/**
 * 空间辅助可视化系统：速度矢量箭头、引力/加速度对数矢量箭头、质心(CoM) 3D 十字标记与 XY 参考网格
 *
 * 严格遵循跨层约定：
 * - 【跨层约定 #2】参考网格必须铺设于 XY 平面（z = 0），低亮度非自发光（线性 RGB <= 0.45）；
 *   进入 'planet-surface' 近地视角时自动整体隐藏，切回太空视角按 VisualOptions 恢复。
 * - 【跨层约定 #3】引力矢量箭头对 body.role === 'planet' 必须改用 body.acceleration，
 *   对 body.role === 'star' 使用 body.force；采用对数长度映射 L = k * ln(1 + mag / F0)
 *   与 蓝→琥珀→红 受力强度色阶（线性 RGB <= 0.95）。
 */

import * as THREE from 'three';
import type { BodyState, Vec3, VisualOptions } from '../types/contracts';
import { computeForceHeatColor, hexToClampedColor } from './colorUtils';

const UP_AXIS = new THREE.Vector3(0, 1, 0);

// 速度矢量对数压缩参数
const VEL_V0 = 0.85;
const VEL_K = 0.42;
const VEL_MAX_LEN = 1.65;

// 引力/加速度矢量对数映射参数：L = FORCE_K * ln(1 + mag / FORCE_F0)
const FORCE_F0 = 0.5;
const FORCE_K = 0.34;
const FORCE_MAX_LEN = 2.1;
const FORCE_HEAT_REF = 36.0;

interface ArrowVisual {
  readonly root: THREE.Group;
  readonly shaft: THREE.Mesh;
  readonly head: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
}

interface BodyArrowPair {
  readonly velocity: ArrowVisual;
  readonly force: ArrowVisual;
}

export class VectorHelpers {
  public readonly group: THREE.Group;

  private readonly velocityGroup: THREE.Group;
  private readonly forceGroup: THREE.Group;
  private readonly comGroup: THREE.Group;
  private readonly gridGroup: THREE.Group;

  private readonly sharedShaftGeo: THREE.CylinderGeometry;
  private readonly sharedHeadGeo: THREE.ConeGeometry;
  private readonly extraGeometries: THREE.BufferGeometry[] = [];
  private readonly extraMaterials: THREE.Material[] = [];

  private readonly arrows = new Map<string, BodyArrowPair>();

  private showVelocity: boolean = false;
  private showForce: boolean = false;
  private showCom: boolean = true;
  private showGrid: boolean = true;
  private surfaceModeHidden: boolean = false;

  // 零每帧 GC 复用的临时对象
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpColor = new THREE.Color();

  constructor(initialOptions: VisualOptions) {
    this.group = new THREE.Group();
    this.group.name = 'VectorAndReferenceHelpers';

    this.velocityGroup = new THREE.Group();
    this.velocityGroup.name = 'VelocityVectors';

    this.forceGroup = new THREE.Group();
    this.forceGroup.name = 'ForceVectors';

    this.comGroup = new THREE.Group();
    this.comGroup.name = 'CenterOfMassMarker';

    this.gridGroup = new THREE.Group();
    this.gridGroup.name = 'XYReferenceGrid';

    this.group.add(
      this.gridGroup,
      this.comGroup,
      this.velocityGroup,
      this.forceGroup
    );

    // 共享单位箭头几何体（沿 +Y 方向，底部位于原点 y=0）
    this.sharedShaftGeo = new THREE.CylinderGeometry(0.0085, 0.0085, 1.0, 10);
    this.sharedShaftGeo.translate(0, 0.5, 0);

    this.sharedHeadGeo = new THREE.ConeGeometry(0.026, 1.0, 12);
    this.sharedHeadGeo.translate(0, 0.5, 0);

    this.buildXYReferenceGrid();
    this.buildCenterOfMassMarker();
    this.setOptions(initialOptions);
  }

  public setOptions(options: VisualOptions): void {
    this.showVelocity = options.showVelocityVectors;
    this.showForce = options.showForceVectors;
    this.showCom = options.showCenterOfMass;
    this.showGrid = options.showReferenceGrid;
    this.applyVisibility();
  }

  public setSurfaceModeHidden(hidden: boolean): void {
    this.surfaceModeHidden = hidden;
    this.applyVisibility();
  }

  public syncBodies(bodies: readonly BodyState[]): void {
    const activeIds = new Set<string>();

    for (const body of bodies) {
      activeIds.add(body.id);
      if (!this.arrows.has(body.id)) {
        const velArrow = this.createArrowVisual(
          hexToClampedColor('#7dd3fc', 0.84)
        );
        const forceArrow = this.createArrowVisual(
          hexToClampedColor('#38bdf8', 0.9)
        );
        this.velocityGroup.add(velArrow.root);
        this.forceGroup.add(forceArrow.root);
        this.arrows.set(body.id, {
          velocity: velArrow,
          force: forceArrow,
        });
      }
    }

    for (const [id, pair] of this.arrows) {
      if (!activeIds.has(id)) {
        this.removeArrowPair(id, pair);
      }
    }
  }

  public update(bodies: readonly BodyState[], centerOfMass: Vec3): void {
    if (this.surfaceModeHidden) return;

    if (this.comGroup.visible) {
      this.comGroup.position.set(
        centerOfMass[0],
        centerOfMass[1],
        centerOfMass[2]
      );
    }

    const needVel = this.velocityGroup.visible;
    const needForce = this.forceGroup.visible;
    if (!needVel && !needForce) return;

    for (const body of bodies) {
      const pair = this.arrows.get(body.id);
      if (!pair) continue;

      const startOffset = Math.max(body.renderRadius * 1.15, 0.025);

      if (needVel) {
        const vx = body.velocity[0];
        const vy = body.velocity[1];
        const vz = body.velocity[2];
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (speed > 1e-6) {
          const length = Math.min(
            VEL_MAX_LEN,
            VEL_K * Math.log(1 + speed / VEL_V0)
          );
          this.tmpDir.set(vx / speed, vy / speed, vz / speed);
          this.orientArrow(
            pair.velocity,
            body.position,
            this.tmpDir,
            startOffset,
            length
          );
          pair.velocity.root.visible = length > 0.015;
        } else {
          pair.velocity.root.visible = false;
        }
      }

      if (needForce) {
        // 【跨层约定 #3】行星测试粒子质量极小导致 force 量级过低，必须改用 acceleration
        const vec = body.role === 'planet' ? body.acceleration : body.force;
        const fx = vec[0];
        const fy = vec[1];
        const fz = vec[2];
        const mag = Math.sqrt(fx * fx + fy * fy + fz * fz);
        if (mag > 1e-9) {
          const logVal = Math.log(1 + mag / FORCE_F0);
          const length = Math.min(FORCE_MAX_LEN, FORCE_K * logVal);
          const normStrength =
            logVal / Math.log(1 + FORCE_HEAT_REF / FORCE_F0);
          computeForceHeatColor(normStrength, this.tmpColor);
          pair.force.material.color.copy(this.tmpColor);

          this.tmpDir.set(fx / mag, fy / mag, fz / mag);
          this.orientArrow(
            pair.force,
            body.position,
            this.tmpDir,
            startOffset,
            length
          );
          pair.force.root.visible = length > 0.015;
        } else {
          pair.force.root.visible = false;
        }
      }
    }
  }

  public dispose(): void {
    for (const [id, pair] of this.arrows) {
      this.removeArrowPair(id, pair);
    }
    this.arrows.clear();

    this.sharedShaftGeo.dispose();
    this.sharedHeadGeo.dispose();

    for (const geo of this.extraGeometries) {
      geo.dispose();
    }
    for (const mat of this.extraMaterials) {
      mat.dispose();
    }
    this.extraGeometries.length = 0;
    this.extraMaterials.length = 0;
    this.group.clear();
  }

  private applyVisibility(): void {
    const hidden = this.surfaceModeHidden;
    this.velocityGroup.visible = !hidden && this.showVelocity;
    this.forceGroup.visible = !hidden && this.showForce;
    this.comGroup.visible = !hidden && this.showCom;
    this.gridGroup.visible = !hidden && this.showGrid;
  }

  private createArrowVisual(color: THREE.Color): ArrowVisual {
    const root = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({
      color: color.clone(),
      transparent: true,
      opacity: 0.9,
      depthWrite: true,
      toneMapped: true,
    });

    const shaft = new THREE.Mesh(this.sharedShaftGeo, material);
    const head = new THREE.Mesh(this.sharedHeadGeo, material);
    shaft.renderOrder = 4;
    head.renderOrder = 4;
    root.add(shaft, head);
    root.visible = false;

    return { root, shaft, head, material };
  }

  private orientArrow(
    arrow: ArrowVisual,
    origin: Vec3,
    unitDir: THREE.Vector3,
    startOffset: number,
    totalLength: number
  ): void {
    arrow.root.position.set(
      origin[0] + unitDir.x * startOffset,
      origin[1] + unitDir.y * startOffset,
      origin[2] + unitDir.z * startOffset
    );
    this.tmpQuat.setFromUnitVectors(UP_AXIS, unitDir);
    arrow.root.quaternion.copy(this.tmpQuat);

    const headLen = Math.min(0.11, Math.max(0.035, totalLength * 0.28));
    const shaftLen = Math.max(0.005, totalLength - headLen);
    const thickness = Math.min(1.25, Math.max(0.6, totalLength * 1.1));

    arrow.shaft.scale.set(thickness, shaftLen, thickness);
    arrow.head.position.set(0, shaftLen, 0);
    arrow.head.scale.set(thickness, headLen, thickness);
  }

  private removeArrowPair(id: string, pair: BodyArrowPair): void {
    this.velocityGroup.remove(pair.velocity.root);
    this.forceGroup.remove(pair.force.root);
    pair.velocity.material.dispose();
    pair.force.material.dispose();
    this.arrows.delete(id);
  }

  /**
   * 【跨层约定 #2】在 XY 平面（z = 0）铺设低亮度深空参考网格与同心轨道标尺环，
   * 全部线性 RGB <= 0.40（严格 <= 0.45），绝不触发 Bloom。
   */
  private buildXYReferenceGrid(): void {
    const halfSpan = 10;
    const step = 1;
    const lineVerts: number[] = [];
    const lineColors: number[] = [];

    const minorCol = hexToClampedColor('#334155', 0.14);
    const majorCol = hexToClampedColor('#475569', 0.23);
    const xAxisCol = hexToClampedColor('#64748b', 0.36);
    const yAxisCol = hexToClampedColor('#64748b', 0.36);

    for (let i = -halfSpan; i <= halfSpan; i += step) {
      const isAxis = i === 0;
      const isMajor = i % 5 === 0;

      // 平行于 X 轴的线段（位于 z = 0）
      lineVerts.push(-halfSpan, i, 0, halfSpan, i, 0);
      const rowCol = isAxis ? xAxisCol : isMajor ? majorCol : minorCol;
      lineColors.push(
        rowCol.r,
        rowCol.g,
        rowCol.b,
        rowCol.r,
        rowCol.g,
        rowCol.b
      );

      // 平行于 Y 轴的线段（位于 z = 0）
      lineVerts.push(i, -halfSpan, 0, i, halfSpan, 0);
      const colCol = isAxis ? yAxisCol : isMajor ? majorCol : minorCol;
      lineColors.push(
        colCol.r,
        colCol.g,
        colCol.b,
        colCol.r,
        colCol.g,
        colCol.b
      );
    }

    // 在 XY 平面（z = 0）追加淡雅同心天文单位距离标尺环（r = 1, 2, 4, 6, 8 AU）
    const ringRadii = [1, 2, 4, 6, 8];
    const ringSegments = 96;
    const ringCol = hexToClampedColor('#3b6e9c', 0.22);

    for (const r of ringRadii) {
      for (let s = 0; s < ringSegments; s++) {
        const a0 = (s / ringSegments) * Math.PI * 2;
        const a1 = ((s + 1) / ringSegments) * Math.PI * 2;
        lineVerts.push(
          Math.cos(a0) * r,
          Math.sin(a0) * r,
          0,
          Math.cos(a1) * r,
          Math.sin(a1) * r,
          0
        );
        lineColors.push(
          ringCol.r,
          ringCol.g,
          ringCol.b,
          ringCol.r,
          ringCol.g,
          ringCol.b
        );
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(lineVerts, 3)
    );
    geometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(lineColors, 3)
    );

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });

    const segments = new THREE.LineSegments(geometry, material);
    segments.renderOrder = -5;

    this.extraGeometries.push(geometry);
    this.extraMaterials.push(material);
    this.gridGroup.add(segments);
  }

  /**
   * 构造质心（CoM）3D 十字准星与外圈线框标记（线性 RGB <= 0.72，绝不触发 Bloom）。
   */
  private buildCenterOfMassMarker(): void {
    const arm = 0.14;
    const crossVerts = new Float32Array([
      -arm,
      0,
      0,
      arm,
      0,
      0,
      0,
      -arm,
      0,
      0,
      arm,
      0,
      0,
      0,
      -arm,
      0,
      0,
      arm,
    ]);

    const crossGeo = new THREE.BufferGeometry();
    crossGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(crossVerts, 3)
    );

    const crossMat = new THREE.LineBasicMaterial({
      color: hexToClampedColor('#34d399', 0.72),
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      depthTest: true,
    });

    const crossLines = new THREE.LineSegments(crossGeo, crossMat);
    crossLines.renderOrder = 6;

    // 细微中心八面体线框，帮助在三维视角下准确定位质心深度
    const octGeo = new THREE.OctahedronGeometry(0.045, 0);
    const octEdgesGeo = new THREE.EdgesGeometry(octGeo);
    octGeo.dispose();

    const octMat = new THREE.LineBasicMaterial({
      color: hexToClampedColor('#a7f3d0', 0.68),
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      depthTest: true,
    });

    const octLines = new THREE.LineSegments(octEdgesGeo, octMat);
    octLines.renderOrder = 6;

    this.extraGeometries.push(crossGeo, octEdgesGeo);
    this.extraMaterials.push(crossMat, octMat);
    this.comGroup.add(crossLines, octLines);
  }
}
