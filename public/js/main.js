import * as THREE from 'three';
import { buildWorld, makeBall } from './world.js';
import { loadAssets, cloneCharacter, fetchAssetVersion } from './animations.js';
import { Character } from './character.js';
import { Controls, TOUCH } from './input.js';
import { TouchControls, installModeSwitch } from './touch.js';
import { audio } from './audio.js';
import { CardBar } from './card.js';
import { BetShop } from './shop.js';
import { Ambulance } from './ambulance.js';
import { Commentary } from './commentary.js';
import { Jumbotron } from './jumbotron.js';
import { createPostFX } from './postfx.js';

const SH = window.SHARED;
const C = SH.C;
const { clamp, lerp, angLerp, angDelta } = SH;

/* 比分栏队色：从 shared.js 的 TEAMS 注入 CSS 变量，改队色只需改一处 */
document.documentElement.style.setProperty('--team-a', C.TEAMS.A.color);
document.documentElement.style.setProperty('--team-b', C.TEAMS.B.color);

/* ============================================================
 *  渲染基础
 * ============================================================ */
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.00;      // 曝光：基准 1.0（再往下就偏暗了）
renderer.outputColorSpace = THREE.SRGBColorSpace;

/** 环境贴图用的「天空→草地」渐变（亮度全部 ≤1，安全 —— 不会像物理天空的 HDR 那样把画面冲白） */
function envGradientTexture() {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 32;
  const g = cv.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 32);
  grd.addColorStop(0.00, '#9ecdf2');    // 天顶：偏蓝
  grd.addColorStop(0.42, '#dcecf8');    // 地平线上：接近白
  grd.addColorStop(0.52, '#c6d8b8');    // 地平线下：草地的反光
  grd.addColorStop(1.00, '#5c7d4e');    // 地面
  g.fillStyle = grd; g.fillRect(0, 0, 64, 32);
  const t = new THREE.CanvasTexture(cv);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 800);
camera.position.set(0, 6, -14);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (fx) fx.setSize(innerWidth, innerHeight);
});

/* ============================================================
 *  UI
 * ============================================================ */
const $ = (id) => document.getElementById(id);

const ui = {
  loading: $('loading'), lbar: $('lbar'), ltxt: $('ltxt'),
  start: $('start'), nameIn: $('nameIn'), joinBtn: $('joinBtn'), teamPick: $('teamPick'),
  tagA: $('tagA'), tagB: $('tagB'),
  hud: $('hud'), clock: $('clock'),
  /* ★ 新版计分牌（scoreboard-component.html 版式）：比分在中间一格，是 "A-B" 合并串 */
  scoreNum: $('scoreNum'), msScore: $('msScore'), msGoal: $('msGoal'),
  teamAName: document.querySelector('#score .ms-team.home .fcName'),
  teamBName: document.querySelector('#score .ms-team.away .fcName'),
  teamABox: document.querySelector('#score .ms-team.home'),
  teamBBox: document.querySelector('#score .ms-team.away'),
  modeTxt: $('modeTxt'), modeBox: $('modeBox'), teamTag: $('teamTag'), coinBox: $('coinBox'), coinTxt: $('coinTxt'),
  chargeWrap: $('chargeWrap'), chargeBar: $('chargeBar'),
  ballHint: $('ballHint'), actionHint: $('actionHint'), lockTag: $('lockTag'), banner: $('banner'), feed: $('killfeed'),
  chatLog: $('chatLog'), chatIn: $('chatIn'), chatTip: $('chatTip'),
  cheerBadge: $('cheerBadge'), emoteWheel: $('emoteWheel'), ewRing: $('ewRing'),
  hpFill: $('hpFill'), hpTxt: $('hpTxt'), hpWrap: $('hpWrap'), speedTxt: $('speedTxt'), speedBar: $('speedBar'),
  net: $('net'), lockTip: $('lockTip'), holdFx: $('holdFx'),
  /* ★ 击球点球 UI（右下角）：红点 = 触球部位 */
  ballCtl: $('ballCtl'), ballDot: $('ballDot'), bcLabel: $('bcLabel'),
};

let bannerTimer = 0;
function banner(text, color, sec = 2.4) {
  ui.banner.textContent = text;
  ui.banner.style.color = color || '#9fefff';
  ui.banner.hidden = false;
  ui.banner.style.animation = 'none';
  void ui.banner.offsetWidth;
  ui.banner.style.animation = '';
  bannerTimer = sec;
}
/* 进球横幅（EA FC 式：斜向扫入 → 停住 → 斜向扫出）+ 计分牌比分格弹一下 */
let scorePopT = 0;
let msGoalT = 0;                            // 计分牌里 GOAL 黄牌的收起计时
let lastScorer = null;                      // { name, team, t } 最近一个进球者
function scorePop(prevA, prevB) {
  const el = document.getElementById('goalBanner');
  const aUp = scores.A > prevA, bUp = scores.B > prevB;
  if (el) {
    const gbA = document.getElementById('gbA'), gbB = document.getElementById('gbB');
    if (gbA) gbA.textContent = scores.A;
    if (gbB) gbB.textContent = scores.B;
    const sc = document.getElementById('gbScorer');
    const fresh = lastScorer && performance.now() - lastScorer.t < 2500 ? lastScorer : null;
    if (sc) sc.textContent = fresh ? fresh.name : (aUp ? C.TEAMS.A.name : C.TEAMS.B.name);
    // 队色斜条 / 字色跟着进球方走
    const col = fresh ? (C.TEAMS[fresh.team] ? C.TEAMS[fresh.team].color : '#5ce1ff')
                      : (aUp ? C.TEAMS.A.color : C.TEAMS.B.color);
    el.style.setProperty('--gb', col);
    el.hidden = false;
    el.classList.remove('on');
    void el.offsetWidth;                    // 强制重排 → 动画能重新播放
    el.classList.add('on');
    clearTimeout(scorePopT);
    scorePopT = setTimeout(() => { el.hidden = true; el.classList.remove('on'); }, 4100);
  }
  // 计分牌：比分格弹一下 + 比分数字滚动 + 计时条位置落一块 GOAL 黄牌
  if (ui.msScore) {
    ui.msScore.classList.remove('hit');
    void ui.msScore.offsetWidth;                    // 强制重排 → 动画能重新播
    ui.msScore.classList.add('hit');
    setTimeout(() => ui.msScore.classList.remove('hit'), 900);
  }
  if (ui.scoreNum) {
    ui.scoreNum.classList.remove('rolling');
    void ui.scoreNum.offsetWidth;
    ui.scoreNum.classList.add('rolling');
    setTimeout(() => ui.scoreNum.classList.remove('rolling'), 520);
  }
  if (ui.msGoal) {
    ui.msGoal.classList.remove('show');
    void ui.msGoal.offsetWidth;
    ui.msGoal.classList.add('show');
    clearTimeout(msGoalT);
    msGoalT = setTimeout(() => ui.msGoal.classList.remove('show'), 3000);
  }
  // 进球方的队名格亮一下（谁进的球，计分牌上直接看得出来）
  const upBox = aUp ? ui.teamABox : (bUp ? ui.teamBBox : null);
  if (upBox) {
    upBox.classList.remove('scored');
    void upBox.offsetWidth;
    upBox.classList.add('scored');
    setTimeout(() => upBox.classList.remove('scored'), 1200);
  }
}

function feed(html) {
  // 顺手把最新战报推到角看台大屏的走字条
  if (jumbo) jumbo.push(String(html).replace(/<[^>]*>/g, ''));
  const d = document.createElement('div');
  d.innerHTML = html;
  ui.feed.appendChild(d);
  setTimeout(() => d.remove(), 6000);
  while (ui.feed.children.length > 5) ui.feed.firstChild.remove();
}

/* ============================================================
 *  资源载入
 * ============================================================ */
let ASSETS = null;
let world = null, ballObj = null;
const introStart = performance.now();   // FK26 开场动画的计时起点（保证最短展示时长）

/* ---- 后台补加载剩余动作（舞蹈/攻击/门将等）----
 * 核心动作只占 29%，其余等玩家在开始界面停留/进游戏后慢慢拉，不挡首屏。
 * 已建立的角色用 Character.addClips 增量挂上；补完时还没建的角色（比如进游戏后才
 * 收到别人 join），在 syncChar 创建那一刻补挂 —— 所以这里要把结果**缓存住**。 */
let lazyBag = null;
let lazyStarted = false;
function warmLazyClips() {
  if (lazyStarted || !ASSETS || !ASSETS.loadLazy) return;
  lazyStarted = true;
  const run = () => ASSETS.loadLazy().then((bag) => {
    if (!bag || !Object.keys(bag).length) return;
    lazyBag = bag;
    let n = 0;
    for (const [, e] of chars) if (e && e.ch) { e.ch.addClips(bag); n++; }
    console.log('[人物] 已把 ' + Object.keys(bag).length + ' 个后台动作补挂到 ' + n + ' 个已存在角色');
  }).catch(() => { lazyStarted = false; });
  if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 2500 });
  else setTimeout(run, 1200);
}
window.__warmLazy = warmLazyClips;      // 测试脚本可手动触发
window.__lazyBag = () => lazyBag;       // 测试脚本可查询补加载结果

/* ---- 资源载入（先取资源指纹，再拉模型/动作）----
 * 版本号由服务端按文件内容算，所以「换了动作文件 → 客户端自动拿到新 ?v= → 不再吃旧缓存」。
 * 另外做一次**版本变更自愈**：如果本次拿到的版本和上次记录的不同，说明服务端刚更新过，
 * 直接 reload 一次，保证玩家不会停留在旧资源的页面上（这个坑实测踩过）。 */
(async () => {
  const VER_KEY = 'fk26.assetVer';
  let ver = '';
  try { ver = await fetchAssetVersion(); } catch (e) {}
  try {
    const last = localStorage.getItem(VER_KEY);
    if (ver && last && last !== ver) {
      localStorage.setItem(VER_KEY, ver);
      console.log('[资源] 版本更新 ' + last + ' → ' + ver + '，刷新以加载新资源');
      location.reload();
      return;
    }
    if (ver) localStorage.setItem(VER_KEY, ver);
  } catch (e) {}

  loadAssets((p) => {
    ui.lbar.style.width = (p * 100).toFixed(0) + '%';
    ui.ltxt.textContent = p < 1 ? `载入动作模型 ${(p * 100) | 0}%` : '球场生成中…';
  }).then((a) => {
    ASSETS = a;
    ui.lbar.style.width = '100%';
    ui.ltxt.textContent = '就绪';
    /* FK26 开场必须被看见 —— 本地加载只要 0.3s，硬切会让艺术字一帧都看不到。
     * 所以设一个最短展示时长，等字母渐隐浮出 + 底线拉开（约 1.5s）再淡出。
     * ★ 注意：#loading 与 #start 同为 z-index 50，谁在 DOM 后面谁盖住谁 ——
     *   必须等淡出**结束**才把 #start 显示出来，否则开始界面会立刻盖掉开场动画。 */
    const MIN_INTRO_MS = 1500;
    const wait = Math.max(0, MIN_INTRO_MS - (performance.now() - introStart));
    setTimeout(() => { ui.loading.classList.add('leaving'); }, wait);
    setTimeout(() => {
      ui.loading.hidden = true;
      ui.loading.classList.remove('leaving');
      ui.start.hidden = false;
      document.body.classList.add('in-menu');   // 菜单期间隐藏右上角 HUD 按钮
      ui.nameIn.focus();
      /* ★ 用户要求"进入游戏的第一个选择页面的背景直接斜角实时俯视球场"。
       *   在这里就把世界建出来 + 摆好**斜角实时俯视**的机位 ——
       *   因为开始界面（#start）是半透明的，背后就是真实渲染的球场（活的：
       *   广告牌在换主题、大屏在走字、看台有人），不是一张静态图。
       *   进入球场时（join）再把相机交还给控制系统。 */
      enterMenuCam();
    }, wait + 540);
    warmLazyClips();                    // 开场期间就把剩余动作拉起来（不挡画面）
  }).catch((e) => {
    ui.ltxt.textContent = '载入失败：' + e.message;
    console.error(e);
  });
})();

/* ============================================================
 *  ★ 开始界面的"斜角实时俯视球场"机位
 *
 *  用户要求"进入游戏的第一个选择页面的背景直接斜角实时俯视球场"。
 *  #start 是半透明层，背后是**真实渲染**的球场（活的：广告牌在换主题、
 *  大屏在走字、看台有人）—— 不是一张静态图。
 *
 *  做法：menuCam 打开时，主循环跳过 controls.update()，改成让相机沿一条
 *  缓慢的环绕轨迹俯视球场（高 26m、斜下 38° 左右），同时给一点点推进，
 *  画面就"活"了。进入球场（join → controls 接管）时关掉即可无缝交还。
 * ============================================================ */
let menuCam = false;
let menuT = 0;

/* ============================================================
 *  开始界面：两侧红/蓝球衣模型选队（独立 UI 场景）
 * ------------------------------------------------------------
 *  ★ 用户要求：
 *   · 背景**只保留场馆视角**（不再实时渲染别人踢球 → 不再连观战）
 *   · 两个队用穿红/蓝球衣的**模型站在两侧**当 UI
 *   · 平时播 `happyIdle`，鼠标悬停播 `salute`（点一下就切换队）
 *   · 旧的选队卡片全部删掉，底部做成一条（左输入框 / 右加入按钮）
 *
 *  为什么用**独立场景**：如果直接放进主场景，模型会被"绕着球场飞"的
 *  转播机位带着跑、还会悬在 30m 高空（看着像飞天）。独立场景 + 独立相机
 *  可以固定投影到屏幕两侧，和背景球场互不干扰。
 * ============================================================ */
const MENU_TEAMS = [
  { team: 'A', x: -1.32 },     // 左 = 红队
  { team: 'B', x: 1.32 },      // 右 = 蓝队
];
const MENU_FEET_Y = -0.35;        // 模型脚底的 y（取景基准，和 UI 相机的 0.415 配套）
const menuUI = { scene: null, cam: null, items: [], ready: false, hover: null };
const menuRay = new THREE.Raycaster();
const _menuV = new THREE.Vector3();
const menuNdc = new THREE.Vector2();

function buildMenuUI() {
  if (menuUI.ready || !ASSETS) return;
  const sc = new THREE.Scene();
  // 灯光：环境 + 主光 + 冷补光 + 轮廓光（队服红/蓝才立得住，不然会发灰）
  sc.add(new THREE.HemisphereLight(0xdcecff, 0x2b3446, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.3); key.position.set(1.9, 3.2, 3.6); sc.add(key);
  const fill = new THREE.DirectionalLight(0x9dc2ff, 1.0); fill.position.set(-3.0, 1.2, 1.6); sc.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 1.5); rim.position.set(-0.8, 2.6, -4.0); sc.add(rim);

  /* 取景：模型脚底放在 y=-0.35、相机平视 y=0.415、距离 5.09（fov 30）。
   * 这样身体占画面 12%~78% 的高度 —— 头顶留 12% 余量、脚底在底条之上，
   * 队名标签正好塞在脚底和底条之间。改这几个数要一起动，否则脚会被裁掉。 */
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
  cam.position.set(0, 0.415, 5.09);
  cam.lookAt(0, 0.415, 0);

  menuUI.scene = sc;
  menuUI.cam = cam;

  // 只挂这两个展示动作，模型不参与比赛动画
  const clips = { happyIdle: ASSETS.clips.happyIdle, salute: ASSETS.clips.salute };

  for (const def of MENU_TEAMS) {
    const { holder, inner } = cloneCharacter(ASSETS.model, ASSETS.unitScale);
    holder.position.set(def.x, MENU_FEET_Y, 0);
    sc.add(holder);
    const ch = new Character(holder, inner, clips, {
      teamColor: C.TEAMS[def.team].color,
      unitScale: ASSETS.unitScale,
      kitTex: ASSETS.kitTex ? ASSETS.kitTex[def.team] : null,
    });
    ch.marker.visible = false;                 // 头顶三角是比赛 HUD，菜单里不要
    if (ch.label) ch.label.visible = false;
    /* 敬礼：**单次**播放，停在最后一帧（悬停一次敬一次；不循环，否则像机器人）
     * 注意 Character 默认按 ONE_SHOT_CLIPS 决定 loop，这里两个都是循环动作，
     * 所以手动改成 LoopOnce。 */
    if (ch.actions.salute) {
      ch.actions.salute.setLoop(THREE.LoopOnce, 1);
      ch.actions.salute.clampWhenFinished = true;
    }
    // 点击热区：透明代理盒（比逐顶点 raycast 蒙皮网格便宜得多，也稳）
    const proxy = new THREE.Mesh(
      new THREE.BoxGeometry(0.86, 2.05, 0.7),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    proxy.position.set(def.x, 0.30, 0);
    proxy.userData.team = def.team;
    sc.add(proxy);

    menuUI.items.push({ team: def.team, x: def.x, holder, ch, proxy, hovered: false });
  }
  menuUI.ready = true;
  syncPickUI();
  console.log('[菜单] 选队模型就绪（红/蓝各 1 个，动作 salute ' +
    (ASSETS.clips.salute ? ASSETS.clips.salute.duration.toFixed(2) + 's' : '缺失') + ' / happyIdle ' +
    (ASSETS.clips.happyIdle ? ASSETS.clips.happyIdle.duration.toFixed(2) + 's' : '缺失') + '）');
}

/** 每帧推进两个模型（悬停 → 敬礼；否则 → 开心待机） */
function updateMenuUI(dt) {
  if (!menuUI.ready) return;
  for (const it of menuUI.items) {
    it.ch.update(dt, {
      x: it.x, y: MENU_FEET_Y, z: 0, yaw: 0,
      anim: it.hovered ? 'salute' : 'happyIdle', animSpd: 1, hp: 100,
    });
    // 选中的队：脚下光圈亮起并放大一点；未选中压暗
    const sel = pickTeam === it.team;
    const rm = it.ch.ring.material;
    rm.opacity = sel ? 0.95 : (it.hovered ? 0.45 : 0.16);
    const rs = sel ? 1.28 : 1;
    it.ch.ring.scale.setScalar(it.ch.ring.scale.x + (rs - it.ch.ring.scale.x) * (1 - Math.exp(-10 * dt)));
    /* 队名标签钉在脚底正下方：把脚底点投影到屏幕再写 left/bottom。
     * 写死百分比在窄窗口会错位（模型 x 是固定米数，NDC 随 aspect 变）。 */
    const el = it.team === 'A' ? ui.tagA : ui.tagB;
    if (el) {
      _menuV.set(it.x, MENU_FEET_Y, 0).project(menuUI.cam);
      const W = window.innerWidth, H = window.innerHeight;
      el.style.left = ((_menuV.x * 0.5 + 0.5) * 100).toFixed(2) + '%';
      // bottom = 脚底到视口底的距离 - 标签自身高度 - 间隙 → 标签落在**脚下方**
      el.style.bottom = Math.max(92, H - (_menuV.y * -0.5 + 0.5) * H - 68).toFixed(0) + 'px';
    }
  }
}

/** 把 UI 场景叠在主画面之上（不参与后处理，画质档影响不到它） */
function drawMenuUI() {
  if (!menuUI.ready) return;
  menuUI.cam.aspect = camera.aspect;
  menuUI.cam.updateProjectionMatrix();
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.render(menuUI.scene, menuUI.cam);
  renderer.autoClear = true;
}

/** 屏幕坐标 → 命中的模型（没有则 null） */
function menuHit(clientX, clientY) {
  if (!menuUI.ready) return null;
  /* ★ 每次命中前同步一下投影矩阵：`menuUI.cam.aspect` 平时是 drawMenuUI() 每帧更新的，
   *   但**首帧之前、窗口 resize 之后、或标签页被浏览器暂停 rAF 时**它还是旧值（初始 1.0）
   *   → raycaster 用错的比例算方向 → 明明点在模型上也打空（表现成"点模型没反应"）。 */
  menuUI.cam.aspect = camera.aspect;
  menuUI.cam.updateProjectionMatrix();
  const r = renderer.domElement.getBoundingClientRect();
  menuNdc.x = ((clientX - r.left) / r.width) * 2 - 1;
  menuNdc.y = -((clientY - r.top) / r.height) * 2 + 1;
  menuRay.setFromCamera(menuNdc, menuUI.cam);
  const hit = menuRay.intersectObjects(menuUI.items.map((i) => i.proxy), false)[0];
  if (!hit) return null;
  return menuUI.items.find((i) => i.proxy === hit.object) || null;
}

function enterMenuCam() {
  ensureWorld();
  if (!world) return;
  menuCam = true;
  menuT = 0;
  camera.fov = 46; camera.updateProjectionMatrix();
  buildMenuUI();
  /* ★ 用户要求"场馆渲染只要球场视角、不用实时渲染踢球" → 不再连观战。
   *   机位直接摆到环绕位，避免第一帧从 (0,0,0) 飞过去。 */
  const a = -2.35, R = 46, H = 30.5;
  camera.position.set(Math.cos(a) * R, H, Math.sin(a) * R);
  camera.lookAt(0, 2.2, 0);
}

/** 纯场馆环绕：绕球场中心缓慢转圈（不再跟随球员） */
function updateMenuCam(dt) {
  menuT += dt;
  const a = -2.35 + menuT * 0.022;          // 一圈约 5 分钟，慢到不抢戏
  const R = 46, H = 30.5;
  camera.position.set(Math.cos(a) * R, H, Math.sin(a) * R);
  camera.lookAt(0, 2.2, 0);
}

/* ============================================================
 *  世界
 * ============================================================ */
let fx = null;                  // 后处理（转播调色 / 泛光 / MSAA）
// 主光方向（与 world.js 的 sun.position 一致）→ 给滤镜算阳光光柱
const sunDir = new THREE.Vector3(-78, 66, 44).normalize();
const sunPt = new THREE.Vector3();
let jumbo = null;               // 角看台大屏
function ensureWorld() {
  if (world) return;
  world = buildWorld(scene);
  // 环境贴图（低强度）：给所有 PBR 材质一点环境光与反射 —— 物体才有"泡在环境里"的立体感，
  // 而不是像被一盏灯打亮的平面。刻意用亮度 ≤1 的渐变（不用物理天空，那个 HDR 会把画面冲白）。
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromEquirectangular(envGradientTexture());
    scene.environment = rt.texture;
    scene.environmentIntensity = 0.28;             // 天光强度（0.45 会把整体提亮过头）
    pmrem.dispose();
  } catch (e) { console.warn('环境贴图生成失败，退回纯灯光', e); }
  ballObj = makeBall();
  scene.add(ballObj);
  ambulance = new Ambulance(scene, C.FIELD, C.AMB_PARK);
  // 大屏（角看台）+ 电视转播观感后处理
  jumbo = new Jumbotron(scene, C.FIELD, { teams: C.TEAMS });
  fx = createPostFX(renderer, scene, camera, {
    onAuto: (from, to) => {
      if (to === 'mid') banner('帧率偏低，画质自动降到「标准」', '#9fefff', 2.2);
      else if (to === 'off') banner('帧率较低，已关闭滤镜', '#9fefff', 2.2);
    },
  });

  /* 实时射门弹道线：持球按住右键/左键时显示将要打出的抛物线（随力度条实时变化） */
  TRAJ_N = 26;
  const mkLine = (color) => {
    const arr = new Float32Array(TRAJ_N * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const ln = new THREE.Line(tg, new THREE.LineBasicMaterial({
      color, transparent: true, opacity: 0.9, depthWrite: false,
    }));
    ln.frustumCulled = false;
    ln.visible = false;
    scene.add(ln);
    return ln;
  };
  trajLine = mkLine('#7cb8ff');       // 射门线（冷蓝）
  trajLinePass = mkLine('#6ee7a8');   // 传球线（绿）
}

let TRAJ_N = 0, TRAJ_POS = null, trajLine = null, trajLinePass = null;

/** 用与服务器一致的球物理预览弹道（力度条实时变化）。
 *  出球速度走 shared.js kickVelocity —— 和服务端同一个函数，
 *  抬头瞄准 → 线明显上吊（高球），压低 → 贴地线，预览即实战。
 *  ★ v2：带上击球点的自旋（Magnus 弧线）+ 偏心掉力量，红点移到边上预览线真的会拐弯。 */
function updateTrajectory(now) {
  const holding = ME.dribbling && BALL.owner === myId;
  const show = holding && controls.charging;
  if (!show) { trajLine.visible = false; trajLinePass.visible = false; return; }
  const dir = controls.kickDir(BALL.x, BALL.z);
  const isShoot = controls.chargeType === 'shoot';
  const hi = isShoot ? C.KICK_SHOOT : C.KICK_PASS;
  const lo = hi * (isShoot ? 0.45 : 0.5);
  /* 与服务端 tryKick 同一公式 + 击球点偏心掉力量 */
  const spin = SH.spinFromSpot(controls.ballSpot.x, controls.ballSpot.y);
  const spotOff = Math.min(1, Math.hypot(controls.ballSpot.x, controls.ballSpot.y));
  const spd = (lo + (hi - lo) * controls.charge) * spin.powerMul;
  const kv = SH.kickVelocity(dir, spd, spotOff);
  const vx = kv.vx, vy = kv.vy, vz = kv.vz;
  const line = isShoot ? trajLine : trajLinePass;
  (isShoot ? trajLinePass : trajLine).visible = false;
  line.visible = true;
  const arr = line.geometry.attributes.position.array;
  // 高球飞行时间更长：线画到「飞 15m 或落地」为止，抬头时能看到完整的上吊弧线
  const flight = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * C.GRAVITY * Math.max(0, BALL.y - C.BALL_R)))) / C.GRAVITY;
  const T = Math.min(Math.max(0.45, flight), 1.2);   // 贴地球 vy=0 → 画一段地平线也看得见
  /* 弧线积分：与服务端 stepBall 同一套 Magnus 力（每步重算水平飞行方向），红点偏移看得见弧度 */
  const N = TRAJ_N, DT = T / (N - 1);
  let bx = BALL.x, by = BALL.y, bz = BALL.z, bvx = vx, bvy = vy, bvz = vz;
  for (let i = 0; i < N; i++) {
    arr[i * 3] = bx;
    arr[i * 3 + 1] = Math.max(C.BALL_R, by);
    arr[i * 3 + 2] = bz;
    /* 半隐式欧拉一步 —— 直接调 SH.magnusAccel（与 stepBall 同一个真实物理函数，
     * 预览线 = 实际飞行弧线，不再各写一份） */
    const ma = SH.magnusAccel(bvx, bvy, bvz, spin.wx, spin.wy, by);
    bvx += ma.ax * DT; bvy += ma.ay * DT; bvz += ma.az * DT;
    bvy -= C.GRAVITY * DT;
    const k = Math.exp(-C.BALL_AIR_DRAG * DT);
    bvx *= k; bvy *= k; bvz *= k;
    bx += bvx * DT; by += bvy * DT; bz += bvz * DT;
    if (by < C.BALL_R) { by = C.BALL_R; bvy = 0; }   // 落地后沿地面画
  }
  line.geometry.attributes.position.needsUpdate = true;
}

/* ============================================================
 *  网络 / 实体
 * ============================================================ */
let socket = null, myId = null, myTeam = null;
/* ★ 观战连接（用户要求："选择页就能直接看到真人玩家在游玩"）
 *   开始界面在点击"进入球场"**之前**就先连一条 spectate 连接：
 *     · 不占槽位、不产生实体，别人看不到你
 *     · 收的 state 与在场玩家**完全一样**（同一条广播流，不额外复制球场）
 *   → 于是选择页背后就是**别人真正在踢的实时画面**，而带宽成本 = 一个普通玩家。
 *   点进入时断开观战连接、以正式身份重连（状态最干净）。
 *
 * ⚠️ 用户要求**默认关闭**（2026-10-30）：这条连接会让停在开始界面的人
 *    每秒产生 4-5 个请求（30Hz state 广播），云端看着像一堆脚本在刷。
 *    想恢复"菜单里能看别人踢球"就设 window.__SOCCER_SPECTATE__ = true。
 */
const SPECTATE_ENABLED = (typeof window !== 'undefined') && window.__SOCCER_SPECTATE__ === true;
let spectateSocket = null;
function startSpectate() {
  if (!SPECTATE_ENABLED) return;              // 默认不建观战连接
  if (spectateSocket || socket) return;
  spectateSocket = io(location.origin, { query: { spectate: '1' }, transports: ['websocket'] });
  spectateSocket.on('connect', () => { if (ui.net) ui.net.textContent = '观战中'; });
  spectateSocket.on('disconnect', () => { spectateSocket = null; });
  /* 用**同一套**渲染管线消化观战的 state —— 收到就直接建角色/更新球，
   * 和进场后没有区别，所以"选择页看到的"就是"进场后看到的"。 */
  spectateSocket.on('state', (s) => { applyNetState(s); });
  spectateSocket.on('chat', (c) => {
    if (c.type === 'system') feed(`<span style="color:#8fa3b8">${c.text}</span>`);
    else feed(`<b>${c.name}</b>：${c.text}`);
  });
}
function stopSpectate() {
  if (!spectateSocket) return;
  try { spectateSocket.disconnect(); } catch (e) {}
  spectateSocket = null;
  // 观战期间建出来的角色要清掉（进场后会按正式 state 重新建）
  for (const id of [...chars.keys()]) removeChar(id);
  myId = null;
}
let touch = null;               // 触屏控制层（触屏设备才创建）
let cardBar = null;             // 属性卡物品栏
let shop = null;                // 押注商店（B 键）
let ambulance = null;           // 救护车（有球员复活时进场）
let speedShow = 0;              // 速度表显示值（平滑后）
let speedTick = 0;              // 速度表刷新计时
const COMMENT = new Commentary(audio);   // 解说引擎（实况风格）
const chars = new Map();          // id -> { ch, x,y,z, yaw, anim, animSpd, init }
const ME = {                      // 本地预测状态
  x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, vy: 0,
  anim: 'idle', animSpd: 1, dribbling: false, mode: 'soccer', slideT: 0,
};
const BALL = { x: 0, y: C.BALL_R, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, owner: null, snapT: 0, rx: 0, ry: C.BALL_R, rz: 0 };
let scores = { A: 0, B: 0 }, clock = C.MATCH_SEC;
let rtt = 0;
let controls = null;

/* 高频复用的临时对象（第一人称取眼位时每帧要用，避免每帧 new 出垃圾） */
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

function applyTeamTag() {
  const t = C.TEAMS[myTeam];
  ui.teamTag.textContent = `你被分到了 ${t.name}`;
  ui.teamTag.style.color = t.color;
  ui.teamTag.style.borderColor = t.color + '66';
}

let myName = '';
function join(name, team) {
  myName = name;
  document.body.classList.remove('in-menu');   // 进游戏：右上角按钮恢复
  stopSpectate();                 // ★ 断开观战连接（避免两条连接重复收 state）
  socket = io(location.origin, {
    query: { name, team: team || 'R' },     // team: 'A' 红队 / 'B' 蓝队 / 'R' 随机
    transports: ['websocket'],
    /* ★ 断线自动重连（原本没配，云端网络抖一下就永久断开，
       表现成「开局后自动失去连接」）。 */
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800,
    reconnectionDelayMax: 4000,
  });

  socket.on('connect', () => {
    /* 原本这里写的是「连接中…」，连上了还显示连接中，容易误判掉线 */
    if (ui.net) ui.net.textContent = '';
  });
  socket.on('disconnect', (reason) => {
    if (ui.net) ui.net.textContent = '重连中…';
    banner('连接中断，正在重连…', '#ffb020', 3);
  });
  socket.on('connect_error', (e) => { if (ui.net) ui.net.textContent = '重连中…'; console.warn(e); });
  socket.io.on('reconnect', () => { banner('已重新连接', '#35d07f', 2); });
  socket.on('serverFull', () => banner('服务器已满', '#ff6b7f', 4));

  socket.on('init', (d) => {
    myId = d.id; myTeam = d.team;
    scores = d.scores; clock = d.clock;
    ensureWorld();
    controls = new Controls(camera, canvas);
    menuCam = false;                 // ★ 交还相机给玩家控制（结束"选择页俯视"机位）
    camera.fov = controls.baseFov;   // 菜单用的是 46°，进场恢复玩家的基础 FOV
    camera.updateProjectionMatrix();
    wireControls();
    // 操作方案：触屏 / 键鼠，可随时用右下角按钮切换（选择会记住）
    applyTouchMode(TOUCH.on);
    installModeSwitch(() => TOUCH.on, applyTouchMode);
    // 出生点由服务端给（现在是从球员席入场）；拿不到才退回中圈
    const me = d.players.find((p) => p.id === d.id);
    ME.x = me ? me.x : 0; ME.z = me ? me.z : 0;
    ME.yaw = me ? (me.yaw || 0) : (d.team === 'A' ? 0 : Math.PI);
    for (const p of d.players) syncChar(p, true);
    ui.start.hidden = true;
    ui.hud.hidden = false;
    /* ★ 击球点球 UI：按 localStorage 里存的红点位置初始化（移动了就保持，不自动回中） */
    if (ui.ballCtl && ui.ballDot) {
      controls.onSpotChange(controls.ballSpot);
      ui.ballCtl.hidden = false;
    }
    preloadCheer();                                          // 庆祝语音预加载（进球后点一下就能响）
    setTimeout(() => { if (ui.chatTip) ui.chatTip.classList.add('fade'); }, 9000);
    applyTeamTag();
    banner(`你被分到了 ${C.TEAMS[d.team].name}`, C.TEAMS[d.team].color, 2.6);
    feed(`<b style="color:${C.TEAMS[d.team].color}">${C.TEAMS[d.team].name}</b> 欢迎 ${d.name || '你'}`);
    if (me && me.benchIn) feed('🏃 你从替补席入场，走上球场即可开踢');

    cardBar = new CardBar((slot) => {
      if (controls && controls.mode === 'attack') socket.emit('skill', { slot });   // 攻击模式 → 放技能
      else socket.emit('useCard', { slot });                                        // 踢球模式 → 用属性卡
    });

    // 押注商店（B 键）
    shop = new BetShop((payload) => socket.emit('bet', payload, (r) => {
      if (r && r.r === 'poor') shop.toast('金币不够了（每局固定押 100）');
      else if (r && r.r === 'cancel') shop.toast('已取消押注，本金退回');
    }));
    if (d.bet) shop.update(d.bet);
    if (d.amb && ambulance) ambulance.setState(d.amb);
    if (controls) controls.onShop = () => shop.toggle();
    socket.on('betUpdate', (s) => shop && shop.update(s));
    socket.on('betSettle', (e) => shop && shop.settle(e));

    // 输入心跳 20Hz
    setInterval(sendInput, 1000 / C.INPUT_HZ);
    // 延迟采样
    setInterval(() => {
      const t0 = performance.now();
      socket.emit('pingCheck', t0, (t) => {
        rtt = performance.now() - t;
        ui.net.textContent = rtt.toFixed(0) + ' ms';
      });
    }, 2000);
  });

  socket.on('state', applyNetState);

  socket.on('restartDone', () => { G_phaseIsPlay = true; });   // 死球结束 → 恢复氛围解说
  socket.on('matchResume', () => { G_phaseIsPlay = true; });
  socket.on('cheerIn', (d) => {
    if (!d || !d.clip) return;
    playCheer(d.clip, d.dist || 0, !!d.self);
    if (!d.self) feed(`📣 <b>${d.by || '有人'}</b> 在庆祝`);
  });
  socket.on('cheerLeft', (d) => { if (d) setCheerBadge(d.left); });
  socket.on('cheerNone', () => banner('没有庆祝次数了（进球后 +1）', '#ffd166', 1.8));

  /* 技能卡回执：被拒绝时必须给反馈，否则玩家只看到"按了没反应"。
   * noball = 马赛回旋没有持球（用户要求：没有持球状态不能做这个动作）。 */
  socket.on('skillAck', (d) => {
    if (!d || d.ok) return;
    const msg = {
      noball: '马赛回旋要先控住球（脚下没球做不了）',
      busy: '正在做别的动作',
      cd: '还在冷却',
      mode: '这张卡只能在踢球模式用',
      down: '倒地中',
      slide: '滑铲中',
    }[d.r];
    if (msg) banner(msg, '#ffd166', 1.6);
  });

  socket.on('goal', (g) => {
    G_phaseIsPlay = false;
    lastScorer = { name: g.by || C.TEAMS[g.team].name, team: g.team, t: performance.now() };
    banner('进 球 ！', C.TEAMS[g.team].color, 3);
    feed(`<b style="color:${C.TEAMS[g.team].color}">${C.TEAMS[g.team].name}</b> 进球${g.by ? ' · ' + g.by : ''}`);
    audio.goal();
    controls.shake(0.55, 0.6);            // 进球：镜头一震
    /* 解说分档：比分接近 / 领先的那一方是"关键球"→ 用更激动的一档素材；
     * 自己在场上被进球（失球方）→ 补一句"丢球了"的旁白，代入感更强。 */
    const diff = Math.abs((g.scores ? g.scores.A - g.scores.B : 0));
    const keyGoal = diff <= 1 && (g.scores ? Math.max(g.scores.A, g.scores.B) >= 1 : false);
    if (keyGoal) COMMENT.goalBig(C.TEAMS[g.team].name, g.by);
    else COMMENT.goal(C.TEAMS[g.team].name, g.by);
    if (myTeam && g.team !== myTeam) setTimeout(() => COMMENT.goalConcede(C.TEAMS[g.team].name), 2400);
  });

  // 中柱 / 横梁：门框弹出的球（服务端新加的实体碰撞）→ 解说 + 看台叹息
  socket.on('hitPost', (h) => {
    audio.sfx('thud', { vol: 0.55, rate: 1.35 });        // 铁框的清脆撞击
    COMMENT.shotPost(h.by);
    if (h.by === myName) controls.shake(0.3, 0.4);
  });

  // 被铲倒 / KO 提示
  socket.on('tackle', (t) => {
    audio.punch();
    if (t.by === myName || t.victim === myName) controls.shake(t.ko ? 0.6 : 0.35, 0.45);
    if (t.victim && t.by) { feed(`<b>${t.by}</b> ${t.ko ? '💥 KO 打倒' : '铲倒'} <b>${t.victim}</b>`); COMMENT.tackle(t.by, t.victim, t.ko); }
    else if (t.victim) feed(`<b>${t.victim}</b> 被铲倒`);
  });
  // 有人出球（射门 / 传球 / 解围 / 传中）：全服广播 → 别人踢球终于也有声音 + 解说
  socket.on('kickEv', (k) => {
    if (k.id === myId) return;                              // 自己的球本地已经播过音效（见 onKick）
    // 按"离自己多远"衰减音量：远处的球声不该和脚下一样响
    const d = Math.hypot(k.x - ME.x, k.z - ME.z);
    const vol = Math.max(0.06, 0.62 * (1 - Math.min(1, d / 55)));
    audio.sfx('kick', { vol, rate: 0.9 + 0.25 * (k.power || 0.5), delay: Math.min(0.3, d / 340) });
    /* 解说按出球的性质分流（这正是"语音绑定事件、不空响"的做法）：
     *   · 射门（type=shoot）→ 大力抽射 / 射门
     *   · 传球出速很大（>24m/s，长传/大脚解围）→ 解围
     *   · 传球方向明显偏向边路（|vz| 大）→ 传中
     *   · 其余短传 → 传球（本身冷却很长，不会一直念） */
    if (k.type === 'shoot') COMMENT.shot(k.power);
    else if (k.spd > 24) COMMENT.clearance(k.by);
    else if (Math.abs(k.vz) > Math.abs(k.vx) * 1.6) COMMENT.cross(k.by);
    else COMMENT.pass();
  });

  // 抢断成功（从别人脚下把球掏走）→ 解说 + 播报
  socket.on('steal', (k) => {
    if (k.id === myId) feed(`⚡ 你从对手脚下断掉了皮球`);
    else feed(`⚡ <b>${k.by}</b> 抢断成功`);
    audio.sfx('thud', { vol: 0.34, rate: 1.1 });
    COMMENT.interception(k.by);
  });

  // 头球（跃起争顶）→ 补一句"头球攻门"的解说（服务端已有 header 事件，之前没接解说）
  socket.on('header', (h) => {
    COMMENT.header(h.by);
    if (h.by === myName) controls.shake(0.22, 0.3);
  });

  // 死球重开：界外球 / 角球 / 球门球 —— 立刻提示，等发球方开出
  socket.on('restart', (r) => {
    G_phaseIsPlay = false;                     // 死球期间不放氛围解说，别和哨声打架
    const t = C.TEAMS[r.team];
    banner(r.label, t.color, 2.2);
    feed(`<b>${r.label}</b> · <span style="color:${t.color}">${t.name}</span>${r.by ? ' · ' + r.by + ' 发球' : ''}`);
    audio.whistle(r.type === 'goalKick');
    if (r.type === 'corner') audio.crowdCheer(0.3);
    if (r.type === 'goalKick') audio.sad();          // 射偏了：看台一片叹息
    COMMENT.restart(r.type, t.name, r.by);
  });

  socket.on('aimLockSet', (d) => { /* 服务端确认，可忽略 */ });

  // AI 守门员开关状态
  socket.on('keepersState', (s) => {
    keepersOn = !!s.on;
    if (s && s.by) { /* 别人改的 */ }
    syncGkBtn();
  });
  // AI 机器人：全服同步
  socket.on('botsState', (s) => {
    botsOn = !!s.on;
    botsBy = (s && s.by) || '';
    syncGkBtn();
  });
  // 射门机器人（练习用）：全服同步
  socket.on('shooterState', (s) => {
    shooterOn = !!s.on;
    syncGkBtn();
  });
  socket.on('init', () => { socket.emit('keepersQuery'); socket.emit('botsQuery'); socket.emit('shooterQuery'); });

  // 属性卡：使用成功 → 播动画；全场播报
  socket.on('cardUse', (r) => {
    if (r && r.ok) { cardBar && cardBar.playUseAnim(0); COMMENT.card('你', '前锋'); }
    else if (r && r.r === 'spent') feed('这张卡已经用过了');
  });
  socket.on('cardUsed', (c) => {
    feed(`🃏 <b>${c.by}</b> 使用了 <b>${c.name}</b> 属性卡（最快速度 +${Math.round((c.mul - 1) * 100)}% · ${c.sec}s）`);
    audio.whistle(false);
    if (c.by !== myName) COMMENT.card(c.by, c.name);
  });

  // 有人准备发球
  socket.on('restartReady', (r) => feed(`<b>${r.by}</b> 准备发${r.label}`));

  // 守门员：认领 / 交出 / 扑救
  socket.on('keeperClaim', (k) => {
    feed(`🧤 <b>${k.by}</b> 担任${C.TEAMS[k.team].name}守门员（禁区内左键扑挡 / 右键飞扑）`);
    COMMENT.keeper(k.by);
  });
  socket.on('keeperRelease', (k) => feed(`<b>${k.by}</b> 离开禁区，不再是守门员`));
  socket.on('gkSave', (k) => {
    if (k.caught) feed(`🧤 <b>${k.by}</b> 扑出并抱住球！`);
    else feed(`<b>${k.by}</b> ${k.kind === 'dive' ? '飞扑' : '贴地扑挡'}`);
    audio.save();
    controls.shake(0.18, 0.25);
    audio.crowdCheer(0.26);
    /* 解说分三种，避免"扑救/脱手/拳击"混成一句：
     *   caught → 抱住了（saveHold）· 没抱住 → 脱手（saveMiss）· AI 门将主动击球 → 单拳打出 */
    if (k.caught) COMMENT.save(k.by, true);
    else if (k.kind === 'punch') COMMENT.savePunch(k.by);
    else COMMENT.save(k.by, false);
  });
  // 门将出球（手抛 / 大脚）→ 一句"发动快攻"
  socket.on('gkDist', (d) => {
    if (d && d.kind === 'roll') COMMENT.keeperThrow(d.by || '门将');
  });
  // 裁判鸣哨（犯规/越位等死球的哨后旁白）
  socket.on('scoresUpdate', (s) => { scores.A = s.A; scores.B = s.B; });
  socket.on('matchEnd', (m) => {
    const w = m.winner ? C.TEAMS[m.winner] : null;
    banner(w ? `${w.name} 获胜` : '平局', w ? w.color : '#9fefff', 4);
    COMMENT.fullTime(w ? w.name : null);
  });
  socket.on('matchReset', () => { banner('新一场开始', '#9fefff', 2); COMMENT.newMatch(); G_phaseIsPlay = true; });  socket.on('chat', (c) => {
    if (c.type === 'system') pushChat({ text: c.text, sys: true });
    else pushChat({ name: c.name, text: '：' + c.text, me: c.name === myName });
  });

  socket.on('playerLeft', () => {});
}

function syncChar(p, immediate = false) {
  if (!ASSETS) return;            // 资源没就绪前丢弃状态（开始按钮已加同款守卫，双保险）
  let e = chars.get(p.id);
  if (!e) {
    const { holder, inner } = cloneCharacter(ASSETS.model, ASSETS.unitScale);
    scene.add(holder);
    const ch = new Character(holder, inner, ASSETS.clips, {
      teamColor: p.color, name: p.name, isMe: p.id === myId, unitScale: ASSETS.unitScale,
      kitTex: ASSETS.kitTex ? ASSETS.kitTex[p.team] : null,     // 新模型的红/蓝队服贴图
    });
    if (lazyBag) ch.addClips(lazyBag);      // 后台动作已就绪 → 直接补挂，别等下一次 syncChar
    e = { ch, x: p.x, y: p.y, z: p.z, yaw: p.yaw, anim: p.anim, animSpd: p.animSpd, spin: 0 };
    chars.set(p.id, e);
    immediate = true;
  }
  e.tx = p.x; e.ty = p.y; e.tz = p.z; e.tyaw = p.yaw;
  e.tvx = p.vx || 0; e.tvz = p.vz || 0;
  e.team = p.team;                                 // ★ 解说导演要看持球人在哪一队
  e.snapT = performance.now();
  e.anim = p.anim || 'idle'; e.animSpd = p.animSpd || 1; e.oneShotSeq = p.oneShotSeq;
  e.hp = typeof p.hp === 'number' ? p.hp : 100;
  e.hint = !!p.hint;
  e.ready = !!p.ready;
  e.lock = !!p.lock;
  e.claim = !!p.claim;
  e.gkHold = !!p.gkHold;                          // ★ 门将抱球中（抱球不可抢 → 不提示"按 F 吸附"）
  e.cards = p.cards; e.boost = p.boost || 0; e.cheer = p.cheer || 0;
  /* 自己的剩余庆祝次数：每条 state 都核对一次（比在 tick 里靠分支更新更可靠） */
  if (p.id === myId && p.cheer !== undefined && p.cheer !== cheerLeft) setCheerBadge(p.cheer);
  e.skillCd = p.skillCd || {};                    // 攻击技能冷却（卡牌条倒计时用）
  e.coins = p.coins || 0;                         // 押注金币
  e.betTeam = p.betTeam || null;
  e.betAmt = p.betAmt || 0;
  e.ambBet = p.ambBet || null;
  e.ambAmt = p.ambAmt || 0;
  e.dead = !!p.dead; e.revT = p.revT || 0; e.revT0 = p.revT0 || 0;
  e.down = !!p.down;
  if (immediate) { e.x = p.x; e.y = p.y; e.z = p.z; e.yaw = p.yaw; }
}

function removeChar(id) {
  const e = chars.get(id);
  if (!e) return;
  e.ch.dispose();
  chars.delete(id);
}

/**
 * 自己的状态同步。
 * 位置**不做本地预测** —— 服务器已经权威算好（含滑铲推进、带球减速、边界碰撞），
 * 客户端再算一遍会和权威值打架，表现就是"跑快了又缩回来"。
 * 这里只同步速度 / 朝向 / 动画，位置统一走 loop 里的"权威值 + 速度外推 + 平滑"。
 */
function reconcile(s) {
  ME.vx = s.vx; ME.vz = s.vz;
  ME.y = s.y;
  ME.yaw = s.yaw;
  ME.anim = s.anim || 'idle';
  ME.animSpd = s.animSpd || 1;
  ME.oneShotSeq = s.oneShotSeq;
  ME.dribbling = !!s.drib;
  ME.mode = s.mode || 'soccer';
  ME.passCd = Math.max(0, s.passCd || 0);        // ★ 传球冷却剩余（按钮置灰用）
}

/* ============================================================
 *  输入
 * ============================================================ */
const mv = { mx: 0, mz: 0, sprint: false, jump: false, walk: false };
let lastModeSent = 'soccer';

/** 切换操作方案：触屏层显隐 / 键位提示 / 指针锁定，选择写进 localStorage 记住 */
function applyTouchMode(on) {
  TOUCH.on = !!on;
  document.body.classList.toggle('touch', TOUCH.on);
  try { localStorage.setItem('touchMode', TOUCH.on ? '1' : '0'); } catch (e) {}
  if (TOUCH.on) {
    if (!touch && controls) touch = new TouchControls(controls);
    ui.lockTip.hidden = true;
    if (controls && controls.locked && document.exitPointerLock) document.exitPointerLock();
  } else {
    if (touch) { touch.destroy(); touch = null; }
    ui.lockTip.hidden = !!(controls && controls.locked);
    canvas.requestPointerLock && (() => { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) {} })();
  }
}

/* ============================================================
 *  聊天（Enter 打开 → Enter 发送 / Esc 关闭）
 * ------------------------------------------------------------
 *  为什么不能用 feed()：killfeed 是战报流（6 秒就消失、最多 5 条），
 *  聊天需要停得久一点、能往回看几条，所以单开一个 #chatLog。
 * ============================================================ */
const CHAT_KEEP = 6, CHAT_LIFE = 11000;
function escChat(x) {
  return String(x == null ? '' : x).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}
function pushChat({ name, text, sys = false, me = false }) {
  const box = ui.chatLog;
  console.log('[chat] 收到', sys ? 'sys' : 'user', name, text, 'box=', !!box);
  if (!box) return;
  const d = document.createElement('div');
  d.className = 'cm' + (sys ? ' sys' : '') + (me ? ' me' : '');
  d.innerHTML = sys ? escChat(text) : `<b>${escChat(name)}</b>${escChat(text)}`;
  box.appendChild(d);
  while (box.children.length > CHAT_KEEP) box.firstChild.remove();
  setTimeout(() => { d.style.transition = 'opacity .5s'; d.style.opacity = '0'; setTimeout(() => d.remove(), 520); }, CHAT_LIFE);
}

let chatOpen = false;
function openChat() {
  if (chatOpen || !ui.chatIn) return;
  chatOpen = true;
  ui.chatIn.value = '';
  ui.chatIn.hidden = false;
  ui.chatIn.focus();
  /* ★ 必须松开所有按键：WASD 是在 input.js 的 keys 集合里按住的，
   *   焦点切到输入框后不会再收到 keyup → 人会一直往前跑。 */
  try { if (controls && controls.releaseAll) controls.releaseAll(); } catch (e) {}
}
function closeChat() {
  chatOpen = false;
  if (!ui.chatIn) return;
  ui.chatIn.hidden = true;
  ui.chatIn.value = '';
  ui.chatIn.blur();
}
function sendChat() {
  const t = (ui.chatIn ? ui.chatIn.value : '').trim();
  closeChat();
  if (!t || !socket) return;
  socket.emit('chat', t.slice(0, 80));
}
window.addEventListener('keydown', (e) => {
  // 焦点在输入框里 → 交给输入框自己的处理器（Esc/Enter 在下面）
  if (e.target && /input|textarea/i.test(e.target.tagName)) return;
  if (e.code === 'Enter') { e.preventDefault(); openChat(); }
});
if (ui.chatIn) {
  ui.chatIn.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
  });
}

/* ============================================================
 *  庆祝语音（中键转盘 / 30m 半径 / 音量随距离衰减）
 * ------------------------------------------------------------
 *  · 次数来自进球：全场每进一个球，每个人 +1（服务端 doGoal 发放，dto.cheer 下发）
 *  · 按住**鼠标中键**开转盘 → 鼠标方向选格（pointer lock 下用 movementX/Y 累积角度）
 *    → 松开触发；落在中心区域 = 取消
 *  · 转盘固定 8 格布局（市面常见的径向菜单）：后续加语音只需往 CHEER_CLIPS 里加一条
 *  · 只有 30m 内能听到，音量按距离衰减（服务端只做范围过滤 + 下发距离，客户端算音量）
 * ============================================================ */
const CHEER_CLIPS = [
  /* gain = 音量均衡系数（实测响度定的，见文件头注释）：
   *   cheer-1 原始 p95 短时 RMS 0.73、峰值 0.99（几乎是压满的），放 1.0 会明显盖过别的声音
   *   cheer-2 原始 p95 只有 0.093、峰值 0.33（约 -18dB）→ 需要放大
   *   统一到 p95≈0.30 附近：0.73×0.40=0.29 / 0.093×2.9=0.27（峰值 0.33×2.9=0.96 不削波） */
  { id: 'cheer-1', label: '进球', icon: '📣', gain: 0.40 },
  { id: 'cheer-2', label: '欢呼', icon: '👏', gain: 2.90 },
];
const CHEER_RANGE = 30;
const WHEEL_SLOTS = 8;                 // 庆祝转盘固定 8 格（空格显示"待添加"）
/* ★ 一个转盘、两套内容：**踢球模式 = 庆祝语音 / 跳舞模式 = 选舞 / 攻击模式 = 不开**。
 *   用"当前模式决定内容"来避免冲突（用户要求"不要和踢球模式的转盘冲突"）——
 *   同一个鼠标中键，按下去看到的永远是这个模式该选的东西。 */
const DANCE_ITEMS = ((SH.C && SH.C.DANCES) || []).map((d, i) => ({ id: d.clip, label: d.name, icon: d.icon, n: i + 1 }));
let cheerLeft = 0;
let wheelOpen = false, wheelIdx = -2, wAccX = 0, wAccY = 0;
let wheelKindNow = 'cheer';            // 'cheer' | 'dance'
let wheelItems = CHEER_CLIPS;
let wheelN = WHEEL_SLOTS;
/* ★ 用 **Web Audio** 播庆祝语音，而不是 <audio>.volume：
 *   HTMLAudio 的音量上限是 1.0，没法把那段小的（cheer-2 -18dB）放大到和 cheer-1 一样响。
 *   GainNode 可以 >1，于是两段能精确对齐到同一响度（gain 系数在 CHEER_CLIPS 里）。 */
let acCtx = null;
const cheerBuf = {};            // id -> AudioBuffer
const cheerSfx = {};            // 兜底用的 HTMLAudio

function preloadCheer() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) { acCtx = new AC(); }
  } catch (e) { acCtx = null; }
  for (const c of CHEER_CLIPS) {
    /* 兜底：Web Audio 不可用 / 解码失败时退回普通 <audio> */
    try {
      const a = new Audio('audio/' + c.id + '.mp3');
      a.preload = 'auto';
      cheerSfx[c.id] = a;
    } catch (e) {}
    if (!acCtx) continue;
    fetch('audio/' + c.id + '.mp3')
      .then((r) => r.arrayBuffer())
      .then((b) => new Promise((res, rej) => acCtx.decodeAudioData(b, res, rej)))
      .then((buf) => { cheerBuf[c.id] = buf; })
      .catch(() => {});
  }
}
/** 播放（dist=0 或 self → 满音量） */
function playCheer(clip, dist, self) {
  const meta = CHEER_CLIPS.find((c) => c.id === clip) || {};
  const gain = meta.gain || 1;
  /* 距离衰减：10m 内基本满，30m 处 ~15%。用 1.6 次方近似"近处响、远处糊"的观感。 */
  const k = Math.max(0, Math.min(1, 1 - (dist || 0) / CHEER_RANGE));
  const vol = (self ? 1 : Math.max(0.05, Math.pow(k, 1.6))) * gain;
  const buf = cheerBuf[clip];
  if (acCtx && buf) {
    try {
      if (acCtx.state === 'suspended') acCtx.resume().catch(() => {});
      const src = acCtx.createBufferSource();
      src.buffer = buf;
      const g = acCtx.createGain();
      g.gain.value = vol;
      src.connect(g).connect(acCtx.destination);
      src.start();
      return;
    } catch (e) { /* 掉到兜底 */ }
  }
  const base = cheerSfx[clip];
  let src = null;
  try { src = base ? base.cloneNode() : new Audio('audio/' + clip + '.mp3'); } catch (e) { return; }
  src.volume = Math.max(0, Math.min(1, vol));      // 兜底时音量被夹在 1
  src.play().catch(() => {});
}

function setCheerBadge(n) {
  cheerLeft = Math.max(0, n | 0);
  const badge = ui.cheerBadge, num = $('cheerNum');
  const core = $('ewNum');
  if (num) num.textContent = String(cheerLeft);
  if (core && wheelKindNow !== 'dance') core.textContent = String(cheerLeft);
  if (badge) {
    badge.hidden = false;
    badge.classList.toggle('have', cheerLeft > 0);
  }
}

/* ---------- 转盘绘制 ---------- */
function wheelGeom(count) {
  const n = count || WHEEL_SLOTS;
  const cx = 110, cy = 110, r0 = 44, r1 = 104;
  const step = 360 / n;
  const segs = [];
  for (let i = 0; i < n; i++) {
    const a0 = (-90 + i * step) * Math.PI / 180;
    const a1 = (-90 + (i + 1) * step) * Math.PI / 180;
    const p = (r, a) => [(cx + r * Math.cos(a)).toFixed(2), (cy + r * Math.sin(a)).toFixed(2)];
    const [x0, y0] = p(r1, a0), [x1, y1] = p(r1, a1);
    const [x2, y2] = p(r0, a1), [x3, y3] = p(r0, a0);
    const d = `M ${x0} ${y0} A ${r1} ${r1} 0 0 1 ${x1} ${y1} L ${x2} ${y2} A ${r0} ${r0} 0 0 0 ${x3} ${y3} Z`;
    const mid = (-90 + (i + 0.5) * step) * Math.PI / 180;
    const mr = (r0 + r1) / 2;
    segs.push({ d, mid, tx: cx + mr * Math.cos(mid), ty: cy + mr * Math.sin(mid) });
  }
  return segs;
}
function buildWheel(kind) {
  const svg = ui.ewRing;
  if (!svg) return;
  const items = kind === 'dance' ? DANCE_ITEMS : CHEER_CLIPS;
  const n = kind === 'dance' ? Math.max(1, items.length) : WHEEL_SLOTS;
  wheelItems = items; wheelN = n;
  const sig = kind + ':' + n;
  if (svg.dataset.built === sig) return;          // 同一套内容，不用重建
  svg.dataset.built = sig;
  svg.innerHTML = '';
  const segs = wheelGeom(n);
  const ns = 'http://www.w3.org/2000/svg';
  segs.forEach((g, i) => {
    const it = items[i];
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', g.d);
    path.setAttribute('class', 'ewSeg' + (it ? '' : ' dis'));
    path.dataset.i = i;
    svg.appendChild(path);
    if (it) {
      const ic = document.createElementNS(ns, 'text');
      ic.setAttribute('x', g.tx.toFixed(1));
      ic.setAttribute('y', (g.ty - 9).toFixed(1));
      ic.setAttribute('class', 'ewIcon');
      ic.textContent = it.icon || '';
      svg.appendChild(ic);
      const tx = document.createElementNS(ns, 'text');
      tx.setAttribute('x', g.tx.toFixed(1));
      tx.setAttribute('y', (g.ty + 9).toFixed(1));
      tx.setAttribute('class', 'ewTxt');
      tx.textContent = it.label;
      svg.appendChild(tx);
    } else {
      const tx = document.createElementNS(ns, 'text');
      tx.setAttribute('x', g.tx.toFixed(1));
      tx.setAttribute('y', g.ty.toFixed(1));
      tx.setAttribute('class', 'ewTxt dis');
      tx.textContent = '待添加';
      svg.appendChild(tx);
    }
  });
}
function wheelPick(angDeg) {
  const step = 360 / wheelN;
  const a = ((angDeg + 90) % 360 + 360) % 360;      // 从顶格（-90°）开始数
  const i = Math.floor(a / step) % wheelN;
  return wheelItems[i] ? i : -1;
}
function wheelHighlight(i) {
  if (wheelIdx === i) return;
  wheelIdx = i;
  const svg = ui.ewRing;
  if (!svg) return;
  svg.querySelectorAll('.ewSeg').forEach((p) => p.classList.toggle('on', +p.dataset.i === i));
  svg.querySelectorAll('.ewTxt').forEach((t) => t.classList.remove('on'));
  if (i >= 0) {
    const segs = wheelGeom(wheelN);
    const tx = svg.querySelectorAll('.ewTxt')[i];
    if (tx && segs[i]) tx.classList.add('on');
  }
}
/** 该开哪种转盘：踢球=庆祝语音，跳舞=选舞，攻击=没有 */
function wheelKindFor() {
  if (!controls) return null;
  if (controls.mode === 'dance') return 'dance';
  if (controls.mode === 'attack') return null;
  return 'cheer';
}
function setWheelCore() {
  const num = $('ewNum');
  const small = ui.emoteWheel ? ui.emoteWheel.querySelector('.ewCore small') : null;
  if (!num) return;
  if (wheelKindNow === 'dance') {
    num.textContent = String((controls && controls.dance) || 1);
    if (small) small.textContent = '松开切换';
  } else {
    num.textContent = String(cheerLeft);
    if (small) small.textContent = '松开使用';
  }
}
function openWheel() {
  if (wheelOpen || !ui.emoteWheel) return;
  const kind = wheelKindFor();
  if (!kind) return;                      // 攻击模式：中键不开转盘
  wheelKindNow = kind;
  buildWheel(kind);
  wheelOpen = true;
  wheelIdx = -2;                     // -2 = 还没选过（-1 是"中心取消"，两者要能区分）
  wAccX = 0; wAccY = 0;
  ui.emoteWheel.hidden = false;
  ui.emoteWheel.classList.toggle('dance', kind === 'dance');
  setWheelCore();
  wheelHighlight(-1);
  if (ui.chatTip) ui.chatTip.classList.add('fade');
}
function closeWheel(trigger) {
  if (!wheelOpen) return;
  wheelOpen = false;
  if (ui.emoteWheel) ui.emoteWheel.hidden = true;
  const idx = wheelIdx;
  wheelHighlight(-1);
  if (!trigger || idx < 0) return;

  /* 跳舞模式：选中的是"第几支舞"→ 直接改 controls.dance（下一帧 input 包会带上去） */
  if (wheelKindNow === 'dance') {
    const d = DANCE_ITEMS[idx];
    if (!d) return;
    controls.dance = d.n;
    controls.onDance && controls.onDance(d.n);
    banner(`${d.icon} ${d.label}`, '#9ad7ff', 1.5);
    return;
  }

  const clip = CHEER_CLIPS[idx];
  if (!clip) return;
  if (cheerLeft <= 0) { banner('没有庆祝次数了（进球后 +1）', '#ffd166', 1.8); return; }
  socket.emit('cheer', { clip: clip.id });
}

/* 中键：按下开转盘 / 移动选格 / 松开触发 */
window.addEventListener('mousedown', (e) => {
  if (e.button !== 1) return;
  if (e.target && /input|textarea/i.test(e.target.tagName)) return;
  e.preventDefault();
  if (!myId) return;
  openWheel();
});
window.addEventListener('mousemove', (e) => {
  if (!wheelOpen) return;
  if (document.pointerLockElement) {
    /* ★ 指针锁定时鼠标坐标是固定的，只能靠 movementX/Y 累积方向 ——
     *   这也正好符合"鼠标往哪推就选哪格"的操作感。 */
    wAccX += e.movementX || 0;
    wAccY += e.movementY || 0;
    const len = Math.hypot(wAccX, wAccY);
    if (len < 14) { wheelHighlight(-1); return; }     // 抖动死区：当作没选
    wheelHighlight(wheelPick(Math.atan2(wAccY, wAccX) * 180 / Math.PI));
  } else {
    const r = ui.emoteWheel.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = e.clientX - cx, dy = e.clientY - cy;
    if (Math.hypot(dx, dy) < 30) { wheelHighlight(-1); return; }
    wheelHighlight(wheelPick(Math.atan2(dy, dx) * 180 / Math.PI));
  }
});
window.addEventListener('mouseup', (e) => {
  if (e.button !== 1) return;
  if (!wheelOpen) return;
  e.preventDefault();
  closeWheel(true);
});
window.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
window.addEventListener('blur', () => { if (wheelOpen) closeWheel(false); });

function wireControls() {
  controls.isHoldingBall = () => ME.dribbling && BALL.owner === myId;
  controls.onMode = (m) => {
    socket.emit('setMode', m);
    ui.modeTxt.textContent = m === 'attack' ? '攻击模式' : (m === 'dance' ? '跳舞模式' : '踢球模式');
    ui.modeTxt.className = m === 'attack' ? 'attack' : (m === 'dance' ? 'dance' : '');
    /* ★ 模式类同时挂到 #modeBox 本体：CSS 没法按子元素反选父级，
     *   颜色底要染整块（踢球=青 / 攻击=红 / 跳舞=紫），类必须落在块上。 */
    if (ui.modeBox) ui.modeBox.className = m === 'attack' ? 'attack' : (m === 'dance' ? 'dance' : 'kick');
    touch && touch.syncMode(m);          // 触屏按钮组跟着模式走
  };
  controls.onDance = (n) => {
    const d = (SH.C.DANCES || [])[(n | 0) - 1];
    ui.modeTxt.textContent = '跳舞模式 · ' + (d ? d.name : ('舞段' + n));
  };
  controls.onSlide = () => {
    const dx = ME.vx, dz = ME.vz;
    const l = Math.hypot(dx, dz);
    socket.emit('slide', l > 0.5
      ? { dirX: dx / l, dirZ: dz / l }
      : { dirX: Math.sin(ME.yaw), dirZ: Math.cos(ME.yaw) });
  };
  // 左键传球 / 右键射门：按住蓄力，松手出球；方向与仰角由准星 + 鼠标俯仰决定
  // ★ 出球带上击球点（右下角球 UI 的红点）：偏心自旋 + 掉力量，服务端 spinFromSpot 同一套公式
  controls.onKick = (type, power) => {
    const dir = controls.kickDir(ME.x, ME.z);
    socket.emit('kick', { type, dir, power, spot: controls.ballSpot });
    audio.kick(power);            // 踢球音效（力度越大越脆）
    controls.shake(0.08 + 0.16 * power, 0.2);   // 出脚的手感反馈
    if (type === 'shoot') COMMENT.shot(power); else COMMENT.pass();
  };
  /* ★ 击球点变化（方向键移动红点）→ 球 UI 立即跟手 + 标签说明 */
  controls.onSpotChange = (s) => {
    if (ui.ballDot) ui.ballDot.style.transform = `translate(${(s.x * 19).toFixed(1)}px, ${(-s.y * 19).toFixed(1)}px)`;
    if (ui.ballDot) ui.ballDot.classList.toggle('center', Math.abs(s.x) < 0.01 && Math.abs(s.y) < 0.01);
    if (ui.bcLabel) {
      const off = Math.hypot(s.x, s.y);
      if (off < 0.01) ui.bcLabel.textContent = '正中 · 满力';
      else {
        const pw = Math.round((1 - 0.15 * off) * 100);
        const parts = [];
        if (s.y > 0.05) parts.push('电梯下坠'); else if (s.y < -0.05) parts.push('后旋滞空');
        if (s.x > 0.05) parts.push('弧线左弯'); else if (s.x < -0.05) parts.push('弧线右弯');
        ui.bcLabel.textContent = (parts.join('·') || '微调') + ' · ' + pw + '%力';
      }
    }
  };
  /* ★ 鼠标侧键拖红点：按下时给即时反馈（球 UI 高亮 + 提示条上"击球点"那条点亮），
   *   松手立刻恢复。为什么要有反馈：侧键拖拽期间鼠标不转镜头，没有反馈玩家会
   *   怀疑"是不是卡了"。 */
  controls.onSpotDrag = (on) => {
    document.body.classList.toggle('spotdrag', !!on);
    const ft = document.getElementById('featTips');
    if (ft) {
      ft.classList.toggle('spotDrag', !!on);
      const first = ft.querySelector('.ft');
      if (first) first.classList.toggle('on', !!on);
    }
  };
  // 攻击模式：左键左勾拳 / 右键右直拳（按下立即出拳，不蓄力）
  // 守门员锁定防守（E 键 / 触屏"锁定"）
  // 属性卡：踢球模式下数字键 1~9 使用
  // 数字键：踢球模式 = 属性卡；攻击模式 = 技能（飞踢/螺旋踢）—— 按模式分流，互不冲突
  controls.onCard = (slot) => {
    if (controls.mode === 'attack') { socket.emit('skill', { slot }); return; }
    if (controls.mode !== 'soccer') return;
    /* 踢球模式：前 N 个槽是**花式卡**（马赛回旋，有 CD），后面的才是属性卡。
     * 服务端两边分开处理（skill / useCard），所以索引要减去花式卡数量。 */
    const nSkill = (C.SKILL_ORDER_SOCCER || []).length;
    if (slot < nSkill) { socket.emit('skill', { slot }); return; }
    socket.emit('useCard', { slot: slot - nSkill });
  };
  controls.onAimLock = (on) => {
    socket.emit('aimLock', { lock: on });
    feed(on ? '🔒 锁定防守：自动面向球，左右变侧步' : '已解除锁定防守');
  };
  /* 自由查看视角：进去时把锚点放到角色身上（"从角色这里往外看"），
   * 出来时不用还原——跟人视角本来就每帧重算镜头位置。 */
  controls.onFreeCam = (on) => {
    if (on) {
      controls.freeAnchor.set(ME.x, Math.max(0, ME.y), ME.z);
      controls.freePos.copy(camera.position);
      feed('🎥 自由视角：绕着角色转 · 鼠标环视 / 滚轮远近 / R·F 升降 · V 退出');
    } else {
      feed('🎥 已回到跟人视角');
    }
    document.body.classList.toggle('freecam', !!on);
  };
  /* ★★ 视角模式回调（V 键三态循环：第三人称 → 第一人称 → 自由查看 → …）
   *   第一人称要点：
   *   · `body.fps` 类 → CSS 把"第一人称不该有的东西"处理掉（准星亮起、自身队环淡出等）
   *   · 注入 `getEyePos`：从自己模型上取 **mixamorigHead 骨骼的世界坐标**，
   *     让相机跟着跑步起伏/起跳/倒地一起动（拿不到就退回固定眼高）。
   *   · `getEyePos` 取不到时返回 null，Controls 内部会退到"脚底 + 1.62m"。 */
  controls.onViewMode = (v) => {
    controls.fpsCam = (v === 'fps');
    document.body.classList.toggle('fps', controls.fpsCam);
    document.body.classList.toggle('freecam', v === 'free');
    if (controls.fpsCam) {
      controls.getEyePos = () => {
        const ent = myId ? chars.get(myId) : null;
        if (!ent) return null;
        const head = ent.ch.inner.getObjectByName('mixamorigHead');
        if (!head) return null;
        /* 头骨**原点在颈部**（Mixamo 的 Head 骨起点 = 脖子顶端），
         * 直接用会把相机放在下巴里 → 沿头骨自己的 +Y（局部朝头顶方向）抬高一点，
         * 落到"眼睛"的位置。headOffset 取 0.11 是按 1.8m 站高标定的（眼高 ≈1.62m）。 */
        const off = new THREE.Vector3(0, 0.11, 0).applyQuaternion(head.getWorldQuaternion(_q));
        const wp = head.getWorldPosition(_v);
        return { x: wp.x + off.x, y: wp.y + off.y, z: wp.z + off.z };
      };
      /* 切进第一人称时把 pitch 拉到"平视"（= 第三人称默认 0.32），
       * 否则从低机位切过来会突然看到天或地。 */
      controls.camPitch = 0.32;
      feed('👁 第一人称 · 鼠标环视 · V 切换视角');
    } else {
      controls.getEyePos = null;
      if (v === 'free') feed('🎥 自由视角：绕着角色转 · 鼠标环视 / 滚轮远近 / R·F 升降 · V 退出');
      else feed('🎥 第三人称');
    }
  };
  controls.onPunch = (hand) => {
    socket.emit('punch', { hand });
    audio.punch();
  };
  controls.onLockChange = (locked) => { ui.lockTip.hidden = locked; };
}

function sendInput() {
  if (!socket || !controls) return;
  // 押注商店开着 → 冻结移动（否则在面板里点按钮时人会乱跑）
  if (shop && shop.open) {
    socket.emit('input', { yaw: controls.camYaw, mx: 0, mz: 0, sprint: false, jump: false, walk: false, grab: false, dance: controls.dance });
    return;
  }
  controls.moveVec(mv);
  /* ★ 第一脚击球的蓄力上行：
   *   球没被自己控住时按住左/右键 = "提前蓄力"（人继续跑），
   *   服务端 tick 判定球进入正前方脚下范围 → 自动按当时方向释放。
   *   ct = 蓄力类型 · cp = 蓄力值 · cdir = 当前瞄准方向 · cspot = 击球点。 */
  const holding = ME.dribbling && BALL.owner === myId;
  let ct = null, cp = 0, cdir = null, cspot = null;
  if (!holding && controls.charging && controls.chargeType) {
    ct = controls.chargeType;
    cp = controls.charge;
    cdir = controls.kickDir(ME.x, ME.z);
    cspot = controls.ballSpot;
  }
  socket.emit('input', {
    yaw: controls.camYaw, mx: mv.mx, mz: mv.mz,
    sprint: mv.sprint, jump: mv.jump, walk: mv.walk,
    grab: controls.grabHeld,             // F 按住 = 持续尝试吸附带球
    dance: controls.dance,               // 跳舞模式舞段 1~5
    ct, cp, cdir, cspot,                 // 第一脚击球的蓄力状态（无蓄力时都是 null/0）
  });
  if (controls.mode !== lastModeSent) { socket.emit('setMode', controls.mode); lastModeSent = controls.mode; }
}

/* ============================================================
 *  ★ 解说导演 —— 按"比赛态势"触发没有专属事件的 flavor 解说
 *
 *  为什么需要它：射门/进球/扑救这些都有明确的服务器事件可挂，但
 *  "阵地组织""反击""突破""直塞"这类**过程性**解说没有对应事件。
 *  如果不做这层，这些语音类别就永远不会被触发（= 白转码，空响的反面）。
 *
 *  判据全部来自本机已有的状态（球的位置/速度、持球人位置、比分），
 *  每秒评估 2 次；每类都有自己的冷却，且同一时刻只放一条，绝不刷屏。
 * ============================================================ */
let pdT = 0;
const pdCd = {};                 // 各情形的冷却
const PD_CD = { buildup: 26, counter: 20, dribble: 16, through: 14, crowdSing: 40, crowdCheer: 30 };
const pdReady = (k) => {
  const now = performance.now();
  if (now - (pdCd[k] || 0) < PD_CD[k] * 1000) return false;
  pdCd[k] = now;
  return true;
};
/* id → 名字（playDirector 要念球员名，最新一份 state 里查） */
const PD_NAME = new Map();
const pdName = (id) => PD_NAME.get(id) || '';

function playDirector(dt) {
  if (!ME || !myId || !audio.enabled) return;
  pdT += dt;
  if (pdT < 0.5) return;
  pdT = 0;
  const holder = BALL.owner ? chars.get(BALL.owner) : null;
  if (holder) {
    const hx = holder.x, hz = holder.z;
    const hd = Math.hypot(hx - ME.x, hz - ME.z);
    // ① 反击：持球人已经越过了半场、开始向对方球门推进、周围没别人
    const oppGoalX = holder.team === 'A' ? C.FIELD.HALF_L : -C.FIELD.HALF_L;
    const toGoal = (oppGoalX - hx) * (holder.team === 'A' ? 1 : -1);
    if (toGoal > 12 && pdReady('counter') && hd < 55) {
      COMMENT.counter(C.TEAMS[holder.team] ? C.TEAMS[holder.team].name : '');
      return;
    }
    // ② 阵地组织：球在自己半场、慢慢倒脚（拿球人速度低）
    const inOwn = holder.team === 'A' ? hx < 0 : hx > 0;
    const slow = Math.hypot(holder.vx || 0, holder.vz || 0) < 3.2;
    if (inOwn && slow && pdReady('buildup') && hd < 45) { COMMENT.buildup(); return; }
    // ③ 边路突破：持球人贴着边线快速推进
    if (Math.abs(hz) > C.FIELD.HALF_W * 0.62 && Math.hypot(holder.vx || 0, holder.vz || 0) > 5.2 && pdReady('dribble')) {
      COMMENT.dribble(pdName(BALL.owner));
      return;
    }
  }
  // ④ 看台氛围（无球时的底噪，换成 FM23 的真实看台录音）
  if (!holder && G_phaseIsPlay && pdReady('crowdSing')) {
    audio.fm(Math.random() < 0.5 ? 'crowdSing' : 'crowdCheer', { vol: 0.2, cd: 0 });
  }
}
let G_phaseIsPlay = true;        // 简化的阶段标记（进球/重开时切换，见事件处理）

/* ============================================================
 *  ★★ 第一人称：藏掉"贴脸"的自身标识
 *
 *  为什么必须在 JS 里管（CSS 管不到）：脚下队环、头顶三角、名牌都是
 *  **3D Sprite / Mesh**，不是 DOM 节点 —— CSS 选择器对它们无效。
 *  第一人称下队环就在镜头正下方、三角正好压在视野上沿，等于两块花花绿绿
 *  贴在脸上，非常脏，所以必须 visible=false。
 *
 *  取舍：**血量不靠三角显示** —— 自己的血条是 DOM 的 #hpWrap（见下方 HUD 段），
 *  和头顶三角无关，所以藏三角不会把自己的血量藏掉。
 *
 *  还原：非第一人称时统一设回 true（比赛里没有别的逻辑会隐藏它们，
 *  菜单态是另一套模型，见 main.js 的 menuUI，不受影响）。
 * ============================================================ */
function applyFpsMarkers() {
  const fps = !!(controls && controls.fpsCam);
  const me = myId ? chars.get(myId) : null;
  if (!me) return;
  const vis = !fps;
  if (me.ch.ring) me.ch.ring.visible = vis;
  if (me.ch.marker) me.ch.marker.visible = vis;
  if (me.ch.label) me.ch.label.visible = vis;
}

/* ============================================================
 *  主循环（服务器权威 + 速度外推 + 渲染平滑）
 * ============================================================ */
let last = performance.now();

function loop(now) {
  requestAnimationFrame(loop);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;

  /* ★ 开始界面：世界已经建好（enterMenuCam），这里把"会动的东西"推进一步再渲染，
   *   相机交给 menuCam 环绕轨迹 —— 于是选择页背后是**活的球场实时俯视**。
   *   注意必须在下面 `!myId` 的提前返回**之前**处理。 */
  if (menuCam && world) {
    /* ★ 选择页：**只有场馆视角**（用户要求不再实时渲染踢球）——
     *   · 广告牌换主题、大屏走字、看台氛围声继续（场馆是"活"的）
     *   · 相机绕球场缓慢环绕（见 updateMenuCam）
     *   · 画完场馆后再叠一层 UI 场景：两侧的红/蓝球衣选队模型 */
    if (world.adBoards) world.adBoards.update(dt);
    if (jumbo) jumbo.update(dt, { scoreA: scores.A, scoreB: scores.B, clock, live: false });
    updateMenuCam(dt);
    updateMenuUI(dt);
    audio.ambient(dt);                                    // 看台氛围声（未 unlock 时内部会跳过）
    if (fx) fx.render(dt); else renderer.render(scene, camera);
    drawMenuUI();                                         // ← 队模叠在球场之上
    return;
  }

  if (!world || !myId) { if (fx) fx.render(dt); else renderer.render(scene, camera); return; }

  stepChars(dt, myId);

  // 自己的渲染位置回写给 ME（给准星 / 相机 / 吸附提示用）
  const meEnt = chars.get(myId);
  if (meEnt) {
    ME.x = meEnt.x; ME.y = meEnt.y; ME.z = meEnt.z;
    ME.boost = meEnt.boost || 0;
    ME.vx = (meEnt.x - (ME.px ?? meEnt.x)) / Math.max(0.001, dt);
    ME.vz = (meEnt.z - (ME.pz ?? meEnt.z)) / Math.max(0.001, dt);
    ME.px = meEnt.x; ME.pz = meEnt.z;
  }

  // 准星
  controls.updateAim(ME.x, ME.z, ME.y);

  // 相机：直接跟渲染位置，不再跟"预测位置"，避免视角落后于身体
  if (menuCam) {
    /* 还在开始界面：相机走"斜角实时俯视球场"的环绕轨迹（见 enterMenuCam）。
     * 世界照常更新（广告牌/大屏/看台都是活的），只是不跟玩家。 */
    updateMenuCam(dt);
  } else {
    controls.update(dt, { x: ME.x, y: ME.y, z: ME.z }, Math.hypot(ME.vx || 0, ME.vz || 0));
  }
  touch && touch.update();      // 触屏摇杆/按钮状态喂给 Controls
  audio.ambient(dt);            // 偶尔一段助威/掌声/现场播报
  if (ambulance) ambulance.update(dt);    // 救护车进/出场

  // 自己的实体（锁定提示 / 发球提示都要用）
  const meNow = myId ? chars.get(myId) : null;

  // 属性卡物品栏 + 加速倒计时（踢球模式）；攻击模式切换成技能卡 + 冷却
  if (meNow && meNow.cheer !== undefined && meNow.cheer !== cheerLeft) setCheerBadge(meNow.cheer);
  if (cardBar && meNow) {
    const holdingBall = !!(ME.dribbling && BALL.owner === myId);
    if (controls.mode === 'attack') {
      cardBar.setMode('attack', C.SKILL_ORDER.map(k => ({ key: k })));
      cardBar.updateSkills(meNow.skillCd || {});
    } else {
      /* needBall 透传给卡面：马赛回旋没持球时置灰 + 显示"需持球" */
      cardBar.setMode(controls.mode, (C.SKILL_ORDER_SOCCER || []).map((k) => ({
        key: k, needBall: !!(C.SKILL[k] && C.SKILL[k].needBall),
      })));
      cardBar.updateSkills(meNow.skillCd || {}, !holdingBall);
      if (meNow.cards) cardBar.sync(meNow.cards);
      cardBar.update(myId && ME.boost !== undefined ? ME.boost : (meNow.boost || 0));
    }
  }

  // 押注商店：同步金币/我的押注 + 结算飘字计时
  if (shop && meNow) {
    shop.setMe(meNow.coins || 0, meNow.betTeam || null, meNow.betAmt || 0, meNow.ambBet || null, meNow.ambAmt || 0);
    shop.tick(dt);
    if (ui.coinBox) {
      ui.coinBox.hidden = false;
      ui.coinTxt.textContent = (meNow.coins || 0) + (meNow.betTeam ? ' · 押' + (meNow.betTeam === 'A' ? '红' : '蓝') : '');
    }
  }

  // 速度表：跑动速度（km/h）+ 进度条
  //   速度来自服务端 20Hz 状态，直接显示会一跳一跳地闪 → 做平滑 + 每 ~100ms 才刷新一次
  if (ui.speedTxt) {
    const spRaw = Math.hypot(ME.vx || 0, ME.vz || 0);
    speedShow += (spRaw - speedShow) * (1 - Math.exp(-4.5 * dt));      // 缓动，读数稳定
    speedTick += dt;
    if (speedTick > 0.1) {
      speedTick = 0;
      const kmh = speedShow * 3.6;
      const txt = kmh < 10 ? kmh.toFixed(1) : kmh.toFixed(0);          // 十几公里就不显示小数，减少跳动
      if (ui.speedTxt.textContent !== txt) ui.speedTxt.textContent = txt;
      const w = Math.round(Math.min(100, (speedShow / (C.SPD.RUN4 || 8.5)) * 100) / 4) * 4;
      const ws = w + '%';
      if (ui.speedBar && ui.speedBar.style.width !== ws) ui.speedBar.style.width = ws;
    }
  }

  // 锁定防守提示（只在自己是门将且锁定时显示）
  const lockOn = !!(meNow && meNow.gk && meNow.lock);
  if (ui.lockTag) ui.lockTag.hidden = !lockOn;

  // 发球提示：两级 —— 走到球边提示「按 F」，按完 F 才提示出球操作
  const hintOn = !!(meNow && (meNow.hint || meNow.ready || meNow.claim));
  const hintTxt = meNow && meNow.ready
    ? '发球准备就绪：<b>左键蓄力</b>，松开出手（触屏点 传球/射门）'
    : (meNow && meNow.hint)
      ? '走到球边按 <b>F</b> 准备发球（触屏点「带球」）'
      : '按 <b>F</b> 当守门员（会替换 AI 守门员）· 触屏点「带球」';
  if (ui.actionHint) {
    if (ui.actionHint.hidden === hintOn) ui.actionHint.hidden = !hintOn;
    if (hintOn && ui.actionHint.dataset.txt !== hintTxt) {
      ui.actionHint.dataset.txt = hintTxt;
      ui.actionHint.innerHTML = hintTxt;
    }
  }

  // 角色渲染
  for (const [id, e] of chars) {
    e.ch.update(dt, { x: e.x, y: e.y, z: e.z, yaw: e.yaw, anim: e.anim, animSpd: e.animSpd, oneShotSeq: e.oneShotSeq, lean: e.lean || 0, hp: e.hp });
  }

  // 自己的血条（HUD）
  {
    const meEnt = chars.get(myId);
    const hp = meEnt ? (meEnt.hp ?? 100) : 100;
    const r = Math.max(0, Math.min(1, hp / 100));
    if (ui.hpFill) {
      ui.hpFill.style.width = (r * 100).toFixed(1) + '%';
      /* 黑白灰：正常=白，低血=红（内联色交给 CSS 的黑白灰层去管，这里只切 class） */
      if (ui.hpWrap) ui.hpWrap.classList.toggle('low', r <= 0.25);
    }
    if (ui.hpTxt) ui.hpTxt.textContent = Math.round(hp);
  }

  // 球的位置插值已并入 stepChars()（观战/游玩共用），这里只留解说导演
  playDirector(dt);

  /* ★ 第一人称：自己的脚下队环 / 头顶三角标识 / 名牌全部藏掉。
   *   它们是 3D Sprite/Mesh（不是 DOM），CSS 管不到，只能在这里设 visible。
   *   为什么必须藏：队环就在镜头底下、头顶三角正好在视野正上方，
   *   第一人称里等于"两块花花绿绿贴在脸上"，非常脏。
   *   **血条不藏** —— 自己血量还得能看见（血条画在三角标识里，见 character.js:165，
   *   所以这里只藏 marker 会连血条一起藏掉 → 见下面 applyFpsMarkers 的取舍）。 */
  applyFpsMarkers();

  // HUD：比分栏（新版计分牌：中间一格显示 "A-B"）
  const scTxt = `${scores.A}-${scores.B}`;
  if (ui.scoreNum && ui.scoreNum.textContent !== scTxt) ui.scoreNum.textContent = scTxt;
  if (ui.teamAName && ui.teamAName.textContent !== C.TEAMS.A.name) ui.teamAName.textContent = C.TEAMS.A.name;
  if (ui.teamBName && ui.teamBName.textContent !== C.TEAMS.B.name) ui.teamBName.textContent = C.TEAMS.B.name;
  const m = Math.floor(clock / 60), s = Math.floor(clock % 60);
  ui.clock.textContent = `${m}:${String(s).padStart(2, '0')}`;
  /* 持球虚焦：持球时左右下角淡入虚焦（配合镜头推近的"视野收窄"观感），出球后淡出 */
  if (ui.holdFx) {
    const holdingBall = ME.dribbling && BALL.owner === myId;
    if (ui.holdFx.classList.contains('on') !== holdingBall) ui.holdFx.classList.toggle('on', holdingBall);
  }
  // 力度条：按住左键（传球）/ 右键（射门）时显示，松手出球
  //   ★ 没持球也在蓄力 = "第一脚"模式：标签提示"到球前松手就踢"（服务端判正前方脚下释放）
  if (controls.charging && controls.charge > 0.001) {
    ui.chargeWrap.classList.add('on');
    const shoot = controls.chargeType === 'shoot';
    ui.chargeWrap.classList.toggle('shoot', shoot);
    const firstKick = !(ME.dribbling && BALL.owner === myId);
    /* ★ 传球冷却中（3s）→ 力度条变"冷却态"并显示倒计时。
     *   没有这个反馈，冷却期按左键会"什么都不发生"，玩家会以为按键坏了。 */
    const onCd = !shoot && (ME.passCd || 0) > 0.05;
    ui.chargeWrap.classList.toggle('cd', onCd);
    ui.chargeWrap.dataset.label = onCd
      ? '传球冷却 ' + (ME.passCd).toFixed(1) + 's · 可先射门 / 带球'
      : (firstKick
        ? (shoot ? '第一脚射门 · 跑到球上自动出脚' : '第一脚传球 · 跑到球上自动出脚')
        : (shoot ? '射门力度 · 松手出球' : '传球力度 · 松手出球'));
    ui.chargeBar.style.width = (controls.charge * 100).toFixed(0) + '%';
  } else {
    ui.chargeWrap.classList.remove('on');
    ui.chargeWrap.classList.remove('shoot');
    ui.chargeWrap.classList.remove('cd');
  }

  // 吸附提示：和服务端同一套判定（贴身圆圈 OR 正前方 1.25m 扇形）
  //   ★ 门将把球抱在怀里时**不提示"按 F 吸附"** —— 服务端会拒绝（抱球不可抢），
  //     提示了就是骗玩家。判定与服务端的 gkHoldingPlayer() 对齐。
  const gkHolding = (() => {
    if (!BALL.owner) return false;
    const o = chars.get(BALL.owner);
    return !!(o && o.gkHold);
  })();
  ui.ballHint.hidden = gkHolding
    || !(SH.inControlRange(ME, BALL.rx, BALL.rz) && BALL.owner !== myId && Math.abs(BALL.ry - 0.4) <= 1.2);
  ui.ballHint.innerHTML = '按 <b>F</b> 吸附带球';

  // 射门弹道线
  updateTrajectory(now);

  if (bannerTimer > 0) {
    bannerTimer -= dt;
    if (bannerTimer <= 0) ui.banner.hidden = true;
  }

  // 太阳屏幕位置 → 滤镜的光柱（方向光当无穷远处理：取相机前方 900m 处的太阳点）
  if (fx && fx.setSun) {
    const dir = sunDir;                    // 场景主光方向（world.js 里同一组数）
    sunPt.set(camera.position.x + dir.x * 400, camera.position.y + dir.y * 400, camera.position.z + dir.z * 400);   // 400m：要在远平面(800)内，否则永远判为不可见
    sunPt.project(camera);
    const onScreen = sunPt.z < 1 && Math.abs(sunPt.x) < 1.5 && Math.abs(sunPt.y) < 1.5;
    const edge = Math.max(Math.abs(sunPt.x), Math.abs(sunPt.y));
    const vis = onScreen ? Math.max(0, 1 - Math.max(0, edge - 0.75) / 0.75) : 0;
    fx.setSun(sunPt.x * 0.5 + 0.5, sunPt.y * 0.5 + 0.5, vis);
  }

  // 角看台大屏：比分 / 剩余时间 / 直播状态（内部按需重绘）
  if (world.adBoards) world.adBoards.update(dt);   // 场边 LED 广告牌滑屏
  if (jumbo) jumbo.update(dt, { scoreA: scores.A, scoreB: scores.B, clock, live: true });

  if (fx) fx.render(dt); else renderer.render(scene, camera);
}
requestAnimationFrame(loop);

/* 画质 / 滤镜档位（**P 键**切换：高 → 标准 → 关）
 * ★ 从 V 挪到 P：V 现在是"自由查看视角"（用户要求"加一个自由查看视角"）——
 *   镜头这种高频操作放在离 WASD 更近的 V 上更顺手，画质档位一年也切不了几次。 */
addEventListener('keydown', (e) => {
  if (e.code !== 'KeyP' || !fx || e.repeat) return;
  const lv = fx.cycle();
  // 画质关掉时，持球虚焦也退化成正角部暗角（不做 backdrop 模糊，省电）
  document.body.classList.toggle('lowfx', lv === 'off');
  const label = { high: '高（泛光 + 转播调色）', mid: '标准（转播调色）', off: '关（直出）' }[lv] || lv;
  banner('画质：' + label, '#8fd3ff', 1.8);
  syncSettings();
});

/* ============================================================
 *  设置面板：AI 机器人（全服同步）/ AI 守门员（全服同步）/ 音效 / 画面滤镜
 * ============================================================ */
let keepersOn = true;
let botsOn = false;        // 默认关（和服务端 BOTS 默认值一致，避免面板显示反）
let shooterOn = false;          // 射门机器人（练习用）开关
let botsBy = '';                 // 最近一次改动机器人设置的人（全服同步）

const setBtn = document.getElementById('setBtn');
const setPanel = document.getElementById('setPanel');
const swBots = document.getElementById('swBots');
const swKeepers = document.getElementById('swKeepers');
const swShooter = document.getElementById('swShooter');
const swAudio = document.getElementById('swAudio');
const swFx = document.getElementById('swFx');
const setFoot = document.getElementById('setFoot');

function syncSettings() {
  const paint = (el, on, txtOn, txtOff) => {
    if (!el) return;
    el.classList.toggle('on', !!on);
    el.textContent = on ? txtOn : txtOff;
  };
  paint(swBots, botsOn, '开', '关');
  paint(swKeepers, keepersOn, '开', '关');
  paint(swShooter, shooterOn, '开', '关');
  paint(swAudio, audio.enabled, '开', '关');
  if (swFx && fx) swFx.textContent = { high: '高', mid: '标准', off: '关' }[fx.level] || fx.level;
  if (setFoot) setFoot.textContent = botsBy
    ? `机器人设置全服同步 · 最近由 ${botsBy} 改动`
    : '机器人设置全服同步（所有人看到同一个状态）';
}
function syncGkBtn() { syncSettings(); }        // 兼容旧调用点

if (setBtn) setBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (setPanel) { setPanel.hidden = !setPanel.hidden; syncSettings(); }
});

/* 帮助面板：默认收起（保持 HUD 干净），⚙ 旁边的 ? 或 H 键切换 */
const helpBtn = document.getElementById('helpBtn');
const helpPanel = document.getElementById('help');
function toggleHelp() {
  if (!helpPanel) return;
  helpPanel.hidden = !helpPanel.hidden;
  if (helpBtn) helpBtn.classList.toggle('on', !helpPanel.hidden);
}
if (helpBtn) helpBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleHelp(); });
addEventListener('keydown', (e) => {
  if (e.code === 'KeyH' && !e.repeat) toggleHelp();
});
if (swBots) swBots.addEventListener('click', (e) => {
  e.stopPropagation();
  socket && socket.emit('bots', { on: !botsOn });
});
if (swKeepers) swKeepers.addEventListener('click', (e) => {
  e.stopPropagation();
  socket && socket.emit('keepers', { on: !keepersOn });
});
if (swShooter) swShooter.addEventListener('click', (e) => {
  e.stopPropagation();
  socket && socket.emit('shooter', { on: !shooterOn });
});
if (swAudio) swAudio.addEventListener('click', (e) => {
  e.stopPropagation();
  audio.setEnabled(!audio.enabled);
  syncSettings();
  if (audio.enabled) audio.say('音效已开启');
});
if (swFx) swFx.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!fx) return;
  fx.cycle();
  syncSettings();
});

/* 调试钩子：控制台里可以 window.__DBG 看自己/球/角色状态 */
window.__DBG = {
  get me() { return ME; }, get ball() { return BALL; }, chars,
  get id() { return myId; }, get socket() { return socket; },
  get spectateSocket() { return spectateSocket; },   // 观战连接（选择页期间）
  get controls() { return controls; }, get scene() { return scene; },
  get touch() { return touch; },
  get traj() { return { shoot: trajLine, pass: trajLinePass }; },
  get anims() { return (ASSETS && ASSETS.clips) || null; },
  get ambulance() { return ambulance; },
  get fx() { return fx; },
  get jumbo() { return jumbo; },
  get renderer() { return renderer; },
  get scene() { return scene; },
  get audio() { return audio; },
  get charsAll() { return chars; },
  get meChar() { return chars.get(myId) || null; },
  get camera() { return camera; },           // 开始界面机位验证要用
  get menuCam() { return menuCam; },          // true = 还在选择页（相机走场馆环绕）
  get menuUI() { return menuUI; },            // 两侧选队模型（scene/cam/items）
  get pickTeam() { return pickTeam; },        // 当前选的队 'A' / 'B'
  menuHit: (x, y) => { const h = menuHit(x, y); return h ? { team: h.team } : null; },
  /* 转盘调试：无头浏览器在 pointer lock 下不产生 movementX，只能直接喂累积量 */
  wheelOpen: () => openWheel(),
  wheelMove: (dx, dy) => {
    if (!wheelOpen) return -1;
    wAccX += dx; wAccY += dy;
    const len = Math.hypot(wAccX, wAccY);
    if (len < 14) { wheelHighlight(-1); return -1; }
    const i = wheelPick(Math.atan2(wAccY, wAccX) * 180 / Math.PI);
    wheelHighlight(i);
    return i;
  },
  wheelClose: () => { closeWheel(true); return wheelIdx; },
  doJoin: () => doJoin(),
  selectTeam: (t) => selectTeam(t),
  get world() { return world; },
  get shop() { return shop; },
  setAmb(st) { if (ambulance) ambulance.setState(st); },
  devScore(a, b, scorer) {
    const pa = scores.A, pb = scores.B;
    if (scorer) lastScorer = { name: scorer, team: a > pa ? 'A' : 'B', t: performance.now() };
    scores = { A: a, B: b };
    scorePop(pa, pb);
  },
  setBots(on) { socket && socket.emit('bots', { on: !!on }); },
};

/* ============================================================
 *  角色渲染插值（观战 / 正式游玩共用）
 *  位置完全用服务器权威值，客户端不做预测/外推/穿透，只在渲染层平滑逼近，
 *  掩盖 30Hz 快照的台阶 —— 永远不会出现"跑出去又缩回来"。
 *  meId 传 null（观战时）→ 全部按"别人"的较慢系数处理。
 * ============================================================ */
function stepChars(dt, meId) {
  for (const [id, e] of chars) {
    const isMe = meId != null && id === meId;
    const k = 1 - Math.exp(-(isMe ? 24 : 15) * dt);
    e.x = lerp(e.x, e.tx, k);
    e.y = lerp(e.y, e.ty, k);
    e.z = lerp(e.z, e.tz, k);
    const prevYaw = e.yaw;
    e.yaw = angLerp(e.yaw, e.tyaw, 1 - Math.exp(-(isMe ? 22 : 12) * dt));
    // 转身侧倾：平滑后的瞬时转向速率 → 身体侧倒；只在跑动中生效（站着转身不歪）
    const turnRate = angDelta(prevYaw, e.yaw) / Math.max(dt, 1e-4);
    const leanTgt = Math.hypot(e.tvx, e.tvz) > 1.2 ? clamp(-turnRate * 0.045, -0.2, 0.2) : 0;
    e.lean = lerp(e.lean || 0, leanTgt, 1 - Math.exp(-12 * dt));
    // 偏差过大（卡顿 / 重新入场）直接吸附，避免长时间拖影
    if (Math.hypot(e.x - e.tx, e.z - e.tz) > 4) { e.x = e.tx; e.z = e.tz; }
  }
  // 球：服务端快照 + 短时外推 + 平滑（观战也要，否则球是死的）
  const age = Math.min(0.09, (performance.now() - BALL.snapT) / 1000);
  let tx = BALL.x + BALL.vx * age, ty = BALL.y + BALL.vy * age, tz = BALL.z + BALL.vz * age;
  ty = Math.max(C.BALL_R, ty);
  const kb = 1 - Math.exp(-26 * dt);
  BALL.rx = lerp(BALL.rx, tx, kb);
  BALL.ry = lerp(BALL.ry, ty, kb);
  BALL.rz = lerp(BALL.rz, tz, kb);
  if (ballObj) {
    ballObj.position.set(BALL.rx, BALL.ry, BALL.rz);
    const sp = Math.hypot(BALL.vx, BALL.vz);
    if (sp > 0.05) {
      const ax = new THREE.Vector3(BALL.vz, 0, -BALL.vx).normalize();
      ballObj.rotateOnWorldAxis(ax, (sp / C.BALL_R) * dt * 0.35);
    }
  }
}

/* ============================================================
 *  网络 state 的**唯一**消化入口（观战 / 正式游玩共用同一条路径）
 *
 *  ★ 用户要求"选择页也能直接看到真人玩家在游玩" —— 关键在于：
 *    观战连接收到的 state 与在场玩家**完全一样**，走这里同一套渲染，
 *    所以选择页看到的画面 = 进场后看到的画面（只是相机不同）。
 *    带宽也因此与"一个正在比赛的玩家"完全相同，不会翻倍。
 * ============================================================ */
function applyNetState(s) {
  const prevA = scores.A, prevB = scores.B;
  scores = s.scores; clock = s.clock;
  // 只在比分**变高**（有人进球）时弹幕；局末重置回 0:0 不弹
  if (scores.A > prevA || scores.B > prevB) scorePop(prevA, prevB);
  if (ambulance && s.amb) ambulance.setState(s.amb);
  // 球
  BALL.x = s.ball.x; BALL.y = s.ball.y; BALL.z = s.ball.z;
  BALL.vx = s.ball.vx; BALL.vy = s.ball.vy; BALL.vz = s.ball.vz;
  BALL.wx = s.ball.wx || 0; BALL.wy = s.ball.wy || 0;
  BALL.owner = s.ball.owner;
  BALL.snapT = performance.now();
  // 玩家
  const seen = new Set();
  for (const p of s.players) {
    seen.add(p.id);
    PD_NAME.set(p.id, p.name);           // 供解说导演念球员名
    if (p.id === myId) reconcile(p);
    syncChar(p);                 // 自己也走同一套"权威值 + 外推"
  }
  for (const id of [...chars.keys()]) if (!seen.has(id)) removeChar(id);
}

/* ============================================================
 *  开局
 * ============================================================ */
/* ★ 用户要求"选择的两个队直接两个卡片居中" → 去掉了"随机"卡（三选一变两选一）。
 *   默认选中**红队**（和 HTML 里 tA 的初始 .on 一致），玩家点另一张即切队。 */
let pickTeam = 'A';                       // 阵营选择：A 红队 / B 蓝队

/** 选中态同步到两侧队名标签（模型的高亮在 updateMenuUI 里按 pickTeam 处理） */
function syncPickUI() {
  for (const [team, el] of [['A', ui.tagA], ['B', ui.tagB]]) {
    if (!el) continue;
    el.classList.toggle('on', pickTeam === team);
    el.style.setProperty('--tagc', C.TEAMS[team].color);
  }
}
let joining = false;                       // 防重复入场（连点模型）
/* ★ 用户要求：**去掉"加入游戏"按钮，点模型直接进游戏**。
 *   所以入场逻辑抽成 doJoin()，由「点模型 / 点队名标签 / 输入框回车」三处触发。 */
function doJoin() {
  if (joining || !ASSETS) return;         // 模型没载入完不许进房
  joining = true;
  const n = (ui.nameIn.value || '').trim() || ('球员' + Math.floor(Math.random() * 900 + 100));
  /* ★ 音频预热必须包 try/catch：没有音频设备 / 浏览器限制 AudioContext 时
   *   （比如无头浏览器、静音的手机）这里一旦抛错，join() 就不会执行 →
   *   表现成"点了模型没反应、进不了游戏"。入场永远不该被音频卡住。 */
  try {
    audio.unlock();                       // 用户手势后开启声音（浏览器自动播放策略）
    audio.crowd(0.5);
    ['kick', 'whistle', 'crowd', 'thud', 'catch'].forEach((k) => audio._buf(k));
    audio.preloadCommentary();
  } catch (e) { console.warn('[入场] 音频预热失败（忽略）', e); }
  join(n, pickTeam);
}

function selectTeam(team, enterNow = true) {
  if (team !== 'A' && team !== 'B') return;
  const changed = pickTeam !== team;
  pickTeam = team;
  syncPickUI();
  // 点模型时给一点声音反馈（未 unlock 时会静默跳过）
  try { audio.sfx('thud', { vol: 0.32, rate: 1.65 }); } catch (e) {}   // 软一点的“嗒”
  /* 点模型/标签 = 直接入场。切了队就给 90ms 让选中态（脚下光圈+队名高亮）先亮一下，
   * 点的是当前已选队则立刻进，手感更跟手。 */
  if (enterNow && menuCam) setTimeout(doJoin, changed ? 90 : 0);
}
/* 队名标签：点了等于点模型 */
for (const el of [ui.tagA, ui.tagB]) {
  if (!el) continue;
  el.addEventListener('click', () => selectTeam(el.dataset.team));
}
/* ★ 模型交互：悬停播 Salute、移开回到 Happy Idle、点击选队。
 *   监听挂在 #start 上（它铺满全屏），坐标再换算到 canvas 的 NDC。
 *   注意 input/button 上的事件也会冒泡上来，所以只在不落在底条上时才处理。 */
ui.start.addEventListener('pointermove', (e) => {
  if (!menuCam || !menuUI.ready) return;
  if (e.target && e.target.closest && e.target.closest('.sBar, .sPickTag')) {
    for (const it of menuUI.items) it.hovered = false;
    return;
  }
  const hit = menuHit(e.clientX, e.clientY);
  for (const it of menuUI.items) it.hovered = !!hit && hit === it;
  renderer.domElement.style.cursor = hit ? 'pointer' : '';
});
ui.start.addEventListener('pointerleave', () => {
  for (const it of menuUI.items) it.hovered = false;
  renderer.domElement.style.cursor = '';
});
ui.start.addEventListener('pointerdown', (e) => {
  if (!menuCam || !menuUI.ready) return;
  if (e.target && e.target.closest && e.target.closest('.sBar, .sPickTag')) return;
  const hit = menuHit(e.clientX, e.clientY);
  if (hit) selectTeam(hit.team);
});

/* 按钮本身已隐藏（CSS），但保留元素：① 回车/异常路径仍可触发 ② 少改引用 */
if (ui.joinBtn) ui.joinBtn.addEventListener('click', doJoin);
ui.nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doJoin(); } });
