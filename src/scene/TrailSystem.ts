/**
 * 弧长与曲率自适应环形缓冲区轨迹系统（TrailSystem）
 *
 * 设计要点：
 * - 为每颗天体预分配固定容量环形缓冲区（MAX_TRAIL_CAPACITY = 2400 点），零每帧 GC。
 * - 采样策略：严禁每帧盲目写入；仅当空间位移 Δs >= minDist 或速度方向夹角变化 Δθ >= minAngle
 *   （且位移超过防抖阈值）时才写入新点，既避免自适应小步长耗尽缓冲，又保证近距急转弯平滑无折线。
 * - 使用自定义 Alpha 渐变 ShaderMaterial + NormalBlending，尾端透明淡出，线性 RGB 严格 <= 0.90，
 *   即使多条轨道重叠交叉也绝不触发 Bloom（threshold = 1.0）。
 */

import * as THREE from 'three';
import type { BodyState } from '../types/contracts';
import { hexToClampedColor } from './colorUtils';

export const MAX_TRAIL_CAPACITY = 2400;

const STAR_MIN_DIST = 0.024;
const PLANET_MIN_DIST = 0.016;
const MIN_CURVATURE_DIST = 0.003;
const MIN_ANGLE_RAD = 0.045; // ~2.6°，保证近距弹弓急转弯曲线平滑圆润

const TRAIL_VERTEX_SHADER = /* glsl */ `
  attribute float aFade;
  varying float vFade;

  void main() {
    vFade = aFade;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TRAIL_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  varying float vFade;

  void main() {
    float f = clamp(vFade, 0.0, 1.0);
    // 尾部柔和透明衰减，头部清晰锐利；颜色严格上限 0.92，绝不触发 Bloom
    vec3 col = min(uColor * mix(0.45, 1.02, f), vec3(0.92));
    float alpha = pow(f, 1.45) * 0.88;
    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

interface TrailEntry {
  readonly id: string;
  readonly isPlanet: boolean;
  readonly ringPositions: Float32Array;
  readonly gpuPositions: Float32Array;
  readonly gpuFades: Float32Array;
  readonly positionAttr: THREE.BufferAttribute;
  readonly fadeAttr: THREE.BufferAttribute;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly line: THREE.Line;
  colorHex: string;
  /** 下一次写入环形缓冲区的槽位索引 */
  writeIndex: number;
  /** 当前环形缓冲区已存储的有效采样点数（0 .. MAX_TRAIL_CAPACITY） */
  sampleCount: number;
  lastSampleX: number;
  lastSampleY: number;
  lastSampleZ: number;
  lastVelDirX: number;
  lastVelDirY: number;
  lastVelDirZ: number;
  hasLastVelDir: boolean;
  /** 标记 GPU 缓冲区是否需要完整刷新 */
  dirty: boolean;
}

export class TrailSystem {
  public readonly group: THREE.Group;

  private readonly entries = new Map<string, TrailEntry>();
  private maxDisplayPoints: number = 900;
  private userVisible: boolean = true;
  private surfaceModeHidden: boolean = false;

  constructor(initialTrailLength: number = 900) {
    this.group = new THREE.Group();
    this.group.name = 'AdaptiveOrbitalTrails';
    this.maxDisplayPoints = this.clampTrailLength(initialTrailLength);
  }

  public setTrailLength(length: number): void {
    const next = this.clampTrailLength(length);
    if (next === this.maxDisplayPoints) return;
    this.maxDisplayPoints = next;
    for (const entry of this.entries.values()) {
      entry.dirty = true;
    }
  }

  public setVisible(visible: boolean): void {
    this.userVisible = visible;
    this.applyVisibility();
  }

  public setSurfaceModeHidden(hidden: boolean): void {
    this.surfaceModeHidden = hidden;
    this.applyVisibility();
  }

  public clearTrails(): void {
    for (const entry of this.entries.values()) {
      entry.writeIndex = 0;
      entry.sampleCount = 0;
      entry.hasLastVelDir = false;
      entry.dirty = false;
      entry.geometry.setDrawRange(0, 0);
    }
  }

  public syncBodies(
    bodies: readonly BodyState[],
    clearTrails: boolean = false
  ): void {
    const activeIds = new Set<string>();

    for (const body of bodies) {
      activeIds.add(body.id);
      let entry = this.entries.get(body.id);
      if (!entry) {
        entry = this.createEntry(body);
        this.entries.set(body.id, entry);
        this.group.add(entry.line);
      } else {
        if (entry.colorHex !== body.color) {
          const uniform = entry.material.uniforms['uColor'];
          if (uniform && uniform.value instanceof THREE.Color) {
            hexToClampedColor(body.color, 0.9, uniform.value);
          }
          entry.colorHex = body.color;
        }
        if (clearTrails) {
          entry.writeIndex = 0;
          entry.sampleCount = 0;
          entry.hasLastVelDir = false;
          entry.geometry.setDrawRange(0, 0);
        }
      }
    }

    for (const [id, entry] of this.entries) {
      if (!activeIds.has(id)) {
        this.removeEntry(id, entry);
      }
    }
  }

  /**
   * 按弧长 Δs 与速度曲率 Δθ 自适应采样，并在可见时刷新 GPU 顶点缓冲。
   */
  public update(bodies: readonly BodyState[]): void {
    const shouldUpload = this.group.visible;

    for (const body of bodies) {
      const entry = this.entries.get(body.id);
      if (!entry) continue;

      const px = body.position[0];
      const py = body.position[1];
      const pz = body.position[2];
      const vx = body.velocity[0];
      const vy = body.velocity[1];
      const vz = body.velocity[2];

      const sampled = this.trySamplePoint(entry, px, py, pz, vx, vy, vz);
      if (sampled) {
        entry.dirty = true;
      }

      if (shouldUpload && entry.sampleCount > 0) {
        if (entry.dirty) {
          this.rebuildGpuBuffer(entry, px, py, pz);
          entry.dirty = false;
        } else {
          // 未触发新采样点时，仅平滑更新末端实时头部顶点，消除星体与轨迹末端的视觉缝隙
          this.updateLiveTip(entry, px, py, pz);
        }
      }
    }
  }

  public dispose(): void {
    for (const [id, entry] of this.entries) {
      this.removeEntry(id, entry);
    }
    this.entries.clear();
    this.group.clear();
  }

  private clampTrailLength(length: number): number {
    return Math.max(
      2,
      Math.min(MAX_TRAIL_CAPACITY - 1, Math.floor(length || 2))
    );
  }

  private applyVisibility(): void {
    const nextVisible = this.userVisible && !this.surfaceModeHidden;
    const becameVisible = nextVisible && !this.group.visible;
    this.group.visible = nextVisible;
    if (becameVisible) {
      for (const entry of this.entries.values()) {
        entry.dirty = true;
      }
    }
  }

  private createEntry(body: BodyState): TrailEntry {
    // GPU 缓冲预留 +1 个实时末端顶点槽位
    const gpuVertexCap = MAX_TRAIL_CAPACITY + 1;
    const ringPositions = new Float32Array(MAX_TRAIL_CAPACITY * 3);
    const gpuPositions = new Float32Array(gpuVertexCap * 3);
    const gpuFades = new Float32Array(gpuVertexCap);

    const geometry = new THREE.BufferGeometry();
    const positionAttr = new THREE.BufferAttribute(gpuPositions, 3);
    const fadeAttr = new THREE.BufferAttribute(gpuFades, 1);
    positionAttr.setUsage(THREE.DynamicDrawUsage);
    fadeAttr.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute('position', positionAttr);
    geometry.setAttribute('aFade', fadeAttr);
    geometry.setDrawRange(0, 0);

    const baseColor = hexToClampedColor(body.color, 0.9);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: baseColor },
      },
      vertexShader: TRAIL_VERTEX_SHADER,
      fragmentShader: TRAIL_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });

    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    line.renderOrder = -2;

    return {
      id: body.id,
      isPlanet: body.role === 'planet',
      ringPositions,
      gpuPositions,
      gpuFades,
      positionAttr,
      fadeAttr,
      geometry,
      material,
      line,
      colorHex: body.color,
      writeIndex: 0,
      sampleCount: 0,
      lastSampleX: 0,
      lastSampleY: 0,
      lastSampleZ: 0,
      lastVelDirX: 0,
      lastVelDirY: 0,
      lastVelDirZ: 0,
      hasLastVelDir: false,
      dirty: false,
    };
  }

  private trySamplePoint(
    entry: TrailEntry,
    px: number,
    py: number,
    pz: number,
    vx: number,
    vy: number,
    vz: number
  ): boolean {
    const speedSq = vx * vx + vy * vy + vz * vz;
    let hasCurVelDir = false;
    let dirX = 0;
    let dirY = 0;
    let dirZ = 0;
    if (speedSq > 1e-12) {
      const invSpeed = 1 / Math.sqrt(speedSq);
      dirX = vx * invSpeed;
      dirY = vy * invSpeed;
      dirZ = vz * invSpeed;
      hasCurVelDir = true;
    }

    if (entry.sampleCount === 0) {
      this.pushRingSample(
        entry,
        px,
        py,
        pz,
        dirX,
        dirY,
        dirZ,
        hasCurVelDir
      );
      return true;
    }

    const dx = px - entry.lastSampleX;
    const dy = py - entry.lastSampleY;
    const dz = pz - entry.lastSampleZ;
    const distSq = dx * dx + dy * dy + dz * dz;

    // 极小位移（例如暂停或极微小步长）绝不重复写入
    if (distSq < 1e-10) {
      return false;
    }

    const minDist = entry.isPlanet ? PLANET_MIN_DIST : STAR_MIN_DIST;
    let shouldWrite = distSq >= minDist * minDist;

    if (
      !shouldWrite &&
      distSq >= MIN_CURVATURE_DIST * MIN_CURVATURE_DIST &&
      hasCurVelDir &&
      entry.hasLastVelDir
    ) {
      const dot = Math.max(
        -1,
        Math.min(
          1,
          dirX * entry.lastVelDirX +
            dirY * entry.lastVelDirY +
            dirZ * entry.lastVelDirZ
        )
      );
      const dTheta = Math.acos(dot);
      if (dTheta >= MIN_ANGLE_RAD) {
        shouldWrite = true;
      }
    }

    if (shouldWrite) {
      this.pushRingSample(
        entry,
        px,
        py,
        pz,
        dirX,
        dirY,
        dirZ,
        hasCurVelDir
      );
      return true;
    }
    return false;
  }

  private pushRingSample(
    entry: TrailEntry,
    px: number,
    py: number,
    pz: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    hasVelDir: boolean
  ): void {
    const idx3 = entry.writeIndex * 3;
    entry.ringPositions[idx3] = px;
    entry.ringPositions[idx3 + 1] = py;
    entry.ringPositions[idx3 + 2] = pz;

    entry.writeIndex = (entry.writeIndex + 1) % MAX_TRAIL_CAPACITY;
    if (entry.sampleCount < MAX_TRAIL_CAPACITY) {
      entry.sampleCount += 1;
    }

    entry.lastSampleX = px;
    entry.lastSampleY = py;
    entry.lastSampleZ = pz;
    if (hasVelDir) {
      entry.lastVelDirX = dirX;
      entry.lastVelDirY = dirY;
      entry.lastVelDirZ = dirZ;
      entry.hasLastVelDir = true;
    }
  }

  private rebuildGpuBuffer(
    entry: TrailEntry,
    liveX: number,
    liveY: number,
    liveZ: number
  ): void {
    const displaySamples = Math.min(entry.sampleCount, this.maxDisplayPoints);
    if (displaySamples <= 0) {
      entry.geometry.setDrawRange(0, 0);
      return;
    }

    // 定位最老的有效点在环形缓冲中的起点
    const oldestIndex =
      (entry.writeIndex - displaySamples + MAX_TRAIL_CAPACITY) %
      MAX_TRAIL_CAPACITY;
    const totalVertices = displaySamples + 1; // 采样点 + 实时末端点
    const invSpan = totalVertices > 1 ? 1 / (totalVertices - 1) : 1;

    const ring = entry.ringPositions;
    const gpuPos = entry.gpuPositions;
    const gpuFade = entry.gpuFades;

    for (let i = 0; i < displaySamples; i++) {
      const ringIdx = (oldestIndex + i) % MAX_TRAIL_CAPACITY;
      const src = ringIdx * 3;
      const dst = i * 3;
      gpuPos[dst] = ring[src];
      gpuPos[dst + 1] = ring[src + 1];
      gpuPos[dst + 2] = ring[src + 2];
      gpuFade[i] = i * invSpan;
    }

    // 追加实时天体当前位置作为末端尖点
    const tipDst = displaySamples * 3;
    gpuPos[tipDst] = liveX;
    gpuPos[tipDst + 1] = liveY;
    gpuPos[tipDst + 2] = liveZ;
    gpuFade[displaySamples] = 1.0;

    entry.positionAttr.needsUpdate = true;
    entry.fadeAttr.needsUpdate = true;
    entry.geometry.setDrawRange(0, totalVertices);
  }

  private updateLiveTip(
    entry: TrailEntry,
    liveX: number,
    liveY: number,
    liveZ: number
  ): void {
    const displaySamples = Math.min(entry.sampleCount, this.maxDisplayPoints);
    if (displaySamples <= 0) return;

    const tipDst = displaySamples * 3;
    entry.gpuPositions[tipDst] = liveX;
    entry.gpuPositions[tipDst + 1] = liveY;
    entry.gpuPositions[tipDst + 2] = liveZ;
    entry.positionAttr.needsUpdate = true;
  }

  private removeEntry(id: string, entry: TrailEntry): void {
    this.group.remove(entry.line);
    entry.geometry.dispose();
    entry.material.dispose();
    this.entries.delete(id);
  }
}
