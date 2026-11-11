import * as THREE from 'three';

/* ============================================================
 *  足球场：草地条纹 + 全部白线（烘焙进一张 canvas 纹理）
 *  球门、球网、看台、灯塔、天空
 *  坐标：长边 X（±HALF_L），宽边 Z（±HALF_W），y=0 为地面
 * ============================================================ */
const C = window.SHARED.C;
const { HALF_L, HALF_W } = C.FIELD;

/* 贴图覆盖范围：比球场大 PAD（场外缓冲区），
 * 关键 —— 贴图要铺满整块地板 PlaneGeometry(含 PAD)，所以映射必须把 PAD 算进去，
 * 否则边线/球门线会被画到地板边缘（离真实球门 12m）。 */
const PAD = 12;

/* 世界坐标 → 贴图 canvas 坐标（含 PAD） */
function makeMapper(W, H) {
  const WL = HALF_L + PAD, WD = HALF_W + PAD;
  return (x, z) => ({
    u: (x + WL) / (2 * WL) * W,
    v: (WD - z) / (2 * WD) * H,
  });
}

/**
 * 草皮"绒毛"细节：一张可平铺的法线贴图 + 粗糙度贴图。
 * 做法：先在 512 画布上画草丝高度场（顺修剪方向的短竖线 + 两层值噪声），
 * 再用 Sobel 差分算成法线（边界环绕，保证平铺无缝）。
 * 贴图以小尺度重复很多次（≈每格 3m、单像素 0.6cm），所以近看是草丝、
 * 远看是细腻的绒面，而不是一块糊掉的平色。
 */
function grassDetailTextures() {
  const S = 512;
  const hgt = document.createElement('canvas');
  hgt.width = hgt.height = S;
  const h = hgt.getContext('2d');
  h.fillStyle = '#808080';
  h.fillRect(0, 0, S, S);
  // ① 两层值噪声（低频起伏：草皮的凹凸不平）
  const noise = (cells, alpha) => {
    const grid = [];
    for (let i = 0; i < cells * cells; i++) grid.push(Math.random());
    const img = h.getImageData(0, 0, S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const fx = x / S * cells, fy = y / S * cells;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const at = (a, b) => grid[((b % cells) + cells) % cells * cells + (((a % cells) + cells) % cells)];
        const v = (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy)
                + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
        const i4 = (y * S + x) * 4;
        // ★ 累加（不是覆盖）：多层噪声叠起来才有"细密"的层次
        const nv = (d[i4] - 128) + (v - 0.5) * 255 * alpha;
        const o = Math.max(0, Math.min(255, 128 + nv));
        d[i4] = d[i4 + 1] = d[i4 + 2] = o;
        d[i4 + 3] = 255;
      }
    }
    h.putImageData(img, 0, 0);
  };
  // ★ 关键：低频必须很淡。给多了近看就是揉皱的纸（法线大起伏造成的斜向褶皱），
  //   真实草面近看是细密颗粒，几乎没有大尺度起伏。
  noise(6, 0.035);     // 低频：几乎不做
  noise(19, 0.075);    // 中频：淡淡草簇
  noise(48, 0.22);     // 高频：细密绒毛（主力）
  noise(96, 0.26);     // 更高频：一根根草叶的碎粒
  noise(160, 0.14);    // 最细：砂粒级
  // ② 草丝：短笔画，**方向随机**（原来几乎全朝一个方向 → 画面会呈现"拉丝"感，
  //    而真实草叶是各朝各的，远看才是均匀的绒面）
  h.lineWidth = 1;
  for (let i = 0; i < 14000; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const len = 2 + Math.random() * 7;
    const v = Math.random();
    const g0 = v < 0.5 ? 96 + Math.random() * 26 : 150 + Math.random() * 40;
    h.strokeStyle = `rgba(${g0 | 0},${g0 | 0},${g0 | 0},${0.5 + Math.random() * 0.45})`;
    h.beginPath();
    h.moveTo(x, y);
    const ang = Math.random() * Math.PI * 2;
    h.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    h.stroke();
  }
  // ③ 细砂噪声
  for (let i = 0; i < 34000; i++) {
    const g0 = (Math.random() * 90 + 83) | 0;
    h.fillStyle = `rgba(${g0},${g0},${g0},0.5)`;
    h.fillRect(Math.random() * S, Math.random() * S, 1, 1);
  }

  // ④ Sobel → 法线贴图（环绕采样，无缝）
  const src = h.getImageData(0, 0, S, S).data;
  const ncv = document.createElement('canvas');
  ncv.width = ncv.height = S;
  const nc = ncv.getContext('2d');
  const nimg = nc.createImageData(S, S);
  const hAt = (x, y) => src[((((y % S) + S) % S) * S + (((x % S) + S) % S)) * 4] / 255;
  const STR = 1.7;                       // 起伏强度（近看要细，不要皱）
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (hAt(x + 1, y) - hAt(x - 1, y)) * STR;
      const dy = (hAt(x, y + 1) - hAt(x, y - 1)) * STR;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const i4 = (y * S + x) * 4;
      nimg.data[i4] = (nx * 0.5 + 0.5) * 255;
      nimg.data[i4 + 1] = (ny * 0.5 + 0.5) * 255;
      nimg.data[i4 + 2] = (nz * 0.5 + 0.5) * 255;
      nimg.data[i4 + 3] = 255;
    }
  }
  nc.putImageData(nimg, 0, 0);

  // ⑤ 粗糙度贴图：草尖反光强一点、根部哑光 → 用高度场反相做个近似
  const rcv = document.createElement('canvas');
  rcv.width = rcv.height = S;
  const rc = rcv.getContext('2d');
  rc.drawImage(hgt, 0, 0);
  const rimg = rc.getImageData(0, 0, S, S);
  for (let i = 0; i < rimg.data.length; i += 4) {
    const v = rimg.data[i] / 255;                    // 0..1
    const rough = 0.92 + (1 - v) * 0.08;             // 0.92 ~ 1.0：完全哑光 —— 真实草叶几乎不反光，
                                                     // 之前给到 0.62 时草尖会有明显高光带（用户说的"反光"）
    const o = (rough * 255) | 0;
    rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = o;
  }
  rc.putImageData(rimg, 0, 0);

  // ⑥ 草丝微细节（可平铺灰度图）：近看时乘在底色上，才有"一根根草"的绒毛感
  //    贴在 shader 里做乘性调制，所以设计成中值 0.5、上下浮动
  const fcv = document.createElement('canvas');
  fcv.width = fcv.height = S;
  const fc = fcv.getContext('2d');
  fc.fillStyle = '#808080';
  fc.fillRect(0, 0, S, S);
  fc.lineWidth = 1;
  for (let i = 0; i < 56000; i++) {                 // 一根根草丝：方向全随机、笔触短
    const x = Math.random() * S, y = Math.random() * S;
    const len = 1.5 + Math.random() * 4.0;
    const ang = Math.random() * Math.PI * 2;
    const t = Math.random();
    const v = t < 0.5 ? 74 + Math.random() * 44 : 152 + Math.random() * 62;
    fc.strokeStyle = `rgba(${v | 0},${v | 0},${v | 0},${0.22 + Math.random() * 0.26})`;
    fc.beginPath();
    fc.moveTo(x, y);
    fc.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    fc.stroke();
  }
  for (let i = 0; i < 44000; i++) {                 // 草尖高光 / 根部阴影的点
    const v = Math.random() < 0.45 ? 168 + Math.random() * 70 : 68 + Math.random() * 44;
    fc.fillStyle = `rgba(${v | 0},${v | 0},${v | 0},0.24)`;
    fc.fillRect(Math.random() * S, Math.random() * S, 1, 1);
  }

  const mk = (cv2, srgb) => {
    const t = new THREE.CanvasTexture(cv2);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { normal: mk(ncv, false), rough: mk(rcv, false), fiber: mk(fcv, false) };
}

function pitchTexture() {
  const WL = HALF_L + PAD, WD = HALF_W + PAD;
  const W = 4096, H = Math.round(W * (WD / WL));      // 含缓冲区，31.7px/m
  const PPM = W / (2 * WL);                            // 像素/米（横竖一致）
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const P = makeMapper(W, H);

  // --- 草地打底（整块，含场外缓冲区）---
  //   原来场外单独填一个更暗的平色 → 比条纹区暗，看起来像"陷在阴影里"。
  //   真实球场的修剪是一致的，所以这里直接用条纹的平均色打底，再让条纹铺满整块草地。
  g.fillStyle = '#627a31';
  g.fillRect(0, 0, W, H);
  // --- 草地底色 + 修剪条纹（只画球场范围）---
  //     对着 FC26 的白天草皮取样：中明度的草绿、带一点点黄，
  //     条纹是**清晰可见的深浅交替宽带**（对比约 13%），这是草坪"质感"的第一来源。
  const p0 = P(-HALF_L, HALF_W), p1 = P(HALF_L, -HALF_W);
  const px = Math.min(p0.u, p1.u), pw = Math.abs(p1.u - p0.u);
  const pz = Math.min(p0.v, p1.v), ph = Math.abs(p1.v - p0.v);
  const stripes = 20;      // 比赛区条数（105m ÷ 5.25m）；整块草地按同样宽度外推
  // 真实球场的修剪条纹**没有硬边界**：草叶倒伏方向是逐渐变的，加上草面本身的起伏，
  // 交界处是一条柔和的过渡带（不是一条直线）。所以这里用一条沿 X 的线性渐变，
  // 每条条纹中心是纯色、两侧各留 EDGE 比例的过渡带，相邻条纹之间平滑接上。
  const LIGHT = '#6a8437', DARK = '#5a6f2e';   // 对齐 FC：色相更绿(≈84)、明度压暗(≈37)、饱和略提(≈38)
  const EDGE = 0.055;                           // 交界过渡带（再收一半）
  // ① 先在**小尺寸离屏画布**上画条纹（条纹本身是平滑渐变，放大 4 倍不失真，而且快）
  //    条数按"单条物理宽度不变"外推到整块草地（含场外），让场内场外是同一片草地。
  const stripeM = (HALF_L * 2) / stripes;                 // 单条宽度（米）≈5.25m
  const stripeN = Math.max(2, Math.round((WL * 2) / stripeM));
  const SW3 = 1024, SH3 = Math.max(64, Math.round(SW3 * H / W));
  const scv = document.createElement('canvas'); scv.width = SW3; scv.height = SH3;
  const sg2 = scv.getContext('2d');
  const sg = sg2.createLinearGradient(0, 0, SW3, 0);
  for (let i = 0; i < stripeN; i++) {
    const w = 1 / stripeN;
    const c = i % 2 ? LIGHT : DARK;
    sg.addColorStop(Math.min(1, i * w + w * EDGE * 0.5), c);
    sg.addColorStop(Math.max(0, (i + 1) * w - w * EDGE * 0.5), c);
  }
  sg2.fillStyle = sg; sg2.fillRect(0, 0, SW3, SH3);
  // ② 草线是**笔直的**（用户明确要求直线边界）；条纹**铺满整块草地**，场内场外不断开。
  //    备注：之前试过"整排条纹横向位移"做局部毛糙，用户否掉了。
  g.drawImage(scv, 0, 0, W, H);
  // 极轻的湿度斑（只用来破掉"绝对纯色"，量要少 —— 多了会把条纹糊掉，那就不像草皮了）
  for (let i = 0; i < 300; i++) {
    const cx = Math.random() * W, cy = Math.random() * H;
    const r = 40 + Math.random() * 120;
    const light = Math.random() < 0.5;
    const a = 0.004 + Math.random() * 0.007;
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    gr.addColorStop(0, light ? `rgba(172,196,152,${a})` : `rgba(36,42,22,${a})`);   // 暗斑更沉 → 层次更真
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  }
  // 草丝：沿修剪方向（贴图 v 轴）的短笔画 —— 细密、均匀，出"绒"的关键
  g.lineWidth = 1;
  for (let i = 0; i < 42000; i++) {
    const x = Math.random() * W, y = Math.random() * H;
    const len = 3 + Math.random() * 8;
    const t = Math.random();
    g.strokeStyle = t < 0.4 ? `rgba(166,196,150,${0.025 + Math.random() * 0.04})`
                  : t < 0.78 ? `rgba(46,50,28,${0.025 + Math.random() * 0.045})`
                             : `rgba(196,216,178,${0.015 + Math.random() * 0.03})`;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (Math.random() - 0.5) * 1.5, y - len);
    g.stroke();
  }
  // ===== 草面「踩踏 / 坑洼」：用**值噪声**做不规则斑块 =====
  //   真实草皮被踩过的地方是"成片的不规则明暗"，不是一颗颗圆点：
  //     · 低洼 / 被踩实 → 暗（草倒伏、照不到光）
  //     · 草叶翘起 / 迎着阳光 → 亮
  //     · 被磨秃的地方 → 露出偏黄的草根土色
  //   做法：在 1/8 分辨率的离屏画布上用值噪声算一张"明暗斑块图"，
  //        再放大贴到主贴图上 —— 浏览器双线性放大刚好给出自然柔和的边缘，而且快。
  (function wornPatches() {
    const SW = 1024, SH = Math.max(64, Math.round(SW * H / W));
    const oc = document.createElement('canvas');
    oc.width = SW; oc.height = SH;
    const og = oc.getContext('2d');
    const img = og.createImageData(SW, SH);
    const dt = img.data;
    // 值噪声：格点随机 + smoothstep 双线性插值
    const makeNoise = (cells) => {
      const cw = Math.ceil(cells) + 2, ch = Math.ceil(cells) + 2;
      const gd = new Float32Array(cw * ch);
      for (let i = 0; i < gd.length; i++) gd[i] = Math.random();
      return (u, v) => {
        const x = u * cells, y = v * cells;
        const x0 = Math.floor(x), y0 = Math.floor(y);
        const fx = x - x0, fy = y - y0;
        const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
        const at = (a, b) => gd[Math.min(ch - 1, b) * cw + Math.min(cw - 1, a)];
        return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy)
             + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
      };
    };
    // 尺度换算：离屏 512px 放大到 4096px（×8），贴图 31.7px/m
    // → 噪声格边长 ≈ 129/cells 米。所以 cells 要够大，斑块才细：
    // 尺度换算：离屏 1024px 对应 129m → 噪声格边长 ≈ 129/cells 米
    const n1 = makeNoise(80);   // ≈1.6m（原来 3.6m，再降一档）
    const n2 = makeNoise(180);  // ≈0.7m：主力
    const n3 = makeNoise(360);  // ≈0.36m：细碎
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        const u = x / SW, v = y / SH;
        const a1 = n1(u, v), a2 = n2(u, v), a3 = n3(u, v);
        const val = a1 * 0.28 + a2 * 0.38 + a3 * 0.34;
        const d = val - 0.5;
        const i = (y * SW + x) * 4;
        // 强度按 FC 实测比例：我的起伏原本是它的 2.5~3.2 倍 → 全部砍到约 1/3
        if (d > 0.012) {                       // 亮：草叶翘起 / 迎着阳光
          dt[i] = 192; dt[i + 1] = 212; dt[i + 2] = 186;
          dt[i + 3] = Math.min(10, d * 2 * 13);
        } else if (d < -0.012) {               // 暗：低洼 / 被踩实
          dt[i] = 28; dt[i + 1] = 36; dt[i + 2] = 22;
          dt[i + 3] = Math.min(11, -d * 2 * 15);
        } else { dt[i + 3] = 0; }
        // 被磨秃的地方：叠一点偏黄的草根土色（只在极低的噪声区）
        if (a1 < 0.22) {                        // 少数被磨秃、露草根土色的地方
          const k = (0.22 - a1) / 0.22;
          const al = Math.min(6, k * 13);
          if (al > dt[i + 3]) { dt[i] = 132; dt[i + 1] = 138; dt[i + 2] = 108; dt[i + 3] = al; }
        }
      }
    }
    og.putImageData(img, 0, 0);
    // 放大前先轻度模糊：否则双线性插值会在斜视角下留下"菱形/拉丝"纹路
    const oc2 = document.createElement('canvas');
    oc2.width = SW; oc2.height = SH;
    const og2 = oc2.getContext('2d');
    og2.filter = 'blur(1.6px)';
    og2.drawImage(oc, 0, 0);
    g.drawImage(oc2, 0, 0, W, H);              // 放大贴上（双线性 → 边缘自然）
  })();

  // 极细颗粒（草尖 / 枯草）：量少而细，保持"干净"，别做成噪点
  for (let i = 0; i < 15000; i++) {
    const a = Math.random() * 0.03;
    const t = Math.random();
    g.fillStyle = t < 0.28 ? `rgba(184,208,172,${a})`
                  : t < 0.58 ? `rgba(34,40,22,${a})`
                  : t < 0.84 ? `rgba(142,142,110,${a * 0.85})`   // 原来是黄褐(162,140,86) → 偏灰绿
                             : `rgba(118,126,102,${a * 0.75})`;
    const s = 1 + Math.random() * 1.5;
    g.fillRect(Math.random() * W, Math.random() * H, s, s);
  }

  // --- 白线（真实线宽 12cm ≈ 0.12 × 31.7 = 3.8px）---
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.fillStyle = 'rgba(255,255,255,0.95)';
  const LW = Math.max(3, 0.12 * PPM);
  g.lineWidth = LW;

  const line = (x1, z1, x2, z2) => {
    const a = P(x1, z1), b = P(x2, z2);
    g.beginPath(); g.moveTo(a.u, a.v); g.lineTo(b.u, b.v); g.stroke();
  };
  const rect = (x1, z1, x2, z2) => {
    const a = P(x1, z1), b = P(x2, z2);
    g.strokeRect(Math.min(a.u, b.u), Math.min(a.v, b.v), Math.abs(b.u - a.u), Math.abs(b.v - a.v));
  };
  const dot = (x, z, r) => {
    const a = P(x, z);
    g.beginPath(); g.arc(a.u, a.v, r, 0, Math.PI * 2); g.fill();
  };
  const arc = (cx, cz, r, a0, a1) => {
    const c = P(cx, cz);
    const ru = r / (2 * HALF_L) * W, rv = r / (2 * HALF_W) * H;
    g.beginPath(); g.ellipse(c.u, c.v, ru, rv, 0, a0, a1); g.stroke();
  };

  // 外框（球场线内缩一点，线本身要在场内）
  const M = 0;
  rect(-HALF_L + M, -HALF_W + M, HALF_L - M, HALF_W - M);
  // 中线 + 中圈
  line(0, -HALF_W + M, 0, HALF_W - M);
  const cc = (x, z) => { const p = P(x, z); return p; };
  { // 中圈用椭圆（贴图 x/y 比例不同）
    const c = cc(0, 0);
    const r = 9.15;
    g.beginPath();
    g.ellipse(c.u, c.v, r * PPM, r * PPM, 0, 0, Math.PI * 2);
    g.stroke();
  }
  dot(0, 0, LW * 1.6);

  // 两侧禁区 / 小禁区 / 罚球点 / 罚球弧
  for (const s of [-1, 1]) {
    const gl = s * HALF_L;              // 底线
    const inw = s * -1;                 // 指向场内
    const boxD = 16.5, smallD = 5.5;
    const boxHW = 20.16, smallHW = 9.16;
    rect(gl, -boxHW, gl + inw * boxD, boxHW);
    rect(gl, -smallHW, gl + inw * smallD, smallHW);
    dot(gl + inw * 11, 0, LW * 1.6);
    // （罚球弧/禁区弧按需求去掉，只保留禁区、小禁区、罚球点）
    // 角球弧
    for (const zs of [-1, 1]) {
      const cc2 = P(gl, zs * HALF_W);
      const rr = 1;
      g.beginPath();
      g.ellipse(cc2.u, cc2.v, rr * PPM, rr * PPM, 0, 0, Math.PI * 2);
      g.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function netTexture() {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.strokeStyle = 'rgba(240,246,252,0.95)';
  g.lineWidth = 2.4;
  for (let i = 0; i <= S; i += 8) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, S); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(S, i); g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;                 // 斜着看球门时不再摩尔纹闪
  return t;
}

/** 白天天空穹顶：真实大气散射渐变 + 太阳 + 体积感云层（摄影感晴天） */
function skyTexture() {
  const W = 2048, H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');

  // ① 大气散射渐变（**自然值**：天顶 S≈64 / 地平线 S≈26，越靠近地平线越白）
  //    上一版为了补 ACES 的去饱和把源色拉到 S≈97% → 渲染出来 S 88~96，像"壁纸蓝"，一眼假。
  //    实测真实晴天：天顶 S 55~70 L 50~62、低空 S 35~50 L 75~85，这里就按这个来。
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0.00, '#2867b8');
  grd.addColorStop(0.12, '#297dd6');
  grd.addColorStop(0.26, '#5a9bd8');
  grd.addColorStop(0.38, '#95bbda');
  grd.addColorStop(0.47, '#c2d4e0');
  grd.addColorStop(0.50, '#d2dde5');
  grd.addColorStop(0.62, '#dde4e9');
  grd.addColorStop(1.00, '#e4e9ec');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);

  // ② 地平线附近的大气暖带（很淡，只是让地平线不生硬）
  const warm = g.createLinearGradient(0, H * 0.36, 0, H * 0.52);
  warm.addColorStop(0, 'rgba(255,244,224,0)');
  warm.addColorStop(1, 'rgba(255,240,214,0.10)');
  g.fillStyle = warm; g.fillRect(0, H * 0.36, W, H * 0.16);

  // ③ 云：用**分形噪声（fBm）**生成 —— 之前是"叠一堆圆"，出来的云是棉花糖，一眼假。
  //    fBm 才有真实云那种丝絮状边缘和内部浓淡。在 512×256 上算（快），再放大贴到穹顶
  //    （云本来就是柔的，放大看不出损失）。
  {
    const CW = 512, CH = 256;
    const ccv = document.createElement('canvas'); ccv.width = CW; ccv.height = CH;
    const cg = ccv.getContext('2d');
    const img = cg.createImageData(CW, CH);
    const d = img.data;
    let sd = 20261016;
    const rnd2 = () => (sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296;
    const perm = new Uint8Array(512);
    for (let i = 0; i < 256; i++) perm[i] = i;
    for (let i = 255; i > 0; i--) { const j = (rnd2() * (i + 1)) | 0; const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
    for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
    const sm = (t) => t * t * (3 - 2 * t);
    const ss = (lo, hi, x) => { const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); };
    const at = (x, y) => perm[(perm[x & 255] + (y & 255)) & 255] / 255;
    const n2 = (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const u = sm(xf), v = sm(yf);
      return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v)
           + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v;
    };
    const fbm = (x, y) => { let r = 0, amp = 0.5, f = 1; for (let o = 0; o < 5; o++) { r += amp * n2(x * f, y * f); f *= 2.03; amp *= 0.5; } return r; };
    for (let y = 0; y < CH; y++) {
      const v = y / CH;                                   // 0 天顶 → 1 地平线
      const band = ss(0.03, 0.38, v) * (1 - ss(0.88, 1.0, v));   // 云带：中高空为主
      for (let x = 0; x < CW; x++) {
        const u = x / CW;
        // Math.pow(v,1.25)：靠近地平线的云被压扁，像真实的大气透视
        const n = fbm(u * 7.5, Math.pow(v, 1.25) * 4.2 + 1.7);
        let dens = (n - 0.47) / 0.27;
        dens = Math.max(0, Math.min(1, dens)) * band;
        dens = dens * dens * (3 - 2 * dens);
        const i = (y * CW + x) * 4;
        const lit = 0.82 + 0.18 * Math.min(1, dens * 1.5);   // 厚的地方是被阳光照透的云顶
        d[i] = 250 * lit; d[i + 1] = 252 * lit; d[i + 2] = 255 * Math.min(1, lit * 0.99);
        d[i + 3] = 255 * dens * 0.98;
      }
    }
    cg.putImageData(img, 0, 0);
    // 贴到穹顶：只覆盖地平线以上；横向再舒展一些（云本来就该是横向的）
    g.drawImage(ccv, 0, H * 0.03, W, H * 0.47);
  }

  let seed = 8823771;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  // ④ 太阳：仰角约 37.6°、方位与主平行光一致（光影才自洽）
  const sunX = W * 0.165, sunY = H * 0.291;
  // 光晕范围要收住，否则会把半边天空洗白
  const halo = g.createRadialGradient(sunX, sunY, 2, sunX, sunY, H * 0.26);
  halo.addColorStop(0.000, 'rgba(255,255,252,0.96)');
  halo.addColorStop(0.050, 'rgba(255,253,240,0.74)');
  halo.addColorStop(0.130, 'rgba(255,247,214,0.34)');
  halo.addColorStop(0.340, 'rgba(255,240,196,0.12)');
  halo.addColorStop(0.700, 'rgba(255,244,214,0.032)');
  halo.addColorStop(1.000, 'rgba(255,255,255,0)');
  g.fillStyle = halo; g.fillRect(0, 0, W, H);
  // 阳光射线（柔和放射，很淡）
  g.save();
  g.translate(sunX, sunY);
  for (let i = 0; i < 22; i++) {
    const ang = (i / 22) * Math.PI * 2 + rnd() * 0.14;
    const len = H * (0.14 + rnd() * 0.30);
    const w = 0.006 + rnd() * 0.014;
    g.save(); g.rotate(ang);
    const rg = g.createLinearGradient(24, 0, len, 0);
    rg.addColorStop(0, 'rgba(255,253,238,0.16)');
    rg.addColorStop(0.35, 'rgba(255,250,226,0.055)');
    rg.addColorStop(1, 'rgba(255,250,226,0)');
    g.fillStyle = rg;
    g.beginPath(); g.moveTo(24, 0);
    g.lineTo(len, -len * w); g.lineTo(len, len * w); g.closePath(); g.fill();
    g.restore();
  }
  g.restore();
  g.fillStyle = 'rgba(255,255,253,1)';
  g.beginPath(); g.arc(sunX, sunY, 19, 0, Math.PI * 2); g.fill();

  // ⑤ 地平线雾带（大气层过渡，让场地地平线不突兀）
  const haz = g.createLinearGradient(0, H * 0.42, 0, H * 0.52);
  haz.addColorStop(0, 'rgba(226,236,246,0)');
  haz.addColorStop(1, 'rgba(224,234,244,0.55)');
  g.fillStyle = haz; g.fillRect(0, H * 0.42, W, H * 0.10);

  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * 单排观众贴图（一排看台贴一排人，比"多排压成一条"立体得多）
 *  每张贴图 = 一排约 42 个坐着的观众：肩/身（球衣色）+ 头（肤色）+ 头发/帽子 +
 *  少数举围巾/举手的人 + 零星空座 + 座位排底色与地面阴影。
 */
function crowdTexture(seed, zoneIdx = 0) {
  const W = 2048, H = 352;         // 分辨率 ×2（原来 1024×176 太小，远看会糊成一团）
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  let s = seed || 1;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;

  // ① 座位排底：白天水泥/塑料座椅色，上亮下暗（有纵深）
  const base = g.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, '#7b7e83');
  base.addColorStop(0.42, '#616468');
  base.addColorStop(1, '#3c3e42');
  g.fillStyle = base; g.fillRect(0, 0, W, H);

  // ② 座位：一排小方块（能看到椅背缝）
  const seatW = 21, seatH = 13;
  for (let x = 2; x < W; x += seatW) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(42,44,48,0.55)' : 'rgba(54,57,62,0.5)';
    g.fillRect(x, H * 0.62, seatW - 3, seatH);
  }

  // ③ 观众
  /* 真实看台观感（用户要求"按照真实的做，不要红蓝色这么丑的"）：
   * 实拍球场的看台其实是**一大片中性与深色**——黑/深灰/炭灰/藏青/灰白，
   * 人群里零散几句亮色（围巾、帽子）只是点缀，绝不会出现整片大红大蓝。
   * 所以这里把主场色换成**低饱和的灰阶系**，并把亮色比例压到 ~10%。 */
  const ZONES = [
    ['#d8dade', '#c9ccd2', '#bfc3ca'],        // 灰白区（浅色外套/白 T）
    ['#3a4049', '#2e343c', '#464d57'],        // 深灰区
    ['#2b3440', '#232b35', '#35404e'],        // 藏青灰区（低饱和）
    ['#4a4f57', '#3d4249', '#585e67'],        // 中灰区
  ];
  const zone = ZONES[Math.abs(zoneIdx) % ZONES.length];
  /* 穿插色：以深色/中性为主；亮色只留极少数低饱和的暖色点缀（围巾感），
   * 不再出现 #c8324a 这种饱和红、#2f6fd0 这种饱和蓝。 */
  const shirts = ['#1f242b', '#2b323b', '#39414c', '#4b535e', '#6a7280',
                  '#8d949e', '#b9bec6', '#d9dce1', '#7b5a48', '#5c5a4a'];
  const skins = ['#f0c9a4', '#e0b083', '#c68b5c', '#a06a42', '#7a4c2c', '#f7d9b8'];
  const n = 46;                     // 每排人数 34 → 46（真看台是摩肩接踵的）
  const step = W / n;
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.07) continue;                                   // 零星空座
    const cx = i * step + step * 0.5 + (rnd() - 0.5) * step * 0.22;
    const sc = 0.86 + rnd() * 0.3;                                // 远近/高矮
    const stand = rnd() < 0.14;                                   // 14% 站起来欢呼
    const cy = (stand ? H * 0.34 : H * 0.46) + (rnd() - 0.5) * 4;
    const bodyW = step * 0.78 * sc, bodyH = H * (stand ? 0.42 : 0.34) * sc;
    const r0 = rnd();
    // 主场色（所属看台区的灰阶）占 78%，其余是中性深色 —— 亮色几乎不出现
    const shirt = r0 < 0.78 ? zone[(rnd() * zone.length) | 0]
                : r0 < 0.94 ? shirts[(rnd() * shirts.length) | 0]
                            : '#dfe3e8';                            // 零星白衣
    const skin = skins[(rnd() * skins.length) | 0];

    // 先用深色画一个略大的轮廓：小尺寸下人形才读得清（不加轮廓时远看会糊成色块）
    g.fillStyle = 'rgba(10,14,20,0.28)';
    g.beginPath();
    g.moveTo(cx - bodyW * 0.545, cy + bodyH * 0.53);
    g.quadraticCurveTo(cx - bodyW * 0.60, cy - bodyH * 0.44, cx, cy - bodyH * 0.535);
    g.quadraticCurveTo(cx + bodyW * 0.60, cy - bodyH * 0.44, cx + bodyW * 0.545, cy + bodyH * 0.53);
    g.closePath(); g.fill();
    // 个体明暗差（有人亮有人暗 —— 真实看台不是一块均匀的色板）
    const bright = 0.86 + rnd() * 0.28;
    g.globalAlpha = bright;
    // 身体（圆肩）
    g.fillStyle = shirt;
    g.beginPath();
    g.moveTo(cx - bodyW * 0.5, cy + bodyH * 0.5);
    g.quadraticCurveTo(cx - bodyW * 0.56, cy - bodyH * 0.42, cx, cy - bodyH * 0.5);
    g.quadraticCurveTo(cx + bodyW * 0.56, cy - bodyH * 0.42, cx + bodyW * 0.5, cy + bodyH * 0.5);
    g.closePath(); g.fill();
    // 衣服明暗（左暗右亮，来自太阳）
    g.fillStyle = 'rgba(255,255,255,0.14)';
    g.beginPath(); g.ellipse(cx + bodyW * 0.2, cy, bodyW * 0.22, bodyH * 0.42, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.16)';
    g.beginPath(); g.ellipse(cx - bodyW * 0.28, cy, bodyW * 0.16, bodyH * 0.4, 0, 0, Math.PI * 2); g.fill();

    // 举手（欢呼）
    if (stand || rnd() < 0.12) {
      g.strokeStyle = skin; g.lineWidth = Math.max(2, step * 0.1);
      g.lineCap = 'round';
      for (const dir of [-1, 1]) {
        g.beginPath();
        g.moveTo(cx + dir * bodyW * 0.42, cy - bodyH * 0.3);
        g.lineTo(cx + dir * bodyW * (0.6 + rnd() * 0.15), cy - bodyH * (0.85 + rnd() * 0.35));
        g.stroke();
      }
    }
    // 头
    const hr = step * 0.22 * sc;
    const hy = cy - bodyH * 0.62;
    g.fillStyle = skin;
    g.beginPath(); g.arc(cx, hy, hr, 0, Math.PI * 2); g.fill();
    // 头发 / 帽子
    const hat = rnd();
    if (hat < 0.22) {                                             // 棒球帽
      g.fillStyle = shirts[(rnd() * shirts.length) | 0];
      g.beginPath(); g.arc(cx, hy - hr * 0.15, hr * 1.06, Math.PI, Math.PI * 2); g.fill();
      g.fillRect(cx - hr * 1.05, hy - hr * 0.3, hr * 2.1, hr * 0.4);
    } else {                                                      // 头发
      g.fillStyle = rnd() < 0.75 ? '#2b2320' : (rnd() < 0.6 ? '#6b4a2f' : '#c9a15c');
      g.beginPath(); g.arc(cx, hy - hr * 0.22, hr * 0.98, Math.PI * 0.98, Math.PI * 2.02); g.fill();
    }
    // 头顶高光（日光）
    g.fillStyle = 'rgba(255,250,235,0.16)';
    g.beginPath(); g.arc(cx - hr * 0.3, hy - hr * 0.5, hr * 0.26, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
    // 围巾/围脖
    if (rnd() < 0.3) {
      g.fillStyle = shirts[(rnd() * shirts.length) | 0];
      g.fillRect(cx - hr * 0.9, hy + hr * 0.6, hr * 1.8, hr * 0.7);
    }
  }

  // ④ 走道（深色竖条：看台楼梯口）
  for (let i = 0; i < 4; i++) {
    const x = (W / 4) * i + W / 8;
    const gd = g.createLinearGradient(x - 13, 0, x + 13, 0);
    gd.addColorStop(0, 'rgba(16,20,28,0)');
    gd.addColorStop(0.5, 'rgba(16,20,28,0.62)');
    gd.addColorStop(1, 'rgba(16,20,28,0)');
    g.fillStyle = gd; g.fillRect(x - 13, 0, 26, H);
  }

  // ⑤ 底部阴影（座位排的投影，把人"坐实"）+ 顶部亮边
  const sh = g.createLinearGradient(0, H * 0.78, 0, H);
  sh.addColorStop(0, 'rgba(10,14,20,0)');
  sh.addColorStop(1, 'rgba(10,14,20,0.55)');
  g.fillStyle = sh; g.fillRect(0, H * 0.78, W, H * 0.22);
  const top = g.createLinearGradient(0, 0, 0, H * 0.1);
  top.addColorStop(0, 'rgba(255,255,255,0.12)');
  top.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = top; g.fillRect(0, 0, W, H * 0.1);

  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * 场边 LED 广告牌：**一整条只显示一个品牌**（现在真实的 LED 围挡就是这样，
 * 不是一排小方块混着不同牌子），每隔几秒用"过场滑动"换成下一个品牌。
 * 所有广告牌共享同一张画布 → 全场同步（真实 LED 围挡也是同步的）。
 */
function makeAdBoards() {
  const W = 2048, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const FONT = '"Arial Black", "Microsoft YaHei", sans-serif';
  /* ★ 用户要求"其他颜色主题的 FK2026" → 主题就是**同一句 FK2026、换不同配色**，
   *   像真实赛事的主题围挡一样成组换色；再留两条别的字样做变化。
   *   solid:true → 纯色底；fg 是字色；acc 是装饰色（底部色带 / 斜条） */
  const BRANDS = [
    { bg: '#0b0d11', fg: '#ffffff', acc: '#00d97e', txt: 'FK2026' },
    { bg: '#f2f4f7', fg: '#0e1217', acc: '#e0293a', txt: 'FK2026' },
    { bg: '#0a2a5e', fg: '#ffffff', acc: '#4aa3ff', txt: 'FK2026' },
    { bg: '#c8102e', fg: '#ffffff', acc: '#ffd166', txt: 'FK2026' },
    { bg: '#00b46a', fg: '#04160d', acc: '#ffffff', txt: 'FK2026' },
    { bg: '#1a1030', fg: '#c9a6ff', acc: '#a78bfa', txt: 'FK2026' },
    { bg: '#ffd700', fg: '#141414', acc: '#c8102e', txt: 'FK2026' },
    { bg: '#0d1219', fg: '#2fd08a', acc: '#2fd08a', txt: '暴力足球' },
    { bg: '#101216', fg: '#e8384f', acc: '#e8384f', txt: 'SPORT ENERGY' },
  ];

  /** 把一个品牌画到指定 2D 上下文（x0 = 左端偏移，供竖切成条用） */
  function paintBrand(ctx, b, x0 = 0) {
    const gg = ctx;
    gg.save();
    gg.beginPath(); gg.rect(x0, 0, W, H); gg.clip();
    gg.fillStyle = b.bg; gg.fillRect(x0, 0, W, H);
    /* 底部一道品牌色带（真 LED 围挡常见：纯色底 + 一条亮色边），
     * 让"换主题色"看得出来，又不喧宾夺主。 */
    gg.fillStyle = b.acc || b.fg;
    gg.globalAlpha = 0.9;
    gg.fillRect(x0, H - 16, W, 9);
    gg.globalAlpha = 1;
    // 品牌名（居中大字，字距按正牌 logo 排，自动缩字号）
    let fs = 88;
    gg.font = `bold ${fs}px ${FONT}`;
    const maxW = W * 0.74;
    const measure = (t, s) => { let w2 = 0; for (const c of [...t]) w2 += gg.measureText(c).width + s * 0.16; return w2 - s * 0.16; };
    while (measure(b.txt, fs) > maxW && fs > 22) { fs -= 2; gg.font = `bold ${fs}px ${FONT}`; }
    const gap = Math.max(8, fs * 0.16);
    const total = measure(b.txt, fs);
    let cx = x0 + W * 0.5 - total / 2;
    gg.fillStyle = b.fg; gg.textBaseline = 'middle'; gg.textAlign = 'left';
    for (const c of [...b.txt]) { gg.fillText(c, cx, H / 2 - 2); cx += gg.measureText(c).width + gap; }
    // 上下深色压边（围挡的金属框）
    gg.fillStyle = 'rgba(8,12,18,0.92)';
    gg.fillRect(x0, 0, W, 7); gg.fillRect(x0, H - 7, W, 7);
    gg.restore();
  }

  /* 每个品牌预先画到自己的离屏画布（只在启动时算一次）——
   * 转场时只做 drawImage 切片，一帧最多 26 次贴图，几乎不耗性能。 */
  const CARDS = BRANDS.map((b) => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const cg = c.getContext('2d');
    paintBrand(cg, b, 0);
    return c;
  });

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  /* 换广告的转场：★ 用户要求"从下往上的过场切换"。
   *
   *  整条按**竖向条带**从左到右逐条**从下往上卷**：
   *    · 新主题从该条的**下沿向上推入**，旧主题被顶上去（每条的推进量带错峰）
   *    · 条带推进的瞬间打一道白色高光（LED 屏体分区刷新的手感）
   *    · 条与条之间留一道暗缝，看得出"分块刷新"
   *    · 整条再叠一道自左向右掠过的扫光
   *  错峰 + 竖向滑动 = 比原来的"整条横向平移"明显得多，也更像真 LED 围挡换画面。 */
  /* ★ 用户反馈："拼接有点多"、"停留时间太快了" →
   *   PANELS 22 → 12（转场时的竖向暗缝少一半，不再像拼了很多小板子）
   *   HOLD  4.2 → 7.5s（一轮停留接近翻倍，主题能看清再换）
   *   SWITCH 0.95 → 1.15s（"从下往上"的过程也更从容，一眼看得出方向） */
  const PANELS = 12;
  const STAGGER = 0.62;                   // 最右一条比最左一条晚开始的比例
  const HOLD = 7.5, SWITCH = 1.15;        // 停 7.5s → 1.15s 从下往上过场
  const st = { t: 0, idx: 0 };
  let drawnIdx = -1, drawnK = -1;

  /** 把一张卡片按"竖向偏移 dy"贴进条带 [x0,x1)：dy=0 完全显示，dy=H 完全移出下方 */
  function blitBand(src, x0, x1, dy) {
    const sw = x1 - x0;
    g.drawImage(src, x0, 0, sw, H, x0, dy, sw, H);
  }

  function render(k) {
    const from = CARDS[st.idx % CARDS.length];
    const to = CARDS[(st.idx + 1) % CARDS.length];
    const pw = W / PANELS;
    for (let i = 0; i < PANELS; i++) {
      const x0 = Math.round(i * pw);
      const x1 = Math.round((i + 1) * pw);
      /* 这一条的推进进度 p：0 = 还是旧主题，1 = 已经是新主题。
       * 从左到右错峰 —— 左边先翻，右边稍后才翻，形成"刷过去"的观感。 */
      const p = Math.max(0, Math.min(1, (k - (i / PANELS) * STAGGER) / (1 - STAGGER)));
      const ease = p * p * (3 - 2 * p);            // smoothstep
      const dy = (1 - ease) * H;                   // 新主题从下方 (dy=H) 升到 (dy=0)
      g.save();
      g.beginPath(); g.rect(x0, 0, x1 - x0, H); g.clip();
      if (dy > 0.5) {
        blitBand(from, x0, x1, 0);                 // 旧主题（会被顶上去）
        blitBand(to, x0, x1, dy);                  // 新主题从下往上推入
      } else {
        blitBand(to, x0, x1, 0);
      }
      // 推进瞬间的高光（p 在 0.5 附近最亮，像屏体分区的刷新辉光）
      const glow = Math.sin(Math.PI * p);
      if (glow > 0.02) {
        g.fillStyle = `rgba(255,255,255,${(0.30 * glow).toFixed(3)})`;
        g.fillRect(x0, 0, x1 - x0, H);
      }
      g.fillStyle = 'rgba(0,0,0,0.18)';            // 屏体之间的暗缝（用户嫌"拼接多"→ 调淡）
      g.fillRect(x0, 0, 2, H);
      g.restore();
    }
    // 整条斜向扫光（转场期间掠过一次，自左向右）
    if (k > 0.02 && k < 0.99) {
      const sweep = k * 1.7 - 0.35;
      const lg = g.createLinearGradient(W * (sweep - 0.18), H, W * (sweep + 0.18), 0);
      lg.addColorStop(0, 'rgba(255,255,255,0)');
      lg.addColorStop(0.5, `rgba(255,255,255,${(0.16 * Math.sin(Math.PI * k)).toFixed(3)})`);
      lg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = lg; g.fillRect(0, 0, W, H);
    }
    tex.needsUpdate = true;               // 共享同一个 Texture → 所有围挡一起刷新
    drawnIdx = st.idx; drawnK = k;
  }
  render(0);

  return {
    tex,
    update(dt) {
      st.t += dt;
      const cyc = HOLD + SWITCH;
      if (st.t >= cyc) {                  // 一轮结束 → 换下一个品牌
        st.t -= cyc; st.idx++;
        render(0);
        return;
      }
      if (st.t < HOLD) {
        if (drawnIdx !== st.idx || drawnK !== 0) render(0);
      } else {
        const k = (st.t - HOLD) / SWITCH;
        render(k * k * (3 - 2 * k));      // smoothstep，起停柔和
      }
    },
    get brands() { return BRANDS.length; },
  };
}

export function buildWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  /* ---------- 天空 / 雾 ---------- */
  // 白天蓝天穹顶（渐变 + 太阳 + 光晕 + 云层）：有光影的晴天
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(520, 48, 28),
    new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false })
  );
  sky.renderOrder = -1;
  group.add(sky);
  scene.background = null;
  // 远景大气雾（大气透视）：让远处的看台/灯塔/场地远端淡成一层浅蓝，
  // 越远越淡 —— 这是"现实感"的关键（没有雾的画面会显得很"平"、像隔着玻璃看）。
  //   · 颜色 = 实测地平线天空色 #b6d8ea，远景才会自然融进天空而不是发白
  //   · near 30 / far 400：看台（离相机约 55~110m）有 7~22% 的雾，
  //     场地远端约 8% —— 明显能看出"远处的空气"，但不至于把画面洗成白墙。
  scene.fog = new THREE.Fog('#c6d2da', 30, 400);   // 雾色降蓝：远处看台不再泛蓝

  /* ---------- 球场地板 ---------- */
  const pad = PAD;
  const PW = (HALF_L + pad) * 2, PH = (HALF_W + pad) * 2;
  // 草皮：底色贴图 1:1 铺满整块地板；绒毛细节贴图小尺度重复（xy 比保持等比，不拉伸）
  const gd = grassDetailTextures();
  // 每格约 6.5m：太密（每格 1~3m）远看会被 mipmap 抹成平色，看不见"绒"
  gd.normal.repeat.set(24, Math.max(1, Math.round(24 * PH / PW)));
  gd.rough.repeat.copy(gd.normal.repeat);
  gd.fiber.repeat.copy(gd.normal.repeat);
  const pitchMat = new THREE.MeshStandardMaterial({
    map: pitchTexture(),
    normalMap: gd.normal,
    normalScale: new THREE.Vector2(0.60, 0.60),      // 法线很轻（只要一点点立体感）
    roughnessMap: gd.rough,
    roughness: 1.0, metalness: 0,                    // 哑光到底，杜绝镜面反光
  });
  // 草丝微细节：在标准材质里乘一层高频灰度，近看就是一根根草（three 没有 detailMap，
  // 用 onBeforeCompile 往 map_fragment 后面插两行最简单）
  pitchMat.onBeforeCompile = (shader) => {
    shader.uniforms.uFiber = { value: gd.fiber };
    shader.uniforms.uFiberScale = { value: new THREE.Vector2(gd.normal.repeat.x, gd.normal.repeat.y) };
    shader.uniforms.uFiberAmt = { value: 0.5 };        // 原来是 1.0（±27% 明暗），太抢
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_pars_fragment>',
        '#include <map_pars_fragment>\nuniform sampler2D uFiber;\nuniform vec2 uFiberScale;\nuniform float uFiberAmt;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          // 三层尺度的"绒"：低频 = 整片草层的薄厚 / 中频 = 一根根草 / 高频 = 绒毛的细碎
          // 全部只做明暗扰动（乘性、均值≈1），不引入任何高光或反射
          float lo  = texture2D(uFiber, vMapUv * uFiberScale * 0.34).r;
          float mid = texture2D(uFiber, vMapUv * uFiberScale).r;
          float hi  = texture2D(uFiber, vMapUv * uFiberScale * 3.3 + vec2(0.41, 0.17)).r;
          float fib = mid * 0.50 + hi * 0.32 + lo * 0.18;
          diffuseColor.rgb *= (0.86 + fib * uFiberAmt * 0.58);   // 均值仍≈1，但幅度约为原来一半
        }`);
  };
  const pitch = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), pitchMat);
  pitch.rotation.x = -Math.PI / 2;
  pitch.receiveShadow = true;
  group.add(pitch);

  // 场外一圈跑道（白天：浅灰，与草皮对比更自然）
  const outer = new THREE.Mesh(
    new THREE.PlaneGeometry((HALF_L + pad) * 2 + 40, (HALF_W + pad) * 2 + 40),
    new THREE.MeshStandardMaterial({ color: '#828f9c', roughness: 1 })
  );
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.02;
  outer.receiveShadow = true;
  group.add(outer);

  /* ---------- 球门 ---------- */
  const net = netTexture();
  function makeGoal(sign) {
    const g = new THREE.Group();
    const hw = C.GOAL.W / 2, H = C.GOAL.H, D = C.GOAL.D;
    const postR = 0.09;
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4, metalness: 0.1 });

    const post = (z) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, H, 12), mat);
      m.position.set(0, H / 2, z); m.castShadow = true;
      return m;
    };
    g.add(post(hw), post(-hw));
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, C.GOAL.W, 12), mat);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(0, H, 0);
    bar.castShadow = true;
    g.add(bar);
    // 后支撑（斜撑）：从门柱顶端斜拉到后网底部的落地锚点
    //   ⚠️ 斜撑在 x-y 平面里倾斜 → 必须绕 z 轴旋转（rotation.x 会让它歪到 z 方向去）
    const stayLen = Math.hypot(H, D);
    const stay = (z) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(postR * 0.72, postR * 0.72, stayLen, 10), mat);
      m.position.set(sign * D / 2, H / 2, z);              // 两端中点
      m.rotation.z = sign * Math.atan2(D, H);              // 绕 z 轴倾斜（连 (0,H) ↔ (sign*D,0)）
      m.castShadow = true;
      return m;
    };
    g.add(stay(hw), stay(-hw));
    // 落地锚点（斜撑在地面的固定脚）
    for (const z of [hw, -hw]) {
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(postR * 1.5, postR * 1.9, 0.14, 10), mat);
      foot.position.set(sign * D, 0.07, z);
      g.add(foot);
    }
    // 底部后横杆：连接两根斜撑的落地端（后网底沿）
    const backBar = new THREE.Mesh(new THREE.CylinderGeometry(postR * 0.72, postR * 0.72, C.GOAL.W, 10), mat);
    backBar.rotation.x = Math.PI / 2;
    backBar.position.set(sign * D, postR * 0.8, 0);
    g.add(backBar);
    // 门柱底座（让立柱不是"插"进草皮）
    for (const z of [hw, -hw]) {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(postR * 1.6, postR * 1.9, 0.12, 10), mat);
      base.position.set(0, 0.06, z);
      g.add(base);
    }

    // 网：后网 + 顶网 + 两侧
    // 网眼约 12cm（贴图一格 16 cell → 一次 repeat 覆盖 1.92m）
    const NET_CELL = 1.92;
    const mkPlane = (w, h, rx, ry) => {
      const m = new THREE.MeshStandardMaterial({
        map: net.clone(),
        // 用 alphaTest 走**不透明队列**：深度写得进去，网不会盖在球员/球门前面，
        // 也不会因为半透明排序在门柱前后乱跳（原来的 depthWrite:false 就是"球网有问题"的根源）
        alphaTest: 0.45,
        side: THREE.DoubleSide,
        roughness: 0.9, metalness: 0,
        emissive: new THREE.Color('#8ea0b4'),      // 阴影里也保持白网（不是一团黑格子）
        emissiveMap: net,
        emissiveIntensity: 0.5,
      });
      m.map.repeat.set(Math.max(1, w / NET_CELL), Math.max(1, h / NET_CELL));
      m.map.needsUpdate = true;
      m.emissiveMap = m.map;
      const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
      p.rotation.x = rx; p.rotation.y = ry;
      return p;
    };
    const backNet = mkPlane(C.GOAL.W, H, 0, Math.PI / 2);
    backNet.position.set(sign * D, H / 2, 0);
    g.add(backNet);

    // 顶网：长边（球门宽 7.32m）必须沿 Z，进深 2m 沿 X。
    // PlaneGeometry(w,h) 的 w 是沿 X 的 → 之前写成 (W, D) 让顶网整体转了 90°，
    // 变成"从横梁往场内伸出去 7.32m"（用户报的顶网角度不对）。这里传 (D, W)。
    const topNet = mkPlane(D, C.GOAL.W, Math.PI / 2, 0);
    topNet.position.set(sign * D / 2, H - 0.02, 0);
    g.add(topNet);

    // 侧网贴在门柱内侧一点，别正好与门柱圆柱重合（原来会从柱子里穿出来）
    for (const z of [hw - postR * 0.8, -(hw - postR * 0.8)]) {
      const side = mkPlane(D, H, 0, 0);
      side.position.set(sign * D / 2, H / 2, z);
      g.add(side);
    }

    g.position.x = sign * HALF_L;
    return g;
  }
  group.add(makeGoal(1), makeGoal(-1));

  /* ---------- 角旗 ---------- */
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6),
      new THREE.MeshStandardMaterial({ color: '#dddddd' })
    );
    pole.position.set(sx * HALF_L, 0.75, sz * HALF_W);
    group.add(pole);
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(0.42, 0.28),
      new THREE.MeshStandardMaterial({ color: '#ffcc22', side: THREE.DoubleSide, roughness: 0.7 })
    );
    flag.position.set(sx * (HALF_L + 0.21), 1.32, sz * HALF_W);
    flag.rotation.y = Math.PI / 2;
    group.add(flag);
  }

  /* ---------- 看台（四面 + 四角：分层看台 + 顶棚 + 广告牌） ---------- */
  const AD_BASE = makeAdBoards();           // 场边 LED 广告牌（共享画布，全场同步）
  const seatMat = new THREE.MeshStandardMaterial({ color: '#585c62', roughness: 0.85 });
  const riserMat = new THREE.MeshStandardMaterial({ color: '#3b3e44', roughness: 0.9 });
  const wallMat = new THREE.MeshStandardMaterial({ color: '#484b51', roughness: 0.88 });
  const roofMat = new THREE.MeshStandardMaterial({ color: '#7b7f86', roughness: 0.62, metalness: 0.24 });
  const pillarMat = new THREE.MeshStandardMaterial({ color: '#a1a4aa', roughness: 0.48, metalness: 0.3 });
  const railMat = new THREE.MeshStandardMaterial({ color: '#c6c9ce', roughness: 0.35, metalness: 0.45 });
  // 共享 4 张观众贴图（原来每排看台各生成一张 → 120 张 canvas，太重且重复）
  // 4 张 = 4 个不同的看台区（灰白 / 深灰 / 藏青灰 / 中灰）—— 真实球场的看台是中性色为主
  const CROWD_TEX = [crowdTexture(11, 0), crowdTexture(97, 1), crowdTexture(203, 2), crowdTexture(311, 3),
                     crowdTexture(53, 0), crowdTexture(139, 1), crowdTexture(241, 3), crowdTexture(367, 2)];
  const crowdMatCache = new Map();
  function crowdMat(texIdx, repX) {
    const k = texIdx + ':' + repX.toFixed(2);
    if (crowdMatCache.has(k)) return crowdMatCache.get(k);
    const tex = CROWD_TEX[texIdx % CROWD_TEX.length].clone();
    tex.needsUpdate = true;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(Math.max(1, repX), 1);
    /* ★★ 用 **MeshBasicMaterial（不受光照）** 而不是 MeshStandardMaterial。
     *
     * 为什么：整个场景的天空半球光/环境光/补光都是**偏蓝**的（#c2dcff / #d2e2f7 / #a6c6f2），
     * 那套冷调白平衡是给草皮和球场做"转播质感"的。但看台是一大片**灰阶人群**，
     * 被这些蓝光一照就整片变成蓝灰色 —— 实测平均色 RGB(97,118,132)，蓝比红高 35。
     * 玩家看到的"观众席红蓝色很丑"其实有一半是**光照把灰色染蓝了**。
     *
     * 远处的看台本来就以环境光为主、没有明确受光面，所以直接贴图输出反而更真实：
     * 灰白就是灰白，深灰就是深灰，不会被天空染成蓝色。 */
    const m = new THREE.MeshBasicMaterial({ map: tex });
    m.color = new THREE.Color('#b9bcc0');        // 整体压一点亮度，免得太亮抢画面
    crowdMatCache.set(k, m);
    return m;
  }
  // 一张贴图横向代表约 21m（34 人 × 0.62m）
  const CROWD_SPAN = 21;

  /** 一面看台：宽 w、进深 d、层高随排数递增；局部 +Z 朝场外，-Z 面朝球场 */
  function stand(cx, cz, w, d, rotY, seed, opts = {}) {
    const g = new THREE.Group();
    const rows = opts.rows || 14;
    const rowD = d / rows;
    const rise = 0.68;
    const base = 1.0;                       // 前排离地高度
    const texIdx = Math.abs(seed) % CROWD_TEX.length;
    const repX = w / CROWD_SPAN;
    for (let i = 0; i < rows; i++) {
      const y = base + i * rise;
      // 每排：踏板 + 朝球场的立面贴观众
      // 面序：+x, -x, +y, -y, +z, -z
      // 局部 -Z 朝球场（+Z 朝场外）→ 观众立面必须贴在 -Z 面（最后一个），否则人群朝外看不见
      const deck = new THREE.Mesh(new THREE.BoxGeometry(w, rise + 0.5, rowD), [
        riserMat, riserMat, seatMat, riserMat,
        riserMat, crowdMat(texIdx + i, repX),
      ]);
      deck.position.set(0, y, rowD * (i + 0.5));       // 从前排往后排往后延伸
      deck.receiveShadow = true;
      g.add(deck);
    }
    const topY = base + rows * rise;
    // 看台背墙（挡住"看台后面是空的"）
    const wallH = topY + (opts.roof === false ? 1.4 : 4.8);
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(w + 2, wallH, 0.6), wallMat);
    backWall.position.set(0, wallH / 2, d + 0.3);
    backWall.castShadow = true;
    g.add(backWall);
    // 前排栏杆（贴场边）
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, w, 8), railMat);
    rail.rotation.z = Math.PI / 2;
    rail.position.set(0, base + 0.95, -0.12);
    g.add(rail);
    const nRailPost = Math.max(4, Math.round(w / 6));
    for (let i = 0; i <= nRailPost; i++) {
      const rp = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.05, 6), railMat);
      rp.position.set(-w / 2 + (w / nRailPost) * i, base + 0.5, -0.12);
      g.add(rp);
    }
    // 顶棚：只盖住后排，前排露天
    if (opts.roof !== false) {
      const rd = d * 0.52;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 5, 0.5, rd), roofMat);
      roof.position.set(0, topY + 5.2, d - rd / 2);
      roof.castShadow = true;
      g.add(roof);
      // 立柱
      const nP = Math.max(3, Math.round(w / 22));
      for (let i = 0; i <= nP; i++) {
        const px = -w / 2 + (w / nP) * i;
        const pil = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 5.4, 10), pillarMat);
        pil.position.set(px, topY + 2.6, d - 0.6);
        pil.castShadow = true;
        g.add(pil);
      }
      // 顶棚边缘（收边，避免像一块悬空的板）
      const fascia = new THREE.Mesh(new THREE.BoxGeometry(w + 5, 0.9, 0.3), roofMat);
      fascia.position.set(0, topY + 4.8, d - rd);
      g.add(fascia);
    }
    /* 场边 LED 广告牌：**整条只显示一个品牌**（真 LED 围挡就是这样），
     * 所有围挡共享同一张画布 → 全场同步。
     *
     * ★★ 踩过的坑（用户反馈"广告牌不会动"）：这里原来写的是
     *   `const adMap = AD_BASE.tex.clone()` —— Texture.clone() 会**复制一份**
     *   Texture 对象（含自己独立的 version 计数器），但共享同一个 `source`(图像)。
     *   而 three 判断"要不要重新上传 GPU"看的是**这个 Texture 自己的 version**：
     *   转场时只改了原 tex 的 needsUpdate（version+1），克隆体的 version 一直是 0
     *   → 永远不上传 → 屏幕上**永远停在第一帧的品牌**（画布在换，画面纹丝不动）。
     *
     *   修法：不要克隆。用同一张 texture 实例，靠 **材质各自的 uv 变换**（offset/repeat）
     *   来给不同长度的围挡调密度 —— 这样任何一块纹理更新，所有围挡一起刷新。
     *   ⚠️ 因此**必须在每个材质上显式设 map.repeat**？不行，同一个 texture 只能有一组
     *   repeat。所以这里改用**几何 UV 缩放**（给每个 board 的 BoxGeometry 直接缩放 UV 属性），
     *   UV 是逐 Mesh 的、纹理是共享的 —— 两头都对。 */
    /* ★ 用户反馈"拼接有点多" → 同一条围挡上品牌名重复的**次数**少一半：
     *   TILE_M 13 → 26（品牌名大约每 26m 出现一次）。
     *   之前 13m 一次，105m 的长边要重复 8 遍，看起来像拼了一排小牌子；
     *   26m 一次刚好每半边围挡 2 个名字，更像"一整条主题广告"。 */
    const TILE_M = 26;                      // 品牌名大约每 26m 出现一次
    const bg = new THREE.BoxGeometry(w, 1.0, 0.35);
    {
      // 把 UV 的 u 轴按 w/TILE_M 铺开：repeat 的效果一样，但不碰 texture 对象
      const uv = bg.attributes.uv;
      const rx = Math.max(0.35, w / TILE_M);
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * rx);
      uv.needsUpdate = true;
    }
    const board = new THREE.Mesh(bg,
      new THREE.MeshStandardMaterial({
        map: AD_BASE.tex, roughness: 0.55, metalness: 0.0,
        emissiveMap: AD_BASE.tex, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.34,
      }));
    board.position.set(0, 0.5, -0.35);
    g.add(board);

    g.position.set(cx, 0, cz);
    g.rotation.y = rotY;
    return g;
  }

  const OY = HALF_W + 11, OX = HALF_L + 11;
  // 注意 rotY 必须让"局部 +Z（台阶往后的方向）"指向场外：东=+π/2，西=-π/2
  group.add(stand(0, OY, HALF_L * 2 + 26, 20, 0, 3));                    // 南（主看台）
  group.add(stand(0, -OY, HALF_L * 2 + 26, 18, Math.PI, 91));             // 北
  group.add(stand(OX, 0, HALF_W * 2 + 26, 18, Math.PI / 2, 55));         // 东
  group.add(stand(-OX, 0, HALF_W * 2 + 26, 18, -Math.PI / 2, 77));       // 西
  // 四角看台（斜 45° 朝向球场中心，小一号、无顶棚）
  for (const [sx, sz, sd] of [[1, 1, 31], [1, -1, 57], [-1, 1, 113], [-1, -1, 149]]) {
    group.add(stand(sx * (OX - 2), sz * (OY - 2), 34, 12, Math.atan2(sx, sz), sd, { rows: 8, roof: false }));
  }

  /* ---------- 灯塔（白天：保留结构，灯头不再发强光） ---------- */
  // 白天灯头是没通电的壳体：深灰 + 一点点金属（白色会在天空前爆成一团白光）
  const lampMat = new THREE.MeshStandardMaterial({ color: '#4d5a6b', roughness: 0.55, metalness: 0.45 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (HALF_L + 17), z = sz * (HALF_W + 15);   // 往外挪：原来正好挡住角看台上的大屏
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.55, 26, 8),
      new THREE.MeshStandardMaterial({ color: '#6b7787', roughness: 0.75 })
    );
    pole.position.set(x, 13, z);
    pole.castShadow = true;
    group.add(pole);
    const head = new THREE.Mesh(new THREE.BoxGeometry(6, 2.4, 0.8), lampMat);
    head.position.set(x, 26, z);
    head.lookAt(0, 0, 0);
    group.add(head);
  }

  /* ---------- 灯光：午后晴天（西甲下午场那种硬朗光影） ---------- */
  // 天空半球光：上方蓝天、下方草地反光。压低一点让主光的阴影更立得住
  scene.add(new THREE.HemisphereLight('#dae4ee', '#67884c', 0.82));   // 天空色降饱和：原来 #c2dcff 会把灰阶看台染蓝
  // 主阳光：暖白、西南 37.6° 斜射 → 长而清晰的影子
  const sun = new THREE.DirectionalLight('#ffeec6', 2.95);
  sun.position.set(-78, 66, 44);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);          // 阴影贴图 2K → 4K
  const d = 80;                                 // 收紧跟到场地范围 → 每纹素约 3.9cm
  sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
  sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 320;
  sun.shadow.bias = -0.00028;
  sun.shadow.normalBias = 0.028;
  scene.add(sun);
  scene.add(sun.target);

  // 环境光：只抬一点点暗部（太多会把看台洗成一片灰白，失去立体感）
  scene.add(new THREE.AmbientLight('#e6e9ec', 0.12));

  // 天空方向补光：带一点天蓝，模拟大气散射（背光面不至于死黑）
  const fill = new THREE.DirectionalLight('#ccd6e0', 0.36);   // 补光降蓝
  fill.position.set(60, 45, -50);
  scene.add(fill);

  // 草地反弹光：从下往上打一点黄绿，人物/球的下缘有环境色（真实感关键）
  const bounce = new THREE.DirectionalLight('#8fbf62', 0.22);
  bounce.position.set(20, -40, 30);
  scene.add(bounce);

  /* ---------- 球员席 / 替补席（北侧边线外 —— 模仿 FC 的球员坐席区） ----------
   * ★ 用户反馈"替补席不要用红蓝色真的好丑" → 全部改**中性灰**。
   *   原来桶椅/背板按队分成大红/大蓝（#c8102e / #1a4fc4）、顶棚压边还是红色，
   *   在黑白灰的球场里非常跳。现在统一成深灰金属质感的教练席，
   *   和看台/球场的灰阶体系一致。 */
  const benchGroup = new THREE.Group();
  {
    const OUT = C.BENCH.OUT, W = C.BENCH.W, GAP = C.BENCH.GAP;
    const bz = -(HALF_W + OUT);
    const C2 = (h) => new THREE.MeshStandardMaterial({ color: h, roughness: 0.62 });
    const metal = new THREE.MeshStandardMaterial({ color: '#9ba0a6', roughness: 0.32, metalness: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: '#31353b', roughness: 0.88 });
    /* 桶椅/背板：中性深灰（不再按队分红蓝） */
    const SEAT = '#42474e';
    const SEAT_BACK = '#4c525a';

    // ① 地台（深色，略高于跑道）
    const plat = new THREE.Mesh(new THREE.BoxGeometry(W + 1.2, 0.3, 3.2), dark);
    plat.position.set(0, 0.15, bz);
    plat.receiveShadow = true;
    benchGroup.add(plat);

    // ② 两排「桶椅」：座垫 + 略后仰的靠背 + 金属侧腿（每队 6 个）
    for (const sign of [-1, 1]) {
      const cx0 = sign * (W * 0.25);
      const seatMat = C2(SEAT);
      for (let i = 0; i < 6; i++) {
        const x = cx0 + (i - 2.5) * (GAP * 0.8);
        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.13, 0.6), seatMat);
        seat.position.set(x, 0.52, bz - 0.30);
        seat.castShadow = true;
        benchGroup.add(seat);
        const back = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.74, 0.13), seatMat);
        back.position.set(x, 0.9, bz - 0.62);
        back.rotation.x = -0.15;
        back.castShadow = true;
        benchGroup.add(back);
        for (const s2 of [-1, 1]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.52, 0.5), metal);
          leg.position.set(x + s2 * 0.35, 0.26, bz - 0.30);
          benchGroup.add(leg);
        }
      }
      const panel = new THREE.Mesh(new THREE.BoxGeometry(W * 0.46, 1.0, 0.1), C2(SEAT_BACK));
      panel.position.set(cx0, 0.9, bz - 0.92);
      benchGroup.add(panel);
    }

    // ③ 中间隔断（两队之间）
    const div = new THREE.Mesh(new THREE.BoxGeometry(0.26, 1.25, 0.9), C2('#3d424a'));
    div.position.set(0, 0.78, bz - 0.45);
    benchGroup.add(div);
    const divPost = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.0, 8), metal);
    divPost.position.set(0, 1.5, bz - 0.1);
    benchGroup.add(divPost);

    // ④ 顶棚：前高后低的斜顶 + 前缘队色压边 + 4 根立柱 + 后方挡墙
    const roof = new THREE.Mesh(new THREE.BoxGeometry(W + 1.6, 0.16, 3.6), C2('#3b3f45'));
    roof.position.set(0, 3.05, bz - 0.15);
    roof.rotation.x = 0.055;
    roof.castShadow = true;
    benchGroup.add(roof);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(W + 1.6, 0.24, 0.12), C2('#565c64'));
    lip.position.set(0, 2.96, bz + 1.6);
    benchGroup.add(lip);
    for (const sx of [-1, 1]) for (const sz of [1.5, -1.7]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 3.05, 8), metal);
      pole.position.set(sx * (W / 2 + 0.7), 1.53, bz + sz);
      pole.castShadow = true;
      benchGroup.add(pole);
    }
    const backwall = new THREE.Mesh(new THREE.BoxGeometry(W + 1.6, 2.7, 0.14), C2('#2a2d32'));
    backwall.position.set(0, 1.45, bz - 1.9);
    benchGroup.add(backwall);
  }
  group.add(benchGroup);

  /* ---------- 救护车停车位（黄白划线，场边） ---------- */
  {
    const px = HALF_L * C.AMB_PARK.X, pz = -(HALF_W + C.AMB_PARK.OUT);
    const lot = new THREE.Mesh(new THREE.BoxGeometry(9, 0.06, 6),
      new THREE.MeshStandardMaterial({ color: '#3c4657', roughness: 0.95 }));
    lot.position.set(px, 0.03, pz);
    lot.receiveShadow = true;
    group.add(lot);
    for (const s of [-1, 1]) {                      // 车位两条黄线
      const line = new THREE.Mesh(new THREE.BoxGeometry(9, 0.02, 0.16),
        new THREE.MeshStandardMaterial({ color: '#ffd24a', roughness: 0.7 }));
      line.position.set(px, 0.07, pz + s * 2.6);
      group.add(line);
    }
    // 白线边框
    for (const s of [-1, 1]) {
      const l2 = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, 6),
        new THREE.MeshStandardMaterial({ color: '#f2f6fb', roughness: 0.7 }));
      l2.position.set(px + s * 4.5, 0.07, pz);
      group.add(l2);
    }
  }

  return { group, sun, adBoards: AD_BASE };
}

/* ---------- 足球 ---------- */
export function makeBall() {
  const g = new THREE.Group();
  const tex = (() => {
    const S = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const c = cv.getContext('2d');
    c.fillStyle = '#f5f5f5'; c.fillRect(0, 0, S, S);
    c.fillStyle = '#16181d';
    // 经典黑白块（简化）
    const pent = (cx, cy, r, rot) => {
      c.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = rot + i * Math.PI * 2 / 5;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.closePath(); c.fill();
    };
    pent(S * 0.5, S * 0.5, S * 0.13, 0);
    for (let i = 0; i < 5; i++) {
      const a = i * Math.PI * 2 / 5 - Math.PI / 2;
      pent(S * 0.5 + Math.cos(a) * S * 0.30, S * 0.5 + Math.sin(a) * S * 0.30, S * 0.115, a);
    }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(C.BALL_R, 24, 18),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.02 })
  );
  mesh.castShadow = true;
  g.add(mesh);
  return g;
}
