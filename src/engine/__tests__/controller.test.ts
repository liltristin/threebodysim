import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESET_MAP } from '../../presets/presets';
import type {
  HudSnapshot,
  ISceneRenderer,
  PhysicsSnapshot,
} from '../../types/contracts';
import { SimulationController } from '../SimulationController';

interface MockRenderer extends ISceneRenderer {
  readonly init: ReturnType<typeof vi.fn<ISceneRenderer['init']>>;
  readonly resize: ReturnType<typeof vi.fn<ISceneRenderer['resize']>>;
  readonly renderFrame: ReturnType<typeof vi.fn<ISceneRenderer['renderFrame']>>;
  readonly syncBodies: ReturnType<typeof vi.fn<ISceneRenderer['syncBodies']>>;
  readonly clearTrails: ReturnType<typeof vi.fn<ISceneRenderer['clearTrails']>>;
  readonly setCameraMode: ReturnType<typeof vi.fn<ISceneRenderer['setCameraMode']>>;
  readonly resetCameraView: ReturnType<typeof vi.fn<ISceneRenderer['resetCameraView']>>;
  readonly setVisualOptions: ReturnType<
    typeof vi.fn<ISceneRenderer['setVisualOptions']>
  >;
  readonly syncSurfaceView: ReturnType<typeof vi.fn<ISceneRenderer['syncSurfaceView']>>;
  readonly dispose: ReturnType<typeof vi.fn<ISceneRenderer['dispose']>>;
}

function createMockRenderer(): MockRenderer {
  return {
    init: vi.fn<ISceneRenderer['init']>(),
    resize: vi.fn<ISceneRenderer['resize']>(),
    renderFrame: vi.fn<ISceneRenderer['renderFrame']>(),
    syncBodies: vi.fn<ISceneRenderer['syncBodies']>(),
    clearTrails: vi.fn<ISceneRenderer['clearTrails']>(),
    setCameraMode: vi.fn<ISceneRenderer['setCameraMode']>(),
    resetCameraView: vi.fn<ISceneRenderer['resetCameraView']>(),
    setVisualOptions: vi.fn<ISceneRenderer['setVisualOptions']>(),
    syncSurfaceView: vi.fn<ISceneRenderer['syncSurfaceView']>(),
    dispose: vi.fn<ISceneRenderer['dispose']>(),
  };
}

function createFakeContainer(): HTMLElement {
  return {
    clientWidth: 1280,
    clientHeight: 720,
  } as unknown as HTMLElement;
}

function installMockRaf() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();

  const raf = vi.fn((cb: FrameRequestCallback): number => {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  });

  const caf = vi.fn((id: number): void => {
    callbacks.delete(id);
  });

  vi.stubGlobal('requestAnimationFrame', raf);
  vi.stubGlobal('cancelAnimationFrame', caf);

  return {
    raf,
    caf,
    pendingCount: () => callbacks.size,
    flushNextFrame: (timestampMs: number) => {
      const first = callbacks.entries().next();
      if (first.done) return false;
      const [id, cb] = first.value;
      callbacks.delete(id);
      cb(timestampMs);
      return true;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SimulationController 集成测试', () => {
  it('挂载初始化默认预设、同步推荐轨迹长度与初始 t=0 历史点，并正确响应 resize', () => {
    const mockRaf = installMockRaf();
    const renderer = createMockRenderer();
    const controller = new SimulationController({ renderer });
    const received: HudSnapshot[] = [];
    controller.subscribe((snap) => received.push(snap));

    const container = createFakeContainer();
    controller.mount(container);

    const figure8 = PRESET_MAP['figure-8'];
    expect(renderer.init).toHaveBeenCalledTimes(1);
    expect(renderer.init.mock.calls[0][0]).toBe(container);
    expect(renderer.init.mock.calls[0][1]).toHaveLength(3);
    expect(renderer.init.mock.calls[0][2].trailLength).toBe(
      figure8.recommendedTrailLength
    );
    expect(renderer.init.mock.calls[0][3]).toBe(figure8.defaultCameraDistance);
    expect(renderer.renderFrame).toHaveBeenCalledTimes(1);
    expect(mockRaf.pendingCount()).toBe(1);

    expect(received).toHaveLength(1);
    expect(received[0].presetId).toBe('figure-8');
    expect(received[0].energyHistory).toHaveLength(1);
    expect(received[0].energyHistory[0].simTime).toBe(0);
    expect(received[0].temperatureHistory).toHaveLength(0);

    controller.resize(1440, 900);
    expect(renderer.resize).toHaveBeenCalledWith(1440, 900);

    controller.resize(0, 900);
    expect(renderer.resize).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it('rAF 60 FPS 驱动下每帧调用 renderer.renderFrame，同时将 HUD 推送节流在 10~15 Hz 并钳制切标签页跳变', () => {
    const mockRaf = installMockRaf();
    const renderer = createMockRenderer();
    const controller = new SimulationController({
      renderer,
      hudThrottleMs: 80,
    });
    const hudUpdates: HudSnapshot[] = [];
    controller.subscribe((snap) => hudUpdates.push(snap));
    controller.mount(createFakeContainer());

    // 清除 mount 时的首帧计数
    renderer.renderFrame.mockClear();
    hudUpdates.length = 0;

    // 模拟 1 秒（60 帧，每帧 16.67ms）
    const frameStepMs = 1000 / 60;
    for (let i = 0; i < 60; i++) {
      expect(mockRaf.flushNextFrame(i * frameStepMs)).toBe(true);
    }

    // 渲染层严格每帧调用 60 次
    expect(renderer.renderFrame).toHaveBeenCalledTimes(60);
    // React HUD 推送严格节流在 10~15 Hz（80ms 间隔 ≈ 12 次），绝不每帧推送
    expect(hudUpdates.length).toBeGreaterThanOrEqual(10);
    expect(hudUpdates.length).toBeLessThanOrEqual(15);

    const lastHud = hudUpdates[hudUpdates.length - 1];
    const falseSlowMo = hudUpdates.find((h) => h.isAutoSlowMoActive);
    expect(
      falseSlowMo
        ? `false slow-mo at T=${falseSlowMo.simTime.toFixed(4)} h=${falseSlowMo.lastStepSize} rMin=${falseSlowMo.minPairDistance} effScale=${falseSlowMo.effectiveTimeScale}`
        : null
    ).toBeNull();
    expect(lastHud.simTime).toBeGreaterThan(0.8);
    expect(lastHud.fps).toBeGreaterThan(45);
    expect(lastHud.fps).toBeLessThan(75);
    expect(lastHud.energyHistory.length).toBeGreaterThanOrEqual(10);

    // 模拟浏览器切标签页 5 秒跳变：单帧 deltaSeconds 必须被钳制在 <= 0.05s
    const simTimeBeforeJump = controller.getHudSnapshot().simTime;
    renderer.renderFrame.mockClear();
    mockRaf.flushNextFrame(60 * frameStepMs + 5000);

    expect(renderer.renderFrame).toHaveBeenCalledTimes(1);
    expect(renderer.renderFrame.mock.calls[0][1]).toBeLessThanOrEqual(0.05);
    const simTimeAfterJump = controller.getHudSnapshot().simTime;
    expect(simTimeAfterJump - simTimeBeforeJump).toBeLessThanOrEqual(0.06);

    controller.dispose();
  });

  it('近距自动慢动作做指数平滑调制，并确保 renderFrame 与 HudSnapshot 的 effectiveTimeScale 与激活标志完全一致', () => {
    const mockRaf = installMockRaf();
    const renderer = createMockRenderer();
    const controller = new SimulationController({
      renderer,
      hudThrottleMs: 80,
    });
    const hudUpdates: HudSnapshot[] = [];
    controller.subscribe((snap) => hudUpdates.push(snap));
    controller.mount(createFakeContainer());

    const actions = controller.getActions();
    // 人为将 star-1 与 star-2 放置在近距交汇范围（距离 0.12 < 0.45）
    actions.updateBody('star-1', { position: [-0.06, 0, 0], velocity: [0, 0.2, 0] });
    actions.updateBody('star-2', { position: [0.06, 0, 0], velocity: [0, -0.2, 0] });
    actions.updateBody('star-3', { position: [3.0, 0, 0], velocity: [0, 0.1, 0] });

    renderer.renderFrame.mockClear();
    hudUpdates.length = 0;

    // 推进 6 帧（约 100ms），触发指数平滑减速与一次节流 HUD 推送
    for (let i = 0; i < 6; i++) {
      mockRaf.flushNextFrame(i * 16.67);
    }

    const lastRenderSnap = renderer.renderFrame.mock.calls[
      renderer.renderFrame.mock.calls.length - 1
    ][0] as PhysicsSnapshot;
    const latestHud = controller.getHudSnapshot();

    expect(lastRenderSnap.isAutoSlowMoActive).toBe(true);
    expect(latestHud.isAutoSlowMoActive).toBe(true);
    expect(lastRenderSnap.effectiveTimeScale).toBeCloseTo(
      latestHud.effectiveTimeScale,
      10
    );
    expect(latestHud.effectiveTimeScale).toBeLessThan(latestHud.config.timeScale);
    expect(latestHud.effectiveTimeScale).toBeGreaterThan(0);

    // 关闭自动慢动作后有效倍速立即恢复为目标倍速
    actions.setAutoSlowMo(false);
    const afterDisable = controller.getHudSnapshot();
    expect(afterDisable.isAutoSlowMoActive).toBe(false);
    expect(afterDisable.effectiveTimeScale).toBeCloseTo(
      afterDisable.config.timeScale,
      10
    );

    controller.dispose();
  });

  it('切换预设同步 recommendedTrailLength、清空重置历史与相机，且从近地视角切往无行星预设时安全回退至 com', () => {
    installMockRaf();
    const renderer = createMockRenderer();
    const controller = new SimulationController({ renderer });
    controller.mount(createFakeContainer());
    const actions = controller.getActions();

    // 无行星场景尝试切入近地视角应被安全忽略
    actions.setCameraMode('planet-surface');
    expect(controller.getHudSnapshot().cameraState.mode).toBe('free');

    // 加载混沌三体 + 三体行星预设
    renderer.syncBodies.mockClear();
    renderer.resetCameraView.mockClear();
    renderer.setVisualOptions.mockClear();
    renderer.syncSurfaceView.mockClear();

    actions.loadPreset('chaotic-trisolaris');
    const trisolaris = PRESET_MAP['chaotic-trisolaris'];
    const snap1 = controller.getHudSnapshot();

    expect(snap1.presetId).toBe('chaotic-trisolaris');
    expect(snap1.visualOptions.trailLength).toBe(trisolaris.recommendedTrailLength);
    expect(snap1.planetTelemetry).not.toBeNull();
    expect(snap1.energyHistory).toHaveLength(1);
    expect(snap1.temperatureHistory).toHaveLength(1);
    expect(renderer.setVisualOptions).toHaveBeenCalledWith({
      trailLength: trisolaris.recommendedTrailLength,
    });
    expect(renderer.syncBodies).toHaveBeenCalledWith(snap1.bodies, true);
    expect(renderer.resetCameraView).toHaveBeenCalledWith(
      trisolaris.defaultCameraDistance
    );
    expect(renderer.syncSurfaceView).toHaveBeenCalled();

    // 切入近地视角自动定位三体行星 ID
    renderer.setCameraMode.mockClear();
    renderer.syncSurfaceView.mockClear();
    actions.setCameraMode('planet-surface');

    const snapSurface = controller.getHudSnapshot();
    expect(snapSurface.cameraState.mode).toBe('planet-surface');
    expect(snapSurface.cameraState.targetBodyId).toBe('trisolaris-planet');
    expect(renderer.setCameraMode).toHaveBeenCalledWith(
      'planet-surface',
      'trisolaris-planet'
    );
    expect(renderer.syncSurfaceView).toHaveBeenCalledWith(
      snapSurface.planetTelemetry!.temperatureC,
      snapSurface.planetTelemetry!.rotationAngle,
      'trisolaris-planet'
    );

    // 切回无行星预设 figure-8：相机必须安全回退至 com 并清空温度历史
    renderer.setCameraMode.mockClear();
    actions.loadPreset('figure-8');
    const snapBack = controller.getHudSnapshot();
    expect(snapBack.cameraState.mode).toBe('com');
    expect(snapBack.cameraState.targetBodyId).toBeNull();
    expect(snapBack.planetTelemetry).toBeNull();
    expect(snapBack.temperatureHistory).toHaveLength(0);
    expect(renderer.setCameraMode).toHaveBeenCalledWith('com', null);

    controller.dispose();
  });

  it('碰撞合并触发 syncBodies(bodies, false)、失效跟随目标回退至 com 并立即推送 HUD 事件', () => {
    const mockRaf = installMockRaf();
    const renderer = createMockRenderer();
    const controller = new SimulationController({
      renderer,
      hudThrottleMs: 1000, // 极大节流阈值，验证碰撞发生时会绕过节流立即推送
    });
    const hudUpdates: HudSnapshot[] = [];
    controller.subscribe((snap) => hudUpdates.push(snap));
    controller.mount(createFakeContainer());

    const actions = controller.getActions();
    actions.setEnableCollisions(true);
    actions.setSoftening(0);
    // 让质量较小的 star-2 朝质量较大的 star-1 迎头相撞（star-2 将被吸收消失）
    actions.updateBody('star-1', {
      mass: 2.0,
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      collisionRadius: 0.05,
    });
    actions.updateBody('star-2', {
      mass: 0.5,
      position: [0.14, 0, 0],
      velocity: [-2.0, 0, 0],
      collisionRadius: 0.05,
    });
    actions.updateBody('star-3', {
      mass: 1.0,
      position: [5.0, 0, 0],
      velocity: [0, 0.2, 0],
      collisionRadius: 0.02,
    });

    // 跟随即将消失的 star-2
    actions.setCameraMode('follow', 'star-2');
    expect(controller.getHudSnapshot().cameraState).toEqual({
      mode: 'follow',
      targetBodyId: 'star-2',
    });

    renderer.syncBodies.mockClear();
    renderer.setCameraMode.mockClear();
    hudUpdates.length = 0;

    // 仅推进 2 帧（33ms << 1000ms 节流间隔），应触发碰撞合并并立即推送 HUD
    mockRaf.flushNextFrame(0);
    mockRaf.flushNextFrame(25);
    mockRaf.flushNextFrame(50);

    expect(hudUpdates.length).toBeGreaterThanOrEqual(1);
    const mergedHud = hudUpdates[hudUpdates.length - 1];
    expect(mergedHud.collisionEvents.length).toBeGreaterThanOrEqual(1);
    expect(mergedHud.bodies).toHaveLength(2);
    expect(mergedHud.bodies.some((b) => b.id === 'star-2')).toBe(false);
    // 跟随目标 star-2 消失，自动回退至 com
    expect(mergedHud.cameraState).toEqual({ mode: 'com', targetBodyId: null });
    expect(renderer.setCameraMode).toHaveBeenCalledWith('com', null);
    expect(renderer.syncBodies).toHaveBeenCalledWith(mergedHud.bodies, false);

    controller.dispose();
  });

  it('暂停状态下所有用户交互操作均立即刷新渲染器并同步 HUD，且质心归零清空旧轨迹', () => {
    installMockRaf();
    const renderer = createMockRenderer();
    const controller = new SimulationController({
      renderer,
      autoStart: false,
    });
    const hudUpdates: HudSnapshot[] = [];
    controller.subscribe((snap) => hudUpdates.push(snap));
    controller.mount(createFakeContainer());

    const actions = controller.getActions();
    expect(controller.getHudSnapshot().isRunning).toBe(false);

    // 1. 单步推进
    renderer.renderFrame.mockClear();
    actions.stepOnce(0.02);
    expect(controller.getHudSnapshot().simTime).toBeCloseTo(0.02, 8);
    expect(controller.getHudSnapshot().energyHistory).toHaveLength(2);
    expect(renderer.renderFrame).toHaveBeenCalledTimes(1);

    // 2. 编辑天体参数（暂停态立即同步并重绘）
    renderer.syncBodies.mockClear();
    renderer.renderFrame.mockClear();
    actions.updateBody('star-1', { color: '#ff00ff', mass: 1.5 });
    expect(renderer.syncBodies).toHaveBeenCalledTimes(1);
    expect(renderer.renderFrame).toHaveBeenCalledTimes(1);

    // 3. 质心归零（必须传 clearTrails = true 清空旧坐标系残留轨迹）
    renderer.syncBodies.mockClear();
    actions.normalizeCenterOfMass();
    expect(renderer.syncBodies).toHaveBeenCalledWith(
      expect.any(Array),
      true
    );
    const com = controller.getHudSnapshot().metrics.centerOfMass;
    expect(Math.hypot(com[0], com[1], com[2])).toBeLessThan(1e-12);

    // 4. 添加三体行星 + 调整自转速度 + 切换测试粒子
    actions.addTrisolarisPlanet();
    expect(controller.getHudSnapshot().bodies).toHaveLength(4);
    expect(controller.getHudSnapshot().planetTelemetry).not.toBeNull();

    renderer.syncSurfaceView.mockClear();
    renderer.renderFrame.mockClear();
    actions.setPlanetRotationRate(1.5);
    expect(controller.getHudSnapshot().config.planetRotationRate).toBe(1.5);
    expect(renderer.syncSurfaceView).toHaveBeenCalled();
    expect(renderer.renderFrame).toHaveBeenCalledTimes(1);

    actions.setPlanetAsTestParticle(false);
    expect(controller.getHudSnapshot().config.planetAsTestParticle).toBe(false);

    // 5. 视觉选项、清空轨迹、积分器、软化、倍速、增删、随机与重置
    renderer.setVisualOptions.mockClear();
    renderer.renderFrame.mockClear();
    actions.updateVisualOptions({ showForceVectors: true, bloomStrength: 1.2 });
    expect(renderer.setVisualOptions).toHaveBeenCalledWith({
      showForceVectors: true,
      bloomStrength: 1.2,
    });
    expect(renderer.renderFrame).toHaveBeenCalledTimes(1);

    renderer.clearTrails.mockClear();
    actions.clearTrails();
    expect(renderer.clearTrails).toHaveBeenCalledTimes(1);

    actions.setIntegrator('verlet');
    actions.setSoftening(0.02);
    actions.setTimeScale(2.5);
    expect(controller.getHudSnapshot().config.integrator).toBe('verlet');
    expect(controller.getHudSnapshot().config.softening).toBe(0.02);
    expect(controller.getHudSnapshot().config.timeScale).toBe(2.5);

    actions.addBody();
    expect(controller.getHudSnapshot().bodies).toHaveLength(5);

    const lastId = controller.getHudSnapshot().bodies[4].id;
    actions.removeBody(lastId);
    expect(controller.getHudSnapshot().bodies).toHaveLength(4);

    actions.randomize(4);
    expect(controller.getHudSnapshot().presetId).toBeNull();
    expect(controller.getHudSnapshot().bodies).toHaveLength(4);
    expect(controller.getHudSnapshot().energyHistory).toHaveLength(1);

    actions.reset();
    expect(controller.getHudSnapshot().simTime).toBe(0);
    expect(controller.getHudSnapshot().bodies).toHaveLength(4);

    actions.togglePlay();
    expect(controller.getHudSnapshot().isRunning).toBe(true);
    actions.pause();
    expect(controller.getHudSnapshot().isRunning).toBe(false);
    actions.play();
    expect(controller.getHudSnapshot().isRunning).toBe(true);

    controller.dispose();
  });

  it('历史环形缓冲区严格受 maxHistoryPoints 上限约束且时间单调递增', () => {
    installMockRaf();
    const renderer = createMockRenderer();
    const controller = new SimulationController({
      initialPresetId: 'chaotic-trisolaris',
      renderer,
      maxHistoryPoints: 20,
      autoStart: false,
    });
    controller.mount(createFakeContainer());

    const actions = controller.getActions();
    for (let i = 0; i < 45; i++) {
      actions.stepOnce(0.01);
    }

    const snap = controller.getHudSnapshot();
    expect(snap.energyHistory).toHaveLength(20);
    expect(snap.temperatureHistory).toHaveLength(20);
    for (let i = 1; i < snap.energyHistory.length; i++) {
      expect(snap.energyHistory[i].simTime).toBeGreaterThan(
        snap.energyHistory[i - 1].simTime
      );
      expect(snap.temperatureHistory[i].simTime).toBeGreaterThan(
        snap.temperatureHistory[i - 1].simTime
      );
    }

    controller.dispose();
  });

  it('dispose() 取消 rAF、清空订阅、幂等释放渲染器并安全兼容 StrictMode 双重挂载', () => {
    const mockRaf = installMockRaf();
    const renderer1 = createMockRenderer();
    const c1 = new SimulationController({ renderer: renderer1 });
    const listener1 = vi.fn();
    c1.subscribe(listener1);
    c1.mount(createFakeContainer());

    expect(mockRaf.pendingCount()).toBe(1);
    listener1.mockClear();

    // 模拟 StrictMode 首次卸载
    c1.dispose();
    c1.dispose(); // 二次调用必须幂等

    expect(mockRaf.caf).toHaveBeenCalledTimes(1);
    expect(mockRaf.pendingCount()).toBe(0);
    expect(renderer1.dispose).toHaveBeenCalledTimes(1);

    // 销毁后任何操作与 tick 均不得再触发回调或渲染
    renderer1.renderFrame.mockClear();
    c1.tickFrame(100);
    c1.getActions().stepOnce(0.05);
    c1.getActions().loadPreset('chaotic-trisolaris');
    expect(listener1).not.toHaveBeenCalled();
    expect(renderer1.renderFrame).not.toHaveBeenCalled();

    // 模拟 StrictMode 二次挂载
    const renderer2 = createMockRenderer();
    const c2 = new SimulationController({ renderer: renderer2 });
    const listener2 = vi.fn();
    c2.subscribe(listener2);
    c2.mount(createFakeContainer());

    expect(mockRaf.pendingCount()).toBe(1);
    expect(renderer2.init).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);

    c2.dispose();
    expect(renderer2.dispose).toHaveBeenCalledTimes(1);
  });
});
