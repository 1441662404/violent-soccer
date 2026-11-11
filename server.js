/* ============================================================
 *  暴力足球 —— 权威服务器
 *  参考《服务器接口文档.md》：socket.io 心跳参数、30Hz 主循环、
 *  客户端上报"意图"、服务端算一切、拒绝必回话。
 * ============================================================ */
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const https = require('https');
const net = require('net');
const { Server } = require('socket.io');

const SH = require('./public/js/shared.js');
const { C, clamp, lerp, angDelta, angApproach, stepBall, kickVelocity, inControlRange, spinFromSpot } = SH;
const { pickAnim } = require('./anim-pick.js');
/* 持球原地等待（Soccer Idle）的双脚轨迹：驱动脚下的球跟着拉球动作走。
 * 由 `node build-dribble-ball.mjs` 从 glb 里采出来（髋为原点、米、朝 +Z）。 */
let DRIBBLE_IDLE = null;
try { DRIBBLE_IDLE = require('./dribble-idle.json'); } catch (e) { console.warn('[球] 缺 dribble-idle.json，持球待机不驱动球'); }

/* 马赛回旋的球轨迹：球被脚带着**绕人一圈**（不能拨出去 —— 用户要求"带着球跑"）。
 * 由 `node build-spin-ball.mjs` 从 spin clip 里量肩线转角算出来（髋为原点、米、朝 +Z）。 */
let SPIN_BALL = null;
try { SPIN_BALL = require('./spin-ball.json'); } catch (e) { console.warn('[球] 缺 spin-ball.json，马赛回旋的球会贴在身前'); }

/* ============================================================
 *  ★★ 门将接球 = 所见即所得
 *
 *  用户反馈："AI 守门员动作没显示就拦截球了，需要根据他的模型动作有没有真正扑到球
 *  才行，不应该是程序拦截，应该是所见即所得。"
 *
 *  改法：不再用"以门将为中心画一个半径 R 的圆"来判接球，改成查
 *  **该动作在那一刻手/头的真实位置**（build-gk-reach.mjs 从 glb 里逐帧采样出来的
 *  gk-reach.json），再判球的飞行线段是否真的穿过手/头/身体。
 *
 *  于是：动作没起手 → 手没伸出去 → 接不到（这也顺带修掉了"没播动作也吞球"）；
 *        动作扑错方向 → 手在不在这条球路上 → 接不到。判定与画面完全一致。
 * ============================================================ */
const GK_REACH = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'gk-reach.json'), 'utf8'));
  } catch (e) {
    console.warn('[门将] gk-reach.json 读取失败，退回旧判定：', e.message);
    return {};
  }
})();

const _gkPoseBuf = new Array(10).fill(0);

/* 接球统计（/gk-stats）：用于验收"每一次接球都有动作驱动" */
const GK_STATS = { catches: 0, withAnim: 0, noAnim: 0, anims: {}, shots: 0, goals: 0, blocked: 0 };

/* ★ 确定性射门序列（调参 / 回归用）：
 *   设了种子之后，射门机器人的「射门点 / 落点 / 力度」和每脚球的 aimJit
 *   全部走同一条伪随机序列 → 改前改后跑的是**同一批射门**，进球数可以直接比。
 *   用法：环境变量 SHOOT_SEED=12345，或运行时 GET /shoot-seed?s=12345。 */
let _rng = Math.random;
function setShootSeed(seed) {
  const n = Number(seed);
  if (!n || !Number.isFinite(n)) { _rng = Math.random; return false; }
  let a = n >>> 0;
  _rng = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return true;
}
const RND = () => _rng();
if (process.env.SHOOT_SEED) setShootSeed(process.env.SHOOT_SEED);


/** 各接球动作"手伸到球位"的最佳时刻（归一化 0~1）—— 从轨迹里自动挑：
 *  低球取"手最低"那帧，高球取"手最高"那帧，半高球取"手最靠前"那帧。
 *  服务器用它在"球还有多久到"里反推该用多快播，让手到位 = 球到位。 */
const GK_MOMENT = (() => {
  const out = {};
  for (const [name, c] of Object.entries(GK_REACH)) {
    if (!c || !c.s || c.n < 2) continue;
    let best = 0, bestScore = -1e9;
    for (let i = 0; i < c.n; i++) {
      const p = c.s[i];
      const handY = Math.min(p[9] + p[1], p[9] + p[4]);     // 较低那只手的世界高度
      const fwd = Math.max(p[2], p[5]);                     // 手向前伸的距离
      let score;
      if (/Low|Scoop/i.test(name)) score = -handY * 2 + fwd;        // 越低越好
      else if (/High/i.test(name)) score = handY * 2 + fwd;         // 越高越好
      else score = fwd * 2 + Math.abs(handY - 0.9) * -0.5;          // 半高：向前为主
      if (score > bestScore) { bestScore = score; best = i; }
    }
    out[name] = +(best / (c.n - 1)).toFixed(3);
  }
  return out;
})();
console.log('[门将] 手到球位时刻:', Object.entries(GK_MOMENT)
  .map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' '));

/** 取某门将动作在进度 prog(0..1) 时的手/头位置（本地系：原点=髋，米，x=侧向 y=上 z=前） */
function gkPoseAt(name, prog) {
  const c = GK_REACH[name];
  if (!c || !c.s || c.n < 2) return null;
  const f = clamp(prog, 0, 1) * (c.n - 1);
  const i = Math.min(c.n - 2, Math.max(0, Math.floor(f)));
  const u = f - i;
  const a = c.s[i], b2 = c.s[i + 1];
  for (let k = 0; k < 10; k++) _gkPoseBuf[k] = a[k] + (b2[k] - a[k]) * u;
  return _gkPoseBuf;
}

/** 点到**线段**的三维最短距离（球一帧能飞 1m+，必须按轨迹算，不能只测端点） */
function segPointDist(ax, ay, az, bx, by, bz, px, py, pz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const fx = ax - px, fy = ay - py, fz = az - pz;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-9) return Math.hypot(fx, fy, fz);
  let t = -(fx * dx + fy * dy + fz * dz) / a;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return Math.hypot(ax + dx * t - px, ay + dy * t - py, az + dz * t - pz);
}


const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

/* ---------------- 模型路由：把英文 URL 映射到 glb/ 目录 ----------------
 *  FBX 包（134MB）由 fbx2glb.mjs 离线转成 GLB（7.9MB）：模型 1 个 + 动画 23 个。
 *  远程服务器带宽小，FBX 直接serve 要下 4~5 分钟，GLB 十几秒搞定。 */
const MODEL_FILES = {
  'ambulance.glb': ['救护车包', 'ambulance.glb'],
  // 模型（唯一带网格的文件）
  'idle.glb':      ['glb', 'idle.glb'],
  'char.fbx':      ['模特包', 'char.fbx'],   // 新人物模型源码（首屏慢，仅作 fallback）
  'char.glb':      ['glb', 'char.glb'],      // ★ 首选：build-char.mjs 从 char.fbx 转出（剥内嵌贴图，br 后省 82%）
  // 动画（只含骨架 + clip，按骨骼名绑定到模型骨架）
  'idleAnim.glb':  ['glb', 'idleAnim.glb'],
  'walk.glb':      ['glb', 'walk.glb'],
  'run1.glb':      ['glb', 'run1.glb'],
  'run2.glb':      ['glb', 'run2.glb'],
  'run3.glb':      ['glb', 'run3.glb'],
  'run4.glb':      ['glb', 'run4.glb'],
  'runBack.glb':   ['glb', 'runBack.glb'],
  'startBack.glb': ['glb', 'startBack.glb'],
  'arcRight.glb':  ['glb', 'arcRight.glb'],
  'rightTurn.glb': ['glb', 'rightTurn.glb'],
  'toTurn.glb':    ['glb', 'toTurn.glb'],
  'changeDir.glb': ['glb', 'changeDir.glb'],
  'jump.glb':      ['glb', 'jump.glb'],
  'slide.glb':     ['glb', 'slide.glb'],
  'dribble.glb':   ['glb', 'dribble.glb'],
  'pass.glb':      ['glb', 'pass.glb'],
  'strikeJog.glb': ['glb', 'strikeJog.glb'],
  'passStill.glb': ['glb', 'passStill.glb'],
  'tackleDown.glb':['glb', 'tackleDown.glb'],
  'throwIn.glb':   ['glb', 'throwIn.glb'],       // 手抛球（界外球）
  'hurtFace.glb':  ['glb', 'hurtFace.glb'],      // 受击：被上勾拳打脸
  'dribbleIdle.glb': ['glb', 'dribbleIdle.glb'], // 持球原地等待（来回拉球）
  'spin.glb':        ['glb', 'spin.glb'],        // 马赛回旋（踢球模式花式卡）
  /* ★ 开始界面选队模型的展示动作：平时 Happy Idle / 悬停 Salute */
  'salute.glb':    ['glb', 'salute.glb'],
  'happyIdle.glb': ['glb', 'happyIdle.glb'],
  'hurtBody.glb':  ['glb', 'hurtBody.glb'],      // 受击：被打中身体
  'gkBlockL.glb':  ['glb', 'gkBlockL.glb'],      // 守门员贴地扑挡 左
  'gkBlockR.glb':  ['glb', 'gkBlockR.glb'],      // 守门员贴地扑挡 右
  'gkDiveL.glb':   ['glb', 'gkDiveL.glb'],       // 守门员飞扑 左
  'gkDiveR.glb':   ['glb', 'gkDiveR.glb'],       // 守门员飞扑 右
  'gkStepL.glb':   ['glb', 'gkStepL.glb'],       // 守门员侧步 左
  'gkStepR.glb':   ['glb', 'gkStepR.glb'],       // 守门员侧步 右
  'gkCatchLow.glb': ['glb', 'gkCatchLow.glb'],   // 门将接球：捞起（低球）
  'gkCatchBody.glb':['glb', 'gkCatchBody.glb'],  // 门将接球：腹部（半高）
  'gkCatchHigh.glb':['glb', 'gkCatchHigh.glb'],  // 门将接球：跳起（高球）
  'gkKick.glb':    ['glb', 'gkKick.glb'],        // 门将原地出球（抱球后大脚开球）
  'gkDrop.glb':    ['glb', 'gkDrop.glb'],        // 门将放地上助跑发球
  'gkRoll.glb':    ['glb', 'gkRoll.glb'],        // 门将滚地发球
  'gangnam.glb':   ['glb', 'gangnam.glb'],
  'hipHop.glb':    ['glb', 'hipHop.glb'],     // 舞段 6 Hip Hop Dancing
  'hipHop1.glb':   ['glb', 'hipHop1.glb'],    // 舞段 7 Hip Hop Dancing (1)
  'swing.glb':     ['glb', 'swing.glb'],      // 舞段 8 Swing Dancing
  'breakdance.glb':['glb', 'breakdance.glb'], // 舞段 5 Breakdance 1990
  'badDance.glb':  ['glb', 'badDance.glb'],   // 舞段 6 马竞战舞 BAD（DeepMotion 素材烘焙）
  'fightIdle.glb': ['glb', 'fightIdle.glb'],
  'punchL.glb':    ['glb', 'punchL.glb'],
  'punchR.glb':    ['glb', 'punchR.glb'],
  'flyKick.glb':   ['glb', 'flyKick.glb'],     // 飞踢（攻击模式技能·短CD，Kicking）
  'hurricane.glb': ['glb', 'hurricane.glb'],   // 螺旋踢（攻击模式技能·长CD，Hurricane Kick）
  'death.glb':     ['glb', 'death.glb'],       // 死亡（血量清零 → 抬进球员席，Death From The Back）
  // 足球动作包新增（与模特包同源骨架，直绑）
  'spin.glb':      ['glb', 'spin.glb'],        // 马赛回旋
  'chip.glb':      ['glb', 'chip.glb'],        // 跑动横传
  'gkIdle.glb':    ['glb', 'gkIdle.glb'],      // 门将锁定原地姿势
  'gkHold.glb':    ['glb', 'gkHold.glb'],      // 门将抱球姿势
  'gkScoop.glb':   ['glb', 'gkScoop.glb'],     // 门将抢近距离球
  'header.glb':    ['glb', 'header.glb'],      // 头球（跳跃顶球）
  'idleLong.glb':  ['glb', 'idleLong.glb'],    // 站立久了原地活动（Happy Idle）
};

/* ---------------- 压缩分发：brotli 优先，gzip 兜底 ----------------
 *  远程服务器带宽小（~450KB/s），24 个 GLB 共 8MB 要下一两分钟。
 *  GLB 的二进制顶点数据 brotli 能压到 23%（实测 7.92MB → 1.81MB），
 *  压缩结果进内存缓存，首次请求压一次、之后零开销。 */
const zlib = require('zlib');
const compCache = new Map();          // fullPath -> { br, gzip }
const compPending = new Map();        // fullPath -> Promise（避免并发重复压缩）

/* 异步压缩：brotli 是 CPU 密集操作，同步压缩会阻塞事件循环，
   并发加载 20+ 个模型时整个进程会卡住几十秒（表现为「正在载入」不动）。
   这里改成异步 + 同文件去重，首次压缩期间其它请求等待同一个 Promise。 */
function ensureCompressed(full) {
  let entry = compCache.get(full);
  if (entry) return Promise.resolve(entry);

  let pending = compPending.get(full);
  if (pending) return pending;

  pending = new Promise(resolve => {
    fs.readFile(full, (err, raw) => {
      if (err || !raw) { resolve(null); return; }
      /* 只做 gzip：brotli 在云端 CPU 上压 5.8MB 要 10s+，
         会把整个进程卡住（表现为进不去）。gzip 只要 ~200ms。 */
      zlib.gzip(raw, { level: 6 }, (e2, gz) => {
        if (e2) { resolve(null); return; }
        const e3 = { br: null, gzip: gz };
        compCache.set(full, e3);
        console.log(`[压缩] ${path.basename(full)} ${(raw.length / 1024) | 0}KB → gzip ${(gz.length / 1024) | 0}KB`);
        resolve(e3);
      });
    });
  }).finally(() => compPending.delete(full));

  compPending.set(full, pending);
  return pending;
}

function sendCompressed(full, req, res, contentType) {
  const ae = req.headers['accept-encoding'] || '';

  /* 已压好的缓存 → 直接发压缩版（最快） */
  const cached = compCache.get(full);
  if (cached) {
    const enc = ae.includes('br') && cached.br ? 'br'
      : (ae.includes('gzip') && cached.gzip ? 'gzip' : null);
    if (enc && !res.headersSent) {
      res.setHeader('Content-Encoding', enc);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', cached[enc].length);
      res.setHeader('Vary', 'Accept-Encoding');
      return res.end(cached[enc]);
    }
  }

  /* 没缓存 → 直接发原文件，绝不在请求里现压。
     云端 CPU 弱，现压 5.8MB 模型要 10s+，网关会先超时返回 502。
     预热任务会在后台慢慢把缓存建好，之后访问就是压缩版。 */
  res.setHeader('Content-Type', contentType);
  return res.sendFile(full);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 8000,
  pingTimeout: 25000,
  connectTimeout: 45000,
  maxHttpBufferSize: 1e6,
  cors: { origin: '*' },
  /* ★ 只允许 websocket，拒绝长轮询（polling）
   *  背景：云平台网关对「短时间内的 HTTP 请求数」有上限（实测约 每秒十几个），
   *        超了会返回 403「系统维护中」页面。
   *        有外部客户端用 transport=polling 连接（每秒 7-8 次请求），
   *        一个人就能把配额吃光，导致其他玩家打不开页面。
   *  我们的客户端本来就写死 transports: ['websocket']，禁掉 polling 对它无影响。 */
  transports: ['websocket'],
  allowUpgrades: false,
});

/* ---------------- 带宽护航：在线游玩优先 ----------------
 *  ★ 用户反馈："有人在加载初始化的时候，游玩的玩家会很卡。"
 *  根因：新人进场要拉 28MB GLB + 5MB 贴图，把上行出口塞满 →
 *        30Hz 的 state 广播排队 → 在场玩家瞬移/顿卡。
 *  做法：场上有真人时，静态资源走全局令牌桶限速（默认只占上行 40%，
 *        并给每个在场玩家预留 25KB/s）；无人时全速放行，不浪费一点带宽。
 *  ⚠️ 必须注册在 express.static **之前**（middleware 是顺序生效的）。
 *  实现与调参见 bw-guard.js；验收 `node check-bw.mjs` / GET /bw-stats。 */
const makeBwGuard = require('./bw-guard.js');
const bwGuard = makeBwGuard({
  /* 延迟读取 G.players：这里定义时 G 还没初始化（第 1176 行才建），
   * 但 middleware 只在请求到来时执行，那时 G 已就绪。 */
  activePlayers: () => {
    let n = 0;
    try { for (const p of G.players.values()) if (!p.bot) n++; } catch (e) { n = 0; }
    return n;
  },
});
app.use(bwGuard.middleware);

/* ★ 开发用视频（extract-video-frames.mjs 抓帧）要开 CORS，否则 canvas 被判定为
 *   "tainted" 不能 toDataURL，抽帧会报 SecurityError。只在 public 下生效。 */
app.use(express.static(path.join(ROOT, 'public'), {
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (/\.(mp4|webm|mov)$/i.test(filePath)) res.setHeader('Access-Control-Allow-Origin', '*');
  },
}));

/* ---------------- 资源指纹（自动版本号）----------------
 * /models/* 与 /char/* 走一年强缓存（max-age=31536000, immutable），最快但有个坑：
 *   文件换了、版本号没升 → 浏览器一年内都会用旧文件（实测踩过：动作改好了但用户看到的还是旧的）。
 * 所以这里按**文件内容**自动算指纹（大小 + mtime），启动时生成一次，
 * 客户端拿到的 `?v=` 会随文件变化自动变 → 不需要再手改 ASSET_V。
 * 客户端也从 /asset-version 拉取，保证和球场上所有人一致。 */
const assetVer = (() => {
  const crypto = require('node:crypto');
  const h = crypto.createHash('sha1');
  const roots = ['glb', 'public/char', 'public/css', 'public/js', 'public/audio', '模特包'];
  const walk = (dir) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const it of items.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) walk(p);
      else {
        try { const st = fs.statSync(p); h.update(it.name + ':' + st.size + ':' + Math.round(st.mtimeMs)); } catch (e) {}
      }
    }
  };
  for (const r of roots) walk(path.join(ROOT, r));
  return h.digest('hex').slice(0, 8);
})();
console.log('[资源指纹] ' + assetVer);

app.get('/asset-version', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/plain').send(assetVer);
});

app.get('/models/:file', (req, res) => {
  const m = MODEL_FILES[req.params.file];
  if (!m) return res.status(404).end('no such model');
  const full = path.join(ROOT, m[0], m[1]);
  if (!fs.existsSync(full)) return res.status(404).end('missing: ' + full);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  sendCompressed(full, req, res, 'model/gltf-binary');
});
app.get('/models.meta', (_req, res) => res.json(MODEL_FILES));
/* 调试用：看当前场上状态 */
/* ★ 开发/验收专用（DEV_API=1 时开启，线上不启用）：
 *   摆球 / 给球权 —— 门将"捡球窗口"这类逻辑必须能把球精确放到门将脚边才测得出来。
 *   用法：DEV_API=1 node server.js，然后
 *     GET /dev-ball?x=-50&z=1&y=0.15&vx=0&vz=-1.5
 *     GET /dev-give?to=玩家名或bot_shooter
 */
if (process.env.DEV_API === '1') {
  app.get('/dev-ball', (req, res) => {
    const b = G.ball;
    const n = (k, d) => (req.query[k] === undefined ? d : Number(req.query[k]));
    b.x = n('x', b.x); b.z = n('z', b.z); b.y = n('y', C.BALL_R);
    b.vx = n('vx', 0); b.vy = n('vy', 0); b.vz = n('vz', 0);
    b.wx = n('wx', 0); b.wy = n('wy', 0);      // 可选：直接给自旋（验证 Magnus 弧线用）
    b.owner = null; b.kickFromX = null; b.lastTouch = null;
    for (const p of G.players.values()) p.dribbling = false;
    res.json({ ok: 1, ball: { x: b.x, y: b.y, z: b.z } });
  });
  /* 调试：直接设庆祝次数（验收转盘用） */
  app.get('/dev-cheer', (req, res) => {
    const key = String(req.query.to || '');
    let who = G.players.get(key);
    if (!who) for (const p2 of G.players.values()) if (p2.name === key) { who = p2; break; }
    if (!who) return res.json({ ok: 0 });
    who.cheer = Number(req.query.n || 1);
    res.json({ ok: 1, to: who.name, cheer: who.cheer });
  });
  app.get('/dev-move', (req, res) => {
    const key = String(req.query.to || '');
    let who = G.players.get(key);
    if (!who) for (const p of G.players.values()) if (p.name === key) { who = p; break; }
    if (!who) return res.json({ ok: 0, err: 'no such player' });
    who.x = who.bx = Number(req.query.x);
    who.z = who.bz = Number(req.query.z);
    if (req.query.yaw !== undefined) who.yaw = who.aimYaw = Number(req.query.yaw);
    who.vx = who.vz = 0;
    res.json({ ok: 1, to: who.name, x: who.x, z: who.z, yaw: who.yaw });
  });
  app.get('/dev-give', (req, res) => {
    const key = String(req.query.to || '');
    let who = G.players.get(key);
    if (!who) for (const p of G.players.values()) if (p.name === key) { who = p; break; }
    if (!who) return res.json({ ok: 0, err: 'no such player' });
    const b = G.ball;
    b.owner = who.id; who.dribbling = true;
    b.x = who.x + Math.sin(who.yaw) * 0.45; b.z = who.z + Math.cos(who.yaw) * 0.45; b.y = C.BALL_R;
    b.vx = b.vy = b.vz = 0; b.lastTouch = who.id;
    res.json({ ok: 1, to: who.name, x: who.x, z: who.z });
  });
  /* 让某玩家**放开球**（测试用：验证"没持球不能做马赛回旋"时必须先确保真的没球）。
   * 注意只清球权，不动球的位置。 */
  app.get('/dev-drop', (req, res) => {
    const key = String(req.query.to || '');
    let who = G.players.get(key);
    if (!who) for (const p of G.players.values()) if (p.name === key) { who = p; break; }
    if (!who) return res.json({ ok: 0, err: 'no such player' });
    who.dribbling = false;
    who.gkHold = false;
    if (G.ball.owner === who.id) {
      G.ball.owner = null;
      G.ball.vx = G.ball.vy = G.ball.vz = 0;
    }
    res.json({ ok: 1, to: who.name, owner: G.ball.owner });
  });
  /* 调试：清掉死球状态 + 把球放回中圈（验收探针连续跑多脚时要清 restart，
   * 否则上一脚出界留下的死球会把后续"第一脚"全挡掉，要等 45s 才自动放开） */
  app.get('/dev-clear', (req, res) => {
    finishRestart(null);
    const b = G.ball;
    b.x = 0; b.z = 0; b.y = C.BALL_R;
    b.vx = b.vy = b.vz = 0; b.wx = b.wy = 0;
    b.owner = null; b.lastTouch = null;
    for (const p of G.players.values()) { p.dribbling = false; p.gkHold = false; }
    res.json({ ok: 1 });
  });
}

/* 门将手部轨迹表（调试/验收用：直接看"各动作的手能到多高多远"） */
app.get('/gk-reach', (_req, res) => res.json(GK_REACH));
/* 带宽护航实时状态（验收/排查用：看当前限速、在场真人数、已发字节） */
app.get('/bw-stats', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(bwGuard.stats()); });
/* 接球统计：验证"每一次接球都伴随门将动作"（所见即所得） */
app.get('/gk-stats', (_req, res) => res.json(GK_STATS));
app.get('/gk-stats/reset', (_req, res) => { GK_STATS.catches = 0; GK_STATS.withAnim = 0; GK_STATS.noAnim = 0; GK_STATS.anims = {}; GK_STATS.shots = 0; GK_STATS.goals = 0; GK_STATS.blocked = 0; res.json({ ok: 1 }); });
/* 运行时设定射门种子（确定性回归） */
app.get('/shoot-seed', (req, res) => res.json({ ok: setShootSeed(req.query.s), seed: req.query.s || null }));

app.get('/debug', (_req, res) => res.json({
  scores: G.scores, clock: Math.round(G.clock), round: G.round, phase: G.phase,
  players: [...G.players.values()].map(p => ({
    id: p.id, name: p.name, team: p.team, x: +p.x.toFixed(1), z: +p.z.toFixed(1),
    bot: !!p.bot, botGK: !!p.botGK, botShooter: !!p.botShooter, isGK: !!p.isGK, dead: !!p.dead, dying: !!p.dying,
    gk: isKeeper(p), keeperSlot: G.keeper[p.team] === p.id,
    kickAnim: +(p.kickAnim || 0).toFixed(2), animLock: +(p.animLock || 0).toFixed(2), oneShotSeq: p.oneShotSeq || 0,
    gkActCd: +(p.gkActCd || 0).toFixed(2), gkSaveT: +(p.gkSaveT || 0).toFixed(2),
    gkScoopMode: p.gkScoopMode || null, gkHold: !!p.gkHold, yaw: +(p.yaw || 0).toFixed(2), cheer: p.cheer || 0,
    ballY: +G.ball.y.toFixed(2), anim: p.anim,
    /* ★ 持球观测（验收「拉球待机」入场时机必须看得到这两个值）：
     *   drib   = 是否持球（anim-pick 的 holdingBall 用的就是它）
     *   holdT  = 持球累计秒数（满 DRIBBBLE_IDLE_DELAY 且静止才进 dribbleIdle）
     *   sp     = 当前水平速度（4.8 分支的速度门限 < 0.45）
     *   没有这三项，脱手后"到底清没清零"只能靠动画名反推（踩过：误判成假失败）。 */
    drib: !!p.dribbling, holdT: +(p.ballHoldT || 0).toFixed(2),
    sp: +Math.hypot(p.vx, p.vz).toFixed(2), grab: !!(p.input && p.input.grab),
  })),
  keeper: { A: G.keeper.A, B: G.keeper.B },
  amb: G.amb,
  ball: { x: +G.ball.x.toFixed(2), y: +G.ball.y.toFixed(2), z: +G.ball.z.toFixed(2),
          vx: +(G.ball.vx || 0).toFixed(2), vy: +(G.ball.vy || 0).toFixed(2), vz: +(G.ball.vz || 0).toFixed(2),
          wx: +(G.ball.wx || 0).toFixed(1), wy: +(G.ball.wy || 0).toFixed(1), owner: G.ball.owner },
}));

/* ---------------- 前端依赖本地托管（不依赖 CDN） ---------------- */
const NM = (function () {
  let dir = ROOT;
  for (;;) {
    const cand = path.join(dir, 'node_modules', 'three');
    if (fs.existsSync(cand)) return path.join(dir, 'node_modules');
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.join(ROOT, 'node_modules');
})();
const LIB_FILES = {
  '/lib/three.module.js': ['three', 'build/three.module.js'],
  '/lib/three.core.js': ['three', 'build/three.core.js'],
  '/lib/socket.io.js': ['socket.io', 'client-dist/socket.io.min.js'],
  '/lib/fflate/esm/browser.js': ['fflate', 'esm/browser.js'],
};
for (const [url, [pkg, rel]] of Object.entries(LIB_FILES)) {
  const full = path.join(NM, pkg, rel);
  if (!fs.existsSync(full)) { console.warn('[缺少依赖]', full); continue; }
  app.get(url, (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    sendCompressed(full, req, res, 'text/javascript');
  });
}
app.use('/lib/jsm', express.static(path.join(NM, 'three', 'examples', 'jsm')));
app.get('/js/anim-pick.js', (_q, res) => res.sendFile(path.join(ROOT, 'anim-pick.js')));
/* 人物贴图：内容不变就一年强缓存（webp 与 png 各留一份，客户端按支持情况选） */
app.get('/char/:file', (req, res, next) => {
  const f = req.params.file;
  if (!/^[\w.-]+\.(webp|png|jpg|jpeg)$/i.test(f)) return next();
  const full = path.join(ROOT, 'public', 'char', f);
  if (!fs.existsSync(full)) return res.status(404).end('no such tex');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  sendCompressed(full, req, res, /\.webp$/i.test(f) ? 'image/webp' : 'image/png');
});

/* ============================================================
 *  死球重开（Restart）：界外球 / 角球 / 球门球
 *  - 球出边线 → 界外球，判给对方；球固定在出界点，最近的对方球员去掷
 *  - 球出底线 → 防守方最后触球 = 角球（进攻方发）· 否则球门球（防守方发）
 *  - 球停在点位，只有发球方可以碰；界外球用手抛球动画 + 蓄力条（左键蓄力松开出手），
 *    角球/球门球直接用普通操作（传/射）
 * ============================================================ */
const RESTART_NAME = { throwIn: '界外球', corner: '角球', goalKick: '球门球' };

function ownGoalSignOf(team) { return team === 'A' ? -1 : 1; }

/** 判定并启动死球重开 */
function startRestart(b, outX, outZ) {
  const last = b.lastTouch ? G.players.get(b.lastTouch) : null;
  const lastTeam = last ? last.team : null;
  let type, team, x, z;

  if (outZ) {                                  // 边线出界 → 界外球
    type = 'throwIn';
    team = lastTeam === 'A' ? 'B' : 'A';       // 对方掷
    x = clamp(b.x, -C.FIELD.HALF_L + 1, C.FIELD.HALF_L - 1);
    z = (Math.sign(b.z) || 1) * C.FIELD.HALF_W;
  } else {                                     // 底线出界
    const side = Math.sign(b.x) || 1;          // 出的是哪一侧的底线
    const defTeam = side > 0 ? 'B' : 'A';      // +X 是 B 的球门（A 攻 +X）
    if (lastTeam === defTeam) {                // 防守方最后触球 → 角球
      type = 'corner';
      team = defTeam === 'A' ? 'B' : 'A';
      x = side * C.FIELD.HALF_L;
      z = (Math.sign(b.z) || 1) * C.FIELD.HALF_W;
    } else {                                   // 进攻方自己踢出底线 → 球门球
      type = 'goalKick';
      team = defTeam;
      x = side * (C.FIELD.HALF_L - 5.5);
      z = 0;
    }
  }

  // 发球人：角球/界外球取最近的己方球员；球门球优先门将
  let taker = null;
  if (type === 'goalKick' && G.keeper[team]) taker = G.players.get(G.keeper[team]);
  if (!taker || taker.downT > 0) {
    let bd = 1e9;
    for (const p of G.players.values()) {
      if (p.team !== team || p.downT > 0 || p.upT > 0) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) { bd = d; taker = p; }
    }
  }

  G.restart = {
    type, team, x, z,
    byId: taker ? taker.id : null,
    taken: false, t: 0, auto: 0,
  };
  b.x = x; b.z = z; b.y = C.BALL_R;
  b.vx = b.vy = b.vz = 0; b.owner = null;
  if (taker) taker.restartHint = true;
  io.emit('restart', {
    type, team, x: +x.toFixed(2), z: +z.toFixed(2),
    by: taker ? taker.name : null,
    label: RESTART_NAME[type],
  });
}

/** 每帧维护死球状态：钉住球、把发球人送过去、超时自动发球 */
function stepRestart(b, dt, players) {
  const R = G.restart;
  R.t += dt;
  b.x = R.x; b.z = R.z; b.y = C.BALL_R;
  b.vx = b.vy = b.vz = 0; b.owner = null;

  // 提示：只有发球方的球员走到球边才提示"按 F"（不自动跑去、不自动发球）
  for (const p of players) {
    const near = p.team === R.team && p.downT <= 0 && Math.hypot(p.x - R.x, p.z - R.z) < 2.2;
    p.restartHint = near && !R.taken;
  }
  // 已经进入发球准备的人走开太远 → 取消准备
  if (R.byId) {
    const t = G.players.get(R.byId);
    if (!t || Math.hypot(t.x - R.x, t.z - R.z) > 3 || t.team !== R.team) {
      if (t) t.restartReady = false;
      R.byId = null;
    }
  }
  // 兜底：45 秒还没人来发 → 自动开出去，避免球一直钉住没人管
  if (!R.taken && R.t > 45) autoRestart();
}

/** 发球方把球开出去（手动 or 自动） */
function takeRestart(p, power, dir, type, spot) {
  const R = G.restart;
  if (!R || R.taken || !p || p.team !== R.team) return false;
  const b = G.ball;
  if (Math.hypot(p.x - b.x, p.z - b.z) > 2.2) return false;
  const kind = type || (R.type === 'throwIn' ? 'pass' : (R.type === 'corner' ? 'pass' : 'shoot'));

  if (R.type === 'throwIn') {
    // 手抛球：出手点比踢球晚一点，动画先起手
    const elev = clamp(SH.pitchToElev(p.input.yaw), 0.2, 0.7);   // 抛球天生带弧线
    const spd = 9 + 9 * clamp(power, 0, 1);
    const l = Math.hypot(dir.x, dir.z) || 1;
    p.kickType = 'throwIn';
    p.kickAnim = C.ANIM_THROWIN;
    p.animLock = C.ANIM_THROWIN;
    oneShotBump(p);
    p.throwPending = {
      // 出手时机：clip 是"举球过头 → 抛出"，抬臂大约在 60~70% 处。
      // 原来 0.55s 偏早（球先飞、人才抛），改成贴近发力点，视觉上球跟在手上走。
      t: C.ANIM_THROWIN * 0.62,
      vx: dir.x / l * spd * Math.cos(elev),
      vz: dir.z / l * spd * Math.cos(elev),
      vy: spd * Math.sin(elev) + 1.5,
    };
  } else {
    // 角球 / 球门球：普通出球（保留玩家的射门/传球类型）—— 角球就该能踢弧线
    p.kickType = kind === 'shoot' ? 'shoot' : 'pass';
    p.kickAnim = kind === 'shoot' ? C.ANIM.strikeJog : C.ANIM.pass;
    p.animLock = p.kickAnim;
    oneShotBump(p);
    p.throwPending = null;
    const hi = kind === 'shoot' ? C.KICK_SHOOT : C.KICK_PASS;
    const lo = hi * (kind === 'shoot' ? 0.45 : 0.5);
    let spd = lo + (hi - lo) * clamp(power, 0, 1);
    const spin = spot ? spinFromSpot(spot.sx, spot.sy) : null;
    if (spin) spd *= spin.powerMul;
    const off = spin ? Math.min(1, Math.hypot(spot.sx || 0, spot.sy || 0)) : 0;
    const kv = kickVelocity(dir, spd, off);
    b.vx = kv.vx; b.vz = kv.vz; b.vy = kv.vy;
    b.wx = spin ? spin.wx : 0; b.wy = spin ? spin.wy : 0;
    b.owner = null; b.lastTouch = p.id;
    finishRestart(p);
  }
  R.taken = true;
  return true;
}

/** 12 秒超时自动发球 */
function autoRestart() {
  const R = G.restart;
  const b = G.ball;
  const taker = R.byId ? G.players.get(R.byId) : null;
  const toInfield = R.type === 'throwIn' ? { x: clamp(-R.x / (C.FIELD.HALF_L * 2), -0.5, 0.5), z: -Math.sign(R.z) }
    : { x: R.type === 'goalKick' ? ownGoalSignOf(R.team) : -Math.sign(R.x) * 0.4, z: 0.5 };
  const l = Math.hypot(toInfield.x, toInfield.z) || 1;
  if (taker) takeRestart(taker, 0.7, { x: toInfield.x / l, y: 0, z: toInfield.z / l }, R.type === 'goalKick' ? 'shoot' : 'pass');
  if (G.restart) {                              // 还没清掉（比如人不在球边）→ 直接放开球
    b.vx = toInfield.x / l * 12; b.vz = toInfield.z / l * 12; b.vy = 2;
    b.lastTouch = taker ? taker.id : null;
    finishRestart(taker);
  }
}

function finishRestart(p) {
  const b = G.ball;
  if (p) {
    b.lastTouch = p.id;
  }
  for (const q of G.players.values()) { q.restartHint = false; q.restartReady = false; }
  const was = G.restart ? G.restart.type : null;
  G.restart = null;
  if (was) io.emit('restartDone', { type: was });     // 客户端据此恢复"解说导演"的氛围音
}

/* ============================================================
 *  守门员
 *  - 本方没人当门将时，靠近本方球门按 F 认领成为守门员
 *  - 只有在禁区内才触发扑救动作：左键=贴地扑挡(L/R)、右键=飞扑(L/R)
 *    方向取当前左右移动方向；没移动则按球在门将的哪一侧
 *  - 扑救动作期间横向位移，接球判定半径内则把球"吸"到手上
 *  - 离开禁区 GK_OUT_TIME 秒自动取消门将身份
 * ============================================================ */
function ownGoalSign(team) { return team === 'A' ? -1 : 1; }   // A 守 -X，B 守 +X

/** 是否在本方禁区内 */
function inOwnBox(p) {
  const gx = ownGoalSign(p.team) * C.FIELD.HALF_L;
  return Math.abs(p.x - gx) < C.GK_BOX_D && Math.abs(p.z) < C.GK_BOX_HW;
}

function isKeeper(p) { return keeperOf(p.team) === p; }

/** ★★ 门将是否正把球**抱在手里**（gkHold）—— 抱球期间球受保护，任何人都不许抢走。
 *
 *  用户反馈："抱球的门将不能被抢夺，竟然门将持球被抢夺了。"
 *  根因：`gkHold` 只是个姿势标志位，抢球判定（tryGrab / 拳击 / 技能 / 铲倒 / 捅球）
 *  全都只看 `G.ball.owner`，**没有一处检查 owner 是不是一个抱着球的门将**。
 *  于是对手站到门将身边按 F 就能把球"吸"走（球原本贴在门将胸口 0.97m 高，
 *  横向距离就在 inControlRange 的 0.5m 贴身圈内 → 判定直接通过）。
 *  滑铲**碰撞**那条分支当时加了 `!b.gkHold` 守卫，但滑铲**铲倒**（knockDown）
 *  这条分支没加 —— 同一件事两条路径两套逻辑，所以时好时坏。
 *
 *  这里给出一条统一判据，所有"能夺走球权"的地方都在动手前问一句：
 *  返回抱着球的门将本人；没人在抱球则返回 null。
 *  注意：进球复位 / 死球 / 换人 / 掉线那种**合法重置**不走这里（它们不是"抢夺"）。 */
function gkHoldingPlayer() {
  /* 负对照开关（仅供 check-gksteal.mjs 验证"测试真能抓住这个 bug"）：
   * GK_STEAL_REPRO=1 时模拟修复前的行为（不做保护）→ 测试必须失败。
   * 默认关闭，生产路径永远走下面的真实判定。 */
  if (process.env.GK_STEAL_REPRO === '1') return null;
  const id = G.ball.owner;
  if (!id) return null;
  const o = G.players.get(id);
  if (!o || !o.gkHold) return null;
  return o;
}

/**
 * 一次性动作起手打点：把序号 +1（客户端据此判断"这是一次新的起手，要 reset 重播"）。
 * 凡是要让客户端"从头播一遍"的一次性动作，起手时都必须调这个。
 */
function oneShotBump(p) { p.oneShotSeq = (p.oneShotSeq || 0) + 1; }

/**
 * 门将动作起手（**唯一入口**）—— 所有扑救/接球/出球动作都必须走这里。
 *
 * ★ 为什么要这么严（"门将动作做两次"的历史包袱）：
 *   门将动作有 3 个独立的触发源 ——
 *     ① AI 预判射门 → keeperSave()（扑救）
 *     ② 自动接球 → 正对来球进 1.25m 起手接球
 *     ③ 禁区内碰球 → 捡起时补一个接球动作
 *   外加 ④ 玩家手动按键。任两个在同一次触球里都命中，就会"同一动作播两遍"。
 *   所以这里做**三道锁**：
 *     · gkAnimT  —— 动作还在播 → 拒（主锁）
 *     · gkActCd  —— 动作**刚播完的收招窗口** → 拒（补锁：这是重播最容易漏的口子）
 *     · gkRelease—— 出球发力时刻未到 → 拒
 *   并且把每次"被拒"的原因打出来（环境变量 GK_DEBUG=1 时），方便定位是哪两路在打架。
 */
const GK_DEBUG = process.env.GK_DEBUG === '1';
function gkStartAnim(p, name, dur, spd) {
  if (!name || !(dur > 0)) return false;
  if (p.dead || p.dying) return false;
  const rej = (why) => {
    if (GK_DEBUG) console.log(`[GK拒] ${p.name}${p.botGK ? '(AI)' : '(人)'} ${name} ← ${why}` +
      ` (animT=${(p.gkAnimT || 0).toFixed(2)} actCd=${(p.gkActCd || 0).toFixed(2)} cur=${p.gkAnimName || '-'})`);
    return false;
  };
  if (p.gkRelease) return rej('出球发力中');
  if (p.gkAnimT > 0.02) return rej('动作还在播');
  if (p.gkActCd > 0.06) return rej('收招窗口内');
  /* ★ 可变速起手（spd）：为了"手到位的那一刻正好球到"，快速来球时把动作播快。
   *   nlerp 动画单纯加速会略微丢细节，但这是门将的本能反应，3 倍以内看不出问题，
   *   反而更像"快速扑出去"。dur 是动作的**原始时长**，锁定时长按 1/spd 折算。 */
  const s = clamp(spd || 1, 1, 3.2);
  p.gkAnimName = name;
  /* ★ 两套倍速必须分开（踩过的坑）：
   *   · gkAnimRel = 相对基准的额外加速（服务端算"播到第几成"用它）
   *   · gkAnimSpd = **给客户端的绝对播放倍速** = 基准倍速 × 相对加速
   *   只传 rel 的话，客户端会把 1.5 当成"绝对倍速"，比基准 2.0 还慢 →
   *   服务端 0.6s 就关窗口，客户端还在慢慢播第一帧，动作播一半被切走、判定也全错。
   *   dur 是"按基准倍速的锁定时长"，所以实际播放时长 = dur / s。 */
  p.gkAnimRel = s;
  p.gkAnimSpd = (C.GK_BASE_SPD[name] || 1) * s;
  p.gkAnimBase = dur;                             // 按基准倍速的锁定时长（算播放进度用）
  if (name !== 'gkScoop') p.gkScoopMode = null;   // 换成别的动作 → 捡球模式作废
  p.kickType = name;
  p.kickAnim = dur / s;                           // 实际播放时长（客户端也按这个速度播）
  p.animLock = dur / s;
  p.gkAnimT = dur / s;                            // 播完前不接受新的门将起手
  oneShotBump(p);                                 // 通知客户端：这是一次新起手，可以 reset 重播
  /* 收招保护 = 动作播完后再多锁 0.18s。
   * ★ 这是"做两次"的关键：以前只锁 0.10s，而网络/帧率抖动（尤其 AI 20Hz 判定）
   *   很容易在动作刚结束的那一帧又命中一次接球判定 → 重播。0.18s 足够跨过这个窗口，
   *   又不影响连续扑救（真实连续扑救间隔都在 0.4s 以上）。 */
  p.gkActCd = dur / s + 0.18;
  if (GK_DEBUG) console.log(`[GK起手] ${p.name}${p.botGK ? '(AI)' : '(人)'} ${name} ${dur.toFixed(2)}s ×${s.toFixed(1)}`);
  return true;
}

/** 解除某人的守门员身份（被抬走 / 换人时用），并让 AI 尽快补位 */
function releaseKeeper(p) {
  if (!p || G.keeper[p.team] !== p.id) return;
  const team = p.team;
  G.keeper[team] = null;
  p.isGK = false; p.gkHold = false; p.aimLock = false;
  io.emit('keeperRelease', { team, by: p.name });
  ensureKeeper(team);
}

/** 取某队门将：槽位里的 id 若已不在场上（玩家退出了）就顺手清掉，避免占着位置没人能当 */
function keeperOf(team) {
  const id = G.keeper[team];
  if (!id) return null;
  const p = G.players.get(id);
  if (!p) { G.keeper[team] = null; return null; }
  return p;
}

/** 该玩家现在按 F 能不能当守门员（给客户端出提示用） */
function canClaimKeeper(p) {
  if (isKeeper(p)) return false;
  const cur = keeperOf(p.team);
  if (cur && !cur.botGK) return false;                      // 已经有真人门将
  const gx = ownGoalSign(p.team) * C.FIELD.HALF_L;
  return Math.hypot(p.x - gx, p.z) <= C.GK_CLAIM_DIST && p.downT <= 0 && p.upT <= 0;
}

/** 认领守门员（靠近本方球门按 F）
 *
 *  ★ 返回值语义 = "这一次按 F **做了认领动作**"。
 *    已经是门将时必须返回 **false** —— 否则调用点
 *    `else if (!tryClaimKeeper(p)) tryGrab(p);` 会被挡掉，
 *    真人门将按 F **永远抢不了球**（用户反馈的"按 F 也抢不了球"就是它）。
 */
function tryClaimKeeper(p) {
  if (isKeeper(p)) return false;      // 已经是门将 → 不做认领，交给 tryGrab 去扑球
  if (!canClaimKeeper(p)) return false;                     // 必须"够近 + 有提示"才能顶替
  const curP = keeperOf(p.team);
  if (curP) {
    const bot = curP;
    if (bot.botGK) {                                       // 顶掉 AI 门将，让人来当
      G.players.delete(bot.id);
      io.emit('chat', { type: 'system', text: `${p.name} 换下 AI 守门员` });
    } else {
      return false;                                        // 已经有真人门将
    }
  }
  G.keeper[p.team] = p.id;
  p.gkOutT = 0;
  io.emit('keeperClaim', { team: p.team, by: p.name });
  return true;
}

/** 把某队/全部 AI 守门员撤掉（手动关开关时用） */
function removeAiKeepers() {
  for (const [id, p] of [...G.players]) {
    if (!p.botGK) continue;
    if (G.keeper[p.team] === id) G.keeper[p.team] = null;
    G.players.delete(id);
  }
}

/** 某个队没人当门将时，AI 自动补位（可被开关关掉 / KEEPERS=0 启动即关） */
function ensureKeeper(team) {
  if (keeperOf(team)) return;
  if (!G.keepersOn) return;
  const id = 'bot_gk_' + team;
  if (G.players.has(id)) { G.keeper[team] = id; return; }
  const p = makePlayer(id, 'AI守门员', team);
  p.bot = true; p.botGK = true;
  const gx = ownGoalSign(team) * C.FIELD.HALF_L, inward = -ownGoalSign(team);
  p.x = p.bx = gx + inward * 1.6; p.z = p.bz = 0;
  p.yaw = p.aimYaw = Math.atan2(inward, 0);
  p.spawn = { x: p.x, z: p.z };
  p.aimLock = true;
  G.players.set(id, p);
  G.keeper[team] = id;
  io.emit('chat', { type: 'system', text: `${team} 队 AI 守门员已就位` });
}

/**
 * 门将扑救。kind: 'block' 贴地扑挡 · 'dive' 飞扑
 * side: +1 = 将门自己的右侧 · -1 = 左侧
 */
function keeperSave(p, kind, side, power = 0.6, reachDist = -1, spd = 1, tArrive = 0) {
  if (!isKeeper(p) || !inOwnBox(p) || p.slideT > 0) return false;
  /* 互斥判断**统一交给 gkStartAnim**（唯一入口），这里不再重复写——
   * ★ 踩过：这里原本有 `p.gkActCd > 0.05`，而 gkStartAnim 又收紧到 `dur+0.18`，
   *   两套阈值互相打架，导致"连续扑救被莫名挡住"。只留一处判断源。 */
  // 动画名按"门将自己的左右"（左右动作就是这个视角）
  const name = (kind === 'dive' ? 'gkDive' : 'gkBlock') + (side > 0 ? 'R' : 'L');
  const dur = C.GK_ANIM[name];
  if (!gkStartAnim(p, name, dur, spd)) return false;   // 起手被挡（正在做别的门将动作）→ 这次扑救不做
  /* 接球窗口 = 动作的**实际**播放时长（已按 spd 折算），否则动作播完了窗口还开着
   * → 会在"手已经收回来"之后还判定接住（正是"所见即所得"要杜绝的）。 */
  /* ★ 窗口只覆盖动作的前 80% —— 那一段正好是"手/身体伸出去"的过程。
   *   给满时长的话，动作末尾（手已经收回、人准备起身）还会判定，
   *   于是出现"看着没扑到，球却突然出现在怀里"的诡异感。
   *   用户要求：没扑成功就切回正常姿势，不要保持持球/扑救姿势。 */
  p.gkSaveT = p.kickAnim * 0.80;
  // 横向位移：随蓄力从最短到最长线性变化（飞扑最长 ≈ 3.7m，能扑到门柱内侧）
  const pw = clamp(power, 0, 1);
  let mv = kind === 'dive'
    ? lerp(C.GK_MOVE_MIN.dive, C.GK_MOVE_MAX.dive, pw)
    : lerp(C.GK_MOVE_MIN.block, C.GK_MOVE_MAX.block, pw);
  /* ★★ 知道落点距离时（AI 预判）：位移**精确**覆盖到落点，允许为 0（原地起动作）。
   *
   *   这里原来写 `if (reachDist > 0)` + 下限 GK_MOVE_MIN(0.7 / 1.2) ——
   *   球**正对**门将时 need≈0，条件不成立 → 退化成 `lerp(MIN, MAX, pw)`，
   *   pw = clamp(0/diveReach, 0.35, 1) = 0.35 → 硬塞 0.7~1.16m 的横向位移，
   *   方向由 `Math.sign(need || 1)` 给出（need=0 → 恒 +1）。
   *   结果：**所有正对门将的来球，门将都会主动横移 0.7m 以上把中路让开** ——
   *   这就是用户说的"正对门将的来球一个都拦不住，但动作是对的"。
   *   现在 reachDist 传了（≥0）就精确用；`Math.abs` 保证 0 距离不移动。 */
  const MAXV = kind === 'dive' ? C.GK_MOVE_MAX.dive : C.GK_MOVE_MAX.block;
  if (reachDist >= 0) mv = clamp(reachDist * 1.06, 0.04, MAXV);
  /* ★★ 位移时长必须对齐"球还有多久到门线" —— 这是拦截率上不去的主因。
   *
   *   原来 `mt` 写死 0.5s（飞扑按起跳滞空算 ≈0.6s），而射门常常 0.3s 就到位：
   *   门将只跑完 0.3/0.5 = 60% 的路程，球已经从身边过去了 —— 实测每次"最近差距"
   *   稳定停在 0.74m（不是随机误差，就是这段没跑完的路）。
   *   现在按 tArrive × 0.85 反推速度：**球到的那一刻，人也正好到预判点**。
   *   位移量本身仍受 GK_MOVE_MAX 限制，所以够不到的球照样够不到（不是无敌）。 */
  const tArr = (tArrive > 0.02) ? tArrive : 0;
  if (kind === 'dive') {
    const defAir = Math.max(0.35, 2 * lerp(C.GK_DIVE_JUMP[0], C.GK_DIVE_JUMP[1], pw) / C.GRAVITY);
    const air = tArr ? clamp(tArr * 0.85, 0.20, defAir) : defAir;
    p.vy = C.GRAVITY * air * 0.5;                          // 滞空时间 = 2v/g = air
    p.gkMoveT = air;
    p.gkSaveVX = 0;
    p.gkSaveVZ = side * keeperRightZ(p.team) * mv / air;
  } else {
    const mt = tArr ? clamp(tArr * 0.85, 0.12, C.GK_MOVE_T.block) : C.GK_MOVE_T.block;
    p.gkMoveT = mt;
    p.gkSaveVX = 0;
    p.gkSaveVZ = side * keeperRightZ(p.team) * mv / mt;
  }
  p.gkSaveR = kind === 'dive' ? C.GK_SAVE_R_DIVE : C.GK_SAVE_R_BLOCK;
  p.gkKind = kind;                                        // 记下扑救类型：决定够得着的高度
  p.gkManualT = 0;                                        // 玩家手动扑救：重置"手动让位"计时
  p.gkHold = false;
  io.emit('gkSave', { by: p.name, kind, side, anim: name });
  return true;
}

/**
 * 门将出球（抱球后发球）：三种专用守门员动作
 *   kind='roll' → 滚地发球（gkRoll）  低平快，短传/快速发动
 *   kind='kick' → 原地大脚（gkKick）  中距离开到中场
 *   kind='drop' → 放地上助跑大脚（gkDrop）长距离开大脚（最长）
 * 动画先起手，球在动作的发力时刻才出手（见 gkRelease），避免"球先走人后动"。
 * aim 可由玩家指定（左/右键的方向），不传则自动（找队友 / 朝场内）。
 */
function gkDistribute(p, kind, mate, inward, aim) {
  if (!p.gkHold || G.ball.owner !== p.id) return false;
  // 防重入：已经在出球过程中（动作已起手、等发力时刻）→ 不再重复起手
  // （否则"玩家按键出球 + 自动出球"或连续两帧调用会把同一个动作播两遍）
  if (p.gkRelease) return false;
  const anim = kind === 'drop' ? 'gkDrop' : (kind === 'kick' ? 'gkKick' : 'gkRoll');
  const dur = C.GK_DIST[anim] || 1.1;
  let dirX, dirZ, power, type;
  if (aim) {                                       // 玩家指定方向
    const l = Math.hypot(aim.x, aim.z) || 1;
    dirX = aim.x / l; dirZ = aim.z / l;
    power = kind === 'roll' ? 0.5 : (kind === 'drop' ? 1.0 : 0.85);
    type = kind === 'roll' ? 'pass' : 'shoot';
  } else if (kind === 'roll' && mate) {            // 自动：滚地找队友
    const dx = mate.x - p.x, dz = mate.z - p.z;
    const l = Math.hypot(dx, dz) || 1;
    dirX = dx / l; dirZ = dz / l;
    power = 0.25 + 0.35 * Math.min(1, l / 20);
    type = 'pass';
  } else {
    const spread = kind === 'drop' ? 0.35 : 0.7;   // 长传更集中，大脚可以飘一点
    dirX = inward * 0.92; dirZ = (Math.random() - 0.5) * spread;
    const l = Math.hypot(dirX, dirZ) || 1;
    dirX /= l; dirZ /= l;
    power = kind === 'drop' ? 1.0 : 0.85;
    type = 'shoot';
  }
  // 出球高度：滚地=贴地快滚；大脚=带弧线；助跑大脚=更高的抛物线
  const vy = kind === 'roll' ? 0.03 : (kind === 'drop' ? 0.42 : 0.30);
  if (!gkStartAnim(p, anim, dur)) return false;      // 起手被挡 → 这次出球不发
  p.aimYaw = Math.atan2(dirX, dirZ);
  /* 出手时刻：★ 用户要求"球实际出球时间比现在快 1.5 秒"。
   *   原来是 96% 才脱手（几乎等动作播完），手感上"人早挥完了球还在手里"。
   *   现在固定提前 1.5s：frac = 0.96 - 1.5/dur（gkRoll/gkDrop 3.15s → 0.48，
   *   gkKick 3.92s → 0.58），并夹在 [0.30, 0.96] 之间防止动作太短时变成负数。 */
  const frac = clamp(0.96 - 1.5 / Math.max(0.5, dur), 0.30, 0.96);
  p.gkRelease = { t: dur * frac, dirX, dirZ, power, type, vy };
  if (GK_DEBUG) console.log(`[GK出球] ${p.name} 动作=${anim} 总长=${dur.toFixed(2)}s 脱手=${(dur * frac).toFixed(2)}s（原 ${(dur * 0.96).toFixed(2)}s）`);
  return true;
}

/**
 * 门将侧步：朝目标点移动。
 *   带「横向死区 + 方向迟滞」——否则门将会每帧跨过目标点，方向反复翻转，
 *   客户端动画就会在 gkStepL / gkStepR / runBack 之间疯狂闪（看起来像"动作重复"）。
 */
/* ★ 门将站位 = **封角平分线**（真实门将的基本功）。
 *   站在"球到两根门柱的两条连线"的角平分线与门线的交点上 —— 这样左右两侧的
 *   射门角度被均分，任何一脚射门的横向距离都是最小的。
 *
 *   以前用的是 `lateral = clamp(b.z * (0.3 + 0.62*near))`（球越近越贴球侧），
 *   惩罚非常大：球在 z=±18 侧翼时门将会站到 ±3.26m 的同侧角上，这时射对角
 *   横向要跨 6.7m，**根本不可能扑到** → 实测拦截率只有 28%。
 *
 *   角平分线定理：三角形 B(球) · P+(z=+hw) · P-(z=-hw) 里，角平分线交对边于 Q，
 *   满足 P+Q / QP- = BP+ / BP-，于是
 *     Q = (d- · P+ + d+ · P-) / (d+ + d-)
 *   其中 d± = 球到各门柱的距离。
 */
function gkBisectZ(bx, bz, goalX, hw) {
  const dx = Math.max(0.4, Math.abs(bx - goalX));
  const dPlus = Math.hypot(dx, bz - hw);      // 到 +z 门柱
  const dMinus = Math.hypot(dx, bz + hw);     // 到 -z 门柱
  const sum = dPlus + dMinus || 1;
  const q = (dMinus * hw + dPlus * -hw) / sum;
  return clamp(q, -hw + 0.35, hw - 0.35);
}

function gkStepTo(p, targetX, targetZ, spd) {
  const dx = targetX - p.x;
  const dzRaw = targetZ - p.z;
  const dz = Math.abs(dzRaw) < 0.09 ? 0 : dzRaw;        // 横向到位 → 不再左右蹭
  const d = Math.hypot(dx, dz);
  if (d > 0.06) {
    const sp = Math.min(spd, d * 3.2);
    let ux = dx / d, uz = dz / d;
    const pv = p.aiDir;
    if (pv && pv.x * ux + pv.z * uz > 0.94) { ux = pv.x; uz = pv.z; }   // 夹角 <20° → 沿用旧方向
    p.aiDir = { x: ux, z: uz };
    p.aiMove = { x: ux, z: uz, spd: sp };
  } else {
    p.aiDir = null;
    p.aiMove = { x: 0, z: 0, spd: 0 };                   // 到位 → 定住（别落回 input 逻辑）
  }
}

/* ============================================================
 *  球员席 / 复活 / 救护车
 * ============================================================ */

/**
 * 新玩家入场：先在**球员席**生成，再自己走进场内。
 * 用户要求"进入游戏首先是在替补席生成的"——这样开局不是凭空出现在阵型点上，
 * 而是从场边席位走上球场，更符合 FC 的入场观感。
 * 逻辑上复用 reviveWalk（自动跑回自己半场）；玩家随时给输入就立刻接管。
 */
function sendToBenchSpawn(p) {
  p.benchIdx = p.benchIdx || (1 + Math.floor(Math.random() * 4));
  const b = benchPos(p);
  p.x = p.bx = b.x; p.z = p.bz = b.z; p.y = 0;
  p.vx = p.vy = p.vz = 0;
  p.dead = false;                     // 不是"倒下"，是"刚入场"
  p.hp = C.HP_MAX;
  p.reviveWalk = true;                // 自动走上场
  p.onBenchSpawn = true;              // 客户端据此提示"从替补席入场"
}

/** 复活的球员自动走回自己半场（期间也吃输入，玩家可以立刻接管） */
function autoWalkBack(p) {
  if (p.input.mx || p.input.mz) { p.reviveWalk = null; p.onBenchSpawn = false; return; }   // 玩家接管了
  // 从球员席入场时目标就是自己的阵型点；被救护车送回的则回中圈附近
  const sp = p.spawn || { x: p.team === 'A' ? -12 : 12, z: 0 };
  const tx = p.onBenchSpawn ? sp.x : (p.team === 'A' ? -12 : 12);
  const tz = p.onBenchSpawn ? sp.z : 0;
  const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
  if (d < 2.5) { p.reviveWalk = null; p.onBenchSpawn = false; return; }
  p.yaw = p.aimYaw = Math.atan2(dx, dz);
  p.input.mx = dx / d; p.input.mz = dz / d;
  p.input.sprint = d > 16;
}

/** 球员席上的座位坐标（北侧边线外；红队坐左半边、蓝队坐右半边，不重叠） */
function benchPos(p) {
  const sideK = p.team === 'A' ? -1 : 1;                       // 红队左半边、蓝队右半边
  const off = (p.benchIdx - 2.5) * C.BENCH.GAP;
  return {
    x: clamp(sideK * (C.BENCH.W * 0.26) + off, -C.FIELD.HALF_L + 10, C.FIELD.HALF_L - 10),
    z: -(C.FIELD.HALF_W + C.BENCH.OUT),
  };
}

/**
 * 送去球员席：血量清零不再只是"原地躺一会儿"，而是被抬到场边球员席，
 * BENCH_TIME 秒后由救护车送回场内（复活时满血满状态）。
 */
function sendToBench(p) {
  p.dead = true;
  p.revT = C.BENCH_TIME;
  p.revT0 = C.BENCH_TIME;
  if (!p.benchIdx) p.benchIdx = 1 + Math.floor(Math.random() * 4);
  const b = benchPos(p);
  p.x = b.x; p.z = b.z; p.y = 0;
  p.vx = p.vz = p.vy = 0;
  p.hp = 0;
  p.dribbling = false;
  p.slideT = 0; p.kickAnim = 0; p.animLock = 0; p.gkSaveT = 0; p.gkMoveT = 0; p.gkAnimT = 0; p.gkActCd = 0; p.gkRelease = null;
  p.downT = 0; p.upT = 0;
  p.hurtAnim = 'hurtBody'; p.hurtAnimT = C.ANIM_HURT.hurtBody;
  if (isKeeper(p)) releaseKeeper(p);                          // 门将被抬走 → 交出身份，AI 补位
  if (G.ball.owner === p.id) { G.ball.owner = null; p.gkHold = false; G.ball.vx = G.ball.vz = 0; G.ball.vy = 1.0; }
  io.emit('playerBench', { id: p.id, name: p.name, team: p.team, t: C.AMB_IN + C.AMB_MID_WAIT + C.AMB_BACK });
  io.emit('chat', { type: 'system', text: `${p.name} 被击倒，抬进球员席` });
  if (!G.amb || !G.amb.on) ambulanceGo();       // 叫救护车（车回到停车点时就把他送回来）
}

/**
 * 救护车进场（服务端只记状态，客户端渲染）：
 *   从场边停车位开进来 → 停 AMB_TIME 秒 → 再开回去。
 *   放在服务端是为了让"后进房间 / 刷新页面的人"也能看到同一辆救护车。
 */
function ambulanceGo() {
  G.ambCount = (G.ambCount || 0) + 1;              // 本局救护车出车次数（大小盘结算用）
  G.amb = {
    on: true,
    phase: 'in',                                   // in → mid → back → end → off
    t: C.AMB_IN,
    // 停车点（球员在这里重生）
    parkX: C.FIELD.HALF_L * C.AMB_PARK.X,
    parkZ: -(C.FIELD.HALF_W + C.AMB_PARK.OUT),
    // 球场中央（停一下再把病人送回来）
    midX: 0, midZ: -2,
  };
  emitAmb();
}
function emitAmb() {
  const a = G.amb;
  if (!a) return;
  io.emit('ambulance', { on: a.on, phase: a.phase, t: a.t, x: a.parkX, z: a.parkZ });
}

/**
 * 救护车流程（服务端驱动，客户端只播）：
 *   in   开到球场中央
 *   mid  停一下
 *   back 开回场边停车点
 *   end  球员在停车点重生（此时才复活，视觉上"从车上下来"）
 *   off  救护车消失
 */
function ambulanceTick(dt) {
  const a = G.amb;
  if (!a || !a.on) return;
  a.t -= dt;
  if (a.t > 0) return;
  if (a.phase === 'in') { a.phase = 'mid'; a.t = C.AMB_MID_WAIT; }
  else if (a.phase === 'mid') { a.phase = 'back'; a.t = C.AMB_BACK; }
  else if (a.phase === 'back') {
    a.phase = 'end'; a.t = C.AMB_END_WAIT;
    reviveAllBenched();                            // 回到停车点 → 席上的伤员在这里重生
  } else {
    a.on = false; a.phase = 'off'; a.t = 0;
  }
  emitAmb();
}

/** 把球员席上所有伤员放到停车点重生（救护车送回） */
function reviveAllBenched() {
  const a = G.amb;
  let n = 0;
  for (const p of G.players.values()) {
    if (!p.dead) continue;
    p.dead = false;
    p.dying = false;
    p.revT = 0; p.revT0 = 0;
    p.hp = C.HP_MAX;
    p.hurtT = 99; p.hurtAnim = null; p.hurtAnimT = 0;
    p.downT = 0; p.upT = 0; p.slideT = 0; p.kickAnim = 0; p.animLock = 0;
    p.gkAnimT = 0; p.gkActCd = 0; p.gkRelease = null;
    p.dribbling = false;
    // 在停车点旁边下车（按顺序错开，别叠在一起）
    const off = (n % 3 - 1) * 2.2;
    p.x = clamp((a ? a.parkX : 0) + off + 3.2, -C.FIELD.HALF_L + 3, C.FIELD.HALF_L - 3);
    p.z = clamp((a ? a.parkZ : 0) + 2.6, -C.FIELD.HALF_W - 5, C.FIELD.HALF_W + 5);
    p.y = 0; p.vx = p.vz = p.vy = 0;
    p.yaw = p.aimYaw = (p.team === 'A' ? Math.PI / 2 : -Math.PI / 2);
    p.reviveWalk = true;                          // 自动跑回自己半场
    io.emit('playerRevive', { id: p.id, name: p.name, team: p.team, x: p.x, z: p.z });
    io.emit('chat', { type: 'system', text: `${p.name} 被救护车送回球场` });
    n++;
  }
  return n;
}

/**
 * 门将这一帧能不能碰到球（按"模型面积"判定，不是封满球门的大圆）：
 *  ① 高度：贴地扑挡只有腰以下、飞扑能到手臂高度；球从头顶飞过 → 够不着
 *  ② 横向：算「本帧位移线段到门将圆心的最近距离」——比单纯端点判定更准，
 *     并把最近距离写进 p._gkMinD（诊断用，可直接核对有没有虚空拦截）
 *  够不着就是够不着 —— 空位该进球就进。
 */
function gkCanReach(p, b, bs) {
  /* ★★ 所见即所得：判"能不能碰到球"看**模型此刻手在哪**，不再画圈。
   *
   *  流程：
   *    ① 必须有门将动作**正在播**（没动作 = 手没伸出去 = 不许吞球）
   *    ② 按动画进度查 gk-reach.json，插值出双手 / 头 / 髋的本地坐标
   *    ③ 换算到世界坐标（髋位置 + 绕 Y 的 yaw 旋转）
   *    ④ 判"球本帧飞行线段"是否真的穿过手 / 头 / 身体
   *
   *  这样：动作没起手 → 接不到；扑错方向 → 手不在这条球路上 → 接不到；
   *        画面上手够到了 → 才判定为接住。完全一致。
   */
  p._gkMinD = 99; p._gkReachR = 0;
  const name = p.gkAnimName;
  const clip = name ? GK_REACH[name] : null;
  if (!clip || !(p.gkAnimT > 0)) { p._gkWhy = '无动作'; return false; }
  // 记录整个窗口里"手离球最近差多少"，窗口关闭时打出来（校准用）
  if (p._gkBest === undefined) p._gkBest = 99;
  /* 进度 = 已播/原始时长。gkAnimT 记的是**真实剩余秒数**（已按 1/spd 折算），
   * 所以要先乘回 spd 才是"动画播到第几成"。 */
  /* ★ 进度必须用 `gkAnimBase`（= 按基准倍速的锁定时长）当分母，**不能**用 clip.dur：
   *   clip.dur 是原始片长（gkCatchLow 2.60s），而 gkAnimT 是从 1.74s（= 2.60÷1.5）开始递减的，
   *   于是 `prog` 一开场就是 1-1.74/2.60 = 0.33 —— 动作**前 1/3（手正在伸出去的关键段）
   *   根本没被采样过**，采样点和画面对不上 → 表现就是"动作看着对，就是接不着球"。 */
  const rel = p.gkAnimRel || 1;
  const prog = 1 - clamp((p.gkAnimT * rel) / Math.max(0.01, p.gkAnimBase || clip.dur), 0, 1);
  const ps = gkPoseAt(name, prog);
  if (!ps) { p._gkWhy = '无姿态'; return false; }

  const hy = (p.y || 0) + ps[9];                     // 髋部世界高度
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
  // 本地 (x=侧, y=上, z=前) → 世界（与客户端 fx=sin(yaw)/fz=cos(yaw) 的朝向约定一致）
  const wx = (lx, lz) => p.x + lx * cy + lz * sy;
  const wz = (lx, lz) => p.z - lx * sy + lz * cy;

  const ax = bs ? bs.x : b.x, az = bs ? bs.z : b.z;
  const ay = bs && bs.y !== undefined ? bs.y : b.y;
  const bx = b.x, by = b.y, bz = b.z;

  const R_BALL = C.BALL_R;
  /* 手部命中半径：手套 + 球。0.42 大致是"手掌到小臂中段"的粗细 ——
   * 真实扑救经常是打在手臂/手套边缘上，只认"拳心那一点"会把门将削得太弱。 */
  const HAND_R = 0.42 + R_BALL;
  const HEAD_R = 0.18 + R_BALL;
  const BODY_R = C.TOUCH_R + R_BALL;                 // 躯干横向

  let best = 99, bestTag = '';

  /* ① 双手 + 前臂
   *   ★ 只判"手"这一点会把门将削得过弱（真实扑救大量命中的是小臂/手套边）。
   *     所以每个手再取一个**朝髋方向回退 0.26m** 的点当作前臂中段 ——
   *     这两个点都是从**动画里手的真实位置**推出来的，依然是所见即所得，
   *     只是把"手臂这一段"也算进接触面，和模型的碰撞体积对得上。 */
  for (const [ox, oy, oz, tag] of [
    [ps[0], ps[1], ps[2], '右手'],
    [ps[3], ps[4], ps[5], '左手'],
  ]) {
    const hx = wx(ox, oz), hz = wz(ox, oz), hyy = hy + oy;
    // 前臂点：手 → 髋 方向回退 0.26m（髋在本地原点，所以直接用 -0.26/|手| 缩放）
    const len = Math.hypot(ox, oy, oz) || 1;
    const fx2 = ox - (ox / len) * 0.26, fy2 = oy - (oy / len) * 0.26, fz2 = oz - (oz / len) * 0.26;
    const ax2 = wx(fx2, fz2), az2 = wz(fx2, fz2), ay2 = hy + fy2;
    for (const [px2, py2, pz2, t2] of [[hx, hyy, hz, tag], [ax2, ay2, az2, tag + '臂']]) {
      const d = segPointDist(ax, ay, az, bx, by, bz, px2, py2, pz2);
      if (d < best) { best = d; bestTag = t2; }
      if (d <= HAND_R) { p._gkMinD = d; p._gkReachR = HAND_R; p._gkWhy = t2; return true; }
    }
  }
  // ② 头（高球用头顶/脸挡）
  {
    const hx = wx(ps[6], ps[8]), hz = wz(ps[6], ps[8]), hyy = hy + ps[7];
    const d = segPointDist(ax, ay, az, bx, by, bz, hx, hyy, hz);
    if (d < best) { best = d; bestTag = '头'; }
    if (d <= HEAD_R) { p._gkMinD = d; p._gkReachR = HEAD_R; p._gkWhy = '头'; return true; }
  }
  // ③ 躯干（抱球/身体挡：髋 → 头 的胶囊；只算横向，按模型实际高度截断）
  {
    const hipY = hy, topY = hy + Math.max(0.35, ps[7]);
    const ballY = clamp(by, hipY, topY);
    // 把球的落点投影到躯干高度上，再算横向距离
    const dxy = Math.hypot(bx - p.x, bz - p.z);
    if (by >= hipY - BODY_R && by <= topY + BODY_R) {
      const d = Math.max(0, dxy - BODY_R);
      if (d < best) { best = d; bestTag = '身体'; }
      if (dxy <= BODY_R) { p._gkMinD = dxy; p._gkReachR = BODY_R; p._gkWhy = '身体'; return true; }
    }
  }

  p._gkMinD = best;
  p._gkReachR = HAND_R;
  p._gkWhy = bestTag + '差' + best.toFixed(2) + 'm';
  if (best < p._gkBest) p._gkBest = best;
  return false;
}

/* 说明：判定用「本帧位移线段到门将圆心的精确最近距离」——这就是"球真实飞过的路径"，
 * 是实体模型判定（不是封满球门的大圆）；低帧率下线段更长也不会虚增范围，
 * 因为最近距离是轨迹本身的属性。远射偏强改用 GK_FAR_DECAY 衰减处理，而不是魔改判定。 */

/** 门将的"右手边"在世界 z 轴的符号：门将面向场内，A 队守 -X → 右 = +Z；B 队反之 */
function keeperRightZ(team) { return team === 'A' ? 1 : -1; }

/** 决定扑救方向（+1 = 门将自己的右侧 / -1 = 左侧）
 *  A 键（向左移动）+ 左键 = 左贴地、D 键 + 左键 = 右贴地，右键同理换成飞扑。
 *  方向按"门将面向场内"这一固定参考系算，不受转身影响。 */
function saveSide(p) {
  const rv = keeperRightZ(p.team);
  if (Math.abs(p.input.mz) > 0.25) return (p.input.mz * rv) >= 0 ? 1 : -1;   // 按玩家按的是左还是右
  const dz = (G.ball.z - p.z) * rv;                                          // 没按方向就朝球那一侧
  return dz >= 0 ? 1 : -1;
}

/* ============================================================
 *  世界状态
 * ============================================================ */
const G = {
  players: new Map(),     // id -> player
  ball: { x: 0, y: C.BALL_R, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, owner: null, lastTouch: null, kickFromX: null, kickFromZ: 0 },
  restart: null,        // 死球重开：{ type, team, x, z, byId, taken, t }
  keeper: { A: null, B: null },   // 各队门将的 playerId
  betPool: { A: 0, B: 0 },        // 本局双方押注总额（按比例算赔率）
  amb: { on: false, t: 0, x: 0, z: 0 },   // 救护车演出状态（有球员复活时进场）
  ambCount: 0,                    // 本局救护车出车次数
  ambPool: { big: 0, small: 0 },  // 救护车大小盘彩池
  /* ★ AI 守门员默认关（用户要求"关掉测试脚本"）。
     它由 spawnTrainingBots 调用 ensureKeeper 创建，属于"看起来像玩家但不是人"的实体。
     需要时用 KEEPERS=1 打开，或在设置面板里开。 */
  keepersOn: process.env.KEEPERS === '1',
  scores: { A: 0, B: 0 },
  clock: C.MATCH_SEC,
  round: 1,
  phase: 'play',          // 'play' | 'goal'
  phaseT: 0,
  lastGoalBy: null,
  botsOn: true,                     // AI 机器人（人机靶子）总开关：全服同步（下面按 BOTS 环境变量定）
  shooterOn: false,                 // 射门机器人（练习用）开关：全服同步（下面按 SHOOTER 环境变量定）
};

function teamCounts() {
  const c = { A: 0, B: 0 };
  for (const p of G.players.values()) c[p.team]++;
  return c;
}

/** 真人数（固定人机不占分队平衡，也不占出生点槽位） */
function realCounts() {
  const c = { A: 0, B: 0 };
  for (const p of G.players.values()) if (!p.bot) c[p.team]++;
  return c;
}

/**
 * 纯玩家分队（人机不参与平衡）：
 *   第 1 人 → 随机一队，自己一个人也能练球
 *   第 2 人 → 一定去另一队，立刻变成 1v1
 *   之后   → 补人少的队，人数相等时随机
 */
function pickTeam() {
  const c = realCounts();
  const total = c.A + c.B;
  if (total === 0) return Math.random() < 0.5 ? 'A' : 'B';
  if (total === 1) return c.A === 1 ? 'B' : 'A';
  if (c.A < c.B) return 'A';
  if (c.B < c.A) return 'B';
  return Math.random() < 0.5 ? 'A' : 'B';
}

/* ============================================================
 *  押注（B 键商店）
 *    每局固定押 100（红队 / 蓝队胜），彩池制：
 *      赔率 = 总池 ÷ 该队池   → 押的人越少，赔率越高（实时随投注比例变化）
 *      结算：押中 → 拿回「下注额 × 赔率」；押错 → 输掉下注额。
 * ============================================================ */
function betOdds() {
  const total = G.betPool.A + G.betPool.B;
  const o = { A: 0, B: 0 };
  for (const t of ['A', 'B']) {
    const pool = G.betPool[t];
    o[t] = pool > 0 ? +clamp(total / pool, C.BET_ODDS_MIN, C.BET_ODDS_MAX).toFixed(2) : 0;  // 0 = 该队暂无人押
  }
  return o;
}
/** 救护车大小盘赔率（同一个彩池公式） */
function ambOdds() {
  const p = G.ambPool || { big: 0, small: 0 };
  const total = p.big + p.small;
  const o = { big: 0, small: 0 };
  for (const k of ['big', 'small']) {
    o[k] = p[k] > 0 ? +clamp(total / p[k], C.BET_ODDS_MIN, C.BET_ODDS_MAX).toFixed(2) : 0;
  }
  return o;
}
function betState() {
  return {
    pool: { ...G.betPool }, odds: betOdds(), amount: C.BET_AMOUNT, round: G.round,
    amb: { pool: { ...(G.ambPool || { big: 0, small: 0 }) }, odds: ambOdds(), count: G.ambCount || 0, line: C.AMB_LINE },
  };
}
function pushBetState() { io.emit('betUpdate', betState()); }

/** 结算本局押注（winner = 'A' | 'B' | null 平局 → 退还本金） */
function settleBets(winner) {
  const odds = betOdds();
  const aOdds = ambOdds();
  const lines = [];
  let any = false;
  for (const p of G.players.values()) {
    // ---- 救护车大小盘：按本局实际出车次数结算 ----
    if (p.ambBet && !p.bot) {
      any = true;
      const hit = (p.ambBet === 'big') ? ((G.ambCount || 0) > C.AMB_LINE) : ((G.ambCount || 0) < C.AMB_LINE);
      if (hit) {
        const gain = Math.round(p.ambAmt * aOdds[p.ambBet]);
        p.coins += gain;
        lines.push(`🚑 ${p.name} 押${p.ambBet === 'big' ? '大' : '小'}${C.AMB_LINE} 中 +${gain}`);
      } else {
        lines.push(`🚑 ${p.name} 押${p.ambBet === 'big' ? '大' : '小'}${C.AMB_LINE} 输掉 ${p.ambAmt}`);
      }
      p.ambBet = null; p.ambAmt = 0;
    }
    if (!p.betTeam || p.bot) continue;
    any = true;
    const amt = p.betAmt || 0;
    const tname = C.TEAMS[p.betTeam].name;
    if (!winner) {                                   // 平局：退回本金
      p.coins += amt;
      lines.push(`🪙 ${p.name} 平局退还 ${amt}`);
    } else if (p.betTeam === winner) {
      const gain = Math.round(amt * odds[p.betTeam]);
      p.coins += gain;
      lines.push(`🪙 ${p.name} 押中 ${tname} +${gain}`);
    } else {
      lines.push(`🪙 ${p.name} 押 ${tname} 输掉 ${amt}`);
    }
    p.betTeam = null; p.betAmt = 0;
  }
  G.betPool.A = 0; G.betPool.B = 0;
  G.ambPool = { big: 0, small: 0 };
  G.ambCount = 0;                                // 新一局重新统计出车次数
  if (any) io.emit('betSettle', { winner, odds, lines, ambOdds: aOdds, ambCount: G.ambCount });
  pushBetState();
}

const FORMATION = {
  // 开球阵型（按 105×68 的比例摆位，都在己方半场）
  A: [[-24, 0], [-18, -17], [-18, 17], [-9, -10], [-9, 10]],
  B: [[24, 0], [18, 17], [18, -17], [9, 10], [9, -10]],
};

function spawnPos(team, slot) {
  const f = FORMATION[team];
  const p = f[slot % f.length];
  return { x: p[0], z: p[1] };
}

function makePlayer(id, name, team) {
  const slot = realCounts()[team];          // 人机不占出生点槽位
  const s = spawnPos(team, slot);
  const dir = team === 'A' ? Math.PI / 2 : -Math.PI / 2;   // 面向对方球门（A 攻 +X，B 攻 -X）
  return {
    id, name, team, color: C.TEAMS[team].color, bot: false,
    x: s.x, y: 0, z: s.z,
    yaw: dir, aimYaw: dir,
    vx: 0, vy: 0, vz: 0,
    mode: 'soccer',                 // 'soccer' | 'attack' | 'dance'
    input: { yaw: dir, mx: 0, mz: 0, sprint: false, jump: false, walk: false, dance: 1,
             ct: null, cp: 0, kdir: null, cspot: null },   // ct/cp/kdir/cspot = 第一脚击球的蓄力上行
    anim: 'idle', animT: 0, animSpd: 1, animLock: 0, idleT: 0,   // idleT = 连续静止时长（站立久了换待机动画）
    dribbling: false,
    kickCd: 0, grabCd: 0, slideT: 0, slideCd: 0, stealCd: 0, punchCd: 0, skillCd: {},
    passCd: 0,                      // ★ 传球独立冷却（3s）—— 只卡传球，不卡射门
    hp: C.HP_MAX, hurtT: 99, downT: 0, upT: 0, _tackled: null,
    hurtAnim: null, hurtAnimT: 0, throwInT: 0,
    throwPending: null, restartHint: false, restartReady: false,
    aimLock: false, gkStep: 0,
    cards: [{ id: 'striker', name: '前锋', spent: false }], boostT: 0,
    gkSaveT: 0, gkMoveT: 0, gkSaveR: 0, gkSaveVX: 0, gkSaveVZ: 0, gkHold: false, gkOutT: 0, isGK: false, gkKind: 'block',
    gkActCd: 0,                     // 门将动作收招保护（0.1s 级）
    gkAnimT: 0,                     // 当前门将动作剩余时长（>0 期间不接受新的门将起手）
    oneShotSeq: 0,                  // 一次性动作"起手序号"（客户端据此判断是否重播，见主循环）
    _lkPrev: 0, _headPrev: 0,       // 上一帧的 animLock / headAnimT（用来检测"跳高"）
    headCd: 0,                      // 头球冷却（防一帧多顶）
    headAnimT: 0,                   // 头球动作剩余时长（客户端据此播 header）
    gkAnimName: '',                 // 当前/最近一次门将动作名（判重用）
    gkManualT: 99,                  // 距上次玩家手动扑救的时间（自动接球要给它让位）
    gkRelease: null,                // 门将出球的发力时刻（到点才放球）
    dance: 1,                       // 跳舞模式当前舞段（1~9）
    // ---- 球员席 / 复活（血量清零 → 场边坐等 → 救护车送回） ----
    reviveWalk: false,              // 刚复活：自动跑回自己半场
    onBenchSpawn: false,            // true = 本次 reviveWalk 是"新入场从球员席走上场"
    dying: false,                   // 正在播"死亡倒地"（播完才被抬进球员席）
    dyingT: 0,
    dead: false,
    revT: 0,                        // 剩余进场倒计时（秒）
    revT0: 0,                       // 本次倒计时初始值（客户端画进度用）
    benchIdx: 0,                    // 在球员席的座位号（按队排）
    // ---- 押注（B 键商店）：每局固定押 100，按投注比例实时结算赔率 ----
    coins: C.BET_START_COINS,       // 金币
    betTeam: null,                  // 本局押的队：null / 'A' / 'B'
    betAmt: 0,                      // 本局押注额
    ambBet: null, ambAmt: 0,        // 救护车大小盘押注（'big' | 'small'）

    slideDir: { x: 0, z: 0 },
    kickType: 'pass', kickSpd: 0,
    kickAnim: 0,
    spawn: { x: s.x, z: s.z },
  };
}

function resetBall(toTeam) {
  G.ball.x = 0; G.ball.y = C.BALL_R; G.ball.z = 0;
  G.ball.vx = 0; G.ball.vy = 0; G.ball.vz = 0;
  G.ball.wx = 0; G.ball.wy = 0;
  G.ball.owner = null;
  if (toTeam) {                       // 失球方开球：球稍微偏向失球方
    G.ball.x = toTeam === 'A' ? -2 : 2;
  }
}

function resetPositions() {
  let slotA = 0, slotB = 0;
  for (const p of G.players.values()) {
    if (p.bot) continue;                       // 固定人机不回出生点，钉在原地
    /* ★ 用户要求"进球后门将的位置不动，其他球员回到自己的半场"。
     *   门将（AI 或真人）留在球门区原地，只清掉速度/带球/动作，不重新站位 ——
     *   否则每次进球门将都被瞬移到阵型点，扑救站位白攒。 */
    if (isKeeper(p)) {
      p.vx = 0; p.vz = 0; p.vy = 0;
      p.dribbling = false; p.slideT = 0; p.kickAnim = 0; p.anim = 'idle';
      continue;
    }
    const s = p.team === 'A' ? spawnPos('A', slotA++) : spawnPos('B', slotB++);
    p.x = s.x; p.z = s.z; p.y = 0;
    p.vx = 0; p.vz = 0; p.vy = 0;
    p.yaw = p.team === 'A' ? Math.PI / 2 : -Math.PI / 2;
    p.aimYaw = p.yaw;
    p.dribbling = false; p.slideT = 0; p.kickAnim = 0; p.anim = 'idle';
  }
}

/* ============================================================
 *  固定人机（测试靶子）：BOTS=0 关闭，默认 1 个
 *  - 站着不动、不发输入，可被打拳、被滑铲铲倒、被球撞弹开
 *  - 每 tick 钉回固定点（不会被撞开），血量正常回
 *  - 放在 B 队：第一个进来的真人必去 A 队，立刻能拿它练手
 * ============================================================ */
/* ★ 默认**关**（用户要求"默认关掉靶子"）。想开就在设置面板里开，或用 BOTS=n 强制指定。 */
const BOT_COUNT = Math.max(0, Math.min(4, Number(process.env.BOTS ?? 0)));
const BOT_TOGGLE_N = Math.max(1, BOT_COUNT);     // 游戏内开关打开时上几个（默认至少 1 个）
G.botsOn = BOT_COUNT > 0;                        // BOTS=0 → 默认就是关
/* 射门机器人默认开关：SHOOTER=A/B → 默认开；SHOOTER=0 或未设 → 默认关。
 * ★ 不管默认开还是关，玩家都能在设置面板里改（全服同步）。 */
G.shooterOn = (() => { const v = String(process.env.SHOOTER || '').trim(); return !!v && v !== '0'; })();
/* ★ 用户要求"人机靶子放在替补席旁边界外"。
 *   球员席在 z = -(HALF_W + BENCH.OUT) = -36.4（北侧边线外），本体宽 15+1.6 → x ∈ [-8.3, 8.3]。
 *   所以把 4 个靶子摆在**替补席两侧的界外空地**（x = ±10.5 / ±13.5，和替补席同一深度），
 *   既在界外、又不挡球员席的座位和救护车通道。 */
const BOT_SPOTS = [
  { x: -10.5, z: -36.4 }, { x: -13.5, z: -36.4 },
  { x: 10.5, z: -36.4 }, { x: 13.5, z: -36.4 },
];
/** 加人机靶子（游戏内开关 / 启动时都会调用） */
function addDummyBots(n) {
  const total = Math.max(0, Math.min(4, n | 0));
  for (let i = 0; i < total; i++) {
    const id = 'bot_dummy_' + i;
    if (G.players.has(id)) continue;
    const p = makePlayer(id, '人机靶子' + (i ? '-' + (i + 1) : ''), 'B');
    p.bot = true;
    const s = BOT_SPOTS[i % BOT_SPOTS.length];
    p.x = p.bx = s.x; p.z = p.bz = s.z;
    p.yaw = p.aimYaw = Math.atan2(-s.x, -s.z);      // 面向中圈
    p.spawn = { x: s.x, z: s.z };
    G.players.set(id, p);
    console.log(`[足球] 人机靶子 ${p.name} 就位 (${s.x}, ${s.z})`);
  }
}
/** 撤掉所有人机靶子（不影响 AI 守门员） */
function removeDummyBots() {
  let n = 0;
  for (const [id, p] of [...G.players]) {
    if (!p.bot || p.botGK || p.botShooter) continue;
    if (G.ball.owner === id) { G.ball.owner = null; G.ball.vy = 0.5; }
    G.players.delete(id);
    n++;
  }
  if (n) console.log(`[足球] 撤掉 ${n} 个人机靶子`);
  return n;
}
/** 全服同步的机器人开关（谁点都一样，所有人都看到同一个状态） */
function setBots(on, by) {
  G.botsOn = !!on;
  if (G.botsOn) addDummyBots(BOT_TOGGLE_N); else removeDummyBots();
  io.emit('botsState', { on: G.botsOn, by: by || null });
  if (by) io.emit('chat', { type: 'system', text: `${by} ${G.botsOn ? '开启' : '关闭'}了 AI 机器人` });
}

function spawnTrainingBots() {
  if (G.botsOn) addDummyBots(BOT_COUNT);
  // AI 守门员：两边各一个（可用游戏内开关或 KEEPERS=0 关闭）
  for (const team of ['A', 'B']) ensureKeeper(team);

  // 射门机器人（练习用）：由 SHOOTER 环境变量给默认值，**也可以在设置面板里随时开关**
  if (G.shooterOn) addShooterBot();
}

/**
 * 射门机器人：自己带球到随机位置、朝球门范围内随机点射门（练习扑救用）。
 * ★ 用户反馈"有个脚本机器人没有关得掉" —— 它原来只由 `SHOOTER` 环境变量控制，
 *   设置面板里没有开关。现在抽成 add/remove，挂了 `swShooter` 开关（全服同步）。
 * gkTeam = 攻哪一队的球门（'A' 或 'B'）。
 */
const SHOOTER_TEAM = (() => {
  const v = String(process.env.SHOOTER || '').trim();
  return (v === 'A' || v === 'B') ? v : 'A';       // 默认攻 A 门
})();
function addShooterBot(gkTeam = SHOOTER_TEAM) {
  const gk = (gkTeam === 'A' || gkTeam === 'B') ? gkTeam : 'A';
  const id = 'bot_shooter';
  if (G.players.has(id)) return;
  const team = gk === 'A' ? 'B' : 'A';
  const p = makePlayer(id, '射门机器人', team);
  p.bot = true; p.botShooter = true;
  p.attachSide = gk === 'A' ? -1 : 1;              // 攻 gk 的球门
  p.x = p.bx = 0; p.z = p.bz = 0;
  p.spawn = { x: 0, z: 0 };
  p.shootState = 'idle'; p.shootT = 0;
  G.players.set(id, p);
  console.log(`[射门机器人] 已就位 —— 会把球带到随机位置、朝 ${gk} 队球门范围内随机点射门`);
}
function removeShooterBot() {
  const p = G.players.get('bot_shooter');
  if (!p) return;
  if (G.ball.owner === 'bot_shooter') { G.ball.owner = null; G.ball.vy = 0.5; }
  G.players.delete('bot_shooter');
  console.log('[射门机器人] 已撤掉');
}
/** 全服同步的射门机器人开关 */
function setShooter(on, by) {
  G.shooterOn = !!on;
  if (G.shooterOn) addShooterBot(); else removeShooterBot();
  io.emit('shooterState', { on: G.shooterOn, by: by || null });
  if (by) io.emit('chat', { type: 'system', text: `${by} ${G.shooterOn ? '开启' : '关闭'}了射门机器人` });
}

/* ============================================================
 *  AI 守门员：沿门线侧步封堵（哪边更靠近球就往哪边走）+ 够不着的高球才飞扑
 *  判定按"身体/手臂面积"来（见 gkCanReach），不再是一个封满球门的大圆圈——
 *  空位该进球就得进。
 * ============================================================ */
/**
 * 射门机器人（测试用）：自己带球走到随机位置，朝**球门范围内的随机点**射门。
 *  目的：让玩家当守门员时能测试真实的拦截范围（球门每个角落都会被射到）。
 *  开启：环境变量 SHOOTER=1（或 SHOOTER=<队名 A/B>），默认关。
 *  行为循环：抢/捡球 → 走到随机射门点 → 瞄准随机落点 → 射门 → 回到起点等一会。
 */
function updateShooterBot(p, dt) {
  if (!p.botShooter) return;
  const b = G.ball;
  const side = p.attachSide !== undefined ? p.attachSide : (p.team === 'A' ? 1 : -1);
  const targetGoalX = side * C.FIELD.HALF_L;              // 要攻的球门（side = 攻门方向）
  const inward = -side;                                   // 朝场内

  // 死球期间：等 restart 处理（避免干扰发球流程）
  if (G.restart || G.phase !== 'play') { p.input.mx = 0; p.input.mz = 0; p.input.grab = false; return; }

  // 倒地等异常：啥也不做
  if (p.downT > 0 || p.upT > 0) return;

  const st = p.shootState || (p.shootState = 'idle');
  p.shootT = (p.shootT || 0) + dt;

  const sp = Math.hypot(p.vx, p.vz);
  const dirTo = (tx, tz) => {
    const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz) || 1;
    return { x: dx / d, z: dz / d, d };
  };

  switch (st) {
    case 'idle': {                                        // 站一会，然后开始下一轮
      p.input.mx = 0; p.input.mz = 0; p.input.sprint = false; p.input.grab = false;
      if (p.shootT > 1.6) {
        p.shootT = 0;
        // 随机射门点：距门线 7~26m、横向 -18~18m
        const dist = 7 + RND() * 19;
        p.shootAim = { x: targetGoalX + inward * dist, z: (RND() - 0.5) * 36 };
        // 随机落点：球门范围内（含门柱内侧 + 上下死角）
        const gw = C.GOAL.W / 2;
        // 高度分三档轮换，保证「贴地 / 半高 / 上角高球」都能被测到（避免随机偏科）
        const tier = Math.floor(RND() * 3);
        const yAim = tier === 0 ? (0.02 + RND() * 0.45)           // 贴地
                   : tier === 1 ? (0.7 + RND() * 0.7)                     // 半高
                   : (1.6 + RND() * 0.75);                                 // 上角高球
        p.shootSpot = {
          z: (RND() * 2 - 1) * (gw - 0.25),
          y: yAim,
        };
        p.shootState = 'goBall';
      }
      return;
    }
    case 'goBall': {                                      // 去捡球（没人持球时）
      if (b.owner === p.id) { p.shootState = 'walk'; p.shootT = 0; return; }
      if (b.owner && b.owner !== p.id) { p.shootState = 'idle'; p.shootT = 0; return; }   // 球被人拿着 → 等
      const t = dirTo(b.x, b.z);
      p.input.yaw = Math.atan2(t.x, t.z);
      // 必须走到吸附距离（GRAB_DIST=0.5m）以内，否则按 F 也吸不到球 → 会卡在球边
      const stopAt = C.GRAB_DIST * 0.7;
      p.input.mx = t.d > stopAt ? t.x : 0;
      p.input.mz = t.d > stopAt ? t.z : 0;
      p.input.sprint = t.d > 7;
      p.input.walk = t.d < 2.5;                           // 贴近时慢走，别冲过球
      p.input.grab = true;                                // 全程按住 F（贴近自动吸附）
      if (p.shootT > 14) { p.shootState = 'idle'; p.shootT = 0; }   // 兜底超时
      return;
    }
    case 'walk': {                                        // 带球走到随机射门点
      // 中途球掉了 → 回去捡
      if (b.owner !== p.id) { p.shootState = 'goBall'; p.shootT = 0; return; }
      const t = dirTo(p.shootAim.x, p.shootAim.z);
      if (t.d < 1.6 || p.shootT > 14) {
        p.input.mx = 0; p.input.mz = 0; p.input.sprint = false;
        p.input.grab = true;
        p.shootState = 'aim'; p.shootT = 0;
        return;
      }
      p.input.yaw = Math.atan2(t.x, t.z);
      p.input.mx = t.x; p.input.mz = t.z;
      p.input.sprint = t.d > 8;
      p.input.grab = true;
      return;
    }
    case 'aim': {                                         // 瞄准随机落点，稳定一下再射
      if (b.owner !== p.id) { p.shootState = 'goBall'; p.shootT = 0; return; }   // 球掉了 → 重捡
      p.input.mx = 0; p.input.mz = 0; p.input.grab = true;
      const az = p.shootSpot.z - b.z;
      const ax = targetGoalX - b.x;
      p.input.yaw = Math.atan2(ax, az);
      if (p.shootT > 0.45) {
        if (b.owner === p.id && p.kickCd <= 0) {
          // 力度：随机（有时轻射、有时爆射）
          const power = 0.6 + RND() * 0.4;
          const l = Math.hypot(targetGoalX - b.x, p.shootSpot.z - b.z) || 1;
          // 抛体补偿：球会下沉（重力 20），要打出目标高度必须抬高仰角。
          // 用 v = 力度算出的出球速度反解所需仰角 θ：
          //   y = v sinθ·t - ½g t²,  t = l / (v cosθ)
          // 直接迭代几次逼近即可（闭式解要考虑 cos^0.6 补偿，迭代更稳）。
          const spd = C.KICK_SHOOT * power;
          const dy = p.shootSpot.y - 0.5;                 // 出手高度约 0.5m
          let elev = Math.atan2(dy, l);
          for (let it = 0; it < 6; it++) {
            const c = Math.pow(Math.cos(elev), 0.6);
            const vx = spd * c;
            const t = l / Math.max(0.5, vx);
            const need = dy + 0.5 * C.GRAVITY * t * t;     // 需要的竖直位移（含下沉补偿）
            const vy = need / Math.max(0.05, t);
            elev = Math.atan2(vy, vx);
          }
          elev = clamp(elev, -0.05, 0.95);
          const dir = { x: (targetGoalX - b.x) / l, y: Math.sin(elev), z: (p.shootSpot.z - b.z) / l };
          if (tryKick(p, dir, power, 'shoot')) GK_STATS.shots++;
          p.shootLog = { from: { x: +b.x.toFixed(1), z: +b.z.toFixed(1) }, to: { z: +p.shootSpot.z.toFixed(2), y: +p.shootSpot.y.toFixed(2) }, power: +power.toFixed(2), dist: +l.toFixed(1), elev: +(elev * 180 / Math.PI).toFixed(0) };
          console.log(`[射门机器人] 射门 从(${b.x.toFixed(1)},${b.z.toFixed(1)}) 瞄 z=${p.shootSpot.z.toFixed(2)} 高=${p.shootSpot.y.toFixed(2)}m 仰角=${(elev * 180 / Math.PI).toFixed(0)}° 力度=${power.toFixed(2)}`);
        }
        p.shootState = 'idle'; p.shootT = 0;
      }
      return;
    }
  }
}

/**
 * 门将抱球在手时的处理：
 *  · AI 门将：抱满 2 秒自动出球（否则球一直在手上，比赛无法继续）
 *  · 真人门将：**不自动发球** —— 让他自己决定传/射（按左/右键蓄力出球）
 */
function updateKeeperHeldBall(p, dt) {
  if (!p.gkHold) { p.holdT = 0; return; }
  /* ★ 倒地期间不出球（抱球被铲倒后新增的状态组合）。
   *   以前"被铲倒"必然掉球，所以 gkHold + 倒地 这个组合不存在；
   *   现在抱球不可被夺 → 铲倒也不掉球 → 必须自己挡住"躺着还能把球扔出去"。 */
  if (p.downT > 0 || p.upT > 0) return;
  if (!p.botGK) return;                     // 真人门将：交给玩家操作，不自动出球
  /* ★ 抱球到出球的间隔：1.2s → 0.6s。
   *   门将抱着球是不防守的，1.2s + 出球动作的发力时刻（再 1.5s）≈ 2.7s 完全空门状态；
   *   射门机器人连射时这段时间被吃满，看起来就像"门将不扑救"。
   *   真实门将收球后 0.5~1s 就发动快攻，0.6s 更合理。 */
  p.holdT = (p.holdT || 0) + dt;
  if (p.holdT <= 0.6) return;
  p.holdT = 0;
  const side = ownGoalSign(p.team);
  const inward = -side;
  // 有队友在近处 → 滚地短传；否则原地大脚开出去
  //   （AI 不用 gkDrop 助跑大脚：原速播完整段要 8 秒，会把比赛拖死）
  let mate = null, md = 1e9;
  for (const q of G.players.values()) {
    if (q.id === p.id || q.team !== p.team) continue;
    const dd = Math.hypot(q.x - p.x, q.z - p.z);
    if (dd < md) { md = dd; mate = q; }
  }
  /* 优先滚地短传（gkRoll 3.15s，发力时刻早 → 1.5s 就脱手）。
   *   原来阈值 22m，而门将离最近的 AI 队友常常 30m+ → 一律用 gkKick（3.92s，2.3s 才脱手），
   *   门将大半时间在做出球动作。放宽到 60m（几乎总是 roll），出球快、空门时间短。 */
  const roll = mate && md < 60;
  gkDistribute(p, roll ? 'roll' : 'kick', mate, inward);
}


function updateKeeperAI(p, dt) {
  if (!p.botGK || G.keeper[p.team] !== p.id) return;
  if (!p.aimLock) { p.aimLock = true; p.gkOutT = 0; }         // AI 门将始终锁定防守
  if (G.restart) return;                                   // 死球期间不动
  const b = G.ball;
  const side = ownGoalSign(p.team);                        // 自家球门在 x 的方向
  const goalX = side * C.FIELD.HALF_L;
  const inward = -side;                                    // 朝场内方向
  const distGoal = Math.abs(b.x - goalX);
  const halfW = C.GOAL.W / 2;                              // 门柱半宽 3.66m
  // 球已被踢出（无人持球 + 球速不低）→ 门将已经"下注"，横向再调整的能力大幅下降。
  //   否则飞/滚过来的球会被门将一路贴身横移堵枪眼（等于自动封门，怎么射都被拦）。
  const flying = (b.owner === null && Math.hypot(b.vx, b.vz) > 5.0);
  const shuffleSpd = flying ? C.GK_SHUFFLE_SPD * 0.78 : C.GK_SHUFFLE_SPD;

  // ⓪ 抱在手里：交给共用的"门将出球"逻辑（真人 + AI 都走这里）
  if (p.gkHold) { updateKeeperHeldBall(p, dt); return; }
  p.holdT = 0;

  /* 正在扑救位移 / 接球动作中：不要改站位，否则会把扑救位移覆盖掉 */
  if (p.gkMoveT > 0 || p.gkSaveT > 0 || p.animLock > 0.1) {
    p.input.mx = 0; p.input.mz = 0;
    p.input.yaw = Math.atan2(b.x - p.x, b.z - p.z);
    return;
  }

  /* ① 预判射门：算球飞到门线时的落点（横向 zPred / 高度 yPred）
   *    先侧步往落点那边横移；真的够不到（且不算太离谱）才飞扑。
   *    远射衰减：球从越远处踢来，门将预判越不准 + 反应越慢 —— 给远射留进球空间。 */
  if (b.owner === null) {
    const vxToward = b.vx * side;                          // 朝球门的速度分量（球门在 side 方向）
    if (vxToward > 3 && distGoal < 34 && distGoal > 0.5) {
      const t = distGoal / Math.max(0.5, Math.abs(b.vx));  // 到门线还剩多久
      const zPred = b.z + b.vz * t;
      const yPred = b.y + b.vy * t - 0.5 * C.GRAVITY * t * t;
      // 远射：按"射门起点到球门的距离"判断（球飞到门前时当前位置总是很近，
      // 用当前位置会让远射衰减失效）。起点越远 → 预判误差越大、反应越慢、扑救范围越窄。
      const originDist = (b.kickFromX != null) ? Math.hypot(b.kickFromX - goalX, b.kickFromZ) : distGoal;
      const farK = clamp((originDist - 6) / 14, 0, 1);     // 0=近（≤6m） 1=远（20m+）
      const jit = farK * 0.55;                             // 最大预判误差 ±0.55m（原来 1.35 太瞎）
      const zAim = zPred + (b.aimJit || 0) * jit;          // 每次出球固定的偏移（不逐帧随机）
      const need = clamp(zAim, -halfW, halfW) - p.z;        // 门框内需要横移多少
      const reach = Math.abs(need);                         // 落点离门将多远

      // 反应时间：远射给门将的反应更晚（球飞得久但人也"押得住"，这里反向减速）
      const canReact = t > 0.07 + farK * 0.09;
      // 远射迟滞：球从远处飞来时门将不会立刻押宝（怕被假动作骗），
      // 等球飞近到一定时间才开始全力判断 —— 远射窗口因此明显收窄
      const farHold = t > (3.4 - 1.0 * farK) ? false : true;
      if (!farHold) {
        // 还在"观望期"：只做小幅度站位微调，不飞扑
        p.input.mx = 0; p.input.mz = 0;
        p.input.yaw = Math.atan2(b.x - p.x, b.z - p.z);
        return;
      }
      // 够不到才扑：落点超过站立接球范围、又在扑救可及范围内
      // 远射时降低扑救意愿（要求更偏才扑，且够得到的范围收紧）
      // 命中判据：近射（球飞得短、门将贴身）允许更宽一点的手臂范围；
      // 远射则相反 —— 靠"移动到位"而不是"伸手拦截"
      const nearBoost = 1 + 0.30 * (1 - farK);              // 近射臂展 +30%
      const diveReach = C.GK_DIVE_REACH * (1 - 0.10 * farK) * nearBoost;
      /* ★ 判定范围放宽到"站立够不到就要动"：
       *   原来下界是 GK_HAND_R+0.45(=1.15m)，中间那一段（0.7~1.15m）既不够站立接、
       *   又不够触发扑救 → 门将"看着球过去"（改造后接球率偏低的主因）。
       *   现在只要超过站立臂展就起动作，靠动作里手的真实位置去够（仍是所见即所得）。 */
      const inDiveRange = reach > C.GK_HAND_R && reach < diveReach;
      /* 正对身体的快球（reach 很小）也允许**原地挡/接**：
       *   以前 notStraightOn 把它排除掉，只能靠身体碰撞箱把球弹开（等于"没动作就挡下了"）。
       *   现在让门将起一个 block/接球动作，靠动作里手的真实位置去够。 */
      const straightFast = !inDiveRange && reach <= C.GK_HAND_R && Math.abs(b.vx) > 8;
      // 高于站立腰腹（约 1.2m 以上）→ 才需要跳；正对脚下的球不扑，交给接球动作
      const highBall = yPred > 1.2;
      const notStraightOn = reach > C.GK_HAND_R;             // 正对身体的来球 → 不扑（腹接/地接）

      if (canReact && (inDiveRange || straightFast) && t < C.GK_REACT_T &&
          p.kickAnim <= 0 && p.gkSaveT <= 0) {
        // 远射不允许飞扑：球飞得久，门将应该靠"移动到位"处理（真实足球也如此），
        // 否则侧步 1.8m + 飞扑 2.9m 叠加 = 能覆盖整个球门，远射全被拦。
        /* ★★ 正对身体的来球（reach ≤ 站立臂展）→ **原地**起接球动作，绝不横向扑。
         *   原来这里走 keeperSave('block')，方向取 `side || 1`（那是"朝场内"的 x 方向！），
         *   位移又受 GK_MOVE_MIN 下限影响 → 门将一边横移一边做侧扑动作，
         *   球却从正中间过去。现在直接用按球高选的接球动作，零位移。 */
        if (straightFast) {
          const nm = yPred > 1.35 ? 'gkCatchHigh' : (yPred > 0.70 ? 'gkCatchBody' : 'gkCatchLow');
          const durC = C.GK_CATCH[nm];
          const momC = GK_MOMENT[nm] || 0.28;
          const spdC = clamp((momC * durC) / Math.max(0.08, t), 1, 3.2);
          if (gkStartAnim(p, nm, durC, spdC)) {
            p.gkSaveT = p.kickAnim;
            p.gkMoveT = 0; p.gkSaveVX = 0; p.gkSaveVZ = 0;     // ★ 原地，不位移
            p.gkKind = 'catch';
            p.input.mx = 0; p.input.mz = 0;
            if (GK_DEBUG) console.log(`[GK正对] ${p.name} ${nm} ${durC.toFixed(2)}s ×${spdC.toFixed(1)} need=${need.toFixed(2)}`);
            io.emit('gkSave', { by: p.name, kind: 'catch' });
            return;
          }
          // 起手被挡（收招窗口内）→ 落到下面的扑救/侧步，不硬吞球
        }
        const allowDive = farK < 0.90;                      // 远射也允许扑（配合更准的预判）
        const kind = !(highBall || reach > 1.6) ? 'block' : 'dive';
        /* 方向：只按"球偏在哪一侧"决定；正对（|need| ≤ 0.12m）时按 0 处理，
         * 配合 keeperSave 里 mv≈0 → 原地起动作，绝不自己让开中路。 */
        const dir = need > 0.12 ? 1 : (need < -0.12 ? -1 : 0);
        const side2 = (dir === 0 ? keeperRightZ(p.team) : dir * keeperRightZ(p.team));
        /* ★ 变速：gk-reach.json 里每个扑救动作"手到位"的时刻（20~27%），
         *   反推该用多快播 —— 让**手伸到位的那一刻**正好是球到门线的那一刻。
         *   否则快速射门时球早就到了，手还在抬起来（表现为"没扑就丢球"或"球自己进手"）。 */
        const nm = (kind === 'dive' ? 'gkDive' : 'gkBlock') + (side2 > 0 ? 'R' : 'L');
        const mom = GK_MOMENT[nm] || 0.24;
        const spd = clamp((mom * (C.GK_ANIM[nm] || 2.5)) / Math.max(0.08, t), 1, 3.2);
        if (kind === 'dive' && !allowDive) {
          // 远射高球：只做贴地扑挡（够不到的远角就让它进）
          keeperSave(p, 'block', side2, clamp(reach / diveReach, 0.3, 1), reach, spd, t);
          return;
        }
        const pw = clamp(reach / diveReach, 0.35, 1);
        keeperSave(p, kind, side2, pw, reach, spd, t);
        return;
      }
      // 还在门框范围内 → 提前侧步挪过去（限速！跑不过去的球就够不着）
      if (Math.abs(zPred) < halfW + 1.2 && t < 2.6) {
        const targetX = goalX + inward * 1.0;                // 尽量贴门线
        // 跑位误差：远射时门将判断没那么准（不会完美贴点），误差随距离放大（每次出球固定）
        const aimOff = (b.aimJit || 0) * farK * 0.55;
        // 侧步速度就这么多：算上反应时间也补不到 → 只能目送（空位该进就进）
        // 远射迟滞：球飞得久门将容易"等球"，横移不敢全速（怕被晃）→ 远射拦截率下降
        // 球已在飞行中 → 门将已下注，横移进一步受限（不能跟着球跑）
        const spd = Math.min(shuffleSpd, C.GK_SHUFFLE_SPD * (1 - 0.30 * farK));
        gkStepTo(p, targetX, need + aimOff, spd);
        p.input.yaw = Math.atan2(b.x - p.x, b.z - p.z);
        return;
      }
    }
  }

  /* ② 常规站位：门线侧步封堵 —— 哪边更靠近球就往哪边走
   *    带球到左门柱前 → 门将侧步到左边；球在中路 → 回中路。
   *    球越近，门将越贴球那一侧（越需要封近角）；球远则收在中路封角度。 */
  const distGoal2 = Math.abs(b.x - goalX);
  /* ★ 站位 = 封角平分线（见 gkBisectZ 的说明）。
   *   比原来的 `0.3 + 0.62*near` 线性近似准得多：球在侧翼时不会再跑到同侧角上，
   *   而是站在"两侧角度均分"的位置 —— 这是拦截率能不能上去的关键。 */
  const lateral = gkBisectZ(b.x, b.z, goalX, halfW);
  // 纵深：球远 → 站出去一点点收角度（但别跑太远，门将就该在门线附近）；球近 → 退回门线
  const standOff = clamp(0.9 + Math.max(0, distGoal2 - 10) * 0.09, 0.9, 2.2);
  const targetZ = lateral;
  const targetX = goalX + inward * clamp(standOff, 1.0, 3.0);
  gkStepTo(p, targetX, targetZ, shuffleSpd);
  p.input.mx = 0; p.input.mz = 0;
  p.input.sprint = false; p.input.walk = false;
  p.input.yaw = Math.atan2(b.x - p.x, b.z - p.z);          // 面向球
}

/* ============================================================
 *  事件：踢球 / 吸附 / 铲球 / 模式
 * ============================================================ */
function dist2D(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

function tryGrab(p) {
  if (p.grabCd > 0) return false;
  const d = Math.hypot(p.x - G.ball.x, p.z - G.ball.z);
  const dy = Math.abs(G.ball.y - 0.4);
  /* ★ 用户要求"拓宽正前方扇形范围的抢断和持球"：
   *   原来是 d > GRAB_DIST(0.5m) 就一律拿不到 —— 球稍微偏一点点就吸不上，
   *   接球/抢断手感很紧。现在改成「贴身圆圈 0.5m OR 正前方 1.25m / ±62° 扇形」
   *   （shared.js 的 inControlRange，客户端提示用的同一份判定）。 */
  const wasOwned = !!G.ball.owner && G.ball.owner !== p.id;      // 这是一次"抢断"而不是"接球"
  /* ★★ 抱住球的门将不能被抢（用户反馈"门将持球被抢夺了"）。
   *   必须在**任何范围判定之前**挡掉 —— 抱球时球贴在门将胸口 0.97m 高，
   *   横向几乎与门将重合，所以 inControlRange 的"0.5m 贴身圈"必然命中，
   *   对手贴着门将按 F 就能把球吸走。这里直接拒绝这一次吸附请求。 */
  if (gkHoldingPlayer()) return false;
  /* ★ 门将在本方禁区内按 F = **扑救/扑脚下球**，覆盖范围比普通球员大得多：
   *   普通球员只认"贴身 0.5m 圆 / 正前 1.25m 扇形"，而单刀时球在对手脚下，
   *   门将离球常常 1.5~2.5m —— 按 F 会直接被这个范围挡掉（用户反馈"按 F 抢不了球"）。
   *   现在门将禁区内 2.2m 内按 F 都能把球按住。 */
  const keeperReach = isKeeper(p) && inOwnBox(p) && d <= 2.2;
  if (!(inControlRange(p, G.ball.x, G.ball.z) || keeperReach) || dy > 1.2) return false;
  // 有人持球时：球只要落在自己的控制扇形里就断得掉；
  // 另外保留"贴到持球者身边"这条老路径（从侧后方贴身也能掏球）
  if (G.ball.owner && G.ball.owner !== p.id) {
    const o = G.players.get(G.ball.owner);
    if (!o) return false;
    const od = Math.hypot(p.x - o.x, p.z - o.z);
    /* ★ 门将在本方禁区内有"扑脚下球"的特权：抢断半径放宽 1.0m。
     *   用户反馈"门将面前单刀按 F 抢不了球" —— 单刀时对手常常在 1.7~2.5m 外，
     *   普通球员的 STEAL_DIST+0.4(=1.7) 门槛把这个距离挡掉了，
     *   但门将本来就该能扑出去把球按住（真实门将的禁区控制范围更大）。 */
    const stealR = C.STEAL_DIST + (isKeeper(p) ? 1.5 : 0.4);
    if (od > stealR && d > C.GRAB_DIST) return false;
    o.dribbling = false;
  }
  G.ball.owner = p.id;
  G.ball.vx = G.ball.vy = G.ball.vz = 0;
  G.ball.kickFromX = null;                    // 被拿住 → 清掉上一脚的起点（避免残留影响门将判断）
  p.dribbling = true;
  /* ★ 门将在本方禁区内按 F 拿到的球 = **抱在怀里**（和 AI 门将没收后一致）。
   *   否则真人门将会用普通带球的姿势（球贴脚前）抱着球站在门线上，
   *   和 gkHold 的抱球动作对不上，看起来像"捡了个球在脚下"。
   *   抱球期间照常可以按左/右键出球（tryKick 只看 ball.owner + dribbling）。 */
  if (isKeeper(p) && inOwnBox(p)) { p.gkHold = true; p.holdT = 0; }
  p.grabCd = C.GRAB_CD;
  G.ball.lastTouch = p.id;
  if (wasOwned) io.emit('steal', { by: p.name, id: p.id, x: +p.x.toFixed(1), z: +p.z.toFixed(1) });
  return true;
}

/** ★ 出球公共尾段：把 kv 速度 + 自旋写到球上（tryKick / tryPoke / 第一脚击球共用）。
 *  spin 可为 null（无旋转球）；spot 存进 ball 供客户端解说/回放用。 */
function launchBall(kv, by, spin) {
  const b = G.ball;
  b.vx = kv.vx;
  b.vz = kv.vz;
  b.vy = kv.vy;
  b.wx = spin ? spin.wx : 0;
  b.wy = spin ? spin.wy : 0;
  b.owner = null;
  b.lastTouch = by.id;
  // 记下射门起点：门将判断"远射/近射"要用起点距离，
  // 不能用球当前位置（球飞到门前时离门总是很近，会让衰减失效 → 远射也被扑）
  b.kickFromX = b.x;
  b.kickFromZ = b.z;
  // 预判误差：每次出球只摇一次（门将整个飞行过程都用同一个偏移量）。
  //   ⚠️ 千万不能每帧 Math.random()，否则门将会追着一个乱跳的目标来回抖（动画反复切）
  b.aimJit = RND() * 2 - 1;
  by.dribbling = false;
  by.gkHold = false;
  by.kickCd = C.KICK_CD;
  by.aimYaw = Math.atan2(kv.vx, kv.vz);
}

function tryKick(p, dirIn, power, type, spot) {
  let dir = dirIn;
  if (p.dead || p.dying) return false;                        // 在球员席/倒地中不能出球
  if (G.restart && p.team !== G.restart.team) return false;   // 死球期间非发球方不能出球
  if (G.ball.owner !== p.id) return false;
  if (p.kickCd > 0) return false;
  if (p.mode === 'attack') return false;      // 攻击模式不能传球/射门，只能带球
  /* ★ 传球 3s 冷却（用户要求）：**只卡传球** —— 射门不受这个影响。
   *   传出去之后可以立刻补一脚射门，但不能马上再传。 */
  if (type !== 'shoot' && p.passCd > 0) return false;
  const len = Math.hypot(dir.x, dir.y ?? 0, dir.z);
  if (len < 0.001) return false;
  // 力度条：松手时的蓄力值决定出球速度
  //   传球 8 → 16 m/s；射门 14.4 → 32 m/s（约 115km/h，真实大力射门数据）
  const isShoot = type === 'shoot';
  const lo = (isShoot ? C.KICK_SHOOT : C.KICK_PASS) * (isShoot ? 0.45 : 0.5);
  const hi = isShoot ? C.KICK_SHOOT : C.KICK_PASS;
  let spd = lerp(lo, hi, clamp(power, 0, 1));

  /* ★ 击球点（右下角球 UI 的红点）：中心吃劲最足，偏点力量变小 + 加自旋 */
  const spin = spot ? spinFromSpot(spot.sx, spot.sy) : null;
  if (spin) spd *= spin.powerMul;
  const off = spin ? Math.min(1, Math.hypot(spot.sx || 0, spot.sy || 0)) : 0;

  /* 跑动加成：原地站定射门力量打折，助跑才有力道（真实足球逻辑）
   *  · 原地（速度 ≈ 0）→ ×0.72（力量条拉满也只有 72%）
   *  · 全速助跑（≥6.5m/s）→ ×1.0（当前数值）
   *  传球不受影响（传球本来就是原地也能做） */
  const runSpd = Math.hypot(p.vx, p.vz);
  if (isShoot) {
    const runK = clamp(runSpd / 6.5, 0, 1);
    spd *= 0.72 + 0.28 * runK;
  }

  /* 触球点偏移：面朝方向和球心不一致时，越偏力量越弱、方向越被带偏
   *  （用"球相对球员的正前偏角"衡量；正对球 = 满力） */
  const bx = G.ball.x - p.x, bz = G.ball.z - p.z;
  const bd = Math.hypot(bx, bz) || 1;
  const fdx = Math.sin(p.yaw), fdz = Math.cos(p.yaw);
  const align = (bx / bd) * fdx + (bz / bd) * fdz;            // 1 = 球正好在正前方
  if (align < 0.92) {
    const off = clamp((0.92 - align) / 1.92, 0, 1);           // 0=正对 1=完全侧向
    spd *= 1 - 0.42 * off;                                    // 最多掉 42% 力量
    // 方向被"撞偏"：出球方向朝球的偏移方向掰一点（脚背蹭到侧面）
    const px = -fdz, pz = fdx;                                // 球员右手边
    const sideDot = (bx / bd) * px + (bz / bd) * pz;
    const skew = 0.34 * off * sideDot;
    const dx2 = fdx * (1 - Math.abs(skew)) + px * skew;
    const dz2 = fdz * (1 - Math.abs(skew)) + pz * skew;
    const dl = Math.hypot(dx2, dz2) || 1;
    dir = { x: dx2 / dl, y: dir.y, z: dz2 / dl };
  }

  // 仰角由准星俯仰决定（共享 kickVelocity：预览线角度 = 实际出球角度）
  const kv = kickVelocity(dir, spd, off);
  launchBall(kv, p, spin);
  p.kickType = isShoot ? 'shoot' : 'pass';
  /* ★ 传球成功 → 进 3s 传球冷却（射门不进）。放在 launchBall 之后：只有真正出球才算数，
   *   前面任何一条 return false 都不会误扣冷却。 */
  if (!isShoot) p.passCd = C.PASS_CD;
  // 记录击球点（解说/回放/数据面板用）
  p.lastSpot = spin ? { sx: +(spot.sx || 0).toFixed(2), sy: +(spot.sy || 0).toFixed(2) } : null;
  p.kickSpd = Math.hypot(p.vx, p.vz);        // 记录踢球时的跑动速度 → 选动画
  p.kickAnim = isShoot ? C.ANIM.strikeJog : (p.kickSpd > 1.2 ? C.ANIM.pass : C.ANIM.passStill);
  p.animLock = p.kickAnim;
  oneShotBump(p);
  return true;
}

/** 滑铲 / 攻击模式扑抢（bot 与玩家共用）。
 *  初速按当前跑动速度取（高速放铲 = 按速度下地，距离随初速；站着铲也有个下限） */
function startSlide(p, dx, dz) {
  if (p.slideCd > 0 || p.slideT > 0 || p.y > 0.01) return false;
  if (p.mode === 'dance') return false;      // 跳舞模式不滑铲（安心跳）
  let x = dx || 0, z = dz || 0;
  const l = Math.hypot(x, z);
  if (l < 0.01) { x = Math.sin(p.yaw); z = Math.cos(p.yaw); }
  else { x /= l; z /= l; }
  p.slideDir = { x, z };
  p.slideSpd = clamp(Math.hypot(p.vx, p.vz), C.SLIDE_MIN, C.SLIDE_MAX);
  p.slideT = C.SLIDE_TIME;
  p.slideCd = C.SLIDE_CD;
  p.animLock = C.SLIDE_TIME;
  oneShotBump(p);
  p._tackled = null;                    // 本次滑铲还没撞过人
  p._ballHit = false;                   // 本次滑铲还没蹭过球
  return true;
}

/** 未持球时的"捅一脚"：攻击模式下捅得更狠（还能撞人）。
 *  ★ v2：支持击球点自旋 + 跑动加成（第一脚触球踢 = 跑步初速度进球速） */
function tryPoke(p, dir, power, type, spot) {
  const d = Math.hypot(p.x - G.ball.x, p.z - G.ball.z);
  if (d > C.POKE_DIST || p.kickCd > 0) return false;
  /* ★ 门将抱在怀里的球不能被捅走（与 tryGrab 同一判据）。
   *   球贴在门将身前，POKE_DIST=1.35m 完全够得着 —— 不挡的话"抢不到也能捅飞"。 */
  if (gkHoldingPlayer()) return false;
  const len = Math.hypot(dir.x, dir.z) || 1;
  const pw = Math.max(0.3, clamp(power, 0, 1));
  let spd = lerp(7, 16, pw) * (p.mode === 'attack' ? 1.25 : 1);
  /* ★ 击球点：偏心掉力量 + 自旋（与持球踢同一套 spinFromSpot） */
  const spin = spot ? spinFromSpot(spot.sx, spot.sy) : null;
  if (spin) spd *= spin.powerMul;
  const off = spin ? Math.min(1, Math.hypot(spot.sx || 0, spot.sy || 0)) : 0;
  const kv = kickVelocity({ x: dir.x, y: dir.y ?? 0, z: dir.z }, spd, off);
  launchBall(kv, p, spin);
  p.lastSpot = spin ? { sx: +(spot.sx || 0).toFixed(2), sy: +(spot.sy || 0).toFixed(2) } : null;
  p.kickType = type === 'shoot' ? 'shoot' : 'pass';
  p.kickSpd = Math.hypot(p.vx, p.vz);
  p.kickAnim = p.kickType === 'shoot' ? C.ANIM.strikeJog
    : (p.kickSpd > 1.2 ? C.ANIM.pass : C.ANIM.passStill);
  p.animLock = p.kickAnim;
  /* ★ 广播这次出球 —— 原来只有本机能听到自己的踢球声，**别人踢球是完全无声的**。
   *   客户端据此播踢球音效 + 对应解说（射门/传球/解围/传中）。 */
  io.emit('kickEv', {
    by: p.name, id: p.id, type: p.kickType, power: +clamp(power, 0, 1).toFixed(2),
    x: +p.x.toFixed(1), z: +p.z.toFixed(1),
    spd: +spd.toFixed(1),                                  // 出球初速（客户端用它区分"短传/长传/爆射"）
    vx: +kv.vx.toFixed(1), vz: +kv.vz.toFixed(1),
  });
  oneShotBump(p);
  return true;
}

/* ★ 击球点（右下角球 UI 红点）解析 —— 必须**同时认两套键名**：
 *   `{sx,sy}`（服务端 spinFromSpot 约定）与 `{x,y}`（早期客户端 get ballSpot 返回的）。
 *   ⚠️ 曾经只认 sx/sy，而客户端发的是 x/y → `spot=null` → **红点对球零作用**（用户实测
 *      "根本没有作用到球"）。这是真 bug，已双向兼容，任何一端先更新都不会再断。 */
function readSpot(raw) {
  if (!raw) return null;
  const sx = typeof raw.sx === 'number' ? raw.sx : (typeof raw.x === 'number' ? raw.x : null);
  const sy = typeof raw.sy === 'number' ? raw.sy : (typeof raw.y === 'number' ? raw.y : null);
  if (sx === null || sy === null) return null;
  return { sx: clamp(sx, -1, 1), sy: clamp(sy, -1, 1) };
}

/* ============================================================
 * ★★★ 第一脚击球（用户需求："球在前面定点，玩家跑过去提前蓄力，
 *      到球的位置释放可以跟正常控球踢一样，而且还能算上跑步的初速度"）
 *
 *  流程（客户端 UI 配合）：
 *    1. 球没被任何人控住（owner=null）时，玩家按住左/右键 → **提前蓄力**
 *       （上行 input 带 ct=chargeType / cp=charge 值），人继续照常跑；
 *    2. 每 tick 给"蓄力中的玩家"做**正前方脚下范围判定**：
 *       球在面前 FIRST_KICK_DIST 内、且相对面朝 ±FIRST_KICK_DEG 内；
 *    3. 判定命中 → 释放动作（strikeJog 踢球动画），按**当时方向**出球：
 *       · 方向 = 蓄力时客户端每帧上行的 dir（松手瞬间的瞄准方向）
 *       · 力度 = 蓄力条（与持球踢同一套 pass/shoot 公式）
 *       · **跑步初速度加成**：跑得越快球速越快（真实：助跑射门力量更大）
 *       · 击球点自旋照加（电梯球/香蕉球/后旋长传全适用）
 *    4. 出脚后进 KICK_CD，输入里的蓄力标记清掉。
 * ============================================================ */
const FIRST_KICK_DIST = 1.05;    // 正前方脚下判定距离（比 POKE_DIST 略近，要"到球的位置释放"）
const FIRST_KICK_DEG = 55;       // 正前方半角（°）—— 只要"脚下偏前"，侧后方不算
const FIRST_KICK_COS = Math.cos(FIRST_KICK_DEG * Math.PI / 180);

/** tick 里逐帧调：蓄力中的玩家 + 无主球 → 判定第一脚击球 */
function tryFirstStrike(p) {
  const inp = p.input;
  const ct = inp.ct;                       // 'pass' | 'shoot' | null（还在蓄力才有值）
  if (!ct || p.dead || p.dying || p.slideT > 0) return;
  if (p.mode !== 'soccer') return;         // 攻击/跳舞模式没有踢球
  if (p.animLock > 0.12 || p.kickAnim > 0) return;
  if (p.kickCd > 0) { inp.ct = null; return; }   // 冷却中直接清标记（蓄力白按）
  const b = G.ball;
  /* ★ 传球 3s 冷却同样约束"第一脚传球"：否则传完立刻冲到球前补一脚就绕过去了。
   *   射门（ct==='shoot'）不受影响。冷却中直接清掉蓄力标记，跟 kickCd 一样处理。 */
  if (ct !== 'shoot' && p.passCd > 0) { inp.ct = null; return; }
  if (b.owner) { inp.ct = null; return; }  // 球被别人控住了 → 蓄力作废
  if (G.restart) return;                   // 死球走发球流程，不走第一脚
  if (b.y > 0.6) return;                   // 半空中的球不判（以后可做凌空斩，先不做）

  const dx = b.x - p.x, dz = b.z - p.z;
  const d = Math.hypot(dx, dz);
  if (d > FIRST_KICK_DIST) return;
  if (d < 1e-4) return;
  const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
  if ((dx / d) * fx + (dz / d) * fz < FIRST_KICK_COS) return;   // 只认正前方脚下

  /* ---- 命中：释放！方向用客户端松手瞬间的瞄准方向（input.dir 由上行心跳带着） ---- */
  const dir = inp.kdir || { x: fx, y: 0, z: fz };
  const isShoot = ct === 'shoot';
  const power = clamp(inp.cp || 0.6, 0, 1);

  /* 力度与持球踢同一套公式；再叠**跑步初速度加成**：
   *   真实足球：助跑射门 = 腿速 + 身体动量。跑 8.5m/s 冲刺一脚 ≈ 加 12% 球速。
   *   注意 tryKick 里也有 0.72~1.0 的"站定打折"，这里反过来给"跑动奖励"，
   *   起点公平：原地第一脚 = 持球原地踢的力度。 */
  const lo = (isShoot ? C.KICK_SHOOT : C.KICK_PASS) * (isShoot ? 0.45 : 0.5);
  const hi = isShoot ? C.KICK_SHOOT : C.KICK_PASS;
  let spd = lerp(lo, hi, power);
  const runSpd = Math.hypot(p.vx, p.vz);
  if (isShoot) {
    const runK = clamp(runSpd / 6.5, 0, 1);
    spd *= 0.72 + 0.28 * runK;                       // 与持球踢同一条"助跑曲线"
  }
  /* 跑步初速度直接叠进球速（用户点名要"算上跑步的初速度"）：
   *   沿出球方向的跑速分量 × 0.35（真实射门约 30~40% 身体动量传递效率） */
  const runAlong = (p.vx * dir.x + p.vz * dir.z) / (Math.hypot(dir.x, dir.z) || 1);
  if (runAlong > 0) spd += runAlong * 0.35;

  /* 击球点自旋（提前调好的电梯球/香蕉球，第一脚照样带） */
  const spot = inp.cspot || null;
  const spin = spot ? spinFromSpot(spot.sx, spot.sy) : null;
  if (spin) spd *= spin.powerMul;
  const off = spin ? Math.min(1, Math.hypot(spot.sx || 0, spot.sy || 0)) : 0;

  const kv = kickVelocity(dir, spd, off);
  /* 出脚点：球就在脚下，直接从球的位置起飞 */
  b.x = p.x + (dx / d) * Math.min(d, 0.42);          // 最多挪到脚前 0.42m，防"球在身后出球"
  b.z = p.z + (dz / d) * Math.min(d, 0.42);
  launchBall(kv, p, spin);
  p.lastSpot = spin ? { sx: +(spot.sx || 0).toFixed(2), sy: +(spot.sy || 0).toFixed(2) } : null;
  p.kickType = isShoot ? 'shoot' : 'pass';
  p.kickSpd = runSpd;
  p.kickAnim = isShoot ? C.ANIM.strikeJog : (runSpd > 1.2 ? C.ANIM.pass : C.ANIM.passStill);
  p.animLock = p.kickAnim;
  if (!isShoot) p.passCd = C.PASS_CD;               // ★ 第一脚传球也进 3s 冷却（射门不进）
  oneShotBump(p);
  inp.ct = null;                                     // 蓄力标记清掉（KICK_CD 由 launchBall 设）
  /* 广播给全服（音效 + 解说；第一脚也给同样的事件流） */
  io.emit('kickEv', {
    by: p.name, id: p.id, type: p.kickType, power: +power.toFixed(2),
    x: +p.x.toFixed(1), z: +p.z.toFixed(1),
    spd: +spd.toFixed(1), vx: +kv.vx.toFixed(1), vz: +kv.vz.toFixed(1),
    first: 1,                                        // 客户端可标识"第一脚触球"
  });
}

/** 攻击模式出拳：左键 = 左勾拳(punchL)，右键 = 右直拳(punchR)。
 *  命中判定：身前 PUNCH_RANGE 内、±70° 扇形内的对手 → 击退 + 掉血 + 硬直 + 打掉持球；
 *  血量清零 → KO 铲倒（tackleDown，clip 内含起身）；没打到人但贴着球 → 顺手捅一脚；
 *  都没有 → 空抡（动画照放）。 */
function tryPunch(p, hand) {
  if (p.dead || p.dying) return false;
  if (p.punchCd > 0 || p.slideT > 0 || p.animLock > 0.12) return false;
  if (p.downT > 0 || p.upT > 0) return false;
  const isLeft = hand !== 'R';
  p.punchCd = C.PUNCH_CD;
  p.kickType = isLeft ? 'punchL' : 'punchR';
  p.kickAnim = C.ANIM_PUNCH[isLeft ? 'punchL' : 'punchR'];
  p.animLock = p.kickAnim;
  oneShotBump(p);

  const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);

  let hit = null;
  for (const q of G.players.values()) {
    if (q.id === p.id) continue;                             // 自己不打
    if (q.team === p.team && !q.bot) continue;               // 只打对手（固定人机靶子例外，谁都能打）
    if (q.downT > 0 || q.upT > 0) continue;                    // 倒地的不补刀
    const dx = q.x - p.x, dz = q.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > C.PUNCH_RANGE || d < 0.001) continue;
    if ((dx / d) * fx + (dz / d) * fz < C.PUNCH_ARC) continue; // 扇形外
    if (!hit || d < Math.hypot(hit.x - p.x, hit.z - p.z)) hit = q;
  }
  if (hit) {
    const dx = hit.x - p.x, dz = hit.z - p.z;
    const l = Math.hypot(dx, dz) || 1;
    hit.vx = dx / l * C.PUNCH_POWER;
    hit.vz = dz / l * C.PUNCH_POWER;
    hit.stealCd = Math.max(hit.stealCd, C.PUNCH_STUN);        // 硬直：不能出拳/吸球
    hit.grabCd = Math.max(hit.grabCd, C.PUNCH_STUN);
    /* ★ 门将抱在怀里的球打不掉（同 tryGrab 判据）。
     *   掉血/击退照常吃，只是球不脱手 —— 否则一拳就能把门将抱球打飞，
     *   又变回"抱球的门将球被抢走"。 */
    if (G.ball.owner === hit.id && !hit.gkHold) {            // 一拳打掉持球
      G.ball.owner = null;
      hit.dribbling = false;
      G.ball.vx = dx / l * 3; G.ball.vz = dz / l * 3; G.ball.vy = 1.5;
    }
    hurt(hit, p, C.PUNCH_DMG, isLeft ? 'face' : 'body');  // 左勾拳打脸 / 右直拳打身体
    return 'hit';
  }
  // 没打到人：贴着球就顺手捅一脚
  const bd = Math.hypot(p.x - G.ball.x, p.z - G.ball.z);
  if (bd <= C.POKE_DIST && G.ball.owner !== p.id) {
    tryPoke(p, { x: fx, y: 0, z: fz }, 0.6, 'pass');
    return 'poke';
  }
  return 'whiff';
}

/**
 * 攻击模式技能（卡牌，无限使用但有冷却）：
 *   飞踢 flyKick   短 CD  → 起跳飞踢，可反复使用
 *   螺旋踢 hurricane 长 CD → 范围更大、伤害更高、击退更远
 *  命中判定与出拳同一套（身前 range 内、arc 扇形内的对手 → 击退 + 掉血 + 硬直 + 打掉持球）
 */
function trySkill(p, key) {
  const S = C.SKILL[key];
  if (!S) return 'bad';
  /* 技能卡分模式：攻击卡（飞踢/螺旋踢）只在攻击模式；花式卡（马赛回旋）只在踢球模式。 */
  if (p.mode !== (S.mode || 'attack')) return 'mode';
  if (p.downT > 0 || p.upT > 0) return 'down';
  if (p.slideT > 0) return 'slide';
  if (p.skillCd && p.skillCd[key] > 0) return 'cd';
  if (p.animLock > 0.12 || p.kickAnim > 0) return 'busy';
  /* ★ 需要持球的花式动作（马赛回旋）：
   *   用户要求"没有持球状态不能做这个动作"。判定放在**扣 CD / 上锁之前** ——
   *   否则空脚一按就把 CD 吃掉、动作也锁住，等于白按一次。
   *   判定用「球确实在自己脚下」（owner + dribbling），光 owner 不够：
   *   球被别人抢走但 owner 还没清的那一帧会误判成可以转。 */
  if (S.needBall && !(G.ball.owner === p.id && p.dribbling && !p.gkHold)) return 'noball';
  p.skillCd = p.skillCd || {};
  p.skillCd[key] = S.cd;                       // 进入冷却（客户端读它画倒计时）
  p.kickType = S.anim;
  p.kickAnim = S.time;
  p.animLock = S.time;
  p.skillFreeze = S.slow;                      // 出招期间限速（不可边冲边放）
  /* ★ 起手序号 +1：客户端靠它判断"这是新的一次起手"→ 允许 reset 重播。
   *   没有这一步，同一张卡连按两次时第二次会被当成"同一次动作还在播"而不重播。 */
  oneShotBump(p);

  const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);

  /* ★ 花式动作（马赛回旋）：没有伤害判定，**球留在脚下被"带着走"**。
   *   用户明确要求"要带着球跑" —— 所以这里**绝不能**把球拨出去/清球权：
   *   球的位置由主循环的 ball 分支按 `spin-ball.json` 绕人一圈（见下面 `o.anim === 'spin'`）。
   *   之前是 `G.ball.owner = null` + 给球 4.2m/s 初速，等于"转个身把球踢飞"，完全不是马赛回旋。 */
  if (S.kind === 'flair') {
    io.emit('flair', { by: p.name, id: p.id, kind: key });
    return 'flair';
  }

  let hit = null;
  for (const q of G.players.values()) {
    if (q.id === p.id) continue;
    if (q.team === p.team && !q.bot) continue;
    if (q.downT > 0 || q.upT > 0) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > S.range || d < 0.001) continue;
    if ((dx / d) * fx + (dz / d) * fz < S.arc) continue;      // 扇形外
    if (!hit || d < Math.hypot(hit.x - p.x, hit.z - p.z)) hit = q;
  }
  if (hit) {
    const dx = hit.x - p.x, dz = hit.z - p.z;
    const l = Math.hypot(dx, dz) || 1;
    hit.vx = dx / l * S.power;
    hit.vz = dz / l * S.power;
    hit.stealCd = Math.max(hit.stealCd, S.stun);
    hit.grabCd = Math.max(hit.grabCd, S.stun);
    /* ★ 门将抱在怀里的球打不掉（同 tryGrab 判据）—— 技能击退/掉血照常，球不脱手。 */
    if (G.ball.owner === hit.id && !hit.gkHold) {            // 打掉持球
      G.ball.owner = null;
      hit.dribbling = false;
      G.ball.vx = dx / l * 3; G.ball.vz = dz / l * 3; G.ball.vy = 1.5;
    }
    hurt(hit, p, S.dmg, S.kind);
    return 'hit';
  }
  // 没打到人：贴着球就顺脚捅出去
  const bd = Math.hypot(p.x - G.ball.x, p.z - G.ball.z);
  if (bd <= C.POKE_DIST && G.ball.owner !== p.id) {
    tryPoke(p, { x: fx, y: 0.12, z: fz }, 0.8, 'shoot');
    return 'poke';
  }
  return 'whiff';
}

/** 掉血 + 硬直刷新；血量清零 → KO 铲倒
 *  kind: 'face' = 被拳头打脸（Receive Uppercut）· 'body' = 被踢中身体（Hit To Body） */
function hurt(v, by, dmg, kind) {
  v.hp = Math.max(0, v.hp - dmg);
  v.hurtT = 0;
  if (kind && v.downT <= 0 && v.upT <= 0) {
    v.hurtAnim = kind === 'body' ? 'hurtBody' : 'hurtFace';
    v.hurtAnimT = C.ANIM_HURT[v.hurtAnim];
  }
  if (v.hp <= 0 && v.downT <= 0 && v.upT <= 0) knockDown(v, by, true);
}


/** 被铲倒 / KO：播放 tackleDown（该 clip 自身已含起身，不另接 getUp），
 *  期间完全定住，掉球。普通铲倒扣 TACKLE_DMG；血量被铲清零 → 升级 KO（倒地更久）。 */
function knockDown(v, by, ko) {
  if (!ko) {
    v.hp = Math.max(0, v.hp - C.TACKLE_DMG);
    v.hurtT = 0;
    if (v.hp <= 0) ko = true;                 // 这一铲直接把血铲清零 → KO
  }
  if (ko && !v.dead && !v.dying) {
    // 血清零 → 先播"死亡倒地"动作，播完（见 tick）再被抬进球员席
    v.dying = true;
    v.dyingT = C.DEATH_TIME;
    v.downT = Math.max(v.downT, C.DEATH_TIME + 0.1);
  }
  v.downT = (ko ? C.KO_DOWN_MUL : 1) * C.DOWN_TIME;
  v.upT = 0;
  v.vx = v.vz = v.vy = 0;
  v.punchCd = Math.max(v.punchCd, v.downT);   // 倒地期间不能出拳
  v.grabCd = Math.max(v.grabCd, v.downT);
  v.stealCd = Math.max(v.stealCd, v.downT);
  /* ★ 门将抱球时被铲倒也不掉球（用户要求"抱球的门将不能被抢夺"）。
   *   滑铲**物理碰撞**那条分支本来就有 !gkHold 守卫，但这条**倒地掉球**分支
   *   一直漏了 —— 同一件事两条路径，所以表现时好时坏。门将照常被铲倒掉血，
   *   只是球留在怀里（gkHold 的不变量循环也会因为"球还在手上"而保留姿势）。 */
  if (G.ball.owner === v.id && !v.gkHold) {                  // 倒地掉球，往远离对手的方向滚
    G.ball.owner = null;
    v.dribbling = false;
    const ax = by ? v.x - by.x : 0, az = by ? v.z - by.z : 1;
    const l = Math.hypot(ax, az) || 1;
    G.ball.vx = ax / l * 4; G.ball.vz = az / l * 4; G.ball.vy = 1.2;
  }
  io.emit('tackle', { by: by ? by.name : '', victim: v.name, ko: !!ko });
}

/* ============================================================
 *  主循环（目标 30Hz，按真实经过时间步进 —— 掉帧时模拟时间不缩水）
 * ============================================================ */
const DT = 1 / C.TICK_HZ;
let _lastTickAt = Date.now();

function tick() {
  const now = Date.now();
  let dt = (now - _lastTickAt) / 1000;
  _lastTickAt = now;
  if (!(dt > 0)) dt = DT;        // 时钟异常 → 用名义步长
  if (dt > 0.1) dt = 0.1;        // 卡顿保护：单步最大 100ms，防穿墙
  const players = [...G.players.values()];

  /* --- 冷却 --- */
  for (const p of players) {
    p.kickCd = Math.max(0, p.kickCd - dt);
    p.grabCd = Math.max(0, p.grabCd - dt);
    p.slideCd = Math.max(0, p.slideCd - dt);
    p.stealCd = Math.max(0, p.stealCd - dt);
    p.punchCd = Math.max(0, p.punchCd - dt);
    p.passCd = Math.max(0, (p.passCd || 0) - dt);         // ★ 传球 3s 冷却
    p.gkActCd = Math.max(0, (p.gkActCd || 0) - dt);
    p.gkAnimT = Math.max(0, (p.gkAnimT || 0) - dt);
    /* ★ 动作播完就**注销动作名**：pickAnim 的"门将动作"分支是按 kickAnim>0 判的，
     *   但 gkAnimName 会一直留着 → 万一有哪一帧 kickAnim 被别的逻辑重设，
     *   客户端就会"定格在扑救最后一帧还能跑动"（用户反馈的"定着这个姿势移动"）。
     *   这里在播完的那一帧统一清掉，pickAnim 立刻回落 gkIdle / idle。 */
    if (p.gkAnimT === 0 && p.gkAnimName && !(p.kickAnim > 0) && !p.gkRelease) {
      p.gkAnimName = null;
      p.gkScoopMode = null;
      if (p.gkSaveT <= 0) p.gkSaveT = 0;
    }
    p.headCd = Math.max(0, (p.headCd || 0) - dt);
    p.headAnimT = Math.max(0, (p.headAnimT || 0) - dt);
    p.gkManualT = (p.gkManualT || 0) + dt;
    // 门将出球：动作播到发力点才真正把球放出去（修"球先走人后动"）
    if (p.gkRelease) {
      p.gkRelease.t -= dt;
      if (p.gkRelease.t <= 0) {
        const R = p.gkRelease;
        p.gkRelease = null;
        /* ★ 抱球姿势的结束必须**无条件**执行。
         *   原来 `p.gkHold = false` 被关在 `if (G.ball.owner === p.id)` 里面：
         *   出球动作期间球权若被别人抢走 / 被进球复位清掉，这个分支就永远进不来，
         *   gkRelease 到点了也没清 gkHold → 门将**卡在抱球姿势**里
         *   （用户反馈"出球后这个姿势应该结束"就是它）。
         *   现在先无条件结束姿势与持球计时，只有"球还在自己手上"时才真正把球踢出去。 */
        const hadBall = p.gkHold && G.ball.owner === p.id;
        p.gkHold = false;
        p.holdT = 0;
        if (p.dribbling && G.ball.owner !== p.id) p.dribbling = false;
        if (hadBall) {
          p.dribbling = false;
          // 直接赋初速（不走 tryKick 的冷却/模式限制：这是死球式发球，不是常规传射）
          const bb = G.ball;
          const base = (R.type === 'pass' ? C.KICK_PASS : C.KICK_SHOOT) * R.power;
          const kv = SH.kickVelocity({ x: R.dirX, y: R.vy, z: R.dirZ }, base);
          // 出手点：从门将身前一点出脚，别让球从头顶瞬移
          bb.x = p.x + R.dirX * 0.5;
          bb.z = p.z + R.dirZ * 0.5;
          bb.y = R.type === 'pass' ? C.BALL_R : 0.5;
          bb.vx = kv.vx; bb.vz = kv.vz; bb.vy = kv.vy;
          bb.owner = null;
          bb.lastTouch = p.id;
          bb.kickFromX = bb.x; bb.kickFromZ = bb.z;   // 门将出球也算一次"出球起点"
          p.kickCd = C.KICK_CD;
          p.aimYaw = Math.atan2(kv.vx, kv.vz);
          io.emit('gkDist', { by: p.name, kind: p.kickType });
        }
      }
    }
    if (p.skillCd) for (const k in p.skillCd) p.skillCd[k] = Math.max(0, p.skillCd[k] - dt);
    /* ★ 一次性动作"起手序号"（oneShotSeq）—— 根治"同一个动作做两次"的关键。
     *
     * 问题：客户端靠 `action.time >= clip.duration` 判断"上一遍播完了没有"。
     *   但动画播完的时刻和锁定到期的时刻**不是同一帧** —— 动画先播完（clamp 在最后一帧），
     *   锁定还差 1~2 帧才到期。这 1~2 帧里客户端会误判成"新一次起手"→ reset → **重播**。
     *   这就是用户看到的"守门员动作做两次"（门将动画播得比锁定略快，必然出现）。
     *
     * 解法：服务端每次**真正发起**一次性动作时调 `oneShotBump(p)` 把序号 +1 并下发；
     *   客户端只在"序号变化"时才 reset 重播，同一次动作期间（序号不变）绝不重播。
     *   ★ 用**显式打点**而不是"观察 animLock 跳高"——后者不可靠：上一个动作的锁定
     *     还在衰减时，新动作的锁定值可能比它小（gkKick 3.92 → gkBlockL 1.32），
     *     锁定值是在**变小**的，猜测式检测会漏掉这次起手。 */
    p.animLock = Math.max(0, p.animLock - dt);
    p.kickAnim = Math.max(0, p.kickAnim - dt);
    // 被铲倒：倒地时长 = tackleDown clip（2.73s ÷ 1.1 倍速 ≈ 2.48s，clip 内自带起身），
    // 播完直接回满血站起来，不另接 getUp（否则起身动作重复）
    if (p.downT > 0) {
      p.downT -= dt;
      if (p.downT <= 0) { p.downT = 0; p.hp = C.HP_MAX; }
    } else if (p.upT > 0) {
      p.upT -= dt;
    }
    // 掉血后 4 秒没再挨打 → 缓慢回血
    if (p.hurtAnimT > 0) p.hurtAnimT -= dt;
    if (p.boostT > 0) p.boostT -= dt;
    p.hurtT += dt;
    if (p.hurtT > C.HP_REGEN_DELAY && p.hp < C.HP_MAX && p.downT <= 0 && p.upT <= 0) {
      p.hp = Math.min(C.HP_MAX, p.hp + C.HP_REGEN * dt);
    }
  }

  /* --- 死亡倒地 → 抬进球员席 --- */
  for (const p of players) {
    if (!p.dying) continue;
    p.dyingT -= dt;
    if (p.dyingT <= 0) { p.dying = false; sendToBench(p); }
  }
  /* --- 球员席：救护车流程走完后重生 --- */
  ambulanceTick(dt);

  /* --- 阶段：进球停顿 --- */
  if (G.phase === 'goal') {
    G.phaseT -= dt;
    if (G.phaseT <= 0) {
      G.phase = 'play';
      resetPositions();
      resetBall(G.lastGoalBy ? (G.lastGoalBy === 'A' ? 'B' : 'A') : null);
      io.emit('matchResume', { round: G.round });
    }
  } else {
    G.clock = Math.max(0, G.clock - dt);
    if (G.clock <= 0) {
      const winner = G.scores.A === G.scores.B ? null : (G.scores.A > G.scores.B ? 'A' : 'B');
      io.emit('matchEnd', { winner, scores: G.scores, round: G.round });
      settleBets(winner);                                  // 先结算押注（用本局最终投注比例算赔率）
      G.round++;
      G.scores.A = 0; G.scores.B = 0;
      G.clock = C.MATCH_SEC;
      resetPositions(); resetBall(null);
      io.emit('matchReset', { round: G.round, reset: true });
    }
  }

  /* --- 守门员：离开禁区太久自动交出身份；锁定时自动面向球 --- */
  for (const p of players) {
    if (!isKeeper(p)) { p.isGK = false; p.aimLock = false; continue; }
    p.isGK = true;
    if (p.aimLock && !inOwnBox(p) && !p.botGK) p.aimLock = false;   // 出禁区自动解除锁定（AI 门将豁免）
    // 锁定中：记下移动前的朝向与"指向球"的目标，移动后统一覆盖（否则转向模型会把朝向写回去）
    if (p.isGK && p.aimLock && inOwnBox(p)) {
      p._lockYaw0 = p.yaw;
      p._lockWant = Math.atan2(G.ball.x - p.x, G.ball.z - p.z);
    } else { p._lockYaw0 = null; }
    if (inOwnBox(p)) { p.gkOutT = 0; }
    else {
      p.gkOutT += dt;
      if (p.gkOutT > C.GK_OUT_TIME) {
        const team = p.team;
        G.keeper[team] = null;
        p.isGK = false; p.gkHold = false;
        io.emit('keeperRelease', { team, by: p.name });
        ensureKeeper(team);
      }
    }
  }

  /* --- 门将抱球：真人 + AI 都要走"2 秒后出球"（否则真人门将抱球后比赛卡住） --- */
  for (const p of players) {
    if (p.botGK) continue;                          // AI 门将在 updateKeeperAI 里已处理
    if (p.gkHold && isKeeper(p)) updateKeeperHeldBall(p, dt);
  }

  /* --- AI 守门员：先决定站位/扑救（写 input） --- */
  for (const p of players) if (p.botGK) updateKeeperAI(p, dt);

  /* --- 射门机器人：自己带球到随机位置、朝球门随机点射门（测试用） --- */
  for (const p of players) if (p.botShooter) updateShooterBot(p, dt);

  /* --- 靠近本方球门时提示「按 F 当守门员」 --- */
  for (const p of players) {
    if (p.bot) continue;
    p.claimHint = canClaimKeeper(p);
  }

  /* --- AI 门将自愈：哪个队没人守门就补一个（每 ~2 秒检查） --- */
  G._gkTick = (G._gkTick || 0) + 1;
  if (G._gkTick % 60 === 0) { ensureKeeper('A'); ensureKeeper('B'); }

  /* --- 玩家移动 --- */
  for (const p of players) {
    // 刚被救护车送回：自动跑回自己半场（玩家一给输入就接管）
    if (p.reviveWalk) autoWalkBack(p);
    // 球员席上的球员：定住在座位上，不接受任何输入（等救护车送回）
    if (p.dead) {
      p.input.mx = 0; p.input.mz = 0; p.input.grab = false;
      p.vx = 0; p.vz = 0; p.vy = 0; p.y = 0;
      p.slideT = 0; p.kickAnim = 0;
      continue;
    }
    const inp = p.input;
    let mx = inp.mx, mz = inp.mz;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }

    /* F 带球：按住持续尝试吸附（贴着球就吸上，有 CD）。
       刚踢出球的 KICK_CD 内禁止吸附 —— 否则慢速传球下一秒就被吸回脚边，
       表现就是"传/射不出去"，球速也会被清零。 */
    if (inp.grab && G.ball.owner !== p.id && p.kickCd <= 0 && !(G.restart && G.restart.team !== p.team)) {
      // 死球：走到球边按 F → 进入发球准备（之后左/右键蓄力出球）
      const R = G.restart;
      if (R && !R.taken && p.team === R.team && Math.hypot(p.x - R.x, p.z - R.z) < 2.2) {
        if (!p.restartReady) {
          p.restartReady = true;
          R.byId = p.id;
          io.emit('restartReady', { by: p.name, team: p.team, label: RESTART_NAME[R.type] });
        }
      } else if (!tryClaimKeeper(p)) tryGrab(p);
    }

    if (p.throwPending) {                       // 手抛球：动画起手后出球
      p.throwPending.t -= dt;
      if (p.throwPending.t <= 0) {
        const b2 = G.ball;
        // 出手点必须挪进场内：球钉在边线（z = ±HALF_W）上，若不挪进来，
        // 出手后第一帧就落在界外 → 会立刻被判出界（"发球瞬间判定出界"的 bug）
        const outSign = Math.sign(b2.z) || 1;
        b2.x = p.x + Math.sin(p.yaw) * 0.4;
        b2.z = p.z + Math.cos(p.yaw) * 0.4;
        b2.y = 1.75;                            // 从头顶出手
        // 强制拉回场内（留 0.6m 余量），避免重启出界判定
        const mx = C.FIELD.HALF_L - 0.6, mz = C.FIELD.HALF_W - 0.6;
        b2.x = clamp(b2.x, -mx, mx);
        b2.z = clamp(b2.z, -mz, mz);
        b2.vx = p.throwPending.vx; b2.vz = p.throwPending.vz; b2.vy = p.throwPending.vy;
        b2.owner = null;
        p.throwPending = null;
        finishRestart(p);
      }
    }
    if (p.botGK && p.aiMove) {                 // AI 门将：直接位移（不受转向加速拖累）
      p.vx = p.aiMove.x * p.aiMove.spd;
      p.vz = p.aiMove.z * p.aiMove.spd;
      if (p.aiMove.x || p.aiMove.z) p.yaw = p.aimYaw = Math.atan2(p.aiMove.x, p.aiMove.z);
      p.aiMove = null;
      p.gkMoveT = 0;
    } else if (p.gkMoveT > 0) {
      /* 守门员扑救位移中：按动作的横向根位移走（贴地扑挡小、飞扑大） */
      p.vx = p.gkSaveVX; p.vz = p.gkSaveVZ;
      p.gkMoveT -= dt;
    } else if (p.downT > 0 || p.upT > 0) {
      /* 被铲倒 / 起身：完全定住，什么都不能做 */
      p.vx = 0; p.vz = 0;
    } else if (p.slideT > 0) {
      /* 滑铲：保持方向、速度衰减（初速 = 放铲时的跑动速度，距离随初速） */
      p.slideT -= dt;
      const ssp = p.slideSpd || C.SLIDE_MIN;
      const k = Math.exp(-2.6 * dt);
      p.vx = p.slideDir.x * ssp * k * clamp(p.slideT / C.SLIDE_TIME, 0.25, 1);
      p.vz = p.slideDir.z * ssp * k * clamp(p.slideT / C.SLIDE_TIME, 0.25, 1);
      /* 滑铲途中蹭到球 → 直接顶走（每脚只顶一次） */
      if (!p._ballHit && !G.ball.owner && G.ball.y < 1.2 && p.slideT > 0.1) {
        const bdx = G.ball.x - p.x, bdz = G.ball.z - p.z;
        if (Math.hypot(bdx, bdz) < 0.75) {
          p._ballHit = true;
          const bs = ssp * 1.05;
          G.ball.vx = p.slideDir.x * bs; G.ball.vz = p.slideDir.z * bs; G.ball.vy = 1.0;
          G.ball.lastTouch = p.id;
        }
      }
    } else {
      if (ml > 0.01) {
        /* ---- 移动：实况/FIFA 手感（车速式转向）----
         * 1) 速度的"方向"以受限角速度转向输入方向：低速 ≈ 原地转身跟手，
         *    高速兜大弧线；面朝永远 = 速度方向 → 不侧滑、不会"转身像傻逼"
         * 2) 速度大小按真实加速曲线逼近档位上限（越跑越快）
         * 3) 大角度变向掉一点速（TURN_CUT），像真人切方向时"撑一步"再弹出去 */
        const sp = Math.hypot(p.vx, p.vz);
        const wantYaw = Math.atan2(mx, mz);
        const vYaw = sp > 0.02 ? Math.atan2(p.vx, p.vz) : wantYaw;   // 静止 → 直接朝输入方向
        const cut = Math.abs(angDelta(vYaw, wantYaw));               // 本帧要切过的角度

        // 档位上限 = 对应动画的真实位移速率（见 shared.js 注释）
        let maxSpd = inp.walk ? C.SPD.WALK : (inp.sprint ? C.SPD.RUN4 : C.SPD.RUN3);
    if (p.boostT > 0) maxSpd *= C.CARD_BOOST_MUL;                 // 属性卡：最高速 +10%
        maxSpd *= p.dribbling ? C.DRIBBLE_SPEED_MUL : 1;
        // 出拳期间只能慢步（打拳不能快速移动）
        if (p.kickAnim > 0 && (p.kickType === 'punchL' || p.kickType === 'punchR')) {
          maxSpd = Math.min(maxSpd, C.PUNCH_SLOW);
        }
        /* ★ 传球动作期间减速（用户要求"跑步中传球，传球动作时要减速"）：
         *   传球/静止传球的动画在播时，把速度上限压成档位的 PASS_SLOW_MUL（32%）。
         *   判据用 kickAnim>0 而不是另设计时器 —— kickAnim 的生命周期与动画严格一致
         *   （launchBall 前的 p.kickAnim = C.ANIM.pass / passStill，见 tryKick / tryFirstStrike），
         *   所以"动作播完就恢复全速"是自动成立的，不会出现残留减速。
         *   · 冲刺出球 8.5 → ≈2.7m/s（大步跨出去那一下，像真人）
         *   · 走路出球 1.72 → 被 PASS_SLOW_MIN(1.4) 托住，几乎无感
         *   · 原地出球：本来就没速度可减，手感不变
         *   注意：射门（strikeJog）**不减速** —— 用户只点名了传球。 */
        if (p.kickAnim > 0 && p.kickType === 'pass') {
          maxSpd = Math.min(maxSpd, Math.max(C.PASS_SLOW_MIN, maxSpd * C.PASS_SLOW_MUL));
        }
        // 攻击技能出招期间也压速度（飞踢/螺旋踢不可边全速冲刺边放）
        if (p.skillFreeze && p.animLock > 0) maxSpd = Math.min(maxSpd, p.skillFreeze * maxSpd + 0.9 * (1 - p.skillFreeze));
        if (cut > C.TURN_CUT_ANGLE) {
          const k = clamp((cut - C.TURN_CUT_ANGLE) / (Math.PI * 0.5 - C.TURN_CUT_ANGLE), 0, 1);
          maxSpd *= 1 - (1 - C.TURN_CUT) * k;
        }

        // 转向：角速度受速度限制（高速不许瞬间掉头，低速几乎原地转）
        const steerMax = Math.max(C.STEER_MIN, C.STEER_MAX - sp * C.STEER_K);
        const nYaw = angApproach(vYaw, wantYaw, steerMax * dt);

        // 速度大小：加速走渐进曲线；超速（急转掉速 / 降档）快速收敛
        const a = sp < maxSpd
          ? Math.max(1.5, C.ACCEL0 * Math.max(0.18, 1 - sp / maxSpd))
          : Math.max(C.DECEL_CUT, C.ACCEL0 * 0.18);
        const nsp = sp + clamp(maxSpd - sp, -a * dt, a * dt);

        p.vx = Math.sin(nYaw) * nsp;
        p.vz = Math.cos(nYaw) * nsp;
        p.yaw = nYaw;
      } else {
        /* 松手：线性减速；还在滑行就继续朝跑的方向看（FIFA 手感），
           快停下再慢慢转向相机方向（站着时身体对准星，瞄哪打哪） */
        const sp = Math.hypot(p.vx, p.vz);
        const ns = Math.max(0, sp - C.DECEL * dt);
        if (sp > 0.001) { p.vx = p.vx / sp * ns; p.vz = p.vz / sp * ns; }
        else { p.vx = 0; p.vz = 0; }
        p.yaw = sp > 0.6
          ? Math.atan2(p.vx, p.vz)
          : angApproach(p.yaw, inp.yaw, C.TURN_RATE * dt);
      }
      // 跳跃
      if (inp.jump && p.y <= 0.001 && p.vy === 0) { p.vy = C.JUMP_VEL; }
    }

    p.x += p.vx * dt;
    p.z += p.vz * dt;
    p.vy -= C.GRAVITY * dt;
    p.y += p.vy * dt;
    if (p.y < 0) { p.y = 0; p.vy = 0; }

    // 场地边界
    const bx = C.FIELD.HALF_L + 3, bz = C.FIELD.HALF_W + 3;
    p.x = clamp(p.x, -bx, bx);
    p.z = clamp(p.z, -bz, bz);
  }

  /* --- 玩家互相碰撞 + 滑铲铲倒判定 --- */
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      const min = C.PLAYER_R * 2;

      /* 滑铲撞人：有几率把对手铲倒 —— 重合度越高（重心贴得越死）概率越大：
       *   d→0（完全重合）≈ 85%，刚擦到 ≈ 30%。判定半径比物理碰撞外扩一点，
       *   高速滑铲单帧跨距大，不会擦边而过。一次滑铲对同一对手只判定一次。 */
      const slider = a.slideT > 0 ? a : (b.slideT > 0 ? b : null);
      if (slider) {
        const victim = slider === a ? b : a;
        const isEnemy = victim.team !== slider.team || !!victim.bot;   // 固定人机谁都能铲
        if (isEnemy && slider._tackled !== victim.id
            && victim.downT <= 0 && victim.upT <= 0 && d < min + C.TACKLE_EXTRA) {
          slider._tackled = victim.id;
          const overlap = clamp(1 - d / (min + C.TACKLE_EXTRA), 0, 1);   // 0=刚擦到 1=完全重合
          const chance = C.TACKLE_DOWN_BASE + (C.TACKLE_DOWN_FULL - C.TACKLE_DOWN_BASE) * overlap;
          if (Math.random() < chance) { hurt(victim, slider, 0, 'body'); knockDown(victim, slider, false); }
        }
      }

      if (d > 0.0001 && d < min) {
        const nx = dx / d, nz = dz / d;
        // 人机不动：真人承担全部推出量；两个真人各推一半
        if (a.bot && !b.bot) { b.x += nx * (min - d); b.z += nz * (min - d); }
        else if (b.bot && !a.bot) { a.x -= nx * (min - d); a.z -= nz * (min - d); }
        else if (!a.bot && !b.bot) {
          const push = (min - d) / 2;
          a.x -= nx * push; a.z -= nz * push;
          b.x += nx * push; b.z += nz * push;
        }
        // 滑铲撞人：把对方撞开并可能撞掉球
        // （门将双手抱球时铲不掉 —— 否则球掉了又要重捡，表现就是"捡球动作做两次"）
        if (a.slideT > 0 && G.ball.owner === b.id && !b.gkHold) {
          b.vx += nx * 6; b.vz += nz * 6; b.dribbling = false; G.ball.owner = null;
        }
        if (b.slideT > 0 && G.ball.owner === a.id && !a.gkHold) {
          a.vx -= nx * 6; a.vz -= nz * 6; a.dribbling = false; G.ball.owner = null;
        }
      }
    }
  }

  /** 固定人机钉回原地（可被打倒，但不被推走）；AI 守门员 / 射门机器人要能移动，不受此限 */
  for (const p of players) {
    if (!p.bot || p.botGK || p.botShooter) continue;
    p.x = p.bx; p.z = p.bz;
    p.vx = 0; p.vz = 0;
  }

  /* --- 锁定防守的门将：朝向强制对准球（必须放在移动之后，否则会被转向模型覆盖） --- */
  for (const p of players) {
    if (p._lockYaw0 !== null && p._lockYaw0 !== undefined) {
      p.yaw = angApproach(p._lockYaw0, p._lockWant, 14 * dt);
      p.aimYaw = p.yaw;
      p._lockYaw0 = null;
    }
  }

  /* --- 门将自动接球：正对来球进入 1.25m 就起手（低球捞起 / 半高腹部 / 高球跳起）
   *     正对身体的球 → 用接球动作，不飞扑（详见 updateKeeperAI 的扑救判据） --- */
  for (const p of players) {
    if (!p.isGK || p.downT > 0 || p.upT > 0 || p.gkHold) continue;
    if (p.kickAnim > 0 || p.animLock > 0.05 || p.gkSaveT > 0) continue;   // 已经在做扑救动作
    if (p.gkActCd > 0) continue;                              // 刚做完扑救/接球动作 → 别紧接着再来一次（修"动作做两次"）
    if (!inOwnBox(p)) continue;
    const bb = G.ball;
    if (bb.owner === p.id) continue;
    const dx = p.x - bb.x, dz = p.z - bb.z;                   // 球 → 门将方向（接近判定要用这个方向）
    const d = Math.hypot(dx, dz);
    if (d > C.GK_CATCH_DIST || d < 0.05) continue;             // 来球前 1.25 米起手
    const vl = Math.hypot(bb.vx, bb.vz);
    /* ★ 这里原来有一条"正面近身球直接没收"——**不播动作就把球吞进手**，
     *   正是用户说的"动作没显示就拦截球了"。已删除：
     *   现在所有接球都必须走"起手动画 → 用动画里手的真实位置判够不够到"，
     *   见下方 gkStartAnim + gkCanReach（以及「禁区内接球」那一段）。 */
    const frontDot = (bb.x - p.x) * Math.sin(p.yaw) + (bb.z - p.z) * Math.cos(p.yaw);
    if (vl < 2.5) continue;                                   // 球得真的冲过来（快速球走下面的接球/飞扑流程）
    const closing = (bb.vx * dx + bb.vz * dz) / (vl * d);     // >0 = 朝门将飞来
    if (closing < 0.55) continue;
    // 正对身体：横向偏出超过手臂够得着的范围 → 交给飞扑，不提前锁死
    if (Math.abs(bb.z - p.z) > C.GK_HAND_R + 0.35) continue;
    // 玩家刚手动操作过（0.6s 内）→ 自动接球让位，别抢着再播一遍
    if (p.gkManualT < 0.6) continue;
    /* ★ 起手时机 + 变速：让"手到位的那一刻"正好是"球到门前的那一刻"。
     *
     *   gk-reach.json 里每个动作的"手到球位"时刻不同（低球要蹲到 ~28%、高球要
     *   举到 ~25%）。如果只在球到 1.25m 才起手，30m/s 的射门 0.04s 就到了，
     *   而手要 0.7s 才伸出去 → 永远慢半拍（表现为"没扑到"或反过来"球自己进手"）。
     *   所以：按"球还有多久到"反推该用多快播，最多 3.2 倍，还不够快就再提前起手。 */
    const name = bb.y > 1.35 ? 'gkCatchHigh' : (bb.y > 0.70 ? 'gkCatchBody' : 'gkCatchLow');
    const dur = C.GK_CATCH[name];
    const frac = GK_MOMENT[name] || 0.28;                    // 手到球位的最佳时刻（归一化）
    const tArrive = vl > 0.1 ? Math.max(0.05, (d - C.GK_HAND_R - C.BALL_R) / vl) : 9;
    if (tArrive > frac * dur) continue;                      // 还早 → 再等等，别做无效动作
    const spd = clamp((frac * dur) / Math.max(0.08, tArrive), 1, 3.2);
    if (!gkStartAnim(p, name, dur, spd)) continue;
    io.emit('gkSave', { by: p.name, kind: 'catch' });
    break;
  }

  /* --- ★ 门将近距离抢球（Goalkeeper Scoop）---
   * 用户反馈"守门员不会自动抢夺近距离足球"。这里补上：
   *   球**停在门将附近的地面上/半高**（不是冲过来的快球 —— 那走上面的接球/飞扑），
   *   且**附近有对方球员**在抢（否则站着等球滚到脚边就行，不用扑），
   *   门将就朝球的方向扑出去把球捞进怀里（gkScoop 有 3.8m 前冲位移）。
   * 与"自动接球"互斥：走的是 gkStartAnim 同一把锁，所以不会两个动作一起播。 */
  /* ★★ 门将"扑抢 / 捡球"（gkScoop）—— 三种情形共用一个动作 + 一个**判定窗口**
   *
   *   ① `must`  近距离**无主滚动球 → 必捡**（用户要求：近身没人控的球不该漏）
   *            不用手部几何判，动作窗口内只要球还在身上就抱起来 —— 这是"必捡"的语义。
   *   ② `steal` **面前 1m 扇形内被对方控制的球** → 扑上去捡（门将在小禁区里收脚下球）
   *   ③ `chase` 中距松球（2.2~3.4m）且有对手争抢 → 原来的"扑出去捞"
   *
   *   实测（改动前）门将只对 ③ 有反应、且要求 `d >= 0.6`，所以脚边的球会"看着不管"。
   */
  for (const p of players) {
    if (!p.isGK || !p.botGK) continue;                        // 只给 AI 门将（真人自己操作）
    if (p.downT > 0 || p.upT > 0 || p.gkHold || !inOwnBox(p)) continue;
    if (p.kickAnim > 0 || p.animLock > 0.05 || p.gkSaveT > 0 || p.gkActCd > 0 || p.gkRelease) continue;
    const bb = G.ball;
    if (G.restart) continue;                                  // 死球期间不乱动
    if (bb.y > 1.25) continue;                                // 高球交给接高球 / 飞扑
    const d = Math.hypot(bb.x - p.x, bb.z - p.z);
    const bsp = Math.hypot(bb.vx, bb.vz);
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    const dot = d > 0.01 ? ((bb.x - p.x) * fx + (bb.z - p.z) * fz) / d : 1;

    let mode = null;
    if (!bb.owner) {
      /* ① 无主球：**禁区里 3m 内的松球一律主动出击**（用户要求"近身没人控的球必捡"）。
       *   原来只覆盖 2.2m，2.2~3.4m 之间还要求"附近有对手在抢"才动 ——
       *   结果门将站在那儿看球停在 2.4m 处不管（用户反馈"面对无控制的区域不捡"）。 */
      if (d <= 3.0 && bsp < 16) mode = 'must';
      else if (d > 3.0 && d <= C.GK_SCOOP_DIST && bsp <= 6) {
        // ③ 中距松球：附近有对手在争抢才值得扑出去
        for (const q of G.players.values()) {
          if (q.team === p.team || q.dead) continue;
          if (Math.hypot(q.x - bb.x, q.z - bb.z) < 2.6) { mode = 'chase'; break; }
        }
      }
    } else if (bb.owner !== p.id) {
      const o = G.players.get(bb.owner);
      /* ② 面前被**对方**控制的球 → 扑上去掏（单刀球）
       *   原来只认 1.25m / 正前方 72° 扇形 —— 单刀时对手常常在 1.5~2.5m 外带球冲过来，
       *   门将永远不启动（用户反馈"单刀近距离前方不会触发捡球"）。
       *   现在放宽到 2.8m、半平面（dot > -0.1，即球不在身后就行）。 */
      if (o && o.team !== p.team && d <= 2.8 && dot > -0.10 && bsp < 24) mode = 'steal';
    }
    if (!mode) continue;

    if (!gkStartAnim(p, 'gkScoop', C.GK_ANIM.gkScoop)) continue;
    const ang = Math.atan2(bb.x - p.x, bb.z - p.z);
    p.aimYaw = p.yaw = ang;
    p.gkScoopMode = mode;
    p.gkSaveT = C.GK_ANIM.gkScoop * 0.92;                     // 窗口时长（判定细节见接球循环）
    p.gkSaveR = C.GK_SCOOP_REACH;
    /* 扑出位移：按"到球的距离"给速度，别原地空扑（远处才冲，脚边只要倒身） */
    const need = Math.max(0.15, d - 0.35);
    /* 位移时长给到窗口的 80%（后面窗口内还会逐帧朝球续速），
     * 否则 0.5s 后门将就站着不动了，对手一带球就再也够不着。 */
    const mvT = mode === 'chase' ? 0.9 : clamp(need / C.GK_SCOOP_SPD, 0.30, 1.2);
    p.gkMoveT = mvT;
    p.gkSaveVX = Math.sin(ang) * (need / mvT);
    p.gkSaveVZ = Math.cos(ang) * (need / mvT);
    p.gkKind = 'scoop';
    if (GK_DEBUG) console.log(`[GK扑抢] ${p.name} mode=${mode} 球距=${d.toFixed(2)}m 球速=${bsp.toFixed(1)} owned=${bb.owner || '-'}`);
    io.emit('gkSave', { by: p.name, kind: 'scoop' });
    break;
  }

  /* --- 球 --- */
  const b = G.ball;
  /* ★ 本帧起点（含高度）必须在**所有**用到它的地方之前声明：
   *   接球判定、人体碰撞箱、stepBall 都要它。之前它声明在接球循环后面，
   *   接球循环先跑 → `Cannot access 'bs' before initialization`（TDZ 直接崩进程）。 */
  const bs = (!b.owner && !G.restart) ? { x: b.x, y: b.y, z: b.z } : null;


  /* ---------- ★ 门将抱球的不变量（每帧收口，防"没抱球也在抱球姿势"） ----------
   *
   *  背景：`p.gkHold` 是个**独立锁存的标志位**，但"球权"在 20+ 处会被清掉
   *  （被拳击/被铲倒/被抢断/进球复位/开球/掉线…），其中大部分只清 ball.owner
   *  而忘了清 gkHold → 球早就没了，门将还抱着。这就是用户反馈的
   *  "没有没收足球也会进入这个姿势"。
   *
   *  与其在 20 个地方各补一行（漏一个就复发），不如**在这里统一收口**：
   *  每帧断言「抱球 ⇒ 球确实在自己脚下 + 自己还是门将」。任一条不成立就立刻清掉。
   *  gkRelease 期间例外 —— 那是有意的"动作已起手、等发力时刻放球"的过渡态。 */
  for (const p of players) {
    if (!p.gkHold) continue;
    if (p.gkRelease) continue;                            // 出球动作进行中：由 gkRelease 到点后收
    if (isKeeper(p) && G.ball.owner === p.id && p.dribbling) continue;   // 正常：球捧在手里
    p.gkHold = false;                                     // 球没了 / 不是门将了 → 立刻结束抱球姿势
    p.holdT = 0;
  }

  /* --- 手抛球（界外球）进行中：球钉在边线，指定球员跑过去掷回 --- */
  if (G.restart) stepRestart(b, dt, players);
  if (b.owner) {
    const o = G.players.get(b.owner);
    if (!o || !o.dribbling) { b.owner = null; }
    else if (o.gkHold) {
      // 门将抱球：球贴在胸前，且朝球场中央（不是贴在脸前/脚边）
      let cx = -o.x, cz = -o.z;                              // 指向球场中央
      const cl = Math.hypot(cx, cz) || 1;
      cx /= cl; cz /= cl;
      const k = 1 - Math.exp(-20 * dt);
      /* ★★ 球的位置要**跟当前门将动作的手**走，不能写死一个世界高度。
       *   踩过：接球动作是"弯腰捞球"，球却被固定在 0.97m → 浮在门将背上
       *   （截图一眼就能看出来）。这里按当前动作进度查 gk-reach.json 取双手中点，
       *   动作播完（回落 gkHold 循环）才用实测的展示位 0.97m / 身前 0.36m。 */
      let ty = 0.97, fw = 0.36;
      if (o.gkAnimName && o.gkAnimT > 0 && GK_REACH[o.gkAnimName]) {
        const rel = o.gkAnimRel || 1;
        const pr = 1 - clamp((o.gkAnimT * rel) / Math.max(0.01, o.gkAnimBase || 1), 0, 1);
        const ps = gkPoseAt(o.gkAnimName, pr);
        if (ps) {
          const mx = (ps[0] + ps[3]) * 0.5, my = (ps[1] + ps[4]) * 0.5, mz = (ps[2] + ps[5]) * 0.5;
          const hipY = (o.y || 0) + ps[9];
          ty = hipY + my;
          fw = clamp(0.18 + mz, 0.18, 0.7);        // 手在身前多远（本地 z）
        }
      }
      const tx = o.x + cx * fw, tz = o.z + cz * fw;
      b.x = lerp(b.x, tx, k);
      b.z = lerp(b.z, tz, k);
      /* ★ 抱球高度 = **从 gkHold 动画里量出来的手位**（build-gk-reach.mjs 采的 gkHold）：
       *     髋高 0.79m，手相对髋 +0.16~0.18 → 手在世界高度 **0.95~0.97m**，身前 0.33m。
       *   所以球心放在 0.97（略高于掌心 0.01，看起来是被捧着而不是穿进手里）。
       *   历史上这个值改过两次：1.32（胸口，浮在手臂上方）→ 0.66（胯前，太低）→ 现在按实测。 */
      b.y = lerp(b.y, ty, k);                                // 手位高度（跟动作走）
      b.vx = o.vx; b.vy = 0; b.vz = o.vz;
    }
    else {
      const fx = Math.sin(o.yaw), fz = Math.cos(o.yaw);
      const sp = Math.hypot(o.vx, o.vz);
      let tx, tz, k = 18;
      /* ★ 持球**原地待机**（Soccer Idle 来回拉球）：球按动画里**双脚的真实位置**走，
       *   而不是死死挂在脚前 0.42m —— 否则人脚在球上来回拉，球纹丝不动，一眼假。
       *   数据来自 `build-dribble-ball.mjs` 采的脚尖轨迹（每帧两脚中点 + 前移一个球半径）。 */
      /* ★★ 马赛回旋：**球被带着绕人一圈**（用户要求"要带着球跑"）。
       *   球权一直在自己脚下，位置按 `spin-ball.json` 走：那张表是
       *   `build-spin-ball.mjs` 从 clip 里量**肩线俯视转角**算出来的方位角（半径 0.42m），
       *   所以球跟着身体一起转，收尾正好回到正前方 —— 写死"球定在世界前方"
       *   会让转到一半时"人背对球、脚从球上跨过去"。 */
      if (SPIN_BALL && o.anim === 'spin' && G.ball.owner === o.id) {
        const pr2 = clamp((o.animT || 0) / Math.max(0.01, SPIN_BALL.dur), 0, 0.999);
        const fi = pr2 * (SPIN_BALL.n - 1);
        const i0 = Math.min(SPIN_BALL.n - 1, Math.floor(fi));
        const i1 = Math.min(SPIN_BALL.n - 1, i0 + 1);
        const f = fi - i0;
        const a = SPIN_BALL.s[i0], c = SPIN_BALL.s[i1];
        const lx = a[0] + (c[0] - a[0]) * f;
        const lz = a[1] + (c[1] - a[1]) * f;
        const cy2 = Math.cos(o.yaw), sy2 = Math.sin(o.yaw);
        tx = o.x + lx * cy2 + lz * sy2;
        tz = o.z - lx * sy2 + lz * cy2;
        k = 34;                                   // 跟得很紧：球是"贴着脚滚"的
      } else if (DRIBBLE_IDLE && o.anim === 'dribbleIdle' && sp < 0.5) {
        const pr = ((o.animT || 0) % DRIBBLE_IDLE.dur) / DRIBBLE_IDLE.dur;
        const fi = pr * (DRIBBLE_IDLE.n - 1);
        const i0 = Math.min(DRIBBLE_IDLE.n - 1, Math.floor(fi));
        const i1 = Math.min(DRIBBLE_IDLE.n - 1, i0 + 1);
        const f = fi - i0;
        const a = DRIBBLE_IDLE.s[i0], c = DRIBBLE_IDLE.s[i1];
        const lx = ((a[0] + (c[0] - a[0]) * f) + (a[2] + (c[2] - a[2]) * f)) * 0.5;
        const lz = ((a[1] + (c[1] - a[1]) * f) + (a[3] + (c[3] - a[3]) * f)) * 0.5 + 0.16;
        const cy2 = Math.cos(o.yaw), sy2 = Math.sin(o.yaw);
        tx = o.x + lx * cy2 + lz * sy2;          // 本地(侧/前) → 世界（与手部判定同一套约定）
        tz = o.z - lx * sy2 + lz * cy2;
        k = 26;                                   // 跟脚更紧，别拖影
      } else {
        const lead = 0.42 + clamp(sp * 0.05, 0, 0.35);
        tx = o.x + fx * lead; tz = o.z + fz * lead;
      }
      b.x = lerp(b.x, tx, 1 - Math.exp(-k * dt));
      b.z = lerp(b.z, tz, 1 - Math.exp(-k * dt));
      b.y = C.BALL_R;
      b.vx = o.vx; b.vy = 0; b.vz = o.vz;
    }
  }
  /* --- ★ 第一脚击球（提前蓄力 + 正前方脚下判定）---
   *  放在 stepBall **之前**：判定命中当帧球就被赋速踢走，stepBall 从新速度继续积分。
   *  死球期不走（发球流程自己管）。 */
  if (!b.owner && !G.restart) {
    for (const p of players) {
      if (p.bot) continue;                     // AI 不用这套（有自己的射门逻辑）
      tryFirstStrike(p);
    }
  }

  if (!b.owner && !G.restart) stepBall(b, dt);

  /* --- 守门员接球：**只在门将动作真正够到球时**才算接住（所见即所得） --- */
  if (!G.restart) {
    for (const p of players) {
      if (p.gkSaveT <= 0 || p.gkHold || b.owner === p.id) continue;
      p.gkSaveT -= dt;                                   // 接球窗口随时间关闭
      if (p.gkSaveT <= 0 && GK_DEBUG) {                  // 窗口收尾：看"手离球最近差多少"
        console.log(`[GK窗口] ${p.name} 动作=${p.gkAnimName || '-'} 最近差距=${(p._gkBest || 99).toFixed(2)}m`
          + ` 球高=${b.y.toFixed(2)} 门将=(${p.x.toFixed(1)},${p.y.toFixed(2)},${p.z.toFixed(1)})`);
        p._gkBest = 99;
      }
      // ★ 线段 = 本帧的**真实位移**：起点是 stepBall 之前的位置，终点是现在的位置。
      //   （原来终点写成 b.x + vx*dt，等于算了两帧的路程 → 判定会提前一点点）
      /* ★★ 扑抢捡球的**动作判定窗口**（用户要求）
       *
       *   gkScoop 播到 6%~88% 之间（正是倒身 / 伸手抱球那一段）时开窗：
       *   只要球还在身体覆盖范围内就捡起来。
       *     · must  → 近身无主球，半径 2.2m，**必捡**（不看手部几何：动作到了就算捡到）
       *     · steal → 面前被对手控制的球，半径 1.45m 且必须在身前扇形里
       *     · chase → 中距松球，用 GK_SCOOP_REACH
       *   这和"接球靠手的真实位置"不冲突：捡球 = 整个人扑到球上，接触面是身体，
       *   用身体半径判才对（只认拳头那一点会把脚边的球判成够不到）。 */
      if (p.gkScoopMode) {
        if (!(p.gkAnimT > 0)) p.gkScoopMode = null;
        else {
          /* ★ 进度必须按**原始 clip 时长**算：
           *   gkAnimT 与 kickAnim 都是「已按 1/spd 折算」的剩余值、两者恒等，
           *   用 gkAnimT / kickAnim 永远是 1 → prog 恒为 0（窗口永远不开）。
           *   正确：真实已播 = gkAnimBase - gkAnimT*spd。 */
          const prog = 1 - clamp((p.gkAnimT * (p.gkAnimRel || 1)) / Math.max(0.01, p.gkAnimBase || p.kickAnim), 0, 1);
          /* ★ 窗口放宽到 **2%~95%**（用户要求"自动化捡起宽容一点"）：
           *   原来 6%~88% 要等动作播到 6% 才开窗、88% 就关掉，
           *   脸贴脸的被控球常常在开窗前就被对手带走了。 */
          if (prog >= 0.02 && prog <= 0.95) {
            const mode = p.gkScoopMode;
            const dd = Math.hypot(b.x - p.x, b.z - p.z);
            /* ★ must/steal 的判定半径都放宽：
             *   · must（无主球）1.25 → **1.40**
             *   · steal（被对方控制）1.45 → **1.85** —— 正面贴脸的带球，门将本来就能一把按住
             *   chase 仍用 GK_SCOOP_REACH。
             *   （2.2m 那种"隔空吸球"仍然不允许，那才是"没扑到却抱球"的来源。） */
            const R = mode === 'must' ? 1.40 : (mode === 'steal' ? 1.85 : C.GK_SCOOP_REACH);
            const fwx = Math.sin(p.yaw), fwz = Math.cos(p.yaw);
            /* steal 只要求"球不在正后方"（dot > -0.9 ≈ ±154°），
             * 原来 -0.45（±117°）会把侧面贴脸的球判成"不在身前"。 */
            const frontOk = mode === 'must' ? true
              : ((b.x - p.x) * fwx + (b.z - p.z) * fwz) > (mode === 'steal' ? -0.9 : -0.45);
            const holder = b.owner ? G.players.get(b.owner) : null;
            const mateBall = holder && holder.team === p.team && holder.id !== p.id;
            /* ★ 窗口内**持续朝球追**（限速）：起手时算的位移方向是死的，
             *   而"脸贴脸"的球多半在对手脚下被带着跑 —— 门将必须跟着挪才按得住。
             *   只在窗口内、球还在 2.6m 内、自己还在禁区里时生效，速度上限 2.8m/s。 */
            if (p.gkAnimT > 0 && dd > 0.45 && dd < 2.6 && inOwnBox(p) && p.downT <= 0) {
              const vx2 = (b.x - p.x) / dd, vz2 = (b.z - p.z) / dd;
              p.gkSaveVX = vx2 * 2.8;
              p.gkSaveVZ = vz2 * 2.8;
              if (p.gkMoveT <= 0.02) p.gkMoveT = 0.06;
            }
            if (b.y < 1.5 && dd <= R + C.BALL_R && frontOk && !mateBall) {
              if (holder && holder.id !== p.id) holder.dribbling = false;   // 从对手脚下掏走
              GK_STATS.catches++;
              GK_STATS.withAnim++;
              GK_STATS.anims.gkScoop = (GK_STATS.anims.gkScoop || 0) + 1;
              console.log(`[GK捡球] ${p.name} mode=${mode} 球距=${dd.toFixed(2)}m 窗口=${(prog * 100).toFixed(0)}%`
                + (holder ? ` 从 ${holder.name} 脚下` : ''));
              b.owner = p.id; p.dribbling = true; p.gkHold = true;
              b.vx = b.vy = b.vz = 0; b.lastTouch = p.id;
              p.holdT = 0; p.gkSaveT = 0; p.gkMoveT = 0; p.gkScoopMode = null;
              /* 收球后动作剩余截断到 0.35s：让门将迅速起身进抱球姿势，
               *   别让"弯腰捞球"的定格和飘在背上的球同时出现。 */
              p.gkAnimT = Math.min(p.gkAnimT, 0.35);
              p.kickAnim = Math.min(p.kickAnim, 0.35);
              p.animLock = Math.min(p.animLock, 0.35);
              io.emit('gkSave', { by: p.name, caught: true });
              continue;
            }
          }
        }
      }

      const start = bs || { x: b.x, y: b.y, z: b.z };
      const end = { x: b.x, y: b.y, z: b.z };
      if (gkCanReach(p, end, start)) {
        const reachR = p._gkReachR || 0;
        console.log(`[接住] ${p.name}${p.botGK ? '(AI)' : '(真人)'} 动作=${p.gkAnimName || '-'}`
          + ` 接触=${p._gkWhy || '-'} 最近=${(p._gkMinD || 0).toFixed(2)}m 球高=${b.y.toFixed(2)}m`);
        GK_STATS.catches++;
        if (p.gkAnimT > 0) { GK_STATS.withAnim++; GK_STATS.anims[p.gkAnimName] = (GK_STATS.anims[p.gkAnimName] || 0) + 1; }
        else GK_STATS.noAnim++;
        b.owner = p.id; p.dribbling = true; p.gkHold = true;
        b.vx = 0; b.vy = 0; b.vz = 0; b.lastTouch = p.id;
        p.gkSaveT = 0; p.gkMoveT = 0;
        p.gkAnimT = Math.min(p.gkAnimT, 0.35);
        p.kickAnim = Math.min(p.kickAnim, 0.35);
        p.animLock = Math.min(p.animLock, 0.35);
        io.emit('gkSave', { by: p.name, caught: true });
      }
    }
  }

  /* --- 北侧练习区：球滚进替补席那一段时，外侧拦一道软挡板 ---
   *  否则球会一路滚到 WALL_MARGIN 的硬墙上（z=-40），而玩家最多只能走到 z=-37，
   *  球就"卡在界外捡不到"了。这里把练习区的球限制在 BENCH_BAY.Z 以内（玩家够得到），
   *  碰到就轻轻弹回场内。 */
  if (!b.owner && !G.restart && b.z < C.BENCH_BAY.Z && Math.abs(b.x) <= C.BENCH_BAY.X) {
    b.z = C.BENCH_BAY.Z;
    b.vz = Math.abs(b.vz) * 0.45;
  }

  /* --- 人体触球碰撞箱（圆柱：脚底到头顶）---
   *  没按带球（F）时，身体碰到球会把球顶开并折射；跑动中撞球 → 球速向人的速度收敛。
   *  扫掠检测 = 本帧位移线段 vs 圆柱（解二次方程找「进入点」）：
   *  32m/s 的球每帧位移 1m+，离散判定会直接穿人；只测终点距离又会漏掉「已越过
   *  圆心最近点」的正对命中（法向翻转成"分离中"）。起点在箱内（人跑过来）也覆盖。
   *  按着带球 / 滑铲中 → 交给吸附逻辑和滑铲捅球，不在这里处理。 */
  if (bs) {
    for (const p of players) {
      if (p.slideT > 0) continue;                                   // 滑铲捅球已单独处理
      if (G.restart && p.team !== G.restart.team) continue;          // 死球期间非发球方不碰球
      /* ★★ 守门员在禁区内接球 —— **所见即所得**
       *
       *  旧逻辑的两个毛病（用户反馈"动作没显示就拦截球了"）：
       *    ① `b.y < 2.6` 就允许接 → 站着不动也能"接住"2.6m 高的球（模型头顶才 1.75m）
       *    ② `b.owner = p.id` 是**无条件**执行的 —— 上面的 gkStartAnim 就算被
       *       收招窗口拒了，球照样被吞进手里 → 屏幕上没有扑救动作，球却没了
       *
       *  现在的规则很硬：
       *    · 没动作 → 先试着起手接球动作（按球高选 low/body/high）
       *    · 起不来（收招窗口/正在做别的动作）→ **这一帧不接**，等下一帧
       *    · 动作在播 → 用 gkCanReach 查**模型此刻手/头/身体的位置**，真够到才接
       *  于是画面与判定永远同步：看到手够到了才算接住。
       */
      if (isKeeper(p) && inOwnBox(p) && !p.gkHold && !(b.lastTouch === p.id && p.kickCd > 0)) {
        const gd = Math.hypot(b.x - p.x, b.z - p.z);
        const bv = Math.hypot(b.vx, b.vz);
        /* ★ 这里只管**慢球**（滚到脚边/半停的球）。
         *   快球一律交给 updateKeeperAI 的扑救分支 —— 那条路径会按"球还有多久到门线"
         *   反推动作播放速度。以前这里对快球也起手 2.6s 的接球动作，等于把门将锁死
         *   在原地做慢动作，球早飞过去了（表现得像"没反应"）。 */
        const slowBall = bv <= 8;
        const near = slowBall && gd < C.GK_HAND_R + C.BALL_R + 0.9;
        if (near) {
          // 没在演任何门将动作 → 按球高起手接球（低/半高/高），速度按到达时间反推
          if (!p.gkRelease && !(p.gkAnimT > 0) && !p.kickAnim && p.gkManualT >= 0.4) {
            const nm = b.y > 1.35 ? 'gkCatchHigh' : (b.y > 0.70 ? 'gkCatchBody' : 'gkCatchLow');
            const dur = C.GK_CATCH[nm];
            const frac = GK_MOMENT[nm] || 0.28;
            const tArr = Math.max(0.08, (gd - C.GK_HAND_R) / Math.max(0.5, bv));
            const spd = clamp((frac * dur) / tArr, 1, 3.2);
            gkStartAnim(p, nm, dur, spd);
          }
          /* 只有在门将动作**正在播**时才可能接住；判定一律交给 gkCanReach
           * （它会用当前动画进度算出手的真实位置）。 */
          if (p.gkAnimT > 0 && gkCanReach(p, b, bs)) {
            console.log(`[接球] ${p.name}${p.botGK ? '(AI)' : '(真人)'} 动作=${p.gkAnimName || '-'}`
              + ` 接触=${p._gkWhy || '-'} 距离=${gd.toFixed(2)}m 球高=${b.y.toFixed(2)}m 球速=${bv.toFixed(1)}m/s`);
            GK_STATS.catches++;
            if (p.gkAnimT > 0) { GK_STATS.withAnim++; GK_STATS.anims[p.gkAnimName] = (GK_STATS.anims[p.gkAnimName] || 0) + 1; }
            else GK_STATS.noAnim++;
            b.owner = p.id; p.dribbling = true; p.gkHold = true;
            b.vx = b.vy = b.vz = 0; b.lastTouch = p.id;
            p.holdT = 0;                                        // 刚抱住：重新计时（出球前的持球时间）
            p.gkAnimT = Math.min(p.gkAnimT, 0.35);
            p.kickAnim = Math.min(p.kickAnim, 0.35);
            p.animLock = Math.min(p.animLock, 0.35);
            io.emit('gkSave', { by: p.name, caught: true });
            break;                                              // 抱住就不再走弹开逻辑
          }
        }
      }
      // 自己刚踢出/捅出的球：球还在自己脚边箱内，别被自己的碰撞箱把球速吸回去
      // （射门 32m/s 每帧位移 1m+，不躲开的话顶球逻辑会把球速收敛到跑动速度）
      if (b.lastTouch === p.id && p.kickCd > 0) continue;
      /* ★ 碰撞箱跟着模型的实际高度走（用户要求"头球会根据模型位置提高碰撞"）：
       *   站立：脚底 0 → 头顶 TOUCH_H(1.75)
       *   跳跃：整体抬高 p.y → 能顶到 TOUCH_H + p.y 那么高的球
       *   跃起争顶：上限放宽到 HEAD_H(2.05) + p.y，让跳起来的头部能顶到高球
       *   （原来箱子固定在 0~1.75，人跳起来箱子还贴地 → 高球永远顶不到） */
      const airborne = p.y > 0.06;
      const boxTop = (airborne ? C.HEAD_H : C.TOUCH_H) + p.y;
      if (b.y > boxTop + C.BALL_R || b.y < p.y - C.BALL_R) continue;   // 高于可及顶点 / 低于脚底
      if (p.input.grab && Math.hypot(b.x - p.x, b.z - p.z) < C.GRAB_DIST + C.BALL_R) continue;  // 按着带球 → 让吸附逻辑吞球
      const minD = C.TOUCH_R + C.BALL_R;
      const sx = bs.x, sz = bs.z;
      const dx = b.x - sx, dz = b.z - sz;
      const fx = sx - p.x, fz = sz - p.z;
      const a = dx * dx + dz * dz;
      const bb2 = 2 * (fx * dx + fz * dz);
      const c = fx * fx + fz * fz - minD * minD;
      const disc = a > 1e-9 ? bb2 * bb2 - 4 * a * c : -1;
      let nx = 0, nz = 0, hit = false;
      if (disc >= 0) {                                              // 线段与圆柱相交 → 进入点
        const t1 = (-bb2 - Math.sqrt(disc)) / (2 * a);
        if (t1 >= 0 && t1 <= 1) {
          const ox = sx + dx * t1 - p.x, oz = sz + dz * t1 - p.z;
          const l = Math.hypot(ox, oz) || 1;
          nx = ox / l; nz = oz / l; hit = true;
        }
      }
      if (!hit && c < 0) {                                          // 起点就在箱内（人跑过来/低速接触）
        const ox = b.x - p.x, oz = b.z - p.z;
        const l = Math.hypot(ox, oz);
        if (l > 0.0001) { nx = ox / l; nz = oz / l; }
        else if (a > 1e-9) { const la = Math.sqrt(a); nx = -dx / la; nz = -dz / la; }
        else { nx = 1; nz = 0; }
        hit = true;
      }
      if (!hit) continue;
      b.x = p.x + nx * minD;                                        // 放到碰撞点并推出箱外
      b.z = p.z + nz * minD;
      const vn = b.vx * nx + b.vz * nz;
      if (vn < 0) {                                                 // 朝人撞过来 → 沿法向折射
        const j = -(1 + C.BALL_BODY_BOUNCE) * vn;
        b.vx += j * nx; b.vz += j * nz;
      }
      if (Math.hypot(p.vx, p.vz) > 0.5) {                           // 跑动中 → 顶球（率限制，防每帧累加）
        const k = 1 - Math.exp(-C.BALL_BODY_PUSH * dt);
        b.vx += (p.vx - b.vx) * k;
        b.vz += (p.vz - b.vz) * k;
      }
      /* ★ 头球（跃起顶球）：碰撞点落在**头部高度**时给一次有力的向前顶出。
       *   判据：人在空中 + 球在肩以上（> 1.2 + p.y）+ 按朝向顶出 + 冷却。
       *   这就是"头球会根据模型位置提高碰撞"的行为侧：跳得越高，能顶到越高的球。 */
      if (airborne && (p.headCd || 0) <= 0 && b.y > 1.15 + p.y) {
        const fx2 = Math.sin(p.yaw), fz2 = Math.cos(p.yaw);
        // 朝面向方向顶（加上一点来球的入射分量，顶出去更自然）
        b.vx = fx2 * C.HEAD_BOOST + b.vx * 0.25;
        b.vz = fz2 * C.HEAD_BOOST + b.vz * 0.25;
        b.vy = Math.max(b.vy, 2.6);                                  // 顶出一个抛物线
        p.headCd = C.HEAD_CD;
        p.kickType = 'header';                                       // 客户端据此播头球动作
        p.headAnimT = 0.75;
        oneShotBump(p);
        io.emit('header', { by: p.name, x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
      }
      if (b.y <= C.BALL_R + 0.02 && Math.hypot(b.vx, b.vz) > 2) b.vy = Math.max(b.vy, 0.7);
      b.lastTouch = p.id;
    }
  }

  /* --- 门框（门柱 + 横梁）：★ 新加的实体碰撞 ---
   *  用户要求"语音绑定好事件活动不要空响"→ 要播"中柱"就必须真的有中柱。
   *  原来球是直接穿门柱进网的（只有门框内的球会进，打到柱子的球会被判成出界）。
   *  这里按**球心到两立柱轴线 / 横梁轴线**的距离做判定，命中就把球弹回场内，
   *  并发一个 hitPost 事件（客户端据此播"中柱"解说 + 看台叹息）。
   *  只在球朝球门方向飞行、且快到门线时才判，避免误伤场内的球。 */
  if (!b.owner && !G.restart && G.phase === 'play') {
    for (const side of [-1, 1]) {
      const goalX = side * C.FIELD.HALF_L;
      const toward = side > 0 ? b.vx > 0 : b.vx < 0;              // 朝这个球门飞
      if (!toward) continue;
      if (Math.abs(b.x - goalX) > 1.2) continue;                  // 只在门线附近 1.2m 内判
      const halfW = C.GOAL.W / 2, pr = C.GOAL_POST_R + C.BALL_R;
      // ① 门柱：球心到立柱轴线（竖直、位于 z = ±halfW）的水平距离
      for (const zs of [-halfW, halfW]) {
        if (b.y > C.GOAL.H + pr) continue;                        // 从横梁上方飞过
        const dz = b.z - zs;
        if (Math.abs(dz) < pr && Math.abs(b.x - goalX) < pr + 0.4) {
          // 从哪边来就弹回哪边
          const nx = -side;
          b.x = goalX + nx * (pr + 0.02);
          b.vx = nx * Math.abs(b.vx) * 0.62;
          b.vz += (dz >= 0 ? 1 : -1) * 1.4;                       // 蹭一口侧向
          b.vy = Math.max(b.vy, 0.9);
          io.emit('hitPost', { by: G.ball.lastTouch, kind: 'post', x: +b.x.toFixed(2), z: +b.z.toFixed(2) });
          break;
        }
      }
      // ② 横梁：球心到横梁轴线（水平、位于 y = GOAL.H）的距离
      if (b.y > 0 && Math.abs(b.z) < halfW - 0.02) {
        const dy = b.y - C.GOAL.H;
        if (Math.abs(dy) < pr && Math.abs(b.x - goalX) < pr + 0.4) {
          const nx = -side;
          b.x = goalX + nx * (pr + 0.02);
          b.vx = nx * Math.abs(b.vx) * 0.62;
          b.vy = dy >= 0 ? Math.abs(b.vy) * 0.5 + 1.0 : -Math.abs(b.vy) * 0.5 - 0.4;
          io.emit('hitPost', { by: G.ball.lastTouch, kind: 'bar', x: +b.x.toFixed(2), z: +b.z.toFixed(2) });
        }
      }
    }
  }

  /* --- 进球（必须排在出界之前，否则球会被先拉回场内，射门永远进不了） --- */
  if (G.phase === 'play') {
    const holder = b.owner ? G.players.get(b.owner) : null;
    const keeperHolding = !!(holder && holder.gkHold);        // 门将抱在手里过线不算进球
    const inMouth = !keeperHolding && Math.abs(b.z) < C.GOAL.W / 2 && b.y < C.GOAL.H + 0.2;
    if (inMouth && b.x > C.FIELD.HALF_L) doGoal('A');
    else if (inMouth && b.x < -C.FIELD.HALF_L) doGoal('B');
    else if (!b.owner) {
      /* --- 出界 ---
       *   ★ 例外：**北侧练习区**（替补席 / 人机靶子那一段，见 C.BENCH_BAY）不判出界。
       *   用户要求"人机靶子放在替补席旁边界外"，那片区域就得能自由玩球，
       *   否则球一滚到靶子脚下就被判出界、立刻重开，靶子形同虚设。 */
      const inBay = b.z <= -C.FIELD.HALF_W && b.z >= C.BENCH_BAY.Z && Math.abs(b.x) <= C.BENCH_BAY.X;
      const outX = Math.abs(b.x) > C.FIELD.HALF_L;
      const outZ = Math.abs(b.z) > C.FIELD.HALF_W && !inBay;
      if ((outX || outZ) && !G.restart) startRestart(b, outX, outZ);
    }
  }

  /* --- 动画状态 --- */
  for (const p of players) pickAnim(p, dt);

  /* --- 广播 --- */
  io.emit('state', {
    t: Date.now(),
    ball: { x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, wx: b.wx || 0, wy: b.wy || 0, owner: b.owner },
    players: players.map(dto),
    scores: G.scores,
    clock: G.clock,
    phase: G.phase,
    amb: G.amb,
    restart: G.restart ? { type: G.restart.type, team: G.restart.team, byId: G.restart.byId } : null,
  });
}

function doGoal(team) {
  const bx0 = G.ball.x, bz0 = G.ball.z;
  console.log('[进球] 判定队=' + team + ' 球位置 x=' + bx0.toFixed(2) + ' z=' + bz0.toFixed(2) +
    ' | 场上：' + [...G.players.values()].map(p => p.name + '(' + p.team + ')@' + p.x.toFixed(0)).join(' '));
  G.scores[team]++;
  GK_STATS.goals++;
  /* ★ 庆祝语音次数：**全场每进一个球，每个人都 +1 次**
   *   （用户要求"根据进球数发放次数，全场进一个每个人就多一次"）。
   *   存成 p.cheer 随 dto 下发，客户端转盘直接用。 */
  for (const q of G.players.values()) q.cheer = (q.cheer || 0) + 1;
  G.phase = 'goal';
  G.phaseT = C.GOAL_RESET_SEC;
  G.lastGoalBy = team;
  // 球躺进网里，别再弹出来
  const b = G.ball;
  b.vx = b.vy = b.vz = 0;
  b.owner = null;
  b.x = team === 'A' ? C.FIELD.HALF_L + C.GOAL.D * 0.5 : -C.FIELD.HALF_L - C.GOAL.D * 0.5;
  b.z = clamp(b.z, -C.GOAL.W / 2 + 0.3, C.GOAL.W / 2 - 0.3);
  b.y = C.BALL_R;
  const scorer = G.ball.lastTouch ? (G.players.get(G.ball.lastTouch) || {}).name : null;
  io.emit('goal', {
    team, by: scorer, scores: G.scores,
    pos: { x: bx0, z: bz0 },
  });
  io.emit('scoresUpdate', { A: G.scores.A, B: G.scores.B, team, by: scorer, gain: 1 });
}

function dto(p) {
  return {
    id: p.id, name: p.name, team: p.team, color: p.color, bot: p.bot,
    /* ★ 这两个字段必须在这里 —— 客户端/测试靠它们区分"纯人机靶子"和
     *   AI 门将(botGK)/射门机器人(botShooter)：它们的位置完全不同（在球门区/替补席），
     *   选错目标就会连出怪现象（踩过：bot-test 的"球撞不穿人机"偶发失败）。
     *   同时把 oneShotSeq 带出来（客户端判断一次性动作是否重播要用）。 */
    botGK: !!p.botGK, botShooter: !!p.botShooter, oneShotSeq: p.oneShotSeq || 0,
    x: p.x, y: p.y, z: p.z, yaw: p.yaw,
    vx: p.vx, vz: p.vz,
    mode: p.mode, anim: p.anim, animSpd: p.animSpd, kick: p.kickAnim > 0,
    drib: p.dribbling, sl: p.slideT > 0,
    hp: Math.round(p.hp), down: p.downT > 0 || p.upT > 0,
    cards: p.cards.map(c => ({ id: c.id, name: c.name, spent: c.spent })), boost: Math.max(0, +(p.boostT || 0).toFixed(1)),
    skillCd: { flyKick: +Math.max(0, (p.skillCd && p.skillCd.flyKick) || 0).toFixed(2), hurricane: +Math.max(0, (p.skillCd && p.skillCd.hurricane) || 0).toFixed(2), spin: +Math.max(0, (p.skillCd && p.skillCd.spin) || 0).toFixed(2) },
    gk: isKeeper(p), gkHold: !!p.gkHold, lock: !!p.aimLock, claim: !!p.claimHint, hint: !!p.restartHint, ready: !!p.restartReady,
    /* ★ 传球冷却剩余秒数（客户端用来"按钮变灰 + 显示倒计时"）。
     *   没有它，3s 冷却期间玩家按键既没动画也没声音像"卡了"——直接不可用。 */
    passCd: +Math.max(0, p.passCd || 0).toFixed(2),
    dead: !!p.dead, dying: !!p.dying, revT: +Math.max(0, p.revT || 0).toFixed(2), revT0: p.revT0 || 0,
    reviveWalk: !!p.reviveWalk, benchIn: !!p.onBenchSpawn, headAnim: +(p.headAnimT || 0).toFixed(2),
    coins: Math.round(p.coins || 0), betTeam: p.betTeam || null, betAmt: p.betAmt || 0,
    ambBet: p.ambBet || null, ambAmt: p.ambAmt || 0,
    cheer: p.cheer || 0,                     // 剩余庆祝语音次数（转盘上显示）
  };
}

/* ============================================================
 *  Socket
 * ============================================================ */
io.on('connection', (socket) => {
  /* ★ 观战连接（用户要求："选择页就能直接看到真人玩家在游玩"）
   *   开始界面在**点击进入之前**先用 `?spectate=1` 连上，这时：
   *     · 不占玩家槽位、不占出生点、不参与分队
   *     · 不产生任何实体（别人看不到这个人）
   *     · 只**收** state 广播（和普通玩家收的是**同一条流**，不额外复制球场状态）
   *   点"进入球场"时客户端会重新以正式身份连一次（或发 `joinGame` 转正）。
   *
   *   ⚠️ 带宽：观战客户端收的 state 与在场玩家**完全一样**（同样的 21.5 包/秒、
   *   同样的载荷），不比自己踢球多一分钱。见 net-size.mjs 的实测。 */
  const isSpectator = String(socket.handshake.query.spectate || '') === '1';
  if (isSpectator) {
    /* ★ 用户要求关闭观战（2026-10-30）：外部脚本用 ?spectate=1 连上来，
       不占槽位、不产生实体，但每秒吃掉 30Hz 的 state 广播 → 云端看着像
       一堆脚本在刷（"长轮询87" 就是这类连接）。
       现在直接拒绝：观战连接一律断开。要恢复就设 SPECTATE=1。 */
    if (process.env.SPECTATE !== '1') {
      socket.emit('spectateHint', { msg: '观战已关闭' });
      socket.disconnect(true);
      return;
    }
    socket.join('spectate');
    socket.emit('spectateOk', { scores: G.scores, clock: G.clock, field: C.FIELD });
    socket.on('joinGame', (d) => {
      // 想转正：这里不处理（客户端重连更简单、状态更干净），只提示
      socket.emit('spectateHint', { msg: '请重新连接以入场' });
    });
    return;
  }

  if (G.players.size >= C.MAX_PLAYERS) {
    socket.emit('serverFull');
    return socket.disconnect(true);
  }
  const rawName = (socket.handshake.query.name || '').toString().trim().slice(0, 12);
  const name = rawName || ('球员' + Math.floor(Math.random() * 900 + 100));
  // 阵营：玩家可在开局界面选 红队(A) / 蓝队(B) / 随机(R)
  //   选了队且该队真人未满 → 按选择入队；否则回退到自动平衡分队
  const wantTeam = (socket.handshake.query.team || '').toString().toUpperCase();
  const _c = realCounts();
  const team = ((wantTeam === 'A' || wantTeam === 'B') && _c[wantTeam] < C.TEAM_SIZE)
    ? wantTeam
    : pickTeam();
  const p = makePlayer(socket.id, name, team);
  sendToBenchSpawn(p);              // ★ 入场先在球员席生成，再走上场（用户要求）
  G.players.set(socket.id, p);


  socket.emit('init', {
    id: socket.id,
    team,
    teams: C.TEAMS,
    scores: G.scores,
    round: G.round,
    clock: G.clock,
    field: C.FIELD,
    goal: C.GOAL,
    ball: G.ball,
    bet: betState(),                                  // 押注盘口（B 键商店）
    amb: G.amb,                                       // 救护车状态
    players: [...G.players.values()].map(dto),
    consts: {
      GRAB_DIST: C.GRAB_DIST, PLAYER_R: C.PLAYER_R, BALL_R: C.BALL_R,
      SPD: C.SPD, GRAVITY: C.GRAVITY, ACCEL0: C.ACCEL0, DECEL: C.DECEL,
      TEAM_SIZE: C.TEAM_SIZE, MATCH_SEC: C.MATCH_SEC,
    },
  });
  io.emit('chat', { type: 'system', text: `${name} 加入${C.TEAMS[team].name}` });

  socket.on('input', (d) => {
    if (!d || !G.players.has(socket.id)) return;
    const p = G.players.get(socket.id);
    p.input.yaw = typeof d.yaw === 'number' ? d.yaw : p.input.yaw;
    p.input.mx = clamp(d.mx || 0, -1, 1);
    p.input.mz = clamp(d.mz || 0, -1, 1);
    p.input.sprint = !!d.sprint;
    p.input.jump = !!d.jump;
    p.input.walk = !!d.walk;
    p.input.grab = !!d.grab;      // F 按住 = 持续尝试吸附（tryGrab 有 CD 保护）
    /* ★ 第一脚击球的蓄力上行：
     *   ct = 'pass'|'shoot'（按住中）· cp = 蓄力值 0~1 · cdir = 松手瞬间的瞄准方向 ·
     *   cspot = 击球点 {sx, sy}（右下角球 UI 的红点，−1~1）。
     *   服务端 tick 的 tryFirstStrike() 每帧判"正前方脚下"，命中就释放。 */
    p.input.ct = (d.ct === 'pass' || d.ct === 'shoot') ? d.ct : null;
    p.input.cp = clamp(typeof d.cp === 'number' ? d.cp : 0, 0, 1);
    if (d.cdir && typeof d.cdir.x === 'number' && typeof d.cdir.z === 'number') {
      const l = Math.hypot(d.cdir.x, d.cdir.z) || 1;
      p.input.kdir = { x: d.cdir.x / l, y: clamp(d.cdir.y || 0, -0.95, 4), z: d.cdir.z / l };
    }
    if (d.cspot) p.input.cspot = readSpot(d.cspot) || p.input.cspot;
    // 跳舞模式：1~9 键切舞段（anim-pick 服务端选动画用）
    //   1~5 = Gangnam Style 切 5 段；6/7 = Hip Hop；8 = Swing；9 = Breakdance
    if (typeof d.dance === 'number' && isFinite(d.dance)) {
      /* 舞段表长度以 shared.js 的 C.DANCES 为准（一舞一键，不再 1~5 共用一段） */
      p.dance = clamp(Math.floor(d.dance), 1, (C.DANCES || []).length || 9);
    }
  });

  // 左键传球 / 右键射门：按住蓄力（力度条），松手才出球；方向与仰角由准星 + 鼠标俯仰决定
  socket.on('kick', (d, ack) => {
    const p = G.players.get(socket.id);
    if (!p) return;
    // 攻击/跳舞模式禁传射：攻击只能出拳带球，跳舞只能跳
    if (p.mode === 'attack' || p.mode === 'dance') { if (typeof ack === 'function') ack({ r: 'mode' }); return; }
    // 死球发球：界外球用手抛球、角球/球门球用普通出球（只有发球方能碰）
    if (G.restart && !G.restart.taken && G.restart.team === p.team) {
      const dist = Math.hypot(p.x - G.ball.x, p.z - G.ball.z);
      if (!p.restartReady) {                       // 还没按 F 进入准备 → 提示先按 F
        if (typeof ack === 'function') ack({ r: 'needF' });
        return;
      }
      if (dist < 2.4) {
        const dir = (d && d.dir) || { x: Math.sin(p.yaw), y: 0, z: Math.cos(p.yaw) };
        const power = clamp((d && typeof d.power === 'number') ? d.power : 0.7, 0, 1);
        const spot = (d && d.spot && typeof d.spot.sx === 'number') ? { sx: clamp(d.spot.sx, -1, 1), sy: clamp(d.spot.sy, -1, 1) } : null;
        takeRestart(p, power, dir, (d && d.type) === 'shoot' ? 'shoot' : 'pass', spot);
        if (typeof ack === 'function') ack({ r: 'restart' });
        return;
      }
    }
    // 守门员抱球在手 → 出球：用专用守门员发球动作
    //   左键 = 滚地发球（gkRoll，低平短传）
    //   右键 = 按蓄力选动作：蓄力短→原地大脚(gkKick)，蓄满→助跑大脚(gkDrop)
    if (p.gkHold && G.ball.owner === p.id) {
      // 只挡"出球动作进行中"的重复按键（p.gkRelease 存在 = 已经起手、等发力时刻放球）。
      // 不再用 gkActCd 挡：接球动作收尾的 0.4s 里玩家按键也该能正常发球（否则感觉"按了没反应"）。
      if (p.gkRelease) {
        if (typeof ack === 'function') ack({ r: 'gkDistBusy' });
        return;
      }
      const dir = (d && d.dir) || { x: Math.sin(p.yaw), z: Math.cos(p.yaw) };
      const pw = clamp((d && typeof d.power === 'number') ? d.power : 0.6, 0, 1);
      let kind;
      if ((d && d.type) !== 'shoot') kind = 'roll';
      else kind = pw > 0.66 ? 'drop' : 'kick';        // 右键蓄满 = 助跑大脚
      gkDistribute(p, kind, null, -ownGoalSign(p.team), dir);
      if (typeof ack === 'function') ack({ r: 'gkDist', kind });
      return;
    }
    // 守门员扑救：禁区内 左键=贴地扑挡 / 右键=飞扑（手上没球时才是扑救）
    if (isKeeper(p) && inOwnBox(p) && G.ball.owner !== p.id) {
      const kind = (d && d.type === 'shoot') ? 'dive' : 'block';
      const power = clamp((d && typeof d.power === 'number') ? d.power : 0.6, 0, 1);
      p.gkManualT = 0;                       // 记下"玩家在手动操作"，自动接球让位
      keeperSave(p, kind, saveSide(p), power);
      if (typeof ack === 'function') ack({ r: 'gk' });
      return;
    }
    const dir = (d && d.dir) || { x: Math.sin(p.yaw), z: Math.cos(p.yaw) };
    const type = (d && d.type) === 'shoot' ? 'shoot' : 'pass';
    const power = clamp((d && typeof d.power === 'number') ? d.power : (type === 'shoot' ? 1 : 0.5), 0, 1);
    /* ★ 击球点（右下角球 UI 红点）：偏心自旋 + 掉力量；持球踢/捅一脚共用 */
    const spot = readSpot(d && d.spot);
    let r;
    if (G.ball.owner === p.id) {
      r = tryKick(p, dir, power, type, spot) ? ('kick:' + type) : 'cd';
    } else {
      const dist = Math.hypot(p.x - G.ball.x, p.z - G.ball.z);
      if (dist <= C.POKE_DIST) r = tryPoke(p, dir, power, type, spot) ? 'poke' : 'cd';
      else r = 'far';
    }
    if (typeof ack === 'function') ack({ r });
  });

  // 攻击模式出拳：左键左勾拳 / 右键右直拳（命中对手有击退+硬直+打掉持球）
  // 客户端进房后查询开关状态
  socket.on('keepersQuery', () => socket.emit('keepersState', { on: G.keepersOn }));
  // AI 机器人开关（全服同步：任何人一按，所有客户端一起变）
  socket.on('botsQuery', () => socket.emit('botsState', { on: G.botsOn }));
  // 射门机器人开关（练习用，全服同步）
  socket.on('shooterQuery', () => socket.emit('shooterState', { on: G.shooterOn }));
  socket.on('shooter', (d) => {
    const p = G.players.get(socket.id);
    if (!p) return;
    setShooter(d && d.on, p.name);
  });
  socket.on('bots', (d) => {
    const p = G.players.get(socket.id);
    if (!p) return;
    setBots(d && d.on, p.name);
  });

  // AI 守门员开关（场上任何人都能切，练习用）
  socket.on('keepers', (d) => {
    const p = G.players.get(socket.id);
    if (!p) return;
    G.keepersOn = !!(d && d.on);
    if (G.keepersOn) { ensureKeeper('A'); ensureKeeper('B'); }
    else removeAiKeepers();
    io.emit('keepersState', { on: G.keepersOn, by: p.name });
    io.emit('chat', { type: 'system', text: `${p.name} ${G.keepersOn ? '开启' : '关闭'}了 AI 守门员` });
  });

  // 属性卡：踢球模式下按数字键使用（一张卡一次）
  socket.on('useCard', (d) => {
    const p = G.players.get(socket.id);
    if (!p) return;
    if (p.mode !== 'soccer' || G.phase !== 'play' || p.downT > 0 || p.upT > 0) {
      socket.emit('cardUse', { ok: false, r: 'state' });
      return;
    }
    const slot = clamp(Math.floor((d && d.slot) || 0), 0, p.cards.length - 1);
    const card = p.cards[slot];
    if (!card || card.spent) { socket.emit('cardUse', { ok: false, r: 'spent' }); return; }
    card.spent = true;
    p.boostT = C.CARD_BOOST_TIME;
    io.emit('cardUsed', { by: p.name, name: card.name, id: card.id, sec: C.CARD_BOOST_TIME, mul: C.CARD_BOOST_MUL });
    socket.emit('cardUse', { ok: true });
  });

  // 守门员锁定防守（E 键）：锁定后自动面向球，左右变成侧步防守
  socket.on('aimLock', (d) => {
    const p = G.players.get(socket.id);
    if (!p) return;
    p.aimLock = !!(d && d.lock) && isKeeper(p);
    socket.emit('aimLockSet', { lock: p.aimLock, ok: p.aimLock === !!(d && d.lock) });
  });

  // 押注（B 键商店）：押 100；押同一项再按一次 = 取消退本
  //   { team:'A'|'B' }        → 红/蓝队胜
  //   { type:'amb', side:'big'|'small' } → 救护车进场 大/小 0.5
  socket.on('bet', (d, ack) => {
    const p = G.players.get(socket.id);
    if (!p) return;
    const amt = C.BET_AMOUNT;
    const reply = (r, extra) => { if (typeof ack === 'function') ack(Object.assign({ r, coins: Math.round(p.coins) }, extra || {})); };

    // ---- 救护车大小盘 ----
    if (d && d.type === 'amb') {
      const side = (d.side === 'big') ? 'big' : ((d.side === 'small') ? 'small' : null);
      if (!side) { reply('bad'); return; }
      if (p.ambBet === side) {
        p.coins += p.ambAmt;
        G.ambPool[side] = Math.max(0, G.ambPool[side] - p.ambAmt);
        p.ambBet = null; p.ambAmt = 0;
        reply('cancel'); pushBetState(); return;
      }
      if (p.ambBet) {                                    // 改押
        p.coins += p.ambAmt;
        G.ambPool[p.ambBet] = Math.max(0, G.ambPool[p.ambBet] - p.ambAmt);
        p.ambBet = null; p.ambAmt = 0;
      }
      if (p.coins < amt) { reply('poor'); pushBetState(); return; }
      p.coins -= amt; p.ambBet = side; p.ambAmt = amt;
      G.ambPool[side] += amt;
      reply('ok', { side });
      pushBetState();
      return;
    }

    // ---- 红蓝队胜 ----
    const team = (d && d.team === 'A') ? 'A' : ((d && d.team === 'B') ? 'B' : null);
    if (!team) { reply('bad'); return; }
    if (p.betTeam === team) {                            // 取消
      p.coins += p.betAmt;
      G.betPool[team] = Math.max(0, G.betPool[team] - p.betAmt);
      p.betTeam = null; p.betAmt = 0;
      reply('cancel'); pushBetState(); return;
    }
    if (p.betTeam) {                                     // 改押：先退旧注
      p.coins += p.betAmt;
      G.betPool[p.betTeam] = Math.max(0, G.betPool[p.betTeam] - p.betAmt);
      p.betTeam = null; p.betAmt = 0;
    }
    if (p.coins < amt) { reply('poor'); pushBetState(); return; }
    p.coins -= amt; p.betTeam = team; p.betAmt = amt;
    G.betPool[team] += amt;
    reply('ok', { team });
    pushBetState();
  });

  socket.on('punch', (d) => {
    const p = G.players.get(socket.id);
    if (!p) return;
    if (p.mode !== 'attack') return;            // 只有攻击模式能出拳
    const r = tryPunch(p, (d && d.hand === 'R') ? 'R' : 'L');
    socket.emit('punchAck', { r });             // 拒绝必回话
  });

  // 攻击模式技能卡（飞踢 / 螺旋踢）：无限使用、各自冷却
  socket.on('skill', (d) => {
    const p = G.players.get(socket.id);
    if (!p) return;
    /* 按模式选卡序：踢球模式 = 花式卡（马赛回旋），攻击模式 = 战斗技能 */
    const order = p.mode === 'soccer' ? (C.SKILL_ORDER_SOCCER || []) : C.SKILL_ORDER;
    if (!order.length) { socket.emit('skillRes', { r: 'bad' }); return; }
    const key = C.SKILL[d && d.key] ? d.key : order[clamp(Math.floor((d && d.slot) || 0), 0, order.length - 1)];
    const r = trySkill(p, key);
    /* noball = 花式动作没持球（马赛回旋要求脚下有球）→ 客户端弹提示，不算成功 */
    socket.emit('skillAck', { key, r, ok: r !== 'cd' && r !== 'busy' && r !== 'down' && r !== 'mode' && r !== 'bad' && r !== 'noball' && r !== 'slide' });
  });

  socket.on('slide', (d) => {
    const p = G.players.get(socket.id);
    if (!p) return;
    const ok = startSlide(p, d && d.dirX, d && d.dirZ);
    socket.emit('slideAck', { ok });          // 拒绝必回话
  });

  socket.on('setMode', (m) => {
    const p = G.players.get(socket.id);
    if (!p) return;
    p.mode = (m === 'attack' || m === 'dance') ? m : 'soccer';
    socket.emit('modeSet', { mode: p.mode });   // 拒绝也回话
  });

  socket.on('chat', (t) => {
    const p = G.players.get(socket.id);
    if (!p) { console.log(`[chat] 丢弃：socket ${socket.id} 没有玩家实体`); return; }
    const text = (t || '').toString().slice(0, 80);
    if (!text) return;
    io.emit('chat', { type: 'user', name: p.name, team: p.team, text });
    console.log(`[chat] ${p.name}: ${text}`);
  });

  /* ★ 庆祝语音（进球）：消耗一次"进球奖励次数"，发给 **30m 内**的所有人。
   *   · 次数来自进球（每球每人 +1，见 doGoal），随 dto 下发到客户端
   *   · 服务端只做**次数校验 + 范围过滤**，音量衰减交给客户端（有距离值）
   *   · AI 不播（它们没有音频），但真人玩家不论敌我都会听到 —— 这是"全场庆祝"的语义 */
  socket.on('cheer', (d) => {
    const p = G.players.get(socket.id);
    if (!p || p.dead || p.dying) return;
    if (!(p.cheer > 0)) { socket.emit('cheerNone', {}); return; }
    p.cheer--;
    const clip = (d && typeof d.clip === 'string' && /^[a-z0-9_-]{1,24}$/.test(d.clip)) ? d.clip : 'cheer-1';
    const R = 30;
    for (const q of G.players.values()) {
      if (!q || q.bot || q.id === p.id) continue;
      const dist = Math.hypot(q.x - p.x, q.z - p.z);
      if (dist > R) continue;
      io.to(q.id).emit('cheerIn', { by: p.name, id: p.id, clip, dist: +dist.toFixed(1) });
    }
    // 自己也播（distance 0）
    socket.emit('cheerIn', { by: p.name, id: p.id, clip, dist: 0, self: true });
    socket.emit('cheerLeft', { left: p.cheer });
  });

  socket.on('pingCheck', (t, ack) => { if (typeof ack === 'function') ack(t); });

  socket.on('disconnect', () => {
    const p = G.players.get(socket.id);
    if (G.ball.owner === socket.id) { G.ball.owner = null; }
    // 断线要释放门将槽位，否则空位被别人占着没人能当门将（随后 AI 补位）
    if (p && G.keeper[p.team] === socket.id) { G.keeper[p.team] = null; ensureKeeper(p.team); }
    // 断线退还本局押注（否则彩池里会留"幽灵钱"，把赔率算歪）
    if (p && p.betTeam) {
      G.betPool[p.betTeam] = Math.max(0, G.betPool[p.betTeam] - p.betAmt);
      p.betTeam = null; p.betAmt = 0;
      pushBetState();
    }
    if (p && p.ambBet) {                                // 救护车盘也要退（否则彩池留幽灵钱）
      G.ambPool[p.ambBet] = Math.max(0, G.ambPool[p.ambBet] - p.ambAmt);
      p.ambBet = null; p.ambAmt = 0;
      pushBetState();
    }
    G.players.delete(socket.id);
  
    if (p) io.emit('chat', { type: 'system', text: `${p.name} 离开了` });
    io.emit('playerLeft', { id: socket.id });
  });
});

setInterval(tick, 1000 / C.TICK_HZ);

/* ★★ 可选 HTTPS 反向代理（只为一件事：**让浏览器允许语音**）
 *
 *   Chrome/Edge 规定 `navigator.mediaDevices` 只在**安全上下文**（https 或 localhost）
 *   下存在。线上用 `http://IP:3000` 打开时它是 undefined → 语音功能不可用（文字聊天不受影响）。
 *   nginx/certbot 不可用，所以这里起一个**极简 https 代理**转发到本机的 3000：
 *     · 普通请求 → http.request 透传
 *     · WebSocket upgrade → 手工建隧道（socket.io 用 websocket transport）
 *   证书是自签的，浏览器首次会警告一次（高级 → 继续访问 即可）。
 *   开关：环境变量 HTTPS_PORT=3443（不设就不开）。
 */
if (Number(process.env.HTTPS_PORT) > 0) {
  const SP = Number(process.env.HTTPS_PORT);
  const certDir = process.env.TLS_DIR || path.join(ROOT, 'cert');
  const crtF = path.join(certDir, 'cert.pem'), keyF = path.join(certDir, 'key.pem');
  if (fs.existsSync(crtF) && fs.existsSync(keyF)) {
    const opts = { cert: fs.readFileSync(crtF), key: fs.readFileSync(keyF) };
    const proxy = https.createServer(opts, (req, res) => {
      const pr = http.request({
        hostname: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers: req.headers,
      }, (pres) => {
        res.writeHead(pres.statusCode || 502, pres.headers);
        pres.pipe(res);
      });
      pr.on('error', () => { try { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('bad gateway'); } catch (e) {} });
      req.pipe(pr);
    });
    /* WebSocket（socket.io 用 websocket transport）必须**原样 TCP 隧道**：
     *   ★ 踩过：用 `http.request` + 手工拼 101 响应 → socket.io 一直连不上
     *     （连接超时，net 一直显示 "-- ms"）。原因是 upgrade 握手对 header 顺序/原样
     *     转发很敏感，手拼容易漏 `Sec-WebSocket-Accept` 之类的细节。
     *   这里直接把**原始请求行 + rawHeaders** 写进后端 TCP，让后端自己回 101，
     *   之后两边字节流转发即可。 */
    proxy.on('upgrade', (req, sock, head) => {
      const psock = net.connect(PORT, '127.0.0.1', () => {
        try {
          psock.write(`${req.method || 'GET'} ${req.url} HTTP/1.1\r\n`);
          const rh = req.rawHeaders || [];
          for (let i = 0; i < rh.length; i += 2) psock.write(`${rh[i]}: ${rh[i + 1]}\r\n`);
          psock.write('\r\n');
          if (head && head.length) psock.write(head);
        } catch (e) { psock.destroy(); sock.destroy(); return; }
        psock.pipe(sock); sock.pipe(psock);
      });
      psock.on('error', () => { try { sock.destroy(); } catch (e) {} });
      sock.on('error', () => { try { psock.destroy(); } catch (e) {} });
    });
    proxy.listen(SP, () => console.log(`[https] 自签 HTTPS 代理已启动 :${SP}（语音需要它）`));
  } else {
    console.log(`[https] 没找到证书 ${crtF} / ${keyF}，跳过 HTTPS（语音在 http 下不可用）`);
  }
}

/* ★ WebSocket 长连接友好：Node 默认 keepAliveTimeout=5 秒，被网关/云负载均衡
   转发时空闲超时会把连接掐断（表现为"开局几秒后掉线"）。放宽到 15 分钟。 */
server.keepAliveTimeout = 15 * 60 * 1000;
server.headersTimeout = 15 * 60 * 1000 + 5000;
server.requestTimeout = 0;
server.on('connection', (s) => { s.setTimeout(0); s.setNoDelay(true); });

server.listen(PORT, () => {
  /* BOTS 默认关：云端 CPU 弱，开局就建世界+跑机器人会让静态请求排队，
     表现为「进游戏一直正在载入」。需要靶子时用 BOTS=1 打开。 */
  if (process.env.BOTS === '1') spawnTrainingBots();

  /* 压缩预热默认关：云端压 8MB 模型会长时间占满 CPU，
     期间所有静态请求（含 style.css）都会被拖到超时。
     改成按需压：只有真的被请求过、且空闲时才压。 */
  if (process.env.PREWARM === '1') {
    const t0 = Date.now();
    let n = 0, bytes = 0;
    const prewarm = [
      ...Object.values(MODEL_FILES).map(([d, f]) => path.join(ROOT, d, f)),
      ...Object.values(LIB_FILES).map(([pkg, rel]) => path.join(NM, pkg, rel)),
    ].filter(f => fs.existsSync(f) && !compCache.has(f));
    const step = () => {
      const full = prewarm.shift();
      if (!full) {
        console.log(`[足球] 压缩预热完成：${n} 个文件 ${(bytes / 1048576).toFixed(1)}MB，耗时 ${Date.now() - t0}ms`);
        return;
      }
      let size = 0;
      try { size = fs.statSync(full).size; } catch (e) {}
      ensureCompressed(full).then(() => {
        bytes += size; n++;
        setTimeout(step, 120);
      }).catch(() => setTimeout(step, 120));
    };
    setTimeout(step, 1500);
  }

  console.log(`[足球] 服务器已启动  http://localhost:${PORT}`);
});
