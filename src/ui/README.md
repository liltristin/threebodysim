# `src/ui/` — 航天遥测极简风 HUD 与移动端响应式界面

全中文航天遥测极简风（Aerospace Minimalism）UI 层，严格零物理/Three.js 耦合（仅依赖 `src/types/contracts.ts`、`src/presets/presets.ts`、`react` 与 `lucide-react`）。

## 设计要点
- **黑曜石材质与零移动端模糊**：桌面端（`>= 768px`）采用 `bg-[#070A12]/80 md:backdrop-blur-md border-white/[0.08]`；移动端（`< 768px`）严禁使用任何 `backdrop-blur`，统一纯半透明 `bg-[#070A12]/[0.92]`，确保高帧率流畅渲染。
- **精密控件与排版**：全量实时数据使用 `font-mono tabular-nums` 配合稳定最小宽度防抖；滑块全面使用 `.aero-slider` + `--slider-pct`；新增苹果/航天风分段胶囊 `SegmentedControl`。
- **响应式与按需重绘**：`useIsMobile`（`max-width: 767px`）在桌面端启用 `288px` 左右折叠侧栏 + 圆角胶囊 Floating Dock（含相机快捷切换），在移动端启用全屏无遮挡默认态 + 紧凑底部栏 + 最高 `55vh` 的 `MobileBottomSheet`（触控热区 `>= 40px`）；`EnergyDriftChart` / `TemperatureChart` 支持 `active` 属性在不可见时完全跳过重绘与尺寸监听。

## 导出入口 (`src/ui/index.ts`)
- `HudOverlay`（Props: `{ snapshot: HudSnapshot; actions: SimulationActions }`）
- `TimelineBar`、`ControlPanel`、`ControlPanelContent`、`TelemetryPanel`、`TelemetryPanelContent`、`MobileBottomSheet`
- `EnergyDriftChart`、`TemperatureChart`、`SegmentedControl`、`useIsMobile`
