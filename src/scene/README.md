# `src/scene/` — 原生 Three.js 3D 渲染引擎

- **零耦合边界**：严禁引入 `react` 或依赖 `src/physics/`，仅面向 `src/types/contracts.ts` 冻结契约编程。
- **统一入口**：`src/scene/index.ts` 导出实现 `ISceneRenderer` 的 `SceneRenderer` 及核心渲染子模块。

## 画质与帧率分级（`QualityMode`）

| 维度 | `'high'`（桌面高画质） | `'performance'`（移动端高帧率） |
| :--- | :--- | :--- |
| DPR 上限 | `Math.min(dpr, 2)` | `Math.min(dpr, 1.25)` |
| 渲染管线 | `HalfFloatType` MSAA `EffectComposer` + **半分辨率** `UnrealBloomPass(threshold=1.0)` + `OutputPass`（按需懒初始化） | 彻底绕过 `EffectComposer` / `UnrealBloomPass`，直出 `renderer.render`（保留 `ACESFilmicToneMapping` + `SRGBColorSpace`，初始性能模式不分配后处理缓冲） |
| 恒星光晕 | 克制日冕 Sprite（配合选择性 Bloom 防叠爆） | 增强多段径向渐变 Additive Sprite 光晕（大半径 + 高不透明度 + 鲜活色泽） |
| 星体球面细分 | `SphereGeometry(1, 36, 24)` | `SphereGeometry(1, 16, 16)` |
| 深空星场点数 | 3400 暗星 + 420 亮星 + 480 星云（共 4300 点） | 900 暗星 + 160 亮星 + 120 星云（共 1180 点） |

## 模块清单

| 文件 | 职责 |
| :--- | :--- |
| `SceneRenderer.ts` | 核心渲染器（`ISceneRenderer` 实现）：分级 DPR、懒初始化后处理与性能模式直出旁路、高画质半分辨率 Bloom、4 种相机模式（`free` / `com` / `follow` / `planet-surface`）、近地鼠标环顾交互与全量 GPU 资源销毁。 |
| `Starfield.ts` | 三层大半径深空星场（远景暗星、冷暖亮星、斜倾银河星云尘埃带），支持 `setQualityMode` 热切换密度，全部线性 RGB ≤ 0.85。 |
| `BodyVisuals.ts` | 预置 36×24 与 16×16 两套共享单位球体并支持热切换；恒星 HDR 自发光光球 + 分级日冕 Sprite + 点光源，行星昼夜光照 + 大气边缘光；近地模式隐藏行星自身并以相对坐标渲染恒星（含“飞星”最小可见角半径保底）。 |
| `TrailSystem.ts` | 预分配 2400 点固定容量环形缓冲区轨迹（零每帧 GC）；按位移 `Δs` 与速度方向夹角 `Δθ` 自适应采样；`NormalBlending` 透明尾端淡出且线性 RGB ≤ 0.92。 |
| `VectorHelpers.ts` | 速度矢量箭头、引力/加速度对数映射矢量箭头（`planet` 改用 `acceleration`，`star` 使用 `force`，蓝→琥珀→红色阶 ≤ 0.92）、质心 3D 十字准星、以及铺设于 **XY 平面 (`z = 0`)** 的低亮度参考网格（≤ 0.45）。 |
| `SurfaceDome.ts` | 三体行星近地沉浸穹顶：采用赤道观测者右手局部正交基（`X=east`, `Y=up`, `Z=-north`, `det=+1`）、真实深度遮挡地平线山脊剪影（`R=0.04`）及实时温度插值大气穹顶（极寒冰蓝 / 恒纪元蔚蓝暖金 / 酷热焦红，线性 RGB ≤ 0.88）。 |
| `colorUtils.ts` | HDR 线性限幅工具、恒星亮度补偿、受力色阶、赤道正交基矩阵构造与程序化 Canvas 纹理生成器（含性能模式多段径向渐变光晕纹理）。 |
