/**
 * 三体运动模拟器 — 经典预设库
 * 约定：无量纲引力常数 G = 1.0，所有预设均已在质心静止系中归零（R_cm = 0, P_tot = 0）
 */

import type {
  BodyRole,
  IntegratorType,
  PresetBodyConfig,
  PresetDefinition,
  Vec3,
} from '../types/contracts';

export type {
  BodyRole,
  IntegratorType,
  PresetBodyConfig,
  PresetDefinition,
  Vec3,
};

export const PRESETS: readonly PresetDefinition[] = [
  // =========================================================================
  // 1. 8 字形周期解（Chenciner–Montgomery / Carles Simó）
  // 具备 KAM 线性稳定性，无软化项下可稳定循环数十个周期
  // 能量 E ≈ -1.287142，周期 T ≈ 6.32591398
  // =========================================================================
  {
    id: 'figure-8',
    name: '8 字形周期解',
    subtitle: 'Figure-8 · Chenciner–Montgomery',
    description:
      '三颗等质量恒星在同一条平面“8”字轨道上首尾相追的经典周期解。具备线性稳定性，适合检验积分器长期保真度。',
    G: 1.0,
    defaultSoftening: 0.0,
    defaultIntegrator: 'dopri54',
    recommendedRtol: 1e-10,
    recommendedVerletDt: 0.001,
    defaultTimeScale: 1.0,
    defaultCameraDistance: 4.2,
    recommendedTrailLength: 900,
    expectedPeriod: 6.32591398,
    hasTrisolarisPlanet: false,
    bodies: [
      {
        id: 'star-1',
        name: '恒星 α',
        role: 'star',
        mass: 1.0,
        position: [-0.97000436, 0.24308753, 0.0],
        velocity: [0.466203685, 0.43236573, 0.0],
        color: '#60a5fa',
        emissiveIntensity: 2.6,
        renderRadius: 0.075,
        collisionRadius: 0.025,
      },
      {
        id: 'star-2',
        name: '恒星 β',
        role: 'star',
        mass: 1.0,
        position: [0.97000436, -0.24308753, 0.0],
        velocity: [0.466203685, 0.43236573, 0.0],
        color: '#fbbf24',
        emissiveIntensity: 2.6,
        renderRadius: 0.075,
        collisionRadius: 0.025,
      },
      {
        id: 'star-3',
        name: '恒星 γ',
        role: 'star',
        mass: 1.0,
        position: [0.0, 0.0, 0.0],
        velocity: [-0.93240737, -0.86473146, 0.0],
        color: '#f87171',
        emissiveIntensity: 2.6,
        renderRadius: 0.075,
        collisionRadius: 0.025,
      },
    ],
  },

  // =========================================================================
  // 2. 拉格朗日等边三角形解（解析精确解，16 位有效数字）
  // 外接圆半径 R = 1，边长 L = √3，线速度 v = 3^(-1/4) ≈ 0.7598356856515925
  // 周期 T = 2π * 3^(1/4) ≈ 8.269137041559
  // 注：等质量构型不满足 Gascheau 稳定判据，高精度下可保持数圈对称后自然演化入混沌
  // =========================================================================
  {
    id: 'lagrange-triangle',
    name: '拉格朗日等边三角',
    subtitle: 'Lagrange Equilateral Solution',
    description:
      '三颗等质量恒星构成刚性旋转等边三角形的经典解析特解。因等质量不满足 Gascheau 稳定判据，数圈后可直观观察微小数值扰动如何触发对称破缺。',
    G: 1.0,
    defaultSoftening: 0.0,
    defaultIntegrator: 'verlet',
    recommendedRtol: 1e-11,
    recommendedVerletDt: 0.001,
    defaultTimeScale: 1.0,
    defaultCameraDistance: 4.5,
    recommendedTrailLength: 800,
    expectedPeriod: 8.269137041559,
    hasTrisolarisPlanet: false,
    bodies: [
      {
        id: 'star-1',
        name: '恒星 α',
        role: 'star',
        mass: 1.0,
        position: [1.0, 0.0, 0.0],
        velocity: [0.0, 0.7598356856515925, 0.0],
        color: '#38bdf8',
        emissiveIntensity: 2.6,
        renderRadius: 0.075,
        collisionRadius: 0.025,
      },
      {
        id: 'star-2',
        name: '恒星 β',
        role: 'star',
        mass: 1.0,
        position: [-0.5, 0.8660254037844386, 0.0],
        velocity: [-0.6580370064762462, -0.37991784282579625, 0.0],
        color: '#facc15',
        emissiveIntensity: 2.6,
        renderRadius: 0.075,
        collisionRadius: 0.025,
      },
      {
        id: 'star-3',
        name: '恒星 γ',
        role: 'star',
        mass: 1.0,
        position: [-0.5, -0.8660254037844386, 0.0],
        velocity: [0.6580370064762462, -0.37991784282579625, 0.0],
        color: '#fb7185',
        emissiveIntensity: 2.6,
        renderRadius: 0.075,
        collisionRadius: 0.025,
      },
    ],
  },

  // =========================================================================
  // 3. 双星 + 绕行恒星（3D 层级三体系统，解析精确构造至 16 位）
  // 内双星 m1=m2=1.0, a_in=0.8，轨面倾角 arctan(7/24) ≈ 16.26°（低于 Kozai-Lidov 临界角）
  // 外恒星 m3=0.6, a_out=3.6（a_out / a_in = 4.5，长期层级稳定）
  // 内周期 T_in ≈ 3.179，外周期 T_out ≈ 26.617
  // =========================================================================
  {
    id: 'hierarchical-binary',
    name: '双星 + 绕行恒星',
    subtitle: '3D Hierarchical Triple System',
    description:
      '紧密互绕的双星系统被一颗远距第三恒星环绕，双星轨面带 16.3° 倾角，在三维空间中编织出稳定的双螺旋轨迹。',
    G: 1.0,
    defaultSoftening: 0.0,
    defaultIntegrator: 'dopri54',
    recommendedRtol: 1e-9,
    recommendedVerletDt: 0.001,
    defaultTimeScale: 1.2,
    defaultCameraDistance: 8.0,
    recommendedTrailLength: 1400,
    hasTrisolarisPlanet: false,
    bodies: [
      {
        id: 'star-1',
        name: '内双星 A',
        role: 'star',
        mass: 1.0,
        position: [-1.2307692307692308, 0.0, 0.0],
        velocity: [0.0, -0.9550627735785952, -0.2213594362117866],
        color: '#fde047',
        emissiveIntensity: 2.8,
        renderRadius: 0.08,
        collisionRadius: 0.025,
      },
      {
        id: 'star-2',
        name: '内双星 B',
        role: 'star',
        mass: 1.0,
        position: [-0.4307692307692308, 0.0, 0.0],
        velocity: [0.0, 0.562830503302227, 0.2213594362117866],
        color: '#fb923c',
        emissiveIntensity: 2.7,
        renderRadius: 0.08,
        collisionRadius: 0.025,
      },
      {
        id: 'star-3',
        name: '远距伴星 C',
        role: 'star',
        mass: 0.6,
        position: [2.7692307692307692, 0.0, 0.0],
        velocity: [0.0, 0.6537204504606136, 0.0],
        color: '#93c5fd',
        emissiveIntensity: 2.4,
        renderRadius: 0.065,
        collisionRadius: 0.02,
      },
    ],
  },

  // =========================================================================
  // 4. 蝴蝶周期轨 I（Šuvakov & Dmitrašinović 2013, PRL Table I, Class I.A.1）
  // 经典等质量平面周期解，周期 T ≈ 6.235641，能量 E ≈ -2.170194
  // 注：该周期解具有正李雅普诺夫指数，约 2~3 个完整周期后会自然过渡到混沌
  // =========================================================================
  {
    id: 'butterfly-1',
    name: '蝴蝶周期轨',
    subtitle: 'Butterfly I · Šuvakov–Dmitrašinović',
    description:
      '2013 年发现的著名平面三体周期解之一，三颗恒星在引力交汇间勾勒出对称的蝴蝶翅膀。高敏感性使其极佳地呈现“周期→混沌”的相变。',
    G: 1.0,
    defaultSoftening: 0.0,
    defaultIntegrator: 'dopri54',
    recommendedRtol: 1e-11,
    recommendedVerletDt: 0.0005,
    defaultTimeScale: 0.9,
    defaultCameraDistance: 4.0,
    recommendedTrailLength: 1200,
    expectedPeriod: 6.235641,
    hasTrisolarisPlanet: false,
    bodies: [
      {
        id: 'star-1',
        name: '恒星 α',
        role: 'star',
        mass: 1.0,
        position: [-1.0, 0.0, 0.0],
        velocity: [0.306893, 0.125507, 0.0],
        color: '#c084fc',
        emissiveIntensity: 2.6,
        renderRadius: 0.07,
        collisionRadius: 0.02,
      },
      {
        id: 'star-2',
        name: '恒星 β',
        role: 'star',
        mass: 1.0,
        position: [1.0, 0.0, 0.0],
        velocity: [0.306893, 0.125507, 0.0],
        color: '#34d399',
        emissiveIntensity: 2.6,
        renderRadius: 0.07,
        collisionRadius: 0.02,
      },
      {
        id: 'star-3',
        name: '恒星 γ',
        role: 'star',
        mass: 1.0,
        position: [0.0, 0.0, 0.0],
        velocity: [-0.613786, -0.251014, 0.0],
        color: '#f472b6',
        emissiveIntensity: 2.6,
        renderRadius: 0.07,
        collisionRadius: 0.02,
      },
    ],
  },

  // =========================================================================
  // 5. 混沌三体 + 三体行星（3D 束缚非对称系统，E ≈ -0.681 < 0）
  // 三颗恒星质量 1.2 / 1.0 / 0.8，质心与总动量严格归零
  // 三体行星初始以 r_p = 0.55 环绕恒星 α（处于其希尔球内部），开局为“恒纪元”
  // 随后伴随 β/γ 靠近发生潮汐摄动、星际俘获与“三日凌空”乱纪元
  // =========================================================================
  {
    id: 'chaotic-trisolaris',
    name: '混沌三体 + 三体行星',
    subtitle: 'Trisolaris · 恒纪元与乱纪元',
    description:
      '三颗非对称质量恒星在三维空间中混沌缠斗，一颗三体行星初始稳定环绕恒星 α 享受短暂的恒纪元，随后在另外两颗恒星的潮汐撕扯下坠入不可预测的乱纪元。',
    G: 1.0,
    defaultSoftening: 0.015,
    defaultIntegrator: 'dopri54',
    recommendedRtol: 1e-9,
    recommendedVerletDt: 0.001,
    defaultTimeScale: 0.85,
    defaultCameraDistance: 7.2,
    recommendedTrailLength: 1200,
    hasTrisolarisPlanet: true,
    bodies: [
      {
        id: 'star-1',
        name: '恒星 α（主星）',
        role: 'star',
        mass: 1.2,
        position: [-1.5, -0.5, 0.2],
        velocity: [0.2, 0.35, -0.08],
        color: '#fef08a',
        emissiveIntensity: 3.0,
        renderRadius: 0.095,
        collisionRadius: 0.03,
      },
      {
        id: 'star-2',
        name: '恒星 β（红巨）',
        role: 'star',
        mass: 1.0,
        position: [1.4, -0.6, -0.32],
        velocity: [-0.12, 0.22, 0.14],
        color: '#fb923c',
        emissiveIntensity: 2.7,
        renderRadius: 0.085,
        collisionRadius: 0.028,
      },
      {
        id: 'star-3',
        name: '恒星 γ（蓝矮）',
        role: 'star',
        mass: 0.8,
        position: [0.5, 1.5, 0.1],
        velocity: [-0.15, -0.8, -0.055],
        color: '#7dd3fc',
        emissiveIntensity: 2.9,
        renderRadius: 0.075,
        collisionRadius: 0.024,
      },
      {
        id: 'trisolaris-planet',
        name: '三体行星',
        role: 'planet',
        mass: 1e-6,
        position: [-0.95, -0.5, 0.2],
        velocity: [0.2, 1.827097891752, -0.08],
        color: '#38bdf8',
        emissiveIntensity: 0.35,
        renderRadius: 0.032,
        collisionRadius: 0.008,
        isTestParticle: true,
      },
    ],
  },
] as const;

export const PRESET_MAP: Readonly<Record<string, PresetDefinition>> = Object.fromEntries(
  PRESETS.map((preset) => [preset.id, preset])
);

export const DEFAULT_PRESET_ID = 'figure-8';
