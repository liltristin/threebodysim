# `src/ui/` — React 深空科幻 HUD 界面

全中文深空科幻毛玻璃 HUD 组件层，严格遵循渲染与物理零耦合约定（仅依赖 `src/types/contracts.ts`、`src/presets/presets.ts`、`react` 与 `lucide-react`）。

## 导出入口 (`src/ui/index.ts`)
- `HudOverlay`（Props: `{ snapshot: HudSnapshot; actions: SimulationActions }`）— 主 HUD 覆盖层，包含顶部状态条、快捷键（`H` 纯净模式 / `Space` 播放暂停）、左右可折叠面板与底部悬浮时间条。
- `TimelineBar` — 底部时间控制条（播放/暂停、单步、时间倍速与慢动作双读数、自动慢动作、重置、随机生成）。
- `ControlPanel` — 可折叠左侧栏（5 套经典预设卡片、物理引擎与数值设置、2~8 颗天体防抖草稿编辑器）。
- `TelemetryPanel` — 可折叠右侧栏（4 种相机视角与行星自转速度、3D 视觉与 Bloom 开关、物理守恒监控、三体行星恒/乱纪元与天空观测面板）。
- `charts/EnergyDriftChart` — 高分屏 DPR 原生 `<canvas>` 相对能量漂移对数曲线图（叠加碰撞合并虚线事件标注）。
- `charts/TemperatureChart` — 高分屏 DPR 原生 `<canvas>` 三体行星表面温度曲线图（背景含 0°C~45°C 翠绿宜居带阴影，按纪元分段着色）。
