/**
 * 3D 三体/N 体物理仿真引擎（纯 TypeScript，零 React / Three.js 依赖）
 *
 * 封装完整仿真状态、双积分器（DOPRI5(4) + FSAL / Velocity Verlet）、
 * 完全非弹性碰撞合并、质心静止系归一化、近距自动慢动作衰减因子、
 * 能量与角动量监控、以及三体行星热力学与恒/乱纪元追踪器。
 */

import { DEFAULT_PRESET_ID, PRESET_MAP } from '../presets/presets';
import {
  MAX_BODIES,
  MIN_BODIES,
  type BodyPatch,
  type BodyState,
  type CollisionEvent,
  type EnergyMetrics,
  type NewBodyInput,
  type PhysicsSnapshot,
  type PhysicsStepResult,
  type PlanetTelemetry,
  type PresetBodyConfig,
  type PresetDefinition,
  type SimulationConfig,
  type Vec3,
} from '../types/contracts';
import { hasAnyCollisionFlat, resolveCollisions } from './collisions';
import { computeEnergyMetrics, normalizeCenterOfMass } from './diagnostics';
import {
  computeGravityForBodies,
  computeLuminosity,
  computeMinPairDistance,
  computeMinStarPairDistance,
} from './gravity';
import {
  DEFAULT_DOPRI_INITIAL_DT,
  H_MIN,
  MAX_SUBSTEPS_PER_FRAME,
  createIntegratorWorkspace,
  integrateFlatDopri54,
  integrateFlatVerlet,
  invalidateWorkspaceCache,
  packBodiesToWorkspace,
  unpackWorkspaceToBodies,
  type IntegratorWorkspace,
} from './integrators';
import {
  PlanetThermodynamicsTracker,
  RADIATION_SOFTENING,
  REFERENCE_FLUX,
} from './thermodynamics';

// ============================================================================
// 自动慢动作平滑衰减参数
// ============================================================================

const AUTO_SLOWMO_DIST_HIGH = 0.45;
const AUTO_SLOWMO_DIST_LOW = 0.06;
const AUTO_SLOWMO_STEP_HIGH = 2e-3;
const AUTO_SLOWMO_STEP_LOW = 5e-5;
const AUTO_SLOWMO_MIN_FACTOR = 0.1;

/** 热力学在长步长积分内的采样间隔上限 */
const THERMAL_SUBSTEP_ACCUM_THRESHOLD = 0.005;

/** 随机生成与新增恒星的默认星体色板（高饱和星色，配合 HDR emissiveIntensity） */
const STAR_COLOR_PALETTE: readonly string[] = [
  '#60a5fa',
  '#fbbf24',
  '#f87171',
  '#c084fc',
  '#34d399',
  '#fb923c',
  '#38bdf8',
  '#f472b6',
];

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function cloneVec3(v: Vec3): Vec3 {
  return [v[0], v[1], v[2]];
}

function presetBodyToBodyState(
  b: PresetBodyConfig,
  planetAsTestParticle: boolean
): BodyState {
  const isTestParticle =
    b.role === 'planet'
      ? (b.isTestParticle ?? planetAsTestParticle)
      : (b.isTestParticle ?? false);

  return {
    id: b.id,
    name: b.name,
    role: b.role,
    mass: b.mass,
    position: cloneVec3(b.position),
    velocity: cloneVec3(b.velocity),
    color: b.color,
    emissiveIntensity: b.emissiveIntensity,
    renderRadius: b.renderRadius,
    collisionRadius: b.collisionRadius,
    isTestParticle,
    acceleration: [0, 0, 0],
    force: [0, 0, 0],
    luminosity: computeLuminosity(b.role, b.mass),
  };
}

function buildConfigFromPreset(preset: PresetDefinition): SimulationConfig {
  const hasPlanet =
    preset.hasTrisolarisPlanet || preset.bodies.some((b) => b.role === 'planet');
  const planetBody = preset.bodies.find((b) => b.role === 'planet');
  const planetAsTestParticle = planetBody?.isTestParticle ?? true;

  return {
    G: preset.G,
    softening: preset.defaultSoftening,
    integrator: preset.defaultIntegrator,
    rtol: preset.recommendedRtol,
    atol: Math.min(preset.recommendedRtol * 1e-2, 1e-12),
    verletDt: preset.recommendedVerletDt,
    timeScale: preset.defaultTimeScale,
    enableCollisions: false,
    enableAutoSlowMo: true,
    planetAsTestParticle,
    planetRotationRate: 0.8,
    enablePlanetTelemetry: hasPlanet,
  };
}

export interface StepOptions {
  /** 本次 step 允许的最大子步数（默认 MAX_SUBSTEPS_PER_FRAME = 500） */
  readonly maxSubsteps?: number;
  /** 是否在 step 内部直接按自动慢动作系数缩放 simDt（默认 false，由调度层控制） */
  readonly applyAutoSlowMo?: boolean;
}

export class PhysicsEngine {
  private currentPresetId: string | null = null;
  private initialBodiesForReset: BodyState[] = [];
  private initialConfigForReset: SimulationConfig;

  private config: SimulationConfig;
  private bodies: BodyState[] = [];
  private simTime = 0;
  private referenceEnergy = 0;
  private cumulativeEnergyLoss = 0;
  private collisionEvents: CollisionEvent[] = [];
  private collisionCounter = 0;
  private bodyIdCounter = 0;

  private minPairDistance = Number.POSITIVE_INFINITY;
  private lastStepSize = 0.001;
  private substepsThisFrame = 0;
  private substepClamped = false;

  private workspace: IntegratorWorkspace = createIntegratorWorkspace(MAX_BODIES);
  private workspaceDirty = true;

  private thermoTracker: PlanetThermodynamicsTracker | null = null;
  private latestPlanetTelemetry: PlanetTelemetry | null = null;

  constructor(presetId: string = DEFAULT_PRESET_ID) {
    const preset = PRESET_MAP[presetId] ?? PRESET_MAP[DEFAULT_PRESET_ID];
    this.config = buildConfigFromPreset(preset);
    this.initialConfigForReset = { ...this.config };
    this.loadPreset(preset.id);
  }

  /**
   * 获取当前激活预设 ID（随机生成时为 null）
   */
  public getPresetId(): string | null {
    return this.currentPresetId;
  }

  /**
   * 加载经典预设并重置全部物理状态、能量基准与热力学状态机
   */
  public loadPreset(presetId: string): PhysicsSnapshot {
    const preset = PRESET_MAP[presetId];
    if (!preset) {
      throw new Error(`Unknown preset id: "${presetId}"`);
    }

    this.currentPresetId = preset.id;
    this.config = buildConfigFromPreset(preset);
    this.initialConfigForReset = { ...this.config };

    const rawBodies = preset.bodies.map((b) =>
      presetBodyToBodyState(b, this.config.planetAsTestParticle)
    );
    const grav = computeGravityForBodies(rawBodies, this.config.G, this.config.softening);

    this.bodies = grav.bodies;
    this.initialBodiesForReset = this.cloneBodies(this.bodies);
    this.minPairDistance = grav.minPairDistance;

    this.resetDynamicCounters(
      this.config.integrator === 'dopri54'
        ? DEFAULT_DOPRI_INITIAL_DT
        : preset.recommendedVerletDt
    );
    this.reinitializeThermodynamics();

    return this.getSnapshot();
  }

  /**
   * 重置仿真到当前预设或最近一次随机生成的初始状态（t = 0）
   */
  public reset(): PhysicsSnapshot {
    if (this.currentPresetId !== null && PRESET_MAP[this.currentPresetId]) {
      return this.loadPreset(this.currentPresetId);
    }

    this.config = { ...this.initialConfigForReset };
    const grav = computeGravityForBodies(
      this.cloneBodies(this.initialBodiesForReset),
      this.config.G,
      this.config.softening
    );
    this.bodies = grav.bodies;
    this.minPairDistance = grav.minPairDistance;

    this.resetDynamicCounters(
      this.config.integrator === 'dopri54'
        ? DEFAULT_DOPRI_INITIAL_DT
        : this.config.verletDt
    );
    this.reinitializeThermodynamics();

    return this.getSnapshot();
  }

  /**
   * 随机生成 E < 0 的 3D 束缚 N 体系统：
   * - 质心与总动量严格归零
   * - 避免初始重叠（最小间距 >= 0.7）
   * - 通过维里比 Q ∈ [0.35, 0.65] 缩放速度，严格保证总能量 E < 0
   */
  public randomize(bodyCount = 3): PhysicsSnapshot {
    const count = Math.min(MAX_BODIES, Math.max(MIN_BODIES, Math.round(bodyCount)));
    this.currentPresetId = null;

    // 混沌随机系统若当前软化为 0，自动赋予安全小软化值防止初始奇点
    const softening = this.config.softening > 0 ? this.config.softening : 0.015;
    this.config = {
      ...this.config,
      softening,
      enablePlanetTelemetry: false,
    };

    const G = this.config.G;
    const minSep = 0.72;

    const masses: number[] = [];
    const positions: [number, number, number][] = [];

    for (let i = 0; i < count; i++) {
      masses.push(0.65 + Math.random() * 0.85);

      let placed = false;
      let radiusScale = 2.0 + 0.25 * Math.max(0, count - 3);
      let candidate: [number, number, number] = [0, 0, 0];

      for (let attempt = 0; attempt < 400; attempt++) {
        if (attempt > 0 && attempt % 100 === 0) {
          radiusScale *= 1.25;
        }
        // 在 3D 球壳 [0.45 * R, R] 内均匀采样
        const u = Math.random();
        const v = Math.random();
        const theta = 2 * Math.PI * u;
        const cosPhi = 2 * v - 1;
        const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
        const r = radiusScale * (0.45 + 0.55 * Math.cbrt(Math.random()));
        candidate = [r * sinPhi * Math.cos(theta), r * sinPhi * Math.sin(theta), r * cosPhi];

        let ok = true;
        for (let j = 0; j < positions.length; j++) {
          const dx = candidate[0] - positions[j][0];
          const dy = candidate[1] - positions[j][1];
          const dz = candidate[2] - positions[j][2];
          if (Math.hypot(dx, dy, dz) < minSep) {
            ok = false;
            break;
          }
        }
        if (ok) {
          placed = true;
          break;
        }
      }

      if (!placed) {
        // 兜底：放置在保证分离的螺旋球面点上
        const angle = (2 * Math.PI * i) / count;
        const r = radiusScale * 1.4;
        candidate = [r * Math.cos(angle), r * Math.sin(angle), (i - (count - 1) / 2) * 0.45];
      }
      positions.push(candidate);
    }

    // 先将位置质心归零
    let totalMass = 0;
    let cmX = 0;
    let cmY = 0;
    let cmZ = 0;
    for (let i = 0; i < count; i++) {
      totalMass += masses[i];
      cmX += masses[i] * positions[i][0];
      cmY += masses[i] * positions[i][1];
      cmZ += masses[i] * positions[i][2];
    }
    cmX /= totalMass;
    cmY /= totalMass;
    cmZ /= totalMass;
    for (let i = 0; i < count; i++) {
      positions[i][0] -= cmX;
      positions[i][1] -= cmY;
      positions[i][2] -= cmZ;
    }

    // 计算当前构型势能 U (< 0)
    let potential = 0;
    const epsSq = softening * softening;
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const dx = positions[j][0] - positions[i][0];
        const dy = positions[j][1] - positions[i][1];
        const dz = positions[j][2] - positions[i][2];
        potential -= (G * masses[i] * masses[j]) / Math.sqrt(dx * dx + dy * dy + dz * dz + epsSq);
      }
    }

    // 生成带适度切向旋转趋势的 3D 随机速度并扣除质心速度
    const velocities: [number, number, number][] = [];
    let pX = 0;
    let pY = 0;
    let pZ = 0;
    for (let i = 0; i < count; i++) {
      const [px, py, pz] = positions[i];
      const vx = -0.35 * py + (Math.random() - 0.5) * 1.2;
      const vy = 0.35 * px + (Math.random() - 0.5) * 1.2;
      const vz = (Math.random() - 0.5) * 0.8 + 0.1 * pz;
      velocities.push([vx, vy, vz]);
      pX += masses[i] * vx;
      pY += masses[i] * vy;
      pZ += masses[i] * vz;
    }
    const vCmX = pX / totalMass;
    const vCmY = pY / totalMass;
    const vCmZ = pZ / totalMass;

    let rawKinetic = 0;
    for (let i = 0; i < count; i++) {
      velocities[i][0] -= vCmX;
      velocities[i][1] -= vCmY;
      velocities[i][2] -= vCmZ;
      const [vx, vy, vz] = velocities[i];
      rawKinetic += 0.5 * masses[i] * (vx * vx + vy * vy + vz * vz);
    }

    // 维里比 Q ∈ [0.35, 0.65] 缩放速度，保证 K = Q * |U| => E = -(1 - Q)*|U| < 0
    const virialRatio = 0.35 + Math.random() * 0.3;
    const targetKinetic = virialRatio * Math.abs(potential);
    const velScale = rawKinetic > 1e-12 ? Math.sqrt(targetKinetic / rawKinetic) : 0;

    const rawBodies: BodyState[] = [];
    for (let i = 0; i < count; i++) {
      const m = masses[i];
      const color = STAR_COLOR_PALETTE[i % STAR_COLOR_PALETTE.length];
      const scaleR = Math.cbrt(m);
      rawBodies.push({
        id: `star-${++this.bodyIdCounter}`,
        name: `随机恒星 ${i + 1}`,
        role: 'star',
        mass: m,
        position: [positions[i][0], positions[i][1], positions[i][2]],
        velocity: [
          velocities[i][0] * velScale,
          velocities[i][1] * velScale,
          velocities[i][2] * velScale,
        ],
        color,
        emissiveIntensity: 2.65,
        renderRadius: 0.075 * scaleR,
        collisionRadius: 0.025 * scaleR,
        isTestParticle: false,
        acceleration: [0, 0, 0],
        force: [0, 0, 0],
        luminosity: computeLuminosity('star', m),
      });
    }

    const normalized = normalizeCenterOfMass(rawBodies);
    const grav = computeGravityForBodies(normalized, this.config.G, this.config.softening);

    this.bodies = grav.bodies;
    this.initialBodiesForReset = this.cloneBodies(this.bodies);
    this.initialConfigForReset = { ...this.config };
    this.minPairDistance = grav.minPairDistance;

    this.resetDynamicCounters(
      this.config.integrator === 'dopri54'
        ? DEFAULT_DOPRI_INITIAL_DT
        : this.config.verletDt
    );
    this.thermoTracker = null;
    this.latestPlanetTelemetry = null;

    return this.getSnapshot();
  }

  /**
   * 推进仿真 simDt 模拟时间
   */
  public step(simDt: number, options?: StepOptions): PhysicsStepResult {
    if (simDt <= 0 || !Number.isFinite(simDt) || this.bodies.length === 0) {
      return {
        snapshot: this.getSnapshot(),
        newCollisions: [],
        bodiesChanged: false,
      };
    }

    const slowMo = this.computeAutoSlowMoFactor();
    const targetDt = options?.applyAutoSlowMo ? simDt * slowMo.factor : simDt;
    const maxSubsteps = Math.max(1, options?.maxSubsteps ?? MAX_SUBSTEPS_PER_FRAME);

    let remainingDt = targetDt;
    let remainingSubsteps = maxSubsteps;
    let totalSubsteps = 0;
    let anyClamped = false;
    let lastStepSize = this.lastStepSize;
    const newCollisions: CollisionEvent[] = [];
    let bodiesChanged = false;

    const endTol = 1e-15 * Math.max(1, targetDt);

    // 若步进开始前就已存在碰撞重叠（如用户手动放置重叠天体），先执行一次合并
    if (this.config.enableCollisions && this.bodies.length >= 2) {
      const preCollision = this.tryResolveCurrentCollisions();
      if (preCollision.merged) {
        newCollisions.push(...preCollision.events);
        bodiesChanged = true;
      }
    }

    while (remainingDt > endTol && remainingSubsteps > 0 && this.bodies.length > 0) {
      if (this.workspaceDirty) {
        packBodiesToWorkspace(this.bodies, this.workspace);
        this.workspaceDirty = false;
      }

      const n = this.bodies.length;
      const checkCollision = this.config.enableCollisions && n >= 2;
      const trackPlanet =
        this.config.enablePlanetTelemetry && this.thermoTracker !== null;
      const segmentStartSimTime = this.simTime;
      let thermalAccumDt = 0;

      const onAcceptedSubstep =
        checkCollision || trackPlanet
          ? (stepDt: number, elapsedTime: number, stateY: Float64Array): boolean => {
              if (trackPlanet) {
                thermalAccumDt += stepDt;
                if (thermalAccumDt >= THERMAL_SUBSTEP_ACCUM_THRESHOLD) {
                  this.stepThermodynamicsFromFlatState(
                    stateY,
                    thermalAccumDt,
                    segmentStartSimTime + elapsedTime
                  );
                  thermalAccumDt = 0;
                }
              }

              if (
                checkCollision &&
                hasAnyCollisionFlat(stateY, this.workspace.collisionRadii, n)
              ) {
                return true;
              }
              return false;
            }
          : undefined;

      const flatResult =
        this.config.integrator === 'verlet'
          ? integrateFlatVerlet(this.workspace, remainingDt, {
              count: n,
              G: this.config.G,
              softening: this.config.softening,
              verletDt: this.config.verletDt,
              maxSubsteps: remainingSubsteps,
              hMin: H_MIN,
              onAcceptedSubstep,
            })
          : integrateFlatDopri54(this.workspace, remainingDt, {
              count: n,
              G: this.config.G,
              softening: this.config.softening,
              rtol: this.config.rtol,
              atol: this.config.atol,
              maxSubsteps: remainingSubsteps,
              hMin: H_MIN,
              onAcceptedSubstep,
            });

      this.simTime += flatResult.dtAdvanced;
      remainingDt = Math.max(0, remainingDt - flatResult.dtAdvanced);
      totalSubsteps += flatResult.substeps;
      remainingSubsteps -= flatResult.substeps;
      lastStepSize = flatResult.lastStepSize;
      if (flatResult.substepClamped) {
        anyClamped = true;
      }

      const unpacked = unpackWorkspaceToBodies(
        this.bodies,
        this.workspace,
        this.config.G,
        this.config.softening
      );
      this.bodies = unpacked.bodies;
      this.minPairDistance = unpacked.minPairDistance;

      // 补齐本段末尾尚未刷新的热力学增量
      if (trackPlanet && thermalAccumDt > 0) {
        this.stepThermodynamicsWithCurrentBodies(thermalAccumDt, this.simTime);
        thermalAccumDt = 0;
      }

      if (flatResult.stoppedEarly && checkCollision) {
        const resolved = this.tryResolveCurrentCollisions();
        if (resolved.merged) {
          newCollisions.push(...resolved.events);
          bodiesChanged = true;
        }
      }

      if (flatResult.substepClamped || flatResult.dtAdvanced <= 0) {
        break;
      }
    }

    this.substepsThisFrame = totalSubsteps;
    this.substepClamped = anyClamped;
    this.lastStepSize = lastStepSize;

    // 刷新最新行星遥测快照
    this.refreshPlanetTelemetrySnapshot();

    return {
      snapshot: this.getSnapshot(),
      newCollisions,
      bodiesChanged,
    };
  }

  /**
   * 单步推进（用于暂停状态下的单步调试按钮）
   */
  public stepOnce(dt?: number): PhysicsStepResult {
    const stepDt =
      dt !== undefined && Number.isFinite(dt) && dt > 0
        ? dt
        : Math.max(1e-4, (1 / 60) * Math.max(this.config.timeScale, 0.1));
    return this.step(stepDt);
  }

  /**
   * 计算近距自动时间膨胀（Auto Slow-Mo）平滑衰减系数：
   * 基于最小两星间距或 DOPRI5(4) 自适应步长骤降进行 smoothstep 平滑插值。
   */
  public computeAutoSlowMoFactor(): { factor: number; active: boolean } {
    if (!this.config.enableAutoSlowMo) {
      return { factor: 1.0, active: false };
    }

    const minStarDist = computeMinStarPairDistance(this.bodies);
    const distBlend = smoothstep(AUTO_SLOWMO_DIST_LOW, AUTO_SLOWMO_DIST_HIGH, minStarDist);
    const distFactor =
      AUTO_SLOWMO_MIN_FACTOR + (1 - AUTO_SLOWMO_MIN_FACTOR) * distBlend;

    let stepFactor = 1.0;
    if (this.config.integrator === 'dopri54' && this.simTime > 0) {
      const logStep = Math.log10(Math.max(this.lastStepSize, 1e-12));
      const stepBlend = smoothstep(
        Math.log10(AUTO_SLOWMO_STEP_LOW),
        Math.log10(AUTO_SLOWMO_STEP_HIGH),
        logStep
      );
      stepFactor = AUTO_SLOWMO_MIN_FACTOR + (1 - AUTO_SLOWMO_MIN_FACTOR) * stepBlend;
    }

    const factor = Math.min(distFactor, stepFactor);
    return {
      factor,
      active: factor < 0.98,
    };
  }

  /**
   * 获取当前完整只读物理快照
   */
  public getSnapshot(): PhysicsSnapshot {
    const metrics: EnergyMetrics = computeEnergyMetrics(
      this.bodies,
      this.config.G,
      this.config.softening,
      this.referenceEnergy,
      this.cumulativeEnergyLoss
    );
    const slowMo = this.computeAutoSlowMoFactor();

    return {
      simTime: this.simTime,
      bodies: this.cloneBodies(this.bodies),
      metrics,
      planetTelemetry: this.latestPlanetTelemetry,
      effectiveTimeScale: this.config.timeScale * slowMo.factor,
      isAutoSlowMoActive: slowMo.active,
      lastStepSize: this.lastStepSize,
      substepsThisFrame: this.substepsThisFrame,
      substepClamped: this.substepClamped,
      minPairDistance: this.minPairDistance,
    };
  }

  /**
   * 获取当前仿真配置副本
   */
  public getConfig(): SimulationConfig {
    return { ...this.config };
  }

  /**
   * 更新仿真配置；涉及动力学定义的参数变化时自动重算加速度、清空 FSAL 缓存并重置能量基准
   */
  public updateConfig(patch: Partial<SimulationConfig>): void {
    const prev = this.config;
    const next: SimulationConfig = {
      ...prev,
      ...patch,
      G: patch.G !== undefined ? Math.max(0, patch.G) : prev.G,
      softening:
        patch.softening !== undefined ? Math.max(0, patch.softening) : prev.softening,
      rtol: patch.rtol !== undefined ? Math.max(1e-14, patch.rtol) : prev.rtol,
      atol: patch.atol !== undefined ? Math.max(1e-16, patch.atol) : prev.atol,
      verletDt:
        patch.verletDt !== undefined ? Math.max(H_MIN, patch.verletDt) : prev.verletDt,
      timeScale:
        patch.timeScale !== undefined ? Math.max(0, patch.timeScale) : prev.timeScale,
    };

    this.config = next;

    let dynamicsChanged =
      next.G !== prev.G || next.softening !== prev.softening;

    if (next.planetAsTestParticle !== prev.planetAsTestParticle) {
      let anyPlanetUpdated = false;
      this.bodies = this.bodies.map((b) => {
        if (b.role !== 'planet') return b;
        anyPlanetUpdated = true;
        return { ...b, isTestParticle: next.planetAsTestParticle };
      });
      if (anyPlanetUpdated) {
        dynamicsChanged = true;
      }
    }

    if (next.integrator !== prev.integrator) {
      invalidateWorkspaceCache(this.workspace, false);
      this.lastStepSize =
        next.integrator === 'dopri54'
          ? Math.max(this.workspace.suggestedDt, DEFAULT_DOPRI_INITIAL_DT)
          : next.verletDt;
    }

    if (dynamicsChanged) {
      const grav = computeGravityForBodies(
        this.bodies,
        this.config.G,
        this.config.softening
      );
      this.bodies = grav.bodies;
      this.minPairDistance = grav.minPairDistance;
      this.referenceEnergy = computeEnergyMetrics(
        this.bodies,
        this.config.G,
        this.config.softening
      ).total;
      this.markWorkspaceDirty(false);
    }

    if (next.enablePlanetTelemetry !== prev.enablePlanetTelemetry) {
      if (next.enablePlanetTelemetry) {
        if (!this.thermoTracker) {
          this.reinitializeThermodynamics();
        } else {
          this.refreshPlanetTelemetrySnapshot();
        }
      } else {
        this.latestPlanetTelemetry = null;
      }
    }
  }

  /**
   * 消除质心漂移：扣除系统质心位置与质心速度，重算加速度并重置能量基准
   */
  public normalizeCenterOfMass(): PhysicsSnapshot {
    const normalized = normalizeCenterOfMass(this.bodies);
    const grav = computeGravityForBodies(
      normalized,
      this.config.G,
      this.config.softening
    );
    this.bodies = grav.bodies;
    this.minPairDistance = grav.minPairDistance;

    this.referenceEnergy = computeEnergyMetrics(
      this.bodies,
      this.config.G,
      this.config.softening
    ).total;
    this.markWorkspaceDirty(false);
    this.refreshPlanetTelemetrySnapshot();

    return this.getSnapshot();
  }

  /**
   * 新增天体（遵循 MAX_BODIES 上限）
   */
  public addBody(input?: NewBodyInput): PhysicsSnapshot {
    if (this.bodies.length >= MAX_BODIES) {
      return this.getSnapshot();
    }

    const newBody = input
      ? this.createBodyFromInput(input)
      : this.createDefaultNewStar();

    const grav = computeGravityForBodies(
      [...this.bodies, newBody],
      this.config.G,
      this.config.softening
    );
    this.bodies = grav.bodies;
    this.minPairDistance = grav.minPairDistance;

    // 若新天体参与系统守恒量（非测试粒子），重置能量基准
    if (!newBody.isTestParticle) {
      this.referenceEnergy = computeEnergyMetrics(
        this.bodies,
        this.config.G,
        this.config.softening
      ).total;
    }

    this.markWorkspaceDirty(false);

    if (newBody.role === 'planet' && !this.thermoTracker) {
      this.config = { ...this.config, enablePlanetTelemetry: true };
      this.reinitializeThermodynamics();
    } else {
      this.refreshPlanetTelemetrySnapshot();
    }

    return this.getSnapshot();
  }

  /**
   * 为当前系统快捷添加一颗处于主星宜居带轨道的三体行星
   */
  public addTrisolarisPlanet(): PhysicsSnapshot {
    if (
      this.bodies.length >= MAX_BODIES ||
      this.bodies.some((b) => b.role === 'planet')
    ) {
      return this.getSnapshot();
    }

    const stars = this.bodies.filter((b) => b.role === 'star');
    const host =
      stars.length > 0
        ? stars.reduce((best, cur) => (cur.mass > best.mass ? cur : best), stars[0])
        : this.bodies[0];

    // 按主星光度自动估算宜居带轨道半径（使初始辐射通量接近 F_ref = 6.375）
    const hostLum = Math.max(host ? host.luminosity : 1.0, 0.1);
    const rHabSq = Math.max(
      hostLum / REFERENCE_FLUX - RADIATION_SOFTENING * RADIATION_SOFTENING,
      0.16 * 0.16
    );
    const rHab = Math.sqrt(rHabSq);

    const hostPos = host ? host.position : ([0, 0, 0] as Vec3);
    const hostVel = host ? host.velocity : ([0, 0, 0] as Vec3);
    const hostMass = host ? host.mass : 1.0;

    const vOrb = Math.sqrt((this.config.G * hostMass) / Math.max(rHab, 1e-4));

    const planet: BodyState = {
      id: 'trisolaris-planet',
      name: '三体行星',
      role: 'planet',
      mass: 1e-6,
      position: [hostPos[0] + rHab, hostPos[1], hostPos[2]],
      velocity: [hostVel[0], hostVel[1] + vOrb, hostVel[2]],
      color: '#38bdf8',
      emissiveIntensity: 0.35,
      renderRadius: 0.032,
      collisionRadius: 0.008,
      isTestParticle: this.config.planetAsTestParticle,
      acceleration: [0, 0, 0],
      force: [0, 0, 0],
      luminosity: 0,
    };

    const grav = computeGravityForBodies(
      [...this.bodies, planet],
      this.config.G,
      this.config.softening
    );
    this.bodies = grav.bodies;
    this.minPairDistance = grav.minPairDistance;

    if (!planet.isTestParticle) {
      this.referenceEnergy = computeEnergyMetrics(
        this.bodies,
        this.config.G,
        this.config.softening
      ).total;
    }

    this.markWorkspaceDirty(false);
    this.config = { ...this.config, enablePlanetTelemetry: true };
    this.reinitializeThermodynamics();

    return this.getSnapshot();
  }

  /**
   * 删除指定天体（遵循 MIN_BODIES 下限）
   */
  public removeBody(bodyId: string): PhysicsSnapshot {
    if (this.bodies.length <= MIN_BODIES) {
      return this.getSnapshot();
    }

    const idx = this.bodies.findIndex((b) => b.id === bodyId);
    if (idx < 0) {
      return this.getSnapshot();
    }

    const removed = this.bodies[idx];
    const remaining = [
      ...this.bodies.slice(0, idx),
      ...this.bodies.slice(idx + 1),
    ];
    const grav = computeGravityForBodies(
      remaining,
      this.config.G,
      this.config.softening
    );
    this.bodies = grav.bodies;
    this.minPairDistance = grav.minPairDistance;

    if (!removed.isTestParticle) {
      this.referenceEnergy = computeEnergyMetrics(
        this.bodies,
        this.config.G,
        this.config.softening
      ).total;
    }

    this.markWorkspaceDirty(false);

    if (this.thermoTracker && this.thermoTracker.getPlanetId() === bodyId) {
      this.reinitializeThermodynamics();
    } else {
      this.refreshPlanetTelemetrySnapshot();
    }

    return this.getSnapshot();
  }

  /**
   * 更新指定天体参数，同步重算加速度/合力/光度并重置 referenceEnergy
   */
  public updateBody(bodyId: string, patch: BodyPatch): PhysicsSnapshot {
    const idx = this.bodies.findIndex((b) => b.id === bodyId);
    if (idx < 0) {
      return this.getSnapshot();
    }

    const target = this.bodies[idx];
    const nextMass =
      patch.mass !== undefined && Number.isFinite(patch.mass)
        ? Math.max(patch.mass, 1e-12)
        : target.mass;

    const updatedTarget: BodyState = {
      ...target,
      name: patch.name !== undefined ? patch.name : target.name,
      mass: nextMass,
      position: patch.position ? cloneVec3(patch.position) : cloneVec3(target.position),
      velocity: patch.velocity ? cloneVec3(patch.velocity) : cloneVec3(target.velocity),
      color: patch.color !== undefined ? patch.color : target.color,
      renderRadius:
        patch.renderRadius !== undefined && patch.renderRadius > 0
          ? patch.renderRadius
          : target.renderRadius,
      collisionRadius:
        patch.collisionRadius !== undefined && patch.collisionRadius > 0
          ? patch.collisionRadius
          : target.collisionRadius,
      emissiveIntensity:
        patch.emissiveIntensity !== undefined
          ? patch.emissiveIntensity
          : target.emissiveIntensity,
      isTestParticle:
        patch.isTestParticle !== undefined
          ? patch.isTestParticle
          : target.isTestParticle,
      luminosity: computeLuminosity(target.role, nextMass),
    };

    const nextList = this.bodies.slice();
    nextList[idx] = updatedTarget;

    const grav = computeGravityForBodies(
      nextList,
      this.config.G,
      this.config.softening
    );
    this.bodies = grav.bodies;
    this.minPairDistance = grav.minPairDistance;

    // 参数手动编辑后重置能量基准，保证相对漂移从 0 平滑继续监控
    this.referenceEnergy = computeEnergyMetrics(
      this.bodies,
      this.config.G,
      this.config.softening
    ).total;
    this.markWorkspaceDirty(false);
    this.refreshPlanetTelemetrySnapshot();

    return this.getSnapshot();
  }

  /**
   * 获取已记录的全部碰撞事件只读列表
   */
  public getCollisionEvents(): readonly CollisionEvent[] {
    return this.collisionEvents.slice();
  }

  // ==========================================================================
  // 内部辅助方法
  // ==========================================================================

  private resetDynamicCounters(initialStepSize: number): void {
    this.simTime = 0;
    this.cumulativeEnergyLoss = 0;
    this.collisionEvents = [];
    this.collisionCounter = 0;
    this.substepsThisFrame = 0;
    this.substepClamped = false;
    this.lastStepSize = initialStepSize;

    this.referenceEnergy = computeEnergyMetrics(
      this.bodies,
      this.config.G,
      this.config.softening
    ).total;
    this.markWorkspaceDirty(true);
  }

  private markWorkspaceDirty(resetSuggestedDt: boolean): void {
    this.workspaceDirty = true;
    invalidateWorkspaceCache(this.workspace, resetSuggestedDt);
  }

  private tryResolveCurrentCollisions(): {
    merged: boolean;
    events: CollisionEvent[];
  } {
    const resolved = resolveCollisions(
      this.bodies,
      this.simTime,
      this.config.G,
      this.config.softening,
      () => `collision-${++this.collisionCounter}`
    );

    if (!resolved.merged) {
      return { merged: false, events: [] };
    }

    this.bodies = resolved.bodies;
    this.minPairDistance = computeMinPairDistance(this.bodies);
    this.collisionEvents.push(...resolved.events);
    this.cumulativeEnergyLoss += resolved.totalEnergyLoss;

    // 碰撞后自动重置能量守恒基准，使 relativeDrift 从 0 重新平滑统计
    this.referenceEnergy = computeEnergyMetrics(
      this.bodies,
      this.config.G,
      this.config.softening
    ).total;

    this.markWorkspaceDirty(false);

    // 若原跟踪的三体行星在碰撞中被吞并，更新热力学追踪器状态
    if (this.thermoTracker) {
      const stillExists = this.bodies.some(
        (b) => b.id === this.thermoTracker!.getPlanetId() && b.role === 'planet'
      );
      if (!stillExists) {
        this.reinitializeThermodynamics();
      }
    }

    return { merged: true, events: resolved.events };
  }

  private reinitializeThermodynamics(): void {
    const planet = this.bodies.find((b) => b.role === 'planet');
    if (!planet || !this.config.enablePlanetTelemetry) {
      this.thermoTracker = null;
      this.latestPlanetTelemetry = null;
      return;
    }

    const stars = this.bodies.filter((b) => b.role === 'star');
    this.thermoTracker = new PlanetThermodynamicsTracker(
      planet,
      stars,
      this.simTime,
      0
    );
    this.latestPlanetTelemetry = this.thermoTracker.evaluate(planet, stars);
  }

  private refreshPlanetTelemetrySnapshot(): void {
    if (!this.config.enablePlanetTelemetry) {
      this.latestPlanetTelemetry = null;
      return;
    }

    const planet = this.bodies.find((b) => b.role === 'planet');
    if (!planet) {
      this.thermoTracker = null;
      this.latestPlanetTelemetry = null;
      return;
    }

    const stars = this.bodies.filter((b) => b.role === 'star');
    if (!this.thermoTracker || this.thermoTracker.getPlanetId() !== planet.id) {
      this.thermoTracker = new PlanetThermodynamicsTracker(
        planet,
        stars,
        this.simTime,
        0
      );
    }

    this.latestPlanetTelemetry = this.thermoTracker.evaluate(planet, stars);
  }

  private stepThermodynamicsWithCurrentBodies(dt: number, currentSimTime: number): void {
    if (!this.thermoTracker || !this.config.enablePlanetTelemetry) return;
    const planet = this.bodies.find((b) => b.role === 'planet');
    if (!planet) return;
    const stars = this.bodies.filter((b) => b.role === 'star');
    this.latestPlanetTelemetry = this.thermoTracker.step(
      planet,
      stars,
      dt,
      currentSimTime,
      this.config.planetRotationRate
    );
  }

  private stepThermodynamicsFromFlatState(
    stateY: Float64Array,
    dt: number,
    currentSimTime: number
  ): void {
    if (!this.thermoTracker || !this.config.enablePlanetTelemetry) return;

    let planetView: BodyState | null = null;
    const starViews: BodyState[] = [];

    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const i3 = i * 3;
      const pos: Vec3 = [stateY[i3], stateY[i3 + 1], stateY[i3 + 2]];
      if (b.role === 'planet' && planetView === null) {
        planetView = { ...b, position: pos };
      } else if (b.role === 'star') {
        starViews.push({ ...b, position: pos });
      }
    }

    if (!planetView) return;
    this.latestPlanetTelemetry = this.thermoTracker.step(
      planetView,
      starViews,
      dt,
      currentSimTime,
      this.config.planetRotationRate
    );
  }

  private generateUniqueId(prefix: string): string {
    let candidate: string;
    do {
      candidate = `${prefix}-${++this.bodyIdCounter}`;
    } while (this.bodies.some((b) => b.id === candidate));
    return candidate;
  }

  private createBodyFromInput(input: NewBodyInput): BodyState {
    const isPlanet = input.role === 'planet';
    const mass = Math.max(input.mass, 1e-12);
    const id = isPlanet
      ? this.bodies.some((b) => b.id === 'trisolaris-planet')
        ? this.generateUniqueId('planet')
        : 'trisolaris-planet'
      : this.generateUniqueId('star');

    const color =
      input.color ??
      (isPlanet
        ? '#38bdf8'
        : STAR_COLOR_PALETTE[this.bodies.length % STAR_COLOR_PALETTE.length]);

    const isTestParticle =
      input.isTestParticle !== undefined
        ? input.isTestParticle
        : isPlanet
          ? this.config.planetAsTestParticle
          : false;

    return {
      id,
      name: input.name ?? (isPlanet ? '三体行星' : `恒星 #${this.bodies.length + 1}`),
      role: input.role,
      mass,
      position: cloneVec3(input.position),
      velocity: cloneVec3(input.velocity),
      color,
      emissiveIntensity:
        input.emissiveIntensity ?? (isPlanet ? 0.35 : 2.6),
      renderRadius:
        input.renderRadius ?? (isPlanet ? 0.032 : 0.075 * Math.cbrt(mass)),
      collisionRadius:
        input.collisionRadius ?? (isPlanet ? 0.008 : 0.025 * Math.cbrt(mass)),
      isTestParticle,
      acceleration: [0, 0, 0],
      force: [0, 0, 0],
      luminosity: computeLuminosity(input.role, mass),
    };
  }

  private createDefaultNewStar(): BodyState {
    // 围绕当前质心在外围轨道放置一颗新恒星，尽量避免重叠与逃逸
    const metrics = computeEnergyMetrics(
      this.bodies,
      this.config.G,
      this.config.softening
    );
    const [cx, cy, cz] = metrics.centerOfMass;
    const [cvx, cvy, cvz] = metrics.centerOfMassVelocity;

    let totalStarMass = 0;
    let maxDist = 1.4;
    for (const b of this.bodies) {
      if (!b.isTestParticle) totalStarMass += b.mass;
      const d = Math.hypot(
        b.position[0] - cx,
        b.position[1] - cy,
        b.position[2] - cz
      );
      if (d > maxDist) maxDist = d;
    }

    const orbitR = Math.min(Math.max(maxDist * 1.15, 1.8), 4.5);
    const angle = (this.bodies.length * 2.399963229728653) % (2 * Math.PI);
    const mass = 0.85;
    const speed = Math.sqrt(
      (this.config.G * Math.max(totalStarMass, 0.5)) / orbitR
    ) * 0.85;

    const pos: Vec3 = [
      cx + orbitR * Math.cos(angle),
      cy + orbitR * Math.sin(angle),
      cz + ((this.bodies.length % 2 === 0 ? 1 : -1) * 0.25),
    ];
    const vel: Vec3 = [
      cvx - speed * Math.sin(angle),
      cvy + speed * Math.cos(angle),
      cvz,
    ];

    return this.createBodyFromInput({
      role: 'star',
      name: `恒星 #${this.bodies.length + 1}`,
      mass,
      position: pos,
      velocity: vel,
    });
  }

  private cloneBodies(list: readonly BodyState[]): BodyState[] {
    return list.map((b) => ({
      ...b,
      position: cloneVec3(b.position),
      velocity: cloneVec3(b.velocity),
      acceleration: cloneVec3(b.acceleration),
      force: cloneVec3(b.force),
    }));
  }
}
