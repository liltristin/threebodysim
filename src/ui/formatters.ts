import type {
  AstronomicalEvent,
  EraStatus,
  EraSubState,
  EraType,
} from '../types/contracts';

/** 格式化模拟时间（保留固定小数位） */
export function formatSimTime(simTime: number): string {
  if (!Number.isFinite(simTime)) return '0.00';
  if (Math.abs(simTime) >= 1000) return simTime.toFixed(1);
  return simTime.toFixed(2);
}

/** 格式化带符号浮点数 */
export function formatSigned(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}`;
}

/** 格式化常规浮点数 */
export function formatFixed(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

/** 格式化科学计数法（适用于能量漂移、步长等极小量） */
export function formatSci(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs === 0) return '0.00e+0';
  if (abs >= 1e-2 && abs < 1e4) {
    return value.toFixed(Math.min(digits + 2, 5));
  }
  return value.toExponential(digits);
}

/** 严格科学计数法（总是带指数，用于相对能量漂移与极小步长） */
export function formatStrictSci(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0.00e+0';
  return value.toExponential(digits);
}

/** 紧凑质量格式化（兼容行星 1e-6 等极小质量） */
export function formatMass(mass: number): string {
  if (!Number.isFinite(mass)) return '—';
  if (mass > 0 && mass < 0.001) return mass.toExponential(1);
  if (mass >= 100) return mass.toFixed(1);
  return mass.toFixed(3).replace(/\.?0+$/, '');
}

/** 将数值转为编辑草稿字符串（去尾随零，保留高精度） */
export function formatDraftNumber(value: number, precision = 7): string {
  if (!Number.isFinite(value)) return '0';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs < 1e-4 || abs >= 1e6) {
    return value.toExponential(4).replace(/\.?0+e/, 'e');
  }
  return Number(value.toPrecision(precision)).toString();
}

/** 格式化摄氏温度 */
export function formatTempC(tempC: number, digits = 1): string {
  if (!Number.isFinite(tempC)) return '—';
  const sign = tempC > 0 ? '+' : '';
  return `${sign}${tempC.toFixed(digits)}°C`;
}

/** 弧度转角度字符串 */
export function formatElevationDeg(rad: number): string {
  if (!Number.isFinite(rad)) return '—';
  const deg = (rad * 180) / Math.PI;
  const sign = deg > 0 ? '+' : '';
  return `${sign}${deg.toFixed(1)}°`;
}

/** 相对能量漂移健康色级（航天极简克制色阶） */
export function getDriftToneClass(relativeDrift: number): string {
  const abs = Math.abs(relativeDrift);
  if (!Number.isFinite(abs)) return 'text-slate-400';
  if (abs < 1e-6) return 'text-emerald-400';
  if (abs < 1e-4) return 'text-sky-300';
  if (abs < 1e-2) return 'text-amber-300';
  return 'text-rose-400';
}

/** 表面温度配色 */
export function getTempToneClass(tempC: number): string {
  if (!Number.isFinite(tempC)) return 'text-slate-300';
  if (tempC >= 0 && tempC <= 45) return 'text-emerald-300';
  if (tempC > 45 && tempC <= 120) return 'text-amber-300';
  if (tempC > 120) return 'text-rose-400';
  if (tempC < 0 && tempC >= -60) return 'text-sky-300';
  return 'text-sky-400';
}

export interface EraTheme {
  readonly badgeTitle: string;
  readonly containerClass: string;
  readonly pillClass: string;
  readonly titleClass: string;
  readonly dotClass: string;
  readonly subLabel: string;
}

const SUB_STATE_LABELS: Record<EraSubState, string> = {
  habitable: '气候稳定宜居',
  scorching: '酷热炙烤',
  freezing: '极寒冰封',
  'rapid-heating': '急剧升温',
  'rapid-cooling': '急剧降温',
  'unstable-flux': '辐射剧烈波动',
};

/** 按纪元与子状态返回克制航天遥测配色（无刺眼霓虹外发光） */
export function getEraTheme(eraStatus: EraStatus): EraTheme {
  const { era, subState, label } = eraStatus;
  const subLabel = label || SUB_STATE_LABELS[subState];

  if (era === 'stable') {
    return {
      badgeTitle: '恒纪元',
      containerClass: 'border-emerald-400/25 bg-emerald-500/[0.08]',
      pillClass: 'border-emerald-400/30 bg-emerald-500/[0.12] text-emerald-300',
      titleClass: 'text-emerald-300',
      dotClass: 'bg-emerald-400',
      subLabel,
    };
  }

  if (subState === 'scorching') {
    return {
      badgeTitle: '乱纪元',
      containerClass: 'border-rose-400/30 bg-rose-500/[0.09]',
      pillClass: 'border-rose-400/30 bg-rose-500/[0.12] text-rose-300',
      titleClass: 'text-rose-300',
      dotClass: 'bg-rose-400',
      subLabel,
    };
  }

  if (subState === 'freezing') {
    return {
      badgeTitle: '乱纪元',
      containerClass: 'border-sky-400/30 bg-sky-500/[0.09]',
      pillClass: 'border-sky-400/30 bg-sky-500/[0.12] text-sky-300',
      titleClass: 'text-sky-300',
      dotClass: 'bg-sky-400',
      subLabel,
    };
  }

  return {
    badgeTitle: '乱纪元',
    containerClass: 'border-amber-400/30 bg-amber-500/[0.09]',
    pillClass: 'border-amber-400/30 bg-amber-500/[0.12] text-amber-300',
    titleClass: 'text-amber-300',
    dotClass: 'bg-amber-400',
    subLabel,
  };
}

export interface EventTheme {
  readonly label: string;
  readonly badgeClass: string;
  readonly compactClass: string;
  readonly description: string;
}

/** 原著特征天文事件视觉主题 */
export function getAstroEventTheme(
  event: AstronomicalEvent,
  customLabel: string | null
): EventTheme | null {
  if (event === 'none') return null;

  switch (event) {
    case 'tri-solar-day':
      return {
        label: customLabel || '三日凌空',
        badgeClass: 'border-rose-400/35 bg-rose-500/[0.12] text-rose-200',
        compactClass: 'border-rose-400/35 bg-rose-500/[0.16] text-rose-200',
        description: '三颗恒星同时升起于地平线之上，表面遭受极强炙烤',
      };
    case 'flying-stars':
      return {
        label: customLabel || '飞星',
        badgeClass: 'border-sky-400/30 bg-sky-500/[0.10] text-sky-200',
        compactClass: 'border-sky-400/30 bg-sky-500/[0.14] text-sky-200',
        description: '恒星远离退化为微弱光点，漫长严寒降临',
      };
    case 'single-sun-stable':
      return {
        label: customLabel || '单日恒纪元',
        badgeClass: 'border-emerald-400/30 bg-emerald-500/[0.10] text-emerald-200',
        compactClass: 'border-emerald-400/30 bg-emerald-500/[0.14] text-emerald-200',
        description: '单颗主星温和照耀，文明迎来喘息窗口',
      };
    case 'bi-solar-glare':
      return {
        label: customLabel || '双日炙烤',
        badgeClass: 'border-amber-400/35 bg-amber-500/[0.12] text-amber-200',
        compactClass: 'border-amber-400/35 bg-amber-500/[0.16] text-amber-200',
        description: '双恒星同时悬于天空，地表辐射通量剧增',
      };
    default:
      return null;
  }
}

/** 温度曲线按纪元和温区着色 */
export function getTemperatureStrokeColor(era: EraType, tempC: number): string {
  if (era === 'stable') return '#34d399'; // 翠绿
  if (tempC < 0) return '#38bdf8'; // 极寒星蓝
  if (tempC > 45) return '#fb7185'; // 酷热绯红
  return '#fbbf24'; // 急剧变化琥珀
}
