import { describe, expect, it } from 'vitest';
import { PRESETS, PRESET_MAP } from '../../presets/presets';
import {
  HABITABLE_TEMP_MAX_C,
  HABITABLE_TEMP_MIN_C,
  MAX_BODIES,
  MIN_BODIES,
  type BodyState,
} from '../../types/contracts';
import {
  ERA_WINDOW_DURATION,
  H_MIN,
  KELVIN_OFFSET,
  MAX_PLANET_TEMP_K,
  MAX_SUBSTEPS_PER_FRAME,
  MIN_PLANET_TEMP_K,
  PhysicsEngine,
  PlanetThermodynamicsTracker,
  REFERENCE_FLUX,
  computeEnergyMetrics,
  computeGravityForBodies,
  computeObserverBasis,
  computeSkyObservations,
  computeTempRate,
  detectAstronomicalEvent,
  integrateBodies,
  normalizeCenterOfMass,
  resolveCollisions,
  stepPlanetTemperature,
} from '../index';

function makeBody(partial: Partial<BodyState> & { id: string; mass: number }): BodyState {
  const role = partial.role ?? 'star';
  return {
    id: partial.id,
    name: partial.name ?? partial.id,
    role,
    mass: partial.mass,
    position: partial.position ?? [0, 0, 0],
    velocity: partial.velocity ?? [0, 0, 0],
    color: partial.color ?? '#60a5fa',
    emissiveIntensity: partial.emissiveIntensity ?? (role === 'star' ? 2.6 : 0.35),
    renderRadius: partial.renderRadius ?? (role === 'star' ? 0.08 : 0.03),
    collisionRadius: partial.collisionRadius ?? (role === 'star' ? 0.025 : 0.008),
    isTestParticle: partial.isTestParticle ?? false,
    acceleration: partial.acceleration ?? [0, 0, 0],
    force: partial.force ?? [0, 0, 0],
    luminosity:
      partial.luminosity ?? (role === 'star' ? Math.pow(Math.max(partial.mass, 0), 3.5) : 0),
  };
}

function vecDist(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe('两体圆轨解析验证（DOPRI5(4) 与 Velocity Verlet）', () => {
  // 等质量两体圆轨：m1 = m2 = 1, G = 1, 半径 r = 1（间距 d = 2）
  // 向心加速度 v^2 / r = G * m / d^2 => v = sqrt(1 / 4) = 0.5
  // 轨道周期 T = 2π * r / v = 4π
  const period = 4 * Math.PI;
  const createTwoBodyCircular = (): BodyState[] => {
    const raw = [
      makeBody({ id: 'b1', mass: 1.0, position: [1, 0, 0], velocity: [0, 0.5, 0] }),
      makeBody({ id: 'b2', mass: 1.0, position: [-1, 0, 0], velocity: [0, -0.5, 0] }),
    ];
    return computeGravityForBodies(raw, 1.0, 0.0).bodies;
  };

  it('DOPRI5(4) 完整周期闭合且能量与角动量高度守恒', () => {
    const initial = createTwoBodyCircular();
    const initialMetrics = computeEnergyMetrics(initial, 1.0, 0.0);

    const res = integrateBodies(initial, period, {
      integrator: 'dopri54',
      G: 1.0,
      softening: 0.0,
      rtol: 1e-11,
      atol: 1e-13,
      maxSubsteps: 20000,
    });

    const finalMetrics = computeEnergyMetrics(
      res.bodies,
      1.0,
      0.0,
      initialMetrics.total
    );

    expect(res.substepClamped).toBe(false);
    expect(finalMetrics.relativeDrift).toBeLessThan(1e-9);
    expect(
      vecDist(finalMetrics.angularMomentum, initialMetrics.angularMomentum)
    ).toBeLessThan(1e-9);

    for (let i = 0; i < initial.length; i++) {
      expect(vecDist(res.bodies[i].position, initial[i].position)).toBeLessThan(1e-7);
      expect(vecDist(res.bodies[i].velocity, initial[i].velocity)).toBeLessThan(1e-7);
    }
  });

  it('Velocity Verlet 多周期辛积分无长期系统性能量漂移且闭合良好', () => {
    const initial = createTwoBodyCircular();
    const initialMetrics = computeEnergyMetrics(initial, 1.0, 0.0);

    const drifts: number[] = [];
    let current = initial;
    for (let orbit = 0; orbit < 3; orbit++) {
      const res = integrateBodies(current, period, {
        integrator: 'verlet',
        G: 1.0,
        softening: 0.0,
        verletDt: 0.002,
        maxSubsteps: 20000,
      });
      expect(res.substepClamped).toBe(false);
      current = res.bodies;
      const metrics = computeEnergyMetrics(current, 1.0, 0.0, initialMetrics.total);
      drifts.push(metrics.relativeDrift);

      if (orbit === 0) {
        expect(vecDist(current[0].position, initial[0].position)).toBeLessThan(1e-4);
        expect(vecDist(current[1].position, initial[1].position)).toBeLessThan(1e-4);
      }
      expect(
        vecDist(metrics.angularMomentum, initialMetrics.angularMomentum)
      ).toBeLessThan(1e-10);
    }

    // 辛积分能量误差保持有界且极低
    for (const d of drifts) {
      expect(d).toBeLessThan(1e-6);
    }
  });
});

describe('经典三体周期解验证（8 字形与拉格朗日等边三角）', () => {
  it('figure-8（softening = 0）经 1 完整周期 T = 6.32591398 回归初始态且能量漂移 < 1e-7', () => {
    const preset = PRESET_MAP['figure-8'];
    const period = preset.expectedPeriod!;
    const engine = new PhysicsEngine('figure-8');
    expect(engine.getConfig().softening).toBe(0);

    const initSnap = engine.getSnapshot();

    // 分多帧推进，顺带验证跨帧 FSAL 缓存一致性
    const numFrames = 40;
    const frameDt = period / numFrames;
    for (let f = 0; f < numFrames; f++) {
      const stepRes = engine.step(frameDt, { maxSubsteps: 5000 });
      expect(stepRes.snapshot.substepClamped).toBe(false);
    }

    const finalSnap = engine.getSnapshot();
    expect(finalSnap.simTime).toBeCloseTo(period, 10);
    expect(finalSnap.metrics.relativeDrift).toBeLessThan(1e-7);
    expect(finalSnap.metrics.angularMomentumMag).toBeLessThan(1e-8);
    expect(vecDist(finalSnap.metrics.centerOfMass, [0, 0, 0])).toBeLessThan(1e-9);

    for (let i = 0; i < initSnap.bodies.length; i++) {
      expect(vecDist(finalSnap.bodies[i].position, initSnap.bodies[i].position)).toBeLessThan(
        1e-3
      );
      expect(vecDist(finalSnap.bodies[i].velocity, initSnap.bodies[i].velocity)).toBeLessThan(
        1e-3
      );
    }
  });

  it('lagrange-triangle（softening = 0）保持等边三角形对称性并守恒能量与角动量', () => {
    const preset = PRESET_MAP['lagrange-triangle'];
    const period = preset.expectedPeriod!;
    const engine = new PhysicsEngine('lagrange-triangle');
    expect(engine.getConfig().softening).toBe(0);

    const initSnap = engine.getSnapshot();
    const expectedSide = Math.sqrt(3);

    // 默认推荐 Velocity Verlet 推进 1 个完整旋转周期
    const res = engine.step(period, { maxSubsteps: 20000 });
    expect(res.snapshot.substepClamped).toBe(false);

    const finalSnap = res.snapshot;
    const [b0, b1, b2] = finalSnap.bodies;
    const d01 = vecDist(b0.position, b1.position);
    const d12 = vecDist(b1.position, b2.position);
    const d20 = vecDist(b2.position, b0.position);

    expect(Math.abs(d01 - expectedSide)).toBeLessThan(1e-4);
    expect(Math.abs(d12 - expectedSide)).toBeLessThan(1e-4);
    expect(Math.abs(d20 - expectedSide)).toBeLessThan(1e-4);

    // 能量与角动量高度守恒
    expect(finalSnap.metrics.relativeDrift).toBeLessThan(1e-5);
    expect(
      vecDist(finalSnap.metrics.angularMomentum, initSnap.metrics.angularMomentum)
    ).toBeLessThan(1e-9);

    // 完整旋转周期回到初态
    for (let i = 0; i < 3; i++) {
      expect(vecDist(finalSnap.bodies[i].position, initSnap.bodies[i].position)).toBeLessThan(
        1e-3
      );
    }
  });
});

describe('极限近距交汇防死循环与自动慢动作保护', () => {
  it('极近奇点下 h_min 与 MAX_SUBSTEPS_PER_FRAME 保护生效，无 NaN/Infinity 且迅速返回', () => {
    const engine = new PhysicsEngine('figure-8');
    engine.updateConfig({
      integrator: 'dopri54',
      softening: 0,
      enableCollisions: false,
      rtol: 1e-11,
      atol: 1e-13,
    });

    // 仅保留两颗极近距离恒星制造极限奇点场景
    engine.removeBody('star-3');
    engine.updateBody('star-1', { position: [-5e-6, 0, 0], velocity: [0, 0, 0], mass: 1.0 });
    engine.updateBody('star-2', { position: [5e-6, 0, 0], velocity: [0, 0, 0], mass: 1.0 });

    const startMs = Date.now();
    const res = engine.step(0.1);
    const elapsedMs = Date.now() - startMs;

    expect(elapsedMs).toBeLessThan(1000);
    expect(res.snapshot.substepClamped).toBe(true);
    expect(res.snapshot.substepsThisFrame).toBeLessThanOrEqual(MAX_SUBSTEPS_PER_FRAME);
    expect(res.snapshot.lastStepSize).toBeGreaterThanOrEqual(H_MIN * (1 - 1e-9));

    for (const body of res.snapshot.bodies) {
      for (const c of [...body.position, ...body.velocity, ...body.acceleration, ...body.force]) {
        expect(Number.isFinite(c)).toBe(true);
      }
    }
    expect(Number.isFinite(res.snapshot.metrics.total)).toBe(true);
    expect(Number.isFinite(res.snapshot.metrics.relativeDrift)).toBe(true);

    // 近距自动慢动作应当显著激活
    const slowMo = engine.computeAutoSlowMoFactor();
    expect(slowMo.active).toBe(true);
    expect(slowMo.factor).toBeLessThan(0.25);
  });

  it('Velocity Verlet 超过单帧最大子步数时同样触发 substepClamped 安全退出', () => {
    const engine = new PhysicsEngine('figure-8');
    engine.updateConfig({ integrator: 'verlet', verletDt: 0.0001 });

    // 需要 10000 步但默认上限 500 步
    const res = engine.step(1.0);
    expect(res.snapshot.substepClamped).toBe(true);
    expect(res.snapshot.substepsThisFrame).toBe(MAX_SUBSTEPS_PER_FRAME);
    expect(Number.isFinite(res.snapshot.metrics.total)).toBe(true);
  });

  it('平稳轨道 figure-8 以 60fps（simDt = 1/60）连续推进与低倍速下不因帧尾截短误触发自动慢动作', () => {
    const engine = new PhysicsEngine('figure-8');
    expect(engine.getSnapshot().lastStepSize).toBeGreaterThan(2e-3);
    expect(engine.getSnapshot().isAutoSlowMoActive).toBe(false);

    // 连续 120 帧（2.0 模拟时间，覆盖多个过零交汇点）均不应误触发慢动作
    const frameDt = 1 / 60;
    for (let f = 0; f < 120; f++) {
      const res = engine.step(frameDt);
      expect(res.snapshot.isAutoSlowMoActive).toBe(false);
      expect(res.snapshot.effectiveTimeScale).toBeCloseTo(1.0, 6);
      expect(res.snapshot.lastStepSize).toBeGreaterThan(2e-3);
    }

    // 即使在极低时间倍速（单帧 simDt = 0.0008 < 2e-3）下也不应因目标步长截短误报慢动作
    engine.updateConfig({ timeScale: 0.05 });
    for (let f = 0; f < 20; f++) {
      const res = engine.step(frameDt * 0.05);
      expect(res.snapshot.isAutoSlowMoActive).toBe(false);
      expect(res.snapshot.lastStepSize).toBeGreaterThan(2e-3);
    }
  });
});

describe('完全非弹性碰撞合并与能量基准重置', () => {
  it('碰撞合并严格满足质量守恒、动量守恒、半径立方根合并、energyLoss >= 0 且重置 relativeDrift 为 0', () => {
    const engine = new PhysicsEngine('figure-8');
    engine.removeBody('star-3');
    engine.updateConfig({
      enableCollisions: true,
      softening: 0.0,
      integrator: 'dopri54',
    });

    // 两颗不等质量恒星迎面相撞
    engine.updateBody('star-1', {
      name: '主恒星',
      mass: 2.0,
      position: [-0.25, 0, 0],
      velocity: [2.0, 0.3, 0],
      renderRadius: 0.1,
      collisionRadius: 0.08,
      color: '#fde047',
    });
    engine.updateBody('star-2', {
      name: '次恒星',
      mass: 1.0,
      position: [0.25, 0, 0],
      velocity: [-1.5, -0.6, 0],
      renderRadius: 0.06,
      collisionRadius: 0.05,
      color: '#60a5fa',
    });

    // 记录碰撞前系统总动量
    const preSnap = engine.getSnapshot();
    const pBefore = [
      preSnap.bodies[0].mass * preSnap.bodies[0].velocity[0] +
        preSnap.bodies[1].mass * preSnap.bodies[1].velocity[0],
      preSnap.bodies[0].mass * preSnap.bodies[0].velocity[1] +
        preSnap.bodies[1].mass * preSnap.bodies[1].velocity[1],
      preSnap.bodies[0].mass * preSnap.bodies[0].velocity[2] +
        preSnap.bodies[1].mass * preSnap.bodies[1].velocity[2],
    ];

    const stepRes = engine.step(0.25, { maxSubsteps: 5000 });
    expect(stepRes.bodiesChanged).toBe(true);
    expect(stepRes.newCollisions.length).toBe(1);
    expect(stepRes.snapshot.bodies.length).toBe(1);

    const survivor = stepRes.snapshot.bodies[0];
    const event = stepRes.newCollisions[0];

    // 质量守恒 & 幸存者属性保留较大质量天体
    expect(survivor.mass).toBeCloseTo(3.0, 12);
    expect(survivor.id).toBe('star-1');
    expect(survivor.name).toBe('主恒星');
    expect(survivor.color).toBe('#fde047');
    expect(survivor.luminosity).toBeCloseTo(Math.pow(3.0, 3.5), 10);

    // 半径按体积立方根合并
    expect(survivor.renderRadius).toBeCloseTo(
      Math.cbrt(Math.pow(0.1, 3) + Math.pow(0.06, 3)),
      12
    );
    expect(survivor.collisionRadius).toBeCloseTo(
      Math.cbrt(Math.pow(0.08, 3) + Math.pow(0.05, 3)),
      12
    );

    // 线动量严格守恒
    expect(survivor.mass * survivor.velocity[0]).toBeCloseTo(pBefore[0], 10);
    expect(survivor.mass * survivor.velocity[1]).toBeCloseTo(pBefore[1], 10);
    expect(survivor.mass * survivor.velocity[2]).toBeCloseTo(pBefore[2], 10);

    // 机械能损耗非负且已累计，能量基准已重置使相对漂移归零
    expect(event.energyLoss).toBeGreaterThan(0);
    expect(stepRes.snapshot.metrics.cumulativeEnergyLoss).toBeCloseTo(event.energyLoss, 12);
    expect(stepRes.snapshot.metrics.relativeDrift).toBeLessThan(1e-12);
    expect(engine.getCollisionEvents().length).toBe(1);
  });

  it('碰撞判定仅依赖物理 collisionRadius，不受放大后的 renderRadius 干扰', () => {
    const bodies = computeGravityForBodies(
      [
        makeBody({
          id: 'a',
          mass: 1,
          position: [0, 0, 0],
          renderRadius: 5.0,
          collisionRadius: 0.05,
        }),
        makeBody({
          id: 'b',
          mass: 1,
          position: [0.2, 0, 0],
          renderRadius: 5.0,
          collisionRadius: 0.05,
        }),
      ],
      1.0,
      0.0
    ).bodies;

    const res = resolveCollisions(bodies, 0, 1.0, 0.0, () => 'col-1');
    expect(res.merged).toBe(false);
    expect(res.bodies.length).toBe(2);
  });
});

describe('质心静止系归一化与限制性测试粒子', () => {
  it('normalizeCenterOfMass 使 R_cm = 0、V_cm = 0 且保持含行星在内的全部相对构型', () => {
    const engine = new PhysicsEngine('chaotic-trisolaris');

    // 人为施加整体平移与匀速漂移
    const initSnap = engine.getSnapshot();
    const relPosBefore = vecDist(
      initSnap.bodies[3].position,
      initSnap.bodies[0].position
    );
    const relVelBefore = vecDist(
      initSnap.bodies[3].velocity,
      initSnap.bodies[0].velocity
    );

    for (const b of initSnap.bodies) {
      engine.updateBody(b.id, {
        position: [b.position[0] + 12.5, b.position[1] - 4.2, b.position[2] + 3.1],
        velocity: [b.velocity[0] + 1.8, b.velocity[1] - 0.7, b.velocity[2] + 0.4],
      });
    }

    const shifted = engine.getSnapshot();
    expect(vecDist(shifted.metrics.centerOfMass, [0, 0, 0])).toBeGreaterThan(10);
    expect(vecDist(shifted.metrics.centerOfMassVelocity, [0, 0, 0])).toBeGreaterThan(1);

    const normalized = engine.normalizeCenterOfMass();
    expect(vecDist(normalized.metrics.centerOfMass, [0, 0, 0])).toBeLessThan(1e-12);
    expect(vecDist(normalized.metrics.centerOfMassVelocity, [0, 0, 0])).toBeLessThan(1e-12);
    expect(normalized.metrics.relativeDrift).toBeLessThan(1e-12);

    // 行星与主星之间的相对位置和相对速度必须完全保持不变
    const relPosAfter = vecDist(
      normalized.bodies[3].position,
      normalized.bodies[0].position
    );
    const relVelAfter = vecDist(
      normalized.bodies[3].velocity,
      normalized.bodies[0].velocity
    );
    expect(relPosAfter).toBeCloseTo(relPosBefore, 12);
    expect(relVelAfter).toBeCloseTo(relVelBefore, 12);

    // 同时验证纯函数 normalizeCenterOfMass
    const pureNormalized = normalizeCenterOfMass(shifted.bodies);
    const pureMetrics = computeEnergyMetrics(pureNormalized, 1.0, 0.015);
    expect(vecDist(pureMetrics.centerOfMass, [0, 0, 0])).toBeLessThan(1e-12);
    expect(vecDist(pureMetrics.centerOfMassVelocity, [0, 0, 0])).toBeLessThan(1e-12);
  });

  it('加入 isTestParticle = true 的三体行星后，恒星轨迹与无行星时完全一致', () => {
    // 1. Velocity Verlet 固定步长下应逐位完全一致（误差 = 0）
    const engineNoPlanetVerlet = new PhysicsEngine('figure-8');
    engineNoPlanetVerlet.updateConfig({ integrator: 'verlet', verletDt: 0.002 });

    const engineWithPlanetVerlet = new PhysicsEngine('figure-8');
    engineWithPlanetVerlet.updateConfig({ integrator: 'verlet', verletDt: 0.002 });
    engineWithPlanetVerlet.addBody({
      role: 'planet',
      mass: 0.5, // 故意给较大质量，验证 isTestParticle=true 确实施加零反作用力
      position: [0.35, 0.45, 0.1],
      velocity: [-0.8, 0.6, 0.05],
      isTestParticle: true,
    });

    const p0 = engineWithPlanetVerlet.getSnapshot().bodies[3].position;
    engineNoPlanetVerlet.step(2.0, { maxSubsteps: 5000 });
    engineWithPlanetVerlet.step(2.0, { maxSubsteps: 5000 });

    const sA = engineNoPlanetVerlet.getSnapshot();
    const sB = engineWithPlanetVerlet.getSnapshot();

    for (let i = 0; i < 3; i++) {
      expect(vecDist(sA.bodies[i].position, sB.bodies[i].position)).toBe(0);
      expect(vecDist(sA.bodies[i].velocity, sB.bodies[i].velocity)).toBe(0);
    }
    // 行星本身必须真实受到恒星引力作用产生位移
    expect(vecDist(sB.bodies[3].position, p0)).toBeGreaterThan(0.5);
    // 系统守恒能不被测试粒子污染
    expect(sB.metrics.total).toBeCloseTo(sA.metrics.total, 14);

    // 2. DOPRI5(4) 自适应步长下恒星轨迹同样高度一致（误差 < 1e-8）
    const engineNoPlanetDopri = new PhysicsEngine('figure-8');
    const engineWithPlanetDopri = new PhysicsEngine('figure-8');
    engineWithPlanetDopri.addTrisolarisPlanet();

    engineNoPlanetDopri.step(1.5, { maxSubsteps: 5000 });
    engineWithPlanetDopri.step(1.5, { maxSubsteps: 5000 });

    const dA = engineNoPlanetDopri.getSnapshot();
    const dB = engineWithPlanetDopri.getSnapshot();

    for (let i = 0; i < 3; i++) {
      expect(vecDist(dA.bodies[i].position, dB.bodies[i].position)).toBeLessThan(1e-8);
      expect(vecDist(dA.bodies[i].velocity, dB.bodies[i].velocity)).toBeLessThan(1e-8);
    }
    expect(dB.metrics.relativeDrift).toBeLessThan(1e-8);
  });
});

describe('三体行星热力学、滞回状态机、统一近地坐标基与原著天象事件', () => {
  it('chaotic-trisolaris 开局处于宜居恒纪元（约 20~25°C）且温度与自转随时间稳定演化', () => {
    const engine = new PhysicsEngine('chaotic-trisolaris');
    const snap0 = engine.getSnapshot();

    expect(snap0.planetTelemetry).not.toBeNull();
    const tel0 = snap0.planetTelemetry!;
    expect(tel0.normalizedFlux).toBeCloseTo(1.0, 2);
    expect(tel0.temperatureC).toBeGreaterThanOrEqual(20);
    expect(tel0.temperatureC).toBeLessThanOrEqual(25);
    expect(tel0.eraStatus.era).toBe('stable');
    expect(tel0.eraStatus.subState).toBe('habitable');

    // 短时间演进，自转角严格按 planetRotationRate * dt 递增
    const rate = engine.getConfig().planetRotationRate;
    const dt = 0.2;
    const snap1 = engine.step(dt, { maxSubsteps: 2000 }).snapshot;
    const tel1 = snap1.planetTelemetry!;

    expect(tel1.rotationAngle).toBeCloseTo(rate * dt, 6);
    expect(tel1.eraStatus.era).toBe('stable');
    expect(tel1.eraStatus.eraDuration).toBeGreaterThan(0.15);
    expect(tel1.eraStatus.longestStableDuration).toBeGreaterThanOrEqual(
      tel1.eraStatus.eraDuration
    );
  });

  it('斯特藩-玻尔兹曼热惯性：近距酷热升温快、深空极寒降温显著变缓且始终安全夹持', () => {
    // 强辐射下迅速进入酷热状态且不发散
    const hotTempK = stepPlanetTemperature(295, REFERENCE_FLUX * 80, 1.0);
    expect(hotTempK - KELVIN_OFFSET).toBeGreaterThan(HABITABLE_TEMP_MAX_C);
    expect(hotTempK).toBeLessThanOrEqual(MAX_PLANET_TEMP_K);

    // 极端辐射测试安全夹持上限
    const clampedHot = stepPlanetTemperature(295, 1e9, 2.0);
    expect(clampedHot).toBe(MAX_PLANET_TEMP_K);

    // 零辐射深空极寒测试安全夹持下限
    const clampedCold = stepPlanetTemperature(60, 0, 500);
    expect(clampedCold).toBeGreaterThanOrEqual(MIN_PLANET_TEMP_K);
    expect(clampedCold).toBeLessThan(60);

    // 检验 T⁴ 辐射散热非线性：高温 600K 的冷却速率远高于低温 100K（理论比值 6⁴ = 1296）
    const coolRateHigh = Math.abs(computeTempRate(600, 0));
    const coolRateLow = Math.abs(computeTempRate(100, 0));
    expect(coolRateHigh / coolRateLow).toBeCloseTo(Math.pow(6, 4), 6);
  });

  it('滑动窗口滞回防抖：离开乱纪元后必须连续满足宜居窗口时长才切回恒纪元', () => {
    const star = makeBody({ id: 's1', role: 'star', mass: 1.0, position: [0, 0, 0] });
    // 先把行星放在极近距离触发酷热乱纪元
    const rClose = 0.12;
    const rHab = Math.sqrt(1.0 / REFERENCE_FLUX - 0.08 * 0.08);
    const planetHot = makeBody({
      id: 'p1',
      role: 'planet',
      mass: 1e-6,
      position: [rClose, 0, 0],
      isTestParticle: true,
    });

    const tracker = new PlanetThermodynamicsTracker(planetHot, [star], 0, 0);
    let tel = tracker.evaluate(planetHot, [star]);
    expect(tel.eraStatus.era).toBe('chaotic');
    expect(tel.eraStatus.subState).toBe('scorching');

    // 瞬间移回宜居距离并把温度设为 22°C，测试滞回窗口防抖
    const planetHab = { ...planetHot, position: [rHab, 0, 0] as const };
    tracker.setTemperatureK(295.0);

    // 推进 0.20（< ERA_WINDOW_DURATION = 0.35）：即便当前温度已在 22°C，仍必须维持乱纪元防闪烁
    let t = 0;
    for (let i = 0; i < 4; i++) {
      t += 0.05;
      tel = tracker.step(planetHab, [star], 0.05, t, 0.5);
    }
    expect(tel.temperatureC).toBeGreaterThan(HABITABLE_TEMP_MIN_C);
    expect(tel.temperatureC).toBeLessThan(HABITABLE_TEMP_MAX_C);
    expect(tel.eraStatus.era).toBe('chaotic');
    expect(tel.eraStatus.subState).toBe('unstable-flux');

    // 继续稳定保持直至超过 ERA_WINDOW_DURATION（累计 >= 0.35）后才切入恒纪元
    while (t < ERA_WINDOW_DURATION + 0.05) {
      t += 0.05;
      tel = tracker.step(planetHab, [star], 0.05, t, 0.5);
    }
    expect(tel.eraStatus.era).toBe('stable');
    expect(tel.eraStatus.subState).toBe('habitable');
  });

  it('严格验证统一近地正交基 up=(cosθ,sinθ,0)、east=(-sinθ,cosθ,0)、north=(0,0,1) 与仰角/方位角', () => {
    const theta = Math.PI / 3; // 60°
    const basis = computeObserverBasis(theta);

    expect(basis.up[0]).toBeCloseTo(Math.cos(theta), 12);
    expect(basis.up[1]).toBeCloseTo(Math.sin(theta), 12);
    expect(basis.up[2]).toBe(0);

    expect(basis.east[0]).toBeCloseTo(-Math.sin(theta), 12);
    expect(basis.east[1]).toBeCloseTo(Math.cos(theta), 12);
    expect(basis.east[2]).toBe(0);

    expect(basis.north).toEqual([0, 0, 1]);

    const planet = makeBody({ id: 'p', role: 'planet', mass: 1e-6, position: [0, 0, 0] });
    const [ux, uy, uz] = basis.up;
    const [ex, ey, ez] = basis.east;
    const [nx, ny, nz] = basis.north;

    const stars = [
      // 天顶正上方：elevation = +π/2, above = true
      makeBody({ id: 'zenith', mass: 1, position: [2 * ux, 2 * uy, 2 * uz] }),
      // 天底正下方：elevation = -π/2, above = false
      makeBody({ id: 'nadir', mass: 1, position: [-2 * ux, -2 * uy, -2 * uz] }),
      // 东偏上 45°：dHat = (up + east)/sqrt(2) => elevation = π/4, azimuth = +π/2
      makeBody({
        id: 'east-45',
        mass: 1,
        position: [ux + ex, uy + ey, uz + ez],
      }),
      // 正北偏上 30°：dHat = sin(30°)up + cos(30°)north => elevation = π/6, azimuth = 0
      makeBody({
        id: 'north-30',
        mass: 1,
        position: [
          0.5 * ux + (Math.sqrt(3) / 2) * nx,
          0.5 * uy + (Math.sqrt(3) / 2) * ny,
          0.5 * uz + (Math.sqrt(3) / 2) * nz,
        ],
      }),
      // 西偏上 45°：dHat = (up - east)/sqrt(2) => elevation = π/4, azimuth = -π/2
      makeBody({
        id: 'west-45',
        mass: 1,
        position: [ux - ex, uy - ey, uz - ez],
      }),
    ];

    const obs = computeSkyObservations(planet, stars, theta);

    // zenith
    expect(obs[0].elevationRad).toBeCloseTo(Math.PI / 2, 10);
    expect(obs[0].isAboveHorizon).toBe(true);

    // nadir
    expect(obs[1].elevationRad).toBeCloseTo(-Math.PI / 2, 10);
    expect(obs[1].isAboveHorizon).toBe(false);

    // east-45
    expect(obs[2].elevationRad).toBeCloseTo(Math.PI / 4, 10);
    expect(obs[2].azimuthRad).toBeCloseTo(Math.PI / 2, 10);
    expect(obs[2].isAboveHorizon).toBe(true);

    // north-30
    expect(obs[3].elevationRad).toBeCloseTo(Math.PI / 6, 10);
    expect(obs[3].azimuthRad).toBeCloseTo(0, 10);
    expect(obs[3].isAboveHorizon).toBe(true);

    // west-45
    expect(obs[4].elevationRad).toBeCloseTo(Math.PI / 4, 10);
    expect(obs[4].azimuthRad).toBeCloseTo(-Math.PI / 2, 10);
    expect(obs[4].isAboveHorizon).toBe(true);
  });

  it('原著特征天文事件检测：三日凌空、飞星、双日炙烤与单日恒纪元', () => {
    const planet = makeBody({ id: 'p', role: 'planet', mass: 1e-6, position: [0, 0, 0] });
    // θ = 0 => up = (1, 0, 0)
    const theta = 0;

    // 1. 三日凌空：三颗近距亮星全在 x > 0（地平线以上）
    const triStars = [
      makeBody({ id: 's1', mass: 1.2, position: [0.5, 0.1, 0.0], renderRadius: 0.09 }),
      makeBody({ id: 's2', mass: 1.0, position: [0.6, -0.2, 0.1], renderRadius: 0.08 }),
      makeBody({ id: 's3', mass: 0.9, position: [0.7, 0.0, -0.2], renderRadius: 0.08 }),
    ];
    const triObs = computeSkyObservations(planet, triStars, theta);
    const triVis = triObs.filter((o) => o.isAboveHorizon).length;
    expect(triVis).toBe(3);
    const triEvent = detectAstronomicalEvent(triObs, triVis, 2.5, 110, 'chaotic');
    expect(triEvent.event).toBe('tri-solar-day');
    expect(triEvent.eventLabel).toBe('三日凌空');

    // 2. 飞星：三颗极远恒星（视张角极小）位于地平线以上
    const flyingStars = [
      makeBody({ id: 'f1', mass: 1.0, position: [9.0, 1.0, 0.5], renderRadius: 0.08 }),
      makeBody({ id: 'f2', mass: 1.0, position: [10.0, -2.0, 1.0], renderRadius: 0.08 }),
      makeBody({ id: 'f3', mass: 1.0, position: [8.5, 0.5, -1.5], renderRadius: 0.08 }),
    ];
    const flyObs = computeSkyObservations(planet, flyingStars, theta);
    expect(flyObs.every((o) => o.isFlyingStar && o.isAboveHorizon)).toBe(true);
    const flyEvent = detectAstronomicalEvent(flyObs, 3, 0.01, -150, 'chaotic');
    expect(flyEvent.event).toBe('flying-stars');

    // 3. 单日恒纪元：仅 1 颗近距太阳在地平线以上且处于恒纪元
    const singleSunStars = [
      makeBody({ id: 'h1', mass: 1.0, position: [0.4, 0, 0], renderRadius: 0.08 }),
      makeBody({ id: 'h2', mass: 1.0, position: [-2.0, 0.2, 0], renderRadius: 0.08 }),
      makeBody({ id: 'h3', mass: 1.0, position: [-2.2, -0.3, 0], renderRadius: 0.08 }),
    ];
    const singleObs = computeSkyObservations(planet, singleSunStars, theta);
    const singleVis = singleObs.filter((o) => o.isAboveHorizon).length;
    expect(singleVis).toBe(1);
    const singleEvent = detectAstronomicalEvent(singleObs, singleVis, 1.0, 22, 'stable');
    expect(singleEvent.event).toBe('single-sun-stable');

    // 4. 双日炙烤：2 颗近距太阳在地平线以上且高通量
    const biSunStars = [
      makeBody({ id: 'b1', mass: 1.1, position: [0.5, 0.1, 0], renderRadius: 0.08 }),
      makeBody({ id: 'b2', mass: 1.1, position: [0.55, -0.1, 0], renderRadius: 0.08 }),
      makeBody({ id: 'b3', mass: 0.8, position: [-2.0, 0, 0], renderRadius: 0.07 }),
    ];
    const biObs = computeSkyObservations(planet, biSunStars, theta);
    const biVis = biObs.filter((o) => o.isAboveHorizon).length;
    expect(biVis).toBe(2);
    const biEvent = detectAstronomicalEvent(biObs, biVis, 1.8, 65, 'chaotic');
    expect(biEvent.event).toBe('bi-solar-glare');
  });
});

describe('PhysicsEngine 生命周期与天体管理边界', () => {
  it('randomize 生成 E < 0 的 3D 束缚系统、质心归零、避免重叠且支持 reset 恢复', () => {
    const engine = new PhysicsEngine('figure-8');
    const snap = engine.randomize(5);

    expect(engine.getPresetId()).toBeNull();
    expect(snap.bodies.length).toBe(5);
    expect(snap.metrics.total).toBeLessThan(0);
    expect(vecDist(snap.metrics.centerOfMass, [0, 0, 0])).toBeLessThan(1e-12);
    expect(vecDist(snap.metrics.centerOfMassVelocity, [0, 0, 0])).toBeLessThan(1e-12);
    expect(snap.minPairDistance).toBeGreaterThan(0.5);
    expect(snap.bodies.some((b) => Math.abs(b.position[2]) > 1e-4)).toBe(true);

    // 推进一步再 reset，必须精确还原随机初态
    engine.stepOnce(0.1);
    expect(engine.getSnapshot().simTime).toBeCloseTo(0.1, 10);

    const restored = engine.reset();
    expect(restored.simTime).toBe(0);
    expect(restored.bodies.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(vecDist(restored.bodies[i].position, snap.bodies[i].position)).toBeLessThan(1e-12);
    }
  });

  it('addBody / removeBody / addTrisolarisPlanet / updateBody 严格遵循 MIN_BODIES ~ MAX_BODIES 与能量基准重置', () => {
    const engine = new PhysicsEngine('figure-8');
    expect(engine.getSnapshot().bodies.length).toBe(3);

    // 快捷添加三体行星并激活热力学监控
    const withPlanet = engine.addTrisolarisPlanet();
    expect(withPlanet.bodies.length).toBe(4);
    expect(withPlanet.planetTelemetry).not.toBeNull();

    // 重复调用不会重复添加行星
    expect(engine.addTrisolarisPlanet().bodies.length).toBe(4);

    // 增至 MAX_BODIES 上限后禁止继续新增，且全部 ID 唯一
    for (let k = 0; k < 10; k++) {
      engine.addBody();
    }
    const maxSnap = engine.getSnapshot();
    expect(maxSnap.bodies.length).toBe(MAX_BODIES);
    expect(new Set(maxSnap.bodies.map((b) => b.id)).size).toBe(MAX_BODIES);

    // 更新天体质量后加速度更新且 referenceEnergy 重置（relativeDrift 归零）
    const beforeAcc = engine.getSnapshot().bodies[0].acceleration;
    const afterUpdate = engine.updateBody('star-2', { mass: 2.5 });
    expect(afterUpdate.metrics.relativeDrift).toBeLessThan(1e-12);
    expect(vecDist(afterUpdate.bodies[0].acceleration, beforeAcc)).toBeGreaterThan(1e-4);

    // 删除至 MIN_BODIES 下限后禁止继续删除
    for (let k = 0; k < 10; k++) {
      const current = engine.getSnapshot().bodies;
      engine.removeBody(current[current.length - 1].id);
    }
    expect(engine.getSnapshot().bodies.length).toBe(MIN_BODIES);
  });

  it('全部 5 套经典预设均可正常加载、质心归零并稳定积分', () => {
    for (const preset of PRESETS) {
      const engine = new PhysicsEngine(preset.id);
      const snap0 = engine.getSnapshot();
      expect(snap0.bodies.length).toBe(preset.bodies.length);
      expect(vecDist(snap0.metrics.centerOfMass, [0, 0, 0])).toBeLessThan(1e-10);
      expect(vecDist(snap0.metrics.centerOfMassVelocity, [0, 0, 0])).toBeLessThan(1e-10);
      expect(snap0.metrics.relativeDrift).toBe(0);

      const res = engine.step(0.5, { maxSubsteps: 10000 });
      expect(res.snapshot.substepClamped).toBe(false);
      expect(res.snapshot.metrics.relativeDrift).toBeLessThan(1e-5);
      for (const b of res.snapshot.bodies) {
        for (const v of [...b.position, ...b.velocity, ...b.acceleration]) {
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
  });
});
