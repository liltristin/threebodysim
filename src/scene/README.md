# `src/scene/` — 原生 Three.js 3D 渲染引擎

- **零耦合边界**：严禁引入 `react` 或依赖 `src/physics/`，仅面向 `src/types/contracts.ts` 冻结契约编程。
- **统一入口**：`src/scene/index.ts` 导出实现 `ISceneRenderer` 的 `SceneRenderer` 及核心渲染子模块。

## 模块清单

| 文件 | 职责 |
| :--- | :--- |
| `SceneRenderer.ts` | 核心渲染器（`ISceneRenderer` 实现）：HDR 选择性 Bloom 管线（`ACESFilmicToneMapping` + `HalfFloatType` `EffectComposer` + `RenderPass` → `UnrealBloomPass(threshold=1.0, radius=0.55)` → `OutputPass`）、4 种相机模式（`free` / `com` / `follow` / `planet-surface`）、近地鼠标环顾交互与全量 GPU 资源销毁。 |
| `Starfield.ts` | 三层大半径深空星场（远景暗星、冷暖亮星、斜倾银河星云尘埃带），所有线性 RGB ≤ 0.85，跟随相机消除视差。 |
| `BodyVisuals.ts` | 恒星 HDR 纯自发光光球 + 日冕 Sprite + 点光源、三体行星昼夜光照球体 + 大气边缘光；`syncBodies` 干净重建与销毁旧资源；近地模式下隐藏行星自身并以相对坐标渲染恒星（含“飞星”最小可见角半径保底）。 |
| `TrailSystem.ts` | 预分配 2400 点固定容量环形缓冲区轨迹（零每帧 GC）；按位移 `Δs` 与速度方向夹角 `Δθ` 自适应采样；`NormalBlending` 透明尾端淡出且线性 RGB ≤ 0.92，交叉不触发 Bloom。 |
| `VectorHelpers.ts` | 速度矢量箭头、引力/加速度对数映射矢量箭头（`planet` 改用 `acceleration`，`star` 使用 `force`，蓝→琥珀→红色阶 ≤ 0.92）、质心 3D 十字准星、以及铺设于 **XY 平面 (`z = 0`)** 的低亮度参考网格（≤ 0.45）。 |
| `SurfaceDome.ts` | 三体行星近地沉浸穹顶：采用赤道观测者右手局部正交基（`X=east`, `Y=up`, `Z=-north`, `det=+1`）、真实深度遮挡地平线山脊剪影（`R=0.04`）及实时温度插值大气穹顶（极寒冰蓝 / 恒纪元蔚蓝暖金 / 酷热焦红，线性 RGB ≤ 0.88）。 |
| `colorUtils.ts` | HDR 线性限幅工具、恒星亮度补偿、受力色阶、赤道正交基矩阵构造与程序化 Canvas 纹理生成器。 |
