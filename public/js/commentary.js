/* ============================================================
 *  解说引擎（实况足球式逻辑）
 *  - 事件分级：进球/终场等高优先级会打断低优先级
 *  - 每类事件多套台词随机挑，避免复读；台词里带球员/球队名（作为字幕保留）
 *  - 发声用 FM23 真人解说素材（audio.commentary / audio.fm），不再走浏览器 TTS
 *  - ★ 2026-10 换用精选的 37 类 / 257 段 FM2 素材（build-fm2.mjs 生成），
 *    事件从 16 类扩到 30+ 类；同一事件可叠多句 + 看台声（由 audio.js 的 EVENT_SEQ 调度）
 *  - 带冷却，避免连续刷屏（实况解说不会每一下都喊）
 * ============================================================ */
const rnd = (a) => a[(Math.random() * a.length) | 0];

/* 台词表（作为字幕/调试用；发声走 FM2 素材）。
 * cat 键必须和 audio.js 的 COMM2 / EVENT_SEQ 对齐，否则会"绑了没声"。 */
export const LINES = {
  goal: [
    (c) => `${c.by || '这一脚'}！球进了！${c.team}取得进球！`,
    (c) => `进了进了进了！${c.by || ''}把球送进网窝！${c.team}领先了！`,
    (c) => `${c.by || '射门'}！太漂亮了！皮球应声入网！`,
    (c) => `球进啦！${c.team}的进攻终于开花结果！`,
  ],
  goalBig: [
    (c) => `世界波！${c.by || ''}这一脚足以载入史册！${c.team}打出气势！`,
    (c) => `关键时刻！${c.team}顶住压力扳平/反超！`,
  ],
  goalConcede: [
    (c) => `${c.team}丢球了！后防线出现了明显的漏洞。`,
    (c) => `这个球丢得太轻易了，${c.team}必须马上调整。`,
  ],
  save: [(c) => `${c.by}！精彩的扑救！`, (c) => `被扑出来了！${c.by}反应太快了！`],
  saveHold: [(c) => `${c.by}把球稳稳抱住了！门线前的最后一道关！`],
  savePunch: [(c) => `${c.by}单拳把球打出去！处理得很果断！`],
  saveMiss: [(c) => `${c.by}扑了一下！球脱手了！危险！`, (c) => `${c.by}扑到了但没抱住！`],
  keeperThrow: [(c) => `${c.by}手抛球发动进攻，快攻的机会！`],
  corner: [(c) => `角球！${c.team}的机会来了！`, (c) => `球出底线，角球！${c.team}获得一次定位球机会。`],
  throwIn: [(c) => `球出边线，${c.team}的界外球。`, (c) => `${c.team}掷界外球，比赛继续。`],
  goalKick: [(c) => `打偏了！这一脚差之毫厘，${c.team}球门球。`],
  freeKick: [(c) => `${c.team}获得任意球，位置不错！`],
  offside: [(c) => `越位了！边裁举旗，${c.team}这次进攻被吹停。`],
  penalty: [(c) => `点球！裁判指向十二码点，${c.team}的绝佳机会！`],
  shot: ['射门！', '起脚打门！', '打门！', '这一脚力量很足！'],
  shotPower: ['大力抽射！', '这一脚轰出去了！'],
  shotPost: [(c) => `中柱了！${c.by || ''}就差一点点！`, '打门柱上了！'],
  shotBlocked: ['被挡出来了！防守球员用身体封堵！'],
  header: ['头球攻门！', '抢到落点顶了一下！'],
  cross: ['传中送到门前！', '边路起球！'],
  tackle: [(c) => `${c.by}这一铲够狠！${c.victim}被放倒了！`, (c) => `身体对抗！${c.victim}被铲翻在地！`],
  ko: [(c) => `KO！${c.by}把${c.victim}直接放倒！这一下太重了！`],
  foul: [(c) => `犯规！裁判鸣哨，${c.team}获得任意球。`],
  card: [(c) => `${c.by}吃到一张牌！动作太大了。`],
  interception: [(c) => `${c.by || ''}把球拦下来了！读球很快！`],
  clearance: [(c) => `${c.by || ''}大脚解围，把危险清除掉。`],
  pass: ['传球。', '转移到边路。', '中场做球。'],
  through: [(c) => `${c.by || ''}一脚穿透性极强的直塞！`],
  counter: [(c) => `反击！${c.team}由守转攻，机会来了！`],
  dribble: [(c) => `${c.by || ''}突破了！把防守球员甩在身后！`],
  buildup: ['耐心地倒球，寻找空当。', '中路的组织推进。'],
  keeper: [(c) => `${c.by}站到了守门员的位置上。`],
  kickoff: ['比赛开始！', '哨响，双方展开争夺！'],
  fullTime: [(c) => `比赛结束！${c.winner ? c.winner + '拿下了这场比赛！' : '双方握手言和。'}`],
  newMatch: ['新的一场比赛开始了！'],
  var: ['裁判在场边看回放，判罚可能要改！'],
};

export class Commentary {
  constructor(audio) {
    this.audio = audio;
    this.last = {};        // 分类冷却
    this.priority = 0;     // 当前正在说的级别
    this.until = 0;
  }

  /** 说一句：cat 分类、priority 越高越能打断、rate/pitch 情绪 */
  say(cat, ctx = {}, { priority = 1, rate = 1.24, pitch = 0.92, cool = 2500 } = {}) {
    const now = performance.now();
    const lines = LINES[cat];
    const important = priority >= 3;
    if (!important) {
      if (now < this.until && priority <= this.priority) return;   // 正在说更重要的
      if (now - (this.last[cat] || 0) < cool) return;              // 同类冷却
    }
    this.last[cat] = now;
    this.priority = priority;
    this.until = now + 2200 * priority / 3 + 600;
    // 台词仍然生成（留作字幕/调试），但不再用 TTS 念 —— 改播 FM 真人解说素材
    if (lines) this._line = typeof lines[0] === 'function' ? rnd(lines)(ctx) : rnd(lines);
    this.audio.commentary(cat, { force: important });
    if (important) setTimeout(() => { this.priority = 0; }, 2600);
  }

  /* ---------- 事件入口 ---------- */
  goal(teamName, by) { this.say('goal', { team: teamName, by }, { priority: 4, rate: 1.32, pitch: 1.02 }); }
  /** 关键球（扳平/反超/远射破门）：用更激动的一档素材 */
  goalBig(teamName, by) { this.say('goalBig', { team: teamName, by }, { priority: 4, rate: 1.3, pitch: 1.02 }); }
  /** 丢球方视角（自己在场上被进球时的旁白） */
  goalConcede(teamName) { this.say('goalConcede', { team: teamName }, { priority: 3, rate: 1.22, pitch: 0.96 }); }
  save(by, caught) {
    if (caught) this.say('saveHold', { by }, { priority: 3, rate: 1.3, pitch: 0.98 });
    else this.say('saveMiss', { by }, { priority: 2, rate: 1.28, pitch: 0.96 });
  }
  savePunch(by) { this.say('savePunch', { by }, { priority: 3, rate: 1.3 }); }
  keeperThrow(by) { this.say('keeperThrow', { by }, { priority: 1, rate: 1.16, cool: 6000 }); }
  restart(type, teamName, by) {
    const cat = ['corner', 'goalKick', 'throwIn', 'freeKick', 'offside', 'penalty'].includes(type) ? type : 'throwIn';
    this.say(cat, { team: teamName, by }, { priority: 2, rate: 1.18, cool: 4000 });
  }
  tackle(by, victim, ko) { this.say(ko ? 'ko' : 'tackle', { by, victim }, { priority: ko ? 3 : 2, rate: 1.28, cool: 3500 }); }
  foul(teamName) { this.say('foul', { team: teamName }, { priority: 2, rate: 1.2, cool: 5000 }); }
  shot(power) {
    if (power > 0.85) this.say('shotPower', {}, { priority: 2, rate: 1.3, pitch: 1.0, cool: 2000 });
    else this.say('shot', {}, { priority: 2, rate: 1.26, cool: 2500 });
  }
  shotPost(by) { this.say('shotPost', { by }, { priority: 3, rate: 1.3, cool: 2500 }); }
  shotBlocked() { this.say('shotBlocked', {}, { priority: 2, rate: 1.26, cool: 3000 }); }
  header(by) { this.say('header', { by }, { priority: 2, rate: 1.28, cool: 3000 }); }
  cross(by) { this.say('cross', { by }, { priority: 1, rate: 1.2, cool: 5000 }); }
  pass() { this.say('pass', {}, { priority: 1, rate: 1.15, cool: 9000 }); }
  through(by) { this.say('through', { by }, { priority: 2, rate: 1.24, cool: 6000 }); }
  counter(teamName) { this.say('counter', { team: teamName }, { priority: 2, rate: 1.26, cool: 7000 }); }
  dribble(by) { this.say('dribble', { by }, { priority: 1, rate: 1.22, cool: 6500 }); }
  buildup() { this.say('buildup', {}, { priority: 1, rate: 1.14, cool: 12000 }); }
  interception(by) { this.say('interception', { by }, { priority: 1, rate: 1.2, cool: 5000 }); }
  clearance(by) { this.say('clearance', { by }, { priority: 1, rate: 1.18, cool: 5000 }); }
  card(by, name) { this.say('card', { by, name }, { priority: 2, rate: 1.26, cool: 3000 }); }
  keeper(by) { this.say('keeper', { by }, { priority: 1, rate: 1.16, cool: 8000 }); }
  varCheck() { this.say('var', {}, { priority: 3, rate: 1.2, cool: 15000 }); }
  newMatch() { this.say('newMatch', {}, { priority: 3, rate: 1.26 }); }
  start() { this.say('kickoff', {}, { priority: 3, rate: 1.26 }); }
  fullTime(winner) { this.say('fullTime', { winner }, { priority: 4, rate: 1.22, pitch: 0.95 }); }
}
