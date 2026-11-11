/*
 * postfx.js —— 电视转播级后处理（西甲观感）
 *
 * 管线：RenderPass → Bloom（阳光/灯牌眩光）→ OutputPass（ACES 色调映射 + sRGB）
 *        → GradePass（FC26 式数字转播调色：通透 / 柔和对比 / 抬黑位 / 干净画面）→ 屏幕
 *
 * 档位（按 V 切换，选择记在 localStorage）：
 *   high  MSAA×4 + 泛光 + 调色（默认）
 *   mid   调色（关泛光，省一半开销）
 *   off   直出（老式渲染，最低配）
 * 还会自动降档：连续掉帧 → high→mid→off。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ------------------------------------------------------------
 * 转播调色 shader
 * ------------------------------------------------------------ */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uSat: { value: 1.02 },        // 饱和度：几乎不加（自然）
    uContrast: { value: 1.12 },   // 对比（写实不是高对比，别拉太硬）
    uLift: { value: 0.008 },      // 黑位微抬：暗部通透不死黑（FC 的暗部能看清细节）
    uWarm: { value: 1.0 },        // 高光暖化强度
    uVig: { value: 0.0 },         // 暗角：关掉（四角不做压暗）
    uSun: { value: new THREE.Vector2(0.5, 1.4) },   // 太阳在屏幕上的位置（UV）
    uSunI: { value: 0.0 },        // 太阳可见度（不在画面里就 0）
    uShaft: { value: 0.7 },       // 光柱强度（太强会糊成条纹）
    uAber: { value: 0.70 },       // 边缘色差：现代数字机镜头几乎无色边（原来 1.2 太多）
    uGrain: { value: 0.26 },      // 颗粒：数字画面很干净，只留一点点质感
    uSharpen: { value: 0.45 },    // 锐化：FC 的画面很利，细节清晰是质感的第一来源
    uHiRoll: { value: 0.34 },     // 高光柔滚降：把接近 1 的高光柔和压回去，天空/白线不糊成一片白
    uBloomMix: { value: 1.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uSat, uContrast, uLift, uWarm, uVig, uAber, uGrain, uSunI, uShaft, uHiRoll, uSharpen;
    uniform vec2 uRes, uSun;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

    void main() {
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float r2 = dot(d, d);

      // ① 边缘色差（模拟转播镜头；中心几乎无感，四角才有彩边）
      float ab = uAber * (0.25 + r2 * 3.4) / max(uRes.x, 1.0);
      vec2 dir = normalize(d + vec2(1e-6));
      vec3 c;
      c.r = texture2D(tDiffuse, uv + dir * ab).r;
      c.g = texture2D(tDiffuse, uv).g;
      c.b = texture2D(tDiffuse, uv - dir * ab).b;

      // ①.5 锐化（unsharp mask）：把细节"提"出来 —— 画面够利才有质感
      vec2 px = 1.0 / max(uRes, vec2(1.0));
      vec3 bl = texture2D(tDiffuse, uv + vec2(px.x, 0.0)).rgb
              + texture2D(tDiffuse, uv - vec2(px.x, 0.0)).rgb
              + texture2D(tDiffuse, uv + vec2(0.0, px.y)).rgb
              + texture2D(tDiffuse, uv - vec2(0.0, px.y)).rgb;
      c += (c - bl * 0.25) * uSharpen;

      // ② 对比（以 0.5 为支点）+ 黑位
      c = (c - 0.5) * uContrast + 0.5 + uLift;

      // ③ 饱和度
      float l = luma(c);
      c = mix(vec3(l), c, uSat);

      /* ④ 分离调色：暗部微冷、亮部微暖。
       * ★ 原来暗部加蓝很重（vec3(-0.013,-0.002,0.026)）→ **整片看台被染成蓝灰**
       *   （用户反馈"观众席红蓝色这么丑"）。现在把暗部冷调削到 1/4，
       *   只留一点通透感，灰阶看台才呈现真实的水泥/灰白质感。 */
      c += vec3(-0.0035, -0.0006, 0.007) * (1.0 - smoothstep(0.0, 0.55, l));
      c += vec3(0.026, 0.010, -0.016) * smoothstep(0.5, 1.0, l) * uWarm;

      // ④.5 高光柔滚降：把逼近 1 的高光柔和压回来（天空/白线/灯牌不过曝成白块），
      //      这是 FC 画面"亮而不爆、通透"的关键
      float hl = smoothstep(0.82, 1.0, l);
      c -= hl * hl * uHiRoll * vec3(0.10, 0.095, 0.08);

      // ⑤ 高光微泛：**已去掉** —— 草皮要的是哑光绒面，亮部再泛光就成"油亮"了

      // ⑥ 暗角（现在关着；保留开关）
      float v = smoothstep(0.95, 0.28, length(d) * 1.16);
      c *= mix(1.0, v, uVig);

      // ⑥.5 阳光光柱：朝太阳方向做径向亮部累积 —— 太阳在画面里时才有
      if (uSunI > 0.002) {
        vec2 toSun = uSun - uv;
        vec2 stepv = toSun / 10.0;
        vec2 p = uv;
        float acc = 0.0;
        for (int i = 0; i < 10; i++) {
          p += stepv;
          acc += max(0.0, luma(texture2D(tDiffuse, p).rgb) - 0.62);
        }
        acc /= 10.0;
        float dist = length(toSun * vec2(uRes.x / max(uRes.y, 1.0), 1.0));
        float fall = smoothstep(1.5, 0.1, dist) + 0.22;      // 离太阳越近越亮
        c += acc * uSunI * uShaft * fall * vec3(1.10, 0.98, 0.78);
        // 太阳本身的柔光
        c += uSunI * uShaft * exp(-dist * dist * 7.0) * vec3(0.30, 0.27, 0.20);
      }

      // ⑦ 极轻颗粒（转播信号质感，静止画面上几乎看不出）
      float g = hash(uv * uRes + fract(uTime) * 137.0) - 0.5;
      c += g * (uGrain / 255.0);

      gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
    }`,
};

export const FX_LEVELS = ['high', 'mid', 'off'];
const STORE_KEY = 'vs_fx_level';

export function createPostFX(renderer, scene, camera, opts = {}) {
  const onAuto = opts.onAuto || (() => {});
  const pr = renderer.getPixelRatio();
  let W = renderer.domElement.clientWidth || innerWidth;
  let H = renderer.domElement.clientHeight || innerHeight;

  const composer = new EffectComposer(renderer);

  // MSAA：走后处理会丢失渲染器自带的抗锯齿 → 用多重采样离屏缓冲补回来
  const msaa = (() => {
    try {
      const rt = new THREE.WebGLRenderTarget(W * pr, H * pr, {
        type: THREE.HalfFloatType, samples: 4,
      });
      const rt2 = rt.clone();
      composer.renderTarget1.dispose();
      composer.renderTarget2.dispose();
      composer.renderTarget1 = rt;
      composer.renderTarget2 = rt2;
      composer.writeBuffer = rt;
      composer.readBuffer = rt2;
      return rt;
    } catch (e) { console.warn('MSAA 不可用，降级为无抗锯齿', e); return null; }
  })();

  composer.addPass(new RenderPass(scene, camera));

  // 阈值 2.6（线性空间）：白色球线/球衣被 2.9 的阳光照到约 2.3 -> 不泛光；
  // 只有大屏这种自身亮度 4.2 的光源才泛光。阈值给低了整片草皮会糊成白雾。
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.34, 0.45, 2.45);
  // 泛光只在高档；半分辨率跑，省一半开销
  const rawBloomSetSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => rawBloomSetSize(Math.max(64, Math.round(w * 0.5)), Math.max(64, Math.round(h * 0.5)));
  rawBloomSetSize(composer.renderTarget1.width, composer.renderTarget1.height);
  composer.addPass(bloom);

  composer.addPass(new OutputPass());          // ACES 色调映射 + sRGB
  const grade = new ShaderPass(GradeShader);   // 显示域调色（放在色调映射之后）
  composer.addPass(grade);

  let level = localStorage.getItem(STORE_KEY) || 'high';
  if (!FX_LEVELS.includes(level)) level = 'high';

  let autoT = 0, slowT = 0;
  const setLevel = (lv, silent) => {
    level = FX_LEVELS.includes(lv) ? lv : 'high';
    bloom.enabled = level === 'high';
    grade.enabled = level !== 'off';
    if (msaa) msaa.samples = level === 'off' ? 0 : 4;
    try { localStorage.setItem(STORE_KEY, level); } catch (e) {}
    if (!silent) console.log('[postfx] 画质档位 →', level);
    return level;
  };
  setLevel(level, true);

  /** 切下一档（high → mid → off → high） */
  function cycle() {
    const i = FX_LEVELS.indexOf(level);
    return setLevel(FX_LEVELS[(i + 1) % FX_LEVELS.length]);
  }

  let acc = 0, n = 0, avgMs = 16;
  function render(dt) {
    grade.uniforms.uTime.value += dt;
    if (avgMs > 26) grade.uniforms.uGrain.value = 0.35;   // 掉帧时颗粒更轻
    if (level === 'off') {
      renderer.render(scene, camera);
    } else {
      composer.render(dt);
    }
    // 自适应降档：连续 ~2.5s 帧耗 > 30ms → 降一档（只降不升，避免来回抖）
    if (autoT >= 0 && dt > 0) {
      acc += dt * 1000; n++;
      if (n >= 45) {
        avgMs = acc / n; acc = 0; n = 0;
        if (avgMs > 30 && level !== 'off') {
          slowT++;
          if (slowT >= 3) { slowT = 0; const before = level; setLevel(FX_LEVELS[FX_LEVELS.indexOf(level) + 1], true); onAuto(before, level); }
        } else slowT = 0;
      }
    }
  }

  function setSize(w, h) {
    W = w; H = h;
    composer.setSize(w, h);
    grade.uniforms.uRes.value.set(w * pr, h * pr);
  }
  setSize(W, H);

  grade.uniforms.uRes.value.set(W * pr, H * pr);

  /** 太阳屏幕位置（UV，y 向下）与可见度 0~1 */
  function setSun(x, y, i) {
    grade.uniforms.uSun.value.set(x, y);
    grade.uniforms.uSunI.value = i;
  }

  return {
    render, setSize, cycle, setSun,
    setLevel: (lv) => setLevel(lv),
    get level() { return level; },
    get avgMs() { return avgMs; },
    get composer() { return composer; },
    get grade() { return grade; },
    get bloom() { return bloom; },
    dispose() { try { composer.dispose(); } catch (e) {} },
  };
}
