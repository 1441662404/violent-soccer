function clampRate(r) { return Math.max(0.5, Math.min(2, r || 1)); }

/* ============================================================
 *  音效 + 解说（全部现场合成，不依赖任何音频素材）
 *  - 音效：Web Audio 合成（哨声 / 踢球 / 进球欢呼 / 出拳 / 观众环境声 / 扑救）
 *  - 解说：用浏览器语音合成（speechSynthesis）念实况解说词，带节流防重叠
 *  浏览器自动播放策略要求用户手势后才能出声 → unlock() 在点击进入球场时调用
 * ============================================================ */
/* 真实音效素材（来自 sounddino.com 免费足球音效包，可商用） */
const SFX = {
  kick: 'audio/kick.mp3',        // 踢球
  net: 'audio/net.mp3',          // 球打网
  catch: 'audio/catch.mp3',      // 门将接球
  crowd: 'audio/crowd.mp3',      // 看台（长循环）
  goal: 'audio/goal.mp3',        // 进球欢呼
  miss: 'audio/miss.mp3',        // 射失的叹息
  chant: 'audio/chant.mp3',      // 球迷助威
  whistle: 'audio/whistle.mp3',  // 哨声
  applause: 'audio/applause.mp3',// 掌声
  thud: 'audio/thud.mp3',        // 身体碰撞
  announce: 'audio/announce.mp3',// 现场播报（真人）
};

/* ------------------------------------------------------------------
 *  真人解说素材 v2（FM23 BASIC SOUND PACK，精选 37 类 / 257 段 / 22kHz 单声道 mp3）
 *
 *  ★ 用户需求 & 对应做法：
 *    · "里面的语音应该尽量多用" → 从源包 2710 个 wav 里精选出**覆盖 37 类比赛事件**的片段，
 *      每类 3~10 段随机播（见 build-fm2.mjs 的类别表）。
 *    · "转化为最低的内存这样就可以用多点了" → 全部压成 24kbps / 22.05kHz / 单声道，
 *      整包只有 3.77MB（源包 1.1GB，压掉 99.7%），这才敢一次挂 257 段。
 *    · "语音绑定好事件活动不要空响" → 键名就是游戏事件名，客户端每个事件都真的绑了一条；
 *      build-fm2.mjs 会校验"每类都必须匹配到真实素材"，源包里的空 wav 也被滤掉了。
 *
 *  文件：/audio/fm2/<类别><序号>.mp3（序号从 1 开始），清单见 /audio/fm2/manifest.json
 * ------------------------------------------------------------------ */
const FM2_DIR = 'audio/fm2/';
const COMM2 = {
  goal: 10, goalBig: 8, goalConcede: 4,
  save: 10, saveHold: 10, savePunch: 8, keeperThrow: 6,
  corner: 8, throwIn: 6, goalKick: 5, freeKick: 6, offside: 4, penalty: 6,
  shot: 10, shotPower: 8, shotPost: 6, shotBlocked: 6, header: 10, cross: 8,
  tackle: 10, foul: 8, card: 6, interception: 6, clearance: 8,
  pass: 10, through: 8, counter: 6, dribble: 8, buildup: 8,
  crowdCheer: 8, crowdOoh: 6, crowdSing: 3,
  ref: 6, whistle: 3, kickoff: 6, fullTime: 5, var: 3,
};

/**
 * 事件 → 语音序列。每个元素 { c: 类别, d: 起播延迟(s), v: 音量, r: 语速 }
 * 第一段的 d=0；后段是"叠加"或"紧跟"，用来做真实的转播层次：
 *   进球 = 看台先炸 + 解说员喊 GOAL + 1.1s 后再补一句"比分改写"
 *   （单句解说会显得又空又假，叠起来才像转播）
 */
const EVENT_SEQ = {
  goal:        [{ c: 'crowdCheer', v: 0.5 }, { c: 'goal', v: 0.95 }, { c: 'crowdCheer', d: 1.1, v: 0.34, r: 1.05 }],
  goalBig:     [{ c: 'crowdCheer', v: 0.55 }, { c: 'goalBig', v: 0.95 }, { c: 'goal', d: 1.3, v: 0.6 }],
  goalConcede: [{ c: 'goalConcede', v: 0.85 }, { c: 'crowdOoh', d: 0.5, v: 0.34 }],
  saveHold:    [{ c: 'saveHold', v: 0.9 }, { c: 'crowdCheer', d: 0.7, v: 0.3 }],
  savePunch:   [{ c: 'savePunch', v: 0.9 }],
  saveMiss:    [{ c: 'save', v: 0.85 }, { c: 'crowdOoh', d: 0.8, v: 0.3 }],
  keeperThrow: [{ c: 'keeperThrow', v: 0.8 }],
  corner:      [{ c: 'corner', v: 0.85 }],
  throwIn:     [{ c: 'throwIn', v: 0.8 }],
  goalKick:    [{ c: 'goalKick', v: 0.85 }, { c: 'crowdOoh', d: 0.6, v: 0.26 }],
  freeKick:    [{ c: 'freeKick', v: 0.85 }],
  offside:     [{ c: 'offside', v: 0.85 }, { c: 'crowdOoh', d: 0.7, v: 0.3 }],
  penalty:     [{ c: 'penalty', v: 0.9 }],
  shotPower:   [{ c: 'shotPower', v: 0.9 }],
  shot:        [{ c: 'shot', v: 0.85 }],
  shotPost:    [{ c: 'shotPost', v: 0.9 }, { c: 'crowdOoh', d: 0.5, v: 0.36 }],
  shotBlocked: [{ c: 'shotBlocked', v: 0.85 }],
  header:      [{ c: 'header', v: 0.85 }],
  cross:       [{ c: 'cross', v: 0.8 }],
  tackle:      [{ c: 'tackle', v: 0.85 }],
  ko:          [{ c: 'tackle', v: 0.9 }, { c: 'crowdOoh', d: 0.5, v: 0.3 }],
  foul:        [{ c: 'foul', v: 0.85 }, { c: 'ref', d: 0.9, v: 0.7 }],
  card:        [{ c: 'card', v: 0.9 }, { c: 'crowdOoh', d: 0.7, v: 0.28 }],
  interception:[{ c: 'interception', v: 0.8 }],
  clearance:   [{ c: 'clearance', v: 0.8 }],
  pass:        [{ c: 'pass', v: 0.75 }],
  through:     [{ c: 'through', v: 0.85 }],
  counter:     [{ c: 'counter', v: 0.85 }],
  dribble:     [{ c: 'dribble', v: 0.82 }],
  buildup:     [{ c: 'buildup', v: 0.75 }],
  crowdCheer:  [{ c: 'crowdCheer', v: 0.4 }],
  crowdOoh:    [{ c: 'crowdOoh', v: 0.4 }],
  crowdSing:   [{ c: 'crowdSing', v: 0.26 }],
  ref:         [{ c: 'ref', v: 0.75 }],
  whistle:     [{ c: 'whistle', v: 0.7 }],
  kickoff:     [{ c: 'kickoff', v: 0.9 }, { c: 'crowdCheer', d: 0.8, v: 0.3 }],
  newMatch:    [{ c: 'kickoff', v: 0.9 }],
  fullTime:    [{ c: 'fullTime', v: 0.92 }, { c: 'crowdCheer', d: 1.2, v: 0.34 }],
  var:         [{ c: 'var', v: 0.85 }],
};
/* 没配序列的老分类 → 直接借一个最接近的 */
const COMM_ALIAS = { keeper: 'ref', save: 'saveMiss', saveMiss: 'saveMiss', card: 'card' };

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.volume = 0.75;
    this.crowdOn = false;
    this._lastSay = 0;
    this._sayQueue = [];
    this._speaking = false;
    this._voice = null;
    this._lastComm = {};     // 解说分类冷却
    this._comm = null;       // 正在播的解说（新的会压住旧的）
    this._bufs = {};         // 采样缓存（decodeAudioData）
    this._loops = {};        // 循环音（看台）
    this._ambT = 0;          // 环境音调度计时
    this._ambPlaying = 0;    // 正在播的看台/合唱片段数（避免叠太多）
    try { this.enabled = localStorage.getItem('audioOff') !== '1'; } catch (e) {}
  }

  unlock() {
    if (!this.enabled) return;
    const ctx = this._ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume();
    this._pickVoice();
    // 部分浏览器音色列表是异步就绪的，就绪后再挑一次
    if (window.speechSynthesis && !this._voiceBound) {
      this._voiceBound = true;
      speechSynthesis.onvoiceschanged = () => { this._voice = null; this._pickVoice(); };
    }
  }

  setEnabled(on) {
    this.enabled = on;
    try { localStorage.setItem('audioOff', on ? '0' : '1'); } catch (e) {}
    if (this.master) this.master.gain.value = on ? this.volume : 0;
    if (!on && this.ctx) this.ctx.suspend();
    if (on) { this.unlock(); this.crowd(0.5); }
  }

  _ensure() {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.enabled = false; return null; }
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this._noiseBuf = this._makeNoise(2.0);
    }
    return this.ctx;
  }

  _makeNoise(sec) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** 一段噪声（可选带通/低通），返回 {src, gain} */
  _noise(dur, freq, q, type = 'bandpass') {
    const ctx = this._ensure();
    if (!ctx) return null;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = freq;
    if (q) flt.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(flt); flt.connect(g); g.connect(this.master);
    src.start();
    src.stop(ctx.currentTime + dur + 0.05);
    return { src, gain: g, flt };
  }

  _tone(freq, dur, type = 'sine', vol = 0.25, delay = 0, glideTo = null) {
    const ctx = this._ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.02, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  /* ---------------- 真实采样 ---------------- */
  /** 按 URL 拉一个音频并解码缓存（name 是缓存键） */
  async _bufUrl(name, url) {
    if (this._bufs[name] !== undefined) return this._bufs[name];
    const ctx = this._ensure();
    if (!ctx || !url) { this._bufs[name] = null; return null; }
    this._bufs[name] = null;                       // 先占位，避免并发重复拉
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);
      const ab = await r.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      this._bufs[name] = buf;
      return buf;
    } catch (e) { console.warn('[音效] 加载失败', name, e.message); return null; }
  }

  async _buf(name) {
    if (!SFX[name]) { this._bufs[name] = null; return null; }
    return this._bufUrl(name, SFX[name]);
  }

  /** 播一个采样（rate 可变调，用来区分力度） */
  async sfx(name, { vol = 0.8, rate = 1, delay = 0 } = {}) {
    const ctx = this._ensure();
    if (!ctx) return false;
    const buf = await this._buf(name);
    if (!buf) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = clampRate(rate);
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g); g.connect(this.master);
    src.start(ctx.currentTime + delay);
    return true;
  }

  /** 循环播放（看台环境声） */
  async loopSfx(name, vol = 0.3) {
    const ctx = this._ensure();
    if (!ctx || this._loops[name]) return !!this._loops[name];
    const buf = await this._buf(name);
    if (!buf) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(g); g.connect(this.master);
    src.start();
    this._loops[name] = { src, gain: g };
    return true;
  }

  setLoopVol(name, v) {
    const l = this._loops[name];
    if (l) l.gain.gain.value = v;
  }

  /** 环境音调度：偶尔来一段球迷助威 / 现场播报，别一直响
   *  ★ 用户要求"语音尽量多用" → 环境音也换成 FM23 的真实看台录音
   *    （原来用的 chanting/applause 是免费音效包，和 FM 素材的质感不统一） */
  ambient(dt) {
    if (!this.enabled) return;
    this._ambT += dt;
    if (this._ambPlaying > 0) return;                    // 上一段看台还在放，别叠
    if (this._ambT > 22 + Math.random() * 26) {
      this._ambT = 0;
      const pick = Math.random();
      if (pick < 0.45) this.fm('crowdSing', { vol: 0.22, cd: 0 });
      else if (pick < 0.75) this.fm('crowdCheer', { vol: 0.26, cd: 0 });
      else if (pick < 0.9) this.fm('crowdOoh', { vol: 0.24, cd: 0 });
      else this.sfx('announce', { vol: 0.3 });
    }
  }

  /* ---------------- 音效 ---------------- */

  /** 踢球：真实采样（力度越大越响越脆），失败时退回合成 */
  kick(power = 1) {
    const p = Math.max(0.25, Math.min(1, power));
    this.sfx('kick', { vol: 0.35 + 0.5 * p, rate: 0.92 + 0.22 * p }).then(ok => { if (!ok) this._kickSynth(p); });
  }
  _kickSynth(power = 1) {
    const ctx = this._ensure();
    if (!ctx) return;
    const p = Math.max(0.25, Math.min(1, power));
    this._tone(110 + 40 * p, 0.16, 'sine', 0.35 * p, 0, 55);
    const n = this._noise(0.12, 1200 + 900 * p, 0.7);
    if (!n) return;
    const t = ctx.currentTime;
    n.gain.gain.setValueAtTime(0.0001, t);
    n.gain.gain.exponentialRampToValueAtTime(0.3 * p, t + 0.008);
    n.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
  }

  /** 裁判哨：优先真实哨声 */
  whistle(long = false) {
    this.sfx('whistle', { vol: long ? 0.75 : 0.6, rate: long ? 1 : 1.05 }).then(ok => { if (!ok) this._whistleSynth(long); });
  }
  _whistleSynth(long = false) {
    const ctx = this._ensure();
    if (!ctx) return;
    const dur = long ? 0.85 : 0.32;
    for (const f of [2050, 2130]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const g = ctx.createGain();
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.075, t + 0.02);
      g.gain.setValueAtTime(0.075, t + dur - 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + dur + 0.02);
    }
  }

  /** 进球：球网 + 全场欢呼 + 掌声 */
  goal() {
    this.sfx('net', { vol: 0.7 });
    this.sfx('goal', { vol: 0.85 });
    this.sfx('applause', { vol: 0.5, delay: 0.2 });
    this.whistle(true);
    this.setLoopVol('crowd', 0.5);
    setTimeout(() => this.setLoopVol('crowd', 0.3), 4200);
  }
  _goalSynth() {
    const ctx = this._ensure();
    if (!ctx) return;
    this.whistle(true);
    const n = this._noise(2.4, 900, 0.6);
    if (n) {
      const t = ctx.currentTime;
      n.gain.gain.setValueAtTime(0.0001, t);
      n.gain.gain.exponentialRampToValueAtTime(0.34, t + 0.35);
      n.gain.gain.exponentialRampToValueAtTime(0.2, t + 1.5);
      n.gain.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    }
    [523, 659, 784, 1047].forEach((f, i) => this._tone(f, 0.42, 'triangle', 0.22, 0.1 + i * 0.12));
  }

  /** 观众惋惜（球门球/偏出）：一阵"哦——" */
  moan() {
    const n = this._noise(1.2, 500, 0.8, 'lowpass');
    const ctx = this._ensure();
    if (!n || !ctx) return;
    const t = ctx.currentTime;
    n.gain.gain.setValueAtTime(0.0001, t);
    n.gain.gain.exponentialRampToValueAtTime(0.22, t + 0.2);
    n.gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
  }

  /** 出拳 / 碰撞：真实身体碰撞声 */
  punch() {
    this.sfx('thud', { vol: 0.6, rate: 1.0 + Math.random() * 0.15 }).then(ok => { if (!ok) this._punchSynth(); });
  }
  /** 射失：看台一阵叹息 */
  sad() { this.sfx('miss', { vol: 0.55 }); }
  _punchSynth() {
    const ctx = this._ensure();
    if (!ctx) return;
    this._tone(90, 0.14, 'sine', 0.4, 0, 45);
    const n = this._noise(0.1, 700, 0.9);
    if (!n) return;
    const t = ctx.currentTime;
    n.gain.gain.setValueAtTime(0.0001, t);
    n.gain.gain.exponentialRampToValueAtTime(0.26, t + 0.005);
    n.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
  }

  /** 扑救：真实门将接球声 + 掌声 */
  save() {
    this.sfx('catch', { vol: 0.75 });
    this.sfx('applause', { vol: 0.34, delay: 0.15 });
  }
  _saveSynth() {
    const ctx = this._ensure();
    if (!ctx) return;
    const n = this._noise(0.5, 1800, 0.5);
    if (n) {
      const t = ctx.currentTime;
      n.gain.gain.setValueAtTime(0.0001, t);
      n.gain.gain.exponentialRampToValueAtTime(0.24, t + 0.03);
      n.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    }
    this._tone(300, 0.25, 'triangle', 0.12, 0, 520);
  }

  /** 观众环境声：优先真实看台录音循环 */
  crowd(level = 0.5) {
    if (this.crowdOn) return;
    this.crowdOn = true;
    this.loopSfx('crowd', 0.28 * level).then(ok => { if (!ok) { this.crowdOn = false; this._crowdSynth(level); } });
  }
  _crowdSynth(level = 0.5) {
    const ctx = this._ensure();
    if (!ctx || this.crowdOn) return;
    const n = this._noise(6, 700, 0.35, 'lowpass');
    if (!n) return;
    n.gain.gain.value = 0.05 * level;
    this._crowdGain = n.gain;
    this.crowdOn = true;
    // 缓慢起伏，像看台人声
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.12;
    const lg = ctx.createGain();
    lg.gain.value = 0.02 * level;
    lfo.connect(lg); lg.connect(n.gain.gain);
    lfo.start();
  }

  crowdCheer(amount = 0.25) {
    if (this._loops.crowd) {                    // 真实看台：抬音量 + 一段欢呼
      this.setLoopVol('crowd', Math.max(0.3, amount * 1.6));
      setTimeout(() => this.setLoopVol('crowd', 0.3), 2600);
      this.sfx('goal', { vol: Math.min(0.7, amount * 2) });
      return;
    }
    this._crowdCheerSynth(amount);
  }
  _crowdCheerSynth(amount = 0.25) {
    const ctx = this._ensure();
    if (!ctx || !this._crowdGain) { this.crowd(); return; }
    const t = ctx.currentTime;
    const g = this._crowdGain.gain;
    const now = g.value;
    g.cancelScheduledValues(t);
    g.setValueAtTime(now, t);
    g.linearRampToValueAtTime(amount, t + 0.4);
    g.linearRampToValueAtTime(0.05, t + 3.2);
  }

  /* ---------------- 解说 ---------------- */

  /**
   * 直接播一条 FM2 语音（不经解说引擎）—— 给"只想要一条口语"的事件用
   * （例：发界外球、门将抛球、裁判哨后的一句提示）。
   * cat 必须是 COMM2 里的键；会走 ACC 的同类冷却（cd 毫秒）避免刷屏。
   */
  fm(cat, { vol = 0.85, rate = 1, cd = 2200, delay = 0 } = {}) {
    if (!this.enabled) return false;
    const n = COMM2[cat];
    if (!n) return false;
    const now = performance.now();
    const k = 'fm_' + cat;
    if (now - (this._lastComm[k] || 0) < cd) return false;
    this._lastComm[k] = now;
    const i = 1 + ((Math.random() * n) | 0);
    if (delay) setTimeout(() => this._playComm(cat, i, vol, rate), delay * 1000);
    else this._playComm(cat, i, vol, rate);
    return true;
  }

  /** 选一条 FM2 语音（不播），返回 [cat, i] —— 供需要自己调度的场合 */
  fmPick(cat) {
    const n = COMM2[cat];
    if (!n) return null;
    return [cat, 1 + ((Math.random() * n) | 0)];
  }

  /** 挑一个最像解说员的中文音色：优先男声（云希/云扬/康康…），其次任意中文 */
  _pickVoice() {
    if (!window.speechSynthesis) return null;
    const vs = speechSynthesis.getVoices() || [];
    if (!vs.length) return this._voice;
    const zh = vs.filter(v => /^zh(-|_)?(CN|Hans)?/i.test(v.lang));
    const pool = zh.length ? zh : vs;
    const male = /yunxi|云希|yunyang|云扬|kangkang|康康|male|男/i;
    const broadcast = /news|解说|comment|premium|natural|enhanced|siri|xiaoyi|xiaoai/i;
    const score = (v) => (male.test(v.name) ? 2 : 0) + (broadcast.test(v.name) ? 3 : 0)
      + (/zh[-_]?CN/i.test(v.lang) ? 2 : 0) + (v.localService ? 0 : 1);
    pool.sort((a, b) => score(b) - score(a));
    this._voice = pool[0] || null;
    return this._voice;
  }

  /** 真人解说：按事件播对应的**语音序列**（可叠加看台/多句，新的压住旧的） */
  commentary(cat, { force = false, vol = 0.9, rate = 1 } = {}) {
    if (!this.enabled) return false;
    const key = COMM_ALIAS[cat] || cat;
    const seq = EVENT_SEQ[key];
    if (!seq) return false;
    const now = performance.now();
    if (!force && now - (this._lastComm[key] || 0) < 1600) return false;   // 同类冷却
    this._lastComm[key] = now;
    for (const step of seq) {
      const n = COMM2[step.c];
      if (!n) continue;                                   // 没素材的分类跳过（不会空响）
      const i = 1 + ((Math.random() * n) | 0);
      const v = (step.v != null ? step.v : 0.9) * (vol / 0.9);
      const r = (step.r != null ? step.r : 1) * rate;
      if (step.d) setTimeout(() => this._playComm(step.c, i, v, r), step.d * 1000);
      else this._playComm(step.c, i, v, r);
    }
    return true;
  }

  async _playComm(cat, i, vol, rate) {
    const ctx = this._ensure();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const name = 'f2_' + cat + i;
    const buf = await this._bufUrl(name, FM2_DIR + cat + i + '.mp3');
    if (!buf) return;
    /* 看台/合唱类不参与"压住上一条"—— 它们本来就是背景；而且长度几十秒，
     * 被 stop 掉反而会突然断。只有口播解说才做互斥。 */
    const isAmbient = cat.startsWith('crowd');
    if (!isAmbient) this._stopComm();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = clampRate(rate);
    const g = ctx.createGain();
    // 短促淡入淡出：避免 mp3 首尾的爆音（转播里这些突然的"啪"很出戏）
    const t0 = ctx.currentTime + 0.01;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), t0 + 0.02);
    const dur = buf.duration / clampRate(rate);
    g.gain.setValueAtTime(Math.max(0.001, vol), t0 + Math.max(0.05, dur - 0.06));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(g); g.connect(this.master);
    src.start(t0);
    if (!isAmbient) {
      this._comm = { src, g };
      src.onended = () => { if (this._comm && this._comm.src === src) this._comm = null; };
    } else {
      this._ambPlaying = (this._ambPlaying || 0) + 1;
      src.onended = () => { this._ambPlaying = Math.max(0, (this._ambPlaying || 1) - 1); };
    }
    // 解说时把看台声抬一点（像现场）
    if (this._crowdGain) {
      const gg = this._crowdGain.gain;
      const now = gg.value;
      gg.cancelScheduledValues(t0); gg.setValueAtTime(now, t0);
      gg.linearRampToValueAtTime(Math.max(now, 0.11), t0 + 0.3);
      gg.linearRampToValueAtTime(0.05, t0 + 3.0);
    }
  }

  _stopComm() {
    const c = this._comm;
    this._comm = null;
    if (!c) return;
    try { c.src.stop(); } catch (e) {}
  }

  /**
   * 预热解说素材。
   * ★ 内存优化：看台/合唱类片段长达 20~40s，解码成 float32 后一个就 3~4MB
   *   （22kHz 单声道 × 4 字节 × 40s），全预载会白吃十几 MB。
   *   所以默认**只预热口播类**（都在 7s 内、每个才 0.3MB），看台类首次用时再拉
   *   —— 反正它们都有 40s 冷却、且是低音量的背景，首次延迟几百毫秒听不出来。
   * only: 只预热这些类别（不传 = 全部口播类）
   */
  preloadCommentary(only = null) {
    const AMBIENT = ['crowdSing', 'crowdCheer', 'crowdOoh'];
    const list = [];
    for (const [cat, n] of Object.entries(COMM2)) {
      if (only) { if (!only.includes(cat)) continue; }
      else if (AMBIENT.includes(cat)) continue;              // 跳过超长看台片段
      for (let i = 1; i <= n; i++) list.push([cat, i]);
    }
    let k = 0;
    const next = () => {
      if (k >= list.length || !this.enabled) return;
      const [cat, i] = list[k++];
      this._bufUrl('f2_' + cat + i, FM2_DIR + cat + i + '.mp3').then(() => setTimeout(next, 40));
    };
    next();
  }

  /** 保留：系统提示音（不是解说）还是用浏览器语音合成念一句 */
  say(text, { force = false, rate = 1.24, pitch = 0.92 } = {}) {
    if (!this.enabled || !window.speechSynthesis) return;
    const now = performance.now();
    if (!force && now - this._lastSay < 900) return;      // 节流
    this._lastSay = now;
    try {
      this._pickVoice();
      speechSynthesis.cancel();                            // 实况解说：新的压住旧的
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      if (this._voice) u.voice = this._voice;
      // 解说员口吻：语速偏快、音高压低一点（更厚实），音量拉满
      u.rate = rate; u.pitch = pitch; u.volume = 1.0;
      if (this._crowdGain && this.ctx) {                   // 解说时看台声音往上抬一点，像现场
        const t = this.ctx.currentTime, g = this._crowdGain.gain;
        const now = g.value;
        g.cancelScheduledValues(t); g.setValueAtTime(now, t);
        g.linearRampToValueAtTime(Math.max(now, 0.11), t + 0.3);
        g.linearRampToValueAtTime(0.05, t + 3.0);
      }
      speechSynthesis.speak(u);
    } catch (e) {}
  }
}

export const audio = new GameAudio();
