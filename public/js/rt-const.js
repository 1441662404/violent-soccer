/* 骨骼重定向常数（由 calc-off3.mjs 离线生成）。
 * D[i] = Wm_bind^-1 × Q[i] × Wv_bind
 *   运行时逐帧： worldM 递归 = parentWorldM × localM   （用 Mixamo 轨道值推出 Mixamo 世界朝向）
 *              worldV      = worldM × D[i]
 *              localV      = worldV_parent^-1 × worldV
 *   Q[i] = 把 Valve 绑定姿势下的骨骼指向 摆到 Mixamo 绑定姿势下的骨骼指向。
 *   两套骨架绑定姿势不同：Mixamo = T-pose（上臂水平），ValveBiped = A-pose（上臂垂 ~46°）。
 *   不补 Q 就会给本已垂下的手臂再多转 46°，手直接甩进躯干里（实测 bug）。
 *   注意：Hips 不补 Q（它的指向差来自脊柱侧倾，补了整个人会后仰）。
 *
 * RT_HIPS_Z / RT_HRATIO：根骨骼位置。Valve Hips 的父级带 -90°X，其局部 +Z 就是世界"向上"，
 *   所以高度写进 local.z。绑定时该值为 RT_HIPS_Z；动画里按腿长比 RT_HRATIO 等比缩放。 */
export const RT_PARENT = {
  Hips: null,
  Spine: 'Hips',
  Spine1: 'Spine',
  Spine2: 'Spine1',
  Neck: 'Spine2',
  Head: 'Neck',
  LeftShoulder: 'Spine2',
  LeftArm: 'LeftShoulder',
  LeftForeArm: 'LeftArm',
  LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine2',
  RightArm: 'RightShoulder',
  RightForeArm: 'RightArm',
  RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips',
  LeftLeg: 'LeftUpLeg',
  LeftFoot: 'LeftLeg',
  LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips',
  RightLeg: 'RightUpLeg',
  RightFoot: 'RightLeg',
  RightToeBase: 'RightFoot',
};
export const RT_D = {
  Hips: [0, 0.000002, -0.000044, 1],
  Spine: [0.500004, 0.499998, 0.5, 0.499999],
  Spine1: [0.500006, 0.499996, 0.500002, 0.499996],
  Spine2: [0.452048, 0.543737, 0.452025, 0.543762],
  Neck: [-0.469543, -0.528707, 0.469533, 0.528713],
  Head: [-0.434012, -0.55824, 0.433999, 0.558253],
  LeftShoulder: [0.454712, 0.534896, -0.456511, -0.546553],
  LeftArm: [-0.707015, -0.707024, 0.011084, 0.011084],
  LeftForeArm: [-0.694455, -0.694455, -0.133163, -0.133161],
  LeftHand: [-0.638932, -0.523262, 0.379962, 0.416643],
  RightShoulder: [0.458186, 0.5451, -0.453934, -0.535608],
  RightArm: [-0.004794, -0.004794, -0.70709, -0.707091],
  RightForeArm: [-0.150443, -0.150443, -0.690916, -0.690919],
  RightHand: [-0.362578, -0.398959, 0.649331, 0.536412],
  LeftUpLeg: [0.500016, 0.500015, -0.499985, -0.499984],
  LeftLeg: [0.500971, 0.500969, -0.49903, -0.499028],
  LeftFoot: [-0.514927, -0.432643, 0.576767, 0.463691],
  LeftToeBase: [-0.608126, -0.302627, 0.640487, 0.358296],
  RightUpLeg: [0.500003, 0.500006, -0.499994, -0.499997],
  RightLeg: [0.499048, 0.499049, -0.500949, -0.50095],
  RightFoot: [-0.568764, -0.457252, 0.523758, 0.439438],
  RightToeBase: [-0.658351, -0.370275, 0.588359, 0.288623],
};
export const RT_BINDM = {
  Hips: [0, -0.000002, 0.000044, 1],
  Spine: [-0.005094, 0, -0.000044, 0.999987],
  Spine1: [-0.042126, 0, 0, 0.999112],
  Spine2: [-0.104593, 0, 0, 0.994515],
  Neck: [0.151432, 0.000002, 0, 0.988468],
  Head: [0, 0, 0, 1],
  LeftShoulder: [0.547094, 0.591411, -0.470841, 0.359486],
  LeftArm: [-0.044919, -0.00324, 0.071861, 0.996397],
  LeftForeArm: [0, 0, 0, 1],
  LeftHand: [0, 0, 0, 1],
  RightShoulder: [-0.547103, 0.591403, -0.470824, -0.359507],
  RightArm: [-0.044905, 0.003238, -0.071839, 0.9964],
  RightForeArm: [0, 0, 0, 1],
  RightHand: [0, 0, 0, 1],
  LeftUpLeg: [0.000001, -0.00663, 0.999978, 0.000122],
  LeftLeg: [-0.01917, -0.000005, 0.000161, 0.999816],
  LeftFoot: [0.318591, -0.002047, -0.007323, 0.947862],
  LeftToeBase: [0.460052, 0.001634, -0.007004, 0.887863],
  RightUpLeg: [0.000001, -0.006655, 0.999978, 0.000122],
  RightLeg: [-0.01912, -0.000005, 0.000161, 0.999817],
  RightFoot: [0.318567, -0.002048, -0.007322, 0.94787],
  RightToeBase: [0.460095, 0.011232, 0.013956, 0.887689],
};
export const RT_ROOTPARENT = [-0.707107, 0, 0, 0.707107];
export const RT_HIPS_Z = 35.4255;
export const RT_HIPS_XY = [-0.0000, -0.5336];
export const RT_HRATIO = 0.367604;
export const RT_ORDER = ["Hips","Spine","Spine1","Spine2","Neck","Head","LeftShoulder","LeftArm","LeftForeArm","LeftHand","RightShoulder","RightArm","RightForeArm","RightHand","LeftUpLeg","LeftLeg","LeftFoot","LeftToeBase","RightUpLeg","RightLeg","RightFoot","RightToeBase"];
