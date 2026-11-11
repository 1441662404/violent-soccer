/* 旋转球物理定标验证 —— 对照真实数据：
 *  · 贝克汉姆圆月弯刀：~25m 弧线横移 2~3.5m，球速 20~30m/s，转速 6~10 转/s
 *  · C罗电梯球：25~30m，几乎不旋转但下坠急（这里用上旋近似），过门楣后急坠
 *  · 后旋长传：滞空比无旋长 15~30%
 * 用法：node verify-magnus.mjs */
'use strict';
const SH = require('./public/js/shared.js');
const C = SH.C;
const G = C.GRAVITY;

function sim(vx, vy, vz, sx, sy, label) {
  const b = { x: 0, y: C.BALL_R, z: 0, vx, vy, vz, wx: 0, wy: 0, owner: null };
  const sp = SH.spinFromSpot(sx, sy);
  b.wx = sp.wx; b.wy = sp.wy;
  const v0 = Math.hypot(vx, vy, vz) * sp.powerMul;
  const l0 = Math.hypot(vx, vz);
  b.vx *= sp.powerMul; b.vy *= sp.powerMul; b.vz *= sp.powerMul;
  const dt = 1 / 240;
  let t = 0, maxZ = 0, peakY = 0, landT = 0, landDist = 0, firstLandT = 0;
  while (t < 6) {
    const pvz = b.vz, pvy = b.vy;
    SH.stepBall(b, dt);
    t += dt;
    if (b.y > peakY) peakY = b.y;
    if (firstLandT === 0 && pvy < 0 && b.y <= C.BALL_R + 0.001 && t > 0.05) { firstLandT = t; landDist = b.z; }
    if (pvy > 0 && b.vy <= 0 && maxZ === 0) maxZ = b.z;
    if (firstLandT) break;
  }
  // 无旋对照
  const b2 = { x: 0, y: C.BALL_R, z: 0, vx, vy, vz, wx: 0, wy: 0, owner: null };
  let t2 = 0, land2 = 0;
  const dt2 = 1 / 240;
  while (t2 < 6) {
    const pvy2 = b2.vy;
    SH.stepBall(b2, dt2);
    t2 += dt2;
    if (pvy2 < 0 && b2.y <= C.BALL_R + 0.001 && t2 > 0.05) { land2 = b2.z; break; }
  }
  const drift = b.z - land2, side = Math.abs(b.x);
  console.log(`\n[${label}] v0=${(v0 * 3.6).toFixed(0)}km/h sy=${sy} sx=${sx}`);
  console.log(`  一次落地: 距离 ${landDist.toFixed(1)}m (无旋对照 ${land2.toFixed(1)}m, 差 ${drift >= 0 ? '+' : ''}${drift.toFixed(1)}m) t=${firstLandT.toFixed(2)}s 侧偏 ${side.toFixed(2)}m 峰高 ${peakY.toFixed(2)}m`);
  return { landDist, land2, side, firstLandT, peakY };
}

console.log('=== 香蕉球：25m/s 45° 向 +z 飞，满侧旋 ===');
// 打右脚内侧弧线（打球的右侧 sx>0）→ 球往左弯（x 负方向）。为了看见侧偏，初始 vx 给 0，侧力会让球拐出 x。
sim(0, 7, 25, 0, 0, '无旋基准');
sim(0, 7, 25, 1, 0, '满右侧旋(应往左弯 x<0)');
sim(0, 7, 25, -1, 0, '满左侧旋(应往右弯 x>0)');

console.log('\n=== 电梯球：26m/s 低平，满上旋（应落点近、下坠急）===');
sim(0, 4, 26, 0, 0, '无旋基准');
sim(0, 4, 26, 0, 1, '满上旋(下坠, 落点应近)');

console.log('\n=== 后旋长传：20m/s 高吊，满后旋（应滞空久、落点远）===');
sim(0, 10, 20, 0, 0, '无旋基准');
sim(0, 10, 20, 0, -1, '满后旋(滞空久)');

console.log('\n=== 力量折扣 ===');
const s0 = SH.spinFromSpot(0, 0), sf = SH.spinFromSpot(1, 1), sh = SH.spinFromSpot(0.5, -0.5);
console.log(`中心 powerMul=${s0.powerMul}  满格=${sf.powerMul.toFixed(2)} (wx=${sf.wx}, wy=${sf.wy})  半格=${sh.powerMul.toFixed(2)}`);
