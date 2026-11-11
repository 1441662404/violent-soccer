/* ============================================================
 *  触屏控制（手机 / 平板）
 *  左半屏：虚拟摇杆（推到底=疾跑）
 *  右半屏：拖动转视角（上下=仰角，看天=高球）
 *  右下按钮组：随模式切换
 *    踢球：传球 / 射门（按住蓄力松手出球）/ 滑铲 / 带球(按住)
 *    攻击：左拳 / 右拳 / 扑抢
 *    跳舞：舞段 1~5
 *  左上：模式切换 / 慢走
 *  桌面加 ?touch=1 可强制开启（方便测试）
 * ============================================================ */
export class TouchControls {
  constructor(controls) {
    this.controls = controls;
    this.stick = { active: false, id: -1, ox: 0, oy: 0, dx: 0, dy: 0, r: 52 };
    this.look = { active: false, id: -1, x: 0, y: 0 };
    this.grab = false;
    this.aimLock = false;
    this.walk = false;
    this.enabled = false;

    this._build();
    this._bind();
    this.syncMode(controls.mode);
    setupOrientation();
  }

  /* ---------- DOM ---------- */
  _build() {
    const root = document.createElement('div');
    root.id = 'touch';
    root.innerHTML = `
      <div class="tz tzL"></div>
      <div class="tz tzR"></div>
      <div id="tstick"><i id="tknob"></i></div>
      <div id="tsys">
        <button class="tbtn sys" data-act="mode">模式</button>
        <button class="tbtn sys" data-act="walk">慢走</button>
        <button class="tbtn sys" data-act="aimlock">锁定</button>
        <button class="tbtn sys" data-act="zoomIn">近</button>
        <button class="tbtn sys" data-act="zoomOut">远</button>
      </div>
      <div id="tbtns">
        <div class="tgrp" data-mode="soccer">
          <button class="tbtn act" data-act="grab">带球</button>
          <button class="tbtn act" data-act="slide">滑铲</button>
          <button class="tbtn big shoot" data-act="shoot">射门</button>
          <button class="tbtn big pass" data-act="pass">传球</button>
        </div>
        <div class="tgrp" data-mode="attack">
          <button class="tbtn act" data-act="slide">扑抢</button>
          <button class="tbtn big punch" data-act="punchR">右拳</button>
          <button class="tbtn big punch" data-act="punchL">左拳</button>
        </div>
        <div class="tgrp" data-mode="dance">
          <button class="tbtn num" data-act="d1">1</button>
          <button class="tbtn num" data-act="d2">2</button>
          <button class="tbtn num" data-act="d3">3</button>
          <button class="tbtn num" data-act="d4">4</button>
          <button class="tbtn num" data-act="d5">5</button>
          <button class="tbtn num" data-act="d6">6</button>
          <button class="tbtn num" data-act="d7">7</button>
          <button class="tbtn num" data-act="d8">8</button>
          <button class="tbtn num" data-act="d9">9</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    document.body.classList.add('touch');   // 让 CSS 藏起键位提示等桌面元素
    this.root = root;
    this.stickEl = root.querySelector('#tstick');
    this.knobEl = root.querySelector('#tknob');
    this.groups = {};
    for (const g of root.querySelectorAll('.tgrp')) this.groups[g.dataset.mode] = g;
  }

  _bind() {
    const c = this.controls;
    const buzz = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };

    /* ---- 按钮 ---- */
    this.root.querySelectorAll('.tbtn').forEach((btn) => {
      const act = btn.dataset.act;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.classList.add('on');
        try { btn.setPointerCapture(e.pointerId); } catch (err) {}
        if (act === 'pass' || act === 'shoot') {
          if (c.mode !== 'soccer') return;
          c.chargeType = act;
          c.charging = true;
          c.chargeStart = performance.now();
          c.charge = 0;
        } else if (act === 'slide') {
          c.onSlide && c.onSlide();
          buzz(20);
        } else if (act === 'grab') {
          this.grab = true;
        } else if (act === 'punchL' || act === 'punchR') {
          if (c.mode !== 'attack') return;
          c.onPunch && c.onPunch(act === 'punchL' ? 'L' : 'R');
          buzz(15);
        } else if (act === 'mode') {
          c.mode = c.mode === 'soccer' ? 'attack' : (c.mode === 'attack' ? 'dance' : 'soccer');
          c.onMode && c.onMode(c.mode);
        } else if (act === 'walk') {
          this.walk = !this.walk;
          btn.classList.toggle('on', this.walk);
        } else if (act === 'aimlock') {
          this.aimLock = !this.aimLock;
          btn.classList.toggle('on', this.aimLock);
          c.aimLock = this.aimLock;
          c.onAimLock && c.onAimLock(this.aimLock);
        } else if (act === 'zoomIn' || act === 'zoomOut') {
          // 视距：点一下走一档，按住连续调（双指捏合同样可用）
          const dir = act === 'zoomIn' ? -1 : 1;      // 近 = 拉近 = 距离变小
          const step = () => this._zoomBy(dir > 0 ? 1.12 : 1 / 1.12);
          step();
          clearInterval(this._zoomTimer);
          this._zoomTimer = setInterval(step, 90);
        } else if (/^d[1-9]$/.test(act)) {
          if (c.mode !== 'dance') return;
          const n = Number(act[1]);
          c.dance = n;
          c.onDance && c.onDance(n);
          buzz(10);
        }
      });
      const up = (e) => {
        btn.classList.remove('on');
        clearInterval(this._zoomTimer);
        if ((act === 'pass' || act === 'shoot') && c.charging && c.chargeType === act) {
          const type = c.chargeType;
          // 触屏轻点也会出一脚像样的球（下限 0.35），不会太绵；长按依旧满力
          const power = Math.max(c.charge, 0.35);
          c.charging = false; c.charge = 0; c.chargeType = null;
          c.onKick && c.onKick(type, power);
        }
        if (act === 'grab') this.grab = false;
      };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
    });

    /* ---- 摇杆 / 视角 / 双指缩放（统一用 pointer 事件，多指并行才稳）---- */
    const stickZone = this.root.querySelector('.tzL');
    const lookZone = this.root.querySelector('.tzR');
    this._onMove = (e) => this._move(e);
    this._onEnd = (e) => this._end(e);
    stickZone.addEventListener('pointerdown', (e) => this._down(e, 'stick'));
    lookZone.addEventListener('pointerdown', (e) => this._down(e, 'look'));
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onEnd);
    window.addEventListener('pointercancel', this._onEnd);
    // 多指追踪：双指同时按下 → 进入缩放（比 touch 事件稳，且能接管正在拖的摇杆/视角）
    this.ptrs = new Map();
    this.pinch = null;
  }

  /** 关闭触屏层（切回键鼠）：清监听、清定时器、删 DOM、清掉残留输入 */
  destroy() {
    clearInterval(this._zoomTimer);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onEnd);
    window.removeEventListener('pointercancel', this._onEnd);
    const c = this.controls;
    c.touchMove.mx = 0; c.touchMove.mz = 0; c.touchMove.sprint = false;
    c._touchGrab = false;
    this.stick.active = false;
    this.look.active = false;
    this.ptrs.clear();
    this.pinch = null;
    this.root.remove();
    const tip = document.getElementById('rotTip');
    if (tip) { tip.remove(); }
  }

  /** 指针按下：记录到多指表；两指时切换成缩放手势 */
  _down(e, kind) {
    e.preventDefault();
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, kind });
    if (this.ptrs.size === 2) {
      this._stickOff(); this._lookOff();          // 双指期间停掉摇杆/视角，避免打架
      const [a, b] = [...this.ptrs.values()];
      this.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, dist0: this.controls.dist };
    } else if (this.ptrs.size === 1) {
      if (kind === 'stick') this._stickStart(e); else this._lookStart(e);
    }
  }

  _stickOff() {
    if (!this.stick.active) return;
    this.stick.active = false;
    this.stickEl.classList.remove('on');
    const c = this.controls;
    c.touchMove.mx = 0; c.touchMove.mz = 0; c.touchMove.sprint = false;
  }

  _lookOff() { this.look.active = false; }

  /** 视距缩放：双指捏合 */
  _zoomBy(scale) {
    this.controls.dist = Math.min(14, Math.max(4, this.controls.dist * scale));
  }

  _stickStart(e) {
    e.preventDefault();
    this.stick.active = true;
    this.stick.id = e.pointerId;
    this.stick.ox = e.clientX; this.stick.oy = e.clientY;
    this.stick.dx = 0; this.stick.dy = 0;
    const r = this.stick.r;
    this.stickEl.style.left = (e.clientX - r) + 'px';
    this.stickEl.style.top = (e.clientY - r) + 'px';
    this.stickEl.classList.add('on');
    this.knobEl.style.transform = 'translate(0px, 0px)';
  }

  _lookStart(e) {
    e.preventDefault();
    this.look.active = true;
    this.look.id = e.pointerId;
    this.look.x = e.clientX; this.look.y = e.clientY;
  }

  _move(e) {
    const c = this.controls;
    const p = this.ptrs && this.ptrs.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    // 双指捏合 → 视距缩放（张开放远、捏拢放近）
    if (this.pinch && this.ptrs.size >= 2) {
      const [a, b] = [...this.ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      this._zoomBy(this.pinch.d0 / d);
      return;
    }
    if (this.stick.active && e.pointerId === this.stick.id) {
      let dx = e.clientX - this.stick.ox, dy = e.clientY - this.stick.oy;
      const l = Math.hypot(dx, dy), r = this.stick.r;
      if (l > r) { dx = dx / l * r; dy = dy / l * r; }
      this.stick.dx = dx; this.stick.dy = dy;
      this.knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
      const mag = l > r ? 1 : l / r;
      c.touchMove.mx = dx / r;
      c.touchMove.mz = -dy / r;
      c.touchMove.sprint = mag > 0.92;
      c.touchMove.walk = this.walk;
    } else if (this.look.active && e.pointerId === this.look.id) {
      const dx = e.clientX - this.look.x, dy = e.clientY - this.look.y;
      this.look.x = e.clientX; this.look.y = e.clientY;
      c.camYaw -= dx * 0.005;
      c.camPitch = Math.min(1.15, Math.max(-0.35, c.camPitch + dy * 0.004));
    }
  }

  _end(e) {
    const c = this.controls;
    if (this.ptrs) this.ptrs.delete(e.pointerId);
    if (this.pinch && (!this.ptrs || this.ptrs.size < 2)) this.pinch = null;
    if (this.stick.active && e.pointerId === this.stick.id) {
      this.stick.active = false;
      this.stickEl.classList.remove('on');
      c.touchMove.mx = 0; c.touchMove.mz = 0; c.touchMove.sprint = false;
    }
    if (this.look.active && e.pointerId === this.look.id) this.look.active = false;
  }

  /** 模式切换后高亮对应按钮组 */
  syncMode(m) {
    for (const [k, g] of Object.entries(this.groups)) g.classList.toggle('on', k === m);
  }

  /** 每帧把触屏输入喂给 Controls */
  update() {
    const c = this.controls;
    c._touchGrab = this.grab;
    c.touchMove.walk = this.walk;
  }

  get enabled2() { return this.enabled; }
}

/** 底部中央的「键鼠 ⇄ 触屏」切换按钮。
 *  getOn() 返回当前是否触屏模式，setOn(bool) 负责真正切换。 */
export function installModeSwitch(getOn, setOn) {
  let btn = document.getElementById('modeSwitch');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'modeSwitch';
    btn.title = '点击切换键鼠 / 触屏操作';
    document.body.appendChild(btn);
  }
  // 按钮显示「当前正在用的方案」，点一下切到另一种
  const label = (on) => (on ? '📱 触屏操作' : '⌨ 键鼠操作');
  const sync = () => {
    const on = !!getOn();
    btn.textContent = label(on);
    btn.classList.toggle('toTouch', !on);
    btn.classList.toggle('toDesktop', on);
  };
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setOn(!getOn());
    sync();
  });
  sync();
  return btn;
}

/** 是否触屏设备（桌面可用 ?touch=1 强制） */
export function isTouchDevice() {
  return /[?&]touch=1\b/.test(location.search)
    || (window.matchMedia && matchMedia('(pointer: coarse)').matches)
    || ('ontouchstart' in window);
}

/** 竖屏提示条 + 一键切横屏全屏（iOS 不支持 orientation.lock，只提示不强制） */
export function setupOrientation() {
  if (document.getElementById('rotTip')) return;
  let dismissed = false;
  try { dismissed = sessionStorage.getItem('rotDismiss') === '1'; } catch (e) {}
  const el = document.createElement('div');
  el.id = 'rotTip';
  el.hidden = true;
  el.innerHTML = `
    <div class="rotBox">
      <i class="rotIcon"></i>
      <div class="rotTxt"><b>横屏游玩体验更佳</b><small>左摇杆移动 · 右侧拖动视角 · 双指缩放视距</small></div>
      <button id="rotGo">横屏全屏</button>
      <button id="rotX" aria-label="关闭">✕</button>
    </div>`;
  document.body.appendChild(el);
  const close = () => {
    el.hidden = true;
    dismissed = true;
    try { sessionStorage.setItem('rotDismiss', '1'); } catch (e) {}
  };
  el.querySelector('#rotX').addEventListener('click', close);
  el.querySelector('#rotGo').addEventListener('click', async () => {
    try {
      const de = document.documentElement;
      if (de.requestFullscreen && !document.fullscreenElement) await de.requestFullscreen({ navigationUI: 'hide' });
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
    } catch (e) { /* iOS 不支持锁定，横屏由玩家自己转 */ }
    close();
  });
  const check = () => { el.hidden = dismissed || !(window.innerHeight > window.innerWidth); };
  // 玩起来就自动让位：6 秒后淡出、第一次操作左摇杆/右侧视角时立刻收起
  setTimeout(() => { if (!el.hidden) el.style.opacity = '0.35'; }, 6000);
  const dismissOnPlay = () => {
    if (el.hidden) return;
    el.hidden = true;
    document.removeEventListener('pointerdown', dismissOnPlay, true);
  };
  setTimeout(() => document.addEventListener('pointerdown', dismissOnPlay, true), 1200);
  window.addEventListener('resize', check);
  window.addEventListener('orientationchange', () => setTimeout(check, 150));
  check();
}
