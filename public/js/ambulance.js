/**
 * 救护车：有球员从球员席复活时开到场边停一会儿。
 *
 * 状态由服务端广播（`amb: { on, t, x, z }`），这里只负责"把它开出来/开回去"的表演，
 * 停靠位置直接用服务端给的坐标 —— 这样新进房间 / 刷新页面的人也能看到同一辆车。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class Ambulance {
  /**
   * @param scene  THREE.Scene
   * @param field  { HALF_L, HALF_W }
   * @param park   { X, OUT } 停车位（X 比例 · 离边线距离）
   */
  constructor(scene, field, park) {
    this.scene = scene;
    this.park = park;
    this.on = false;              // 服务端状态：是否在场边
    this.t = 0;                   // 剩余停留
    this.x = 0;                   // 目标停靠点
    this.z = 0;
    this.cx = this.homeX;         // 当前位置（平滑跟踪）
    this.cz = this.homeZ;
    this.yaw = 0;
    this.loaded = false;

    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    this.phase = 'off';
    // 停车点（球员在这里重生）
    this.parkX = field.HALF_L * park.X;
    this.parkZ = -(field.HALF_W + park.OUT);
    // 场外起点（远处 16m，斜着开进来）
    this.homeX = this.parkX - 16;
    this.homeZ = this.parkZ - 9;
    this.cx = this.homeX; this.cz = this.homeZ;
    // 球场中央（停一下，再把病人送回来）
    this.midX = 0;
    this.midZ = -2;

    // 警灯（陪跑演出：红蓝闪）
    this.beacons = [];
    this.beaconT = 0;

    this._load();
  }

  _load() {
    new GLTFLoader().load('models/ambulance.glb', (g) => {
      const o = g.scene;
      o.traverse((m) => {
        if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
      });
      // 统一按"车长 6m"缩放（模型原始单位未知）
      const box = new THREE.Box3().setFromObject(o);
      const size = new THREE.Vector3(); box.getSize(size);
      const k = 6 / Math.max(size.x, size.y, size.z);
      o.scale.setScalar(k);
      const box2 = new THREE.Box3().setFromObject(o);
      const ctr = new THREE.Vector3(); box2.getCenter(ctr);
      o.position.sub(new THREE.Vector3(ctr.x, box2.min.y, ctr.z));   // 底部贴地、原点居中
      // 车头朝向 +X（沿场边开）
      this.group.add(o);

      // 顶灯红蓝闪
      const h = size.y * k;
      for (const [dx, col] of [[-0.45, '#ff3b4e'], [0.45, '#3b7bff']]) {
        const lamp = new THREE.Mesh(
          new THREE.SphereGeometry(0.16, 10, 8),
          new THREE.MeshBasicMaterial({ color: col })
        );
        lamp.position.set(dx, h + 0.06, 0);
        this.group.add(lamp);
        this.beacons.push(lamp);
      }
      this.loaded = true;
    }, undefined, (e) => console.warn('[救护车] 模型加载失败', e));
  }

  /** 服务端状态同步（phase: in → mid → back → end → off） */
  setState(st) {
    if (!st) return;
    this.on = !!st.on;
    this.phase = st.phase || (this.on ? 'in' : 'off');
    this.t = st.t || 0;
    if (st.x !== undefined) { this.parkX = st.x; this.parkZ = st.z; }
    if (!this.on) this.phase = 'off';
  }

  update(dt) {
    const ph = this.phase;

    // 各阶段的目标位置：in 从停车场开向球场中央；mid 停在中央；back/end 回停车点；off 开回停车场
    let gx, gz;
    if (ph === 'in') { gx = this.midX; gz = this.midZ; }
    else if (ph === 'mid') { gx = this.midX; gz = this.midZ; }
    else if (ph === 'back' || ph === 'end') { gx = this.parkX; gz = this.parkZ; }
    else { gx = this.homeX; gz = this.homeZ; }

    // 位置平滑朝目标走（配合服务端每阶段的时长，看起来就是开过去/停下/开回来）
    const k = 1 - Math.exp(-2.6 * dt);
    this.cx += (gx - this.cx) * k;
    this.cz += (gz - this.cz) * k;

    // 可见性：流程进行中一直可见；off 之后要开回停车场，到了才隐藏
    const backHome = Math.hypot(this.cx - this.homeX, this.cz - this.homeZ) < 1.2;
    this.group.visible = (ph !== 'off') || !backHome;
    if (!this.group.visible) return;

    this.group.position.set(this.cx, 0, this.cz);
    // 朝向：始终朝着"要去的地方"（in 朝中央 / back 朝停车点 / off 朝停车场）
    const fx = gx - this.cx, fz = gz - this.cz;
    if (Math.hypot(fx, fz) > 0.4) {
      this.yaw = Math.atan2(fx, fz);
    }
    this.group.rotation.y = this.yaw;

    // 警灯闪烁（停稳时闪得更急）
    this.beaconT += dt;
    const fast = (ph === 'mid' || ph === 'end');
    const flash = this.beaconT % (fast ? 0.34 : 0.62) < (fast ? 0.17 : 0.31);
    if (this.beacons[0]) this.beacons[0].material.color.set(flash ? '#ff5a68' : '#5a1418');
    if (this.beacons[1]) this.beacons[1].material.color.set(flash ? '#1a3468' : '#5aa0ff');

    // 本地倒计时（仅用于显示平滑，真值以服务端为准）
    if (this.t > 0) this.t = Math.max(0, this.t - dt);
  }
}
