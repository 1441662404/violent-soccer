'use strict';

/* ============================================================
 *  bw-guard.js —— 带宽护航：在线游玩优先
 *
 *  【要解决的问题】服务器上行带宽有限。新玩家进场要下载
 *    ~28MB GLB + 5MB 贴图 + 11MB 音频。**只要有人在下载，
 *    正在踢球的人就卡** —— 大文件把上行出口和 TCP 发送缓冲塞满，
 *    30Hz 的 state 广播被排队，延迟飙升（表现就是"瞬移/一顿一顿"）。
 *
 *  【做法】静态资源（/models /char /audio /lib /css /js /index.html）
 *    在**场上有真人在玩**时，通过一个**全局令牌桶**统一限速，
 *    主动留出带宽给实时流量；场上没有真人时**全速放行**（不浪费）。
 *
 *  ★ 关键设计：**加载中的新玩家不计入「在玩」**
 *    客户端在开始界面用的是 `?spectate=1` 连接（不进 G.players），
 *    点"进入球场"才正式 join。所以判据天然只统计**真正在场踢球**的人
 *    —— 新玩家自己不会被自己限速，但在场的老玩家一定是"被保护对象"。
 *
 *  ★ 全局桶，不是每连接限速：3 个人同时加载时共享同一份额度
 *    （每连接限速会变成 3× 超发，反而没保护住）。
 *
 *  ★ 中途人数变化立刻生效：每个发送批次都重算速率，
 *    下载到一半有人进场 → 下一个批次就降速。
 *
 *  【调参】环境变量，改完 restart 生效：
 *    BW_GUARD=0          完全关掉限速（排查用，回到原始全速行为）
 *    BW_UP_KBPS=220      服务器上行带宽估算（KB/s）
 *    BW_PLAY_PCT=0.55    有人在玩时，静态资源最多占用上行的比例
 *    BW_RESERVE_KBPS=95  每个在场真人预留的实时带宽（KB/s）
 *    BW_MIN_KBPS=48      限速下界（太低会让加载慢到不可用）
 *    BW_DEBUG=1          打印限速决策
 *
 *  ★ 这两个数字都是**实测**，不是拍脑袋：
 *    · upKbps=220：线上冷启动全套资源实测 3.25MB / 15.4s ≈ 215 KB/s
 *      （取 220 留一点余量）。**故意取得保守** —— 若真实上行更高，
 *      后果只是"加载稍慢"；若取高了，就会让在场玩家卡（这才是要防的）。
 *    · reserveKbps=95：socket.io 单客户端 30Hz state 含协议头 ≈ 93 KB/s
 *      （场上 7 个实体时单包 ~3.0KB，见 net-size.mjs）。
 *    于是 1 人在玩时：静态额度 min(220×0.55, 220-95) = 121 KB/s，
 *    给玩家留 99 KB/s ≥ 93 KB/s ✓ —— 实时流够用，加载也不至于慢到不可用。
 *
 *  【验收】GET /bw-stats 看实时速率与在线人数；
 *         `node check-bw.mjs` 跑「无人 vs 有人」下载速度对比。
 * ============================================================ */

/* 单响应缓冲上限：超过就放弃限速直接发（保护内存，正常文件远达不到） */
const MAXQ = 24 * 1024 * 1024;
/* 背压水位：队列超过它就让写方暂停（等降到它以下再发 drain），
 * 避免 express.static 的 pipe 一口气把整个文件读进内存。 */
const HWM = 256 * 1024;

/* 走限速的静态路径（其余路径——socket.io / dev 接口 / 小 JSON——一律不碰） */
const STATIC_PREFIX = ['/models/', '/char/', '/audio/', '/lib/', '/css/', '/js/', '/videos/', '/glb/'];
const STATIC_EXACT = ['/', '/index.html'];

function isStaticPath(p) {
  if (typeof p !== 'string') return false;
  if (STATIC_EXACT.indexOf(p) >= 0) return true;
  for (let i = 0; i < STATIC_PREFIX.length; i++) {
    if (p.startsWith(STATIC_PREFIX[i])) return true;
  }
  return false;
}

function numEnv(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function makeBwGuard(opts) {
  const activePlayers = (opts && opts.activePlayers) || function () { return 0; };

  const cfg = {
    /* ★ 默认关闭（用户要求"关掉限速"）。
       原因：28MB 模型在 48KB/s 下要 10 分钟才加载完，有 2 人在场时新玩家永远进不去，
       表现成"一直在载入"。云端上行实测 ~220KB/s 足够 3-4 人同时在线游玩，
       限速省下的那点带宽远不如"进不去游戏"的代价大。
       需要时用 BW_GUARD=1 打开。 */
    enabled: process.env.BW_GUARD === '1',
    upKbps: numEnv(process.env.BW_UP_KBPS, 220),        // 实测：线上整套 3.25MB/15.4s ≈ 215KB/s
    playPct: numEnv(process.env.BW_PLAY_PCT, 0.55),
    reserveKbps: numEnv(process.env.BW_RESERVE_KBPS, 95),   // 实测：每个在场玩家 30Hz state ≈ 93KB/s
    minKbps: numEnv(process.env.BW_MIN_KBPS, 48),
    debug: process.env.BW_DEBUG === '1',
  };

  /* 全局令牌桶：容量 = 当前速率的 1 秒量（允许一次性突发 1 秒） */
  const bucket = { tokens: 0, last: Date.now() };

  const stats = {
    enabled: cfg.enabled,
    cfg: cfg,
    live: 0,            // 当前在场真人
    limitKBps: 0,       // 当前静态限速（0 = 不限速）
    throttled: 0,       // 被限速的请求数
    passed: 0,          // 无人时直接放行的请求数
    bytesFree: 0,       // 全速发出的字节
    bytesThrottled: 0,  // 限速发出的字节
    bytesBypass: 0,     // 超缓冲旁路发出的字节
    active: 0,          // 正在进行中的限速响应
  };

  /** 当前允许的静态资源速率（字节/秒）；Infinity = 不限速 */
  function limitBps() {
    const n = activePlayers() | 0;
    stats.live = n;
    if (!cfg.enabled || n <= 0) { stats.limitKBps = 0; return Infinity; }
    const up = cfg.upKbps * 1024;
    const byPct = up * cfg.playPct;                       // 主动留白
    const byReserve = up - cfg.reserveKbps * 1024 * n;    // 按人头预留
    const lim = Math.max(cfg.minKbps * 1024, Math.min(byPct, byReserve));
    stats.limitKBps = +(lim / 1024).toFixed(1);
    return lim;
  }

  /** 从全局桶里取最多 n 个字节，返回实际可取到的量 */
  function take(n, rate, now) {
    let t = bucket.tokens + ((now - bucket.last) / 1000) * rate;
    bucket.last = now;
    if (t > rate) t = rate;              // 最多攒 1 秒
    if (t < 0) t = 0;
    const got = Math.min(n, t);
    bucket.tokens = t - got;
    return got;
  }

  /* ★ 全局泵：所有被限速的响应共用一个定时器链，而不是各自挂 setTimeout。
   *   踩过的坑：每响应一条定时器链时，线上 32 个并发下载把事件循环切碎，
   *   实测总吞吐只有设定值的 38%（121KB/s → 46KB/s，新玩家要 77s 才加载完）。
   *   单泵把唤醒次数从 O(连接数×频率) 降到 O(频率)，抖动被 1 秒量桶吸收。 */
  const pending = new Set();
  let pumpTimer = null;
  const PUMP_MS = 5;

  function pump() {
    pumpTimer = null;
    if (!pending.size) return;
    for (const s of Array.from(pending)) { try { s.stepFn(); } catch (e) { /* 单连接出错不影响其它 */ } }
    if (pending.size) pumpTimer = setTimeout(pump, PUMP_MS);
  }
  function addPending(s) {
    pending.add(s);
    if (!pumpTimer) pumpTimer = setTimeout(pump, PUMP_MS);
  }
  function removePending(s) {
    pending.delete(s);
    if (!pending.size && pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
  }

  /** 把一个 res 包成"按当前速率分批下发" */
  function wrap(res) {
    if (res.__bwWrapped) return;
    res.__bwWrapped = true;
    stats.active++;

    const ow = res.write.bind(res);
    const oe = res.end.bind(res);
    let q = [];            // 待发 Buffer 队列
    let qb = 0;            // 队列总字节
    let ending = false;
    let done = false;
    let endCb = null;
    let needDrain = false; // 已向写方报过"满了"，等降到低水位要补一个 drain
    const self = { stepFn: null };

    /* ★ 收尾统一走这里，保证 stats.active 只减一次。
     *   踩过的坑：客户端中途断开（close）时 kill() 直接置 done 而没减计数，
     *   验收跑完会残留 active=N 的假象（排查时会误以为有响应卡住没发完）。
     *   doEnd=false 用于 close 场景 —— 响应已销毁，不能再调原生 end。 */
    const finish = (cb, doEnd) => {
      if (done) return;
      done = true;
      removePending(self);
      stats.active = Math.max(0, stats.active - 1);
      if (doEnd !== false) oe(cb);
      else if (typeof cb === 'function') process.nextTick(cb);
    };

    const kill = () => {
      q = []; qb = 0;
      finish(null, false);                       // 客户端断开：只还计数，不碰已关闭的响应
    };

    const maybeEnd = () => {
      if (q.length || !ending) return;
      const cb = endCb; endCb = null;
      finish(cb, true);
    };

    /* ★ 背压：队列涨过 HWM 就返回 false，降回 HWM/2 以下补发 'drain'。
     *   没有这段，express.static 的 pipe 会把整个 28MB 文件读进内存。 */
    const drainIfLow = () => {
      if (needDrain && qb <= HWM / 2) {
        needDrain = false;
        process.nextTick(() => { if (!res.destroyed) res.emit('drain'); });
      }
    };

    /* 把队列一次性冲出去（不限速 / 旁路时用） */
    const flushAll = (tag) => {
      while (q.length) {
        const b = q.shift();
        qb -= b.length;
        ow(b);
        stats[tag] += b.length;
      }
      qb = 0;
      drainIfLow();
    };

    /* 由全局泵调用：尽力把队列推出去；推不动就留着等下一轮 */
    const stepFn = () => {
      if (done) return;
      if (res.destroyed) return kill();

      const rate = limitBps();
      if (!Number.isFinite(rate)) {           // 没人玩 → 全速
        flushAll('bytesFree');
        return maybeEnd();
      }

      while (q.length) {
        const b = q[0];
        const got = take(b.length, rate, Date.now());
        if (got <= 0) { drainIfLow(); return; }   // 桶空 → 等下一轮泵
        if (got >= b.length) {
          q.shift(); qb -= b.length;
          ow(b);
          stats.bytesThrottled += b.length;
        } else {
          ow(b.subarray(0, got));
          q[0] = b.subarray(got);
          qb -= got;
          stats.bytesThrottled += got;
          drainIfLow();
          return;
        }
      }
      drainIfLow();
      maybeEnd();
    };
    self.stepFn = stepFn;

    const push = (b) => {
      if (done) return;
      q.push(b); qb += b.length;
      if (qb > MAXQ) {                        // 异常大响应 → 放弃限速保内存
        flushAll('bytesBypass');
        return;
      }
      /* 先同步尝试一次（无人玩时这里就把整个文件全速发完了，零额外延迟）；
       * 发不动（桶空）再交给全局泵，避免每条连接各挂一条定时器链。 */
      stepFn();
      if (!done && q.length) addPending(self);
    };

    res.on('close', kill);

    res.write = function (chunk, enc, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = null; }
      else if (typeof enc === 'function') { cb = enc; enc = null; }
      if (chunk == null || done) { if (typeof cb === 'function') process.nextTick(cb); return true; }
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8');
      if (b.length) push(b);
      if (typeof cb === 'function') process.nextTick(cb);
      if (qb > HWM) { needDrain = true; return false; }   // 通知写方暂停
      return true;
    };

    res.end = function (chunk, enc, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = null; }
      else if (typeof enc === 'function') { cb = enc; enc = null; }
      if (done) { if (typeof cb === 'function') process.nextTick(cb); return res; }
      if (chunk != null) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8');
        if (b.length) push(b);
      }
      if (typeof cb === 'function') endCb = cb;
      ending = true;
      if (done) return res;
      if (!q.length) { const cb = endCb; endCb = null; finish(cb); }
      else addPending(self);
      return res;
    };
  }

  const middleware = function bwGuardMw(req, res, next) {
    if (!cfg.enabled) return next();
    const m = req.method;
    if (m !== 'GET' && m !== 'HEAD') return next();
    if (!isStaticPath(req.path)) return next();
    const n = activePlayers() | 0;
    if (n <= 0) { stats.passed++; return next(); }   // 没人玩 → 完全不包装，零开销
    stats.throttled++;
    wrap(res);
    next();
  };

  const api = {
    middleware: middleware,
    config: cfg,
    stats: function () {
      limitBps();                                    // 刷新一下 live / limit
      return {
        enabled: stats.enabled,
        cfg: stats.cfg,
        livePlayers: stats.live,
        limitKBps: stats.limitKBps,
        throttledReq: stats.throttled,
        passedReq: stats.passed,
        activeResponses: stats.active,
        bytesFree: stats.bytesFree,
        bytesThrottled: stats.bytesThrottled,
        bytesBypass: stats.bytesBypass,
        summary: (stats.limitKBps === 0
          ? '无人在玩 → 静态资源全速下发'
          : '有人在玩 → 静态资源限速 ' + stats.limitKBps + ' KB/s（带宽留给在场玩家）'),
      };
    },
  };
  return api;
}

module.exports = makeBwGuard;
module.exports.isStaticPath = isStaticPath;
