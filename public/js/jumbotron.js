/*
 * jumbotron.js —— 角看台上方的大屏（LED 计分屏）
 *
 * · 内容画在离屏 canvas 上（比分 / 剩余时间 / 直播状态 / 底部滚动播报），
 *   只在内容变化时重绘，避免每帧重画 1536×864。
 * · 屏幕用 MeshBasicMaterial + 亮度系数 > 1，配合泛光即有 LED 自发光质感。
 * · 对角两面（东北角 + 西南角）共用同一张纹理、各自朝向场内，文字不会镜像。
 */
import * as THREE from 'three';

const CW = 1536, CH = 864;      // 设计空间（绘制坐标）
const RW = 1280, RH = 720;      // 实际画布（纹理上传量更小）

const F_BOLD = (px) => `900 ${px}px "Arial Black", Impact, "Arial Narrow", Arial, sans-serif`;
const F_UI = (px, w = 700) => `${w} ${px}px "Microsoft YaHei", "PingFang SC", Arial, sans-serif`;

/** 圆角矩形 */
function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export class Jumbotron {
  constructor(scene, field, opts = {}) {
    const HALF_L = field.HALF_L, HALF_W = field.HALF_W;
    this.SW = 18.6;                    // 屏宽
    this.SH = 10.46;                   // 屏高（16:9）
    this.teams = opts.teams || null;
    this.events = [];                  // 底部播报（最多留 6 条）
    this._sig = '';
    this._tick = 0;
    this._flash = 0;
    this._lastLive = true;

    /* ---------- 离屏画布 ---------- */
    const cv = document.createElement('canvas');
    cv.width = RW; cv.height = RH;
    this.cv = cv;
    this.g = cv.getContext('2d');
    this.tex = new THREE.CanvasTexture(cv);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;

    // LED 像素网纹（画一次，之后当 pattern 叠在内容上）
    const pc = document.createElement('canvas');
    pc.width = pc.height = 6;
    const pg = pc.getContext('2d');
    pg.fillStyle = 'rgba(0,0,0,0.22)'; pg.fillRect(0, 5, 6, 1);
    pg.fillStyle = 'rgba(0,0,0,0.11)'; pg.fillRect(5, 0, 1, 6);
    this.grid = this.g.createPattern(pc, 'repeat');

    /* ---------- 屏幕材质（>1 亮度系数 = 自发光感） ---------- */
    this.mat = new THREE.MeshBasicMaterial({
      map: this.tex, toneMapped: false,
      color: new THREE.Color(2.25, 2.25, 2.25),   // >1 = 过曝，泛光里就是"亮着的 LED"
    });
    this.frameMat = new THREE.MeshStandardMaterial({ color: '#12161f', roughness: 0.45, metalness: 0.55 });
    this.legMat = new THREE.MeshStandardMaterial({ color: '#2a3140', roughness: 0.5, metalness: 0.6 });

    this.group = new THREE.Group();
    scene.add(this.group);

    const OX = HALF_L + 11, OY = HALF_W + 11;
    // 东北角 + 西南角（对角两面，场上任意位置基本都能看见一块）
    for (const [sx, sz] of [[1, -1], [-1, 1]]) {
      const host = new THREE.Group();
      host.position.set(sx * (OX - 2), 0, sz * (OY - 2));
      host.rotation.y = Math.atan2(sx, sz);      // 与角看台同向：局部 -Z 朝场内
      this.group.add(host);

      const g = new THREE.Group();
      g.position.set(0, 15.2, 9.0);              // 架在角看台后排上方
      g.rotation.y = Math.PI;                    // 屏幕正面朝场内
      host.add(g);

      // 外框在屏面后面（z 层序不能反，否则整块屏被外框挡成一块黑板）
      const frame = new THREE.Mesh(new THREE.BoxGeometry(this.SW + 0.7, this.SH + 0.7, 0.55), this.frameMat);
      frame.position.z = -0.34;
      g.add(frame);

      const panel = new THREE.Mesh(new THREE.PlaneGeometry(this.SW, this.SH), this.mat);
      panel.position.z = 0.02;
      g.add(panel);

      // 支架：两根立柱落到角看台顶层
      for (const s of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.34, 4.6, 0.34), this.legMat);
        leg.position.set(s * (this.SW / 2 - 1.1), -this.SH / 2 - 2.0, -0.2);
        g.add(leg);
        const foot = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.24, 1.2), this.legMat);
        foot.position.set(s * (this.SW / 2 - 1.1), -this.SH / 2 - 4.3, 0.2);
        g.add(foot);
      }
      // 背面检修走道
      const back = new THREE.Mesh(new THREE.BoxGeometry(this.SW - 1.2, 0.12, 1.2), this.legMat);
      back.position.set(0, -this.SH / 2 - 0.4, -1.0);
      g.add(back);
    }

    // 首帧先画一次"等待开赛"
    this.draw({ scoreA: 0, scoreB: 0, clock: 0, live: false });
  }

  /** 追加一条底部播报（用于进球 / 击倒 / 押注结算等） */
  push(text) {
    if (!text) return;
    const t = String(text).replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (this.events[0] === t) return;
    this.events.unshift(t);
    if (this.events.length > 6) this.events.length = 6;
    this.tex.needsUpdate = true;
  }

  /** 每帧调用：dt 秒；st = { scoreA, scoreB, clock, live, focus } */
  update(dt, st) {
    this._tick += dt;
    this._flash += dt;
    const sec = Math.floor(st.clock || 0);
    const sig = `${st.scoreA}|${st.scoreB}|${sec}|${st.live ? 1 : 0}|${st.focus || ''}`;
    // 内容没变就不重绘；有走字时 12Hz，没走字时 0.5s 一次（只为 LIVE 闪烁）
    const interval = this.events.length ? 1 / 12 : 0.5;
    if (sig === this._sig && this._tick < interval) return;
    this._sig = sig;
    this._tick = 0;
    this.draw(st);
  }

  draw(st) {
    const g = this.g, W = CW, H = CH;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.scale(RW / CW, RH / CH);          // 设计空间 → 实际画布，等比缩放

    const A = (this.teams && this.teams.A) || { name: '红队', color: '#e8384f' };
    const B = (this.teams && this.teams.B) || { name: '蓝队', color: '#2f7bf5' };
    const live = !!st.live;

    /* 底板 */
    g.clearRect(0, 0, W, H);
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a1220');
    bg.addColorStop(0.55, '#070c16');
    bg.addColorStop(1, '#04070d');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);

    /* 顶部信息条 */
    const top = g.createLinearGradient(0, 0, W, 0);
    top.addColorStop(0, 'rgba(232,56,79,0.22)');
    top.addColorStop(0.5, 'rgba(20,30,48,0.05)');
    top.addColorStop(1, 'rgba(47,123,245,0.22)');
    g.fillStyle = top; g.fillRect(0, 0, W, 96);
    g.fillStyle = '#eef3fa';
    g.font = F_UI(38, 800); g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText('暴力足球', 40, 50);
    g.fillStyle = 'rgba(200,214,232,0.62)';
    g.font = F_BOLD(22);
    g.fillText('V I O L E N T   S O C C E R', 250, 54);
    g.textAlign = 'right';
    g.font = F_UI(26, 600);
    g.fillStyle = 'rgba(200,214,232,0.72)';
    g.fillText('联赛 · 第 1 轮', W - 40, 50);
    g.fillStyle = 'rgba(120,140,170,0.35)'; g.fillRect(0, 96, W, 2);

    /* 双方比分 */
    const midY = 430;
    const drawTeam = (t, cx, score, dir) => {
      // 队名胶囊
      g.font = F_UI(46, 800);
      const nameW = g.measureText(t.name).width + 72;
      const px = cx - nameW / 2, py = 150;
      g.fillStyle = t.color; rr(g, px, py, nameW, 76, 38); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.16)';
      rr(g, px, py, nameW * 0.45, 76, 38); g.fill();
      g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(t.name, cx, py + 40);

      // 比分（带同色光晕）
      g.save();
      g.shadowColor = t.color; g.shadowBlur = 14;
      g.fillStyle = '#ffffff';
      g.font = F_BOLD(272);
      g.fillText(String(score), cx, midY + 40);
      g.restore();
      // 数字下方色条
      g.fillStyle = t.color;
      rr(g, cx - 96, midY + 186, 192, 8, 4); g.fill();
    };
    drawTeam(A, 400, st.scoreA | 0, -1);
    drawTeam(B, W - 400, st.scoreB | 0, 1);

    /* 中间：剩余时间 + 直播状态 */
    const m = Math.floor((st.clock || 0) / 60), s = Math.floor((st.clock || 0) % 60);
    g.textAlign = 'center';
    g.fillStyle = 'rgba(180,196,218,0.66)';
    g.font = F_UI(28, 700);
    g.fillText('剩余时间', W / 2, 250);
    g.fillStyle = live && (this._flash % 1.0 < 0.5) ? '#ffe6a3' : '#ffffff';
    g.font = F_BOLD(128);
    g.fillText(`${m}:${String(s).padStart(2, '0')}`, W / 2, 356);
    g.font = F_UI(30, 800);
    g.fillStyle = 'rgba(160,178,200,0.5)';
    g.fillText(':', W / 2, 356);   // 占位（避免两侧数字跳动时视觉偏移）

    // LIVE
    const bl = live ? (this._flash % 1.2 < 0.6) : true;
    g.beginPath(); g.arc(W / 2 - 74, 470, 13, 0, Math.PI * 2);
    g.fillStyle = live ? (bl ? '#ff3b52' : '#5a1420') : '#39424f'; g.fill();
    g.font = F_UI(30, 800);
    g.fillStyle = live ? '#ffb9c2' : 'rgba(150,164,184,0.55)';
    g.fillText(live ? 'LIVE 直播中' : '等待开赛', W / 2 - 44, 470);
    g.textAlign = 'left';

    /* 底部播报 */
    g.fillStyle = '#0b1220'; g.fillRect(0, H - 118, W, 118);
    g.fillStyle = (A.color); g.fillRect(0, H - 118, 8, 118);
    g.fillStyle = (B.color); g.fillRect(8, H - 118, 8, 118);
    g.fillStyle = 'rgba(120,140,170,0.28)'; g.fillRect(0, H - 118, W, 2);
    g.font = F_UI(40, 700);
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    if (this.events.length) {
      const line = this.events.join('   ·   ');
      const tw = g.measureText(line).width;
      const span = W + tw;
      const x0 = W - ((this._flash * 62) % Math.max(span, 1));   // 从右往左走字
      g.fillStyle = 'rgba(214,228,246,0.92)';
      g.fillText(line, x0, H - 58);
      if (x0 + tw < W) g.fillText(line, x0 + span, H - 58);      // 循环接上
    } else {
      g.textAlign = 'center';
      g.fillStyle = 'rgba(198,214,234,0.80)';
      g.fillText('欢迎来到暴力足球 · 踢球 / 攻击 / 跳舞，三种模式随你切换', W / 2, H - 58);
    }

    /* LED 网纹 + 屏面质感 */
    g.fillStyle = this.grid; g.fillRect(0, 0, W, H);
    const vig = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 1.0);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.28)');
    g.fillStyle = vig; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(120,170,255,0.05)'; g.fillRect(0, 0, W, H);

    this.tex.needsUpdate = true;
  }
}
