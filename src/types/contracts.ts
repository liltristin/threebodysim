/**
 * 3D 三体运动模拟器 — 跨层冻结共享接口契约（Phase 0）
 *
 * 架构解耦约定：
 * - `src/physics/`：纯 TypeScript 物理内核，严禁引入 React 或 Three.js，仅依赖本契约与预设。
 * - `src/scene/`：原生 Three.js 渲染引擎，实现 `ISceneRenderer`，严禁引入 React。
 * - `src/engine/`：`SimulationController` 调度层，桥接物理与渲染，以 10~15 Hz 节流推送 `HudSnapshot`。
 * - `src/ui/`：React 深空科幻 HUD，只消费 `HudSnapshot` 并调用 `SimulationActions`。
 *
 * 三体行星热力学校准约定（物理层与渲染层共享基准）：
 * - 长度单位映射：`1 L = 1 AU`；引力常数默认 `G = 1.0`。
 * - 恒星无量纲光度估算：`L_i = M_i^3.5`（行星光度为 0）。
 * - 辐射通量：`F = Σ L_i / (r_i² + ε_rad²)`。
 * - 基准校准：`chaotic-trisolaris` 预设初始通量 `F_ref ≈ 6.375` 对应平衡温度 `T_eq ≈ 295K (+22°C)`，
 *   即 `normalizedFlux = F / F_ref ≈ 1.0` 时处于宜居带（`0°C ~ 45°C`）中段；
 *   斯特藩-玻尔兹曼演化方程 `dT/dt = α * F - β * T⁴` 满足 `(α / β) * F_ref = (295K)⁴`，
 *   使近地视角大气色温插值与行星恒/乱纪元判定共享同一温度标度（典型物理区间约 `-200°C ~ +500°C`）。
 */

// ============================================================================
// 公共常量
// ============================================================================

/** 系统允许的最少天体数量 */
export const MIN_BODIES = 2;

/** 系统允许的最多天体数量 */
export const MAX_BODIES = 8;

/** 三体行星宜居带温度下限（摄氏度） */
export const HABITABLE_TEMP_MIN_C = 0;

/** 三体行星宜居带温度上限（摄氏度） */
export const HABITABLE_TEMP_MAX_C = 45;

// ============================================================================
// 基础数学与物理类型
// ============================================================================

/** 只读三维向量 [x, y, z] */
export type Vec3 = readonly [number, number, number];

/** 可变三维向量 [x, y, z]（仅用于物理内部缓冲区计算） */
export type MutableVec3 = [number, number, number];

/** 数值积分器类型 */
export type IntegratorType = 'dopri54' | 'verlet';

/** 天体角色分类 */
export type BodyRole = 'star' | 'planet';

// ============================================================================
// 预设与天体状态类型
// ============================================================================

export interface PresetBodyConfig {
  readonly id: string;
  readonly name: string;
  readonly role: BodyRole;
  readonly mass: number;
  readonly position: Vec3;
  readonly velocity: Vec3;
  /** 基础颜色（十六进制，用于 UI 标识与轨迹渐变） */
  readonly color: string;
  /** HDR 自发光强度（恒星 > 1.0 触发选择性 Bloom，行星 <= 1.0） */
  readonly emissiveIntensity: number;
  /** 视觉渲染半径（与物理碰撞半径解耦） */
  readonly renderRadius: number;
  /** 物理碰撞判定半径 */
  readonly collisionRadius: number;
  /** 仅行星生效：是否作为零反作用测试粒子（限制性 N 体） */
  readonly isTestParticle?: boolean;
}

export interface PresetDefinition {
  readonly id: string;
  readonly name: string;
  readonly subtitle: string;
  readonly description: string;
  /** 推荐引力常数 */
  readonly G: number;
  /**
   * 预设绑定软化项：
   * 精密周期解强制为 0，混沌/随机系统可启用小软化值防止极端奇点
   */
  readonly defaultSoftening: number;
  /** 推荐默认积分器 */
  readonly defaultIntegrator: IntegratorType;
  /** DOPRI5(4) 推荐相对误差容限 */
  readonly recommendedRtol: number;
  /** Velocity Verlet 推荐固定子步长 */
  readonly recommendedVerletDt: number;
  /** 推荐播放时间倍速 */
  readonly defaultTimeScale: number;
  /** 相机初始距离 */
  readonly defaultCameraDistance: number;
  /** 轨迹环形缓冲区建议最大点数 */
  readonly recommendedTrailLength: number;
  /** 理论周期（仅周期解填写，供 Vitest 回归验证用） */
  readonly expectedPeriod?: number;
  /** 是否默认激活三体行星温度与恒/乱纪元监控 */
  readonly hasTrisolarisPlanet: boolean;
  readonly bodies: readonly PresetBodyConfig[];
}

export interface BodyState extends PresetBodyConfig {
  /** 是否作为零反作用测试粒子（运行时必填） */
  readonly isTestParticle: boolean;
  /** 当前瞬时合加速度向量 */
  readonly acceleration: Vec3;
  /** 当前瞬时合引力向量（用于渲染层引力箭头可视化） */
  readonly force: Vec3;
  /** 恒星无量纲光度（L = M^3.5；行星为 0） */
  readonly luminosity: number;
}

// ============================================================================
// 仿真配置、守恒量与碰撞事件
// ============================================================================

export interface SimulationConfig {
  readonly G: number;
  readonly softening: number;
  readonly integrator: IntegratorType;
  readonly rtol: number;
  readonly atol: number;
  readonly verletDt: number;
  readonly timeScale: number;
  readonly enableCollisions: boolean;
  readonly enableAutoSlowMo: boolean;
  readonly planetAsTestParticle: boolean;
  readonly planetRotationRate: number;
  readonly enablePlanetTelemetry: boolean;
}

export interface EnergyMetrics {
  readonly kinetic: number;
  readonly potential: number;
  readonly total: number;
  readonly referenceEnergy: number;
  readonly relativeDrift: number;
  readonly angularMomentum: Vec3;
  readonly angularMomentumMag: number;
  readonly centerOfMass: Vec3;
  readonly centerOfMassVelocity: Vec3;
  readonly cumulativeEnergyLoss: number;
}

export interface CollisionEvent {
  readonly id: string;
  readonly simTime: number;
  readonly absorbedNames: readonly [string, string];
  readonly survivorId: string;
  readonly survivorName: string;
  readonly newMass: number;
  readonly energyLoss: number;
  readonly position: Vec3;
}

// ============================================================================
// 三体行星热力学、天象观测与恒/乱纪元状态机
// ============================================================================

export type EraType = 'stable' | 'chaotic';

export type EraSubState =
  | 'habitable'
  | 'scorching'
  | 'freezing'
  | 'rapid-heating'
  | 'rapid-cooling'
  | 'unstable-flux';

export type AstronomicalEvent =
  | 'none'
  | 'tri-solar-day'
  | 'flying-stars'
  | 'single-sun-stable'
  | 'bi-solar-glare';

export interface EraStatus {
  readonly era: EraType;
  readonly subState: EraSubState;
  readonly label: string;
  readonly event: AstronomicalEvent;
  readonly eventLabel: string | null;
  readonly eraDuration: number;
  readonly longestStableDuration: number;
}

export interface StarSkyObservation {
  readonly starId: string;
  readonly starName: string;
  readonly color: string;
  readonly distance: number;
  readonly angularDiameter: number;
  readonly elevationRad: number;
  readonly azimuthRad: number;
  readonly fluxShare: number;
  readonly isAboveHorizon: boolean;
  readonly isFlyingStar: boolean;
}

export interface PlanetTelemetry {
  readonly planetId: string;
  readonly temperatureK: number;
  readonly temperatureC: number;
  readonly equilibriumTempC: number;
  readonly tempRateCPerSimTime: number;
  readonly normalizedFlux: number;
  readonly rotationAngle: number;
  readonly visibleSunCount: number;
  readonly skyObservations: readonly StarSkyObservation[];
  readonly eraStatus: EraStatus;
}

// ============================================================================
// 物理步进快照与返回契约
// ============================================================================

export interface PhysicsSnapshot {
  readonly simTime: number;
  readonly bodies: readonly BodyState[];
  readonly metrics: EnergyMetrics;
  readonly planetTelemetry: PlanetTelemetry | null;
  readonly effectiveTimeScale: number;
  readonly isAutoSlowMoActive: boolean;
  readonly lastStepSize: number;
  readonly substepsThisFrame: number;
  readonly substepClamped: boolean;
  readonly minPairDistance: number;
}

export interface PhysicsStepResult {
  readonly snapshot: PhysicsSnapshot;
  readonly newCollisions: readonly CollisionEvent[];
  readonly bodiesChanged: boolean;
}

// ============================================================================
// 渲染层契约（Three.js 渲染引擎）
// ============================================================================

export type CameraMode = 'free' | 'com' | 'follow' | 'planet-surface';

/** 渲染质量与帧率分级模式（high: 桌面高画质；performance: 移动端高帧率） */
export type QualityMode = 'high' | 'performance';

export interface VisualOptions {
  readonly qualityMode: QualityMode;
  readonly showTrails: boolean;
  readonly trailLength: number;
  readonly showVelocityVectors: boolean;
  readonly showForceVectors: boolean;
  readonly showCenterOfMass: boolean;
  readonly showReferenceGrid: boolean;
  readonly enableBloom: boolean;
  readonly bloomStrength: number;
}

export const DEFAULT_VISUAL_OPTIONS: VisualOptions = {
  qualityMode: 'high',
  showTrails: true,
  trailLength: 900,
  showVelocityVectors: false,
  showForceVectors: false,
  showCenterOfMass: true,
  showReferenceGrid: true,
  enableBloom: true,
  bloomStrength: 0.85,
};

export interface CameraState {
  readonly mode: CameraMode;
  readonly targetBodyId: string | null;
}

export interface ISceneRenderer {
  init(
    container: HTMLElement,
    initialBodies: readonly BodyState[],
    initialVisuals: VisualOptions,
    defaultCameraDistance?: number
  ): void;
  resize(width: number, height: number): void;
  renderFrame(snapshot: PhysicsSnapshot, deltaSeconds: number): void;
  syncBodies(bodies: readonly BodyState[], clearTrails?: boolean): void;
  clearTrails(): void;
  setCameraMode(mode: CameraMode, targetBodyId?: string | null): void;
  resetCameraView(distance?: number): void;
  setVisualOptions(options: Partial<VisualOptions>): void;
  syncSurfaceView(
    temperatureC: number,
    rotationAngle: number,
    planetId?: string | null
  ): void;
  dispose(): void;
}

// ============================================================================
// 控制层对外给 UI 的契约
// ============================================================================

export interface EnergyHistoryPoint {
  readonly simTime: number;
  readonly relativeDrift: number;
  readonly totalEnergy: number;
}

export interface TemperatureHistoryPoint {
  readonly simTime: number;
  readonly temperatureC: number;
  readonly era: EraType;
}

export interface HudSnapshot {
  readonly isRunning: boolean;
  readonly simTime: number;
  /** 当前激活预设 ID；随机生成或脱离预设时可为 null */
  readonly presetId: string | null;
  readonly config: SimulationConfig;
  readonly visualOptions: VisualOptions;
  readonly cameraState: CameraState;
  readonly bodies: readonly BodyState[];
  readonly metrics: EnergyMetrics;
  readonly planetTelemetry: PlanetTelemetry | null;
  readonly effectiveTimeScale: number;
  readonly isAutoSlowMoActive: boolean;
  readonly lastStepSize: number;
  readonly substepClamped: boolean;
  readonly minPairDistance: number;
  readonly fps: number;
  readonly energyHistory: readonly EnergyHistoryPoint[];
  readonly collisionEvents: readonly CollisionEvent[];
  readonly temperatureHistory: readonly TemperatureHistoryPoint[];
}

export interface BodyPatch {
  readonly name?: string;
  readonly mass?: number;
  readonly position?: Vec3;
  readonly velocity?: Vec3;
  readonly color?: string;
  readonly renderRadius?: number;
  readonly collisionRadius?: number;
  readonly emissiveIntensity?: number;
  readonly isTestParticle?: boolean;
}

export interface NewBodyInput {
  readonly name?: string;
  readonly role: BodyRole;
  readonly mass: number;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly color?: string;
  readonly renderRadius?: number;
  readonly collisionRadius?: number;
  readonly emissiveIntensity?: number;
  readonly isTestParticle?: boolean;
}

export interface SimulationActions {
  readonly play: () => void;
  readonly pause: () => void;
  readonly togglePlay: () => void;
  readonly stepOnce: (dt?: number) => void;
  readonly reset: () => void;
  readonly randomize: (bodyCount?: number) => void;
  readonly setTimeScale: (scale: number) => void;
  readonly setAutoSlowMo: (enabled: boolean) => void;
  readonly loadPreset: (presetId: string) => void;
  readonly setIntegrator: (integrator: IntegratorType) => void;
  readonly setSoftening: (softening: number) => void;
  readonly setEnableCollisions: (enabled: boolean) => void;
  readonly setPlanetAsTestParticle: (enabled: boolean) => void;
  readonly setPlanetRotationRate: (rate: number) => void;
  readonly normalizeCenterOfMass: () => void;
  readonly addBody: (input?: NewBodyInput) => void;
  readonly addTrisolarisPlanet: () => void;
  readonly removeBody: (bodyId: string) => void;
  readonly updateBody: (bodyId: string, patch: BodyPatch) => void;
  readonly setCameraMode: (mode: CameraMode, targetBodyId?: string | null) => void;
  readonly resetCameraView: () => void;
  readonly updateVisualOptions: (patch: Partial<VisualOptions>) => void;
  readonly setQualityMode: (mode: QualityMode) => void;
  readonly clearTrails: () => void;
}
