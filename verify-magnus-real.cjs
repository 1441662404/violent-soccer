const SH = require('./public/js/shared.js');
const C = SH.C;

// 沿 +z 飞（wx = 上旋/后旋横轴，wy = 侧旋竖直轴），量侧偏/最高点/滞空
function sim(v, elevDeg, wx, wy, maxDist) {
  const e = elevDeg * Math.PI / 180;
  const b = { x: 0, y: C.BALL_R, z: 0, vx: 0, vy: v * Math.sin(e), vz: v * Math.cos(e), wx, wy, owner: null };
  const dt = 1 / 240; let t = 0;
  let maxLat = 0, maxY = 0, air = 0;
  while (t < 8) {
    SH.stepBall(b, dt); t += dt;
    if (Math.abs(b.x) > Math.abs(maxLat)) maxLat = b.x;
    if (b.y > maxY) maxY = b.y;
    if (b.y > C.BALL_R + 0.02) air = t;
    if (b.z >= maxDist) break;
  }
  return { lat: maxLat, maxY, air, t, dist: b.z };
}
const f = (x) => x.toFixed(2);

console.log('=== A. 真实数据函数自洽性校验（Goff & Carré AJP 77:1020）===');
{
  const r = sim(18.5, 18, 0, 64, 18);
  console.log(`Carré2002 v=18.5 ω=64 18m → 侧偏 ${f(r.lat)}m（论文实测 >3m）`);
  const r2 = sim(25, 20, 0, 60, 18);
  console.log(`Bray2003 v=25 ω=60 18m 仰角20° → 侧偏 ${f(r2.lat)}m`);
}

console.log('\n=== B. 满侧旋（10转/s=62.8）25m 航程横移 vs 球速（仰角 16°，任意球典型）===');
for (const v of [18, 22, 25, 30]) {
  const r = sim(v, 16, 0, 62.8, 25);
  console.log(`v=${v} → 横移 ${f(r.lat)}m（滞空 ${f(r.air)}s）`);
}

console.log('\n=== C. 后旋长传 vs 无旋（v=24 仰角 24°）===');
for (const [tag, wx] of [['无旋', 0], ['后旋满(-62.8)', -62.8], ['上旋满(+62.8)', 62.8]]) {
  const r = sim(24, 24, wx, 0, 60);
  console.log(`${tag} → 最高 ${f(r.maxY)}m 滞空 ${f(r.air)}s`);
}

console.log('\n=== D. 电梯球额外下坠（上旋，v=28 仰角 14°）===');
{
  const a = sim(28, 14, 0, 0, 30), b = sim(28, 14, 62.8, 0, 30);
  console.log(`无旋最高 ${f(a.maxY)}m / 上旋最高 ${f(b.maxY)}m → 额外下坠 ${f(a.maxY - b.maxY)}m`);
}
