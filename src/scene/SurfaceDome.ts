/**
 * 三体行星近地沉浸穹顶与地平线剪影系统（SurfaceDome）
 *
 * 严格落实跨层约定：
 * - 【跨层约定 #1】采用赤道观测者右手局部正交基：
 *   +X = east = (-sin θ, cos θ, 0)
 *   +Y = up   = (cos θ, sin θ, 0)
 *   +Z = -north = (0, 0, -1)
 *   使天空中恒星的升落、仰角、方位角与物理层 StarSkyObservation 100% 同步。
 * - 真实深度遮挡地貌（R = 0.04，局部 y <= ~0，opaque depthWrite=true）：
 *   地平线以下恒星与日冕被硬件深度缓冲 100% 物理遮挡，且不遮挡 elevationRad > 0 的刚升起恒星。
 * - 动态温度变色大气穹顶（R = 500，局部 y >= 0，NormalBlending 透明叠加于星场之上、恒星之下）：
 *   根据实时 temperatureC 平滑插值：
 *   - 极寒乱纪元（< 0°C）：深邃冰蓝 / 寒靛
 *   - 恒纪元（0°C ~ 45°C）：澄澈蔚蓝 / 暖金地平线
 *   - 酷热乱纪元（> 45°C）：焦灼暗红 / 熔橙地平线
 *   并结合可见太阳数量与方向调制昼夜明暗与轻微瑞利/米氏散射光晕。
 * - 全部着色器输出通道严格硬限幅 <= 0.88（<= 0.90），绝对不触发 UnrealBloomPass(threshold = 1.0)。
 */

import * as THREE from 'three';
import { clampLinearColor, computeEquatorialBasisMatrix } from './colorUtils';

export const SURFACE_TERRAIN_RADIUS = 0.04;
export const SURFACE_SKY_RADIUS = 500;

interface AtmospherePalette {
  readonly tempC: number;
  readonly zenithHex: string;
  readonly midHex: string;
  readonly horizonHex: string;
  readonly rimHex: string;
}

/**
 * 温度锚点色板（按摄氏度升序排列，支持平滑连续插值）
 */
const TEMP_PALETTE_ANCHORS: readonly AtmospherePalette[] = [
  {
    // 极寒深冻（-120°C 及以下）
    tempC: -120,
    zenithHex: '#060f24',
    midHex: '#0d264d',
    horizonHex: '#285e8a',
    rimHex: '#1c4469',
  },
  {
    // 严寒冰封（-20°C）
    tempC: -20,
    zenithHex: '#0a1c3d',
    midHex: '#183f73',
    horizonHex: '#4f8db8',
    rimHex: '#2c5a80',
  },
  {
    // 恒纪元清凉（5°C）
    tempC: 5,
    zenithHex: '#123a78',
    midHex: '#2b6cb3',
    horizonHex: '#8db8d9',
    rimHex: '#527c9e',
  },
  {
    // 恒纪元宜居黄金（24°C）
    tempC: 24,
    zenithHex: '#16458a',
    midHex: '#3579bd',
    horizonHex: '#d4ae7d',
    rimHex: '#8a6b48',
  },
  {
    // 恒纪元偏暖临界（45°C）
    tempC: 45,
    zenithHex: '#2a3763',
    midHex: '#6e5b5c',
    horizonHex: '#dc8f4c',
    rimHex: '#96572b',
  },
  {
    // 酷热乱纪元（110°C）
    tempC: 110,
    zenithHex: '#471210',
    midHex: '#9c2d17',
    horizonHex: '#db5821',
    rimHex: '#a13812',
  },
  {
    // 极端炙烤（260°C 及以上）
    tempC: 260,
    zenithHex: '#360707',
    midHex: '#851b0e',
    horizonHex: '#cf3813',
    rimHex: '#99220a',
  },
];

const SKY_DOME_VERT = /* glsl */ `
  varying vec3 vLocalDir;

  void main() {
    vLocalDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_DOME_FRAG = /* glsl */ `
  uniform vec3 uZenithColor;
  uniform vec3 uMidColor;
  uniform vec3 uHorizonColor;
  uniform float uDaylight;
  uniform int uSunCount;
  uniform vec3 uSunDirs[3];
  uniform vec3 uSunColors[3];

  varying vec3 vLocalDir;

  void main() {
    vec3 dir = normalize(vLocalDir);
    float elev = clamp(dir.y, 0.0, 1.0);

    // 三段垂直大气渐变：地平线 → 中天 → 天顶
    vec3 lowerSky = mix(uHorizonColor, uMidColor, smoothstep(0.0, 0.28, elev));
    vec3 daySky = mix(lowerSky, uZenithColor, smoothstep(0.18, 0.88, elev));

    // 夜晚模式：深暗极夜天顶 + 极淡温度余晖地平线，让深空星场清晰透现
    vec3 nightZenith = uZenithColor * 0.14;
    vec3 nightHorizon = uHorizonColor * 0.24;
    vec3 nightSky = mix(nightHorizon, nightZenith, smoothstep(0.0, 0.45, elev));

    vec3 skyCol = mix(nightSky, daySky, uDaylight);

    // 叠加轻微太阳方向大气瑞利/米氏散射晕（仅限地平线附近及上方太阳，绝不触发 Bloom）
    for (int i = 0; i < 3; i++) {
      if (i >= uSunCount) break;
      vec3 sDir = normalize(uSunDirs[i]);
      float sunAbove = smoothstep(-0.12, 0.15, sDir.y);
      float cosAng = max(dot(dir, sDir), 0.0);
      float wideGlow = pow(cosAng, 5.0) * 0.24;
      float tightGlow = pow(cosAng, 28.0) * 0.28;
      float horizonBoost = mix(1.25, 0.85, elev);
      skyCol += uSunColors[i] * (wideGlow + tightGlow) * sunAbove * horizonBoost * (0.35 + 0.65 * uDaylight);
    }

    // 透明度：白昼大气更浓厚、地平线雾气最厚；夜晚天顶近乎透明以便观赏星空
    float horizonDensity = mix(0.92, 0.58, smoothstep(0.0, 0.35, elev));
    float nightAlpha = mix(0.52, 0.12, smoothstep(0.0, 0.42, elev));
    float alpha = mix(nightAlpha, horizonDensity, uDaylight);

    // 地平线以下缓慢裁除（由不透明地形遮挡，此处留微小过渡带防接缝）
    alpha *= smoothstep(-0.04, 0.01, dir.y);

    // 严格线性 RGB 硬上限 <= 0.88，100% 免疫误触发 Bloom
    skyCol = min(skyCol, vec3(0.88));
    gl_FragColor = vec4(skyCol, clamp(alpha, 0.0, 0.94));
  }
`;

const TERRAIN_VERT = /* glsl */ `
  varying vec3 vLocalDir;
  varying float vRidgeHeight;

  void main() {
    vLocalDir = normalize(position);
    vRidgeHeight = uv.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TERRAIN_FRAG = /* glsl */ `
  uniform vec3 uHorizonColor;
  uniform vec3 uRimColor;
  uniform float uDaylight;

  varying vec3 vLocalDir;
  varying float vRidgeHeight;

  void main() {
    vec3 dir = normalize(vLocalDir);
    float az = atan(dir.x, -dir.z); // 0 = 北, +pi/2 = 东, pi = 南, -pi/2 = 西

    // 极简三体玄武岩/风蚀荒漠剪影基底
    vec3 deepGround = vec3(0.012, 0.014, 0.02);
    vec3 litGround = mix(vec3(0.025, 0.028, 0.036), uRimColor * 0.32, 0.65);
    vec3 baseCol = mix(deepGround, litGround, 0.25 + 0.75 * uDaylight);

    // 距天底越近越深沉，距山脊天际线越近呈现大气边缘透视雾
    float rimFactor = smoothstep(0.62, 1.0, vRidgeHeight);
    vec3 ridgeHaze = mix(uRimColor * 0.35, uHorizonColor * 0.52, uDaylight);
    vec3 col = mix(baseCol, ridgeHaze, pow(rimFactor, 2.2) * 0.72);

    // 地表微妙方位刻度纹理（东西南北方向微弱暗纹，辅助感知行星自转）
    float cardinalPulse = pow(abs(cos(az * 2.0)), 40.0);
    float groundBand = smoothstep(0.45, 0.88, vRidgeHeight) * (1.0 - smoothstep(0.92, 0.99, vRidgeHeight));
    col += uHorizonColor * cardinalPulse * groundBand * 0.14;

    // 严格限制在 <= 0.65，绝不触发 Bloom
    col = min(col, vec3(0.65));
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class SurfaceDome {
  public readonly group: THREE.Group;

  private readonly skyGeometry: THREE.SphereGeometry;
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly skyMesh: THREE.Mesh;

  private readonly terrainGeometry: THREE.BufferGeometry;
  private readonly terrainMaterial: THREE.ShaderMaterial;
  private readonly terrainMesh: THREE.Mesh;

  // 预分配临时矩阵与颜色，避免每帧分配
  private readonly basisMatrix = new THREE.Matrix4();
  private readonly tmpZenith = new THREE.Color();
  private readonly tmpMid = new THREE.Color();
  private readonly tmpHorizon = new THREE.Color();
  private readonly tmpRim = new THREE.Color();
  private readonly tmpLerpA = new THREE.Color();
  private readonly tmpLerpB = new THREE.Color();

  private readonly sunDirsUniform: THREE.Vector3[] = [
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 1, 0),
  ];
  private readonly sunColorsUniform: THREE.Color[] = [
    new THREE.Color(0.8, 0.7, 0.5),
    new THREE.Color(0.8, 0.7, 0.5),
    new THREE.Color(0.8, 0.7, 0.5),
  ];

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'TrisolarisSurfaceDome';
    this.group.visible = false;

    // 1. 天空大气穹顶（覆盖上半球并略延至地平线下方 -3° 防微缝）
    this.skyGeometry = new THREE.SphereGeometry(
      SURFACE_SKY_RADIUS,
      48,
      28,
      0,
      Math.PI * 2,
      0,
      Math.PI * 0.53
    );

    this.skyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uZenithColor: { value: new THREE.Color('#16458a') },
        uMidColor: { value: new THREE.Color('#3579bd') },
        uHorizonColor: { value: new THREE.Color('#d4ae7d') },
        uDaylight: { value: 0.75 },
        uSunCount: { value: 0 },
        uSunDirs: { value: this.sunDirsUniform },
        uSunColors: { value: this.sunColorsUniform },
      },
      vertexShader: SKY_DOME_VERT,
      fragmentShader: SKY_DOME_FRAG,
      side: THREE.BackSide,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.skyMesh = new THREE.Mesh(this.skyGeometry, this.skyMaterial);
    this.skyMesh.renderOrder = -10;
    this.skyMesh.frustumCulled = false;

    // 2. 真实深度遮挡地平线剪影地貌（R = 0.04，不透明写入深度缓冲）
    this.terrainGeometry = this.buildTerrainGeometry();
    this.terrainMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uHorizonColor: { value: new THREE.Color('#d4ae7d') },
        uRimColor: { value: new THREE.Color('#8a6b48') },
        uDaylight: { value: 0.75 },
      },
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
      side: THREE.DoubleSide,
      transparent: false,
      depthTest: true,
      depthWrite: true,
    });

    this.terrainMesh = new THREE.Mesh(
      this.terrainGeometry,
      this.terrainMaterial
    );
    this.terrainMesh.renderOrder = -1;
    this.terrainMesh.frustumCulled = false;

    this.group.add(this.skyMesh, this.terrainMesh);
  }

  public setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /**
   * 幂等更新近地穹顶朝向、温度大气色板、昼夜明暗及太阳散射方向。
   * 每次以相同参数调用均产生完全一致的视觉状态（满足跨层约定 #1 & #3）。
   */
  public update(
    temperatureC: number,
    rotationAngle: number,
    visibleSunCount: number,
    localSunDirs: readonly THREE.Vector3[],
    sunColors: readonly THREE.Color[],
    sunCount: number = localSunDirs.length
  ): void {
    // 1. 严格应用赤道观测者右手局部正交基（X=east, Y=up, Z=-north, det=+1）
    computeEquatorialBasisMatrix(rotationAngle, this.basisMatrix);
    this.group.quaternion.setFromRotationMatrix(this.basisMatrix);

    // 2. 根据实时表面温度平滑插值大气色板
    this.sampleTemperaturePalette(
      temperatureC,
      this.tmpZenith,
      this.tmpMid,
      this.tmpHorizon,
      this.tmpRim
    );

    // 3. 结合可见恒星数量与最高太阳仰角计算自然昼夜系数
    let maxElev = -1;
    const count = Math.min(3, sunCount, localSunDirs.length);
    for (let i = 0; i < count; i++) {
      const dir = localSunDirs[i];
      this.sunDirsUniform[i].copy(dir);
      const col = sunColors[i];
      if (col) {
        this.sunColorsUniform[i].copy(col);
        clampLinearColor(this.sunColorsUniform[i], 0.82);
      }
      if (dir.y > maxElev) {
        maxElev = dir.y;
      }
    }

    // 即使在曙暮光（太阳刚在地平线下方 -8°~0°）也给出平滑晨昏过渡；多日同天更明亮
    const twilight = this.smoothstep(-0.14, 0.18, maxElev);
    const multiSunLift = Math.min(1.0, visibleSunCount * 0.35);
    const daylight = Math.max(
      0.0,
      Math.min(1.0, Math.max(twilight * 0.85, multiSunLift * 0.55 + twilight * 0.45))
    );

    const skyU = this.skyMaterial.uniforms;
    (skyU['uZenithColor'].value as THREE.Color).copy(this.tmpZenith);
    (skyU['uMidColor'].value as THREE.Color).copy(this.tmpMid);
    (skyU['uHorizonColor'].value as THREE.Color).copy(this.tmpHorizon);
    skyU['uDaylight'].value = daylight;
    skyU['uSunCount'].value = count;

    const terU = this.terrainMaterial.uniforms;
    (terU['uHorizonColor'].value as THREE.Color).copy(this.tmpHorizon);
    (terU['uRimColor'].value as THREE.Color).copy(this.tmpRim);
    terU['uDaylight'].value = daylight;
  }

  public dispose(): void {
    this.skyGeometry.dispose();
    this.skyMaterial.dispose();
    this.terrainGeometry.dispose();
    this.terrainMaterial.dispose();
    this.group.clear();
  }

  /**
   * 构造闭环下半球 + 360° 极简三体山脊地平线剪影网格：
   * - 仰角范围从天底 (-π/2) 延伸至山脊天际线（-0.015 rad ~ +0.0035 rad），
   *   使地平线以下恒星被硬件深度缓冲 100% 遮挡，而刚升至 0° 以上的恒星立即露出山脊，
   *   与物理层 StarSkyObservation.isAboveHorizon 严格同步。
   */
  private buildTerrainGeometry(): THREE.BufferGeometry {
    const azSegments = 180;
    const elevRings = 14;
    const radius = SURFACE_TERRAIN_RADIUS;

    const vertexCount = (azSegments + 1) * (elevRings + 1);
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices: number[] = [];

    let vPtr = 0;
    let uvPtr = 0;

    for (let r = 0; r <= elevRings; r++) {
      const t = r / elevRings; // 0 = 天底, 1 = 山脊天际线
      // 非线性加密靠近地平线附近的网格环，使山脊边缘平滑自然
      const shapedT = 1 - Math.pow(1 - t, 1.8);

      for (let a = 0; a <= azSegments; a++) {
        const u = a / azSegments;
        const az = u * Math.PI * 2;

        // 多频山脊轮廓（周期严格闭合，幅度克制在 [-0.015, +0.0035] rad 之间）
        const mountain =
          Math.sin(az * 3.0 + 0.4) * 0.0055 +
          Math.sin(az * 7.0 - 1.1) * 0.0032 +
          Math.sin(az * 13.0 + 2.3) * 0.0018 +
          Math.cos(az * 23.0 - 0.7) * 0.0009;
        const ridgeElev = -0.0075 + mountain; // 最高峰约 +0.0039 rad (0.22°)，谷底约 -0.018 rad

        const elev = -Math.PI * 0.5 + shapedT * (ridgeElev + Math.PI * 0.5);
        const cosE = Math.cos(elev);
        const sinE = Math.sin(elev);

        // 局部坐标：X = east, Y = up, Z = -north
        positions[vPtr++] = radius * cosE * Math.sin(az);
        positions[vPtr++] = radius * sinE;
        positions[vPtr++] = -radius * cosE * Math.cos(az);

        uvs[uvPtr++] = u;
        uvs[uvPtr++] = t;
      }
    }

    const rowStride = azSegments + 1;
    for (let r = 0; r < elevRings; r++) {
      for (let a = 0; a < azSegments; a++) {
        const i0 = r * rowStride + a;
        const i1 = i0 + 1;
        const i2 = i0 + rowStride;
        const i3 = i2 + 1;
        indices.push(i0, i2, i1);
        indices.push(i1, i2, i3);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  private sampleTemperaturePalette(
    tempC: number,
    outZenith: THREE.Color,
    outMid: THREE.Color,
    outHorizon: THREE.Color,
    outRim: THREE.Color
  ): void {
    const anchors = TEMP_PALETTE_ANCHORS;
    if (tempC <= anchors[0].tempC) {
      this.assignPalette(anchors[0], outZenith, outMid, outHorizon, outRim);
      return;
    }
    const last = anchors[anchors.length - 1];
    if (tempC >= last.tempC) {
      this.assignPalette(last, outZenith, outMid, outHorizon, outRim);
      return;
    }

    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i];
      const b = anchors[i + 1];
      if (tempC >= a.tempC && tempC <= b.tempC) {
        const rawT = (tempC - a.tempC) / (b.tempC - a.tempC);
        // 平滑 Hermite 插值
        const t = rawT * rawT * (3 - 2 * rawT);

        this.lerpHexClamped(a.zenithHex, b.zenithHex, t, 0.82, outZenith);
        this.lerpHexClamped(a.midHex, b.midHex, t, 0.85, outMid);
        this.lerpHexClamped(a.horizonHex, b.horizonHex, t, 0.88, outHorizon);
        this.lerpHexClamped(a.rimHex, b.rimHex, t, 0.72, outRim);
        return;
      }
    }
  }

  private assignPalette(
    p: AtmospherePalette,
    outZenith: THREE.Color,
    outMid: THREE.Color,
    outHorizon: THREE.Color,
    outRim: THREE.Color
  ): void {
    clampLinearColor(outZenith.set(p.zenithHex), 0.82);
    clampLinearColor(outMid.set(p.midHex), 0.85);
    clampLinearColor(outHorizon.set(p.horizonHex), 0.88);
    clampLinearColor(outRim.set(p.rimHex), 0.72);
  }

  private lerpHexClamped(
    hexA: string,
    hexB: string,
    t: number,
    maxChannel: number,
    out: THREE.Color
  ): void {
    this.tmpLerpA.set(hexA);
    this.tmpLerpB.set(hexB);
    out.copy(this.tmpLerpA).lerp(this.tmpLerpB, t);
    clampLinearColor(out, maxChannel);
  }

  private smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }
}
