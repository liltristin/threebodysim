/**
 * 多层次深空星场与星云尘埃带（Starfield）
 *
 * 设计要点：
 * - 三层大半径球壳（680 ~ 920），始终跟随相机中心消除视差，确保太空视角与近地视角均自然衔接。
 * - 所有恒星点与尘埃云的线性 RGB 严格 <= 0.85，绝不触发 Bloom（threshold = 1.0）。
 * - 渲染顺序 renderOrder = -22 / -20，开启 depthTest、关闭 depthWrite，保证近地地貌与天体正确遮挡星空。
 */

import * as THREE from 'three';
import {
  clampLinearColor,
  createNebulaPuffTexture,
  createSeededRandom,
  createStarPointTexture,
} from './colorUtils';

const STAR_SPECTRAL_HEX = [
  '#9bb8ff', // O/B 蓝白
  '#bfd4ff', // B/A 浅蓝白
  '#e2ebff', // A 纯冷白
  '#f4f1ea', // F 柔和白
  '#f6e3be', // G 暖黄白
  '#e8c494', // K 淡橙金
  '#d9a27e', // M 暖琥珀
] as const;

const NEBULA_PALETTE_HEX = [
  '#1b2f5e', // 深空靛蓝
  '#183c54', // 寒青星尘
  '#2d224c', // 幽紫星云
  '#3e2438', // 极淡玫瑰暗尘
] as const;

export class Starfield {
  public readonly group: THREE.Group;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'DeepSpaceStarfield';

    const rand = createSeededRandom(20260403);
    const starTex = createStarPointTexture();
    const nebulaTex = createNebulaPuffTexture();
    if (starTex) this.textures.push(starTex);
    if (nebulaTex) this.textures.push(nebulaTex);

    // 1. 极淡银河星云尘埃带（倾角 ~34°，太空与近地夜空均可望见斜跨天穹的微光尘带）
    this.buildNebulaBand(rand, nebulaTex);

    // 2. 远景精细暗星层（3400 颗）
    this.buildStarLayer(rand, {
      count: 3400,
      minRadius: 740,
      maxRadius: 920,
      pointSize: 3.1,
      minBrightness: 0.22,
      maxBrightness: 0.68,
      galacticBias: 0.35,
      texture: starTex,
      renderOrder: -21,
      opacity: 0.85,
    });

    // 3. 中远景冷暖亮星层（420 颗）
    this.buildStarLayer(rand, {
      count: 420,
      minRadius: 680,
      maxRadius: 800,
      pointSize: 5.8,
      minBrightness: 0.52,
      maxBrightness: 0.84,
      galacticBias: 0.2,
      texture: starTex,
      renderOrder: -20,
      opacity: 0.92,
    });
  }

  /**
   * 将星场包围球对齐到相机位置（太空模式下实现无限远无视差；近地模式下相机在原点，星空随世界坐标固定）。
   */
  public setCenter(position: THREE.Vector3): void {
    this.group.position.copy(position);
  }

  public dispose(): void {
    for (const geo of this.geometries) {
      geo.dispose();
    }
    for (const mat of this.materials) {
      mat.dispose();
    }
    for (const tex of this.textures) {
      tex.dispose();
    }
    this.geometries.length = 0;
    this.materials.length = 0;
    this.textures.length = 0;
    this.group.clear();
  }

  private buildStarLayer(
    rand: () => number,
    opts: {
      count: number;
      minRadius: number;
      maxRadius: number;
      pointSize: number;
      minBrightness: number;
      maxBrightness: number;
      galacticBias: number;
      texture: THREE.Texture | null;
      renderOrder: number;
      opacity: number;
    }
  ): void {
    const positions = new Float32Array(opts.count * 3);
    const colors = new Float32Array(opts.count * 3);
    const color = new THREE.Color();
    const tiltMatrix = new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(0.62, 0.38, 0.25)
    );
    const vec = new THREE.Vector3();

    for (let i = 0; i < opts.count; i++) {
      const u = rand() * Math.PI * 2;
      let cosPhi: number;
      if (rand() < opts.galacticBias) {
        // 部分星点沿银河带略微聚集
        const spread = (rand() + rand() + rand()) / 3 - 0.5;
        cosPhi = Math.max(-0.99, Math.min(0.99, spread * 0.55));
      } else {
        cosPhi = rand() * 2 - 1;
      }
      const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
      const r = opts.minRadius + rand() * (opts.maxRadius - opts.minRadius);

      vec.set(r * sinPhi * Math.cos(u), r * sinPhi * Math.sin(u), r * cosPhi);
      vec.applyMatrix4(tiltMatrix);

      const i3 = i * 3;
      positions[i3] = vec.x;
      positions[i3 + 1] = vec.y;
      positions[i3 + 2] = vec.z;

      const hex =
        STAR_SPECTRAL_HEX[Math.floor(rand() * STAR_SPECTRAL_HEX.length)] ??
        '#e2ebff';
      color.set(hex);
      const brightness =
        opts.minBrightness +
        Math.pow(rand(), 1.6) * (opts.maxBrightness - opts.minBrightness);
      color.multiplyScalar(brightness);
      clampLinearColor(color, 0.85);

      colors[i3] = color.r;
      colors[i3 + 1] = color.g;
      colors[i3 + 2] = color.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: opts.pointSize,
      sizeAttenuation: true,
      map: opts.texture,
      vertexColors: true,
      transparent: true,
      opacity: opts.opacity,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      fog: false,
    });

    const points = new THREE.Points(geometry, material);
    points.renderOrder = opts.renderOrder;
    points.frustumCulled = false;

    this.geometries.push(geometry);
    this.materials.push(material);
    this.group.add(points);
  }

  private buildNebulaBand(
    rand: () => number,
    texture: THREE.Texture | null
  ): void {
    const count = 480;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const color = new THREE.Color();
    const tiltMatrix = new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(0.62, 0.38, 0.25)
    );
    const vec = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
      const angle = rand() * Math.PI * 2;
      // 高斯近似聚集于银河赤道附近
      const bandLat = ((rand() + rand() + rand()) / 3 - 0.5) * 0.52;
      const cosLat = Math.cos(bandLat);
      const r = 820 + rand() * 90;

      vec.set(
        r * cosLat * Math.cos(angle),
        r * cosLat * Math.sin(angle),
        r * Math.sin(bandLat)
      );
      vec.applyMatrix4(tiltMatrix);

      const i3 = i * 3;
      positions[i3] = vec.x;
      positions[i3 + 1] = vec.y;
      positions[i3 + 2] = vec.z;

      const hex =
        NEBULA_PALETTE_HEX[Math.floor(rand() * NEBULA_PALETTE_HEX.length)] ??
        '#1b2f5e';
      color.set(hex);
      const intensity = 0.25 + rand() * 0.45;
      color.multiplyScalar(intensity);
      // 星云尘埃严格限制在低线性亮度，防止叠加发白或触发 Bloom
      clampLinearColor(color, 0.32);

      colors[i3] = color.r;
      colors[i3 + 1] = color.g;
      colors[i3 + 2] = color.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 165,
      sizeAttenuation: true,
      map: texture,
      vertexColors: true,
      transparent: true,
      opacity: 0.11,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      fog: false,
    });

    const points = new THREE.Points(geometry, material);
    points.renderOrder = -22;
    points.frustumCulled = false;

    this.geometries.push(geometry);
    this.materials.push(material);
    this.group.add(points);
  }
}
