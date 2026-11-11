import * as THREE from 'three';

/* mixamo FBX 载入后默认朝 +Z；如果你的模型是反的，把它改成 Math.PI */
export const MODEL_YAW_OFFSET = 0;

/* 一次性动作（播完就停、停在最后一帧，绝不循环）。
 * ★ 这是"门将动作/玩家动作重复两次"的根治点：
 *   three.js 的 AnimationAction 默认是 **LoopRepeat（无限循环）**，而服务端给一次性
 *   动作设的锁定时间基本等于（甚至略超）动画本身长度，于是动画播到底后会**从头再播一遍**
 *   —— 表现就是"同一段动作做了两次"（门将扑救/接球尤其明显，因为锁定时间留了余量）。
 *   改成 LoopOnce + clampWhenFinished 后，动画播完停在最后一帧，不再回绕。
 *
 * ★ 注意**不要**把循环类动作加进来：
 *   · gkStepL / gkStepR —— 门将左右侧步，是持续循环的挪步动画
 *   · gkIdle / gkHold   —— 门将待机 / 抱球，原地循环
 *   · idle / idleLong / run* / dribble / walk / fightIdle / dance* —— 全是循环
 *   加错会让这些动作播一下就僵在最后一帧。 */
const ONE_SHOT_CLIPS = new Set([
  'pass', 'passStill', 'strikeJog', 'slide', 'jump', 'tackleDown', 'throwIn',
  'hurtFace', 'hurtBody', 'punchL', 'punchR',
  'gkBlockL', 'gkBlockR', 'gkDiveL', 'gkDiveR',
  'gkCatchLow', 'gkCatchBody', 'gkCatchHigh', 'gkKick', 'gkRoll', 'gkDrop',
  'gkScoop',                      // 门将抢近距离球
  'header',                       // 头球
  'flyKick', 'hurricane', 'death',
  'spin',                         // 马赛回旋（踢球模式花式卡，1.27s 一次性）
  // 转向过渡：状态机里已停用（连续变向会鬼畜），但留着分类无害
  'startBack', 'toTurn', 'changeDir',
]);

const FORCE_SWITCH = new Set(['pass', 'passStill', 'strikeJog', 'slide', 'jump', 'header', 'startBack', 'toTurn', 'changeDir', 'dribble', 'punchL', 'punchR', 'tackleDown', 'throwIn', 'hurtFace', 'hurtBody', 'gkBlockL', 'gkBlockR', 'gkDiveL', 'gkDiveR', 'gkStepL', 'gkStepR', 'gkCatchLow', 'gkCatchBody', 'gkCatchHigh', 'gkKick', 'gkRoll', 'gkDrop', 'flyKick', 'hurricane', 'death', 'dance1', 'spin']);

/** 头顶血条（Sprite 永远朝向相机，不会因视角被身体挡住） */
/* ★ 独立血条 Sprite 已删除 —— 用户反馈"血条融进三角形里，三角形标识里也可以显示血量"。
 *   原来血条(y=1.90)和三角标识(y=2.03)只差 13cm，远看叠在一起糊成一团。
 *   现在血量**直接在三角标识内部显示**（见 markerSprite），少一个 Sprite 也省开销。 */

/** 玩家名牌：EA FC 那种"白色细体 + 细描边"，不带底板、不带盒子 */
function labelSprite(text) {
  const cv = document.createElement('canvas');
  cv.width = 640; cv.height = 96;
  const g = cv.getContext('2d');
  g.font = '400 42px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 3.5;                       // 细描边（原来是 6px 粗黑边，显得很土）
  g.strokeStyle = 'rgba(0,0,0,.7)';
  g.strokeText(text, 320, 50);
  g.fillStyle = '#ffffff';
  g.fillText(text, 320, 50);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  s.scale.set(2.0, 0.30, 1);
  s.renderOrder = 999;
  return s;
}

/**
 * 玩家标识：EA FC 式小三角 + **血量直接画在三角内部**。
 *
 * 用户要求"血条融进三角形里，三角形标识里面也可以显示血量" → 不再单独画一条血条，
 * 改成：**以底部的三角尖为底，血量从尖往上一格格长** —— 满血整块亮，掉血就从上往下退，
 * 一眼能看出还剩多少（和普通血条方向一致）。三角描边用队伍色（保留身份识别），
 * 低血时填充与底色都转红。
 * 返回的 Sprite 上挂了 `userData.setHp(v)` 供 Character.setHp 调用。
 */
function markerSprite(color, hp = 1) {
  const S = 96;                                  // 分辨率 ×1.5，缩放后更锐利
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(0.30, 0.30, 1);
  sp.renderOrder = 1000;

  const k = S / 64;
  const A = [11 * k, 13 * k], B = [53 * k, 13 * k], C = [32 * k, 51 * k];   // 向下的小三角
  const tri = () => { g.beginPath(); g.moveTo(A[0], A[1]); g.lineTo(B[0], B[1]); g.lineTo(C[0], C[1]); g.closePath(); };

  const draw = (r) => {
    g.clearRect(0, 0, S, S);
    // 底：深色三角（掉血后露出来的部分）；低血时底色泛红，一眼能看出危险
    tri();
    g.fillStyle = r > 0.25 ? 'rgba(8,10,14,.80)' : 'rgba(78,12,20,.86)';
    g.fill();
    /* 血量填充：★ 用户要求"上下调转，下面的三角形尖是底" ——
     *   即以**底部尖端**为底，血量从尖往上一格格长出来（和普通血条一样：满血顶到上沿，
     *   掉血就从上面往下退，剩下的始终是靠近尖的那一段）。
     *   裁剪在三角形状内，所以填充区永远贴着三角的下半部分收窄。 */
    g.save();
    tri(); g.clip();
    const h = (C[1] - A[1]) * r;
    g.fillStyle = r > 0.25 ? 'rgba(255,255,255,.95)' : '#ff4d5e';
    g.fillRect(0, C[1] - h, S, h);
    g.restore();
    // 描边：队伍色（本人白色）
    tri();
    g.lineWidth = 5 * k; g.lineJoin = 'round';
    g.strokeStyle = color || '#ffffff';
    g.stroke();
    tex.needsUpdate = true;
  };
  draw(Math.max(0, Math.min(1, hp)));
  sp.userData.setHp = (v) => draw(Math.max(0, Math.min(1, v)));
  return sp;
}

export class Character {
  constructor(holder, inner, clips, opts = {}) {
    this.holder = holder;
    this.inner = inner;
    this.clips = clips;
    this.cur = null;
    this.lastSwitch = -1;
    this.seqOf = {};                 // 每个一次性动作"已播过的起手序号"（防止误重播）
    this.mixer = new THREE.AnimationMixer(inner);
    this.actions = {};
    for (const k of Object.keys(clips)) {
      if (!clips[k]) continue;
      try {
        const a = this.mixer.clipAction(clips[k]);
        a.enabled = true;
        a.setEffectiveWeight(0);
        /* 一次性动作：播完停在最后一帧，不回绕（否则锁定时间比 clip 长时会"做两次"） */
        if (ONE_SHOT_CLIPS.has(k)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
        else { a.setLoop(THREE.LoopRepeat, Infinity); }
        this.actions[k] = a;
      } catch (e) { console.warn('clip 绑定失败', k, e); }
    }
    // 队服：新模型换球衣贴图（红/蓝两队）；没命中就退回轻度染色（旧模型走这条）
    const kitOk = opts.kitTex ? this.setKitTex(opts.kitTex) : false;
    if (!kitOk && opts.teamColor) this.tint(opts.teamColor);
    // holder 可能带 unitScale，脚环/名牌挂在不被缩放的 overlay 上
    const overlay = new THREE.Group();
    overlay.scale.setScalar(1 / (opts.unitScale || 1));
    holder.add(overlay);
    this.overlay = overlay;

    // 脚下队伍环：FC 那种细弧，不做成粗圆环
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.40, 0.45, 40),
      new THREE.MeshBasicMaterial({ color: opts.teamColor || '#fff', transparent: true, opacity: 0.62, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    overlay.add(ring);
    this.ring = ring;

    // 头顶三角标识（FC 风格），队伍色
    const mk = markerSprite(opts.isMe ? '#ffffff' : (opts.teamColor || '#ffffff'));
    mk.position.y = 2.03;
    overlay.add(mk);
    this.marker = mk;

    if (opts.name) {
      const lb = labelSprite(opts.name);
      lb.position.y = 2.22;
      overlay.add(lb);
      this.label = lb;
    }
    this.name = opts.name || '';        // 供调试/测试按名字定位角色（头顶标签是 sprite，读不到名字）

    /* 血量：不再单独挂一条血条，直接画在三角标识内部（见 markerSprite） */
    this._hp = -1;
    this.setHp(100);

    // 脚/趾骨骼：用来做"贴地钳制"（任何动画都不许把脚压到地面以下）
    this.groundBones = [];
    inner.traverse((o) => { if (o.isBone && /ToeBase|Toe_End|Foot/i.test(o.name)) this.groundBones.push(o); });
    this.lift = 0;
    // 基准：绑定姿势（T-pose）下脚趾离地高度 —— 站立时脚底正好贴地，这就是"正常贴地"的参考
    this.footRef = 0;
    if (this.groundBones.length) {
      holder.updateMatrixWorld(true);
      const baseY = inner.matrixWorld.elements[13];
      let low = Infinity;
      for (const b of this.groundBones) { const y = b.matrixWorld.elements[13]; if (y < low) low = y; }
      if (isFinite(low)) this.footRef = low - baseY;
    }

    this.setAnim('idle', 1, true);
  }

  /** 换球衣贴图：匹配球衣材质槽（贴图名/材质名含 texture_6 或 texture_10） */
  setKitTex(tex) {
    if (!tex) return false;
    let hit = 0;
    this.inner.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      const out = list.map((m) => {
        const tag = ((m.map && m.map.name) || '') + '|' + (m.name || '');
        if (!/texture_6|texture_10/i.test(tag)) return m;
        hit++;
        const c = m.clone();
        c.map = tex;
        if (c.color) c.color.set('#ffffff');
        c.needsUpdate = true;
        return c;
      });
      o.material = Array.isArray(o.material) ? out : out[0];
    });
    return hit > 0;
  }

  tint(hex) {
    const col = new THREE.Color(hex);
    this.inner.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      const out = list.map((m) => {
        const c = m.clone();
        if (c.color) {
          // 只做轻度染色，避免整个人变成纯色块
          c.color.lerp(col, 0.45);
        }
        return c;
      });
      o.material = Array.isArray(o.material) ? out : out[0];
    });
  }

  /**
   * 增量补挂动画（用于"核心动作先加载 → 进游戏后台补其余动作"）。
   * 只新增 actions，不动当前正在播的动画，所以调用时不会有任何视觉跳变。
   * @returns 新增成功的动作名数组
   */
  addClips(clips) {
    const added = [];
    for (const k of Object.keys(clips)) {
      if (!clips[k] || this.actions[k]) continue;
      try {
        const a = this.mixer.clipAction(clips[k]);
        a.enabled = true;
        a.setEffectiveWeight(0);
        if (ONE_SHOT_CLIPS.has(k)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
        else { a.setLoop(THREE.LoopRepeat, Infinity); }
        this.actions[k] = a;
        added.push(k);
      } catch (e) { console.warn('clip 补挂失败', k, e); }
    }
    return added;
  }

  setAnim(name, spd, immediate = false, seq) {
    if (!this.actions[name]) name = 'idle';
    if (!this.actions[name]) return;
    if (name === this.cur) {
      const a = this.actions[name];
      a.timeScale = spd;
      /* ★★ 一次性动作何时"从头播"：**只看服务端下发的起手序号**。
       *   绝不能靠 `a.time >= duration` 判断 —— 动画播完的时刻比锁定到期早 1~2 帧，
       *   那两帧里会被误判成"新指令"→ reset → 同一个动作做两次（用户反复反馈的问题）。
       *   序号变了 = 服务端确实发起了新的一次（比如连续两次扑救）→ 才 reset；
       *   序号没变 = 同一次动作还在进行 → 什么都不做（播完就停在最后一帧）。 */
      if (ONE_SHOT_CLIPS.has(name) && seq !== undefined && seq !== null && this.seqOf[name] !== seq) {
        this.seqOf[name] = seq;
        a.reset(); a.timeScale = spd; a.setEffectiveWeight(1); a.enabled = true;
        if (!a.isRunning()) a.play();
      }
      return;
    }
    const t = performance.now() / 1000;
    if (!immediate && !FORCE_SWITCH.has(name) && t - this.lastSwitch < 0.11) return; // 防抖
    this.lastSwitch = t;

    const prev = this.cur ? this.actions[this.cur] : null;
    const next = this.actions[name];
    if (seq !== undefined && seq !== null) this.seqOf[name] = seq;
    next.reset();
    next.timeScale = spd;
    next.setEffectiveWeight(1);
    next.enabled = true;
    if (!next.isRunning()) next.play();
    if (prev && prev !== next) {
      prev.enabled = true;
      const dur = FORCE_SWITCH.has(name) ? 0.09 : 0.2;
      next.crossFadeFrom(prev, dur, true);
    }
    this.cur = name;
  }

  /** 更新头顶血条（hp 0~100） */
  /** 血量：直接画在头顶三角标识里（0~100） */
  setHp(hp) {
    const r = Math.max(0, Math.min(1, (hp ?? 100) / 100));
    if (this.marker && this.marker.userData.setHp) this.marker.userData.setHp(r);
  }

  /** @param s {x,y,z,yaw,anim,animSpd,lean,hp} lean=转身侧倾(rad)，跑动中由转向速率驱动 */
  update(dt, s) {
    this.holder.position.set(s.x, s.y, s.z);
    this.holder.rotation.y = s.yaw + MODEL_YAW_OFFSET;
    this.setAnim(s.anim || 'idle', s.animSpd || 1, false, s.oneShotSeq);
    this.mixer.update(dt);
    // 转身侧倾：身体向弯心倒（FIFA/PES 的侧倾手感）。放在 mixer 之后写，
    // 即使有动画轨道碰了根节点旋转也以侧倾为准。
    this.inner.rotation.z = s.lean || 0;

    /* 脚部贴地钳制：某些动作（门将扑救/出球、倒地等）根骨骼下沉，
       会让脚甚至半条腿埋进草皮。这里量出最低的脚/趾骨骼，整体把角色抬起来
       —— 抬是瞬时的（绝不穿地），落是平滑的（不跳帧）。 */
    if (this.groundBones.length) {
      this.holder.updateMatrixWorld(true);
      const baseY = this.inner.matrixWorld.elements[13];
      let low = Infinity;
      for (const b of this.groundBones) {
        const y = b.matrixWorld.elements[13];
        if (y < low) low = y;
      }
      if (isFinite(low)) {
        const need = this.footRef - (low - baseY);      // >0 = 脚比正常站姿更低（要穿地了）
        const k = 1 - Math.exp(-14 * dt);
        this.lift = Math.max(0, Math.max(need, this.lift + (need - this.lift) * k));
        if (this.lift > 0.0005) this.holder.position.y = (s.y || 0) + this.lift;
      }
    }
    // 血条（只在变化时重绘）
    if (s.hp !== this._hp) { this._hp = s.hp; this.setHp(s.hp); }
    if (this.label) this.label.material.rotation = 0;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.holder.parent && this.holder.parent.remove(this.holder);
  }
}
