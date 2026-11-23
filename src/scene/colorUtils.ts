/**
 * 渲染层颜色、HDR 限幅、程序化纹理与赤道正交基数学工具
 *
 * 严格约束：
 * - 非恒星元素的线性 RGB 分量必须严格保持在 [0, 0.95] 区间内，防止触及 UnrealBloomPass(threshold = 1.0)。
 * - 仅恒星材质通过 HDR emissiveIntensity > 1.0 触发选择性辉光。
 */

import * as THREE from 'three';

const WHITE_COLOR = new THREE.Color(1, 1, 1);

const FORCE_BLUE = new THREE.Color('#38bdf8');
const FORCE_AMBER = new THREE.Color('#f59e0b');
const FORCE_RED = new THREE.Color('#ef4444');

const TMP_EAST = new THREE.Vector3();
const TMP_UP = new THREE.Vector3();
const TMP_NEG_NORTH = new THREE.Vector3();

/**
 * 将线性颜色的最大通道值等比压缩至 maxChannel 以内，保持色相且绝对不触发 Bloom。
 */
export function clampLinearColor(
  color: THREE.Color,
  maxChannel: number = 0.92
): THREE.Color {
  const maxComp = Math.max(color.r, color.g, color.b);
  if (maxComp > maxChannel && maxComp > 0) {
    const scale = maxChannel / maxComp;
    color.r *= scale;
    color.g *= scale;
    color.b *= scale;
  }
  color.r = Math.max(0, Math.min(maxChannel, color.r));
  color.g = Math.max(0, Math.min(maxChannel, color.g));
  color.b = Math.max(0, Math.min(maxChannel, color.b));
  return color;
}

/**
 * 解析十六进制 sRGB 颜色并转换为限幅后的线性颜色。
 */
export function hexToClampedColor(
  hex: string,
  maxChannel: number = 0.92,
  target: THREE.Color = new THREE.Color()
): THREE.Color {
  target.set(hex);
  return clampLinearColor(target, maxChannel);
}

/**
 * 计算线性 RGB 亮度（与 Three.js LuminosityHighPassShader 一致，BT.709 系数）。
 */
export function getLinearLuminance(color: THREE.Color): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

/**
 * 计算恒星 HDR 自发光颜色与有效自发光强度。
 *
 * 物理/视觉细节：
 * - Three.js 将 sRGB 颜色转线性后，红/蓝/紫恒星的线性亮度往往仅 ~0.33，若直接乘 2.6 可能不足 threshold=1.0。
 * - 将光球核心轻度向炽白混色（30%）并按线性亮度做下限补偿，确保各类色温恒星在 emissiveIntensity > 1.0 时
 *   均能稳定跨越 threshold=1.0 绽放自然辉光，而在 <= 1.0 时安全保持非辉光。
 */
export function computeStarEmissive(
  hex: string,
  emissiveIntensity: number,
  outColor: THREE.Color
): number {
  outColor.set(hex);
  if (emissiveIntensity <= 1.0) {
    clampLinearColor(outColor, 0.92);
    return Math.max(0, Math.min(emissiveIntensity, 0.92));
  }

  // 光球核心向白热态微混，呈现真实恒星核心+外缘色泽
  outColor.lerp(WHITE_COLOR, 0.3);
  const lum = Math.max(getLinearLuminance(outColor), 0.18);
  const targetLum = emissiveIntensity * 0.82;
  const compensatedIntensity = Math.max(emissiveIntensity, targetLum / lum);
  // 上限保护，避免极端输入在 ACES 下过曝成巨大纯白块
  return Math.min(compensatedIntensity, 6.0);
}

/**
 * 引力/加速度强度色阶：蓝（弱）→ 琥珀（中）→ 红（强），严格限幅 <= 0.92。
 */
export function computeForceHeatColor(
  normalizedStrength: number,
  outColor: THREE.Color
): THREE.Color {
  const t = Math.max(0, Math.min(1, normalizedStrength));
  if (t < 0.5) {
    outColor.copy(FORCE_BLUE).lerp(FORCE_AMBER, t * 2.0);
  } else {
    outColor.copy(FORCE_AMBER).lerp(FORCE_RED, (t - 0.5) * 2.0);
  }
  return clampLinearColor(outColor, 0.92);
}

/**
 * 【跨层约定 #1】构造赤道观测者右手局部正交基旋转矩阵：
 * - 行星绕世界 Z 轴自转，自转角 θ = rotationAngle
 * - +X_local = east  = (-sin θ, cos θ, 0)
 * - +Y_local = up    = (cos θ, sin θ, 0)
 * - +Z_local = -north = (0, 0, -1)
 * 矩阵行列式 det = +1，与物理层 StarSkyObservation 100% 对齐。
 */
export function computeEquatorialBasisMatrix(
  rotationAngle: number,
  outMatrix: THREE.Matrix4
): THREE.Matrix4 {
  const cosT = Math.cos(rotationAngle);
  const sinT = Math.sin(rotationAngle);
  TMP_EAST.set(-sinT, cosT, 0);
  TMP_UP.set(cosT, sinT, 0);
  TMP_NEG_NORTH.set(0, 0, -1);
  return outMatrix.makeBasis(TMP_EAST, TMP_UP, TMP_NEG_NORTH);
}

/**
 * 创建确定性伪随机数生成器（Mulberry32），保证深空星场分布稳定美观。
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成柔和恒星日冕径向光晕纹理（用于恒星外层光环与远距“飞星”星芒）。
 */
export function createCoronaTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const half = size * 0.5;
  ctx.clearRect(0, 0, size, size);

  // 主日冕指数柔和衰减
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  grad.addColorStop(0.12, 'rgba(255, 252, 245, 0.85)');
  grad.addColorStop(0.28, 'rgba(255, 245, 230, 0.42)');
  grad.addColorStop(0.55, 'rgba(255, 235, 220, 0.11)');
  grad.addColorStop(0.82, 'rgba(255, 230, 220, 0.02)');
  grad.addColorStop(1.0, 'rgba(255, 230, 220, 0.0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // 细微十字星芒衍射丝（提升远距“飞星”与近距恒星质感）
  ctx.save();
  ctx.translate(half, half);
  for (let i = 0; i < 2; i++) {
    ctx.rotate(i === 0 ? 0 : Math.PI / 2);
    const rayGrad = ctx.createLinearGradient(-half, 0, half, 0);
    rayGrad.addColorStop(0.0, 'rgba(255,255,255,0)');
    rayGrad.addColorStop(0.32, 'rgba(255,255,255,0.03)');
    rayGrad.addColorStop(0.5, 'rgba(255,255,255,0.22)');
    rayGrad.addColorStop(0.68, 'rgba(255,255,255,0.03)');
    rayGrad.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = rayGrad;
    ctx.fillRect(-half, -1.5, size, 3);
  }
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 生成柔和圆形星点纹理（消除 Points 默认方块像素锯齿）。
 */
export function createStarPointTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const half = size * 0.5;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  grad.addColorStop(0.3, 'rgba(255, 255, 255, 0.78)');
  grad.addColorStop(0.65, 'rgba(255, 255, 255, 0.16)');
  grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 生成极淡星云尘埃团纹理（柔和扩散、无硬边）。
 */
export function createNebulaPuffTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const half = size * 0.5;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 0.45)');
  grad.addColorStop(0.4, 'rgba(255, 255, 255, 0.18)');
  grad.addColorStop(0.75, 'rgba(255, 255, 255, 0.04)');
  grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 生成三体行星表面程序化云纹/大陆反照率纹理（保持中等灰度以便与行星色相融合并突出昼夜明暗对比）。
 */
export function createPlanetSurfaceTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const width = 256;
  const height = 128;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const img = ctx.createImageData(width, height);
  const data = img.data;

  for (let y = 0; y < height; y++) {
    const v = y / height;
    const lat = (v - 0.5) * Math.PI;
    const polarCap = Math.pow(Math.abs(Math.sin(lat)), 5.0);
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const lon = u * Math.PI * 2;
      // 多频三角谐波构造周期无缝行星表面地貌与云带
      const n1 =
        Math.sin(lon * 2.0 + Math.cos(lat * 3.0)) *
        Math.cos(lat * 2.5 - Math.sin(lon * 3.0) * 0.5);
      const n2 =
        Math.sin(lon * 5.0 - lat * 4.0) * 0.45 +
        Math.cos(lon * 8.0 + lat * 7.0) * 0.25;
      const cloudBand =
        Math.sin(lat * 9.0 + Math.sin(lon * 4.0) * 0.7) * 0.22;

      const continent = 0.58 + n1 * 0.18 + n2 * 0.1;
      const cloud = Math.max(0, cloudBand) * 0.35;
      const shade = Math.max(0.32, Math.min(0.95, continent + cloud + polarCap * 0.25));

      const r = Math.round(shade * (215 + polarCap * 30));
      const g = Math.round(shade * (225 + polarCap * 22));
      const b = Math.round(shade * (238 + polarCap * 14));

      const idx = (y * width + x) * 4;
      data[idx] = Math.min(240, r);
      data[idx + 1] = Math.min(242, g);
      data[idx + 2] = Math.min(245, b);
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
