/**
 * 仿真调度控制层（SimulationController）
 *
 * 职责边界：
 * - 持有并桥接纯 TS 物理引擎（PhysicsEngine）与原生 Three.js 渲染引擎（ISceneRenderer）。
 * - 在 requestAnimationFrame 主循环中执行单帧步长钳制（<= 0.05s）、平滑 FPS 统计、
 *   近距自动慢动作指数平滑调制，并每帧驱动 renderer.renderFrame。
 * - 严禁每帧推送 React 状态：以 10~15 Hz（默认 80ms）节流向 UI 推送只读 HudSnapshot；
 *   在用户交互、碰撞合并、单步推进或切换预设时立即推送并确保暂停态画面实时响应。
 * - 维护有界环形历史缓冲区（energyHistory / temperatureHistory，默认上限 300 点）。
 * - 严格兼容 React 18 StrictMode 双重挂载/卸载，dispose() 全量释放 rAF、订阅与 WebGL 资源。
 */

import { PhysicsEngine } from '../physics';
import { DEFAULT_PRESET_ID, PRESET_MAP } from '../presets/presets';
import { SceneRenderer } from '../scene';
import {
  DEFAULT_VISUAL_OPTIONS,
  type BodyPatch,
  type CameraMode,
  type CameraState,
  type EnergyHistoryPoint,
  type HudSnapshot,
  type IntegratorType,
  type ISceneRenderer,
  type NewBodyInput,
  type PhysicsSnapshot,
  type PhysicsStepResult,
  type QualityMode,
  type SimulationActions,
  type TemperatureHistoryPoint,
  type VisualOptions,
} from '../types/contracts';

/** 单帧物理最大增量（秒），防止切换浏览器标签页后产生时间跳变 */
const MAX_FRAME_DELTA_SECONDS = 0.05;

/** 移动端 / 性能模式轨迹默认上限（降低顶点缓冲与着色器开销） */
export const PERFORMANCE_MAX_TRAIL_LENGTH = 400;

/** 移动端 / 性能模式 HUD 节流间隔（毫秒）：125ms = 8 Hz */
export const MOBILE_HUD_THROTTLE_MS = 125;

/** 桌面端 / 高画质模式 HUD 节流间隔（毫秒）：80ms ≈ 12.5 Hz，位于 10~15 Hz 规范区间 */
export const DESKTOP_HUD_THROTTLE_MS = 80;

/** 默认曲线历史最大点数 */
const DEFAULT_MAX_HISTORY_POINTS = 300;

/** 随机生成系统的默认相机观测距离 */
const RANDOM_SYSTEM_CAMERA_DISTANCE = 6.5;

/** 自动慢动作指数平滑时间常数（秒）：减速响应快、恢复自然平滑 */
const SLOWMO_TAU_DOWN_SECONDS = 0.06;
const SLOWMO_TAU_UP_SECONDS = 0.22;

/**
 * 自动探测默认渲染分级模式：
 * - 触屏粗指针（pointer: coarse）或窄屏（< 768px）默认进入 'performance' 高帧率模式；
 * - 其余桌面端与无头 Node 测试环境默认 'high'。
 */
export function detectDefaultQualityMode(): QualityMode {
  if (typeof window === 'undefined') {
    return 'high';
  }
  const isCoarsePointer =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  if (isCoarsePointer || window.innerWidth < 768) {
    return 'performance';
  }
  return 'high';
}

export type HudListener = (snapshot: HudSnapshot) => void;

export interface SimulationControllerOptions {
  /** 初始预设 ID（默认 DEFAULT_PRESET_ID = 'figure-8'） */
  readonly initialPresetId?: string;
  /** 初始渲染质量分级（默认按 detectDefaultQualityMode() 自动探测） */
  readonly initialQualityMode?: QualityMode;
  /** 可选自定义渲染器实现（默认 new SceneRenderer()；便于无头集成测试注入 mock） */
  readonly renderer?: ISceneRenderer;
  /** 可选自定义物理引擎实例 */
  readonly physics?: PhysicsEngine;
  /** HUD 节流推送间隔（毫秒；未传时按质量模式自动采用 80ms / 125ms） */
  readonly hudThrottleMs?: number;
  /** 能量/温度历史曲线最大点数（默认 300） */
  readonly maxHistoryPoints?: number;
  /** 挂载后是否默认处于运行态（默认 true） */
  readonly autoStart?: boolean;
}

/**
 * 固定容量环形缓冲区（用于能量漂移曲线与行星温度曲线历史）
 * - O(1) 写入，无头部 shift 开销
 * - 懒生成只读数组快照，未写入时不重复分配
 */
class RingHistory<T> {
  private readonly buffer: (T | undefined)[];
  private readonly capacity: number;
  private head = 0;
  private size = 0;
  private cached: readonly T[] | null = [];

  constructor(capacity: number) {
    this.capacity = Math.max(2, Math.floor(capacity));
    this.buffer = new Array<T | undefined>(this.capacity);
  }

  public get length(): number {
    return this.size;
  }

  public last(): T | undefined {
    if (this.size === 0) return undefined;
    const idx = (this.head + this.size - 1) % this.capacity;
    return this.buffer[idx];
  }

  public push(item: T): void {
    if (this.size < this.capacity) {
      this.buffer[(this.head + this.size) % this.capacity] = item;
      this.size += 1;
    } else {
      this.buffer[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
    }
    this.cached = null;
  }

  public clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.size = 0;
    this.cached = [];
  }

  public toArray(): readonly T[] {
    if (this.cached !== null) {
      return this.cached;
    }
    const out = new Array<T>(this.size);
    for (let i = 0; i < this.size; i++) {
      out[i] = this.buffer[(this.head + i) % this.capacity] as T;
    }
    this.cached = out;
    return out;
  }
}

export class SimulationController {
  private readonly physics: PhysicsEngine;
  private readonly renderer: ISceneRenderer;
  private readonly hasCustomHudThrottle: boolean;
  private hudThrottleMs: number;

  private readonly energyHistory: RingHistory<EnergyHistoryPoint>;
  private readonly temperatureHistory: RingHistory<TemperatureHistoryPoint>;
  private readonly listeners = new Set<HudListener>();

  private isRunning: boolean;
  private mounted = false;
  private disposed = false;

  private visualOptions: VisualOptions;
  private cameraState: CameraState = { mode: 'free', targetBodyId: null };
  private defaultCameraDistance: number;

  private smoothedSlowMoFactor = 1.0;
  private smoothedFps = 60;
  private latestSnapshot: PhysicsSnapshot;

  private rafId: number | null = null;
  private lastFrameTimeMs: number | null = null;
  private hudElapsedSinceEmitMs = 0;

  private readonly actions: SimulationActions;

  constructor(options?: SimulationControllerOptions) {
    const initialPresetId = options?.initialPresetId ?? DEFAULT_PRESET_ID;
    const preset = PRESET_MAP[initialPresetId] ?? PRESET_MAP[DEFAULT_PRESET_ID];
    const initialQualityMode: QualityMode =
      options?.initialQualityMode ?? detectDefaultQualityMode();

    this.physics = options?.physics ?? new PhysicsEngine(preset.id);
    this.renderer = options?.renderer ?? new SceneRenderer();
    this.hasCustomHudThrottle = options?.hudThrottleMs !== undefined;
    this.hudThrottleMs = this.hasCustomHudThrottle
      ? Math.max(16, options!.hudThrottleMs!)
      : initialQualityMode === 'performance'
        ? MOBILE_HUD_THROTTLE_MS
        : DESKTOP_HUD_THROTTLE_MS;
    this.isRunning = options?.autoStart ?? true;

    const maxHistoryPoints = options?.maxHistoryPoints ?? DEFAULT_MAX_HISTORY_POINTS;
    this.energyHistory = new RingHistory<EnergyHistoryPoint>(maxHistoryPoints);
    this.temperatureHistory = new RingHistory<TemperatureHistoryPoint>(maxHistoryPoints);

    const activePresetId = this.physics.getPresetId();
    const activePreset = activePresetId ? PRESET_MAP[activePresetId] : undefined;
    const recommendedTrail =
      activePreset?.recommendedTrailLength ?? DEFAULT_VISUAL_OPTIONS.trailLength;
    const initialTrailLength =
      initialQualityMode === 'performance'
        ? Math.min(recommendedTrail, PERFORMANCE_MAX_TRAIL_LENGTH)
        : recommendedTrail;

    this.visualOptions = {
      ...DEFAULT_VISUAL_OPTIONS,
      qualityMode: initialQualityMode,
      trailLength: initialTrailLength,
    };
    this.defaultCameraDistance = activePreset?.defaultCameraDistance ?? 5.5;

    this.smoothedSlowMoFactor = this.physics.computeAutoSlowMoFactor().factor;
    this.latestSnapshot = this.buildConsistentSnapshot(this.physics.getSnapshot());
    this.resetAndSeedHistories(this.latestSnapshot);

    this.actions = this.createBoundActions();
  }

  /**
   * 获取引用稳定的全部 24 项 SimulationActions（供 React UI 直接消费，不触发子组件重绑事件）
   */
  public getActions(): SimulationActions {
    return this.actions;
  }

  /**
   * 挂载 3D 渲染容器并启动 requestAnimationFrame 主循环
   */
  public mount(container: HTMLElement): void {
    if (this.disposed) return;

    this.mounted = true;
    this.renderer.init(
      container,
      this.latestSnapshot.bodies,
      this.visualOptions,
      this.defaultCameraDistance
    );
    this.renderer.setCameraMode(this.cameraState.mode, this.cameraState.targetBodyId);
    this.syncRendererSurfaceIfNeeded(this.latestSnapshot);
    this.renderer.renderFrame(this.latestSnapshot, 0);

    this.lastFrameTimeMs = null;
    this.emitHudNow();
    this.scheduleNextFrame();
  }

  /**
   * 响应容器尺寸变化
   */
  public resize(width: number, height: number): void {
    if (this.disposed || !this.mounted) return;
    if (width <= 0 || height <= 0) return;
    this.renderer.resize(width, height);
  }

  /**
   * 订阅节流后的 HudSnapshot 更新；返回取消订阅函数
   */
  public subscribe(listener: HudListener): () => void {
    if (this.disposed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 同步获取当前最新完整 HudSnapshot
   */
  public getHudSnapshot(): HudSnapshot {
    return {
      isRunning: this.isRunning,
      simTime: this.latestSnapshot.simTime,
      presetId: this.physics.getPresetId(),
      config: this.physics.getConfig(),
      visualOptions: this.visualOptions,
      cameraState: this.cameraState,
      bodies: this.latestSnapshot.bodies,
      metrics: this.latestSnapshot.metrics,
      planetTelemetry: this.latestSnapshot.planetTelemetry,
      effectiveTimeScale: this.latestSnapshot.effectiveTimeScale,
      isAutoSlowMoActive: this.latestSnapshot.isAutoSlowMoActive,
      lastStepSize: this.latestSnapshot.lastStepSize,
      substepClamped: this.latestSnapshot.substepClamped,
      minPairDistance: this.latestSnapshot.minPairDistance,
      fps: this.smoothedFps,
      energyHistory: this.energyHistory.toArray(),
      collisionEvents: this.physics.getCollisionEvents(),
      temperatureHistory: this.temperatureHistory.toArray(),
    };
  }

  /**
   * 推进一帧仿真与渲染（供 rAF 回调与无头集成测试复用）
   */
  public tickFrame(nowMs: number): void {
    if (this.disposed) return;

    let rawDtMs = 16.6667;
    if (this.lastFrameTimeMs !== null) {
      rawDtMs = Math.max(0, nowMs - this.lastFrameTimeMs);
    }
    this.lastFrameTimeMs = nowMs;

    if (rawDtMs > 0.5 && rawDtMs < 1000) {
      const instFps = Math.min(1000 / rawDtMs, 240);
      this.smoothedFps = this.smoothedFps * 0.9 + instFps * 0.1;
    }

    const deltaSeconds = Math.min(rawDtMs / 1000, MAX_FRAME_DELTA_SECONDS);
    this.hudElapsedSinceEmitMs += rawDtMs;

    let forceImmediateHud = false;

    if (this.isRunning && deltaSeconds > 0) {
      const config = this.physics.getConfig();
      const targetSlowMo = this.physics.computeAutoSlowMoFactor();

      if (!config.enableAutoSlowMo) {
        this.smoothedSlowMoFactor = 1.0;
      } else {
        const tau =
          targetSlowMo.factor < this.smoothedSlowMoFactor
            ? SLOWMO_TAU_DOWN_SECONDS
            : SLOWMO_TAU_UP_SECONDS;
        const alpha = 1 - Math.exp(-deltaSeconds / tau);
        this.smoothedSlowMoFactor +=
          (targetSlowMo.factor - this.smoothedSlowMoFactor) * alpha;
        this.smoothedSlowMoFactor = Math.max(
          0.05,
          Math.min(1.0, this.smoothedSlowMoFactor)
        );
        if (
          targetSlowMo.factor >= 0.999 &&
          Math.abs(1.0 - this.smoothedSlowMoFactor) < 0.002
        ) {
          this.smoothedSlowMoFactor = 1.0;
        }
      }

      const effectiveTimeScale = config.timeScale * this.smoothedSlowMoFactor;
      const isAutoSlowMoActive =
        config.enableAutoSlowMo &&
        (targetSlowMo.active || this.smoothedSlowMoFactor < 0.96);

      const simDt = deltaSeconds * effectiveTimeScale;
      const stepResult = this.physics.step(simDt);

      const consistentSnapshot: PhysicsSnapshot = {
        ...stepResult.snapshot,
        effectiveTimeScale,
        isAutoSlowMoActive,
      };
      this.latestSnapshot = consistentSnapshot;

      forceImmediateHud = this.handlePostStepChanges(stepResult, consistentSnapshot);

      const dueForHud = this.hudElapsedSinceEmitMs >= this.hudThrottleMs;
      if (forceImmediateHud || dueForHud) {
        this.appendHistorySamples(consistentSnapshot, forceImmediateHud);
      }
    }

    // 每帧驱动 3D 渲染（暂停态仍继续驱动 OrbitControls 阻尼与近地交互）
    if (this.mounted) {
      this.renderer.renderFrame(this.latestSnapshot, deltaSeconds);
    }

    // 节流推送 HUD（10~15 Hz），碰撞或天体拓扑变更时立即推送
    if (forceImmediateHud || this.hudElapsedSinceEmitMs >= this.hudThrottleMs) {
      this.emitHudNow();
    }
  }

  /**
   * 销毁控制器：取消 rAF、清空全部 UI 订阅并释放渲染器（幂等，兼容 StrictMode 双重卸载）
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mounted = false;

    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
    this.listeners.clear();
    this.renderer.dispose();
  }

  // ============================================================================
  // 24 项 SimulationActions 实现
  // ============================================================================

  private createBoundActions(): SimulationActions {
    return {
      play: () => this.play(),
      pause: () => this.pause(),
      togglePlay: () => this.togglePlay(),
      stepOnce: (dt?: number) => this.stepOnce(dt),
      reset: () => this.reset(),
      randomize: (bodyCount?: number) => this.randomize(bodyCount),
      setTimeScale: (scale: number) => this.setTimeScale(scale),
      setAutoSlowMo: (enabled: boolean) => this.setAutoSlowMo(enabled),
      loadPreset: (presetId: string) => this.loadPreset(presetId),
      setIntegrator: (integrator: IntegratorType) => this.setIntegrator(integrator),
      setSoftening: (softening: number) => this.setSoftening(softening),
      setEnableCollisions: (enabled: boolean) => this.setEnableCollisions(enabled),
      setPlanetAsTestParticle: (enabled: boolean) =>
        this.setPlanetAsTestParticle(enabled),
      setPlanetRotationRate: (rate: number) => this.setPlanetRotationRate(rate),
      normalizeCenterOfMass: () => this.normalizeCenterOfMass(),
      addBody: (input?: NewBodyInput) => this.addBody(input),
      addTrisolarisPlanet: () => this.addTrisolarisPlanet(),
      removeBody: (bodyId: string) => this.removeBody(bodyId),
      updateBody: (bodyId: string, patch: BodyPatch) =>
        this.updateBody(bodyId, patch),
      setCameraMode: (mode: CameraMode, targetBodyId?: string | null) =>
        this.setCameraMode(mode, targetBodyId),
      resetCameraView: () => this.resetCameraView(),
      updateVisualOptions: (patch: Partial<VisualOptions>) =>
        this.updateVisualOptions(patch),
      setQualityMode: (mode: QualityMode) => this.setQualityMode(mode),
      clearTrails: () => this.clearTrails(),
    };
  }

  private play(): void {
    if (this.disposed || this.isRunning) return;
    this.isRunning = true;
    this.lastFrameTimeMs = null;
    this.emitHudNow();
  }

  private pause(): void {
    if (this.disposed || !this.isRunning) return;
    this.isRunning = false;
    this.emitHudNow();
  }

  private togglePlay(): void {
    if (this.disposed) return;
    if (this.isRunning) {
      this.pause();
    } else {
      this.play();
    }
  }

  private stepOnce(dt?: number): void {
    if (this.disposed) return;

    this.isRunning = false;
    const stepResult = this.physics.stepOnce(dt);
    this.smoothedSlowMoFactor = this.physics.computeAutoSlowMoFactor().factor;
    const consistentSnapshot = this.buildConsistentSnapshot(stepResult.snapshot);
    this.latestSnapshot = consistentSnapshot;

    this.handlePostStepChanges(stepResult, consistentSnapshot);
    this.appendHistorySamples(consistentSnapshot, true);

    this.syncRendererSurfaceIfNeeded(consistentSnapshot);
    this.renderImmediateIfMounted(consistentSnapshot);
    this.emitHudNow();
  }

  private reset(): void {
    if (this.disposed) return;

    const rawSnapshot = this.physics.reset();
    this.smoothedSlowMoFactor = this.physics.computeAutoSlowMoFactor().factor;
    const consistentSnapshot = this.buildConsistentSnapshot(rawSnapshot);
    this.latestSnapshot = consistentSnapshot;

    this.reconcileCameraAfterBodyChange(consistentSnapshot.bodies);
    this.resetAndSeedHistories(consistentSnapshot);

    if (this.mounted) {
      this.renderer.syncBodies(consistentSnapshot.bodies, true);
      this.syncRendererSurfaceIfNeeded(consistentSnapshot);
      this.renderer.renderFrame(consistentSnapshot, 0);
    }

    this.emitHudNow();
  }

  private randomize(bodyCount?: number): void {
    if (this.disposed) return;

    const rawSnapshot = this.physics.randomize(bodyCount);
    this.smoothedSlowMoFactor = this.physics.computeAutoSlowMoFactor().factor;
    const consistentSnapshot = this.buildConsistentSnapshot(rawSnapshot);
    this.latestSnapshot = consistentSnapshot;

    this.defaultCameraDistance = RANDOM_SYSTEM_CAMERA_DISTANCE;
    this.reconcileCameraAfterBodyChange(consistentSnapshot.bodies);
    this.resetAndSeedHistories(consistentSnapshot);

    if (this.mounted) {
      this.renderer.syncBodies(consistentSnapshot.bodies, true);
      this.renderer.resetCameraView(this.defaultCameraDistance);
      this.renderer.renderFrame(consistentSnapshot, 0);
    }

    this.emitHudNow();
  }

  private setTimeScale(scale: number): void {
    if (this.disposed || !Number.isFinite(scale)) return;
    const clamped = Math.max(0.01, Math.min(20, scale));
    this.physics.updateConfig({ timeScale: clamped });
    this.latestSnapshot = this.buildConsistentSnapshot(this.physics.getSnapshot());
    this.emitHudNow();
  }

  private setAutoSlowMo(enabled: boolean): void {
    if (this.disposed) return;
    this.physics.updateConfig({ enableAutoSlowMo: enabled });
    if (!enabled) {
      this.smoothedSlowMoFactor = 1.0;
    }
    this.latestSnapshot = this.buildConsistentSnapshot(this.physics.getSnapshot());
    this.emitHudNow();
  }

  private loadPreset(presetId: string): void {
    if (this.disposed) return;
    const preset = PRESET_MAP[presetId];
    if (!preset) return;

    const rawSnapshot = this.physics.loadPreset(presetId);
    this.smoothedSlowMoFactor = this.physics.computeAutoSlowMoFactor().factor;
    const consistentSnapshot = this.buildConsistentSnapshot(rawSnapshot);
    this.latestSnapshot = consistentSnapshot;

    // 同步预设推荐轨迹长度（按当前渲染分级收敛）与默认相机距离
    const nextTrailLength =
      this.visualOptions.qualityMode === 'performance'
        ? Math.min(preset.recommendedTrailLength, PERFORMANCE_MAX_TRAIL_LENGTH)
        : preset.recommendedTrailLength;

    this.visualOptions = {
      ...this.visualOptions,
      trailLength: nextTrailLength,
    };
    this.defaultCameraDistance = preset.defaultCameraDistance;

    // 若原相机目标在新预设中不存在（如由行星近地切至无行星预设），先安全回退至 'com'
    this.reconcileCameraAfterBodyChange(consistentSnapshot.bodies);
    this.resetAndSeedHistories(consistentSnapshot);

    if (this.mounted) {
      this.renderer.setVisualOptions({
        trailLength: nextTrailLength,
      });
      this.renderer.syncBodies(consistentSnapshot.bodies, true);
      this.syncRendererSurfaceIfNeeded(consistentSnapshot);
      this.renderer.resetCameraView(preset.defaultCameraDistance);
      this.renderer.renderFrame(consistentSnapshot, 0);
    }

    this.emitHudNow();
  }

  private setIntegrator(integrator: IntegratorType): void {
    if (this.disposed) return;
    this.physics.updateConfig({ integrator });
    this.latestSnapshot = this.buildConsistentSnapshot(this.physics.getSnapshot());
    this.emitHudNow();
  }

  private setSoftening(softening: number): void {
    if (this.disposed || !Number.isFinite(softening)) return;
    this.physics.updateConfig({ softening: Math.max(0, softening) });
    this.latestSnapshot = this.buildConsistentSnapshot(this.physics.getSnapshot());
    if (!this.isRunning) {
      this.renderImmediateIfMounted(this.latestSnapshot);
    }
    this.emitHudNow();
  }

  private setEnableCollisions(enabled: boolean): void {
    if (this.disposed) return;
    this.physics.updateConfig({ enableCollisions: enabled });
    this.latestSnapshot = this.buildConsistentSnapshot(this.physics.getSnapshot());
    this.emitHudNow();
  }

  private setPlanetAsTestParticle(enabled: boolean): void {
    if (this.disposed) return;
    this.physics.updateConfig({ planetAsTestParticle: enabled });
    this.latestSnapshot = this.buildConsistentSnapshot(this.physics.getSnapshot());
    if (!this.isRunning) {
      this.renderImmediateIfMounted(this.latestSnapshot);
    }
    this.emitHudNow();
  }

  private setPlanetRotationRate(rate: number): void {
    if (this.disposed || !Number.isFinite(rate)) return;
    this.physics.updateConfig({ planetRotationRate: Math.max(0, rate) });
    this.latestSnapshot = this.buildConsistentSnapshot(this.physics.getSnapshot());
    this.syncRendererSurfaceIfNeeded(this.latestSnapshot);
    if (!this.isRunning) {
      this.renderImmediateIfMounted(this.latestSnapshot);
    }
    this.emitHudNow();
  }

  private normalizeCenterOfMass(): void {
    if (this.disposed) return;
    const rawSnapshot = this.physics.normalizeCenterOfMass();
    const consistentSnapshot = this.buildConsistentSnapshot(rawSnapshot);
    this.latestSnapshot = consistentSnapshot;

    if (this.mounted) {
      // 质心归零后清空旧坐标系残留轨迹，防止轨迹错位连线
      this.renderer.syncBodies(consistentSnapshot.bodies, true);
      this.renderer.renderFrame(consistentSnapshot, 0);
    }
    this.emitHudNow();
  }

  private addBody(input?: NewBodyInput): void {
    if (this.disposed) return;
    const prevCount = this.latestSnapshot.bodies.length;
    const rawSnapshot = this.physics.addBody(input);
    const consistentSnapshot = this.buildConsistentSnapshot(rawSnapshot);
    this.latestSnapshot = consistentSnapshot;

    if (consistentSnapshot.bodies.length !== prevCount) {
      if (
        consistentSnapshot.planetTelemetry !== null &&
        this.temperatureHistory.length === 0
      ) {
        this.temperatureHistory.push({
          simTime: consistentSnapshot.simTime,
          temperatureC: consistentSnapshot.planetTelemetry.temperatureC,
          era: consistentSnapshot.planetTelemetry.eraStatus.era,
        });
      }

      if (this.mounted) {
        this.renderer.syncBodies(consistentSnapshot.bodies, false);
        this.syncRendererSurfaceIfNeeded(consistentSnapshot);
        this.renderer.renderFrame(consistentSnapshot, 0);
      }
    }

    this.emitHudNow();
  }

  private addTrisolarisPlanet(): void {
    if (this.disposed) return;
    const prevCount = this.latestSnapshot.bodies.length;
    const rawSnapshot = this.physics.addTrisolarisPlanet();
    const consistentSnapshot = this.buildConsistentSnapshot(rawSnapshot);
    this.latestSnapshot = consistentSnapshot;

    if (consistentSnapshot.bodies.length !== prevCount) {
      if (
        consistentSnapshot.planetTelemetry !== null &&
        this.temperatureHistory.length === 0
      ) {
        this.temperatureHistory.push({
          simTime: consistentSnapshot.simTime,
          temperatureC: consistentSnapshot.planetTelemetry.temperatureC,
          era: consistentSnapshot.planetTelemetry.eraStatus.era,
        });
      }

      if (this.mounted) {
        this.renderer.syncBodies(consistentSnapshot.bodies, false);
        this.syncRendererSurfaceIfNeeded(consistentSnapshot);
        this.renderer.renderFrame(consistentSnapshot, 0);
      }
    }

    this.emitHudNow();
  }

  private removeBody(bodyId: string): void {
    if (this.disposed) return;
    const prevCount = this.latestSnapshot.bodies.length;
    const rawSnapshot = this.physics.removeBody(bodyId);
    const consistentSnapshot = this.buildConsistentSnapshot(rawSnapshot);
    this.latestSnapshot = consistentSnapshot;

    if (consistentSnapshot.bodies.length !== prevCount) {
      this.reconcileCameraAfterBodyChange(consistentSnapshot.bodies);

      if (consistentSnapshot.planetTelemetry === null) {
        this.temperatureHistory.clear();
      }

      if (this.mounted) {
        this.renderer.syncBodies(consistentSnapshot.bodies, false);
        this.renderer.renderFrame(consistentSnapshot, 0);
      }
    }

    this.emitHudNow();
  }

  private updateBody(bodyId: string, patch: BodyPatch): void {
    if (this.disposed) return;
    const rawSnapshot = this.physics.updateBody(bodyId, patch);
    const consistentSnapshot = this.buildConsistentSnapshot(rawSnapshot);
    this.latestSnapshot = consistentSnapshot;

    if (this.mounted) {
      this.renderer.syncBodies(consistentSnapshot.bodies, false);
      this.syncRendererSurfaceIfNeeded(consistentSnapshot);
      this.renderer.renderFrame(consistentSnapshot, 0);
    }

    this.emitHudNow();
  }

  private setCameraMode(mode: CameraMode, targetBodyId?: string | null): void {
    if (this.disposed) return;
    const bodies = this.latestSnapshot.bodies;

    if (mode === 'planet-surface') {
      // 自动定位三体行星 ID（无行星时直接忽略）
      const planet =
        (targetBodyId
          ? bodies.find((b) => b.id === targetBodyId && b.role === 'planet')
          : undefined) ?? bodies.find((b) => b.role === 'planet');
      if (!planet) {
        return;
      }

      this.cameraState = { mode: 'planet-surface', targetBodyId: planet.id };
      if (this.mounted) {
        this.renderer.setCameraMode('planet-surface', planet.id);
        const pt = this.latestSnapshot.planetTelemetry;
        this.renderer.syncSurfaceView(
          pt ? pt.temperatureC : 22,
          pt ? pt.rotationAngle : 0,
          planet.id
        );
        this.renderer.renderFrame(this.latestSnapshot, 0);
      }
      this.emitHudNow();
      return;
    }

    if (mode === 'follow') {
      const explicitValid =
        targetBodyId && bodies.some((b) => b.id === targetBodyId)
          ? targetBodyId
          : null;
      const existingValid =
        this.cameraState.targetBodyId &&
        bodies.some((b) => b.id === this.cameraState.targetBodyId)
          ? this.cameraState.targetBodyId
          : null;
      const resolvedId = explicitValid ?? existingValid ?? bodies[0]?.id ?? null;

      if (resolvedId === null) {
        this.cameraState = { mode: 'com', targetBodyId: null };
      } else {
        this.cameraState = { mode: 'follow', targetBodyId: resolvedId };
      }
    } else {
      this.cameraState = { mode, targetBodyId: null };
    }

    if (this.mounted) {
      this.renderer.setCameraMode(
        this.cameraState.mode,
        this.cameraState.targetBodyId
      );
      if (!this.isRunning) {
        this.renderer.renderFrame(this.latestSnapshot, 0);
      }
    }
    this.emitHudNow();
  }

  private resetCameraView(): void {
    if (this.disposed) return;
    if (this.mounted) {
      this.renderer.resetCameraView(this.defaultCameraDistance);
      if (!this.isRunning) {
        this.renderer.renderFrame(this.latestSnapshot, 0);
      }
    }
    this.emitHudNow();
  }

  private updateVisualOptions(patch: Partial<VisualOptions>): void {
    if (this.disposed) return;
    const sanitized: Partial<VisualOptions> = {
      ...patch,
      ...(patch.trailLength !== undefined && Number.isFinite(patch.trailLength)
        ? { trailLength: Math.max(10, Math.round(patch.trailLength)) }
        : {}),
      ...(patch.bloomStrength !== undefined && Number.isFinite(patch.bloomStrength)
        ? { bloomStrength: Math.max(0, patch.bloomStrength) }
        : {}),
    };

    this.visualOptions = {
      ...this.visualOptions,
      ...sanitized,
    };

    if (sanitized.qualityMode !== undefined && !this.hasCustomHudThrottle) {
      this.hudThrottleMs =
        sanitized.qualityMode === 'performance'
          ? MOBILE_HUD_THROTTLE_MS
          : DESKTOP_HUD_THROTTLE_MS;
    }

    if (this.mounted) {
      this.renderer.setVisualOptions(sanitized);
      if (!this.isRunning) {
        this.renderer.renderFrame(this.latestSnapshot, 0);
      }
    }
    this.emitHudNow();
  }

  private setQualityMode(mode: QualityMode): void {
    if (this.disposed) return;
    if (this.visualOptions.qualityMode === mode) return;

    let nextTrailLength = this.visualOptions.trailLength;
    if (mode === 'performance') {
      nextTrailLength = Math.min(nextTrailLength, PERFORMANCE_MAX_TRAIL_LENGTH);
    } else if (nextTrailLength <= PERFORMANCE_MAX_TRAIL_LENGTH) {
      const presetId = this.physics.getPresetId();
      const activePreset = presetId ? PRESET_MAP[presetId] : undefined;
      nextTrailLength =
        activePreset?.recommendedTrailLength ?? DEFAULT_VISUAL_OPTIONS.trailLength;
    }

    const nextVisuals: VisualOptions = {
      ...this.visualOptions,
      qualityMode: mode,
      trailLength: nextTrailLength,
    };
    this.visualOptions = nextVisuals;

    if (!this.hasCustomHudThrottle) {
      this.hudThrottleMs =
        mode === 'performance' ? MOBILE_HUD_THROTTLE_MS : DESKTOP_HUD_THROTTLE_MS;
    }

    if (this.mounted) {
      this.renderer.setVisualOptions(nextVisuals);
      if (!this.isRunning) {
        this.renderer.renderFrame(this.latestSnapshot, 0);
      }
    }
    this.emitHudNow();
  }

  private clearTrails(): void {
    if (this.disposed) return;
    if (this.mounted) {
      this.renderer.clearTrails();
      if (!this.isRunning) {
        this.renderer.renderFrame(this.latestSnapshot, 0);
      }
    }
    this.emitHudNow();
  }

  // ============================================================================
  // 内部同步、历史记录与主循环调度
  // ============================================================================

  private scheduleNextFrame(): void {
    if (this.disposed || !this.mounted) return;
    if (typeof requestAnimationFrame !== 'function') return;
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(this.onAnimationFrame);
  }

  private readonly onAnimationFrame = (nowMs: number): void => {
    this.rafId = null;
    if (this.disposed || !this.mounted) return;
    this.tickFrame(nowMs);
    this.scheduleNextFrame();
  };

  private buildConsistentSnapshot(raw: PhysicsSnapshot): PhysicsSnapshot {
    const config = this.physics.getConfig();
    const factor = config.enableAutoSlowMo ? this.smoothedSlowMoFactor : 1.0;
    const targetSlowMo = this.physics.computeAutoSlowMoFactor();
    return {
      ...raw,
      effectiveTimeScale: config.timeScale * factor,
      isAutoSlowMoActive:
        config.enableAutoSlowMo && (targetSlowMo.active || factor < 0.96),
    };
  }

  private handlePostStepChanges(
    stepResult: PhysicsStepResult,
    snapshot: PhysicsSnapshot
  ): boolean {
    const hasCollisions = stepResult.newCollisions.length > 0;
    if (!stepResult.bodiesChanged && !hasCollisions) {
      return false;
    }

    this.reconcileCameraAfterBodyChange(snapshot.bodies);
    if (this.mounted) {
      this.renderer.syncBodies(snapshot.bodies, false);
    }

    if (snapshot.planetTelemetry === null) {
      this.temperatureHistory.clear();
    }

    return true;
  }

  /**
   * 校验相机目标天体是否仍存活；若消失则安全回退到质心锁定 ('com')
   */
  private reconcileCameraAfterBodyChange(
    bodies: readonly PhysicsSnapshot['bodies'][number][]
  ): void {
    if (this.cameraState.mode === 'follow') {
      const stillExists =
        this.cameraState.targetBodyId !== null &&
        bodies.some((b) => b.id === this.cameraState.targetBodyId);
      if (!stillExists) {
        this.cameraState = { mode: 'com', targetBodyId: null };
        if (this.mounted) {
          this.renderer.setCameraMode('com', null);
        }
      }
      return;
    }

    if (this.cameraState.mode === 'planet-surface') {
      const samePlanet =
        this.cameraState.targetBodyId !== null
          ? bodies.find(
              (b) =>
                b.id === this.cameraState.targetBodyId && b.role === 'planet'
            )
          : undefined;
      const fallbackPlanet = samePlanet ?? bodies.find((b) => b.role === 'planet');
      if (fallbackPlanet) {
        if (this.cameraState.targetBodyId !== fallbackPlanet.id) {
          this.cameraState = {
            mode: 'planet-surface',
            targetBodyId: fallbackPlanet.id,
          };
          if (this.mounted) {
            this.renderer.setCameraMode('planet-surface', fallbackPlanet.id);
          }
        }
      } else {
        this.cameraState = { mode: 'com', targetBodyId: null };
        if (this.mounted) {
          this.renderer.setCameraMode('com', null);
        }
      }
    }
  }

  private syncRendererSurfaceIfNeeded(snapshot: PhysicsSnapshot): void {
    if (!this.mounted || snapshot.planetTelemetry === null) return;
    const pt = snapshot.planetTelemetry;
    this.renderer.syncSurfaceView(pt.temperatureC, pt.rotationAngle, pt.planetId);
  }

  private renderImmediateIfMounted(snapshot: PhysicsSnapshot): void {
    if (!this.mounted) return;
    this.renderer.renderFrame(snapshot, 0);
  }

  private resetAndSeedHistories(snapshot: PhysicsSnapshot): void {
    this.energyHistory.clear();
    this.temperatureHistory.clear();

    this.energyHistory.push({
      simTime: snapshot.simTime,
      relativeDrift: snapshot.metrics.relativeDrift,
      totalEnergy: snapshot.metrics.total,
    });

    if (snapshot.planetTelemetry !== null) {
      this.temperatureHistory.push({
        simTime: snapshot.simTime,
        temperatureC: snapshot.planetTelemetry.temperatureC,
        era: snapshot.planetTelemetry.eraStatus.era,
      });
    }
  }

  private appendHistorySamples(snapshot: PhysicsSnapshot, force: boolean): void {
    const lastEnergy = this.energyHistory.last();
    if (
      force ||
      lastEnergy === undefined ||
      snapshot.simTime > lastEnergy.simTime + 1e-12
    ) {
      this.energyHistory.push({
        simTime: snapshot.simTime,
        relativeDrift: snapshot.metrics.relativeDrift,
        totalEnergy: snapshot.metrics.total,
      });
    }

    if (snapshot.planetTelemetry !== null) {
      const lastTemp = this.temperatureHistory.last();
      if (
        force ||
        lastTemp === undefined ||
        snapshot.simTime > lastTemp.simTime + 1e-12
      ) {
        this.temperatureHistory.push({
          simTime: snapshot.simTime,
          temperatureC: snapshot.planetTelemetry.temperatureC,
          era: snapshot.planetTelemetry.eraStatus.era,
        });
      }
    }
  }

  private emitHudNow(): void {
    if (this.disposed) return;
    this.hudElapsedSinceEmitMs = 0;
    if (this.listeners.size === 0) return;

    const hudSnapshot = this.getHudSnapshot();
    for (const listener of this.listeners) {
      listener(hudSnapshot);
    }
  }
}
