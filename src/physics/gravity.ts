/**
 * 牛顿万有引力计算与天体光度辅助函数
 * 支持可调软化项 ε 与零反作用限制性测试粒子（isTestParticle）
 */

import type { BodyRole, BodyState, Vec3 } from '../types/contracts';

/** 防止 r = 0 且 ε = 0 时出现 0/0 奇点的极小下限 */
const MIN_DIST_SQ_GUARD = 1e-30;

/**
 * 恒星无量纲光度估算（L = M^3.5；行星为 0）
 */
export function computeLuminosity(role: BodyRole, mass: number): number {
  if (role !== 'star') {
    return 0;
  }
  const safeMass = Math.max(mass, 0);
  return Math.pow(safeMass, 3.5);
}

/**
 * 基于扁平 Float64Array 缓冲区计算 N 体引力加速度（零 GC，用于积分器高频调用）
 *
 * 物理规则：
 * - a_i = Σ_{j≠i, !isTest[j]} G * m_j * (r_j - r_i) / (|r_j - r_i|² + ε²)^(3/2)
 * - isTestParticle[j] === 1 的天体受其他非测试天体引力，但对任何天体施加零反作用力。
 *
 * @returns 所有天体对之间的最小欧氏间距（n < 2 时返回 Infinity）
 */
export function computeAccelerationsFlat(
  positions: Float64Array,
  masses: Float64Array,
  isTestParticle: Uint8Array,
  count: number,
  G: number,
  softening: number,
  outAccelerations: Float64Array
): number {
  outAccelerations.fill(0, 0, count * 3);

  if (count < 2) {
    return Number.POSITIVE_INFINITY;
  }

  const epsSq = softening * softening;
  let minDistSq = Number.POSITIVE_INFINITY;

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const xi = positions[i3];
    const yi = positions[i3 + 1];
    const zi = positions[i3 + 2];
    const mi = masses[i];
    const iTest = isTestParticle[i] !== 0;

    for (let j = i + 1; j < count; j++) {
      const j3 = j * 3;
      const dx = positions[j3] - xi;
      const dy = positions[j3 + 1] - yi;
      const dz = positions[j3 + 2] - zi;

      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < minDistSq) {
        minDistSq = distSq;
      }

      const jTest = isTestParticle[j] !== 0;
      if (iTest && jTest) {
        continue;
      }

      const denomSq = distSq + epsSq;
      if (denomSq <= MIN_DIST_SQ_GUARD) {
        continue;
      }

      const invDist = 1 / Math.sqrt(denomSq);
      const invDist3 = invDist / denomSq;

      // j 对 i 的引力（仅当 j 非测试粒子）
      if (!jTest) {
        const factorI = G * masses[j] * invDist3;
        outAccelerations[i3] += dx * factorI;
        outAccelerations[i3 + 1] += dy * factorI;
        outAccelerations[i3 + 2] += dz * factorI;
      }

      // i 对 j 的引力（仅当 i 非测试粒子）
      if (!iTest) {
        const factorJ = G * mi * invDist3;
        outAccelerations[j3] -= dx * factorJ;
        outAccelerations[j3 + 1] -= dy * factorJ;
        outAccelerations[j3 + 2] -= dz * factorJ;
      }
    }
  }

  return Number.isFinite(minDistSq) ? Math.sqrt(minDistSq) : Number.POSITIVE_INFINITY;
}

/**
 * 计算所有天体对之间的最小间距
 */
export function computeMinPairDistance(bodies: readonly BodyState[]): number {
  const n = bodies.length;
  if (n < 2) {
    return Number.POSITIVE_INFINITY;
  }

  let minDistSq = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const pi = bodies[i].position;
    for (let j = i + 1; j < n; j++) {
      const pj = bodies[j].position;
      const dx = pj[0] - pi[0];
      const dy = pj[1] - pi[1];
      const dz = pj[2] - pi[2];
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq < minDistSq) {
        minDistSq = dSq;
      }
    }
  }
  return Math.sqrt(minDistSq);
}

/**
 * 计算两颗恒星（非测试粒子）之间的最小间距，供近距自动慢动作使用；
 * 若恒星不足 2 颗则退化为全部天体的最小间距。
 */
export function computeMinStarPairDistance(bodies: readonly BodyState[]): number {
  const n = bodies.length;
  if (n < 2) {
    return Number.POSITIVE_INFINITY;
  }

  let minStarDistSq = Number.POSITIVE_INFINITY;
  let starPairs = 0;

  for (let i = 0; i < n; i++) {
    if (bodies[i].role !== 'star') continue;
    const pi = bodies[i].position;
    for (let j = i + 1; j < n; j++) {
      if (bodies[j].role !== 'star') continue;
      const pj = bodies[j].position;
      const dx = pj[0] - pi[0];
      const dy = pj[1] - pi[1];
      const dz = pj[2] - pi[2];
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq < minStarDistSq) {
        minStarDistSq = dSq;
      }
      starPairs++;
    }
  }

  if (starPairs > 0 && Number.isFinite(minStarDistSq)) {
    return Math.sqrt(minStarDistSq);
  }
  return computeMinPairDistance(bodies);
}

export interface GravityResult {
  readonly bodies: BodyState[];
  readonly minPairDistance: number;
}

/**
 * 纯函数接口：为一组 BodyState 重新计算瞬时加速度、合引力、光度与最小间距
 */
export function computeGravityForBodies(
  bodies: readonly BodyState[],
  G: number,
  softening: number
): GravityResult {
  const n = bodies.length;
  const positions = new Float64Array(n * 3);
  const masses = new Float64Array(n);
  const isTest = new Uint8Array(n);
  const accelerations = new Float64Array(n * 3);

  for (let i = 0; i < n; i++) {
    const b = bodies[i];
    const i3 = i * 3;
    positions[i3] = b.position[0];
    positions[i3 + 1] = b.position[1];
    positions[i3 + 2] = b.position[2];
    masses[i] = b.mass;
    isTest[i] = b.isTestParticle ? 1 : 0;
  }

  const minPairDistance = computeAccelerationsFlat(
    positions,
    masses,
    isTest,
    n,
    G,
    softening,
    accelerations
  );

  const updated: BodyState[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = bodies[i];
    const i3 = i * 3;
    const ax = accelerations[i3];
    const ay = accelerations[i3 + 1];
    const az = accelerations[i3 + 2];
    const acc: Vec3 = [ax, ay, az];
    const force: Vec3 = [b.mass * ax, b.mass * ay, b.mass * az];
    updated[i] = {
      ...b,
      position: [b.position[0], b.position[1], b.position[2]],
      velocity: [b.velocity[0], b.velocity[1], b.velocity[2]],
      acceleration: acc,
      force,
      luminosity: computeLuminosity(b.role, b.mass),
    };
  }

  return { bodies: updated, minPairDistance };
}
