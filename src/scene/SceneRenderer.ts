/**
 * 原生 Three.js 3D 渲染引擎（SceneRenderer）
 *
 * 完整实现 `src/types/contracts.ts` 中的 `ISceneRenderer` 接口，并支持移动端高帧率渲染分级（QualityMode）：
 * - 画质分级与 DPR 管控：
 *   - `'high'`（桌面高画质）：DPR <= 2，懒初始化 `HalfFloatType` MSAA `EffectComposer` +
 *     半分辨率 `UnrealBloomPass(threshold = 1.0, radius = 0.55)` + `OutputPass`，36×24 球体与 4300 点星场。
 *   - `'performance'`（移动端高帧率）：DPR <= 1.25，彻底绕过 `EffectComposer` + `UnrealBloomPass`
 *     直接走 `ACESFilmicToneMapping` 渲染（初始即为性能模式时不分配后处理 GPU 缓冲），
 *     切换为 16×16 球体、增强多段径向渐变 Additive Sprite 光晕与 1180 点轻量星场。
 * - 弧长与曲率自适应环形缓冲区轨迹（零每帧 GC）
 * - 速度矢量箭头、引力/加速度对数缩放矢量箭头、质心 3D 十字、XY 平面参考网格
 * - 4 种相机模式（free / com / follow / planet-surface）与三体行星相对坐标系近地沉浸穹顶
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type {
  BodyState,
  CameraMode,
  ISceneRenderer,
  PhysicsSnapshot,
  QualityMode,
  Vec3,
  VisualOptions,
} from '../types/contracts';
import { DEFAULT_VISUAL_OPTIONS } from '../types/contracts';
import { BodyVisuals } from './BodyVisuals';
import {
  computeEquatorialBasisMatrix,
  hexToClampedColor,
} from './colorUtils';
import { Starfield } from './Starfield';
import { SurfaceDome } from './SurfaceDome';
import { TrailSystem } from './TrailSystem';
import { VectorHelpers } from './VectorHelpers';

const SPACE_FOV = 45;
const SPACE_NEAR = 0.02;
const SPACE_FAR = 2500;

const SURFACE_DEFAULT_FOV = 62;
const SURFACE_MIN_FOV = 34;
const SURFACE_MAX_FOV = 85;
const SURFACE_NEAR = 0.005;
const SURFACE_FAR = 2500;

const SURFACE_DEFAULT_YAW = Math.PI * 0.46; // 面向偏东方，直观观赏恒星东升弧线
const SURFACE_DEFAULT_PITCH = 0.24; // 仰角约 +14°，兼顾山脊地平线与广袤天穹
const SURFACE_MIN_PITCH = -0.12; // 最低可略俯视地平线以下约 -7°
const SURFACE_MAX_PITCH = Math.PI * 0.485; // 最高仰视至近天顶 87.3°（防万向节锁）

const BLOOM_THRESHOLD = 1.0;
const BLOOM_RADIUS = 0.55;

const HIGH_DPR_CAP = 2.0;
const PERF_DPR_CAP = 1.25;

/**
 * 计算当前画质模式下的有效 DPR 上限（high <= 2，performance <= 1.25）。
 */
export function computeEffectivePixelRatio(
  mode: QualityMode,
  devicePixelRatio: number
): number {
  const safeDpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  const cap = mode === 'performance' ? PERF_DPR_CAP : HIGH_DPR_CAP;
  return Math.min(safeDpr, cap);
}

/**
 * 计算高画质模式下 UnrealBloomPass 半分辨率渲染目标尺寸。
 */
export function computeHalfResolutionBloomSize(
  width: number,
  height: number,
  pixelRatio: number
): readonly [number, number] {
  const bloomW = Math.max(1, Math.floor(width * pixelRatio * 0.5));
  const bloomH = Math.max(1, Math.floor(height * pixelRatio * 0.5));
  return [bloomW, bloomH] as const;
}

export class SceneRenderer implements ISceneRenderer {
  private container: HTMLElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private composer: EffectComposer | null = null;
  private renderTarget: THREE.WebGLRenderTarget | null = null;
  private renderPass: RenderPass | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private outputPass: OutputPass | null = null;
  private controls: OrbitControls | null = null;
  private ambientLight: THREE.HemisphereLight | null = null;

  private starfield: Starfield | null = null;
  private bodyVisuals: BodyVisuals | null = null;
  private trailSystem: TrailSystem | null = null;
  private vectorHelpers: VectorHelpers | null = null;
  private surfaceDome: SurfaceDome | null = null;

  private visualOptions: VisualOptions = { ...DEFAULT_VISUAL_OPTIONS };
  private viewportWidth: number = 1;
  private viewportHeight: number = 1;
  private defaultCameraDistance: number = 5.5;
  private cameraMode: CameraMode = 'free';
  private cameraTargetBodyId: string | null = null;
  private isSurfaceRendered: boolean = false;

  // 近地视角状态（跨层约定 #1 & #3）
  private surfaceTemperatureC: number = 22;
  private surfaceRotationAngle: number = 0;
  private surfacePlanetId: string | null = null;
  private surfaceYaw: number = SURFACE_DEFAULT_YAW;
  private surfacePitch: number = SURFACE_DEFAULT_PITCH;
  private surfaceFov: number = SURFACE_DEFAULT_FOV;

  // 近地视角指针拖拽环顾状态
  private isSurfaceDragging: boolean = false;
  private activePointerId: number | null = null;
  private lastPointerX: number = 0;
  private lastPointerY: number = 0;

  // 太空视角保存状态（进出近地模式无缝还原）
  private readonly savedSpaceCamPos = new THREE.Vector3(1.6, -3.2, 4.2);
  private readonly savedSpaceTarget = new THREE.Vector3(0, 0, 0);
  private hasSavedSpaceCamera: boolean = false;

  // 跟随 / 质心锁定增量位移缓存
  private readonly lastTrackedTarget = new THREE.Vector3();
  private hasLastTrackedTarget: boolean = false;

  // 最新物理状态缓存（支持暂停状态下调用 syncSurfaceView / setCameraMode / setVisualOptions / resize 即时重绘）
  private lastBodies: readonly BodyState[] = [];
  private lastCenterOfMass: Vec3 = [0, 0, 0];
  private lastTelemetryVisibleSuns: number | null = null;
  private isInsideRenderFrame: boolean = false;
  private disposed: boolean = false;

  // 零每帧 GC 复用缓冲区
  private readonly tmpOriginOffset = new THREE.Vector3();
  private readonly tmpTargetPos = new THREE.Vector3();
  private readonly tmpDelta = new THREE.Vector3();
  private readonly tmpBasisMatrix = new THREE.Matrix4();
  private readonly tmpBasisQuat = new THREE.Quaternion();
  private readonly tmpLookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly tmpLookQuat = new THREE.Quaternion();
  private readonly tmpRelStar = new THREE.Vector3();
  private readonly scratchSunDirs: THREE.Vector3[] = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];
  private readonly scratchSunColors: THREE.Color[] = [
    new THREE.Color(),
    new THREE.Color(),
    new THREE.Color(),
  ];

  public init(
    container: HTMLElement,
    initialBodies: readonly BodyState[],
    initialVisuals: VisualOptions,
    defaultCameraDistance: number = 5.5
  ): void {
    if (this.renderer) {
      this.dispose();
    }
    this.disposed = false;
    this.container = container;
    this.visualOptions = {
      ...DEFAULT_VISUAL_OPTIONS,
      ...initialVisuals,
    };
    this.defaultCameraDistance = Math.max(0.5, defaultCameraDistance || 5.5);

    const width = Math.max(1, container.clientWidth || window.innerWidth || 1);
    const height = Math.max(
      1,
      container.clientHeight || window.innerHeight || 1
    );
    this.viewportWidth = width;
    this.viewportHeight = height;

    const qualityMode = this.visualOptions.qualityMode;
    const pixelRatio = this.getEffectivePixelRatio(qualityMode);

    // 1. WebGLRenderer：ACESFilmicToneMapping + SRGBColorSpace + 分级 DPR
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x02040a, 1);

    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.touchAction = 'none';
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    // 2. Scene & Camera
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x02040a);
    this.scene = scene;

    // 极弱半球补光（线性 <= 0.08），仅用于在太空视角隐约勾勒行星暗面，绝不触发 Bloom
    const ambientLight = new THREE.HemisphereLight(0x283854, 0x090c14, 0.28);
    scene.add(ambientLight);
    this.ambientLight = ambientLight;

    const camera = new THREE.PerspectiveCamera(
      SPACE_FOV,
      width / height,
      SPACE_NEAR,
      SPACE_FAR
    );
    camera.up.set(0, 1, 0);
    this.camera = camera;

    // 3. 懒初始化后处理管线：仅在 'high' 模式下分配 HalfFloatType MSAA EffectComposer 与半分辨率 Bloom
    if (qualityMode === 'high') {
      this.ensurePostProcessing();
    }

    // 4. OrbitControls（太空视角）
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.minDistance = 0.16;
    controls.maxDistance = 160;
    controls.zoomSpeed = 1.05;
    controls.rotateSpeed = 0.78;
    controls.panSpeed = 0.85;
    controls.addEventListener('change', this.handleOrbitControlsChange);
    this.controls = controls;

    // 5. 近地视角鼠标/触控环顾交互事件
    renderer.domElement.addEventListener(
      'pointerdown',
      this.handleSurfacePointerDown
    );
    renderer.domElement.addEventListener(
      'pointermove',
      this.handleSurfacePointerMove
    );
    renderer.domElement.addEventListener(
      'pointerup',
      this.handleSurfacePointerUp
    );
    renderer.domElement.addEventListener(
      'pointercancel',
      this.handleSurfacePointerUp
    );
    renderer.domElement.addEventListener('wheel', this.handleSurfaceWheel, {
      passive: false,
    });

    // 6. 构建五大渲染子系统（传入初始画质分级）
    this.starfield = new Starfield(qualityMode);
    this.bodyVisuals = new BodyVisuals(qualityMode);
    this.trailSystem = new TrailSystem(this.visualOptions.trailLength);
    this.vectorHelpers = new VectorHelpers(this.visualOptions);
    this.surfaceDome = new SurfaceDome();

    scene.add(
      this.starfield.group,
      this.surfaceDome.group,
      this.vectorHelpers.group,
      this.trailSystem.group,
      this.bodyVisuals.group
    );

    // 7. 应用初始选项、天体与相机构图并绘制首帧
    this.trailSystem.setVisible(this.visualOptions.showTrails);
    this.applyDefaultSpaceCamera(this.defaultCameraDistance);
    this.syncBodies(initialBodies, true);
    this.renderStaticNow();
  }

  public resize(width: number, height: number): void {
    if (!this.renderer || !this.camera) return;
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.viewportWidth = w;
    this.viewportHeight = h;

    const pixelRatio = this.getEffectivePixelRatio(
      this.visualOptions.qualityMode
    );

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(w, h, false);

    if (this.visualOptions.qualityMode === 'high' && this.composer) {
      this.syncPostProcessingSize();
    }

    if (!this.isInsideRenderFrame) {
      this.renderStaticNow();
    }
  }

  public renderFrame(snapshot: PhysicsSnapshot, deltaSeconds: number): void {
    if (this.disposed || !this.renderer || !this.scene || !this.camera) return;

    this.isInsideRenderFrame = true;
    try {
      this.lastBodies = snapshot.bodies;
      this.lastCenterOfMass = snapshot.metrics.centerOfMass;

      // 防御性同步：如上层直接变更了天体数组而未提前调用 syncBodies
      if (this.bodyVisuals && !this.bodyVisuals.hasMatchingIds(snapshot.bodies)) {
        this.bodyVisuals.syncBodies(snapshot.bodies);
        this.trailSystem?.syncBodies(snapshot.bodies, false);
        this.vectorHelpers?.syncBodies(snapshot.bodies);
      }

      // 【跨层约定 #3】幂等同步 snapshot.planetTelemetry 至近地视角状态
      if (snapshot.planetTelemetry !== null) {
        this.surfaceTemperatureC = snapshot.planetTelemetry.temperatureC;
        this.surfaceRotationAngle = snapshot.planetTelemetry.rotationAngle;
        this.surfacePlanetId = snapshot.planetTelemetry.planetId;
        this.lastTelemetryVisibleSuns =
          snapshot.planetTelemetry.visibleSunCount;
      } else {
        this.lastTelemetryVisibleSuns = null;
      }

      // 轨迹始终在世界坐标中持续自适应采样，确保切入近地再切回太空后轨道连续不中断
      this.trailSystem?.update(snapshot.bodies);

      const safeDt = Math.min(Math.max(deltaSeconds || 0, 0), 0.1);
      this.updateSceneObjectsAndCamera(safeDt);
      this.drawFrame(safeDt);
    } finally {
      this.isInsideRenderFrame = false;
    }
  }

  public syncBodies(
    bodies: readonly BodyState[],
    clearTrails: boolean = false
  ): void {
    this.lastBodies = bodies;
    this.bodyVisuals?.syncBodies(bodies);
    this.trailSystem?.syncBodies(bodies, clearTrails);
    this.vectorHelpers?.syncBodies(bodies);

    // 校验当前跟踪的近地行星 / 跟随目标是否依然存在
    if (
      this.surfacePlanetId !== null &&
      !bodies.some((b) => b.id === this.surfacePlanetId)
    ) {
      const fallbackPlanet = bodies.find((b) => b.role === 'planet') ?? null;
      this.surfacePlanetId = fallbackPlanet ? fallbackPlanet.id : null;
    }

    if (
      this.cameraTargetBodyId !== null &&
      !bodies.some((b) => b.id === this.cameraTargetBodyId)
    ) {
      this.cameraTargetBodyId = bodies[0]?.id ?? null;
      this.hasLastTrackedTarget = false;
    }

    if (!this.isInsideRenderFrame && this.renderer) {
      this.renderStaticNow();
    }
  }

  public clearTrails(): void {
    this.trailSystem?.clearTrails();
    if (!this.isInsideRenderFrame && this.renderer) {
      this.renderStaticNow();
    }
  }

  public setCameraMode(
    mode: CameraMode,
    targetBodyId?: string | null
  ): void {
    const prevMode = this.cameraMode;
    this.cameraMode = mode;

    if (targetBodyId !== undefined) {
      this.cameraTargetBodyId = targetBodyId;
      if (mode === 'planet-surface' && targetBodyId !== null) {
        this.surfacePlanetId = targetBodyId;
      }
    } else if (mode === 'follow' && this.cameraTargetBodyId === null) {
      this.cameraTargetBodyId = this.lastBodies[0]?.id ?? null;
    }

    if (mode !== prevMode || mode === 'follow') {
      this.hasLastTrackedTarget = false;
    }

    // 切换至 follow 或 com 时立即平移 OrbitControls 目标，保持用户当前相对视角与缩放距离
    if (
      (mode === 'follow' || mode === 'com') &&
      this.controls &&
      this.camera &&
      !this.isSurfaceRendered
    ) {
      const targetVec = this.resolveSpaceTargetPosition();
      if (targetVec) {
        this.tmpDelta.copy(targetVec).sub(this.controls.target);
        this.controls.target.copy(targetVec);
        this.camera.position.add(this.tmpDelta);
        this.lastTrackedTarget.copy(targetVec);
        this.hasLastTrackedTarget = true;
      }
    }

    if (!this.isInsideRenderFrame && this.renderer) {
      this.renderStaticNow();
    }
  }

  public resetCameraView(distance?: number): void {
    if (distance !== undefined && Number.isFinite(distance) && distance > 0) {
      this.defaultCameraDistance = distance;
    }

    if (this.isSurfaceRendered) {
      this.surfaceYaw = SURFACE_DEFAULT_YAW;
      this.surfacePitch = SURFACE_DEFAULT_PITCH;
      this.surfaceFov = SURFACE_DEFAULT_FOV;
      if (this.camera) {
        this.camera.fov = this.surfaceFov;
        this.camera.updateProjectionMatrix();
      }
    } else {
      this.applyDefaultSpaceCamera(this.defaultCameraDistance);
    }

    if (!this.isInsideRenderFrame && this.renderer) {
      this.renderStaticNow();
    }
  }

  public setVisualOptions(options: Partial<VisualOptions>): void {
    const prevQualityMode = this.visualOptions.qualityMode;
    this.visualOptions = {
      ...this.visualOptions,
      ...options,
    };

    const nextQualityMode = this.visualOptions.qualityMode;
    if (nextQualityMode !== prevQualityMode) {
      this.bodyVisuals?.setQualityMode(nextQualityMode);
      this.starfield?.setQualityMode(nextQualityMode);

      if (this.renderer) {
        const pixelRatio = this.getEffectivePixelRatio(nextQualityMode);
        this.renderer.setPixelRatio(pixelRatio);
        this.renderer.setSize(this.viewportWidth, this.viewportHeight, false);

        if (nextQualityMode === 'high') {
          this.ensurePostProcessing();
          this.syncPostProcessingSize();
        }
      }
    }

    if (this.bloomPass) {
      this.bloomPass.enabled = this.visualOptions.enableBloom;
      this.bloomPass.strength = Math.max(0, this.visualOptions.bloomStrength);
      // 严守 threshold = 1.0 防全屏泛白
      this.bloomPass.threshold = BLOOM_THRESHOLD;
    }

    if (this.trailSystem) {
      this.trailSystem.setTrailLength(this.visualOptions.trailLength);
      this.trailSystem.setVisible(this.visualOptions.showTrails);
    }

    this.vectorHelpers?.setOptions(this.visualOptions);

    if (!this.isInsideRenderFrame && this.renderer) {
      this.renderStaticNow();
    }
  }

  /**
   * 【跨层约定 #3】幂等同步近地视角温度、自转角与目标行星，
   * 在仿真暂停时调用也会立即刷新天空/地貌与相机朝向并重绘一帧。
   */
  public syncSurfaceView(
    temperatureC: number,
    rotationAngle: number,
    planetId?: string | null
  ): void {
    this.surfaceTemperatureC = temperatureC;
    this.surfaceRotationAngle = rotationAngle;
    this.lastTelemetryVisibleSuns = null;
    if (planetId !== undefined) {
      this.surfacePlanetId = planetId;
    }

    if (!this.isInsideRenderFrame && this.renderer) {
      this.renderStaticNow();
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const dom = this.renderer?.domElement;
    if (dom) {
      dom.removeEventListener('pointerdown', this.handleSurfacePointerDown);
      dom.removeEventListener('pointermove', this.handleSurfacePointerMove);
      dom.removeEventListener('pointerup', this.handleSurfacePointerUp);
      dom.removeEventListener('pointercancel', this.handleSurfacePointerUp);
      dom.removeEventListener('wheel', this.handleSurfaceWheel);
    }

    if (this.controls) {
      this.controls.removeEventListener(
        'change',
        this.handleOrbitControlsChange
      );
      this.controls.dispose();
      this.controls = null;
    }

    this.starfield?.dispose();
    this.bodyVisuals?.dispose();
    this.trailSystem?.dispose();
    this.vectorHelpers?.dispose();
    this.surfaceDome?.dispose();

    this.starfield = null;
    this.bodyVisuals = null;
    this.trailSystem = null;
    this.vectorHelpers = null;
    this.surfaceDome = null;

    this.renderPass?.dispose();
    this.bloomPass?.dispose();
    this.outputPass?.dispose();
    if (this.composer) {
      // EffectComposer.dispose() 内部仅释放 renderTarget1，此处一并释放 renderTarget2
      this.composer.renderTarget2.dispose();
      this.composer.dispose();
    }
    this.renderTarget?.dispose();

    this.renderPass = null;
    this.bloomPass = null;
    this.outputPass = null;
    this.composer = null;
    this.renderTarget = null;

    if (this.ambientLight && this.scene) {
      this.scene.remove(this.ambientLight);
    }
    this.ambientLight?.dispose();
    this.ambientLight = null;

    if (this.renderer) {
      const canvas = this.renderer.domElement;
      this.renderer.dispose();
      if (canvas.parentElement === this.container) {
        this.container?.removeChild(canvas);
      }
      this.renderer = null;
    }

    this.scene?.clear();
    this.scene = null;
    this.camera = null;
    this.container = null;
    this.lastBodies = [];
  }

  // ============================================================================
  // 分级 DPR、后处理懒初始化与渲染通道调度
  // ============================================================================

  private getEffectivePixelRatio(mode: QualityMode): number {
    const rawDpr =
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return computeEffectivePixelRatio(mode, rawDpr);
  }

  /**
   * 仅在处于或首次切入 'high' 模式时按需分配 HDR HalfFloatType EffectComposer 与半分辨率 UnrealBloomPass。
   */
  private ensurePostProcessing(): void {
    if (this.composer || !this.renderer || !this.scene || !this.camera) return;

    const w = Math.max(1, this.viewportWidth);
    const h = Math.max(1, this.viewportHeight);
    const pixelRatio = this.getEffectivePixelRatio('high');
    const [bloomW, bloomH] = computeHalfResolutionBloomSize(w, h, pixelRatio);

    const msaaSamples = this.renderer.capabilities.isWebGL2
      ? Math.min(4, this.renderer.capabilities.maxSamples)
      : 0;
    const renderTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: msaaSamples,
    });
    renderTarget.texture.name = 'HDRSceneRenderTarget';
    this.renderTarget = renderTarget;

    const composer = new EffectComposer(this.renderer, renderTarget);
    const renderPass = new RenderPass(this.scene, this.camera);
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(bloomW, bloomH),
      Math.max(0, this.visualOptions.bloomStrength),
      BLOOM_RADIUS,
      BLOOM_THRESHOLD
    );
    bloomPass.threshold = BLOOM_THRESHOLD;
    bloomPass.radius = BLOOM_RADIUS;
    bloomPass.strength = Math.max(0, this.visualOptions.bloomStrength);
    bloomPass.enabled = this.visualOptions.enableBloom;

    const outputPass = new OutputPass();

    composer.addPass(renderPass);
    composer.addPass(bloomPass);
    composer.addPass(outputPass);

    this.composer = composer;
    this.renderPass = renderPass;
    this.bloomPass = bloomPass;
    this.outputPass = outputPass;

    this.syncPostProcessingSize();
  }

  /**
   * 同步高画质后处理管线尺寸，并在 composer.setSize 后显式将 UnrealBloomPass 锁定在半分辨率。
   */
  private syncPostProcessingSize(): void {
    if (!this.composer || !this.bloomPass) return;

    const w = Math.max(1, this.viewportWidth);
    const h = Math.max(1, this.viewportHeight);
    const pixelRatio = this.getEffectivePixelRatio(
      this.visualOptions.qualityMode
    );

    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);

    // 必须在 composer.setSize 之后显式降为半分辨率，避免被 EffectComposer 覆写回全分辨率
    const [bloomW, bloomH] = computeHalfResolutionBloomSize(w, h, pixelRatio);
    this.bloomPass.setSize(bloomW, bloomH);
  }

  private drawFrame(deltaSeconds: number): void {
    if (!this.renderer || !this.scene || !this.camera) return;

    if (this.visualOptions.qualityMode === 'performance') {
      // 性能模式彻底绕过 EffectComposer + UnrealBloomPass，直接经 ACESFilmicToneMapping 上屏
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    this.ensurePostProcessing();
    if (this.composer) {
      this.composer.render(deltaSeconds);
    } else {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
    }
  }

  // ============================================================================
  // 内部场景更新与相机切换逻辑
  // ============================================================================

  private renderStaticNow(): void {
    if (this.disposed || !this.renderer || !this.scene || !this.camera) return;
    this.isInsideRenderFrame = true;
    try {
      this.updateSceneObjectsAndCamera(0);
      this.drawFrame(0);
    } finally {
      this.isInsideRenderFrame = false;
    }
  }

  private updateSceneObjectsAndCamera(deltaSeconds: number): void {
    if (!this.camera) return;

    const surfacePlanet =
      this.cameraMode === 'planet-surface'
        ? this.findSurfacePlanet(this.lastBodies)
        : null;
    const isSurfaceActive = surfacePlanet !== null;

    // 检测太空模式 <-> 近地模式状态切换，执行严格模式隔离与相机参数恢复
    if (isSurfaceActive !== this.isSurfaceRendered) {
      this.transitionSurfaceMode(isSurfaceActive);
    }

    if (isSurfaceActive && surfacePlanet) {
      // 1. 行星相对坐标系防 Float32 抖动：行星锚定于渲染原点 (0,0,0)
      this.tmpOriginOffset.set(
        surfacePlanet.position[0],
        surfacePlanet.position[1],
        surfacePlanet.position[2]
      );

      // 2. 更新所有恒星相对坐标 r_star - r_planet 并隐藏行星自身 Mesh
      this.bodyVisuals?.updatePositions(
        this.lastBodies,
        this.tmpOriginOffset,
        true,
        surfacePlanet.id,
        this.surfaceRotationAngle
      );

      // 3. 更新近地穹顶（赤道正交基旋转 + 实时温度大气变色 + 多日散射）
      this.updateSurfaceDomeAndCamera(surfacePlanet);
    } else {
      // 太空模式：世界坐标原点渲染
      this.tmpOriginOffset.set(0, 0, 0);

      this.bodyVisuals?.updatePositions(
        this.lastBodies,
        this.tmpOriginOffset,
        false,
        null,
        this.surfaceRotationAngle
      );

      this.vectorHelpers?.update(this.lastBodies, this.lastCenterOfMass);
      this.updateSpaceCamera(deltaSeconds);
    }

    // 星场始终以相机为中心（太空模式零视差无限远；近地模式位于 (0,0,0) 与恒星同世界坐标系）
    this.starfield?.setCenter(this.camera.position);
  }

  private transitionSurfaceMode(enterSurface: boolean): void {
    if (!this.camera || !this.controls) return;

    if (enterSurface) {
      // 保存太空相机状态，以便退出近地模式时无缝复原
      this.savedSpaceCamPos.copy(this.camera.position);
      this.savedSpaceTarget.copy(this.controls.target);
      this.hasSavedSpaceCamera = true;

      this.controls.enabled = false;
      this.isSurfaceDragging = false;
      this.activePointerId = null;

      this.camera.fov = this.surfaceFov;
      this.camera.near = SURFACE_NEAR;
      this.camera.far = SURFACE_FAR;
      this.camera.updateProjectionMatrix();

      // 【跨层约定 #2】近地模式隔离：自动隐藏 XY 参考网格、质心、矢量箭头、轨迹线
      this.trailSystem?.setSurfaceModeHidden(true);
      this.vectorHelpers?.setSurfaceModeHidden(true);
      this.surfaceDome?.setVisible(true);
    } else {
      this.isSurfaceDragging = false;
      this.activePointerId = null;

      this.surfaceDome?.setVisible(false);
      this.trailSystem?.setSurfaceModeHidden(false);
      this.vectorHelpers?.setSurfaceModeHidden(false);

      this.camera.fov = SPACE_FOV;
      this.camera.near = SPACE_NEAR;
      this.camera.far = SPACE_FAR;
      this.camera.up.set(0, 1, 0);
      this.camera.updateProjectionMatrix();

      if (this.hasSavedSpaceCamera) {
        this.camera.position.copy(this.savedSpaceCamPos);
        this.controls.target.copy(this.savedSpaceTarget);
      } else {
        this.applyDefaultSpaceCamera(this.defaultCameraDistance);
      }

      this.controls.enabled = true;
      this.hasLastTrackedTarget = false;
      this.controls.update(0);
    }

    this.isSurfaceRendered = enterSurface;
  }

  private updateSurfaceDomeAndCamera(surfacePlanet: BodyState): void {
    if (!this.camera || !this.surfaceDome) return;

    const theta = this.surfaceRotationAngle;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    // 【跨层约定 #1】赤道观测者正交基：east=(-sinθ, cosθ, 0), up=(cosθ, sinθ, 0), -north=(0, 0, -1)
    computeEquatorialBasisMatrix(theta, this.tmpBasisMatrix);
    this.tmpBasisQuat.setFromRotationMatrix(this.tmpBasisMatrix);

    // 收集恒星在局部赤道坐标系下的方向与颜色，驱动天空散射与昼夜亮度
    let sunIdx = 0;
    let computedVisibleSuns = 0;
    const px = surfacePlanet.position[0];
    const py = surfacePlanet.position[1];
    const pz = surfacePlanet.position[2];

    for (const body of this.lastBodies) {
      if (body.role !== 'star') continue;
      this.tmpRelStar.set(
        body.position[0] - px,
        body.position[1] - py,
        body.position[2] - pz
      );
      const dist = this.tmpRelStar.length();
      if (dist < 1e-6) continue;
      this.tmpRelStar.divideScalar(dist);

      // 将世界单位方向投影到局部正交基 (X=east, Y=up, Z=-north)
      const localX = -sinT * this.tmpRelStar.x + cosT * this.tmpRelStar.y;
      const localY = cosT * this.tmpRelStar.x + sinT * this.tmpRelStar.y;
      const localZ = -this.tmpRelStar.z;

      if (localY > 0) {
        computedVisibleSuns += 1;
      }

      if (sunIdx < 3) {
        this.scratchSunDirs[sunIdx].set(localX, localY, localZ);
        hexToClampedColor(body.color, 0.82, this.scratchSunColors[sunIdx]);
        sunIdx += 1;
      }
    }

    const visibleSuns =
      this.lastTelemetryVisibleSuns !== null
        ? this.lastTelemetryVisibleSuns
        : computedVisibleSuns;

    this.surfaceDome.update(
      this.surfaceTemperatureC,
      theta,
      visibleSuns,
      this.scratchSunDirs,
      this.scratchSunColors,
      sunIdx
    );

    // 构造局部环顾四元数：YXZ 欧拉角 (pitch, -yaw, 0)，保证相机始终以局部天顶 +Y 为上方向、无侧倾
    this.tmpLookEuler.set(this.surfacePitch, -this.surfaceYaw, 0, 'YXZ');
    this.tmpLookQuat.setFromEuler(this.tmpLookEuler);

    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.copy(this.tmpBasisQuat).multiply(this.tmpLookQuat);
  }

  private updateSpaceCamera(deltaSeconds: number): void {
    if (!this.controls || !this.camera) return;

    if (this.cameraMode === 'com' || this.cameraMode === 'follow') {
      const targetPos = this.resolveSpaceTargetPosition();
      if (targetPos) {
        if (this.hasLastTrackedTarget) {
          this.tmpDelta.copy(targetPos).sub(this.lastTrackedTarget);
          this.controls.target.add(this.tmpDelta);
          this.camera.position.add(this.tmpDelta);
        } else {
          this.tmpDelta.copy(targetPos).sub(this.controls.target);
          this.controls.target.copy(targetPos);
          this.camera.position.add(this.tmpDelta);
        }
        this.lastTrackedTarget.copy(targetPos);
        this.hasLastTrackedTarget = true;
      }
    } else {
      this.hasLastTrackedTarget = false;
    }

    this.controls.update(deltaSeconds > 0 ? deltaSeconds : undefined);
  }

  private resolveSpaceTargetPosition(): THREE.Vector3 | null {
    if (this.cameraMode === 'com') {
      this.tmpTargetPos.set(
        this.lastCenterOfMass[0],
        this.lastCenterOfMass[1],
        this.lastCenterOfMass[2]
      );
      return this.tmpTargetPos;
    }
    if (this.cameraMode === 'follow') {
      const body =
        this.lastBodies.find((b) => b.id === this.cameraTargetBodyId) ??
        this.lastBodies[0];
      if (!body) return null;
      this.tmpTargetPos.set(
        body.position[0],
        body.position[1],
        body.position[2]
      );
      return this.tmpTargetPos;
    }
    return null;
  }

  private applyDefaultSpaceCamera(distance: number): void {
    if (!this.camera || !this.controls) return;
    const d = Math.max(0.5, distance);

    const anchor = this.resolveSpaceTargetPosition();
    if (anchor) {
      this.controls.target.copy(anchor);
      this.lastTrackedTarget.copy(anchor);
      this.hasLastTrackedTarget = true;
    } else {
      this.controls.target.set(0, 0, 0);
      this.hasLastTrackedTarget = false;
    }

    // 俯视 XY 轨道平面的优雅 3D 透视构图：兼顾平面周期轨清晰度与三维 Z 轴立体层次
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(
      this.controls.target.x + d * 0.22,
      this.controls.target.y - d * 0.56,
      this.controls.target.z + d * 0.8
    );
    this.camera.lookAt(this.controls.target);
    this.controls.update(0);
  }

  private findSurfacePlanet(bodies: readonly BodyState[]): BodyState | null {
    if (this.surfacePlanetId) {
      const bySurfaceId = bodies.find((b) => b.id === this.surfacePlanetId);
      if (bySurfaceId) return bySurfaceId;
    }
    if (this.cameraTargetBodyId) {
      const byTargetId = bodies.find(
        (b) => b.id === this.cameraTargetBodyId && b.role === 'planet'
      );
      if (byTargetId) return byTargetId;
    }
    return bodies.find((b) => b.role === 'planet') ?? null;
  }

  // ============================================================================
  // DOM 交互回调（箭头函数绑定，便于 dispose 精确注销）
  // ============================================================================

  private readonly handleOrbitControlsChange = (): void => {
    if (!this.isInsideRenderFrame && !this.isSurfaceRendered) {
      this.renderStaticNow();
    }
  };

  private readonly handleSurfacePointerDown = (event: PointerEvent): void => {
    if (!this.isSurfaceRendered || event.button !== 0) return;
    this.isSurfaceDragging = true;
    this.activePointerId = event.pointerId;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.renderer?.domElement.setPointerCapture?.(event.pointerId);
  };

  private readonly handleSurfacePointerMove = (event: PointerEvent): void => {
    if (
      !this.isSurfaceRendered ||
      !this.isSurfaceDragging ||
      event.pointerId !== this.activePointerId
    ) {
      return;
    }
    const dx = event.clientX - this.lastPointerX;
    const dy = event.clientY - this.lastPointerY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;

    const sensitivity = 0.0042 * (this.surfaceFov / SURFACE_DEFAULT_FOV);
    this.surfaceYaw -= dx * sensitivity;
    this.surfacePitch = Math.max(
      SURFACE_MIN_PITCH,
      Math.min(SURFACE_MAX_PITCH, this.surfacePitch + dy * sensitivity)
    );

    if (!this.isInsideRenderFrame) {
      this.renderStaticNow();
    }
  };

  private readonly handleSurfacePointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return;
    this.isSurfaceDragging = false;
    this.activePointerId = null;
    try {
      this.renderer?.domElement.releasePointerCapture?.(event.pointerId);
    } catch {
      // 忽略已释放的指针捕获状态
    }
  };

  private readonly handleSurfaceWheel = (event: WheelEvent): void => {
    if (!this.isSurfaceRendered || !this.camera) return;
    event.preventDefault();
    const nextFov = Math.max(
      SURFACE_MIN_FOV,
      Math.min(SURFACE_MAX_FOV, this.surfaceFov + event.deltaY * 0.03)
    );
    if (Math.abs(nextFov - this.surfaceFov) > 1e-4) {
      this.surfaceFov = nextFov;
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
      if (!this.isInsideRenderFrame) {
        this.renderStaticNow();
      }
    }
  };
}
