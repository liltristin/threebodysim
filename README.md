# 3D 三体运动模拟器（Three-Body Simulator）

基于 **高精度纯 TypeScript 数值物理内核**、**原生 Three.js 双档分级 3D 渲染引擎** 与 **航天遥测极简风（Aerospace Minimalism）HUD** 构建的交互式三维 N 体（2~8 颗天体）引力仿真应用，并内置**三体行星辐射热力学、恒/乱纪元状态机与行星近地沉浸视角**。

> **架构亮点**：物理计算（`src/physics`）、3D 渲染（`src/scene`）、主循环调度（`src/engine`）与 React UI（`src/ui`）四层严格解耦——物理内核零框架依赖，渲染层零 React 耦合，React 绝不每帧 `setState`，桌面与移动端均可稳定高帧率运行。

---

## 核心特性

### 1. 高精度数值物理内核（纯 TypeScript，零框架依赖）
- **双数值积分器自由切换**：
  - **DOPRI5(4) 自适应步长**（默认）：标准 Dormand-Prince 7 级 5(4) 阶嵌入法 + 零拷贝 **FSAL**（First Same As Last）复用，采用分量级混合误差容限 `scale_i = atol + rtol * max(|y_i|, |y_next_i|)`，防止微小质量行星被恒星误差淹没；内置单帧最大子步上限（`MAX_SUBSTEPS_PER_FRAME = 500`）与最小步长下限（`h_min = 1e-7`），极端近距奇点下绝不死循环或产生 `NaN`。
  - **Velocity Verlet 辛积分**：固定小步长子步推进，长期无系统性能量漂移，适合长时间观测周期轨道保真度。
- **按预设绑定软化项（Softening ε）**：精密周期解预设强制默认 `ε = 0` 以防势能畸变导致周期轨退化，混沌/随机系统默认启用安全小软化值且可实时微调或一键归零。
- **独立物理碰撞半径与完全非弹性合并**：渲染球体半径与物理 `collisionRadius` 彻底解耦；开启碰撞合并后，满足距离阈值时执行质量叠加、动量守恒、质心落位与体积立方根半径合并，自动记录机械能损耗 `ΔE_loss` 并重置能量漂移基准 `E₀`，在能量曲线上标注“碰撞合并”竖线。
- **2~8 颗天体自由扩展与质心归一化**：支持实时增删、手风琴卡片编辑天体质量/位置/速度/颜色/半径，支持一键生成总能 `E < 0` 的三维随机束缚系统与一键“消除质心漂移（CoM 归零）”；三体行星默认作为零反作用测试粒子（限制性 N 体，可切换为完整引力互作用），加入行星不破坏经典周期解。
- **近距自动时间膨胀（Auto Slow-Mo）**：当两星间距逼近阈值或自适应步长骤降时，通过指数平滑自动降低有效时间倍速，清晰呈现引力弹弓交汇瞬间并在 HUD 提示激活状态。

### 2. 三体行星热力学与近地沉浸视角
- **斯特藩-玻尔兹曼辐射热力学**：按 `1 L = 1 AU`、恒星光度 `L_i = M_i^3.5` 与辐射软化通量 `F = Σ L_i / (r_i² + ε_rad²)` 校准（`chaotic-trisolaris` 开局通量 `F_ref ≈ 6.375` 对应平衡温度 `T_eq ≈ 295 K / +22°C`），以半隐式稳定格式演化 `dT/dt = αF - βT⁴`，真实还原近距骤热、高温速冷与深空极寒缓冷的热惯性。
- **防闪烁恒/乱纪元状态机与原著天象检测**：基于滑动时间窗口与温变率阈值滞回判定**恒纪元**（持续处于 `0°C ~ 45°C` 宜居带且温变平缓）与**乱纪元**（细分酷热、极寒、急剧升温/降温、辐射剧变），并实时监测并播报原著特征天象：**三日凌空**、**飞星**、**单日恒纪元**、**双日炙烤**。
- **近地视角相对坐标系防抖动**：切换至行星近地视角时，将行星锚定于渲染原点 `(0, 0, 0)`，所有恒星按相对向量 `r_star - r_planet` 渲染，彻底消除大坐标 Float32 抖动；以世界 Z 轴自转角与赤道观测者右手局部正交基（`east, up, -north`）统一驱动地平线山脊深度遮挡、三日升落、飞星保底星芒，以及随实时表面温度平滑插值的大气穹顶（极寒冰蓝 / 恒纪元蔚蓝暖金 / 酷热焦红）。

### 3. 双档分级 3D 渲染与移动端高帧率优化
- **桌面高画质模式（`high`）**：`ACESFilmicToneMapping` + `HalfFloatType` MSAA `EffectComposer` + **半分辨率**选择性 `UnrealBloomPass(threshold = 1.0)`；非恒星元素（轨迹、箭头、网格、星空、行星、大气）线性 RGB 严格限幅 `< 1.0`，仅恒星 HDR 自发光触发柔和光晕，彻底杜绝全屏泛白；搭配 `36×24` 高模球体与 4,300 点三层深空星场。
- **移动端性能流畅模式（`performance`）**：自动检测触屏粗指针（`pointer: coarse`）或窄屏（`< 768px`），亦支持顶栏一键热切换——DPR 钳制 `<= 1.25`，彻底绕过 `EffectComposer` / `UnrealBloomPass`（初始为性能模式时不分配后处理渲染目标）直接渲染至屏幕，改用程序化 256×256 多段径向渐变 `AdditiveBlending` Sprite 替代光晕；同步切换 `16×16` 轻量球体、1,180 点轻量星场、`400` 点轨迹上限与 `8 Hz`（125 ms）HUD 节流。
- **弧长与曲率自适应环形缓冲轨迹**：每颗天体预分配固定容量环形 `BufferGeometry`（零每帧 GC），按位移阈值 `Δs` 与速度转角 `Δθ` 自适应采样，兼顾弯道圆滑与长轨迹留存；另配备 **XY 轨道平面参考网格**、3D 质心十字及对数缩放引力/加速度矢量箭头（测试粒子行星自动使用加速度矢量，保持清晰可见）。

### 4. 航天遥测极简风 HUD（Aerospace Minimalism）
- **深黑曜石暗色玻璃界面**：桌面端采用 `bg-[#070A12]/80` + 细高光描边与极简 `.aero-slider` 精密控件；移动端严格采用**零 `backdrop-blur`** 实色高不透明黑曜石材质，消除低端 GPU 合成卡顿。
- **全视口自适应布局**：
  - 顶部悬浮条内置 5 套预设快切下拉、实时纪元/温度/天象徽章、画质分级切换、固定宽 `FPS` 与一键纯净模式；390px 窄屏自动拆分二级居中微胶囊，彻底防重叠折行。
  - 底部圆角悬浮胶囊坞集成播放/暂停、单步、倍速与慢动作双读数、自动慢动作、重置、随机生成及 4 模式相机快捷切换。
  - 桌面左右侧栏精简为 `288px` 可折叠面板与手风琴天体编辑器（本地草稿防抖，10~15 Hz 遥测刷新不打断输入）；移动端（`< 768px`）自动收起侧栏进入全屏 3D 视口，点击底部“控制 / 遥测”滑出最高 `55vh` 专属 **Bottom Sheet** 抽屉。
- **零浪费原生 `<canvas>` 实时曲线**：高分屏 DPR 适配的对数纵轴相对能量漂移曲线（叠加碰撞合并标注）与翠绿宜居带（`0°C ~ 45°C`）分段着色行星温度曲线，在面板折叠、纯净模式或移动端非当前标签页时自动跳过重绘。

---

## 内置经典预设一览

所有经典预设均保留高精度初值并在质心静止系中归零（`G = 1.0`, `R_cm = 0`, `P_tot = 0`）：

| 预设名称 | ID | 默认积分器 | 默认软化 `ε` | 物理特点与观测亮点 |
| :--- | :--- | :---: | :---: | :--- |
| **8 字形周期解** | `figure-8` | `DOPRI5(4)` | `0.000` | Chenciner–Montgomery 等质量经典平面周期解（`T ≈ 6.3259`），具备线性稳定性，适合检验长期守恒精度 |
| **拉格朗日等边三角** | `lagrange-triangle` | `Velocity Verlet` | `0.000` | 刚性旋转等边三角形解析特解（`T ≈ 8.2691`），因等质量不满足 Gascheau 稳定判据，数圈后直观呈现对称破缺入混沌 |
| **双星 + 绕行恒星** | `hierarchical-binary` | `DOPRI5(4)` | `0.000` | 三维层级三体系统（内双星带 `16.3°` 倾角 + 远距伴星），编织长期稳定的三维双螺旋轨道 |
| **蝴蝶周期轨** | `butterfly-1` | `DOPRI5(4)` | `0.000` | Šuvakov–Dmitrašinović 2013 平面周期解（`T ≈ 6.2356`），正李雅普诺夫指数使其约 2~3 周期后自然过渡为混沌 |
| **混沌三体 + 三体行星** | `chaotic-trisolaris` | `DOPRI5(4)` | `0.015` | 3D 非对称质量（1.2 / 1.0 / 0.8）束缚三体 + 初始环绕主星的三体行星，默认开启温度曲线、恒/乱纪元与近地视角 |

---

## 快捷键与交互说明

| 操作 / 快捷键 | 功能说明 |
| :--- | :--- |
| `Space` | 播放 / 暂停物理仿真（聚焦输入框时自动避让） |
| `H` | 一键切换**纯净观赏模式**（隐藏全部 HUD，仅保留右上角恢复入口） |
| **鼠标左键拖拽 / 单指拖动** | 太空视角下旋转 3D 轨道相机；近地视角下 360° 偏航与地平线至天顶俯仰环顾天空 |
| **鼠标右键拖拽 / 双指平移** | 太空自由视角下平移观察目标 |
| **鼠标滚轮 / 双指捏合** | 太空视角下缩放视距；近地视角下调节广角/长焦视场角（FOV `34° ~ 85°`） |

---

## 技术栈与目录架构

### 技术栈
- **前端框架**：React 18 + TypeScript 5.8（Strict Mode）
- **构建与测试**：Vite 6 + Vitest 3
- **3D 图形**：原生 Three.js（`three@^0.174.0`，零 React Three Fiber 开销）
- **界面样式**：Tailwind CSS 3 + `lucide-react`

### 目录结构

```text
three-body-simulator/
├── index.html                           # 深空暗色入口页（zh-CN）
├── package.json                         # 依赖与脚本配置
├── vercel.json                          # Vercel SPA 重写、静态资源缓存与安全响应头
├── SPEC.md                              # 项目技术规格书
└── src/
    ├── main.tsx                         # React 18 入口
    ├── App.tsx                          # 全屏 100dvh 视口挂载、ResizeObserver 与稳定动作代理
    ├── index.css                        # Tailwind 指令、4px 透明暗轨滚动条与 .aero-slider 精密滑块
    ├── types/
    │   └── contracts.ts                 # 跨层冻结只读契约（物理快照、ISceneRenderer、HudSnapshot、SimulationActions）
    ├── presets/
    │   └── presets.ts                   # 5 套高精度经典预设库
    ├── physics/                         # 纯 TypeScript 物理内核（严禁引入 React / Three.js）
    │   ├── gravity.ts                   # 软化牛顿引力、测试粒子零反作用与恒星光度计算
    │   ├── integrators.ts               # DOPRI5(4)+FSAL 自适应积分器与 Velocity Verlet 辛积分器
    │   ├── collisions.ts                # 独立碰撞半径检测与完全非弹性合并
    │   ├── diagnostics.ts               # 能量/角动量守恒监控与质心静止系归一化
    │   ├── thermodynamics.ts            # 斯特藩-玻尔兹曼热力学、恒/乱纪元滞回状态机与天象观测
    │   ├── PhysicsEngine.ts             # 物理引擎统一封装与自动慢动作衰减评估
    │   └── __tests__/physics.test.ts    # 19 项物理精度、守恒律、热力学与边界单元测试
    ├── scene/                           # 原生 Three.js 3D 渲染引擎（严禁引入 React）
    │   ├── SceneRenderer.ts             # ISceneRenderer 实现、双档 DPR/后处理分级与 4 模式相机
    │   ├── BodyVisuals.ts               # 双模球体（36×24 / 16×16）、HDR 恒星、日冕 Sprite 与光照行星
    │   ├── Starfield.ts                 # 双档密度深空三层星场（4300 / 1180 点）
    │   ├── TrailSystem.ts               # 弧长/曲率自适应环形缓冲轨迹（零每帧 GC）
    │   ├── VectorHelpers.ts             # 速度/对数引力矢量箭头、3D 质心十字与 XY 参考网格
    │   ├── SurfaceDome.ts               # 赤道局部正交基驱动的近地山脊遮挡与温度变色大气穹顶
    │   ├── colorUtils.ts                # HDR 限幅、引力热力色阶与赤道基矩阵工具
    │   └── scene.test.ts                # 11 项渲染契约、数学正交基、HDR 限幅与画质分级单测
    ├── engine/                          # 主循环调度与节流控制层
    │   ├── SimulationController.ts      # rAF 主循环、自动慢动作平滑、画质热切换与 12.5Hz/8Hz HUD 节流
    │   └── __tests__/controller.test.ts # 10 项无头集成测试（节流、碰撞同步、移动分级与 StrictMode）
    └── ui/                              # 航天极简风 React HUD（仅消费 HudSnapshot 与 SimulationActions）
        ├── HudOverlay.tsx               # 顶栏预设快切、纪元徽章、画质切换与全局快捷键
        ├── TimelineBar.tsx              # 桌面圆角悬浮控制坞 & 移动端底部操作条
        ├── ControlPanel.tsx             # 桌面 288px 左侧控制栏（预设、积分器、软化、碰撞、天体管理）
        ├── TelemetryPanel.tsx           # 桌面 288px 右侧遥测栏（相机、视觉、守恒监控、三体行星纪元）
        ├── MobileBottomSheet.tsx        # 移动端专属 55vh 无模糊 Bottom Sheet 抽屉
        ├── charts/
        │   ├── EnergyDriftChart.tsx     # 高分屏 DPR 原生 Canvas 相对能量漂移与碰撞标注曲线
        │   └── TemperatureChart.tsx     # 高分屏 DPR 原生 Canvas 宜居带分段着色行星温度曲线
        ├── components/
        │   ├── BodyEditorCard.tsx       # 手风琴天体参数卡片（本地草稿防抖编辑）
        │   └── HudPrimitives.tsx        # 航天极简开关、分段胶囊与 .aero-slider 控件
        ├── hooks/useIsMobile.ts         # 移动端视口断点钩子（< 768px）
        └── formatters.ts                # 等宽科学计数法、温度与纪元主题格式化工具
```

---

## 本地开发、测试与部署

### 环境要求
- **Node.js 18+**（推荐 Node.js 20 / 22 / 24 LTS）与 npm

### 安装与常用命令

```bash
# 1. 安装依赖
npm install

# 2. 启动本地开发服务器（Vite HMR）
npm run dev

# 3. 运行全量自动化测试（40 项单元测试与集成测试：物理 19 + 渲染 11 + 调度集成 10）
npm run test

# 4. 运行严格 TypeScript 类型检查
npm run typecheck

# 5. 构建生产静态包（先执行 tsc --noEmit 再执行 vite build，输出至 dist/）
npm run build

# 6. 本地预览生产构建产物
npm run preview
```

### GitHub + Vercel 一键部署

本仓库已内置 [`vercel.json`](./vercel.json)，预配置了 Vite 构建指令（`npm run build`）、输出目录（`dist`）、SPA 路由回退重写（`/(.*) -> /index.html`）、`/assets/*` 一年不可变强缓存以及全站安全响应头（`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`）：

1. 将仓库推送至 GitHub（`.gitignore` 已自动排除 `node_modules/`、`dist/`、`.vercel/` 与本地环境文件）。
2. 登录 [Vercel](https://vercel.com/) → **Add New Project** → 导入该 GitHub 仓库。
3. Vercel 将自动识别 `vercel.json` 中的 Vite 框架配置，无需额外填写环境变量，直接点击 **Deploy** 即可上线。
