/**
 * 天体完全非弹性碰撞检测与合并模块
 *
 * 规范要点：
 * - 碰撞判定使用独立物理半径 collisionRadius（与渲染半径解耦）：dist <= r_c1 + r_c2
 * - 质量守恒 m_new = m1 + m2，动量守恒 v_new = (m1*v1 + m2*v2) / m_new，位置取质心
 * - 保留质量更大天体的 id / name / role / color / emissiveIntensity
 * - 渲染半径与物理碰撞半径按体积立方根合并：(r1³ + r2³)^(1/3)
 * - 计算并记录碰撞机械能损耗，支持外层重置 referenceEnergy
 */

import type { BodyState, CollisionEvent, Vec3 } from '../types/contracts';
import { computeEnergyMetrics } from './diagnostics';
import { computeGravityForBodies, computeLuminosity } from './gravity';

export interface CollisionResolutionResult {
  readonly bodies: BodyState[];
  readonly events: CollisionEvent[];
  readonly totalEnergyLoss: number;
  readonly merged: boolean;
}

/**
 * 扫描当前天体列表，快速判断是否存在碰撞对（距离 <= r_c1 + r_c2）
 */
export function hasAnyCollisionFlat(
  positions: Float64Array,
  collisionRadii: Float64Array,
  count: number
): boolean {
  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const xi = positions[i3];
    const yi = positions[i3 + 1];
    const zi = positions[i3 + 2];
    const ri = collisionRadii[i];

    for (let j = i + 1; j < count; j++) {
      const j3 = j * 3;
      const dx = positions[j3] - xi;
      const dy = positions[j3 + 1] - yi;
      const dz = positions[j3 + 2] - zi;
      const sumR = ri + collisionRadii[j];
      if (dx * dx + dy * dy + dz * dz <= sumR * sumR) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 合并两颗发生碰撞的天体（完全非弹性合并）
 */
export function mergePair(bodyA: BodyState, bodyB: BodyState): BodyState {
  // 质量更大者作为幸存主体；质量相同时优先保留恒星，再保留顺序靠前者
  const aWins =
    bodyA.mass > bodyB.mass ||
    (bodyA.mass === bodyB.mass &&
      (bodyA.role === bodyB.role || bodyA.role === 'star'));
  const survivor = aWins ? bodyA : bodyB;
  const absorbed = aWins ? bodyB : bodyA;

  const m1 = bodyA.mass;
  const m2 = bodyB.mass;
  const newMass = m1 + m2;

  const invM = newMass > 0 ? 1 / newMass : 0;
  const pos: Vec3 =
    newMass > 0
      ? [
          (m1 * bodyA.position[0] + m2 * bodyB.position[0]) * invM,
          (m1 * bodyA.position[1] + m2 * bodyB.position[1]) * invM,
          (m1 * bodyA.position[2] + m2 * bodyB.position[2]) * invM,
        ]
      : [
          0.5 * (bodyA.position[0] + bodyB.position[0]),
          0.5 * (bodyA.position[1] + bodyB.position[1]),
          0.5 * (bodyA.position[2] + bodyB.position[2]),
        ];

  const vel: Vec3 =
    newMass > 0
      ? [
          (m1 * bodyA.velocity[0] + m2 * bodyB.velocity[0]) * invM,
          (m1 * bodyA.velocity[1] + m2 * bodyB.velocity[1]) * invM,
          (m1 * bodyA.velocity[2] + m2 * bodyB.velocity[2]) * invM,
        ]
      : [
          0.5 * (bodyA.velocity[0] + bodyB.velocity[0]),
          0.5 * (bodyA.velocity[1] + bodyB.velocity[1]),
          0.5 * (bodyA.velocity[2] + bodyB.velocity[2]),
        ];

  const renderRadius = Math.cbrt(
    Math.pow(bodyA.renderRadius, 3) + Math.pow(bodyB.renderRadius, 3)
  );
  const collisionRadius = Math.cbrt(
    Math.pow(bodyA.collisionRadius, 3) + Math.pow(bodyB.collisionRadius, 3)
  );

  // 若两者中至少有一个非测试天体，则合并后成为非测试天体
  const isTestParticle = survivor.isTestParticle && absorbed.isTestParticle;

  return {
    id: survivor.id,
    name: survivor.name,
    role: survivor.role,
    mass: newMass,
    position: pos,
    velocity: vel,
    color: survivor.color,
    emissiveIntensity: survivor.emissiveIntensity,
    renderRadius,
    collisionRadius,
    isTestParticle,
    acceleration: [0, 0, 0],
    force: [0, 0, 0],
    luminosity: computeLuminosity(survivor.role, newMass),
  };
}

/**
 * 循环检测并解决所有成对碰撞（支持同一时刻多体连续合并）。
 *
 * 能量损耗说明：
 * 合并后两体间的内部引力结合势能 U_12 = -G*m1*m2/sqrt(r12² + ε²) 转化为合并天体的内部自结合能，
 * 机械能损耗由碰撞前总机械能 E_before 与碰撞后（含内部自结合能）总机械能之差给出，
 * 并用 Math.max(0, ...) 保证非负；若外部系统能量直接下降 E_before - E_after 更大则取其物理损耗。
 * 对二体完全非弹性碰撞，该量精确等于相对动能耗散 ½ μ |v1 - v2|²。
 */
export function resolveCollisions(
  bodies: readonly BodyState[],
  simTime: number,
  G: number,
  softening: number,
  nextEventId: () => string
): CollisionResolutionResult {
  let current = bodies.slice();
  const events: CollisionEvent[] = [];
  let totalEnergyLoss = 0;

  while (current.length >= 2) {
    let bestI = -1;
    let bestJ = -1;
    let bestRatio = Number.POSITIVE_INFINITY;

    for (let i = 0; i < current.length; i++) {
      const bi = current[i];
      for (let j = i + 1; j < current.length; j++) {
        const bj = current[j];
        const dx = bj.position[0] - bi.position[0];
        const dy = bj.position[1] - bi.position[1];
        const dz = bj.position[2] - bi.position[2];
        const dist = Math.hypot(dx, dy, dz);
        const sumR = bi.collisionRadius + bj.collisionRadius;
        if (dist <= sumR) {
          const ratio = sumR > 0 ? dist / sumR : dist;
          if (ratio < bestRatio) {
            bestRatio = ratio;
            bestI = i;
            bestJ = j;
          }
        }
      }
    }

    if (bestI < 0 || bestJ < 0) {
      break;
    }

    const bodyA = current[bestI];
    const bodyB = current[bestJ];

    const eBefore = computeEnergyMetrics(current, G, softening).total;

    // 计算碰撞前两体间的内部引力势能（仅当两者均参与系统能量统计）
    let pairSelfPotential = 0;
    if (!bodyA.isTestParticle && !bodyB.isTestParticle) {
      const dx = bodyB.position[0] - bodyA.position[0];
      const dy = bodyB.position[1] - bodyA.position[1];
      const dz = bodyB.position[2] - bodyA.position[2];
      const denomSq = Math.max(dx * dx + dy * dy + dz * dz + softening * softening, 1e-30);
      pairSelfPotential = -(G * bodyA.mass * bodyB.mass) / Math.sqrt(denomSq);
    }

    const mergedBody = mergePair(bodyA, bodyB);
    const nextBodies: BodyState[] = [];
    for (let k = 0; k < current.length; k++) {
      if (k === bestI) {
        nextBodies.push(mergedBody);
      } else if (k !== bestJ) {
        nextBodies.push(current[k]);
      }
    }

    const eAfter = computeEnergyMetrics(nextBodies, G, softening).total;

    // 碰撞耗散的机械能：保留合并体内部引力自结合能后比较前后机械能
    // 对纯非测试二体碰撞精确等于 0.5 * (m1*m2/(m1+m2)) * |v1 - v2|²
    let energyLoss: number;
    if (!bodyA.isTestParticle && !bodyB.isTestParticle) {
      energyLoss = Math.max(0, eBefore - (eAfter + pairSelfPotential));
    } else {
      // 涉及测试粒子时，按约化质量相对动能计算碰撞耗散
      const mSum = bodyA.mass + bodyB.mass;
      const dvx = bodyA.velocity[0] - bodyB.velocity[0];
      const dvy = bodyA.velocity[1] - bodyB.velocity[1];
      const dvz = bodyA.velocity[2] - bodyB.velocity[2];
      energyLoss =
        mSum > 0
          ? Math.max(0, 0.5 * ((bodyA.mass * bodyB.mass) / mSum) * (dvx * dvx + dvy * dvy + dvz * dvz))
          : 0;
    }

    totalEnergyLoss += energyLoss;
    events.push({
      id: nextEventId(),
      simTime,
      absorbedNames: [bodyA.name, bodyB.name],
      survivorId: mergedBody.id,
      survivorName: mergedBody.name,
      newMass: mergedBody.mass,
      energyLoss,
      position: mergedBody.position,
    });

    current = nextBodies;
  }

  if (events.length > 0) {
    current = computeGravityForBodies(current, G, softening).bodies;
  }

  return {
    bodies: current,
    events,
    totalEnergyLoss,
    merged: events.length > 0,
  };
}
