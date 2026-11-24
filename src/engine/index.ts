/**
 * `src/engine/` 统一出口 — 导出 SimulationController、渲染分级常量/探测函数与相关类型
 */

export {
  DESKTOP_HUD_THROTTLE_MS,
  MOBILE_HUD_THROTTLE_MS,
  PERFORMANCE_MAX_TRAIL_LENGTH,
  SimulationController,
  detectDefaultQualityMode,
  type HudListener,
  type SimulationControllerOptions,
} from './SimulationController';
