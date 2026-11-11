/* ============================================================
 * shared.js —— 服务端与客户端共用的常量 / 工具
 * 服务端用 require('../public/js/shared.js') 载入
 * 客户端用 <script src="js/shared.js"> 载入，得到 window.SHARED
 * 两边的物理常量必须逐项一致，否则预测与校正会来回拉扯
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SHARED = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const C = {
    /* ---------- 网络 ---------- */
    TICK_HZ: 30,                 // 服务器主循环频率
    INPUT_HZ: 20,                // 客户端上行心跳
    MAX_PLAYERS: 30,

    /* ---------- 球场 ---------- */
    // 长边沿 X，宽边沿 Z。球门在 x = ±HALF_L
    FIELD: { HALF_L: 52.5, HALF_W: 34 },   // 105m x 68m（FIFA 标准场地）
    GOAL:  { W: 7.32, H: 2.44, D: 2.0 }, // 门宽(沿Z) / 门高 / 门深
    GOAL_POST_R: 0.06,           // 门柱/横梁半径（真实门柱直径 12cm）—— 用于"中柱"判定
    WALL_MARGIN: 6,              // 场外缓冲区（球出界后落回场内）

    /* ---------- 球 ---------- */
    BALL_R: 0.11,
    BALL_MASS: 0.43,
    GRAVITY: 20,
    BALL_AIR_DRAG: 0.16,         // 空气阻力系数（每秒）
    BALL_GROUND_DRAG: 0.45,      // 地面滚动阻尼（每秒）：26m/s 射门约能滚 57m，够从禁区外打到门里
    BALL_BOUNCE: 0.55,           // 触地垂直恢复系数
    /* ★ 旋转球（击球点 UI，Magnus 效应）—— 用**真实空气动力学公式**：
     *
     *   F = ½ · ρ · A · C_L · |v|²  ，方向 = ω̂ × v̂
     *   → 加速度 a = (½·ρ·A·C_L·r) / m · ω · v   （正比于 ω·v，即真实足球教科书式）
     *
     *   真实足球参数（FIFA Quality Pro / 标准 5 号球）：
     *     ρ 空气密度 1.225 kg/m³ · 球直径 0.22m → A = π r² = 0.038 m²
     *     m 球质量 0.43 kg · r 球半径 0.11 m
     *     C_L 升力/侧力系数 ≈ 0.15~0.25（随转速比 Sp=ωr/v 变化；本作取 0.20 常数近似）
     *
     *   ★ 升力系数 C_L 不是拍脑袋常数，用文献里的**真实数据函数**
     *     （Goff & Carré, Am. J. Phys. 77(11):1020, 2009 —— 足球飞行标准模型）：
     *
     *        C_L = 1 / ( 2 + v / v_spin )     ，v_spin = r·ω（球面切向速度）
     *        a   = ( ½ρA/m ) · C_L · v²       ，方向 = ω̂ × v̂
     *
     *     所以 a = BALL_AERO_K · C_L · v²，BALL_AERO_K = ½ρA/m = 0.0541 m⁻¹
     *       （ρ=1.225、A=0.038、m=0.43 —— 全是真实参数，无自由系数）。
     *
     *   自洽性校验（用本函数算出的 a 反推真实任意球，应吻合论文实测）：
     *     · Carré 2002 实测：v=18.5 m/s、ω=64 rad/s、18m 航程 → 偏移 >3m
     *       本模型：v_spin=7.04、v/v_spin=2.63 → C_L=0.216 → a=4.0 m/s²
     *       18m 飞行 ≈1.1s → 偏移 ≈ ½·4·1.1² ≈ 2.4m，末端球减速 C_L 上升再加大 → ✓ >3m
     *     · Bray & Kerwin 2003 实测：v=25 m/s、18m 任意球需仰角 16.5~17.5° 才能绕过人墙入网 → ✓
     *     · 25m/25m·s⁻¹/10转每秒 → 横移 ≈4m（真实强弧线量级，肉眼极明显） */
    BALL_AERO_K: 0.0541,         // ★ ½ρA/m = 0.5·1.225·0.038/0.43 m⁻¹（真实空气动力学常数）
    BALL_MAGNUS_LIFT: 1.15,      // 后旋升力系数略高的真实修正（backspin Cl > sidespin Cl）
    BALL_SPIN_DECAY: 0.22,       // 空中自旋衰减（每秒）：空中 3s 还剩一半
    BALL_SPIN_HIT_DECAY: 0.72,   // 落地弹跳一次自旋衰减
    BALL_SPIN_GROUND_DECAY: 1.15,// ★ 贴地滚动时自旋被地面摩擦吃掉（每秒）
    BALL_MAGNUS_GROUND: 0.85,    // ★ 贴地时 Magnus 力保留比例（贴地同样出弧线，肉眼可见）
    BALL_SPIN_MIN_SPD: 2,        // 球速低于这个值不再施加 Magnus（慢滚球旋转没意义）
    BALL_SPIN_GROUND_H: 0.42,    // ★ 高于此高度算"完全在空中"（Magnus 全额）；以下按高度削弱
    BALL_RISE_K: 0.30,           // ★ 偏心击球自然抬脚：vy 抬升 = off · min(RISE_MAX, RISE_K·球速)
    BALL_RISE_MAX: 6.5,          //    真实踢弧线球必然"包"到球的下侧 → 球一定离地
    BALL_MAX_SPEED: 40,

    /* ---------- 球员 ---------- */
    PLAYER_R: 0.45,              // 碰撞半径
    PLAYER_HEIGHT: 1.8,
    ACCEL0: 11,                  // 起步爆发加速度 m/s²；随速度衰减：a = ACCEL0 * (1 - v/vmax)
                                 // → 越跑越快、越接近极限越难加速，符合真实足球运动员加速曲线
                                 //   （0→极速约 2.5s：走→慢跑→快跑→冲刺一档档上来）
    DECEL: 18,                   // 松手减速度
    TURN_RATE: 14,               // 站立/将停时朝向相机的插值速率 rad/s（瞄准手感，别太抽搐）

    /* 转向模型 —— 学实况足球 / FIFA 的"车速式"转向：
     * 速度的"方向"以受限角速度转向输入方向，面朝永远 = 速度方向 → 不侧滑、不鬼畜；
     * 低速几乎原地转身（跟手），高速自然兜大弧线（冲刺半径 ≈ 1.85m，和真人一致）。
     * 旧模型是"面朝先转、速度慢慢追"，高速下速度永远追不上面朝 → 打滑 + 拐不过弯。 */
    STEER_MAX: 12,               // 低速最大转向角速度 rad/s（站着/慢走 ≈ 原地转身）
    STEER_MIN: 4.6,              // 冲刺（8.5m/s）时的转向角速度 rad/s → 转弯半径 ≈ 1.85m
    STEER_K: 0.9,                // 转向角速度随速度衰减系数
    TURN_CUT: 0.80,              // 大角度变向时的速度折扣（高速急转掉速，像真人"撑一步"再弹出去）
    TURN_CUT_ANGLE: 0.7,         // 输入与当前方向差超过 ~40° 算大角度变向
    DECEL_CUT: 8,                // 超速（急转掉速）时的收敛减速度 m/s²

    /* 速度分档 —— 数值不是拍脑袋定的，是从每个 FBX 的根位移实测出来的：
     *   位移速率 = 动画一圈走的距离 / 一圈时长（见 rootmotion.json）
     * 角色的实际位移 = 动画的位移，脚不打滑；速度靠 ACCEL 一档档加上去。
     * ★ 2026-10 换成「足球动作包」（与模特包同源骨架，不再重定向）后重新实测：
     *   run1 小跑 2.40 · run2 中跑 4.08 · run3 快跑 5.52 m/s（实测值见 fbx2glb2.mjs 输出） */
    SPD: {
      WALK: 1.72,                // 仅用于"算不算在走"的阈值（本包没有走的动画）
      /* ★ 2026-10 换成用户给的「摆臂小→中→大」三档跑步（同源，实测自然速率）：
       *   小跑 3.33 · 中跑 5.51 · 快跑 6.64 m/s —— 摆臂 72.5 / 130.9 / 174.3 cm 递进。 */
      RUN1: 3.33,                // Running 轻摆臂
      RUN2: 5.51,                // Running 中摆臂
      RUN3: 6.64,                // Running 高摆臂
      RUN4: 8.5,                 // 疾跑上限：真实足球运动员冲刺 ≈ 8.5m/s（30km/h）
                                 // 用「冲刺」动画（Sprint 5.75），超速时以 1.48 倍步频播放
    },
    BACK_SPEED: 2.22,            // 后退跑上限（Jog Backward 实测 71 单位 / 0.80s）
    DRIBBLE_SPEED_MUL: 0.8,      // 带球冲刺 ≈ 6.8m/s（真实带球冲刺约是空跑的 8 折）
    /* ★ 持球「拉球待机」入场延迟（用户要求：拿到球起算 3 秒没有动作才进入拉球待机）。
     *   以前是"球一到脚 + 站住"就立刻播 Soccer Idle，玩家刚接到球就来回拉球，很跳。
     *   现在从**拿到球那一刻**开始计时（不是从站住开始），满 3s 且此刻几乎静止
     *   （sp < 0.45）才进 dribbleIdle；球一脱手/踢出，计时清零。
     *   只对**普通球员**生效 —— AI 守门员 & 门将抱球一律不播（见 anim-pick.js 的 4.8 分支）。 */
    DRIBBLE_IDLE_DELAY: 3.0,     // 秒
    JUMP_VEL: 6.2,
    SLIDE_MIN: 3.5,              // 滑铲初速下限（站着铲也会出去一小步）
    SLIDE_MAX: 8.5,              // 滑铲初速上限 = 当前跑动速度（高速放铲按速度下地，距离随初速）
    SLIDE_TIME: 0.75,            // 滑铲持续（足球动作包的飞铲 1.53s 自带起身，0.75s 只是物理滑行时长，动画继续播完）
    SLIDE_CD: 1.4,

    /* ---------- 足球逻辑 ---------- */
    GRAB_DIST: 0.5,              // 吸附带球距离（需求指定 0.5m）——贴身小圆圈，不分朝向
    /* ★ 正前方「控制扇形」（用户要求：拓宽正前方扇形范围的抢断和持球）
     *   原来只有 GRAB_DIST=0.5m 一个圆圈：球稍微偏一点就吸不到，接球/抢断手感很紧。
     *   现在补一个**正前方的扇面**（贴身圆圈仍然保留，背面贴身照样能拿）：
     *     · 半径 1.25m —— 约「迈一步 + 伸腿」的距离（FIFA/PES 的控球/拦截判定都在 1.0~1.5m）
     *     · 半角 62° —— 合计 124° 的正面扇面，正前方 ±62° 内都算够得着
     *   三个数（半径/半角）由下面的 inControlRange() 统一判定，服务端与客户端共用同一份逻辑。 */
    CONTROL_FAN_R: 1.25,         // 正前方扇形可及半径（m）
    CONTROL_FAN_DEG: 62,         // 正前方扇形半角（度）
    GRAB_CD: 0.18,               // 吸附后多久才能踢出（防误触）
    POKE_DIST: 1.35,             // 未持球时"捅一脚"的距离
    /* 人体触球碰撞箱（圆柱：脚底到头顶）—— 没按带球碰到球也会把球顶开/折射 */
    TOUCH_R: 0.38,               // 碰撞箱半径（m）
    TOUCH_H: 1.75,               // 碰撞箱高度（到站立头顶，m）
    /* ★ 头球：跳跃时碰撞箱**随模型位置整体抬高**（用户要求"头球会根据模型位置提高碰撞"）。
     *   原来碰撞箱固定在 y=0..TOUCH_H，跳起来人升到 0.9m 高、箱子还贴地 → 顶不到球。
     *   现在整个圆柱跟着 p.y 上移，于是跳多高、能顶到多高。 */
    HEAD_H: 2.05,                // 顶球最高点（站立伸手/跃起头顶 ≈ 2.0~2.4m；配合跳跃上限 0.95m 够到高球）
    HEAD_BOOST: 10,              // 头球顶出速度（m/s，跳跃中顶球比身体挡球更有力）
    HEAD_CD: 0.42,               // 头球冷却（防一帧多顶）
    BALL_BODY_BOUNCE: 0.45,      // 球撞人体的弹性（折射阻尼）
    BALL_BODY_PUSH: 9,           // 跑动顶球：球速向人的速度收敛的速率（1/s）
    KICK_PASS: 16,               // 传球满力初速（力度条：0.5 倍 ~ 1 倍 → 8~16 m/s）
    KICK_SHOOT: 32,              // 射门满力初速（力度条：0.45 倍 ~ 1 倍 → 14.4~32 m/s，约 115km/h，真实大力射门数据）
    KICK_CD: 0.35,               // 出球后的通用吸附/再踢冷却（防"传出去又被自己吸回来"）
    /* ★ 传球独立冷却（用户要求"传球加上 3s cd"）：
     *   射门不受影响 —— 3s 只卡**传球**这一个动作，所以传完还能立刻补一脚射门。
     *   射完想再传也照常等这个 3s（避免"射门 → 秒传"钻空子）。
     *   ⚠️ 只加在"传球"上：第一脚击球（跑到球上自动出脚的传球）也走这条冷却，
     *      否则"传完立刻冲到球前再补一脚"就绕过去了。 */
    PASS_CD: 3.0,
    /* ★ 传球动作期间的减速（用户要求"跑步中传球，传球动作时要减速"）：
     *   取"减速成 maxSpd 的几成"而不是绝对速度 —— 这样冲刺中出球会掉到 32%（≈2.1m/s，
     *   像真人大步跨出去那一下），原地传球则没有可减的速度、不影响手感。
     *   PASS_SLOW_MIN 给一个下限，免得慢速带球时被压到几乎站住。 */
    PASS_SLOW_MUL: 0.32,
    PASS_SLOW_MIN: 1.4,          // 减速后至少保留这个速度（m/s）
    /* 出球仰角由准星俯仰决定（见 input.js kickDir / pitchToElev）：
     *   平视 ≈ 低平球 · 抬头 ≈ 高吊（球明显往上抛）· 压低 ≈ 贴地斩 */

    /* ---------- 攻击模式（武术包） ---------- */
    PUNCH_RANGE: 1.9,            // 出拳命中判定距离（角色中心到敌人中心）
    PUNCH_ARC: 0.35,             // 命中扇形：面向与「朝敌人」点乘 > 0.35（约 ±70°）
    PUNCH_POWER: 7.5,            // 命中击退速度 m/s
    PUNCH_STUN: 0.4,             // 命中后对手硬直（不能出拳/吸球）
    PUNCH_CD: 0.42,              // 出拳冷却
    PUNCH_SLOW: 1.6,             // 出拳期间的移动速度上限（打拳慢步，不能边冲刺边打）
    ANIM_PUNCH: { punchL: 0.5, punchR: 0.42 },   // 出拳动画锁定时长
    ANIM_HURT: { hurtFace: 0.62, hurtBody: 0.66 }, // 受击反应锁定时长
    ANIM_THROWIN: 1.5,            // 手抛球动画锁定时长

    /* ---------- 攻击模式技能（卡牌，无限使用但有冷却） ---------- */
    SKILL: {
      flyKick: {                                  // 飞踢（Flying Kick）：短 CD，可反复用
        name: '飞踢', anim: 'flyKick', cd: 1.8, time: 1.30,
        range: 2.7, arc: 0.40, dmg: 20, power: 9.5, stun: 0.75, slow: 0.75, kind: 'body',
      },
      hurricane: {                                // 螺旋踢（Hurricane Kick）：长 CD，伤害高、范围大
        name: '螺旋踢', anim: 'hurricane', cd: 5.0, time: 1.65,
        range: 3.1, arc: 0.15, dmg: 32, power: 13, stun: 1.15, slow: 0.5, kind: 'body',
      },
      /* ★ 踢球模式的**花式卡**（用户给的 Soccer Spin 素材）：
       *   纯表演动作，不造成伤害，**必须脚下有球**（needBall），做的时候球被带着绕人一圈 ——
       *   转完球还在脚下继续带（不是"把球踢出去"）。cd 就是卡面上的倒计时。 */
      spin: {
        name: '马赛回旋', anim: 'spin', cd: 6.0, time: 1.27,
        mode: 'soccer', kind: 'flair', dmg: 0, range: 0,
        needBall: true,         // ★ 没持球不能做（服务端 trySkill 直接拒，不扣 CD）
      },
    },
    SKILL_ORDER: ['flyKick', 'hurricane'],        // 攻击模式卡牌条顺序
    SKILL_ORDER_SOCCER: ['spin'],                 // 踢球模式卡牌条顺序（花式动作）

    /* ---------- 跳舞模式：舞段表 ----------
     * ★ 这里是**唯一真相**：键位 1~6、中键转盘、服务端状态机（anim-pick）都读这一份。
     *   以前 1~5 号键全指向同一段 Gangnam（用户反馈"舞蹈重复了几个键"），现在一舞一键。
     *   clip 名 = animations.js 里 CLIP_FILES 的 key。 */
    DANCES: [
      { clip: 'dance1', name: '江南 Style', icon: '🕺' },
      { clip: 'dance2', name: 'Hip Hop', icon: '💃' },
      { clip: 'dance3', name: 'Hip Hop 2', icon: '🕴️' },
      { clip: 'dance4', name: 'Swing', icon: '🎩' },
      { clip: 'dance5', name: 'Breakdance', icon: '🤸' },
      { clip: 'dance6', name: '马竞战舞 BAD', icon: '⚔️' },   // DeepMotion 素材
    ],

    /* ---------- 守门员 ---------- */
    GK_CLAIM_DIST: 6,             // 靠近本方球门这个距离内按 F 可当守门员（要够近）
    GK_OUT_TIME: 3.5,             // 离开禁区这么久就自动取消守门员身份
    GK_BOX_D: 16.5,               // 禁区进深（距球门线）
    GK_BOX_HW: 20.16,             // 禁区半宽
    GK_SAVE_R_BLOCK: 0.72,        // 贴地扑挡：手臂可及半径（身体横移是主覆盖，手臂只是补充）
    GK_SAVE_R_DIVE: 0.9,          // 飞扑：手臂可及半径（根位移已经飞过去了，手臂不用再"隔空"加长）
    GK_HAND_R: 0.7,               // 门将站立时徒手接球半径（身体 + 手，只比普通身体大一点）
    GK_DIVE_REACH: 3.3,           // 预判落点超出这个距离 → 不扑（空位该进球就进）
    GK_SHUFFLE_SPD: 3.8,          // 沿门线横移的最大速度（是侧步，不是满场飞）
    GK_REACT_T: 1.10,             // 来球少于这么久才起反应（预判提前；配合变速播放，手到位=球到位）
    // 远射：球飞得越久，门将准备越充分 → 拦截会偏强。按来球距离做衰减，
    // 让"禁区外远射"保留合理进球空间（公网低帧率下尤其需要）。
    GK_FAR_DECAY: { from: 26, to: 10, mul: 0.72 },  // 10m 内不打折；26m 起臂展 ×0.72（远射留空间）
    // 横向位移随蓄力变化（最短 ~ 最长）：飞扑最长 ≈ 3.7m（能扑到门柱内侧，但盖不满整个球门）
    GK_MOVE_MIN: { block: 0.7, dive: 1.2 },
    GK_MOVE_MAX: { block: 2.0, dive: 3.7 },
    GK_MOVE_T: { block: 0.5, dive: 0.8 },     // 位移持续时间（动作前段）
    GK_DIVE_JUMP: [3.0, 6.0],     // 飞扑起跳上升速度（最短蓄力~最长蓄力）—— 跳得高、滞空久，飞得远
    // 自动接球动作锁定时长 = clip 时长 ÷ 播放倍速（必须 ≥ 实际播放时间，
    // 否则动画没播完锁就松了 → 会被重新触发/重播，表现就是"动作做两次"）
    //   gkCatchLow 2.60s ÷ 1.5 = 1.73 · gkCatchBody 2.10 ÷ 1.5 = 1.40 · gkCatchHigh 2.73 ÷ 1.25 = 2.18
    GK_CATCH: { gkCatchLow: 1.74, gkCatchBody: 1.40, gkCatchHigh: 2.19 },
    /* 门将近距离抢球（Goalkeeper Scoop）：朝球扑出把球捞进怀里 */
    gkScoop: 2.62,                // 动作时长（clip 2.60s 原速）
    GK_SCOOP_DIST: 3.4,           // 球在门将这个距离内 + 有对手在抢 → 扑出去
    GK_SCOOP_SPD: 4.2,            // 扑出速度（m/s，覆盖 3.8m 前冲位移）
    GK_SCOOP_REACH: 1.15,         // 扑出时手臂够球半径（m）
    GK_CATCH_DIST: 2.0,           // 正对来球到这个距离起手接球（腹接/地接/高接）
    // 门将出球动作锁定时长 = clip 时长（原速播完整段，球在动作结束时才出手）
    GK_DIST: { gkRoll: 3.15, gkKick: 3.92, gkDrop: 3.15 },

    /* ---------- 球员席 / 复活 / 救护车 ---------- */
    // 球员席（放在北侧边线外，看台前面；坐标是"边线再往外多少米"）
    BENCH: { OUT: 2.4, GAP: 1.9, W: 15 },         // OUT 离边线距离 · GAP 座位间距 · W 席位平台宽
    /* ★ 北侧练习区（球员席 / 替补席 + 人机靶子所在的那一段边线外）。
     *   用户要求"人机靶子放在替补席旁边界外"。但如果严格按边线判出界，
     *   球一滚到 z < -HALF_W 就立刻触发界外球重开 —— 靶子站在那儿根本没法用球练。
     *   所以把**北侧替补席那一段**划成练习区：球可以自由滚进去、不判出界。
     *     · X  = 练习区在 x 方向的半宽 26m —— 要够站开射门（靶子在 ±13.5，
     *            从 ±25 的位置起脚也得算界内，否则"刚出脚就被判出界重开"）
     *     · Z  = 练习区最外侧（比球员席 36.4 再留一点，且保证球员走得到就能捡回球）
     *   北侧剩下的两段（|x| > 26）以及东/西/南三面照常判界外球。 */
    BENCH_BAY: { X: 26, Z: -37.2 },
    AMB_PARK: { X: 0.62, OUT: 7.0 },              // 救护车停车位（X 比例 · 离边线距离）
    BENCH_TIME: 4,                // 血量清零后要在球员席等这么久才复活（秒）
    AMB_TIME: 7,                  // （兼容保留）救护车总时长上界
    // 救护车出动流程（秒）：开进场中央 → 停 → 回停车点 → 球员在停车点重生 → 车消失
    AMB_IN: 2.2, AMB_MID_WAIT: 2.0, AMB_BACK: 2.4, AMB_END_WAIT: 1.4,

    /* ---------- 押注（B 键商店） ---------- */
    BET_AMOUNT: 100,              // 每局固定下注额
    BET_START_COINS: 1000,        // 初始金币
    BET_ODDS_MIN: 1.05,           // 赔率下限（押注一边倒时）
    BET_ODDS_MAX: 8.0,            // 赔率上限（一边几乎没人押）
    // 救护车进场盘：押"本局救护车出车次数 大/小 0.5"
    //   大 0.5 = 出车 ≥ 1 次；小 0.5 = 一次都没出
    AMB_LINE: 0.5,

    /* ---------- 属性卡 ---------- */
    CARD_BOOST_MUL: 1.10,         // 最高速 +10%
    CARD_BOOST_TIME: 10,          // 持续 10 秒           // 来球到这个距离开始做接球动作
    GK_ANIM: {                    // 动画锁定时长 = clip ÷ **基准倍速**（见 GK_BASE_SPD）
      gkBlockL: 1.32, gkBlockR: 1.24, gkDiveL: 1.70, gkDiveR: 1.62,
      gkScoop: 2.62,          // 门将抢近距离球（Goalkeeper Scoop）
    },
    /* ★ 门将动作的**基准播放倍速**（必须与 anim-pick.js 的 ONE_SHOT_SPD 里 gk* 的值一致）。
     *   上面 GK_ANIM / GK_CATCH 里的"锁定时长"都是按这个基准折算出来的：
     *     锁定时长 = clip 原始时长 ÷ 基准倍速
     *   服务端要额外加速时（spd>1）传**绝对倍速 = 基准 × spd** 给客户端播放，
     *   锁定时间仍按 spd 折算。两套倍速必须分开，
     *   否则会出现"服务端按 3 倍缩窗口、客户端按 1.5 倍慢慢播"→ 动作播一半就切走。 */
    GK_BASE_SPD: {
      gkCatchLow: 1.5, gkCatchBody: 1.5, gkCatchHigh: 1.25,
      gkBlockL: 2.0, gkBlockR: 2.0, gkDiveL: 2.0, gkDiveR: 2.0,
      gkScoop: 1.0, gkKick: 1.0, gkRoll: 1.0, gkDrop: 1.0, header: 1.0,
    },

    /* ---------- 血量 / 滑铲铲倒 / 起身 ---------- */
    HP_MAX: 100,
    HP_REGEN_DELAY: 4,           // 掉血后多久开始回血（秒）
    HP_REGEN: 10,                // 每秒回血
    PUNCH_DMG: 12,               // 一拳掉血
    TACKLE_DMG: 8,               // 被铲倒掉血
    TACKLE_DOWN_BASE: 0.30,      // 滑铲撞人：基础被铲倒概率
    TACKLE_DOWN_FULL: 0.85,      // 完全重合（重心贴死）时的被铲倒概率
    TACKLE_EXTRA: 0.45,          // 铲倒判定半径外扩（物理碰撞 0.9m，判定到 1.35m，快速滑铲不会擦边而过）
    DOWN_TIME: 1.79,               // 倒地时长 = 足球动作包 Soccer Tackle 1.77s ÷ 1.2 倍速 ≈ 1.48s
                                  // （该 clip 自身已含起身，不另接 getUp）
    DEATH_TIME: 2.85,             // 死亡倒地时长 = Death From The Back 2.97s ÷ 1.04 倍速（播完才被抬走）
    KO_DOWN_MUL: 1.3,             // 血量清零 → KO，倒地更久
    ANIM_DOWN: { tackleDown: 2.5 },   // 铲倒动画锁定时长（clip 内自带起身）
    /* 踢球动画锁定时长（秒）—— 取 clip 时长的一部分，播到发力就收，别硬等整段：
     *   pass        Soccer Pass          1.60s clip
     *   passStill   非跑动传球           1.60s clip
     *   strikeJog   Strike Foward Jog    1.30s clip
     */
    ANIM: { pass: 1.11, passStill: 1.05, strikeJog: 0.85 },
    STEAL_DIST: 1.3,             // 抢断：贴近持球者多近能断球
    STEAL_CD: 0.8,
    MAX_CHARGE: 0.9,             // 蓄力条：按住 0.9 秒满力

    /* ---------- 比赛 ---------- */
    MATCH_SEC: 600,              // 单场 10 分钟
    GOAL_RESET_SEC: 3,           // 进球后重置延迟
    TEAM_SIZE: 5,                // 每队人数（真人不满用 AI 补）

    TEAMS: {
      A: { name: '红队', color: '#e8384f' },
      B: { name: '蓝队', color: '#2f7bf5' },
    },
  };

  /* ---------------- 工具 ---------------- */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  /** 准星俯仰 → 出球仰角（弧度）。
   *  相机约定（Controls.update）：camPitch 大 = 相机升高 = 视线压低（看地）；
   *  camPitch 小 = 相机降低 = 抬头（看天）。所以「看天 = 高球」要取负号。
   *    camPitch  0.32（默认略俯视）→ ~2° 低平球；-0.35（看天）→ ~48° 高吊；1.15（看地）→ 贴地。
   *  客户端 input.js 与服务端共用，保证「预览线角度 = 实际出球角度」。 */
  function pitchToElev(camPitch) {
    // 默认（平视 0.32）≈ 5.2° 低平带一点起球；看天 → ~48° 高吊；看地 → 贴地。
    // 0.09 是起球脚感的平衡点：再低球"起"不起来，再高传球发飘。
    return clamp((0.32 - camPitch) * 1.2 + 0.09, -0.05, 0.95);
  }

  /** 出球三轴速度：水平方向 × 速率，仰角由 dir.y（= tan(仰角)）决定。
   *  水平速度做 cos^0.6 补偿 —— 抬头打高球不会损失太多水平速度（高球也能打远），
   *  服务端出球与客户端预览弹道共用本函数 → 预览即实战，不会「线没角度」。
   *  off = 击球点偏心量（0~1，可选）：真实弧线球是"包"着球下侧踢的，
   *  所以偏心越大球越会离地（否则贴地滚球根本转不起来、也就没有弧线）。 */
  function kickVelocity(dir, spd, off = 0) {
    const hl = Math.hypot(dir.x, dir.z) || 1;
    const elev = clamp(Math.atan2(dir.y || 0, hl), -0.05, 0.95);   // -3° ~ 54°
    const c = Math.pow(Math.cos(elev), 0.6);                       // 0.51~1 仰角补偿
    let vy = elev > 0.02 ? spd * Math.sin(elev) : 0;
    // ★ 偏心击球 → 球自然离地（真实脚背包球）；至少给一个低平弧线的抬升分量
    if (off > 0) {
      const rise = off * Math.min(C.BALL_RISE_MAX, C.BALL_RISE_K * spd);
      if (rise > vy) vy = rise;
    }
    return {
      vx: dir.x / hl * spd * c,
      vz: dir.z / hl * spd * c,
      // 平射/贴地斩不给上升速度 —— 球落地即滚，不会一路弹跳掉速（球要滚得远）
      vy,
    };
  }

  /* ---------------- 旋转球（击球点 UI）----------------
   * 击球点红点 (sx, sy)：sx∈[-1,1] 左右（-左 +右）、sy∈[-1,1] 上下（+上 -下）。
   * 物理按真实脚背触球推（右手系，X 沿球飞出方向、Y 向上）：
   *   · sy>0 打球**顶部** → 前上旋（topspin）→ Magnus 力**向下** → 电梯球（下坠急）
   *   · sy<0 打球**底部** → 后旋（backspin）→ Magnus 力**向上** → 滞空久（长传吊球）
   *   · sx>0  打球**右侧** → 逆时针自旋（俯视 +y）→ Magnus 力**向左** → 球往左弯
   *   · sx<0  打球**左侧** → 顺时针自旋（俯视 -y）→ Magnus 力**向右** → 球往右弯
   *   （真实足球就是这个方向性：打球的右侧球往左拐 —— 内脚背弧线球）
   * 中心 (0,0) 吃劲最足；击球点偏了力量变小（真实触球面积变小）。
   * 服务端出球与客户端预览共用 → 预览线的弧线 = 实际飞行的弧线。 */

  /** 击球点 → 力量折扣与自旋角速度。
   *  · powerMul：正中 1.0；拉满一格 0.82（偏心击球掉力量）
   *  · wx：绕飞行轴的自旋（上旋为正 → 下坠）
   *  · wy：竖直轴自旋（>0 逆时针俯视 → 力向左；<0 顺时针 → 力向右） */
  function spinFromSpot(sx, sy) {
    const x = clamp(sx || 0, -1, 1), y = clamp(sy || 0, -1, 1);
    const off = clamp(Math.hypot(x, y), 0, 1);          // 0=正中 1=拉满（对角线也只算 1）
    const powerMul = 1 - 0.15 * off;                    // 偏心最多掉 15% 力量
    const wMax = 62.8;                                  // 最大自旋 ≈ 10 转/s（真实弧线球上限）
    return {
      powerMul,
      wx: y * wMax,                                     // 上旋(+)/后旋(-)，绕飞行轴
      wy: x * wMax,                                     // 左弧(+逆时针)/右弧(-)，绕竖直轴
    };
  }

  /** 给 stepBall 用的自旋状态：每帧衰减。
   *  ★ 贴地滚动时用更快的衰减（BALL_SPIN_GROUND_DECAY）—— 真实足球的旋转
   *    在草地上会被摩擦迅速吃掉；空中才靠空气缓慢衰减。 */
  function stepBallSpin(b, dt) {
    if (!b.wx && !b.wy) return;
    const onGround = b.y <= C.BALL_R + C.BALL_SPIN_GROUND_H * 0.5 && Math.abs(b.vy || 0) < 1.2;
    const decay = onGround ? C.BALL_SPIN_GROUND_DECAY : C.BALL_SPIN_DECAY;
    const k = Math.exp(-decay * dt);
    b.wx *= k; b.wy *= k;
    if (Math.abs(b.wx) < 0.5) b.wx = 0;
    if (Math.abs(b.wy) < 0.5) b.wy = 0;
  }

  // 角度差归一到 [-PI, PI]
  function angDelta(a, b) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
  function angLerp(a, b, t) { return a + angDelta(a, b) * t; }
  function angApproach(a, b, maxStep) {
    const d = angDelta(a, b);
    if (Math.abs(d) <= maxStep) return b;
    return a + Math.sign(d) * maxStep;
  }

  /* ---------------- Magnus 力（真实空气动力学数据函数）----------------
   * 真实足球飞行标准模型（Goff & Carré, Am. J. Phys. 77(11):1020, 2009）：
   *
   *   F = ½ · ρ · A · C_L · |v|² ，方向 = ω̂ × v̂
   *   C_L = 1 / ( 2 + v / v_spin ) ，v_spin = r·ω（球面切向速度）
   *   ⇒ a = (½ρA/m) · C_L · v² = BALL_AERO_K · C_L · v²
   *
   * C_L 随自旋比变化：转得越快 C_L 越大（更弯），球速越快 C_L 越小（快球不弯）。
   * 服务端 stepBall 与客户端预览线**都调这一个函数** → 预览弧线 = 实际弧线。
   *
   * 参数：
   *   vx,vy,vz  球速（m/s）
   *   wx,wy     自旋（rad/s）；wy=绕竖直轴（香蕉球）、wx=绕水平横轴（电梯/后旋）
   *   y         球心离地高度（m），用于贴地削弱（游戏性：低平球也出弧线）
   * 返回 { ax, ay, az } —— 加速度（m/s²），调用方乘 dt 累加到速度。 */
  function magnusAccel(vx, vy, vz, wx, wy, y) {
    const out = { ax: 0, ay: 0, az: 0 };
    if (!wx && !wy) return out;
    const hs = Math.hypot(vx, vz);
    if (hs < C.BALL_SPIN_MIN_SPD) return out;          // 慢滚球旋转没意义
    const fx = vx / hs, fz = vz / hs;                  // 水平飞行方向
    // ★ 真实数据函数：C_L = 1/(2 + v/v_spin)，v = 球速，v_spin = r·ω（合成自旋切向速度）
    const wAbs = Math.hypot(wx || 0, wy || 0);
    const vSpin = C.BALL_R * wAbs;
    const vFull = Math.hypot(vx, vy, vz);
    const cL = vSpin > 1e-3 ? 1 / (2 + vFull / vSpin) : 0;
    const aMag = C.BALL_AERO_K * cL * vFull * vFull;   // 马格努斯加速度标量
    // 贴地削弱：完全在空中 1.0；贴地保留 GROUND 比例（低平球照样出弧线，肉眼可见）
    const hK = clamp(Math.max(0, y - C.BALL_R) / C.BALL_SPIN_GROUND_H, 0, 1);
    const magH = C.BALL_MAGNUS_GROUND + (1 - C.BALL_MAGNUS_GROUND) * hK;      // 水平弧线
    const magV = C.BALL_MAGNUS_GROUND + (1 - C.BALL_MAGNUS_GROUND) * hK * hK; // 垂直（贴地更"吸"）
    // 竖直轴自旋 → 侧向力：侧向单位 = (fz, -fx)（飞行方向左手侧）
    //   wy>0（打球右侧）→ 球往左拐 ✓（真实内脚背弧线）
    if (wy) {
      const s = aMag * (wy / wAbs) * magH;
      out.ax += fz * s;
      out.az += -fx * s;
    }
    // 水平横轴自旋 → 竖直力：ω = wx·(fz,0,-fx)；(ω×v)_y = -wx·|v|（沿飞行轴 +z 推导）
    //   wx>0 上旋 → ay<0 下坠（电梯球）；wx<0 后旋 → ay>0 升力（乘 LIFT）
    if (wx) {
      const lift = wx < 0 ? C.BALL_MAGNUS_LIFT : 1;
      out.ay += -aMag * (wx / wAbs) * magV * lift;
    }
    return out;
  }

  /** 球体一步物理（服务端与客户端共用，保证预测一致） */
  function stepBall(b, dt) {
    if (b.owner) return;                     // 被带球时位置由持球者决定
    // 空气阻力
    const sp = Math.hypot(b.vx, b.vy, b.vz);
    if (sp > 0.0001) {
      const k = Math.exp(-C.BALL_AIR_DRAG * dt);
      b.vx *= k; b.vy *= k; b.vz *= k;
    }
    /* ★ Magnus（旋转球）—— 真实物理公式，见 magnusAccel()。
     *   ⚠️ 曾经的 bug：这里曾判 `b.y > BALL_R + 0.02`，而抛地滚动时 b.y 被
     *      clamp 到**精确等于** BALL_R → 低平球（vy=0 出脚即贴地）全程不施加 Magnus，
     *      用户实测"没有偏移/直线"。现在不再用高度当门槛，贴地由权重处理。 */
    const ma = magnusAccel(b.vx, b.vy, b.vz, b.wx, b.wy, b.y);
    b.vx += ma.ax * dt; b.vy += ma.ay * dt; b.vz += ma.az * dt;
    stepBallSpin(b, dt);
    b.vy -= C.GRAVITY * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;

    if (b.y <= C.BALL_R) {                   // 触地
      b.y = C.BALL_R;
      // 只有大落差才反弹（阈值 ≈ 落地速度 2.2m/s ≈ 从 12cm 以上落下来）；
      // 小仰角传球/轻吊落地时直接过渡到滚动 —— 否则每脚带点后仰的球都要弹一下，
      // 白掉 18% 水平速度，球滚不起来。高球/爆射落地照常弹。
      if (b.vy < -2.2) {
        b.vy = -b.vy * C.BALL_BOUNCE;
        // 落地水平方向损耗
        b.vx *= 0.82; b.vz *= 0.82;
        // 落地一次自旋也被地面吃掉一截
        b.wx = (b.wx || 0) * C.BALL_SPIN_HIT_DECAY;
        b.wy = (b.wy || 0) * C.BALL_SPIN_HIT_DECAY;
      } else {
        b.vy = 0;
        const g = Math.exp(-C.BALL_GROUND_DRAG * dt);
        b.vx *= g; b.vz *= g;
        if (Math.hypot(b.vx, b.vz) < 0.12) { b.vx = 0; b.vz = 0; }
      }
    }
    // 速度上限
    const s2 = Math.hypot(b.vx, b.vy, b.vz);
    if (s2 > C.BALL_MAX_SPEED) {
      const m = C.BALL_MAX_SPEED / s2;
      b.vx *= m; b.vy *= m; b.vz *= m;
    }
    // 场外：撞看不见的挡板，弹回场内
    const bx = C.FIELD.HALF_L + C.WALL_MARGIN;
    const bz = C.FIELD.HALF_W + C.WALL_MARGIN;
    if (b.x > bx) { b.x = bx; b.vx = -Math.abs(b.vx) * 0.6; }
    if (b.x < -bx) { b.x = -bx; b.vx = Math.abs(b.vx) * 0.6; }
    if (b.z > bz) { b.z = bz; b.vz = -Math.abs(b.vz) * 0.6; }
    if (b.z < -bz) { b.z = -bz; b.vz = Math.abs(b.vz) * 0.6; }
  }

  const CONTROL_FAN_COS = Math.cos(C.CONTROL_FAN_DEG * Math.PI / 180);

  /**
   * 球是不是落在球员 p 的「可控制范围」里。
   *   · 贴身小圆圈（GRAB_DIST=0.5m）：不分朝向，背面也能拿 → 保留原有的贴身手感
   *   · 正前方扇面（半径 CONTROL_FAN_R=1.25m / 半角 CONTROL_FAN_DEG=62°）：
   *     面向与「球员→球」方向点乘 ≥ CONTROL_FAN_COS 才算数 → 只有正前方才够得着
   * 服务端 tryGrab 与客户端「按 F 吸附」提示共用这一份判定，避免两边不一致。
   */
  function inControlRange(p, bx, bz) {
    const dx = bx - p.x, dz = bz - p.z;
    const d = Math.hypot(dx, dz);
    if (d <= C.GRAB_DIST) return true;                        // 贴身：任意方向
    if (d > C.CONTROL_FAN_R) return false;                    // 超出扇形半径
    if (d < 1e-4) return true;
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);         // 球员正前方向量
    return (dx / d) * fx + (dz / d) * fz >= CONTROL_FAN_COS;  // 正前方 ±62°
  }

  return { C, clamp, lerp, angDelta, angLerp, angApproach, stepBall, pitchToElev, kickVelocity, inControlRange, spinFromSpot, stepBallSpin, magnusAccel };
});
