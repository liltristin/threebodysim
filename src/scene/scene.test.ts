/**
 * 渲染层核心逻辑无头单元测试（Headless Vitest）
 * 验证跨层契约、赤道局部正交基数学一致性、HDR 阈值防泛白限幅、
 * 弧长/曲率自适应环形缓冲轨迹、XY 参考网格与行星加速度矢量映射。
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { BodyState, ISceneRenderer } from '../types/contracts';
import { DEFAULT_VISUAL_OPTIONS } from '../types/contracts';
import {
  BodyVisuals,
  MAX_TRAIL_CAPACITY,
  SceneRenderer,
  Starfield,
  SurfaceDome,
  TrailSystem,
  VectorHelpers,
  clampLinearColor,
  computeEffectivePixelRatio,
  computeEquatorialBasisMatrix,
  computeForceHeatColor,
  computeHalfResolutionBloomSize,
  computeStarEmissive,
  hexToClampedColor,
} from './index';

function makeStar(overrides: Partial<BodyState> = {}): BodyState {
  return {
    id: 'star-1',
    name: '恒星 α',
    role: 'star',
    mass: 1.0,
    position: [1, 0, 0],
    velocity: [0, 0.8, 0],
    color: '#f87171',
    emissiveIntensity: 2.6,
    renderRadius: 0.08,
    collisionRadius: 0.025,
    isTestParticle: false,
    acceleration: [-1.2, 0, 0],
    force: [-1.2, 0, 0],
    luminosity: 1.0,
    ...overrides,
  };
}

function makePlanet(overrides: Partial<BodyState> = {}): BodyState {
  return {
    id: 'trisolaris-planet',
    name: '三体行星',
    role: 'planet',
    mass: 1e-6,
    position: [0.55, 0, 0],
    velocity: [0, 1.4, 0],
    color: '#38bdf8',
    emissiveIntensity: 0.35,
    renderRadius: 0.032,
    collisionRadius: 0.008,
    isTestParticle: true,
    acceleration: [-3.9, 0.2, 0],
    force: [-3.9e-6, 0.2e-6, 0],
    luminosity: 0,
    ...overrides,
  };
}

describe('SceneRenderer 接口与数学/HDR 规范验证', () => {
  it('SceneRenderer 严格满足 ISceneRenderer 类型契约并支持幂等 dispose', () => {
    const renderer: ISceneRenderer = new SceneRenderer();
    expect(typeof renderer.init).toBe('function');
    expect(typeof renderer.resize).toBe('function');
    expect(typeof renderer.renderFrame).toBe('function');
    expect(typeof renderer.syncBodies).toBe('function');
    expect(typeof renderer.clearTrails).toBe('function');
    expect(typeof renderer.setCameraMode).toBe('function');
    expect(typeof renderer.resetCameraView).toBe('function');
    expect(typeof renderer.setVisualOptions).toBe('function');
    expect(typeof renderer.syncSurfaceView).toBe('function');
    expect(typeof renderer.dispose).toBe('function');

    // 未 init 时调用 dispose 与状态方法也应安全无异常
    renderer.setVisualOptions({ enableBloom: false });
    renderer.syncSurfaceView(25, 0.5, 'trisolaris-planet');
    renderer.dispose();
    renderer.dispose();
  });

  it('【跨层约定 #1】赤道观测者局部正交基行列式恒为 +1 且严格对齐 (east, up, -north)', () => {
    const mat = new THREE.Matrix4();
    const angles = [0, Math.PI / 6, Math.PI / 2, Math.PI, -Math.PI * 0.75, 4.2];

    for (const theta of angles) {
      computeEquatorialBasisMatrix(theta, mat);
      expect(mat.determinant()).toBeCloseTo(1, 10);

      const xAxis = new THREE.Vector3();
      const yAxis = new THREE.Vector3();
      const zAxis = new THREE.Vector3();
      mat.extractBasis(xAxis, yAxis, zAxis);

      // X = east = (-sin θ, cos θ, 0)
      expect(xAxis.x).toBeCloseTo(-Math.sin(theta), 10);
      expect(xAxis.y).toBeCloseTo(Math.cos(theta), 10);
      expect(xAxis.z).toBeCloseTo(0, 10);

      // Y = up = (cos θ, sin θ, 0)
      expect(yAxis.x).toBeCloseTo(Math.cos(theta), 10);
      expect(yAxis.y).toBeCloseTo(Math.sin(theta), 10);
      expect(yAxis.z).toBeCloseTo(0, 10);

      // Z = -north = (0, 0, -1)
      expect(zAxis.x).toBeCloseTo(0, 10);
      expect(zAxis.y).toBeCloseTo(0, 10);
      expect(zAxis.z).toBeCloseTo(-1, 10);
    }
  });

  it('HDR 阈值防泛白：非恒星限幅 <= 0.95，所有色温恒星 emissiveIntensity > 1 均跨过 threshold = 1.0', () => {
    const out = new THREE.Color();

    // 各类预设恒星色温均能可靠触发 Bloom（线性亮度 > 1.0）
    const starHexes = ['#60a5fa', '#fbbf24', '#f87171', '#c084fc', '#fef08a', '#fb923c'];
    for (const hex of starHexes) {
      const intensity = computeStarEmissive(hex, 2.6, out);
      const lum = (0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b) * intensity;
      expect(lum).toBeGreaterThan(1.5);
    }

    // 非恒星限幅与引力色阶严格 <= 0.95
    const clampedWhite = hexToClampedColor('#ffffff', 0.92);
    expect(Math.max(clampedWhite.r, clampedWhite.g, clampedWhite.b)).toBeLessThanOrEqual(0.92 + 1e-6);

    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      computeForceHeatColor(t, out);
      expect(Math.max(out.r, out.g, out.b)).toBeLessThanOrEqual(0.95);
    }

    clampLinearColor(out.setRGB(3.5, 2.0, 1.5), 0.85);
    expect(Math.max(out.r, out.g, out.b)).toBeLessThanOrEqual(0.85 + 1e-6);
  });

  it('Starfield 全部星点与星云尘埃线性 RGB 严格 <= 0.85', () => {
    const starfield = new Starfield();
    for (const child of starfield.group.children) {
      if (child instanceof THREE.Points) {
        const colAttr = child.geometry.getAttribute('color') as THREE.BufferAttribute;
        for (let i = 0; i < colAttr.count; i++) {
          expect(colAttr.getX(i)).toBeLessThanOrEqual(0.85 + 1e-5);
          expect(colAttr.getY(i)).toBeLessThanOrEqual(0.85 + 1e-5);
          expect(colAttr.getZ(i)).toBeLessThanOrEqual(0.85 + 1e-5);
        }
      }
    }
    starfield.dispose();
  });

  it('TrailSystem 按位移与曲率自适应采样（禁止静止/微小步长刷爆缓冲），并支持环形覆盖与清空', () => {
    const trails = new TrailSystem(50);
    const star = makeStar({ position: [0, 0, 0], velocity: [1, 0, 0] });
    trails.syncBodies([star], true);

    // 连续 20 帧极微小位移不应重复写入新点
    for (let i = 0; i < 20; i++) {
      trails.update([makeStar({ position: [i * 1e-5, 0, 0], velocity: [1, 0, 0] })]);
    }
    const line = trails.group.children[0] as THREE.Line;
    // 1 个初始采样点 + 1 个实时末端点 = 2
    expect(line.geometry.drawRange.count).toBe(2);

    // 沿直线超过 minDist 步进 80 次，仅显示不超过 trailLength + 1 个顶点
    for (let i = 1; i <= 80; i++) {
      trails.update([makeStar({ position: [i * 0.05, 0, 0], velocity: [1, 0, 0] })]);
    }
    expect(line.geometry.drawRange.count).toBe(51);

    // 速度方向急转弯（即使位移小于 minDist 但超过防抖下限）应触发曲率采样
    trails.clearTrails();
    expect(line.geometry.drawRange.count).toBe(0);

    trails.update([makeStar({ position: [0, 0, 0], velocity: [1, 0, 0] })]);
    trails.update([makeStar({ position: [0.005, 0.002, 0], velocity: [0, 1, 0] })]);
    expect(line.geometry.drawRange.count).toBe(3); // 2 采样点 + 1 实时点

    expect(MAX_TRAIL_CAPACITY).toBe(2400);
    trails.dispose();
  });

  it('【跨层约定 #2 & #3】VectorHelpers 网格严格位于 XY 平面 (z=0)，行星引力箭头改用 acceleration', () => {
    const helpers = new VectorHelpers({
      ...DEFAULT_VISUAL_OPTIONS,
      showForceVectors: true,
      showVelocityVectors: true,
      showReferenceGrid: true,
      showCenterOfMass: true,
    });

    // 验证参考网格所有顶点均位于 z = 0 且颜色 <= 0.45
    const gridGroup = helpers.group.getObjectByName('XYReferenceGrid') as THREE.Group;
    const gridSegments = gridGroup.children[0] as THREE.LineSegments;
    const posAttr = gridSegments.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = gridSegments.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < posAttr.count; i++) {
      expect(posAttr.getZ(i)).toBe(0);
      expect(colAttr.getX(i)).toBeLessThanOrEqual(0.45 + 1e-5);
      expect(colAttr.getY(i)).toBeLessThanOrEqual(0.45 + 1e-5);
      expect(colAttr.getZ(i)).toBeLessThanOrEqual(0.45 + 1e-5);
    }

    // 验证测试粒子行星（force ≈ 1e-6，acceleration ≈ 3.9）依然显示可见引力箭头
    const planet = makePlanet();
    helpers.syncBodies([planet]);
    helpers.update([planet], [0, 0, 0]);
    const forceGroup = helpers.group.getObjectByName('ForceVectors') as THREE.Group;
    const planetArrowRoot = forceGroup.children[0];
    expect(planetArrowRoot.visible).toBe(true);

    // 验证近地模式隔离自动隐藏全部辅助层，切回后恢复
    helpers.setSurfaceModeHidden(true);
    expect(gridGroup.visible).toBe(false);
    expect(forceGroup.visible).toBe(false);

    helpers.setSurfaceModeHidden(false);
    expect(gridGroup.visible).toBe(true);
    expect(forceGroup.visible).toBe(true);

    helpers.dispose();
  });

  it('SurfaceDome 严格对齐赤道正交基旋转且任意温度下大气均匀色通道 <= 0.88', () => {
    const dome = new SurfaceDome();
    const theta = 1.23;
    const sunDir = new THREE.Vector3(0.4, 0.7, -0.5).normalize();
    const sunCol = new THREE.Color('#fef08a');

    for (const tempC of [-180, -30, 15, 35, 95, 350]) {
      dome.update(tempC, theta, 2, [sunDir], [sunCol], 1);
      const expectedMat = computeEquatorialBasisMatrix(theta, new THREE.Matrix4());
      const expectedQuat = new THREE.Quaternion().setFromRotationMatrix(expectedMat);
      expect(Math.abs(dome.group.quaternion.dot(expectedQuat))).toBeCloseTo(1, 6);
    }

    dome.dispose();
  });

  it('BodyVisuals 支持增删同步、近地模式隐藏自身行星并以相对坐标放置恒星', () => {
    const visuals = new BodyVisuals();
    const star = makeStar({ id: 'star-1', position: [1.5, 0.5, 0] });
    const planet = makePlanet({ id: 'planet-1', position: [0.5, 0.5, 0] });

    visuals.syncBodies([star, planet]);
    expect(visuals.group.children.length).toBe(2);

    // 近地模式：行星被隐藏，恒星相对位置沿 +X 方向 (1.0, 0, 0)
    visuals.updatePositions(
      [star, planet],
      new THREE.Vector3(0.5, 0.5, 0),
      true,
      'planet-1',
      0.5
    );
    const planetObj = visuals.group.getObjectByName('Planet_planet-1');
    const starObj = visuals.group.getObjectByName('Star_star-1');
    expect(planetObj?.visible).toBe(false);
    expect(starObj?.visible).toBe(true);
    expect(starObj?.position.x).toBeGreaterThan(0.9);
    expect(Math.abs(starObj?.position.y ?? 1)).toBeLessThan(1e-6);

    // 移除行星后干净销毁
    visuals.syncBodies([star]);
    expect(visuals.group.children.length).toBe(1);
    visuals.dispose();
  });

  it('BodyVisuals 在 performance（16×16 球体 + 增强 Additive Sprite 光晕）与 high（36×24 球体）间热切换与资源清理', () => {
    const visuals = new BodyVisuals('performance');
    const star = makeStar({ id: 'star-perf', renderRadius: 0.1, color: '#fbbf24' });
    const planet = makePlanet({ id: 'planet-perf', renderRadius: 0.04 });

    visuals.syncBodies([star, planet]);
    expect(visuals.getQualityMode()).toBe('performance');

    const starGroup = visuals.group.getObjectByName('Star_star-perf') as THREE.Group;
    const starMesh = starGroup.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
    const starSprite = starGroup.children.find((c) => c instanceof THREE.Sprite) as THREE.Sprite;
    const planetGroup = visuals.group.getObjectByName('Planet_planet-perf') as THREE.Group;
    const planetSpinPivot = planetGroup.children[0] as THREE.Group;
    const planetMesh = planetSpinPivot.children[0] as THREE.Mesh;

    // performance 模式：16×16 球体 + 增强 Additive Sprite 光晕（大半径 + 高不透明度）
    const perfGeoParams = (starMesh.geometry as THREE.SphereGeometry).parameters;
    expect(perfGeoParams.widthSegments).toBe(16);
    expect(perfGeoParams.heightSegments).toBe(16);
    expect((planetMesh.geometry as THREE.SphereGeometry).parameters.widthSegments).toBe(16);

    const spriteMat = starSprite.material as THREE.SpriteMaterial;
    expect(spriteMat.blending).toBe(THREE.AdditiveBlending);
    expect(spriteMat.depthWrite).toBe(false);
    expect(spriteMat.opacity).toBeGreaterThanOrEqual(0.9);
    const perfScale = starSprite.scale.x;
    expect(perfScale).toBeCloseTo(0.1 * 9.5, 5);

    // 热切换至 high 模式：36×24 球体 + 克制日冕光晕（防止与 Bloom 叠爆）
    visuals.setQualityMode('high');
    expect(visuals.getQualityMode()).toBe('high');
    const highGeoParams = (starMesh.geometry as THREE.SphereGeometry).parameters;
    expect(highGeoParams.widthSegments).toBe(36);
    expect(highGeoParams.heightSegments).toBe(24);
    expect((planetMesh.geometry as THREE.SphereGeometry).parameters.widthSegments).toBe(36);

    expect(spriteMat.opacity).toBeLessThan(0.7);
    expect(starSprite.scale.x).toBeLessThan(perfScale);
    expect(starSprite.scale.x).toBeCloseTo(0.1 * 6.5, 5);

    // 切回 performance 并校验近地模式自适应光晕增强
    visuals.setQualityMode('performance');
    visuals.updatePositions([star, planet], new THREE.Vector3(0, 0, 0), false, null, 0);
    expect(starSprite.scale.x).toBeCloseTo(0.1 * 9.5, 5);
    expect(spriteMat.opacity).toBeGreaterThanOrEqual(0.9);

    visuals.dispose();
    expect(visuals.group.children.length).toBe(0);
  });

  it('Starfield 在 performance 模式下点云总数显著低于 high 模式且线性 RGB 严格 <= 0.85', () => {
    const countTotalPoints = (sf: Starfield): number => {
      let total = 0;
      for (const child of sf.group.children) {
        if (child instanceof THREE.Points) {
          const posAttr = child.geometry.getAttribute('position') as THREE.BufferAttribute;
          const colAttr = child.geometry.getAttribute('color') as THREE.BufferAttribute;
          total += posAttr.count;
          for (let i = 0; i < colAttr.count; i++) {
            expect(colAttr.getX(i)).toBeLessThanOrEqual(0.85 + 1e-5);
            expect(colAttr.getY(i)).toBeLessThanOrEqual(0.85 + 1e-5);
            expect(colAttr.getZ(i)).toBeLessThanOrEqual(0.85 + 1e-5);
          }
        }
      }
      return total;
    };

    const starfield = new Starfield('high');
    const highTotal = countTotalPoints(starfield);
    expect(highTotal).toBe(4300);

    starfield.setQualityMode('performance');
    expect(starfield.getQualityMode()).toBe('performance');
    const perfTotal = countTotalPoints(starfield);
    expect(perfTotal).toBe(1180);
    expect(perfTotal).toBeLessThan(highTotal * 0.35);

    // 切回高画质应完整还原密度
    starfield.setQualityMode('high');
    expect(countTotalPoints(starfield)).toBe(highTotal);

    starfield.dispose();
    expect(starfield.group.children.length).toBe(0);
  });

  it('SceneRenderer 支持 qualityMode 热切换、DPR 分级上限与半分辨率 Bloom 尺寸计算', () => {
    // 验证 DPR 分级上限（high <= 2.0，performance <= 1.25）
    expect(computeEffectivePixelRatio('high', 3)).toBe(2);
    expect(computeEffectivePixelRatio('high', 1.5)).toBe(1.5);
    expect(computeEffectivePixelRatio('performance', 3)).toBe(1.25);
    expect(computeEffectivePixelRatio('performance', 2)).toBe(1.25);
    expect(computeEffectivePixelRatio('performance', 1)).toBe(1);

    // 验证高画质半分辨率 Bloom 目标尺寸
    expect(computeHalfResolutionBloomSize(1920, 1080, 2)).toEqual([1920, 1080]);
    expect(computeHalfResolutionBloomSize(1280, 720, 1)).toEqual([640, 360]);
    expect(computeHalfResolutionBloomSize(1, 1, 1)).toEqual([1, 1]);

    const renderer: ISceneRenderer = new SceneRenderer();
    const star = makeStar();
    const planet = makePlanet();

    // 在无 WebGL 上下文的无头环境下，完整验证质量档位切换与全方法安全幂等性
    renderer.syncBodies([star, planet], true);
    renderer.setVisualOptions({ qualityMode: 'performance', enableBloom: false, trailLength: 400 });
    renderer.setCameraMode('planet-surface', planet.id);
    renderer.syncSurfaceView(22, 0.75, planet.id);
    renderer.setVisualOptions({ qualityMode: 'high', enableBloom: true, bloomStrength: 0.85 });
    renderer.setCameraMode('com');
    renderer.resetCameraView(6.0);
    renderer.resize(800, 600);
    renderer.clearTrails();
    renderer.dispose();
    renderer.dispose();
  });
});
