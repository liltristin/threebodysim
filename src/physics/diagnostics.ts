/**
 * 物理守恒量诊断（机械能、相对能量漂移、角动量、质心）与质心静止系归一化
 */

import type { BodyState, EnergyMetrics, Vec3 } from '../types/contracts';

/** 防止势能分母为零的极小保护值 */
const MIN_DIST_SQ_GUARD = 1e-30;

/**
 * 计算机械能（动能、软化引力势能、总能）、角动量与质心状态。
 *
 * 约定：
 * - `isTestParticle === true` 的限制性测试粒子不计入系统守恒量基准，
 *   确保在精密周期解中加入测试行星不会污染能量漂移读数。
 */
export function computeEnergyMetrics(
  bodies: readonly BodyState[],
  G: number,
  softening: number,
  referenceEnergy?: number,
  cumulativeEnergyLoss = 0
): EnergyMetrics {
  const n = bodies.length;
  const epsSq = softening * softening;

  let kinetic = 0;
  let potential = 0;
  let lx = 0;
  let ly = 0;
  let lz = 0;

  let totalMass = 0;
  let cmX = 0;
  let cmY = 0;
  let cmZ = 0;
  let cmVx = 0;
  let cmVy = 0;
  let cmVz = 0;

  for (let i = 0; i < n; i++) {
    const bi = bodies[i];
    if (bi.isTestParticle) continue;

    const mi = bi.mass;
    const [rx, ry, rz] = bi.position;
    const [vx, vy, vz] = bi.velocity;

    kinetic += 0.5 * mi * (vx * vx + vy * vy + vz * vz);

    // 角动量 L = Σ m_i * (r_i × v_i)
    lx += mi * (ry * vz - rz * vy);
    ly += mi * (rz * vx - rx * vz);
    lz += mi * (rx * vy - ry * vx);

    // 质心位置与速度累加
    totalMass += mi;
    cmX += mi * rx;
    cmY += mi * ry;
    cmZ += mi * rz;
    cmVx += mi * vx;
    cmVy += mi * vy;
    cmVz += mi * vz;

    for (let j = i + 1; j < n; j++) {
      const bj = bodies[j];
      if (bj.isTestParticle) continue;

      const dx = bj.position[0] - rx;
      const dy = bj.position[1] - ry;
      const dz = bj.position[2] - rz;
      const denomSq = Math.max(dx * dx + dy * dy + dz * dz + epsSq, MIN_DIST_SQ_GUARD);
      potential -= (G * mi * bj.mass) / Math.sqrt(denomSq);
    }
  }

  const total = kinetic + potential;
  const refE = referenceEnergy !== undefined ? referenceEnergy : total;
  const relativeDrift = Math.abs(total - refE) / Math.max(Math.abs(refE), 1e-12);

  const centerOfMass: Vec3 =
    totalMass > 0 ? [cmX / totalMass, cmY / totalMass, cmZ / totalMass] : [0, 0, 0];
  const centerOfMassVelocity: Vec3 =
    totalMass > 0 ? [cmVx / totalMass, cmVy / totalMass, cmVz / totalMass] : [0, 0, 0];
  const angularMomentum: Vec3 = [lx, ly, lz];
  const angularMomentumMag = Math.hypot(lx, ly, lz);

  return {
    kinetic,
    potential,
    total,
    referenceEnergy: refE,
    relativeDrift,
    angularMomentum,
    angularMomentumMag,
    centerOfMass,
    centerOfMassVelocity,
    cumulativeEnergyLoss,
  };
}

/**
 * 质心静止系归一化：
 * 基于所有非测试天体计算质心位置 R_cm 与质心速度 V_cm，
 * 并从全部天体（含测试行星）同步扣除，使系统质心与总动量严格归零，
 * 同时完整保持全部天体的相对位置与相对速度。
 */
export function normalizeCenterOfMass(bodies: readonly BodyState[]): BodyState[] {
  let totalMass = 0;
  let cmX = 0;
  let cmY = 0;
  let cmZ = 0;
  let cmVx = 0;
  let cmVy = 0;
  let cmVz = 0;

  for (const b of bodies) {
    if (b.isTestParticle) continue;
    totalMass += b.mass;
    cmX += b.mass * b.position[0];
    cmY += b.mass * b.position[1];
    cmZ += b.mass * b.position[2];
    cmVx += b.mass * b.velocity[0];
    cmVy += b.mass * b.velocity[1];
    cmVz += b.mass * b.velocity[2];
  }

  // 极端退化情况：如果全部都是测试粒子，则退化为按全部天体质量计算质心
  if (totalMass <= 0) {
    for (const b of bodies) {
      totalMass += b.mass;
      cmX += b.mass * b.position[0];
      cmY += b.mass * b.position[1];
      cmZ += b.mass * b.position[2];
      cmVx += b.mass * b.velocity[0];
      cmVy += b.mass * b.velocity[1];
      cmVz += b.mass * b.velocity[2];
    }
  }

  if (totalMass <= 0) {
    return bodies.map((b) => ({
      ...b,
      position: [b.position[0], b.position[1], b.position[2]],
      velocity: [b.velocity[0], b.velocity[1], b.velocity[2]],
    }));
  }

  const rCmX = cmX / totalMass;
  const rCmY = cmY / totalMass;
  const rCmZ = cmZ / totalMass;
  const vCmX = cmVx / totalMass;
  const vCmY = cmVy / totalMass;
  const vCmZ = cmVz / totalMass;

  return bodies.map((b) => ({
    ...b,
    position: [b.position[0] - rCmX, b.position[1] - rCmY, b.position[2] - rCmZ],
    velocity: [b.velocity[0] - vCmX, b.velocity[1] - vCmY, b.velocity[2] - vCmZ],
  }));
}
