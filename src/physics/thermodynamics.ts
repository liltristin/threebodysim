/**
 * 三体行星辐射热力学、统一近地局部坐标系天象观测与恒/乱纪元滞回状态机
 *
 * 物理校准基准（与 src/types/contracts.ts 严格对齐）：
 * - 辐射软化：ε_rad = 0.08
 * - 基准通量：F_ref = 6.375 对应平衡温度 T_eq = 295K (+21.85°C)
 * - 斯特藩-玻尔兹曼演化：dT/dt = α * F - β * T⁴，满足 (α / β) * F_ref = 295⁴
 * - 稳定半隐式推进：T_next = T + dt*(α*F - β*T⁴) / (1 + 4*dt*β*T³)，夹持至 [40K, 1200K]
 *
 * 统一近地视角局部正交基（跨层约定 #1）：
 * - 行星绕世界 Z 轴自转，自转角 θ = rotationAngle（随 planetRotationRate * dt 递增）
 * - 天顶 up = (cos θ, sin θ, 0)
 * - 东向 east = (-sin θ, cos θ, 0)
 * - 北向 north = (0, 0, 1)
 */

import {
  HABITABLE_TEMP_MAX_C,
  HABITABLE_TEMP_MIN_C,
  type AstronomicalEvent,
  type BodyState,
  type EraStatus,
  type EraSubState,
  type EraType,
  type PlanetTelemetry,
  type StarSkyObservation,
  type Vec3,
} from '../types/contracts';

// ============================================================================
// 热力学与观测物理常数
// ============================================================================

export const KELVIN_OFFSET = 273.15;

/** 辐射通量近距软化项 */
export const RADIATION_SOFTENING = 0.08;

/** chaotic-trisolaris 开局基准辐射通量 */
export const REFERENCE_FLUX = 6.375;

/** 基准通量对应的平衡温度（295K = +21.85°C） */
export const REFERENCE_EQUILIBRIUM_TEMP_K = 295.0;

/** 辐射热吸收系数 α */
export const THERMAL_ALPHA = 55.0;

/** 辐射散热系数 β，严格满足 (α / β) * F_ref = 295⁴ */
export const THERMAL_BETA =
  (THERMAL_ALPHA * REFERENCE_FLUX) / Math.pow(REFERENCE_EQUILIBRIUM_TEMP_K, 4);

/** 温度安全夹持区间（开尔文） */
export const MIN_PLANET_TEMP_K = 40.0;
export const MAX_PLANET_TEMP_K = 1200.0;

/** 恒纪元/乱纪元滑动窗口时长（模拟时间） */
export const ERA_WINDOW_DURATION = 0.35;

/** 判定恒纪元允许的最大温变率 |dT/dt|（°C / 模拟时间） */
export const STABLE_TEMP_RATE_THRESHOLD = 35.0;

/** 飞星判定阈值：视张角极小或距离极远 */
export const FLYING_STAR_MAX_ANGULAR_DIAMETER = 0.045;
export const FLYING_STAR_MIN_DISTANCE = 4.5;

/** 热力学半隐式子步最大步长 */
const MAX_THERMAL_SUBSTEP_DT = 0.02;

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

// ============================================================================
// 统一赤道观测者局部正交基（跨层约定 #1）
// ============================================================================

export interface ObserverBasis {
  readonly up: Vec3;
  readonly east: Vec3;
  readonly north: Vec3;
}

/**
 * 给定行星自转角 θ（绕世界 Z 轴），返回赤道观测者局部右手正交基：
 * - up    = (cos θ, sin θ, 0)
 * - east  = (-sin θ, cos θ, 0)
 * - north = (0, 0, 1)
 */
export function computeObserverBasis(rotationAngle: number): ObserverBasis {
  const cosT = Math.cos(rotationAngle);
  const sinT = Math.sin(rotationAngle);
  return {
    up: [cosT, sinT, 0],
    east: [-sinT, cosT, 0],
    north: [0, 0, 1],
  };
}

// ============================================================================
// 辐射通量、平衡温度与半隐式温度演化纯函数
// ============================================================================

export interface FluxEvaluation {
  readonly totalFlux: number;
  readonly normalizedFlux: number;
  readonly equilibriumTempK: number;
  readonly equilibriumTempC: number;
  readonly starFluxes: readonly number[];
}

/**
 * 计算行星接收的恒星辐射总通量与瞬间辐射平衡温度
 */
export function computeRadiativeFlux(
  planet: BodyState,
  stars: readonly BodyState[]
): FluxEvaluation {
  const epsSq = RADIATION_SOFTENING * RADIATION_SOFTENING;
  const starFluxes: number[] = new Array(stars.length);
  let totalFlux = 0;

  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    const dx = s.position[0] - planet.position[0];
    const dy = s.position[1] - planet.position[1];
    const dz = s.position[2] - planet.position[2];
    const distSq = dx * dx + dy * dy + dz * dz;
    const fluxI = s.luminosity / (distSq + epsSq);
    starFluxes[i] = fluxI;
    totalFlux += fluxI;
  }

  const normalizedFlux = totalFlux / REFERENCE_FLUX;
  const rawEqK =
    totalFlux > 0
      ? Math.pow((THERMAL_ALPHA * totalFlux) / THERMAL_BETA, 0.25)
      : MIN_PLANET_TEMP_K;
  const equilibriumTempK = clamp(rawEqK, MIN_PLANET_TEMP_K, MAX_PLANET_TEMP_K);

  return {
    totalFlux,
    normalizedFlux,
    equilibriumTempK,
    equilibriumTempC: equilibriumTempK - KELVIN_OFFSET,
    starFluxes,
  };
}

/**
 * 瞬时温变率 dT/dt = α * F - β * T⁴（K / simTime，数值等于 °C / simTime）
 */
export function computeTempRate(tempK: number, totalFlux: number): number {
  const t2 = tempK * tempK;
  return THERMAL_ALPHA * totalFlux - THERMAL_BETA * t2 * t2;
}

/**
 * 采用半隐式稳定格式推进斯特藩-玻尔兹曼热力学方程：
 * T_next = T + dt*(α*F - β*T⁴) / (1 + 4*dt*β*T³)
 * 大步长自动细分，并安全夹持至 [MIN_PLANET_TEMP_K, MAX_PLANET_TEMP_K]。
 */
export function stepPlanetTemperature(
  currentTempK: number,
  totalFlux: number,
  dt: number
): number {
  let temp = clamp(currentTempK, MIN_PLANET_TEMP_K, MAX_PLANET_TEMP_K);
  if (dt <= 0 || !Number.isFinite(dt)) {
    return temp;
  }

  const substeps = Math.min(200, Math.max(1, Math.ceil(dt / MAX_THERMAL_SUBSTEP_DT)));
  const h = dt / substeps;

  for (let s = 0; s < substeps; s++) {
    const t2 = temp * temp;
    const t3 = t2 * temp;
    const t4 = t2 * t2;
    const numerator = h * (THERMAL_ALPHA * totalFlux - THERMAL_BETA * t4);
    const denominator = 1 + 4 * h * THERMAL_BETA * t3;
    const nextTemp = temp + numerator / denominator;
    temp = Number.isFinite(nextTemp)
      ? clamp(nextTemp, MIN_PLANET_TEMP_K, MAX_PLANET_TEMP_K)
      : clamp(temp, MIN_PLANET_TEMP_K, MAX_PLANET_TEMP_K);
  }

  return temp;
}

// ============================================================================
// 近地天空恒星观测与原著天文事件检测
// ============================================================================

/**
 * 基于统一赤道局部正交基计算每颗恒星的天空观测参数
 */
export function computeSkyObservations(
  planet: BodyState,
  stars: readonly BodyState[],
  rotationAngle: number,
  fluxEval?: FluxEvaluation
): StarSkyObservation[] {
  const basis = computeObserverBasis(rotationAngle);
  const flux = fluxEval ?? computeRadiativeFlux(planet, stars);
  const { up, east, north } = basis;

  const observations: StarSkyObservation[] = new Array(stars.length);

  for (let i = 0; i < stars.length; i++) {
    const star = stars[i];
    const dx = star.position[0] - planet.position[0];
    const dy = star.position[1] - planet.position[1];
    const dz = star.position[2] - planet.position[2];
    const distance = Math.hypot(dx, dy, dz);
    const invDist = distance > 1e-12 ? 1 / distance : 0;

    const dHatX = dx * invDist;
    const dHatY = dy * invDist;
    const dHatZ = dz * invDist;

    const dotUp = clamp(dHatX * up[0] + dHatY * up[1] + dHatZ * up[2], -1, 1);
    const dotEast = dHatX * east[0] + dHatY * east[1] + dHatZ * east[2];
    const dotNorth = dHatX * north[0] + dHatY * north[1] + dHatZ * north[2];

    const elevationRad = Math.asin(dotUp);
    const azimuthRad = Math.atan2(dotEast, dotNorth);
    const isAboveHorizon = elevationRad > 0;
    const angularDiameter = 2 * Math.atan(star.renderRadius / Math.max(distance, 1e-6));
    const fluxShare = flux.totalFlux > 0 ? flux.starFluxes[i] / flux.totalFlux : 0;

    const isFlyingStar =
      angularDiameter <= FLYING_STAR_MAX_ANGULAR_DIAMETER ||
      (distance >= FLYING_STAR_MIN_DISTANCE && angularDiameter <= 0.08);

    observations[i] = {
      starId: star.id,
      starName: star.name,
      color: star.color,
      distance,
      angularDiameter,
      elevationRad,
      azimuthRad,
      fluxShare,
      isAboveHorizon,
      isFlyingStar,
    };
  }

  return observations;
}

/**
 * 基于天空恒星观测、辐射通量、表面温度与纪元判定原著特征天文事件
 */
export function detectAstronomicalEvent(
  skyObservations: readonly StarSkyObservation[],
  visibleSunCount: number,
  normalizedFlux: number,
  temperatureC: number,
  era: EraType
): { event: AstronomicalEvent; eventLabel: string | null } {
  const visibleStars = skyObservations.filter((obs) => obs.isAboveHorizon);
  const visibleFlyingStars = visibleStars.filter((obs) => obs.isFlyingStar);
  const visibleNonFlyingStars = visibleStars.filter((obs) => !obs.isFlyingStar);
  const totalFlyingStars = skyObservations.filter((obs) => obs.isFlyingStar).length;

  // 1. 三日凌空：至少 3 颗恒星同时位于地平线以上，且非全是遥远飞星，同时辐射强或已酷热
  if (
    visibleSunCount >= 3 &&
    visibleNonFlyingStars.length >= 2 &&
    (normalizedFlux >= 1.25 || temperatureC > HABITABLE_TEMP_MAX_C)
  ) {
    return { event: 'tri-solar-day', eventLabel: '三日凌空' };
  }

  // 2. 飞星天象：天空中出现多颗遥远飞星，或地平线以上全部可见太阳皆为飞星，或深空极寒多飞星
  if (
    visibleFlyingStars.length >= 2 ||
    (visibleFlyingStars.length >= 1 && visibleNonFlyingStars.length === 0) ||
    (totalFlyingStars >= 2 && normalizedFlux < 0.35)
  ) {
    const label =
      visibleFlyingStars.length >= 3
        ? '三颗飞星'
        : visibleFlyingStars.length === 2
          ? '双飞星'
          : '飞星天象';
    return { event: 'flying-stars', eventLabel: label };
  }

  // 3. 双日炙烤：至少 2 颗近距太阳同时在地平线以上且辐射高或温度超宜居上限
  if (
    visibleSunCount >= 2 &&
    visibleNonFlyingStars.length >= 2 &&
    (normalizedFlux >= 1.35 || temperatureC > HABITABLE_TEMP_MAX_C)
  ) {
    return { event: 'bi-solar-glare', eventLabel: '双日炙烤' };
  }

  // 4. 单日恒纪元：处于恒纪元且天空仅有一颗非飞星太阳高悬
  if (era === 'stable' && visibleSunCount === 1 && visibleNonFlyingStars.length === 1) {
    return { event: 'single-sun-stable', eventLabel: '单日恒纪元' };
  }

  return { event: 'none', eventLabel: null };
}

// ============================================================================
// 恒纪元 / 乱纪元滑动窗口滞回状态机
// ============================================================================

interface EraWindowSample {
  readonly time: number;
  readonly isInstantHabitable: boolean;
}

export class PlanetThermodynamicsTracker {
  private planetId: string;
  private temperatureK: number;
  private rotationAngle: number;
  private currentEra: EraType;
  private eraDuration: number;
  private longestStableDuration: number;
  private windowSamples: EraWindowSample[];
  private continuousHabitableDuration: number;

  constructor(
    planet: BodyState,
    stars: readonly BodyState[],
    simTime = 0,
    initialRotationAngle = 0
  ) {
    this.planetId = planet.id;
    this.rotationAngle = initialRotationAngle;

    const flux = computeRadiativeFlux(planet, stars);
    this.temperatureK = flux.equilibriumTempK;
    const initTempC = this.temperatureK - KELVIN_OFFSET;
    const initRate = computeTempRate(this.temperatureK, flux.totalFlux);

    const initHabitable = isInstantaneouslyHabitable(initTempC, initRate);

    this.eraDuration = 0;
    this.longestStableDuration = 0;

    if (initHabitable) {
      // 开局平衡温度处于宜居带时预填充稳定窗口，确保 chaotic-trisolaris 开局即为“恒纪元”
      this.windowSamples = [
        { time: simTime - ERA_WINDOW_DURATION, isInstantHabitable: true },
        { time: simTime, isInstantHabitable: true },
      ];
      this.continuousHabitableDuration = ERA_WINDOW_DURATION;
      this.currentEra = 'stable';
    } else {
      this.windowSamples = [{ time: simTime, isInstantHabitable: false }];
      this.continuousHabitableDuration = 0;
      this.currentEra = 'chaotic';
    }
  }

  public getPlanetId(): string {
    return this.planetId;
  }

  public getTemperatureK(): number {
    return this.temperatureK;
  }

  public getRotationAngle(): number {
    return this.rotationAngle;
  }

  public setTemperatureK(tempK: number): void {
    this.temperatureK = clamp(tempK, MIN_PLANET_TEMP_K, MAX_PLANET_TEMP_K);
  }

  public setRotationAngle(angle: number): void {
    this.rotationAngle = angle;
  }

  /**
   * 推进一个时间步 dt，更新行星温度、自转角与恒/乱纪元滞回状态机
   */
  public step(
    planet: BodyState,
    stars: readonly BodyState[],
    dt: number,
    simTime: number,
    planetRotationRate: number
  ): PlanetTelemetry {
    this.planetId = planet.id;
    const flux = computeRadiativeFlux(planet, stars);

    if (dt > 0 && Number.isFinite(dt)) {
      this.temperatureK = stepPlanetTemperature(this.temperatureK, flux.totalFlux, dt);
      this.rotationAngle += planetRotationRate * dt;

      const tempC = this.temperatureK - KELVIN_OFFSET;
      const rate = computeTempRate(this.temperatureK, flux.totalFlux);
      const instantHabitable = isInstantaneouslyHabitable(tempC, rate);

      // 维护滑动时间窗口 (simTime - ERA_WINDOW_DURATION, simTime]
      this.windowSamples.push({ time: simTime, isInstantHabitable: instantHabitable });
      const cutoff = simTime - ERA_WINDOW_DURATION;
      while (
        this.windowSamples.length > 1 &&
        this.windowSamples[0].time <= cutoff + 1e-12
      ) {
        this.windowSamples.shift();
      }

      if (instantHabitable) {
        this.continuousHabitableDuration += dt;
      } else {
        this.continuousHabitableDuration = 0;
      }

      const allWindowHabitable = this.windowSamples.every((s) => s.isInstantHabitable);
      const nextEra: EraType =
        instantHabitable &&
        allWindowHabitable &&
        this.continuousHabitableDuration >= ERA_WINDOW_DURATION - 1e-9
          ? 'stable'
          : 'chaotic';

      if (nextEra === this.currentEra) {
        this.eraDuration += dt;
      } else {
        this.currentEra = nextEra;
        this.eraDuration = 0;
      }

      if (this.currentEra === 'stable' && this.eraDuration > this.longestStableDuration) {
        this.longestStableDuration = this.eraDuration;
      }
    }

    return this.buildTelemetry(planet, stars, flux);
  }

  /**
   * 仅基于当前位置与状态构建遥测快照（不推进时间）
   */
  public evaluate(planet: BodyState, stars: readonly BodyState[]): PlanetTelemetry {
    this.planetId = planet.id;
    const flux = computeRadiativeFlux(planet, stars);
    return this.buildTelemetry(planet, stars, flux);
  }

  private buildTelemetry(
    planet: BodyState,
    stars: readonly BodyState[],
    flux: FluxEvaluation
  ): PlanetTelemetry {
    const temperatureC = this.temperatureK - KELVIN_OFFSET;
    const tempRateCPerSimTime = computeTempRate(this.temperatureK, flux.totalFlux);
    const skyObservations = computeSkyObservations(
      planet,
      stars,
      this.rotationAngle,
      flux
    );

    let visibleSunCount = 0;
    for (const obs of skyObservations) {
      if (obs.isAboveHorizon) {
        visibleSunCount++;
      }
    }

    const { subState, label } = classifyEraSubState(
      this.currentEra,
      temperatureC,
      tempRateCPerSimTime
    );

    const { event, eventLabel } = detectAstronomicalEvent(
      skyObservations,
      visibleSunCount,
      flux.normalizedFlux,
      temperatureC,
      this.currentEra
    );

    const eraStatus: EraStatus = {
      era: this.currentEra,
      subState,
      label,
      event,
      eventLabel,
      eraDuration: this.eraDuration,
      longestStableDuration: this.longestStableDuration,
    };

    return {
      planetId: planet.id,
      temperatureK: this.temperatureK,
      temperatureC,
      equilibriumTempC: flux.equilibriumTempC,
      tempRateCPerSimTime,
      normalizedFlux: flux.normalizedFlux,
      rotationAngle: this.rotationAngle,
      visibleSunCount,
      skyObservations,
      eraStatus,
    };
  }
}

function isInstantaneouslyHabitable(tempC: number, tempRate: number): boolean {
  return (
    tempC >= HABITABLE_TEMP_MIN_C &&
    tempC <= HABITABLE_TEMP_MAX_C &&
    Math.abs(tempRate) <= STABLE_TEMP_RATE_THRESHOLD
  );
}

function classifyEraSubState(
  era: EraType,
  tempC: number,
  tempRate: number
): { subState: EraSubState; label: string } {
  if (era === 'stable') {
    return { subState: 'habitable', label: '恒纪元 · 气候宜居' };
  }

  if (tempC > HABITABLE_TEMP_MAX_C) {
    return {
      subState: 'scorching',
      label: tempC > 120 ? '乱纪元 · 炙热熔炉' : '乱纪元 · 酷热炙烤',
    };
  }

  if (tempC < HABITABLE_TEMP_MIN_C) {
    return {
      subState: 'freezing',
      label: tempC < -80 ? '乱纪元 · 极寒冰封' : '乱纪元 · 严寒冰冻',
    };
  }

  if (tempRate >= STABLE_TEMP_RATE_THRESHOLD) {
    return { subState: 'rapid-heating', label: '乱纪元 · 急剧升温' };
  }

  if (tempRate <= -STABLE_TEMP_RATE_THRESHOLD) {
    return { subState: 'rapid-cooling', label: '乱纪元 · 急剧降温' };
  }

  return { subState: 'unstable-flux', label: '乱纪元 · 辐射震荡' };
}
