/**
 * 数值积分器模块：
 * 1. DOPRI5(4)：标准 Dormand-Prince 7 级 5(4) 阶自适应步长嵌入法 + FSAL 复用
 *    - 分量级混合误差容限：scale_i = atol + rtol * max(|y_i|, |y_next_i|)
 *    - 防死循环守卫：MAX_SUBSTEPS_PER_FRAME = 500，h_min = 1e-7
 * 2. Velocity Verlet：固定子步长二阶辛积分（无长期系统性能量漂移）
 */

import type { BodyState, IntegratorType, Vec3 } from '../types/contracts';
import { computeAccelerationsFlat, computeLuminosity } from './gravity';

/** 默认单帧最大子步上限（防浏览器卡死） */
export const MAX_SUBSTEPS_PER_FRAME = 500;

/** 自适应最小允许步长下限 */
export const H_MIN = 1e-7;

/** 自适应最大允许步长上限 */
export const H_MAX = 0.5;

/** DOPRI5(4) 默认初始试探步长 */
export const DEFAULT_DOPRI_INITIAL_DT = 0.005;

// ============================================================================
// Dormand-Prince 5(4) 标准 Butcher 表（Hairer, Nørsett, Wanner）
// ============================================================================

const A21 = 1 / 5;

const A31 = 3 / 40;
const A32 = 9 / 40;

const A41 = 44 / 45;
const A42 = -56 / 15;
const A43 = 32 / 9;

const A51 = 19372 / 6561;
const A52 = -25360 / 2187;
const A53 = 64448 / 6561;
const A54 = -212 / 729;

const A61 = 9017 / 3168;
const A62 = -355 / 33;
const A63 = 46732 / 5247;
const A64 = 49 / 176;
const A65 = -5103 / 18656;

// 5 阶解权重（同时是第 7 级系数 — FSAL 特性）
const B1 = 35 / 384;
// B2 = 0
const B3 = 500 / 1113;
const B4 = 125 / 192;
const B5 = -2187 / 6784;
const B6 = 11 / 84;
// B7 = 0

// 误差估计权重 e_i = b_i - b_hat_i
const E1 = 71 / 57600;
// E2 = 0
const E3 = -71 / 16695;
const E4 = 71 / 1920;
const E5 = -17253 / 339200;
const E6 = 22 / 525;
const E7 = -1 / 40;

const SAFETY_FACTOR = 0.9;
const MIN_SCALE_FACTOR = 0.2;
const MAX_SCALE_FACTOR = 5.0;

// ============================================================================
// 零 GC 可复用工作区缓冲区
// ============================================================================

export interface IntegratorWorkspace {
  capacity: number;
  /** 状态向量 [x0,y0,z0,..., vx0,vy0,vz0,...]，长度 6*n */
  y: Float64Array;
  yTemp: Float64Array;
  yNext: Float64Array;
  k1: Float64Array;
  k2: Float64Array;
  k3: Float64Array;
  k4: Float64Array;
  k5: Float64Array;
  k6: Float64Array;
  k7: Float64Array;
  /** Verlet 临时缓冲 */
  velHalf: Float64Array;
  accPrev: Float64Array;
  accCurr: Float64Array;
  /** 天体标量参数缓冲 */
  masses: Float64Array;
  isTestParticle: Uint8Array;
  collisionRadii: Float64Array;
  /** FSAL 缓存是否对当前 y 有效 */
  fsalValid: boolean;
  /** Verlet 加速度缓存是否有效 */
  verletAccValid: boolean;
  /** DOPRI5(4) 下一步建议步长 */
  suggestedDt: number;
}

export function createIntegratorWorkspace(initialCapacity = 8): IntegratorWorkspace {
  const cap = Math.max(initialCapacity, 2);
  const dim = cap * 6;
  return {
    capacity: cap,
    y: new Float64Array(dim),
    yTemp: new Float64Array(dim),
    yNext: new Float64Array(dim),
    k1: new Float64Array(dim),
    k2: new Float64Array(dim),
    k3: new Float64Array(dim),
    k4: new Float64Array(dim),
    k5: new Float64Array(dim),
    k6: new Float64Array(dim),
    k7: new Float64Array(dim),
    velHalf: new Float64Array(cap * 3),
    accPrev: new Float64Array(cap * 3),
    accCurr: new Float64Array(cap * 3),
    masses: new Float64Array(cap),
    isTestParticle: new Uint8Array(cap),
    collisionRadii: new Float64Array(cap),
    fsalValid: false,
    verletAccValid: false,
    suggestedDt: DEFAULT_DOPRI_INITIAL_DT,
  };
}

export function ensureWorkspaceCapacity(ws: IntegratorWorkspace, bodyCount: number): void {
  if (bodyCount <= ws.capacity) {
    return;
  }
  const cap = Math.max(bodyCount, ws.capacity * 2);
  const dim = cap * 6;
  ws.capacity = cap;
  ws.y = new Float64Array(dim);
  ws.yTemp = new Float64Array(dim);
  ws.yNext = new Float64Array(dim);
  ws.k1 = new Float64Array(dim);
  ws.k2 = new Float64Array(dim);
  ws.k3 = new Float64Array(dim);
  ws.k4 = new Float64Array(dim);
  ws.k5 = new Float64Array(dim);
  ws.k6 = new Float64Array(dim);
  ws.k7 = new Float64Array(dim);
  ws.velHalf = new Float64Array(cap * 3);
  ws.accPrev = new Float64Array(cap * 3);
  ws.accCurr = new Float64Array(cap * 3);
  ws.masses = new Float64Array(cap);
  ws.isTestParticle = new Uint8Array(cap);
  ws.collisionRadii = new Float64Array(cap);
  ws.fsalValid = false;
  ws.verletAccValid = false;
}

export function invalidateWorkspaceCache(ws: IntegratorWorkspace, resetSuggestedDt = false): void {
  ws.fsalValid = false;
  ws.verletAccValid = false;
  if (resetSuggestedDt) {
    ws.suggestedDt = DEFAULT_DOPRI_INITIAL_DT;
  }
}

/**
 * 将 BodyState 数组打包写入工作区扁平缓冲区
 */
export function packBodiesToWorkspace(
  bodies: readonly BodyState[],
  ws: IntegratorWorkspace
): void {
  const n = bodies.length;
  ensureWorkspaceCapacity(ws, n);
  const velOffset = n * 3;
  for (let i = 0; i < n; i++) {
    const b = bodies[i];
    const i3 = i * 3;
    ws.y[i3] = b.position[0];
    ws.y[i3 + 1] = b.position[1];
    ws.y[i3 + 2] = b.position[2];
    ws.y[velOffset + i3] = b.velocity[0];
    ws.y[velOffset + i3 + 1] = b.velocity[1];
    ws.y[velOffset + i3 + 2] = b.velocity[2];
    ws.masses[i] = b.mass;
    ws.isTestParticle[i] = b.isTestParticle ? 1 : 0;
    ws.collisionRadii[i] = b.collisionRadius;
  }
}

/**
 * 从工作区状态缓冲区回写生成新 BodyState 数组，并同步计算加速度、合力与最小间距
 */
export function unpackWorkspaceToBodies(
  templateBodies: readonly BodyState[],
  ws: IntegratorWorkspace,
  G: number,
  softening: number
): { bodies: BodyState[]; minPairDistance: number } {
  const n = templateBodies.length;
  const velOffset = n * 3;
  const posView = ws.y.subarray(0, velOffset);

  const minPairDistance = computeAccelerationsFlat(
    posView,
    ws.masses,
    ws.isTestParticle,
    n,
    G,
    softening,
    ws.accCurr
  );

  const result: BodyState[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = templateBodies[i];
    const i3 = i * 3;
    const ax = ws.accCurr[i3];
    const ay = ws.accCurr[i3 + 1];
    const az = ws.accCurr[i3 + 2];
    const pos: Vec3 = [ws.y[i3], ws.y[i3 + 1], ws.y[i3 + 2]];
    const vel: Vec3 = [
      ws.y[velOffset + i3],
      ws.y[velOffset + i3 + 1],
      ws.y[velOffset + i3 + 2],
    ];
    const acc: Vec3 = [ax, ay, az];
    const force: Vec3 = [b.mass * ax, b.mass * ay, b.mass * az];

    result[i] = {
      ...b,
      position: pos,
      velocity: vel,
      acceleration: acc,
      force,
      luminosity: computeLuminosity(b.role, b.mass),
    };
  }

  return { bodies: result, minPairDistance };
}

// ============================================================================
// 导数求值：dy/dt = [v, a(r)]
// ============================================================================

function evaluateDerivative(
  y: Float64Array,
  masses: Float64Array,
  isTestParticle: Uint8Array,
  count: number,
  G: number,
  softening: number,
  outK: Float64Array
): number {
  const velOffset = count * 3;
  // dr/dt = v
  for (let i = 0; i < velOffset; i++) {
    outK[i] = y[velOffset + i];
  }
  // dv/dt = a(r)
  const posView = y.subarray(0, velOffset);
  const accView = outK.subarray(velOffset, velOffset * 2);
  return computeAccelerationsFlat(posView, masses, isTestParticle, count, G, softening, accView);
}

// ============================================================================
// 积分器参数与结果类型
// ============================================================================

/**
 * 每完成一个被接受的子步后的回调钩子；
 * 返回 true 表示请求提前中断积分（例如检测到碰撞需要合并天体并重建状态维度）。
 */
export type AcceptedSubstepHook = (
  stepDt: number,
  elapsedTime: number,
  stateY: Float64Array
) => boolean;

export interface Dopri54FlatOptions {
  readonly count: number;
  readonly G: number;
  readonly softening: number;
  readonly rtol: number;
  readonly atol: number;
  readonly maxSubsteps?: number;
  readonly hMin?: number;
  readonly hMax?: number;
  readonly onAcceptedSubstep?: AcceptedSubstepHook;
}

export interface VerletFlatOptions {
  readonly count: number;
  readonly G: number;
  readonly softening: number;
  readonly verletDt: number;
  readonly maxSubsteps?: number;
  readonly hMin?: number;
  readonly onAcceptedSubstep?: AcceptedSubstepHook;
}

export interface FlatIntegrationResult {
  readonly dtAdvanced: number;
  readonly substeps: number;
  readonly substepClamped: boolean;
  readonly lastStepSize: number;
  readonly stoppedEarly: boolean;
}

// ============================================================================
// DOPRI5(4) + FSAL 扁平数组核心实现
// ============================================================================

export function integrateFlatDopri54(
  ws: IntegratorWorkspace,
  simDt: number,
  options: Dopri54FlatOptions
): FlatIntegrationResult {
  const n = options.count;
  const dim = n * 6;
  const maxSubsteps = Math.max(1, options.maxSubsteps ?? MAX_SUBSTEPS_PER_FRAME);
  const hMin = options.hMin ?? H_MIN;
  const hMax = options.hMax ?? H_MAX;
  const rtol = Math.max(options.rtol, 1e-14);
  const atol = Math.max(options.atol, 1e-16);
  const { G, softening, onAcceptedSubstep } = options;

  if (simDt <= 0 || !Number.isFinite(simDt) || n === 0) {
    return {
      dtAdvanced: 0,
      substeps: 0,
      substepClamped: false,
      lastStepSize: ws.suggestedDt,
      stoppedEarly: false,
    };
  }

  const y = ws.y;
  const yTemp = ws.yTemp;
  const yNext = ws.yNext;
  const { masses, isTestParticle } = ws;

  // 若 FSAL 缓存失效，先计算初始 k1 = f(y)
  if (!ws.fsalValid) {
    evaluateDerivative(y, masses, isTestParticle, n, G, softening, ws.k1);
    ws.fsalValid = true;
  }

  let currentH = Math.min(Math.max(ws.suggestedDt, hMin), hMax);
  let elapsed = 0;
  let substeps = 0;
  let lastStepSize = currentH;
  let substepClamped = false;
  let stoppedEarly = false;
  let prevRejected = false;

  const endTol = 1e-15 * Math.max(1, simDt);

  while (simDt - elapsed > endTol) {
    if (substeps >= maxSubsteps) {
      substepClamped = true;
      break;
    }

    const remaining = simDt - elapsed;
    const clippedToTarget = remaining < currentH;
    const stepH = clippedToTarget ? remaining : currentH;

    substeps++;

    const k1 = ws.k1;
    const k2 = ws.k2;
    const k3 = ws.k3;
    const k4 = ws.k4;
    const k5 = ws.k5;
    const k6 = ws.k6;
    const k7 = ws.k7;

    // Stage 2
    for (let i = 0; i < dim; i++) {
      yTemp[i] = y[i] + stepH * (A21 * k1[i]);
    }
    evaluateDerivative(yTemp, masses, isTestParticle, n, G, softening, k2);

    // Stage 3
    for (let i = 0; i < dim; i++) {
      yTemp[i] = y[i] + stepH * (A31 * k1[i] + A32 * k2[i]);
    }
    evaluateDerivative(yTemp, masses, isTestParticle, n, G, softening, k3);

    // Stage 4
    for (let i = 0; i < dim; i++) {
      yTemp[i] = y[i] + stepH * (A41 * k1[i] + A42 * k2[i] + A43 * k3[i]);
    }
    evaluateDerivative(yTemp, masses, isTestParticle, n, G, softening, k4);

    // Stage 5
    for (let i = 0; i < dim; i++) {
      yTemp[i] =
        y[i] + stepH * (A51 * k1[i] + A52 * k2[i] + A53 * k3[i] + A54 * k4[i]);
    }
    evaluateDerivative(yTemp, masses, isTestParticle, n, G, softening, k5);

    // Stage 6
    for (let i = 0; i < dim; i++) {
      yTemp[i] =
        y[i] +
        stepH *
          (A61 * k1[i] + A62 * k2[i] + A63 * k3[i] + A64 * k4[i] + A65 * k5[i]);
    }
    evaluateDerivative(yTemp, masses, isTestParticle, n, G, softening, k6);

    // 5 阶候选解 yNext (B2 = 0)
    for (let i = 0; i < dim; i++) {
      yNext[i] =
        y[i] +
        stepH *
          (B1 * k1[i] + B3 * k3[i] + B4 * k4[i] + B5 * k5[i] + B6 * k6[i]);
    }

    // Stage 7（FSAL：若该步被接受，k7 直接作为下一步的 k1）
    evaluateDerivative(yNext, masses, isTestParticle, n, G, softening, k7);

    // 分量级混合误差容限：scale_i = atol + rtol * max(|y_i|, |y_next_i|)
    let sumSq = 0;
    let isFiniteStep = true;
    for (let i = 0; i < dim; i++) {
      const yn = yNext[i];
      const k7i = k7[i];
      if (!Number.isFinite(yn) || !Number.isFinite(k7i)) {
        isFiniteStep = false;
        break;
      }
      const err =
        stepH *
        (E1 * k1[i] + E3 * k3[i] + E4 * k4[i] + E5 * k5[i] + E6 * k6[i] + E7 * k7i);
      const scale = atol + rtol * Math.max(Math.abs(y[i]), Math.abs(yn));
      const ratio = err / scale;
      sumSq += ratio * ratio;
    }

    const errNorm = isFiniteStep ? Math.sqrt(sumSq / dim) : Number.POSITIVE_INFINITY;

    // 接受条件：常规 errNorm <= 1.0；或已触及最小步长且数值有限、误差仍可控
    const atMinStep = !clippedToTarget && stepH <= hMin * (1 + 1e-12);
    const acceptStep = isFiniteStep && (errNorm <= 1.0 || (atMinStep && errNorm <= 10.0));

    if (acceptStep) {
      // 提交状态更新
      for (let i = 0; i < dim; i++) {
        y[i] = yNext[i];
      }

      // FSAL 零拷贝指针交换：下一步直接复用 k7 作为 k1
      ws.k1 = k7;
      ws.k7 = k1;
      ws.fsalValid = true;
      ws.verletAccValid = false;

      elapsed = clippedToTarget ? simDt : elapsed + stepH;

      // 自适应步长预测
      let scaleFactor: number;
      if (errNorm <= 1e-16) {
        scaleFactor = MAX_SCALE_FACTOR;
      } else {
        scaleFactor = SAFETY_FACTOR * Math.pow(errNorm, -0.2);
        scaleFactor = Math.min(MAX_SCALE_FACTOR, Math.max(MIN_SCALE_FACTOR, scaleFactor));
      }
      if (prevRejected) {
        scaleFactor = Math.min(1.0, scaleFactor);
      }
      prevRejected = false;

      const candidateH = Math.min(hMax, Math.max(hMin, stepH * scaleFactor));
      // 仅在非帧尾截短步更新真实自适应步长 lastStepSize；若帧尾截短步因误差被迫继续缩小则同步更新
      if (!clippedToTarget) {
        lastStepSize = stepH;
        currentH = candidateH;
      } else if (candidateH < stepH) {
        lastStepSize = candidateH;
        currentH = candidateH;
      }

      if (onAcceptedSubstep && onAcceptedSubstep(stepH, elapsed, y)) {
        stoppedEarly = true;
        break;
      }
    } else {
      prevRejected = true;

      // 若在最小步长下依然数值发散或误差过大，安全截断退出，绝不污染状态或死循环
      if (!clippedToTarget && stepH <= hMin * (1 + 1e-12)) {
        lastStepSize = hMin;
        currentH = hMin;
        substepClamped = true;
        break;
      }

      if (!isFiniteStep) {
        currentH = Math.max(hMin, stepH * 0.25);
      } else {
        const shrink = Math.max(
          MIN_SCALE_FACTOR,
          SAFETY_FACTOR * Math.pow(errNorm, -0.25)
        );
        currentH = Math.max(hMin, stepH * shrink);
      }
      lastStepSize = currentH;

      // 若截短到残余步长且已经 <= hMin 依然不满足容限，安全退出
      if (clippedToTarget && stepH <= hMin) {
        substepClamped = true;
        break;
      }
    }
  }

  ws.suggestedDt = Math.min(hMax, Math.max(hMin, currentH));

  return {
    dtAdvanced: elapsed,
    substeps,
    substepClamped,
    lastStepSize,
    stoppedEarly,
  };
}

// ============================================================================
// Velocity Verlet 辛积分核心实现
// ============================================================================

export function integrateFlatVerlet(
  ws: IntegratorWorkspace,
  simDt: number,
  options: VerletFlatOptions
): FlatIntegrationResult {
  const n = options.count;
  const maxSubsteps = Math.max(1, options.maxSubsteps ?? MAX_SUBSTEPS_PER_FRAME);
  const hMin = options.hMin ?? H_MIN;
  const baseDt = Math.max(options.verletDt, hMin);
  const { G, softening, onAcceptedSubstep } = options;

  if (simDt <= 0 || !Number.isFinite(simDt) || n === 0) {
    return {
      dtAdvanced: 0,
      substeps: 0,
      substepClamped: false,
      lastStepSize: baseDt,
      stoppedEarly: false,
    };
  }

  const velOffset = n * 3;
  const y = ws.y;
  const posView = y.subarray(0, velOffset);
  const velHalf = ws.velHalf;
  const accCurr = ws.accCurr;
  const accPrev = ws.accPrev;
  const { masses, isTestParticle } = ws;

  // 若加速度缓存失效，先计算初始 a(t)
  if (!ws.verletAccValid) {
    computeAccelerationsFlat(posView, masses, isTestParticle, n, G, softening, accCurr);
    ws.verletAccValid = true;
  }

  const rawSteps = Math.max(1, Math.ceil(simDt / baseDt));
  const clamped = rawSteps > maxSubsteps;
  const numSteps = clamped ? maxSubsteps : rawSteps;
  // 未触及上限时均分 simDt 保持严格恒定子步长以维持辛对称性；触及上限时保持固定 baseDt 避免步长膨胀失稳
  const h = clamped ? baseDt : simDt / numSteps;
  const halfH = 0.5 * h;

  let elapsed = 0;
  let substeps = 0;
  let substepClamped = clamped;
  let stoppedEarly = false;

  for (let s = 0; s < numSteps; s++) {
    // 备份当前状态用于异常数值回滚
    for (let i = 0; i < velOffset; i++) {
      ws.yTemp[i] = y[i];
      ws.yTemp[velOffset + i] = y[velOffset + i];
      accPrev[i] = accCurr[i];
    }

    // 1. 半步速度推进 + 整步位置推进
    let finite = true;
    for (let i = 0; i < velOffset; i++) {
      const vh = y[velOffset + i] + halfH * accCurr[i];
      const nextPos = y[i] + h * vh;
      if (!Number.isFinite(vh) || !Number.isFinite(nextPos)) {
        finite = false;
        break;
      }
      velHalf[i] = vh;
      y[i] = nextPos;
    }

    if (!finite) {
      // 回滚状态
      for (let i = 0; i < velOffset; i++) {
        y[i] = ws.yTemp[i];
        y[velOffset + i] = ws.yTemp[velOffset + i];
        accCurr[i] = accPrev[i];
      }
      substepClamped = true;
      break;
    }

    // 2. 在新位置重算加速度 a(t + h)
    computeAccelerationsFlat(posView, masses, isTestParticle, n, G, softening, accCurr);

    // 3. 第二半步速度推进
    for (let i = 0; i < velOffset; i++) {
      const nextVel = velHalf[i] + halfH * accCurr[i];
      if (!Number.isFinite(nextVel)) {
        finite = false;
        break;
      }
      y[velOffset + i] = nextVel;
    }

    if (!finite) {
      for (let i = 0; i < velOffset; i++) {
        y[i] = ws.yTemp[i];
        y[velOffset + i] = ws.yTemp[velOffset + i];
        accCurr[i] = accPrev[i];
      }
      substepClamped = true;
      break;
    }

    substeps++;
    elapsed = !clamped && s === numSteps - 1 ? simDt : elapsed + h;
    ws.fsalValid = false;

    if (onAcceptedSubstep && onAcceptedSubstep(h, elapsed, y)) {
      stoppedEarly = true;
      break;
    }
  }

  return {
    dtAdvanced: elapsed,
    substeps,
    substepClamped,
    lastStepSize: h,
    stoppedEarly,
  };
}

// ============================================================================
// 便捷纯函数封装（直接对 BodyState[] 执行单次积分）
// ============================================================================

export interface IntegrateBodiesOptions {
  readonly integrator: IntegratorType;
  readonly G: number;
  readonly softening: number;
  readonly rtol?: number;
  readonly atol?: number;
  readonly verletDt?: number;
  readonly maxSubsteps?: number;
  readonly hMin?: number;
}

export interface IntegrateBodiesResult {
  readonly bodies: BodyState[];
  readonly minPairDistance: number;
  readonly dtAdvanced: number;
  readonly substeps: number;
  readonly substepClamped: boolean;
  readonly lastStepSize: number;
}

export function integrateBodies(
  bodies: readonly BodyState[],
  simDt: number,
  options: IntegrateBodiesOptions,
  workspace?: IntegratorWorkspace
): IntegrateBodiesResult {
  const ws = workspace ?? createIntegratorWorkspace(bodies.length);
  packBodiesToWorkspace(bodies, ws);
  invalidateWorkspaceCache(ws);

  const flatResult =
    options.integrator === 'verlet'
      ? integrateFlatVerlet(ws, simDt, {
          count: bodies.length,
          G: options.G,
          softening: options.softening,
          verletDt: options.verletDt ?? 0.001,
          maxSubsteps: options.maxSubsteps,
          hMin: options.hMin,
        })
      : integrateFlatDopri54(ws, simDt, {
          count: bodies.length,
          G: options.G,
          softening: options.softening,
          rtol: options.rtol ?? 1e-10,
          atol: options.atol ?? 1e-12,
          maxSubsteps: options.maxSubsteps,
          hMin: options.hMin,
        });

  const unpacked = unpackWorkspaceToBodies(bodies, ws, options.G, options.softening);

  return {
    bodies: unpacked.bodies,
    minPairDistance: unpacked.minPairDistance,
    dtAdvanced: flatResult.dtAdvanced,
    substeps: flatResult.substeps,
    substepClamped: flatResult.substepClamped,
    lastStepSize: flatResult.lastStepSize,
  };
}
