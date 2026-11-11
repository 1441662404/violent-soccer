import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { RT_PARENT, RT_D, RT_BINDM, RT_ROOTPARENT, RT_ORDER, RT_HIPS_XY, RT_HRATIO } from './rt-const.js';

/* 模型 1 个（idle.glb）+ 动画 23 个（只含骨架+clip，每个 ~130KB）。
 * 由 fbx2glb.mjs 从 FBX 包离线转换（17x 缩小，加载从 134MB 降到 8MB）。
 * 英文 URL 由 server.js 映射到 glb/ 目录。 */
export const MODEL_FILE = 'idle.glb';
/* 新人物模型（可选）：把 Mixamo **自动绑骨**导出的 FBX 放到 `模特包/char.fbx`，
 * 就会自动顶替 idle.glb；不存在 / 加载失败 → 无缝回退到 idle.glb（不影响现有玩法）。
 * 运行时**优先走 char.glb**（由 build-char.mjs 离线转出，首屏体积只有 FBX 的 1/6）。 */
export const CHAR_FBX = 'char.fbx';
export const CHAR_GLB = 'char.glb';
/* 队服贴图：Al Nassr 模型里球衣在材质 `texture_6`（贴图文件 texture_10.png）。
 * 这里按"贴图名 或 材质名"匹配，导出后名字有变化也能兜住。 */
export const KIT_TEX = { A: 'char/kit_red.png', B: 'char/kit_blue.png' };
const KIT_RE = /texture_6|texture_10/i;
/* 骨骼朝向补偿：见文件末尾的 retargetValve()。
 * 常数表（RT_PARENT / RT_D / RT_BINDM / RT_ROOTPARENT）在 rt-const.js 里，
 * 由 calc-off3.mjs 离线算出。
 *
 * 为什么不用"逐骨骼本地差"（旧方案，已废弃）：
 *   ValveBiped 与 Mixamo 的**骨骼局部基向量**并不一致（右侧骨尤甚），
 *   用 qV_bind × qM_bind⁻¹ 左乘轨道，左臂凑巧对、右臂会卡成水平平举。
 *   正确做法是**世界空间重定向**：
 *     worldM 递归 = parentWorldM × localM   （用 Mixamo 轨道值推出 Mixamo 世界朝向）
 *     worldV      = C × worldM              （C = 两套骨架的绑定世界朝向差）
 *     localV      = worldV_parent⁻¹ × worldV
 *   这样每根骨骼的世界朝向都被映射到 ValveBiped 的坐标系里，左右自然对称。 */
/* 若模型是 ValveBiped（CS/SFM 的 Bip01）骨架，把骨骼**改名**成 Mixamo 的名字，
 * 让 Mixamo 动画（旧包，0/69 命中）能按名字绑上。
 * 注意：两套骨架的绑定姿势差 46°，改名只是让动画"绑得上"，
 * 姿态必须再经 retargetValve() 的世界空间重定向才算对。
 *
 * ★ 但 `足球动作包` 出来的动画**与模特包同源**（同样 53 骨、同样 ValveBiped_Bip01_* 命名、
 *   绑定姿势差异 0.0°），它们**不需要重定向** —— 见 adaptClip()：检测到 ValveBiped 轨道名
 *   就走"只改名"的快路径，姿态天然正确。 */
const RENAME = {
  ValveBiped_Bip01_Pelvis: 'mixamorigHips',
  ValveBiped_Bip01_Spine: 'mixamorigSpine',
  ValveBiped_Bip01_Spine1: 'mixamorigSpine1',
  ValveBiped_Bip01_Spine2: 'mixamorigSpine2',
  ValveBiped_Bip01_Neck1: 'mixamorigNeck',
  ValveBiped_Bip01_Head1: 'mixamorigHead',
  ValveBiped_Bip01_L_Clavicle: 'mixamorigLeftShoulder',
  ValveBiped_Bip01_L_UpperArm: 'mixamorigLeftArm',
  ValveBiped_Bip01_L_Forearm: 'mixamorigLeftForeArm',
  ValveBiped_Bip01_L_Hand: 'mixamorigLeftHand',
  ValveBiped_Bip01_R_Clavicle: 'mixamorigRightShoulder',
  ValveBiped_Bip01_R_UpperArm: 'mixamorigRightArm',
  ValveBiped_Bip01_R_Forearm: 'mixamorigRightForeArm',
  ValveBiped_Bip01_R_Hand: 'mixamorigRightHand',
  ValveBiped_Bip01_L_Thigh: 'mixamorigLeftUpLeg',
  ValveBiped_Bip01_L_Calf: 'mixamorigLeftLeg',
  ValveBiped_Bip01_L_Foot: 'mixamorigLeftFoot',
  ValveBiped_Bip01_L_Toe0: 'mixamorigLeftToeBase',
  ValveBiped_Bip01_R_Thigh: 'mixamorigRightUpLeg',
  ValveBiped_Bip01_R_Calf: 'mixamorigRightLeg',
  ValveBiped_Bip01_R_Foot: 'mixamorigRightFoot',
  ValveBiped_Bip01_R_Toe0: 'mixamorigRightToeBase',
};
export const CLIP_FILES = {
  /* 站立待机：用**同源**的 idle.glb（ValveBiped 直绑）。
   * ★ 之前这里指向 `idleAnim.glb`（老的 Mixamo 动画）—— 它走世界空间重定向，
   *   重定向有残余偏差 → 用户反馈"静止状态还是反弓的，但待机状态是正常的"
   *   （待机 idleLong 是同源的，所以正常）。换成本地转出的同源 idle.glb 后，
   *   两者都是 53/53 直绑、绑定差 0.0°，姿态一致。 */
  idle:       'idle.glb',     // 原地站立（Breathing Idle，同源直绑）
  walk:       'walk.glb',     // Walking
  run1:       'run1.glb',     // Running1
  run2:       'run2.glb',     // Running3
  run3:       'run3.glb',     // Running 2
  run4:       'run4.glb',     // Running4
  runBack:    'runBack.glb',  // Run Backward
  startBack:  'startBack.glb',// start run to back
  arcRight:   'arcRight.glb', // Run Forward Arc Right
  rightTurn:  'rightTurn.glb',// Running Right Turn
  toTurn:     'toTurn.glb',   // Running To Turn
  changeDir:  'changeDir.glb',// Change Direction
  jump:       'jump.glb',     // Running Jump
  dribbleIdle:'dribbleIdle.glb', // 持球原地等待（Soccer Idle：来回拉球）
  spin:       'spin.glb',     // 马赛回旋（Soccer Spin，踢球模式花式卡）
  slide:      'slide.glb',    // Running Slide
  dribble:    'dribble.glb',  // Dribble
  pass:       'pass.glb',     // Soccer Pass（跑动中传球）
  strikeJog:  'strikeJog.glb',// Strike Foward Jog（爆射 / 跑射）
  passStill:  'passStill.glb',// 非跑动传球（静止状态传球）
  tackleDown: 'tackleDown.glb',// Soccer Tackle（被铲倒，clip 内含起身）
  throwIn:    'throwIn.glb',   // Throw In（手抛球 / 界外球）
  hurtFace:   'hurtFace.glb',  // Receive Uppercut To The Face（被打脸）
  hurtBody:   'hurtBody.glb',  // Hit To Body（被打中身体）
  gkBlockL:   'gkBlockL.glb',  // Goalkeeper Body Block(left)（贴地扑挡 左）
  gkBlockR:   'gkBlockR.glb',  // Goalkeeper Body Block(right)（贴地扑挡 右）
  gkDiveL:    'gkDiveL.glb',   // Goalkeeper Diving Save(left)（飞扑 左）
  gkDiveR:    'gkDiveR.glb',   // Goalkeeper Diving Save(right)（飞扑 右）
  gkStepL:    'gkStepL.glb',   // Goalkeeper Sidestep left（侧步防守 左）
  gkStepR:    'gkStepR.glb',   // Goalkeeper Sidestep right（侧步防守 右）
  gkCatchLow: 'gkCatchLow.glb',  // 门将接球：正对来球捞起（低球）
  gkCatchBody:'gkCatchBody.glb', // 门将接球：腹部接球（半高球）
  gkCatchHigh:'gkCatchHigh.glb', // 门将接球：跳跃接球（高球）
  gkKick:     'gkKick.glb',     // 门将原地出球（抱球后大脚开球）
  gkDrop:     'gkDrop.glb',     // 门将放地上助跑发球（长距离）
  gkRoll:     'gkRoll.glb',     // 门将滚地发球（快速低平球）
  fightIdle:  'fightIdle.glb',// Bouncing Fight Idle（攻击模式格斗待机）
  salute:     'salute.glb',    // 敬礼（开始界面：鼠标悬停在选队模型上时播）
  happyIdle:  'happyIdle.glb', // 开心待机（开始界面：选队模型的默认动作）
  punchL:     'punchL.glb',   // left Punching（左勾拳，攻击模式左键）
  punchR:     'punchR.glb',   // rightPunching（右直拳，攻击模式右键）
  flyKick:    'flyKick.glb',  // Flying Kick（攻击模式卡牌技能·飞踢）
  hurricane:  'hurricane.glb',// Hurricane Kick（攻击模式卡牌技能·螺旋踢）
  death:      'death.glb',    // Death From The Back（血量清零 → 被抬进球员席）
  /* 舞蹈（★ 每个键一个**不同的**舞，不再 1~5 全指向 Gangnam —— 用户反馈"重复了几个键"）*/
  dance1:     'gangnam.glb',    // 1 江南 Style（整段 12.4s 循环）
  dance2:     'hipHop.glb',     // 2 Hip Hop Dancing
  dance3:     'hipHop1.glb',    // 3 Hip Hop Dancing (1)
  dance4:     'swing.glb',      // 4 Swing Dancing
  dance5:     'breakdance.glb', // 5 Breakdance 1990
  dance6:     'badDance.glb',   // 6 马竞战舞 BAD（DeepMotion 素材，build-bad-dance.mjs 烘焙成直绑）
  /* ---- 足球动作包（与模特包同源，直绑不重定向）---- */
  spin:       'spin.glb',       // Soccer Spin 马赛回旋（备用）
  chip:       'chip.glb',       // 跑动横传（备用）
  gkIdle:     'gkIdle.glb',     // 门将锁定状态原地姿势（站桩防守）
  gkHold:     'gkHold.glb',     // 门将没收球后抱球姿势（持球待发）
  gkScoop:    'gkScoop.glb',    // 门将抢近距离球（扑倒把球捞进怀里）
  header:     'header.glb',     // 头球（跳跃时顶球，Soccer Header）
  idleLong:   'idleLong.glb',   // 站立久了原地活动（Happy Idle）
  run4:       'run4.glb',       // Sprint 冲刺（替换原来复用的快跑）
};

const L = new GLTFLoader();

/* ---- 首屏核心动作（其它等进游戏后台补）----
 * 判据：进游戏后 **10 秒内**一定会用到 → 核心。
 *   移动（跑/冲刺/后退/带球）、传射、铲球/被铲倒、滑铲、跳跃、受击、站立待机
 * 放后台补的：
 *   舞蹈 5 个（要按 Q 切模式才用）、攻击/武术 5 个（要切模式）、
 *   门将 12 个（先要走到球门按 F）、转身弧线 5 个（转向时可选）、旧 walk/startBack、备用 spin/chip、
 *   死亡/庆祝 等低频动作 */
export const CORE_CLIPS = {
  idle: 1, idleLong: 1,
  run1: 1, run2: 1, run3: 1, run4: 1, runBack: 1,
  dribble: 1, pass: 1, passStill: 1, strikeJog: 1,
  slide: 1, tackleDown: 1, throwIn: 1, jump: 1, header: 1,
  hurtFace: 1, hurtBody: 1,
  salute: 1, happyIdle: 1,          // 开始界面的选队模型要用 → 必须首屏就绪
  dribbleIdle: 1, spin: 1,          // 持球待机 / 马赛回旋要在踢球模式里秒出
};

/* 进球庆祝 / 舞蹈等一次性加载的剩余动作，供外部在后台预热 */
export const LAZY_CLIPS = Object.keys(CLIP_FILES).filter((n) => !CORE_CLIPS[n]);

/* 资源版本号。
 * /models/* 与 /char/* 走一年强缓存，所以 `?v=` 必须随文件变化 —— 否则换了动作
 * 用户一年内看到的还是旧文件（实测踩过这个坑）。
 * 现在**版本号由服务端算**（按文件大小+mtime 的 sha1，见 server.js 的 assetVer），
 * 客户端启动时拉一次；拿不到才退回这个兜底值。 */
let ASSET_V = '20261016e';
export function setAssetVersion(v) { if (v) ASSET_V = String(v); }
export function getAssetVersion() { return ASSET_V; }

/** 启动时同步一次版本号（在 loadAssets 之前 await 它） */
export async function fetchAssetVersion() {
  try {
    const r = await fetch('/asset-version', { cache: 'no-store' });
    if (r.ok) { const t = (await r.text()).trim(); if (t) ASSET_V = t; }
  } catch (e) { /* 拿不到就用兜底值，不影响加载 */ }
  return ASSET_V;
}

function loadOne(file) {
  return new Promise((res, rej) => {
    /* 用相对路径：挂在门户 /play/<slug>/ 下时自动带上前缀，
       不再依赖运行时 shim 改写（shim 万一没加载就会 404） */
    L.load('models/' + file + '?v=' + ASSET_V, (g) => res(g), undefined, (e) => rej(new Error(file + ': ' + (e && e.message || e))));
  });
}

/**
 * 冻结根骨骼的水平位移（root motion）。
 * mixamo 动画自带位移：Running4 一圈向前冲 3.57m、Running Slide 冲 6.4m、Dribble 4.6m，
 * 播完一圈又弹回原点 —— 表现就是"跑出去又缩回来"。
 * 水平位移全部交给服务器物理，这里把 X/Z 冻结到起始值；
 * Y 保留（跑动的上下起伏、滑铲的低伏姿态还要靠它）。
 */
function freezeRootMotion(clip) {
  /* ★★ Valve 同源包**不要**在这里冻根位移：
   *   这条规则是给 Mixamo 包写的（Hips 的 position 是 (x, 竖直y, z)，冻 x/z 正好只留高度）。
   *   而 Valve 骨架的 Pelvis 父级带 -90°X，**局部 z 才是"上"** —— 按 x/z 冻会把竖直分量一起冻掉，
   *   舞蹈/跳跃就再也没有起伏了（实测：战舞髋高振幅从 4.7 单位变成 0）。
   *   同源包的水平位移在 `build-bad-dance.mjs` / `fbx2glb2.mjs` 里已经钉在首帧了。 */
  if (clip.tracks.some((t) => /ValveBiped/i.test(t.name))) return clip;
  for (const t of clip.tracks) {
    const dot = t.name.lastIndexOf('.');
    if (dot < 0) continue;
    const bone = t.name.slice(0, dot), prop = t.name.slice(dot + 1);
    if (prop !== 'position') continue;
    if (!/hips|pelvis|root|reference/i.test(bone)) continue;
    const v = t.values;
    const x0 = v[0], z0 = v[2];
    for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
    t.needsUpdate = true;
  }
  return clip;
}

/** 左右镜像：四元数 (x,-y,-z,w)，位移 x 取反 —— 让"右转/右弧线"也能用在左边 */
function mirrorClip(src, name) {
  const clip = src.clone();
  clip.name = name;
  for (const t of clip.tracks) {
    const v = t.values;
    if (t.name.endsWith('.quaternion')) {
      for (let i = 0; i < v.length; i += 4) { v[i + 1] = -v[i + 1]; v[i + 2] = -v[i + 2]; }
    } else if (t.name.endsWith('.position')) {
      for (let i = 0; i < v.length; i += 3) v[i] = -v[i];
    }
  }
  return clip;
}

/**
 * 把 Mixamo 轨道值转成 ValveBiped 可用的本地旋转（世界空间重定向）。
 * 只在模型是 char.fbx（ValveBiped 骨架）时调用，纯离线一次性计算，运行时不增加开销。
 */
const RT_KEY = RT_ORDER.filter((b) => b in RT_D);
function retargetValve(clip) {
  // 1) 收集需要重定向的四元数轨道 + 根骨骼(Hips)的位置轨道
  const src = new Map();      // 骨骼短名 -> {times, values}
  const rest = [];            // 其余轨道原样保留
  let hipsPos = null;         // Mixamo 的 Hips 位置轨道（离地高度）
  for (const tr of clip.tracks) {
    const m = /^mixamorig([A-Za-z0-9_]+)\.quaternion$/.exec(tr.name);
    if (m && RT_D[m[1]]) {
      if (!src.has(m[1])) src.set(m[1], { times: Array.from(tr.times), values: Float32Array.from(tr.values) });
    } else if (/\.quaternion$/.test(tr.name)) {
      // 落在骨架里没有的骨头（手指、眼球、下颌、Neck1 这类转换残留）→ 丢掉，避免绑定警告
      const bare = tr.name.split('.')[0].replace(/^mixamorig/, '');
      if (RT_D[bare]) rest.push(tr);
    } else if (/^mixamorigHips\.position$/.test(tr.name)) {
      hipsPos = { times: Array.from(tr.times), values: Float32Array.from(tr.values) };
    } else {
      rest.push(tr);
    }
  }
  if (!src.size) return clip;

  // 2) 统一时间轴（各骨骼关键帧时刻不同，递归需要对齐 → 取并集）
  const set = new Set();
  for (const v of src.values()) for (const t of v.times) set.add(+t.toFixed(5));
  if (hipsPos) for (const t of hipsPos.times) set.add(+t.toFixed(5));
  const times = [...set].sort((a, b) => a - b);
  if (times.length < 2) return clip;

  // 采样某骨骼在 t 时刻的本地四元数（相邻帧球面插值，足够精确）
  const _a = new THREE.Quaternion(), _b = new THREE.Quaternion();
  const sample = (v, t, out) => {
    const ts = v.times;
    if (t <= ts[0]) { const i = 0; out.set(v.values[i], v.values[i + 1], v.values[i + 2], v.values[i + 3]); return out; }
    const last = ts.length - 1;
    if (t >= ts[last]) { const i = last * 4; out.set(v.values[i], v.values[i + 1], v.values[i + 2], v.values[i + 3]); return out; }
    let lo = 0, hi = last;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
    const i0 = lo * 4, i1 = hi * 4;
    _a.set(v.values[i0], v.values[i0 + 1], v.values[i0 + 2], v.values[i0 + 3]);
    _b.set(v.values[i1], v.values[i1 + 1], v.values[i1 + 2], v.values[i1 + 3]);
    const k = (t - ts[lo]) / Math.max(1e-6, ts[hi] - ts[lo]);
    return out.copy(_a).slerp(_b, k);
  };

  // 标量采样（用于 Hips 高度）
  const sampleNum = (v, t, stride, off) => {
    const ts = v.times;
    if (t <= ts[0]) return v.values[off];
    const last = ts.length - 1;
    if (t >= ts[last]) return v.values[last * stride + off];
    let lo = 0, hi = last;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
    const k = (t - ts[lo]) / Math.max(1e-6, ts[hi] - ts[lo]);
    return v.values[lo * stride + off] * (1 - k) + v.values[hi * stride + off] * k;
  };

  // 3) 预采样每根骨骼的 Mixamo 本地旋转
  const localM = new Map();
  for (const bone of RT_KEY) {
    const arr = new Float32Array(times.length * 4);
    const v = src.get(bone);
    const q = new THREE.Quaternion();
    if (v) { for (let i = 0; i < times.length; i++) { sample(v, times[i], q); arr.set([q.x, q.y, q.z, q.w], i * 4); } }
    else { const b = RT_BINDM[bone]; for (let i = 0; i < times.length; i++) arr.set(b, i * 4); }
    localM.set(bone, arr);
  }

  // 4) 按层级递归算本地旋转
  const cq = new Map();
  for (const b of RT_KEY) { const d = RT_D[b]; cq.set(b, new THREE.Quaternion(d[0], d[1], d[2], d[3])); }
  const rootInv = new THREE.Quaternion(RT_ROOTPARENT[0], RT_ROOTPARENT[1], RT_ROOTPARENT[2], RT_ROOTPARENT[3]).invert();
  const worldM = new Map(), worldV = new Map(), out = new Map();
  const qm = new THREE.Quaternion(), qv = new THREE.Quaternion(), qi = new THREE.Quaternion();
  for (const bone of RT_KEY) {
    const p = RT_PARENT[bone];
    const pm = p ? worldM.get(p) : null, pv = p ? worldV.get(p) : null;
    const lm = localM.get(bone), Dq = cq.get(bone);
    const wmA = new Float32Array(times.length * 4), wvA = new Float32Array(times.length * 4), outA = new Float32Array(times.length * 4);
    for (let i = 0; i < times.length; i++) {
      qm.set(lm[i * 4], lm[i * 4 + 1], lm[i * 4 + 2], lm[i * 4 + 3]);
      if (pm) qm.premultiply(qi.set(pm[i * 4], pm[i * 4 + 1], pm[i * 4 + 2], pm[i * 4 + 3]));   // worldM = parent × local
      wmA.set([qm.x, qm.y, qm.z, qm.w], i * 4);
      qv.copy(qm).multiply(Dq);                                                               // worldV = worldM × D
      wvA.set([qv.x, qv.y, qv.z, qv.w], i * 4);
      if (pv) qv.premultiply(qi.set(pv[i * 4], pv[i * 4 + 1], pv[i * 4 + 2], pv[i * 4 + 3]).invert());
      else qv.premultiply(rootInv);                                                            // 根骨骼的父是带 -90°X 的 group
      outA.set([qv.x, qv.y, qv.z, qv.w], i * 4);
    }
    worldM.set(bone, wmA); worldV.set(bone, wvA);
    out.set(bone, new THREE.QuaternionKeyframeTrack('mixamorig' + bone + '.quaternion', times, outA));
  }

  /* 5) 根骨骼(Hips)位置：Mixamo 的位置轨道是"离地高度"（父级纯单位旋转），
   *    而 ValveBiped 的 Pelvis 父级带 -90°X —— 在它父级的局部空间里"向上"是 +Z。
   *    直接把 y 值填进去会让模型整体塌到地下 0.9m（名牌/三角标跟着飘在半空）。
   *    这里把高度按腿长比换算后写到 local.z，水平分量保持绑定值（水平位移交给服务器物理）。 */
  if (hipsPos) {
    const pv = new Float32Array(times.length * 3);
    const [hx, hy] = RT_HIPS_XY;
    for (let i = 0; i < times.length; i++) {
      pv[i * 3] = hx;
      pv[i * 3 + 1] = hy;
      pv[i * 3 + 2] = sampleNum(hipsPos, times[i], 3, 1) * RT_HRATIO;
    }
    out.set('__hipsPos', new THREE.VectorKeyframeTrack('mixamorigHips.position', times, pv));
  }

  return new THREE.AnimationClip(clip.name, clip.duration, [...out.values(), ...rest]);
}

/**
 * 同源动画适配：把 `足球动作包` 的 ValveBiped 骨骼名改成模型用的名字。
 * 这批动画与模特包**同源**（绑定姿势差 0.0°），所以**只改名、不重定向** —— 姿态天然正确。
 * 顺带把落在骨架里没有的骨头（颈链/手指细节）的轨道丢掉，避免绑定警告。
 * @returns {number} 改名后的轨道数（0 表示这不是同源动画）
 */
const V2M = (() => {
  // ValveBiped 全名 → 模型骨骼名（模型已被 RENAME 改成 mixamorig*）
  const out = {};
  for (const [v, m] of Object.entries(RENAME)) out[v] = m;
  return out;
})();
/* 模型骨架里**没有**对应骨头的前缀/名字 —— 这些轨道要丢掉（否则一堆绑定警告） */
function adaptValveClip(clip) {
  const tracks = [];
  let mapped = 0;
  for (const tr of clip.tracks) {
    const dot = tr.name.lastIndexOf('.');
    if (dot < 0) continue;
    const bone = tr.name.slice(0, dot), prop = tr.name.slice(dot + 1);
    const to = V2M[bone] || bone;
    let values = tr.values;
    /* 根位移节点：水平位移交给服务器物理，这里把 X/Z 钉到首帧
     * （保留 Y —— 蹲伏/起跳的上下起伏还要用）。
     * 该节点的 local +Z 就是世界前进方向，冻结后动画不再"跑出去又缩回来"。 */
    if (/skeleton$/i.test(bone) && prop === 'position') {
      values = Float32Array.from(values);
      const x0 = values[0], z0 = values[2];
      for (let i = 0; i < values.length; i += 3) { values[i] = x0; values[i + 2] = z0; }
    }
    tracks.push(new (tr.constructor)(to + '.' + prop, tr.times, values));
    if (V2M[bone]) mapped++;
  }
  return mapped ? new THREE.AnimationClip(clip.name, clip.duration, tracks) : null;
}

/**
 * 统一的动画适配入口：按轨道骨骼名自动判别是"同源包"还是"Mixamo 旧包"。
 *  - 轨道名带 `ValveBiped_Bip01_` → 同源（足球动作包）→ 只改名
 *  - 轨道名带 `mixamorig`           → 旧 Mixamo 包      → 世界空间重定向
 * 两种情况都要求模型是 ValveBiped（char.fbx）；回退用 idle.glb 时原样直用。
 */
function adaptClip(clip, modelIsValve) {
  if (!modelIsValve) return clip;
  if (!clip.tracks.length) return clip;
  // 只要**任意**一条轨道是 ValveBiped 骨骼名，就认定是同源包
  // （不能只看第一条 —— 第一条通常是根位移节点 root_skeleton）
  if (clip.tracks.some((t) => /ValveBiped/i.test(t.name))) return adaptValveClip(clip) || clip;
  if (clip.tracks.some((t) => /mixamorig/i.test(t.name))) return retargetValve(clip);
  return clip;
}

/**
 * 载入模型与全部动画。
 * 模型来自 idle.glb（唯一带网格的文件，mixamo 角色），
 * 动画全部来自独立的 *.glb（只含骨架 + 一个 clip，按骨骼名绑定到模型骨架）。
 */
export async function loadAssets(onProgress) {
  const names = Object.keys(CLIP_FILES);
  let done = 0;
  const tick = () => { done++; if (onProgress) onProgress(done / (names.length + 1)); };

  /* ---- 模型加载顺序 ----
   * 1) char.glb  ← 首选。由 build-char.mjs 从 char.fbx 离线转出：
   *      · 剥掉了 FBX 里内嵌的 9 张 PNG（4.1MB，和 /char/*.png 完全重复）
   *      · GLB 的 float 数组 brotli 后只要 0.94MB，而 char.fbx 是 5.26MB —— 省 82%
   *      · 材质名已写成对应的贴图文件名（texture_1.png 等），客户端凭名字挂贴图
   * 2) char.fbx  ← 兼容旧部署（没跑过 build-char.mjs 时仍可用，只是首屏慢）
   * 3) idle.glb  ← Mixamo 原模型，最终兜底（不影响玩法）
   */
  let model = null, fromFbx = false, modelKind = '';
  try {
    const gltf = await loadOne(CHAR_GLB);
    model = gltf.scene;
    fromFbx = true;
    modelKind = 'char.glb';
  } catch (e) {
    try {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      model = await new Promise((res, rej) =>
        new FBXLoader().load('models/' + CHAR_FBX + '?v=' + ASSET_V, res, undefined, rej));
      fromFbx = true;
      modelKind = 'char.fbx';
    } catch (e2) {
      const gltf = await loadOne(MODEL_FILE);
      model = gltf.scene;
      modelKind = 'idle.glb';
    }
  }
  if (fromFbx) {
    // 骨骼改名（ValveBiped → Mixamo），否则动画一条都绑不上
    let renamed = 0;
    model.traverse((o) => { if (o.isBone && RENAME[o.name]) { o.name = RENAME[o.name]; renamed++; } });
    console.log('[人物] 模型 ' + modelKind + '，骨骼改名 ' + renamed + ' 根');
  } else {
    console.log('[人物] 模型 idle.glb（Mixamo 兜底）');
  }
  tick();

  // 统一身高到 1.8m（外层 Group 缩放，动画位移会一起被缩放，clip 不用改）
  const box = new THREE.Box3().setFromObject(model);
  const h = Math.max(0.2, box.max.y - box.min.y);
  const unitScale = 1.8 / h;

  /* ---- 新模型的贴图：不在模型里，全部外挂在 /char/*.png，按名字挂回去 ----
   * char.glb 的材质名就是贴图文件名（build-char.mjs 写入的），char.fbx 则要靠 map.name。
   * 贴图优先用 WebP（同画质只有 PNG 的 ~27%，见 build-webp.mjs），浏览器不支持则自动退回 PNG。 */
  const TEX_WEBP = (() => {
    try { return document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp'); }
    catch (e) { return false; }
  })();
  const texLoader = new THREE.TextureLoader();
  const texCache = new Map();
  const getCharTex = (fileName, flipY) => {
    const key = fileName + '|' + flipY;
    if (texCache.has(key)) return texCache.get(key);
    const base = 'char/' + fileName.replace(/\.(png|jpg|jpeg)$/i, '');
    const t = texLoader.load((TEX_WEBP ? base + '.webp' : base + '.png') + '?v=' + ASSET_V);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.flipY = flipY;                 // 跟随 FBX 原本的约定，避免上下颠倒
    texCache.set(key, t);
    return t;
  };

  model.traverse((o) => {
    if (o.isMesh) {
      o.frustumCulled = false;
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.material) {
        const fix = (m) => {
          const c = m.clone();
          if (fromFbx) {
            // 新模型：把 /char/<名字> 挂回对应材质（其余通道全部清掉，避免 404 变黑）
            // char.glb 材质名已是 "texture_1.png"；char.fbx 仍靠 map.name
            const orig = (c.map && c.map.name) || c.name || '';
            const flipY = c.map ? c.map.flipY : true;
            if (/^texture_\d+\.(png|jpg|jpeg|tga|dds)$/i.test(orig)) {
              c.map = getCharTex(orig, flipY);
              if (c.color) c.color.set('#ffffff');       // FBX 原色 #cccccc 会压暗贴图
            } else if (c.map) { c.map = null; }
            for (const k of ['normalMap', 'specularMap', 'bumpMap', 'aoMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'emissiveMap']) {
              if (c[k]) { c[k].dispose?.(); c[k] = null; }
            }
            c.needsUpdate = true;
            return c;
          }
          // GLB 转换时已去贴图；这里再兜底一次（mixamo 贴图是导出机路径，浏览器 404 → 全黑）
          for (const k of ['map', 'normalMap', 'specularMap', 'bumpMap', 'aoMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'emissiveMap']) {
            if (c[k]) { c[k].dispose?.(); c[k] = null; }
          }
          if (!c.color || (c.color.r === 0 && c.color.g === 0 && c.color.b === 0)) c.color = new THREE.Color('#c8ccd2');
          c.needsUpdate = true;
          return c;
        };
        o.material = Array.isArray(o.material) ? o.material.map(fix) : fix(o.material);
      }
    }
  });

  /* ★★ 眼球 UV 重投影（修「眼珠发白 / 瞳孔跑到上眼睑后面」）
   *
   *  模型里的「眼睛」不是画在脸皮上的，而是**独立网格**（材质名 texture_5.png，
   *  一张 128×128 的虹膜贴图：白眼球 + 中央褐色虹膜）。这个网格里包着**左右两个眼球球体**。
   *
   *  问题：FBX 转 GLB 之后两个球体的 UV 极点（= 贴图 (0.5,0.5) 落的位置）指在**上方偏外侧**，
   *  虹膜被皮肤/上眼睑挡住 → 近看就是「一只全白、一只只有半个瞳孔」。
   *  （实测：把眼球网格 visible=false 后，脸上根本没有画眼睛，所以不能简单隐藏。）
   *
   *  做法：不依赖原始 UV，直接用**几何方向**重新做一次极坐标展开 ——
   *    · 按 x 正负把顶点分成左右眼球，各自求球心
   *    · 顶点方向与「正前方 +Z」的夹角 θ 当极径，绕前方的方位角当极角
   *    · θ = 0（正前方）→ 贴图中心 (0.5, 0.5) = 虹膜正中对准正前方
   *    · θ 到 90° → 半径 0.5（正好用满贴图内切圆；圆外本来就是白眼球色）
   *  贴图是"白底 + 中央虹膜"，极径越小越靠虹膜，所以这样展开后瞳孔永远朝正前方。
   *  眼球没有独立骨骼（53 骨里没有 eye），只能整颗跟着头转，所以固定朝前就是正确表现。
   */
  const EYE_PITCH = 0.34;          // 虹膜俯仰校正（贴图 v 单位，实测扫出来的）
  function fixEyeUV(root) {
    let n = 0;
    root.traverse((o) => {
      if (!o.isMesh) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      // 识别眼球网格：材质名（char.glb）或贴图 url（char.fbx 兜底时材质名不带 texture_5）
      const isEye = ms.some((m) => m && (/texture_5/i.test(m.name || '')
        || (m.map && m.map.image && /texture_5/i.test((m.map.image.src || '') + ' ' + (m.name || '')))));
      if (!isEye) return;
      const geo = o.geometry;
      const pos = geo.attributes.position;
      if (!pos || !geo.attributes.uv) return;

      /* ★★ 眼球贴图是「球面展开 + UV 环绕」的：实测左眼 u∈[-2.035,-1.060]、
       *   右眼 u∈[0.052,1.031]（各覆盖一整个 2π），虹膜中心落在 u=0.5+k、v=0.5。
       *   原模型的虹膜被转到了**上/外侧**，被上眼睑挡住 → 近看「一只全白、一只半个瞳」。
       *
       *   正确修法不是重投影（会把虹膜大小/形状搞乱），而是**每只眼睛各自平移 UV**：
       *     · 找出该眼球上「方向最接近正前方(+Z)」的那个顶点，读它的 uv
       *     · 平移量 Δ = 虹膜中心 uv − 该顶点 uv，整只眼睛的 uv 都加上 Δ
       *   → 虹膜正好落在"正前方"那个顶点上，大小/形状完全不变。
       *
       *   两个坑（都踩过）：
       *   ① 顶点属性**跨网格共享**（9 个网格引用同一批 accessor），
       *      直接 setXY 会把整具模型的 UV 改掉（整个身体变成眼球贴图）。
       *      ⇒ 必须先 uv.clone() 出自己的那一份。
       *   ② 每个网格都带全量 99141 个顶点，只有 index 挑出来的才是自己的三角形
       *      （眼球只有 960 个 index）。⇒ 只用 index 引用到的顶点。 */
      let uv = geo.attributes.uv;
      if (!uv.__eyeFixed) { uv = uv.clone(); uv.__eyeFixed = true; geo.setAttribute('uv', uv); }

      const idx = geo.index;
      const used = idx ? Array.from(new Set(Array.from(idx.array))) : Array.from({ length: pos.count }, (_, k) => k);
      const G = [{ cx: 0, cy: 0, cz: 0, u0: 9, u1: -9, n: 0 }, { cx: 0, cy: 0, cz: 0, u0: 9, u1: -9, n: 0 }];
      const sideOf = new Map();
      for (const i of used) {
        const g = pos.getX(i) < 0 ? 0 : 1;
        sideOf.set(i, g);
        const q = G[g];
        q.cx += pos.getX(i); q.cy += pos.getY(i); q.cz += pos.getZ(i);
        q.u0 = Math.min(q.u0, uv.getX(i)); q.u1 = Math.max(q.u1, uv.getX(i));
        q.n++;
      }
      for (const q of G) if (q.n) { q.cx /= q.n; q.cy /= q.n; q.cz /= q.n; }

      /* 每只眼睛各自算平移量。
       *
       *  实测（离线量的方向 ↔ UV 对应，见 probe-eye2.mjs）：
       *    眼球的 UV 是**绕 ±X 轴展开**的 —— v 管"前/后"（+Z 在 v≈0.82、-Z 在 v≈0.14），
       *    u 管"上下左右转"（+X 在 u≈0.11、-X 在 u≈0.85）。
       *  贴图里的虹膜在**正中央 (0.5,0.5)**，所以原来虹膜指向的是 **-Y（正下方）** ——
       *  从上往下看就是一颗白眼球（虹膜藏在下面）。
       *
       *  ★ 还踩过一个坑：**左眼的 u 是负的**（-2.035~-1.060），贴图是 ClampToEdge，
       *    负 u 会采到边缘的白色 → 左眼永远是纯白。
       *
       *  修法（对左右眼都一样，一行公式）：
       *    让「方向最接近正前方 +Z」的那个顶点**采样到贴图正中心 (0.5,0.5)** ——
       *    du = 0.5 - u(+Z顶点)，dv = 0.5 - v(+Z顶点)。
       *  这样虹膜正好落在眼球正前方，同时 u 范围被带进 [0,1]（左眼顺势 +2，消除负 u）。
       */
      const shift = G.map((q, qi) => {
        if (!q.n) return [0, 0];
        let front = -1, best = -9;
        for (const i of used) {
          if (sideOf.get(i) !== qi) continue;
          const dx = pos.getX(i) - q.cx, dy = pos.getY(i) - q.cy, dz = pos.getZ(i) - q.cz;
          const len = Math.hypot(dx, dy, dz) || 1;
          if (dz / len > best) { best = dz / len; front = i; }     // 与 +Z 最接近
        }
        if (front < 0) return [0, 0];
        let du = 0.5 - uv.getX(front);
        /* EYE_PITCH：虹膜相对"眼球正前方"还要再抬高一点。
         * 这个 0.34 是**实测扫描**出来的（dbg-eyesweep.mjs 一次拍 6 个偏移量对比）：
         * 不校正是白眼球、-0.34 是往下看、**+0.34 才是正对镜头**。
         * 原因：眼球的"可视球冠"中心并不在绑定空间的 +Z 上（绑定的轴向和游戏里的朝向差一截）。 */
        const dv = (0.5 + EYE_PITCH) - uv.getY(front);
        // 兜底：u 平移后整体仍要落在 [0,1]（左眼 -2.03 起 → +2 后正好 0~0.97）
        if (q.u0 + du < -0.001) du += Math.ceil(-(q.u0 + du));
        if (q.u1 + du > 1.001) du -= Math.ceil(q.u1 + du - 1);
        return [du, dv];
      });
      for (const i of used) {
        const s2 = shift[sideOf.get(i)] || [0, 0];
        uv.setXY(i, uv.getX(i) + s2[0], uv.getY(i) + s2[1]);
      }
      uv.needsUpdate = true;
      n++;
    });
    if (n) console.log('[人物] 眼球 UV 已按眼平移校正（' + n + ' 个网格）→ 瞳孔朝正前方');
    return n;
  }
  if (fromFbx) fixEyeUV(model);

  // 动画 glb：取第一个有内容的 clip（根位移已在转换时冻结，这里再冻结一次兜底）
  const pick = (arr) => {
    if (!arr) return null;
    return arr.find(c => c && c.tracks && c.tracks.length > 0) || null;
  };
  /* ---- 渐进式加载 ----
   * 首屏只需要"马上会用到"的动作（跑/传/射/铲/受击），
   * 舞蹈 / 攻击 / 门将 / 备用 这些几十秒内不会触发的，等进游戏后在后台补。
   * 高延迟下这一步能省掉 20+ 次 RTT（3G 下实测差别很大）。 */
  const coreNames = names.filter((n) => CORE_CLIPS[n]);
  const lazyNames = names.filter((n) => !CORE_CLIPS[n]);
  const clips = {};
  const loadClipsInto = async (list) => {
    await Promise.all(list.map(async (n) => {
      const g = await loadOne(CLIP_FILES[n]);
      const c = pick(g.animations);
      if (c) { c.name = n; clips[n] = freezeRootMotion(c); }
      else console.warn('[动画] ' + n + ' 没有可用的 clip');
      g.scene?.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
      tick();
    }));
  };
  await loadClipsInto(coreNames);

  // 镜像出左侧版本
  if (clips.arcRight) clips.arcLeft = mirrorClip(clips.arcRight, 'arcLeft');
  if (clips.rightTurn) clips.leftTurn = mirrorClip(clips.rightTurn, 'leftTurn');

  /* 舞蹈：CLIP_FILES 里已经是 dance1..dance6 六个**独立**文件，不用再别名映射了。
   * （旧代码把 `dance` 改名为 `dance1`，于是 1~5 号键全放同一段 Gangnam。） */

  // ---- 队服贴图（红/蓝）----
  const loadTex = (u) => new Promise((res) => {
    texLoader.load(u + '?v=' + ASSET_V,
      (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; res(t); },
      undefined, () => res(null));
  });
  const kitTex = { A: await loadTex(KIT_TEX.A), B: await loadTex(KIT_TEX.B) };

  /* ---- 动画适配：同源包只改名 / 旧 Mixamo 包走世界空间重定向。
   * 抽成函数 —— 后台补加载的动画走同一条路径，保证行为一致。 ---- */
  const adaptAll = (bag, label) => {
    if (!fromFbx) return;
    const t0 = performance.now();
    let nSame = 0, nRetarget = 0;
    for (const k of Object.keys(bag)) {
      const before = bag[k];
      // 判定用 .some()（第一条轨道通常是根位移节点，不含 ValveBiped 前缀）
      const isValve = before.tracks.some((t) => /ValveBiped/i.test(t.name));
      bag[k] = adaptClip(before, true);
      if (isValve) nSame++; else nRetarget++;
    }
    console.log('[人物] 动画适配（' + label + '）：同源直绑 ' + nSame + ' 个 / 世界空间重定向 ' + nRetarget
      + ' 个，共 ' + Object.keys(bag).length + ' 个 clip，耗时 ' + (performance.now() - t0).toFixed(0) + 'ms');
  };
  adaptAll(clips, '首屏');

  if (fromFbx) {
    // 自检：确认绑上的轨道名确实是模型骨架里的（否则动画"能播但不动"）
    const boneSet = new Set();
    model.traverse((o) => { if (o.isBone) boneSet.add(o.name); });
    let total = 0, ok = 0;
    for (const c of Object.values(clips)) {
      for (const tr of c.tracks) {
        total++;
        const b = tr.name.split('.')[0];
        if (boneSet.has(b) || /Hips|skeleton/i.test(b)) ok++;
      }
    }
    console.log('[人物] 轨道绑定自检：' + ok + '/' + total + ' 条能绑上模型骨骼'
      + (ok === total ? '（全部命中）' : '  ← 有 ' + (total - ok) + ' 条绑不上！'));
  }

  /* ---- 后台补加载：返回一个函数，调用方在进入游戏后调它即可 ----
   * 不会打断正在播的动画（调用方用 Character.addClips 增量挂）。 */
  let lazyBusy = false;
  const loadLazy = async () => {
    if (lazyBusy || !lazyNames.length) return {};
    lazyBusy = true;
    const bag = {};
    const names0 = Object.keys(clips);
    await Promise.all(lazyNames.map(async (n) => {
      try {
        const g = await loadOne(CLIP_FILES[n]);
        const c = pick(g.animations);
        if (c) { c.name = n; bag[n] = freezeRootMotion(c); }
        g.scene?.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
      } catch (e) { console.warn('[动画] 后台补加载失败 ' + n, e); }
    }));
    adaptAll(bag, '后台');
    console.log('[人物] 后台补加载完成：' + Object.keys(bag).length + ' 个动作（' + names0.length + ' → '
      + (Object.keys(clips).length + Object.keys(bag).length) + '）');
    return bag;
  };

  return { model, clips, unitScale, kitTex, fromFbx, loadLazy, lazyCount: lazyNames.length };
}

/** 复制一份角色（骨架独立，几何/材质共享） */
export function cloneCharacter(model, unitScale) {
  const holder = new THREE.Group();
  const c = skeletonClone(model);
  holder.add(c);
  holder.scale.setScalar(unitScale);
  c.traverse((o) => {
    if (o.isMesh) { o.frustumCulled = false; }
  });
  return { holder, inner: c };
}
