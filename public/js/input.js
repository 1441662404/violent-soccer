import * as THREE from 'three';
const SH = window.SHARED;
const C = SH.C;
const { clamp } = SH;

/** 操作方案开关（可在页面右下角随时切换键鼠/触屏，选择记进 localStorage）
 *  ?touch=1 / ?touch=0 强制指定，方便测试 */
export const TOUCH = {
  on: (() => {
    try {
      const q = /[?&]touch=([01])/.exec(location.search);
      if (q) return q[1] === '1';
      const saved = localStorage.getItem('touchMode');
      if (saved !== null) return saved === '1';
    } catch (e) {}
    return (window.matchMedia && matchMedia('(pointer: coarse)').matches) || ('ontouchstart' in window);
  })(),
};

/* ★ 击球点（右下角球 UI 的红点）：键盘方向键移动，位置持久保存、移动了就不自动回中。
 *   偏上 = 电梯球（上旋下坠）· 偏下 = 后旋（滞空久）· 偏左 = 顺时针弧线（往右弯）
 *   偏右 = 逆时针弧线（往左弯）。正中心吃劲最足。
 *   箭头键被这个 UI 接管（dot 挪动），角色不再被方向键拖着跑 —— WASD 照常移动。 */
const BALL_SPOT_KEY = 'fk26.ballSpot';
const ballSpot = { x: 0, y: 0 };          // -1..1（y 向上为正）
try {
  const saved = JSON.parse(localStorage.getItem(BALL_SPOT_KEY) || 'null');
  if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
    ballSpot.x = Math.max(-1, Math.min(1, saved.x));
    ballSpot.y = Math.max(-1, Math.min(1, saved.y));
  }
} catch (e) {}

/* ★ 鼠标侧键调击球点（用户要求）：
 *   按住侧键（后退 button 3 / 前进 button 4）后移动鼠标 = 推红点；
 *   松开侧键立刻回到正常视角控制，互不干扰。
 *   灵敏度标定：把红点从正中推到边缘（量程 1.0）约需鼠标位移 260px
 *   → 0.0038 /px。pointer lock 下鼠标可以无限累积，所以不设加速，纯线性最好控。 */
const SPOT_MOUSE_SENS = 0.0038;

/* ★★ 第一人称（FPS 球员视角）参数 —— 学习主流足球游戏 FC/FIFA 的"球员镜头"
 *
 *  pitch 范围 [-1.08, 1.72]（围绕"平视基准" FPS_PITCH_BIAS 上下各 ~80°）：
 *    · camPitch = 0.32 平视（= 第三人称的默认值，切过来不会突然低头）
 *    · camPitch = 1.72 → 低头 80° → 能看到自己的胸口以下、脚和脚下的球
 *    · camPitch = -1.08 → 抬头 80° → 看看台顶棚 / 高吊球
 *  ⚠️ 千万不要用第三人称那套 [-0.35, 1.15]：那个范围是"相机绕着人抬高/放低"，
 *     放到第一人称会变成"只能仰视、完全低不了头"，低头看球直接失效。
 *
 *  EYE_FALLBACK_Y：拿不到头部骨骼时的兜底眼高（脚底往上 1.62m ≈ 一米八的人眼高）。
 *  NEAR_FPS：第一人称的相机近裁剪面。**这就是"只隐藏头部"的做法** ——
 *    头部网格离相机 0~0.15m，把 near 提到 0.22 就全部被裁掉，
 *    而胸口(≈1.35m 高，离眼 0.27m)以下照常可见 → 用户要的"只隐藏头部、能看到身体和脚"。
 *
 *  ★ 视线方向的数学（与第三人称共用同一套 camYaw/camPitch，只是原点换到头部）：
 *    前向 = ( sin(camYaw)·cos(p), -sin(p), cos(camYaw)·cos(p) )，其中 p = camPitch - FPS_PITCH_BIAS。
 *    · 水平分量与 moveVec 的"前 = (sin yaw, cos yaw)"**完全一致** → WASD 永远朝你看的方向走。
 *    · 俯仰带 FPS_PITCH_BIAS 是为了让"平视"落在 camPitch=0.32 上，
 *      于是 shared.js 的 pitchToElev(camPitch)（出球仰角）语义不变：
 *      "低头=贴地斩 / 抬头=高吊" 在第一人称下依然成立，预览线即实战。 */
const FPS_PITCH_BIAS = 0.32;
const FPS_PITCH_MIN = FPS_PITCH_BIAS - 1.4;   // ≈ -1.08（抬头 80°）
const FPS_PITCH_MAX = FPS_PITCH_BIAS + 1.4;   // ≈  1.72（低头 80°）
const FPS_EYE_FALLBACK_Y = 1.62;
const FPS_NEAR = 0.22;
const TP_NEAR = 0.1;

/* ============================================================
 *  键鼠输入 + 第三人称相机
 *  F：吸附带球（0.5m 内）
 *  左键传球 / 右键射门：按住蓄力（力度条 0.9 秒满），松手才出球
 *  方向与仰角由准星 + 鼠标上下决定（看天=高球，看地=贴地球）
 *  C：滑铲 / 攻击模式扑抢 · Q：切换模式（踢球 → 攻击 → 跳舞）
 *  跳舞模式：站着就跳。1 = Gangnam Style 整段（不拆键位），6~9 = Hip Hop/Swing/Breakdance，移动即打断
 * ============================================================ */
export class Controls {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.keys = new Set();
    /** 松开所有按键（打开聊天框时调用，否则角色会一直按着 W 往前跑） */
    this.releaseAll = () => { this.keys.clear(); };
    this.camYaw = 0;
    this.camPitch = 0.32;
    this.dist = 7.2;
    this.sens = 0.0022;
    this.locked = false;

    /* ★ 自由查看视角（V 键切换）
     *   打开后：镜头脱离角色、鼠标自由环视，WASD 前后左右平移观察，
     *   滚轮拉近拉远。再按 V 回到跟人视角（回到原位置，不会把人弄丢）。
     *   为什么需要它：现在镜头是死死跟人的第三人称，想看看别处/看看自己跳的舞
     *   只能带着人一起转，很不方便。 */
    this.freeCam = false;
    this.freePos = new THREE.Vector3();     // 自由镜头位置
    this.freeAnchor = new THREE.Vector3();  // 自由镜头的球心（= 角色位置）
    this.freeDist = 6.5;                    // 观察半径（滚轮调：拉近/拉远）
    this.freeHeight = 0;                    // 机位高度微调（R/F）
    this.onFreeCam = null;

    /* ★★ 第一人称视角（V 键循环的第 2 档）
     *   学习主流足球游戏（FC/FIFA 的球员视角）：相机架在**自己头骨位置**，
     *   视线跟着鼠标自由俯仰，低头能看到自己的身体和脚下的球。
     *   · 眼位由外部注入的 `getEyePos()` 提供（main.js 从 mixamorigHead 骨骼取世界坐标），
     *     取不到时才退回"脚底 + 1.62m"的估算。
     *   · 头部几何靠**加大 camera.near** 裁掉（见 update 里的 near 管理）——
     *     这是主流做法：第一人称不渲染任何贴脸几何，也就不需要改材质/骨骼可见性。
     *   · 速度与第三人称**完全一致**（用户明确要求"实际奔跑速度跟第三人称一样"），
     *     这里只改机位与俯仰范围，不碰任何服务端参数。 */
    this.fpsCam = false;
    this.getEyePos = null;      // () => {x,y,z}  眼位（头部骨骼世界坐标）
    this.onViewMode = null;     // (mode: 'tp'|'fps'|'free') => void

    this.primaryDown = false;
    this.charging = false;
    this.charge = 0;          // 0~1 力度条
    this.chargeType = null;   // 'pass' | 'shoot'
    this.chargeStart = 0;
    this.mode = 'soccer';     // 'soccer' | 'attack' | 'dance'
    this.dance = 1;           // 跳舞模式当前舞段 1~5
    this.touchMove = { mx: 0, mz: 0, sprint: false, walk: false };   // 触屏摇杆输入（touch.js 写入）
    this._touchGrab = false;  // 触屏"带球"按钮按住

    this.baseFov = camera.fov || 62;
    this.speedFx = 0;          // 0~1 冲刺视效强度（拉 FOV + 压低机位）
    this.holdFx = 0;           // 0~1 持球视效强度（收窄 FOV，像镜头"跟上去"）
    this.shakeT = 0;           // 抖动剩余时间
    this.shakeAmp = 0;
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.aim = new THREE.Vector3();     // 准星在世界地面的落点
    this.aimValid = false;

    this.onPrimary = null;      // ({dir, power}) => void
    this.onGrab = null;         // () => void
    this.onSlide = null;        // () => void
    this.onMode = null;         // (mode) => void
    this.onDance = null;        // (n: 1~5) => void   跳舞模式切换舞段
    this.onPunch = null;        // (hand: 'L'|'R') => void   攻击模式：左键左勾拳 / 右键右直拳
    this.onAimLock = null;      // (on: bool) => void   守门员锁定防守（E 键）
    this.onCard = null;         // (slot: number) => void  属性卡（踢球模式 1~9）
    this.onShop = null;         // () => void  押注商店（B 键）
    this.aimLock = false;       // 锁定状态（客户端记，服务端只认守门员+禁区内）
    this.onLockChange = null;
    this.onSpotChange = null;   // (spot: {x,y}) => void  击球点变化（UI 更新红点位置）
    /* ★ 鼠标侧键调击球点（见文件顶部 SPOT_MOUSE_SENS 注释）：
     *   this.spotDrag = 正在用侧键拖红点（此期间 mousemove 不转镜头） */
    this.spotDrag = false;
    this.onSpotDrag = null;     // (dragging: bool) => void  侧键拖拽状态（UI 给个高亮反馈）

    this._bind();
  }

  _bind() {
    const dom = this.dom;
    dom.addEventListener('click', () => {
      if (!this.locked && !TOUCH.on && dom.requestPointerLock) {
        try { const p = dom.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === dom;
      if (!this.locked) { this.charging = false; this.charge = 0; this.chargeType = null; this.spotDrag = false; this.onSpotDrag && this.onSpotDrag(false); }
      this.onLockChange && this.onLockChange(this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      /* ★ 侧键拖红点：**不要求 pointer lock**，而且不转镜头。
       *   为什么放宽锁定条件：① 侧键按下本身就是明确的"我要推红点"意图，
       *   锁没拿到（比如刚进房）时也该能用；② 无头环境 pointer lock 拿不到，
       *   卡这个条件会让逻辑根本跑不起来。 */
      if (this.spotDrag) { this._spotMove(e); return; }
      /* 兜底：某些鼠标/驱动不派发侧键的 mousedown，但 mousemove 的 buttons
       *   位掩码里一定带着 8(后退)/16(前进)。发现掩码里有侧键就直接进拖拽模式。 */
      if ((e.buttons & 8) || (e.buttons & 16)) { this._beginSpotDrag(); this._spotMove(e); return; }
      if (!this.locked) return;
      this.camYaw -= e.movementX * this.sens;
      this.camPitch += e.movementY * this.sens;
      /* ★ 俯仰范围分两套（第一人称要能低头看球/抬头看天）：
       *   第三人称走窄范围 [-0.35, 1.15]（原来的值，机位太高会看到头顶）；
       *   第一人称走 ±78°，低头能看到自己的身体和球，抬头能看到看台顶棚。
       *   ⚠️ 第一人称**不能**用第三人称的 clamp —— 否则"低头看球"永远做不到
       *   （1.15 rad ≈ 66° 在 FPS 里是"仰视"而不是"俯视"，方向感完全错）。 */
      if (this.fpsCam) this.camPitch = clamp(this.camPitch, FPS_PITCH_MIN, FPS_PITCH_MAX);
      else this.camPitch = clamp(this.camPitch, -0.35, 1.15);
    });
    /* 滚轮：自由视角下调"观察半径"（等效拉近拉远）；跟人视角不动 */
    dom.addEventListener('wheel', (e) => {
      if (!this.freeCam) return;
      e.preventDefault();
      this.freeDist = clamp(this.freeDist + Math.sign(e.deltaY) * 0.8, 1.8, 30);
    }, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    /* 侧键的 auxclick 也要拦（有些浏览器只发 auxclick 不发 mousedown 的默认行为） */
    window.addEventListener('auxclick', (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); });

    dom.addEventListener('mousedown', (e) => {
      /* ★ 鼠标侧键（3=后退 / 4=前进）：按下即进入"推红点"模式，抢占这次拖拽。
       *   preventDefault 是必须的 —— 否则浏览器会把侧键当"后退/前进"导航，
       *   整个游戏页面会被直接翻走。 */
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        this._beginSpotDrag();
        return;
      }
      if (!this.locked) return;
      // 攻击模式：按下立即出拳（左键左勾拳 / 右键右直拳），不蓄力
      if (this.mode === 'attack' && (e.button === 0 || e.button === 2)) {
        this.onPunch && this.onPunch(e.button === 0 ? 'L' : 'R');
        return;
      }
      if (this.mode === 'dance') return;      // 跳舞模式：不蓄力不出球，安心跳
      // 左键 = 传球，右键 = 射门：按下开始蓄力（力度条），松手才出球
      if (e.button === 0 || e.button === 2) {
        this.chargeType = e.button === 0 ? 'pass' : 'shoot';
        this.charging = true;
        this.chargeStart = performance.now();
        this.charge = 0;
      }
    });
    window.addEventListener('mouseup', (e) => {
      /* ★ 侧键松开 → 立刻退出"推红点"模式，鼠标回到正常视角控制 */
      if (e.button === 3 || e.button === 4) {
        if (this.spotDrag) { this.spotDrag = false; this.onSpotDrag && this.onSpotDrag(false); }
        return;
      }
      if (e.button !== 0 && e.button !== 2) return;
      if (!this.charging) return;
      if (this.chargeType !== (e.button === 0 ? 'pass' : 'shoot')) return;
      const type = this.chargeType;
      const power = this.charge;
      this.charging = false;
      this.charge = 0;
      this.chargeType = null;
      this.onKick && this.onKick(type, power);
    });

    window.addEventListener('keydown', (e) => {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      /* ★ 方向键 = 移动击球点红点（踢球模式专属），不再移动角色 —— WASD 照常。
       *   移动了就保持（localStorage 持久），不自动回正中。 */
      if (this.mode === 'soccer' && /^Arrow(Up|Down|Left|Right)$/.test(e.code)) {
        const STEP = 0.2;
        if (e.code === 'ArrowUp') ballSpot.y = Math.min(1, ballSpot.y + STEP);
        else if (e.code === 'ArrowDown') ballSpot.y = Math.max(-1, ballSpot.y - STEP);
        else if (e.code === 'ArrowLeft') ballSpot.x = Math.max(-1, ballSpot.x - STEP);
        else ballSpot.x = Math.min(1, ballSpot.x + STEP);
        e.preventDefault();
        this.setSpot(ballSpot.x, ballSpot.y);   // 存盘 + 通知 UI（与侧键共用）
        this.keys.add(e.code);              // 也记进 keys，keyup 统一清
        return;                             // 不给 moveVec 用
      }
      this.keys.add(e.code);
      if (e.code === 'KeyQ') {
        // 三模式循环：踢球 → 攻击 → 跳舞
        this.mode = this.mode === 'soccer' ? 'attack' : (this.mode === 'attack' ? 'dance' : 'soccer');
        this.onMode && this.onMode(this.mode);
      }
      /* 跳舞模式：切换舞段（1~6，一舞一键，表在 C.DANCES）。
       * 键位只做"选第几个"，具体 clip 由服务端状态机按表查，避免两边各写一套映射。 */
      if (this.mode === 'dance' && /^Digit[1-9]$/.test(e.code)) {
        const n = clamp(Number(e.code.slice(5)), 1, (C.DANCES || []).length || 6);
        this.dance = n;
        this.onDance && this.onDance(n);
      }
      // E：守门员锁定防守（自动面向球，左右侧步）
      if (e.code === 'KeyE' && !this.keys.has('__e')) {
        this.keys.add('__e');
        this.aimLock = !this.aimLock;
        this.onAimLock && this.onAimLock(this.aimLock);
      }
      if (e.code === 'KeyC' && !this.keys.has('__c')) {
        this.keys.add('__c');
        this.onSlide && this.onSlide();
      }
      // B：押注商店（开/关）—— 用 e.repeat 判重，避免漏 keyup 时卡住
      if (e.code === 'KeyB' && !e.repeat) {
        this.onShop && this.onShop();
      }
      /* ★ V：视角循环切换（用户要求"V 键循环切换"）
       *   第三人称 → 第一人称 → 自由查看 → 回到第三人称 ……
       *   三者互斥（同时只能一个生效），切换时各自复位自己的临时状态。 */
      if (e.code === 'KeyV' && !e.repeat) {
        if (!this.fpsCam && !this.freeCam) {
          // tp → fps
          this.fpsCam = true;
          this.camPitch = clamp(this.camPitch, FPS_PITCH_MIN, FPS_PITCH_MAX);
          if (this.onViewMode) this.onViewMode('fps');
        } else if (this.fpsCam) {
          // fps → free
          this.fpsCam = false;
          this.freeCam = true;
          this.freeHeight = 0;
          this.freeDist = 6.5;
          if (this.onViewMode) this.onViewMode('free');
        } else {
          // free → tp
          this.freeCam = false;
          if (this.onViewMode) this.onViewMode('tp');
        }
      }
      // 踢球模式：1~9 使用属性卡槽
      // 数字键 1~9：踢球模式用属性卡；攻击模式放技能（飞踢/螺旋踢）—— 两者不再冲突
      if ((this.mode === 'soccer' || this.mode === 'attack') && /^Digit[1-9]$/.test(e.code)) {
        this.onCard && this.onCard(Number(e.code.slice(5)) - 1);
      }
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyC') this.keys.delete('__c');
      if (e.code === 'KeyE') this.keys.delete('__e');
      if (e.code === 'KeyB') this.keys.delete('__b');
    });
    window.addEventListener('blur', () => { this.keys.clear(); this._touchGrab = false; this.spotDrag = false; });
  }

  /** 进入"侧键推红点"状态（幂等：mousedown 与 mousemove 兜底两条路都会调它） */
  _beginSpotDrag() {
    if (this.spotDrag) return;
    this.spotDrag = true;
    this.onSpotDrag && this.onSpotDrag(true);
  }

  /** ★ 侧键拖拽时的一步：鼠标位移 → 红点位移（移动方向与推鼠标方向一致）。
   *  红点在球面上，屏幕向右推 = 红点向右（x+），屏幕向下推 = 红点向下（y-，
   *  因为 ballSpot.y 以"向上为正"）。关掉视角旋转是刻意的：
   *  一边推红点一边甩镜头会两件事都做不好。 */
  _spotMove(e) {
    ballSpot.x = Math.max(-1, Math.min(1, ballSpot.x + (e.movementX || 0) * SPOT_MOUSE_SENS));
    ballSpot.y = Math.max(-1, Math.min(1, ballSpot.y - (e.movementY || 0) * SPOT_MOUSE_SENS));
    this.setSpot(ballSpot.x, ballSpot.y);
  }

  /** 统一入口：改红点 → 存 localStorage → 通知 UI（键盘方向键 / 侧键拖拽共用） */
  setSpot(x, y) {
    ballSpot.x = Math.max(-1, Math.min(1, x));
    ballSpot.y = Math.max(-1, Math.min(1, y));
    try { localStorage.setItem(BALL_SPOT_KEY, JSON.stringify(ballSpot)); } catch (e2) {}
    this.onSpotChange && this.onSpotChange({ x: ballSpot.x, y: ballSpot.y });
  }

  has(code) { return this.keys.has(code); }

  /** ★ 当前击球点（红点位置，-1..1；y 向上为正）—— 出球时随 kick 上行给服务端。
   *  ⚠️ 曾经这里是 `{x, y}`，而服务端读的是 `{sx, sy}` → **红点对球零作用**（真 bug）。
   *     现在同时给出两套键名，服务端也已双向兼容，谁先更新都不会断。 */
  get ballSpot() {
    return {
      sx: ballSpot.x, sy: ballSpot.y,       // 服务端 spinFromSpot 用的键名
      x: ballSpot.x, y: ballSpot.y,         // 兼容旧调用（预览线/标签等）
    };
  }

  /** F 按住 = 持续尝试吸附带球（上行随 input 心跳发）；触屏"带球"按钮等价 */
  get grabHeld() { return this.has('KeyF') || !!this._touchGrab; }

  /** 世界移动方向（相对相机）；触屏摇杆输入叠加在后面。
   *  ★ 方向键（Arrow*）已改为"移动击球点红点"，不再参与移动 —— 只有 WASD。 */
  moveVec(out = { mx: 0, mz: 0 }) {
    /* ★ 自由查看视角是"绕着人看"，不是"开飞行器" → 这里返回 0，
     *   但角色本身照常能走（不然想转着看他跑步就做不到）。 */
    let f = 0, d = 0;
    if (this.has('KeyW')) f += 1;
    if (this.has('KeyS')) f -= 1;
    if (this.has('KeyD')) d += 1;
    if (this.has('KeyA')) d -= 1;
    // 前 = (sin yaw, cos yaw)；右 = cross(前, 上) = (-cos yaw, sin yaw)
    const fx = Math.sin(this.camYaw), fz = Math.cos(this.camYaw);
    const rx = -Math.cos(this.camYaw), rz = Math.sin(this.camYaw);
    out.mx = fx * f + rx * d;
    out.mz = fz * f + rz * d;
    // 触屏摇杆：屏幕方向（上/右）也要过 camYaw 变换 → 相机相对，和键盘 WASD 一致。
    // 之前直接加原始值 → 世界固定方向，相机一转摇杆就和准星对不上。
    const tm = this.touchMove;
    if (tm.mx || tm.mz) {
      out.mx += fx * tm.mz + rx * tm.mx;
      out.mz += fz * tm.mz + rz * tm.mx;
    }
    const l = Math.hypot(out.mx, out.mz);
    if (l > 1) { out.mx /= l; out.mz /= l; }
    out.sprint = this.has('ShiftLeft') || this.has('ShiftRight') || tm.sprint;
    out.jump = this.has('Space');
    out.walk = this.has('ControlLeft') || this.has('ControlRight') || tm.walk;
    return out;
  }

  /** 准星方向：屏幕中心射线打到地面 */
  updateAim(fromX, fromZ, fromY = 1.0) {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    let hit = null;
    if (dir.y < -0.02) {
      const t = (C.BALL_R - (this.camera.position.y)) / dir.y;
      if (t > 0) {
        hit = this.camera.position.clone().addScaledVector(dir, Math.min(t, 120));
      }
    }
    if (!hit) {
      hit = this.camera.position.clone().addScaledVector(dir, 40);
      hit.y = C.BALL_R;
    }
    hit.y = C.BALL_R;
    // 限制在球场范围，避免瞄到场外很远
    hit.x = Math.max(-C.FIELD.HALF_L - 4, Math.min(C.FIELD.HALF_L + 4, hit.x));
    hit.z = Math.max(-C.FIELD.HALF_W - 4, Math.min(C.FIELD.HALF_W + 4, hit.z));
    this.aim.copy(hit);
    this.aimValid = true;
    return hit;
  }

  /**
   * 踢球方向（从角色/球指向准星），仰角由鼠标上下决定：
   * 默认视线 ≈ 低平球；抬头（看向天空）≈ 高吊（球明显往上抛）；压低视线 ≈ 贴地斩。
   * 仰角公式在 shared.js pitchToElev，服务端出球/客户端预览线共用 → 预览即实战。
   */
  kickDir(px, pz) {
    const a = this.aim;
    let dx = a.x - px, dz = a.z - pz;
    const l = Math.hypot(dx, dz);
    if (l < 0.001) { dx = Math.sin(this.camYaw); dz = Math.cos(this.camYaw); }
    else { dx /= l; dz /= l; }
    const e = SH.pitchToElev(this.camPitch);
    return { x: dx, y: Math.tan(e), z: dz };
  }

  /** 镜头冲击（进球 / 铲人 / 扑救等）：amp 力度、dur 时长 */
  shake(amp = 0.3, dur = 0.35) {
    this.shakeAmp = Math.max(this.shakeAmp, amp);
    this.shakeT = Math.max(this.shakeT, dur);
    this.shakeDur = Math.max(this.shakeDur || dur, dur);
  }

  update(dt, target, speed = 0) {
    // 蓄力
    if (this.charging) {
      const held = (performance.now() - this.chargeStart) / 1000;
      this.charge = Math.min(1, Math.max(0, (held - 0.06) / C.MAX_CHARGE));
    }
    // 冲刺视效：速度越接近极速，FOV 拉得越大、机位越压低（速度感）
    const sfx = clamp((speed - 3.5) / 5.0, 0, 1);
    this.speedFx += (sfx - this.speedFx) * (1 - Math.exp(-6 * dt));
    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
    const tx = target.x, ty = target.y, tz = target.z;

    /* ★★ near 的统一管理 —— **必须放在所有分支的最前面**。
     *  踩过的坑：原先写在第一人称分支后面，想着"离开 fps 就会往下走到这里还原"，
     *  但自由视角分支在 fps 分支之前就 return 了 → 「fps → 自由视角」这一跳
     *  永远走不到还原代码，near 卡在 0.22（自由视角看自己会被切掉一块脖子）。
     *  现在改为：**每帧先按当前模式设定 near**，与走哪条分支无关。 */
    {
      const wantNear = this.fpsCam ? FPS_NEAR : TP_NEAR;
      if (Math.abs(this.camera.near - wantNear) > 1e-4) {
        this.camera.near = wantNear;
        this.camera.updateProjectionMatrix();
      }
    }

    /* ---- 自由查看视角：**绕着角色转**（用户明确要求"可以围着角色旋转视角"）----
     *   相机始终围着「角色」这个球心转：鼠标环视 = 绕人转一圈，
     *   滚轮 = 拉近拉远（半径），R/F = 抬高/放低机位。
     *   ★ 之前做成"锚点 + WASD 平移锚点"是错的 —— 那会让人从取景框里跑出去，
     *     实际想要的是"像看展品一样绕着人转"。所以这里锁定球心 = 角色位置
     *     （跟得很紧，指数 30，人走动时依然围着他转）。 */
    if (this.freeCam) {
      this.freeAnchor.set(tx, ty, tz);          // 球心 = 角色（紧跟随）
      const want = new THREE.Vector3(
        this.freeAnchor.x - Math.sin(this.camYaw) * this.freeDist * cp,
        this.freeAnchor.y + 1.05 + sp * this.freeDist,
        this.freeAnchor.z - Math.cos(this.camYaw) * this.freeDist * cp
      );
      if (want.y < 0.35) want.y = 0.35;
      /* 半径也用 R/F 微调（滚轮改 freeDist，这里只做高度微调） */
      if (this.has('KeyR')) this.freeHeight = Math.min(6, (this.freeHeight || 0) + 4 * dt);
      if (this.has('KeyF')) this.freeHeight = Math.max(-1.2, (this.freeHeight || 0) - 4 * dt);
      want.y += (this.freeHeight || 0);
      this.freePos.lerp(want, 1 - Math.exp(-24 * dt));
      this.camera.position.copy(this.freePos);
      /* 注视点 = 角色躯干中部（这样无论怎么转，人都稳稳在画面中央） */
      this.camera.lookAt(this.freeAnchor.x, this.freeAnchor.y + 0.95 + (this.freeHeight || 0) * 0.25, this.freeAnchor.z);
      this.camera.fov += (this.baseFov - this.camera.fov) * (1 - Math.exp(-8 * dt));
      this.camera.updateProjectionMatrix();
      return;
    }

    /* ============================================================
     *  ★★ 第一人称（FPS 球员视角）—— 学习主流足球游戏
     *  相机架在自己**头部**，视线由鼠标 yaw/pitch 直接驱动；
     *  不做"注视点"那套（lookAt 会引入跟随滞后，第一人称必须严格锁死在视线方向）。
     *  速度/移动与服务端完全不受影响（用户要求"实际奔跑速度跟第三人称一样"）。
     * ============================================================ */
    if (this.fpsCam) {
      /* 眼位：优先取头部骨骼的世界坐标（跟着跑步/起跳/倒地一起动），
       * 拿不到（模型还没加载完）就退回"脚底 + 1.62m"。 */
      let ex = tx, ey = ty + FPS_EYE_FALLBACK_Y, ez = tz;
      if (this.getEyePos) {
        const e = this.getEyePos();
        if (e) { ex = e.x; ey = e.y; ez = e.z; }
      }
      /* 第一人称**不做位置平滑**：相机必须严格贴着头，
       * 平滑会让画面在急停/变向时"飘出脑袋"（戴着别人的头看世界）。 */
      this.camera.position.set(ex, ey, ez);

      // 抖动照样要（进球/铲人时镜头晃，第一人称尤其需要）
      if (this.shakeT > 0) {
        this.shakeT -= dt;
        const k = Math.max(0, this.shakeT / (this.shakeDur || 0.35));
        const a = this.shakeAmp * k * k;
        this.camera.position.x += (Math.random() - 0.5) * a;
        this.camera.position.y += (Math.random() - 0.5) * a * 0.8;
        this.camera.position.z += (Math.random() - 0.5) * a;
        if (this.shakeT <= 0) this.shakeAmp = 0;
      }

      /* 视线方向：与水平移动共用 camYaw（保证 WASD 朝你看的方向走），
       * 俯仰减去 FPS_PITCH_BIAS 让"平视"落在 camPitch=0.32（= 第三人称默认值）。
       * 注意 y 分量的符号：**camPitch 越大 = 越低**（与 pitchToElev 的约定一致），
       * 所以前向 y = -sin(p)。曾经想当然写成 +sin(p) → 鼠标往下推画面反而抬头。 */
      const fp = this.camPitch - FPS_PITCH_BIAS;
      const fcp = Math.cos(fp), fsp = Math.sin(fp);
      this.camLook.set(
        ex + Math.sin(this.camYaw) * fcp,
        ey - fsp,
        ez + Math.cos(this.camYaw) * fcp
      );
      this.camera.lookAt(this.camLook);
      /* FOV：第一人称保持基础视角（不做冲刺拉 FOV —— 贴地视角拉 FOV
       * 眩晕感极强，FC 的球员镜头也不拉）。 */
      this.camera.fov += (this.baseFov - this.camera.fov) * (1 - Math.exp(-8 * dt));
      this.camera.updateProjectionMatrix();
      return;
    }

    // 冲刺时相机稍远一点、低一点，视野更沉浸
    const dist = this.dist * (1 + 0.06 * this.speedFx);
    const want = new THREE.Vector3(
      tx - Math.sin(this.camYaw) * dist * cp,
      ty + 1.55 + sp * dist - 0.16 * this.speedFx,
      tz - Math.cos(this.camYaw) * dist * cp
    );
    if (want.y < 0.7) want.y = 0.7;
    // 目标位置本身已是平滑过的渲染位置，这里只留很轻的平滑，别再叠一层滞后
    this.camPos.lerp(want, 1 - Math.exp(-35 * dt));
    this.camera.position.copy(this.camPos);
    // 抖动（指数衰减）
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const k = Math.max(0, this.shakeT / (this.shakeDur || 0.35));
      const a = this.shakeAmp * k * k;
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.y += (Math.random() - 0.5) * a * 0.8;
      this.camera.position.z += (Math.random() - 0.5) * a;
      if (this.shakeT <= 0) { this.shakeAmp = 0; }
    }
    this.camLook.set(tx, ty + 1.25, tz);      // 注视点即时跟随，消除甩尾
    this.camera.lookAt(this.camLook);
    // 持球时收窄 FOV、出球后放开 —— 实况/FC 那种"镜头跟着球走"的动态视野。
    //   拾球/出球不是瞬间切，用指数缓动（≈0.4s）平滑过渡。
    const holdingNow = (this.isHoldingBall && this.isHoldingBall()) ? 1 : 0;
    this.holdFx += (holdingNow - this.holdFx) * (1 - Math.exp(-3.6 * dt));
    // 冲刺拉 FOV + 持球收 FOV（每帧朝目标值平滑）
    //   持球收窄幅度 8.5 → 13.5 → 21：8.5 完全感觉不到、13.5 也偏弱，21 才明确"镜头推近"
    const wantFov = this.baseFov + 9 * this.speedFx - 21 * this.holdFx;
    this.camera.fov += (wantFov - this.camera.fov) * (1 - Math.exp(-8 * dt));
    this.camera.updateProjectionMatrix();
  }
}
