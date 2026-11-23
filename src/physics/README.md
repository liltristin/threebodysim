# `src/physics/` — 纯 TypeScript 物理内核

- **严禁引入 React 或 Three.js**。
- 负责引力场计算、DOPRI5(4) 自适应积分器、Velocity Verlet 辛积分器、碰撞合并、质心归一化、能量与角动量监控、三体行星辐射热力学与恒/乱纪元状态机，以及对应的 Vitest 单元测试。
- 跨层类型统一从 `../types/contracts` 导入。
