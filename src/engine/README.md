# `src/engine/` — 仿真调度控制层

- `SimulationController.ts`：单核调度器，桥接 `PhysicsEngine` 与 `ISceneRenderer`，在 `requestAnimationFrame` 中执行单帧时间步钳制（`<= 0.05s`）、近距自动慢动作指数平滑、有界历史环形数组采样（上限 300 点），并以 10~15 Hz（80ms）节流向 React UI 推送 `HudSnapshot`。
- 完整实现 23 项 `SimulationActions`，支持碰撞合并后相机目标自动回退与暂停态即时渲染，兼容 React 18 StrictMode 双重挂载/卸载。
- `__tests__/controller.test.ts`：注入 mock `ISceneRenderer` 的无头 Vitest 集成测试。
