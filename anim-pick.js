/* ============================================================
 * anim-pick.js —— 运动包动画状态机（服务端算，客户端预测时复用同一函数）
 *
 * 运动包 14 个 clip 全部参与：
 *   idle        Breathing Idle          静止
 *   walk        Walking                 0 ~ 2.2
 *   run1        Running1                2.2 ~ 4.0
 *   run2        Running 2               4.0 ~ 5.5
 *   run3        Running3                5.5 ~ 7.0
 *   run4        Running4                7.0 ~ 9.0（疾跑）
 *   runBack     Run Backward            背向移动
 *   startBack   start run to back       「停止状态 → 向后跑」起步过渡
 *   arcRight    Run Forward Arc Right   高速右弧线跑
 *   arcLeft     (arcRight 的镜像)       高速左弧线跑
 *   rightTurn   Running Right Turn      中低速右转
 *   leftTurn    (rightTurn 的镜像)      中低速左转
 *   toTurn      Running To Turn         急停掉头
 *   changeDir   Change Direction        输入方向突变
 *   jump        Running Jump            跳跃滞空
 *   slide       Running Slide           滑铲 / 攻击模式扑抢
 *   dribble     Dribble                 带球（足球包）
 *   pass        Soccer Pass             传球 / 射门（足球包）
 *   fightIdle   Bouncing Fight Idle     攻击模式闲置格斗姿势（武术包）
 *   punchL      left Punching           左勾拳（武术包，攻击模式左键）
 *   death       Death From The Back     死亡（被击倒 → 抬进球员席）
 *   flyKick     Kicking                 飞踢（攻击模式技能卡·短CD）
 *   hurricane   Hurricane Kick          螺旋踢（攻击模式技能卡·长CD）
 *   punchR      rightPunching           右直拳（武术包，攻击模式右键）
 *   tackleDown  Soccer Tackle           被铲倒（足球包，clip 自身已含起身，不另接 getUp）
 *   dance1      Gangnam Style           跳舞（舞蹈包，整段 12.4s 一起跳，不拆键位）
 *   dance6~9    Hip Hop/Swing/Breakdance 跳舞（整段循环，6~9 键切换）
 * ============================================================ */
(function (root, factory) {
  const SH = (typeof module === 'object' && module.exports)
    ? require('./public/js/shared.js')
    : root.SHARED;
  const api = factory(SH);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AnimPick = api;
})(typeof self !== 'undefined' ? self : globalThis, function (SH) {
  'use strict';
  const { C, clamp, angDelta } = SH;

  /**
   * 每个 clip 的"自然速度" = 动画根位移 ÷ 时长（实测值，见 rootmotion.json）。
   * timeScale = 实际速度 / 自然速度 → 角色走多快，动画就走多快，脚底下不打滑。
   * 也就是：位移完全由动画的位移决定。
   */
  const CLIP_SPEED = {
    /* ★ 三档跑步（用户给的"慢/中/快"）+ 冲刺。这四个值必须等于**原始 FBX 的实测自然速率**，
     *   否则 timeScale ≠ 1 → 脚打滑。校验：`node probe-runspeed.mjs`。
     *   实测：runSlow 3.33 · runMid 5.51 · runFast 6.64 · sprint(高速奔跑) 6.64 */
    idle: 0, walk: 1.72, run1: 3.33, run2: 5.51, run3: 6.64, run4: 6.64,
    runBack: 2.22, startBack: 1.70,
    arcRight: 3.36, arcLeft: 3.36, rightTurn: 3.94, leftTurn: 3.94,
    toTurn: 1.79, changeDir: 3.05,
    jump: 4.77, slide: 4.07,
    dribble: 2.64, pass: 2.18,
    strikeJog: 2.24,      // 球员奔跑中射门（足球动作包）116 单位 / 1.30s
    passStill: 0,         // 站立传球（足球动作包）原地 0 位移
    fightIdle: 0,         // Bouncing Fight Idle 2.97s 原地循环
    punchL: 0, punchR: 0, // 左右刺拳均为原地动作
    flyKick: 0, hurricane: 0, // 攻击模式技能（原地出招）
    death: 2.85,              // 死亡（被击倒 → 等抬走，播完整段）
    tackleDown: 0,        // 铲倒（原地，位移冻结；clip 1.77s 内含起身）
    throwIn: 0,           // 手抛球（原地，位移冻结）
    hurtFace: 0, hurtBody: 0,   // 受击反应（原地）
    gkBlockL: 0, gkBlockR: 0, gkDiveL: 0, gkDiveR: 0,   // 守门员扑救（横向位移由服务端驱动）
    gkStepL: 0, gkStepR: 0,       // 守门员锁定后的左右侧步防守
    gkIdle: 0, gkHold: 0,         // 门将待机 / 抱球（原地循环）
    gkScoop: 0, header: 0,        // 门将抢近距离球 / 头球（原地，一次性）
    idleLong: 0,          // 站立久了原地活动（Happy Idle，原地循环）
    dribbleIdle: 0,       // 持球原地等待（Soccer Idle，来回拉球，原地循环）
    spin: 0,              // 马赛回旋（原地转身，位移由 clip 自己的根旋转完成）
    /* ⚠️ 这个动作的"转"完全在**根节点 root_skeleton 的旋转曲线**上：
     *    素材是 76 帧的 0→360° 曲线，一旦被重采样成 1fps（只剩首尾两帧），
     *    360° ≡ 0° → 播出来就是**直直站着不动**（踩过，用户反馈"马赛回旋没动作"）。
     *    校验：`node probe-glb.mjs`（任何动作 < 10 帧都会报警）。 */
    chip: 0,              // 横传（备用，暂未接入状态机）
    gkCatchLow: 0, gkCatchBody: 0, gkCatchHigh: 0,   // 门将自动接球（按来球高度）
    gkKick: 0, gkRoll: 0, gkDrop: 0,                // 门将出球（抱球后发球，专用动画）
    /* 跳舞（原地循环，位移冻结）：舞段表见 shared.js 的 C.DANCES */
    dance1: 0, dance2: 0, dance3: 0, dance4: 0, dance5: 0, dance6: 0,
  };

  /* 一次性动作：播放期间被锁定，不被移动状态打断。
   * ★ 时长必须 ≥ 动画实际播放时间（clip 时长 ÷ 播放倍速），否则锁一松开就会被
   *   重新触发 → 表现成"同一个动作做两次"。
   *   校验办法：`node probe-lock.mjs`（逐条对比 clip.duration / spd 与这里的值）。 */
  const ONE_SHOT = {
    pass: 1.11, passStill: 1.05, strikeJog: 0.85,
    slide: 1.53, startBack: 0.5, toTurn: 0.42, changeDir: 0.34,
    /* 出拳：clip 1.27s / 1.26s 原速 —— 原来写 0.5/0.42 比动画短，会播到一半就解锁重播 */
    punchL: 1.29, punchR: 1.28,
    flyKick: 2.19, hurricane: 1.85,   // 攻击模式技能（Kicking 2.17s / Hurricane Kick 1.83s，原速）
    death: 2.99,          // clip 2.97s 原速（原来 2.85 比动画短 → 会重播）
    tackleDown: 1.79,     // clip 1.77s 原速（原来 1.5 比动画短 → 会重播）
    throwIn: 2.07, hurtFace: 0.64, hurtBody: 0.68,
    /* 门将扑救：clip ÷ 倍速（全部按 2.0 倍速 → 1.24~1.70s） */
    gkBlockL: 1.32, gkBlockR: 1.24, gkDiveL: 1.70, gkDiveR: 1.62,
    /* 门将接球：clip ÷ 倍速（防重播）。低 2.60/1.5=1.73 · 身 2.10/1.5=1.40 · 高 2.73/1.25=2.18 */
    gkCatchLow: 1.74, gkCatchBody: 1.40, gkCatchHigh: 2.19,
    /* 门将抢近距离球（Goalkeeper Scoop）· 头球 */
    gkScoop: 2.62, header: 2.39,
    spin: 1.30,           // 马赛回旋 clip 1.27s 原速（锁定略留 0.03 余量）
    /* 门将出球：原速播完整段（球在动作结束时才出手），留 0.02s 余量 */
    gkKick: 3.92, gkRoll: 3.15, gkDrop: 3.15,
  };
  // 一次性动作的播放倍速（略快，收招不拖沓）
  const ONE_SHOT_SPD = { pass: 1.35, passStill: 1.3, strikeJog: 1.25, punchL: 1.0, punchR: 1.0, tackleDown: 1.0,
    flyKick: 1.25, hurricane: 1.15, death: 1.04,
    throwIn: 1.35, hurtFace: 1.5, hurtBody: 1.4,
    gkBlockL: 2.0, gkBlockR: 2.0, gkDiveL: 2.0, gkDiveR: 2.0,
    gkCatchLow: 1.5, gkCatchBody: 1.5, gkCatchHigh: 1.25,
    gkScoop: 1.0, header: 1.0, spin: 1.0,
    gkKick: 1, gkRoll: 1, gkDrop: 1 };              // 出球动作按原速（加速播很难看）

  function set(p, name, lock) {
    const changed = p.anim !== name;
    if (changed) { p.anim = name; p.animT = 0; }
    else p.animT += 0;
    /* ★★ `animLock` 只能在**切换到该动作的那一帧**设一次。
     *
     *   原来是无条件 `if (lock) p.animLock = lock`。而"一次性动作"分支每帧都会调
     *   `set(p, name, ONE_SHOT[name])` → **每帧把锁重新充满**，于是：
     *     · kickAnim（真正在递减的时长）先到 0 → 但 animLock 还停在满值
     *     · 再花整整一个"动作时长"才衰减到 0
     *   结果：动作播完了，客户端仍被要求保持这个动作 —— 表现就是用户说的
     *   **"定着这个姿势移动"**（gkScoop 2.62s 的动作实际卡 5.2s；
     *   踢球/出拳也会拖住一段动画时间，人一边滑行一边保持出招姿势）。
     *
     *   锁的语义本来就是"起手时上锁，由服务端计时器自然衰减"，
     *   所以只在 changed 时设才是对的。 */
    if (lock && changed) p.animLock = lock;
  }

  function timeScaleFor(name, sp) {
    const base = CLIP_SPEED[name];
    if (!base) return 1;
    // 速度档位本来就取自动画速率，疾跑 8.5m/s 是动画自然速率的 1.49 倍（真实冲刺步频），
    // 所以范围放到 0.7~1.55
    return clamp(sp / base, 0.7, 1.55);
  }

  /**
   * @param p   player（含 vx,vz,yaw,y,slideT,kickAnim,dribbling,anim,animT,animLock,input）
   * @param dt  秒
   */
  function pickAnim(p, dt) {
    if (p._pyaw === undefined) p._pyaw = p.yaw;
    const turn = angDelta(p._pyaw, p.yaw) / Math.max(dt, 1e-4);   // rad/s，>0 右转
    p._pyaw = p.yaw;
    const absTurn = Math.abs(turn);
    const sp = Math.hypot(p.vx, p.vz);

    p.animT += dt;
    /* 连续静止时长：给"站立久了换待机"用（移动/出招/倒地都清零） */
    const busy = p.slideT > 0 || p.kickAnim > 0 || p.downT > 0 || p.animLock > 0
              || p.y > 0.06 || p.mode !== 'soccer';
    p.idleT = (sp < 0.28 && !busy) ? (p.idleT || 0) + dt : 0;

    /* ★★ 持球计时（用户要求：**拿到球那一刻**起算，满 3 秒没有动作才进"拉球待机"）
     *   · 累计口径：只要球在自己脚下就累加（走也好、站也好都算），**球一脱手/被踢出/
     *     被抢断立即清零** → 所以下一次拿到球会重新计满 3 秒。
     *   · 门将抱球（gkHold）不算"持球待机"：门将用的是 gkHold 抱球姿势，绝不播拉球
     *     （用户明确要求"ai守门员不播放拉球动作，普通球员才有控球拉球动作"）。
     *   · 这个值只服务于下面的 4.8 分支，别处不用。 */
    const holdingBall = !!p.dribbling && !p.gkHold;
    p.ballHoldT = holdingBall ? (p.ballHoldT || 0) + dt : 0;

    /* ---- 0.9 门将动作：立刻起手（起跳滞空也不能被 jump 覆盖） ----
     * ★ 速度优先用服务端给的 gkAnimSpd：门将接球/扑救要按"球还有多久到"变速，
     *   让**手到位的那一刻正好球到**（否则快速射门时手还没伸出去球就过去了，
     *   或者动作太慢看起来"没扑就接住了"）。 */
    if (p.kickType && /^gk/.test(p.kickType) && p.kickAnim > 0 && ONE_SHOT[p.kickType] !== undefined) {
      set(p, p.kickType, ONE_SHOT[p.kickType]);
      /* ★ 服务端给的 gkAnimSpd 是**绝对播放倍速**（已含基准倍速），直接用；
       *   没给才退回表里的基准值。以前只在 >1 时才用，导致
       *   "服务端要求 3 倍速播放"被当成 1.5 倍 → 动作慢半拍、窗口对不上。 */
      p.animSpd = p.gkAnimSpd || ONE_SHOT_SPD[p.kickType] || 1;
      return p.kickType;
    }

    /* ---- 1. 一次性动作锁定中 ---- */
    if (p.animLock > 0 && ONE_SHOT[p.anim] !== undefined) {
      p.animSpd = ONE_SHOT_SPD[p.anim] || 1;
      return p.anim;
    }

    /* ---- 1.5 被铲倒 / KO：倒地（clip 自带起身），最高优先级（期间服务端已定住移动） ---- */
    // 死亡倒地（血量清零）：播 Death From The Back，播完才被抬进球员席
    if (p.dying) { set(p, 'death', ONE_SHOT.death); p.animSpd = ONE_SHOT_SPD.death; return 'death'; }
    // 在球员席上（血量清零被抬走）→ 站在席位前等，别播倒地球动画
    if (p.dead) { set(p, 'idle'); p.animSpd = 1; return 'idle'; }
    if (p.downT > 0) {
      set(p, 'tackleDown', ONE_SHOT.tackleDown);
      p.animSpd = ONE_SHOT_SPD.tackleDown;
      return 'tackleDown';
    }

    /* ---- 1.55 门将锁定防守：面向球时左右 = 侧步，前后 = 正常 ---- */
    if (p.isGK && p.aimLock && sp > 0.35) {
      const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
      const rx = -fz, rz = fx;                                   // 面朝方向的右手边
      const lat = p.vx * rx + p.vz * rz;                          // 横向速度
      const fwd = p.vx * fx + p.vz * fz;                          // 前后速度
      if (Math.abs(lat) > Math.abs(fwd) + 0.15) {                 // 以横移为主 → 侧步
        const name = lat > 0 ? 'gkStepR' : 'gkStepL';
        set(p, name);
        p.animSpd = clamp(Math.abs(lat) / 2.0, 0.65, 1.7);
        return name;
      }
    }

    /* ---- 1.6 受击反应：被打脸 / 被打中身体（覆盖移动，倒地优先级之下） ---- */
    if (p.hurtAnimT > 0 && (p.hurtAnim === 'hurtFace' || p.hurtAnim === 'hurtBody')) {
      set(p, p.hurtAnim, ONE_SHOT[p.hurtAnim]);
      p.animSpd = ONE_SHOT_SPD[p.hurtAnim];
      return p.hurtAnim;
    }

    /* ---- 2. 滑铲（含攻击模式扑抢）---- */
    if (p.slideT > 0) {
      set(p, 'slide');
      // 高速放铲动画也播快点（初速 = 放铲时的跑动速度）
      p.animSpd = clamp((p.slideSpd || 4.22) / 4.22, 0.75, 1.7);
      return 'slide';
    }

    /* ---- 3. 滞空 = 头球动作 ----
     * 用户要求「Soccer Header 这个动作应该替换空格跳」→ 空格起跳就播 header。
     * （原来这一步播的是老的 Mixamo `jump`；头球动作本身就是"起跳争顶"，
     *   用来当跳跃动画既统一了姿态，又天然对上顶球判定。）
     * 倍速调到 ~1.25，让 clip 里的"蹬地—腾空"段落刚好覆盖一次跳跃的滞空时长。 */
    if (p.y > 0.06) {
      /* ★ 这里**不能**给 animLock（`set(p,'header', ONE_SHOT.header)`）：
       *   animLock 每帧都会被重新赋值 → 在空中一直顶住 → 落地后还要从 2.4s 开始衰减
       *   → 玩家落地后 2.4 秒内踢不了球、传不了球（体感"僵住"）。
       *   跳跃是"持续状态"不是"一次性动作"，重播交给 setAnim 的"名字切换"路径即可。 */
      set(p, 'header');
      p.animSpd = clamp(1.15 + sp * 0.04, 1.15, 1.5);
      return 'header';
    }

    /* ---- 4. 踢球 / 出拳动作：按类型选动画 ----
     *   出拳（攻击模式）  → punchL 左勾拳 / punchR 右直拳
     *   射门（任意速度）  → strikeJog   Strike Foward Jog（爆射，跑射专用）
     *   跑动中传球        → pass        Soccer Pass
     *   站着不动传球      → passStill   非跑动传球
     */
    if (p.kickAnim > 0) {
      // 所有"踢球之外"的一次性动作，动画名就直接等于 kickType：
      //   守门员扑救/接球/出球（gk*）· 手抛球 throwIn · 出拳 punchL/R
      //   · 攻击模式技能卡 flyKick / hurricane（Kicking / Hurricane Kick）
      //   ⚠️ 这几类漏一个，按卡牌就会掉到下面的"传球"分支去播 Soccer Pass（曾踩过）
      if (p.kickType && p.kickType !== 'shoot' && p.kickType !== 'pass'
          && ONE_SHOT[p.kickType] !== undefined) {
        set(p, p.kickType, ONE_SHOT[p.kickType]);
        p.animSpd = p.gkAnimSpd || ONE_SHOT_SPD[p.kickType] || 1;
        return p.kickType;
      }
      if (p.kickType === 'shoot') {
        set(p, 'strikeJog', ONE_SHOT.strikeJog);
        p.animSpd = ONE_SHOT_SPD.strikeJog;
        return 'strikeJog';
      }
      if ((p.kickSpd || 0) > 1.2) {
        set(p, 'pass', ONE_SHOT.pass);
        p.animSpd = ONE_SHOT_SPD.pass;
        return 'pass';
      }
      set(p, 'passStill', ONE_SHOT.passStill);
      p.animSpd = ONE_SHOT_SPD.passStill;
      return 'passStill';
    }

    /* ---- 4.5 门将抱球在手：用**抱球姿势**（gkHold），不是普通待机 ----
     * ★ 这两个动作（gkHold 抱球 / gkIdle 锁定）之前**只在表里登记、从没被 set() 调用过**，
     *   属于死代码 —— 用户反馈的"空缺的动作没用"就是它们。
     *   `gkHold` 只有门将没收球后才为 true，所以判断它本身就够。
     *   优先级放在"静止"之前：门将抱着球时不该播普通 idle。 */
    if (p.gkHold) {
      set(p, 'gkHold');
      p.animSpd = 1;
      return 'gkHold';
    }

    /* ---- 4.8 持球**原地等待**（Soccer Idle：来回拉球）----
     * ★ 必须排在"5 静止 → idle"**之前**：站住不动时 sp≈0，会先命中静止分支播 idle。
     *   这个动作脚下的球由 dribble-idle.json 的脚部轨迹驱动（见 server.js），
     *   所以门限取"真的站住"（< 0.45），走动时不会误触发导致球乱飘。
     *
     * ★★ 入场条件（用户要求，2026-10-18）：**拿到球起算满 3 秒、且此刻没有动作（几乎静止）**
     *   才播"拉球待机"。以前是球一到脚 + 站住就立刻播 —— 刚接到球就开始来回拉球，很跳。
     *   · 计时 `p.ballHoldT` 从**拿到球那一刻**累加（走/站都算），球脱手立即清零；
     *   · 所以"带球跑了 3 秒后停下"也会立刻进入（符合"从拿到球起算"的口径）。
     * · 只给**普通球员**：门将（isGK）与抱球（gkHold）一律不播 ——
     *   用户明确要求"ai守门员不播放拉球动作，普通球员才有控球拉球动作"。 */
    if (holdingBall && !p.isGK && (p.ballHoldT || 0) >= (C.DRIBBLE_IDLE_DELAY || 3) && sp < 0.45) {
      set(p, 'dribbleIdle');
      p.animSpd = 1;
      return 'dribbleIdle';
    }

    /* ---- 5. 静止 ---- */
    if (sp < 0.28) {
      // 跳舞模式站着 → 舞段（循环播；移动即打断）
      //   1 = Gangnam Style（整段 12.4s，不拆分）；6/7 = Hip Hop Dancing；8 = Swing；9 = Breakdance
      if (p.mode === 'dance') {
        /* ★ 舞段表在 shared.js 的 C.DANCES（一舞一键，键位/转盘/服务端共用）。
         *   以前这里是 `if (n>=2 && n<=5) n = 1;` —— 2~5 号键全放同一段 Gangnam，
         *   用户反馈"舞蹈重复了几个键"就是这个。 */
        const list = C.DANCES || [];
        const d = (list[clamp(Math.floor(p.dance || 1), 1, list.length) - 1] || {}).clip || 'dance1';
        set(p, d);
        p.animSpd = 1;
        return d;
      }
      // 攻击模式站着 → 格斗待机姿势（Bouncing Fight Idle）
      if (p.mode === 'attack') { set(p, 'fightIdle'); p.animSpd = 1; return 'fightIdle'; }
      /* 门将锁定防守站着 → **门将锁定姿势**（gkIdle），不是普通呼吸待机。
       * ★ 之前 gkIdle 也是死代码（只在表里登记），用户明确要求"守门员锁定足球状态的
       *   站立姿势"要用这个动作。放在 idleLong 之前，因为门将不该播"站立久了活动"。 */
      if (p.isGK && p.aimLock) { set(p, 'gkIdle'); p.animSpd = 1; return 'gkIdle'; }
      /* 站立久了 → 换成"原地活动"待机（Happy Idle），更有生气。
       *   idleT 由服务器累计（连续静止时长），做成一进一出都带滞回，避免在阈值上抖：
       *   静止满 6s 进入，一旦移动就清零（回到普通呼吸待机）。 */
      if ((p.idleT || 0) >= 6) { set(p, 'idleLong'); p.animSpd = 1; return 'idleLong'; }
      set(p, 'idle'); p.animSpd = 1; return 'idle';
    }

    /* ---- 方向关系 ---- */
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    const vx = p.vx / sp, vz = p.vz / sp;
    const dotF = fx * vx + fz * vz;                 // 1=正前 -1=正后

    /* ---- 6. 背向移动 ----
     * ★ 已去掉 start run to back 过渡（那是 Mixamo 动画；足球动作包没有对应起步动作）。
     *   直接从静止进入后退跑，衔接靠 crossFade 的 0.2s 混过去。
     */
    if (dotF < -0.32) {
      set(p, 'runBack');
      p.animSpd = timeScaleFor('runBack', sp);
      return 'runBack';
    }

    /* ---- 7. 带球：低速时用 Dribble，高速时仍用跑步（球自动吸附脚前） ----
     * 注：转弯 / 弧线跑 / 急停掉头这几个动画（rightTurn/leftTurn/arcRight/arcLeft/
     *     toTurn/changeDir）已停用 —— 实测连续变向时会反复切换导致鬼畜，
     *     转身改为直接由鼠标/移动方向驱动朝向，动画只管"跑多快 + 朝哪跑"。
     */
    if (p.dribbling && sp < 4.5) {
      set(p, 'dribble');
      p.animSpd = clamp(0.75 + sp * 0.3, 0.75, 1.9);
      return 'dribble';
    }

    /* ---- 8. 速度分档：run1(小跑) → run2(中跑) → run3(快跑) → run4(冲刺)
     * ★ 足球动作包补齐了「冲刺」(Sprint 5.75 m/s)，疾跑段不再复用快跑。
     *   低于 WALK 阈值的慢速直接用 run1，靠 timeScale 放慢（脚不滑，只是步频慢）。 */
    const S = C.SPD;
    let name = 'run1';
    if (sp >= (S.RUN3 + S.RUN4) / 2) name = 'run4';
    else if (sp >= (S.RUN2 + S.RUN3) / 2) name = 'run3';
    else if (sp >= (S.RUN1 + S.RUN2) / 2) name = 'run2';
    set(p, name);
    p.animSpd = timeScaleFor(name, sp);
    return name;
  }

  return { pickAnim, CLIP_SPEED, ONE_SHOT };
});
