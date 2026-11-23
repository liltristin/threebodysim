/**
 * 天体 3D 视觉管理（恒星 HDR 核心 + 日冕光环 + 点光源；三体行星光照昼夜面 + 大气边缘光）
 *
 * 严格遵循：
 * - 恒星通过 MeshStandardMaterial(color=0x000000, emissive, emissiveIntensity > 1.0) 触发选择性 Bloom。
 * - 行星材质严格保持 emissiveIntensity <= 0.40 且漫反射反照率受限，光照下绝不触发 Bloom。
 * - syncBodies 支持天体增删、碰撞合并、改色/改半径时干净重建并释放旧 GPU 资源（零泄漏）。
 * - 近地视角下自动隐藏行星自身 Mesh，并将所有恒星按相对坐标 r_star - r_planet 渲染，
 *   同时为远距“飞星”保留最小可见星芒与精准方向角。
 */

import * as THREE from 'three';
import type { BodyRole, BodyState } from '../types/contracts';
import {
  computeStarEmissive,
  createCoronaTexture,
  createPlanetSurfaceTexture,
  hexToClampedColor,
} from './colorUtils';

const MAX_SURFACE_STAR_DIST = 440;
const MIN_TERRAIN_CLEARANCE = 0.065;
const FLYING_STAR_MIN_ANG_RAD = 0.0045; // 约 0.26°，保证极远“飞星”仍有清晰星点
const CLOSE_STAR_MAX_ANG_RAD = 0.42; // 约 24°，防止极限近距吞没地平线地貌

interface StarVisualEntry {
  readonly role: 'star';
  readonly root: THREE.Group;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  readonly corona: THREE.Sprite;
  readonly coronaMaterial: THREE.SpriteMaterial;
  readonly light: THREE.PointLight;
  colorHex: string;
  emissiveIntensity: number;
  renderRadius: number;
  luminosity: number;
  baseLightIntensity: number;
}

interface PlanetVisualEntry {
  readonly role: 'planet';
  readonly root: THREE.Group;
  readonly spinPivot: THREE.Group;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  readonly atmosphereMesh: THREE.Mesh;
  readonly atmosphereMaterial: THREE.ShaderMaterial;
  colorHex: string;
  emissiveIntensity: number;
  renderRadius: number;
}

type BodyVisualEntry = StarVisualEntry | PlanetVisualEntry;

const PLANET_ATMO_VERT = /* glsl */ `
  varying vec3 vNormalWorld;
  varying vec3 vViewDirWorld;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vNormalWorld = normalize(mat3(modelMatrix) * normal);
    vViewDirWorld = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const PLANET_ATMO_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying vec3 vNormalWorld;
  varying vec3 vViewDirWorld;

  void main() {
    float ndotv = clamp(dot(normalize(vNormalWorld), normalize(vViewDirWorld)), 0.0, 1.0);
    float fresnel = pow(1.0 - ndotv, 2.6);
    vec3 col = min(uColor, vec3(0.48));
    gl_FragColor = vec4(col, fresnel * 0.58);
  }
`;

export class BodyVisuals {
  public readonly group: THREE.Group;

  private readonly entries = new Map<string, BodyVisualEntry>();
  private readonly sharedUnitSphere: THREE.SphereGeometry;
  private readonly coronaTexture: THREE.CanvasTexture | null;
  private readonly planetTexture: THREE.CanvasTexture | null;

  // 复用的临时向量与颜色，避免每帧 GC
  private readonly tmpRel = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();
  private readonly tmpPlanetPos = new THREE.Vector3();

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'CelestialBodyVisuals';

    this.sharedUnitSphere = new THREE.SphereGeometry(1, 36, 24);
    this.coronaTexture = createCoronaTexture();
    this.planetTexture = createPlanetSurfaceTexture();
  }

  /**
   * 同步天体集合：支持增删、碰撞合并、角色变更、改色/改半径/改发光强度，并干净释放被移除天体的 GPU 资源。
   */
  public syncBodies(bodies: readonly BodyState[]): void {
    const activeIds = new Set<string>();

    for (const body of bodies) {
      activeIds.add(body.id);
      const existing = this.entries.get(body.id);

      if (existing && existing.role !== body.role) {
        this.removeEntry(body.id, existing);
      }

      const current = this.entries.get(body.id);
      if (!current) {
        const created =
          body.role === 'star'
            ? this.createStarEntry(body)
            : this.createPlanetEntry(body);
        this.entries.set(body.id, created);
        this.group.add(created.root);
      } else {
        this.updateEntryAppearance(current, body);
      }
    }

    // 清理已删除或被碰撞合并吸收的天体
    for (const [id, entry] of this.entries) {
      if (!activeIds.has(id)) {
        this.removeEntry(id, entry);
      }
    }
  }

  /**
   * 每帧更新所有天体位置、尺度、行星自转以及近地模式下的相对坐标/飞星保底可视性。
   */
  public updatePositions(
    bodies: readonly BodyState[],
    originOffset: THREE.Vector3,
    isSurfaceMode: boolean,
    hiddenPlanetId: string | null,
    planetRotationAngle: number
  ): void {
    // 若太空模式中存在行星，记录其位置用于动态防止恒星极近距离将行星照爆过 Bloom 阈值
    let hasSpacePlanet = false;
    if (!isSurfaceMode) {
      for (const b of bodies) {
        if (b.role === 'planet') {
          this.tmpPlanetPos.set(
            b.position[0] - originOffset.x,
            b.position[1] - originOffset.y,
            b.position[2] - originOffset.z
          );
          hasSpacePlanet = true;
          break;
        }
      }
    }

    for (const body of bodies) {
      const entry = this.entries.get(body.id);
      if (!entry) continue;

      // 【跨层约定 #2】近地模式下隐藏行星自身球体 Mesh
      if (isSurfaceMode && body.id === hiddenPlanetId) {
        entry.root.visible = false;
        continue;
      }
      entry.root.visible = true;

      this.tmpRel.set(
        body.position[0] - originOffset.x,
        body.position[1] - originOffset.y,
        body.position[2] - originOffset.z
      );

      if (entry.role === 'star') {
        this.updateStarTransform(entry, body, isSurfaceMode, hasSpacePlanet);
      } else {
        this.updatePlanetTransform(entry, body, planetRotationAngle);
      }
    }
  }

  public hasMatchingIds(bodies: readonly BodyState[]): boolean {
    if (bodies.length !== this.entries.size) return false;
    for (const body of bodies) {
      const entry = this.entries.get(body.id);
      if (!entry || entry.role !== body.role) return false;
    }
    return true;
  }

  public dispose(): void {
    for (const [id, entry] of this.entries) {
      this.removeEntry(id, entry);
    }
    this.entries.clear();
    this.sharedUnitSphere.dispose();
    this.coronaTexture?.dispose();
    this.planetTexture?.dispose();
    this.group.clear();
  }

  private createStarEntry(body: BodyState): StarVisualEntry {
    const root = new THREE.Group();
    root.name = `Star_${body.id}`;

    const emissiveColor = new THREE.Color();
    const effectiveIntensity = computeStarEmissive(
      body.color,
      body.emissiveIntensity,
      emissiveColor
    );

    const material = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: emissiveColor,
      emissiveIntensity: effectiveIntensity,
      roughness: 1.0,
      metalness: 0.0,
    });

    const mesh = new THREE.Mesh(this.sharedUnitSphere, material);
    mesh.scale.setScalar(body.renderRadius);
    mesh.renderOrder = 0;
    root.add(mesh);

    const coronaColor = hexToClampedColor(body.color, 0.65);
    const coronaMaterial = new THREE.SpriteMaterial({
      map: this.coronaTexture,
      color: coronaColor,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      depthTest: true,
    });

    const corona = new THREE.Sprite(coronaMaterial);
    corona.scale.setScalar(body.renderRadius * 6.5);
    corona.renderOrder = 10;
    root.add(corona);

    const lightColor = hexToClampedColor(body.color, 0.92);
    const baseLightIntensity = this.computeStarLightIntensity(body.luminosity);
    const light = new THREE.PointLight(lightColor, baseLightIntensity, 0, 1.4);
    root.add(light);

    root.position.set(body.position[0], body.position[1], body.position[2]);

    return {
      role: 'star',
      root,
      mesh,
      material,
      corona,
      coronaMaterial,
      light,
      colorHex: body.color,
      emissiveIntensity: body.emissiveIntensity,
      renderRadius: body.renderRadius,
      luminosity: body.luminosity,
      baseLightIntensity,
    };
  }

  private createPlanetEntry(body: BodyState): PlanetVisualEntry {
    const root = new THREE.Group();
    root.name = `Planet_${body.id}`;

    // 内层旋转枢轴：绕世界 Z 轴自转，SphereGeometry 极轴从 Y 旋至 Z 对齐北极
    const spinPivot = new THREE.Group();
    root.add(spinPivot);

    const diffuseColor = hexToClampedColor(body.color, 0.64);
    const emissiveColor = hexToClampedColor(body.color, 0.28);
    const safeEmissiveIntensity = Math.max(
      0,
      Math.min(body.emissiveIntensity, 0.38)
    );

    const material = new THREE.MeshStandardMaterial({
      map: this.planetTexture,
      color: diffuseColor,
      emissive: emissiveColor,
      emissiveIntensity: safeEmissiveIntensity,
      roughness: 0.78,
      metalness: 0.06,
    });

    const mesh = new THREE.Mesh(this.sharedUnitSphere, material);
    mesh.rotation.x = Math.PI * 0.5;
    mesh.scale.setScalar(body.renderRadius);
    mesh.renderOrder = 1;
    spinPivot.add(mesh);

    const atmoColor = hexToClampedColor(body.color, 0.48);
    const atmosphereMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: atmoColor },
      },
      vertexShader: PLANET_ATMO_VERT,
      fragmentShader: PLANET_ATMO_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });

    const atmosphereMesh = new THREE.Mesh(
      this.sharedUnitSphere,
      atmosphereMaterial
    );
    atmosphereMesh.scale.setScalar(body.renderRadius * 1.15);
    atmosphereMesh.renderOrder = 3;
    root.add(atmosphereMesh);

    root.position.set(body.position[0], body.position[1], body.position[2]);

    return {
      role: 'planet',
      root,
      spinPivot,
      mesh,
      material,
      atmosphereMesh,
      atmosphereMaterial,
      colorHex: body.color,
      emissiveIntensity: body.emissiveIntensity,
      renderRadius: body.renderRadius,
    };
  }

  private updateEntryAppearance(
    entry: BodyVisualEntry,
    body: BodyState
  ): void {
    if (entry.role === 'star') {
      if (
        entry.colorHex !== body.color ||
        entry.emissiveIntensity !== body.emissiveIntensity
      ) {
        const effective = computeStarEmissive(
          body.color,
          body.emissiveIntensity,
          this.tmpColor
        );
        entry.material.emissive.copy(this.tmpColor);
        entry.material.emissiveIntensity = effective;

        hexToClampedColor(body.color, 0.65, entry.coronaMaterial.color);
        hexToClampedColor(body.color, 0.92, entry.light.color);

        entry.colorHex = body.color;
        entry.emissiveIntensity = body.emissiveIntensity;
      }
      if (entry.luminosity !== body.luminosity) {
        entry.luminosity = body.luminosity;
        entry.baseLightIntensity = this.computeStarLightIntensity(
          body.luminosity
        );
        entry.light.intensity = entry.baseLightIntensity;
      }
      entry.renderRadius = body.renderRadius;
    } else {
      if (
        entry.colorHex !== body.color ||
        entry.emissiveIntensity !== body.emissiveIntensity
      ) {
        hexToClampedColor(body.color, 0.64, entry.material.color);
        hexToClampedColor(body.color, 0.28, entry.material.emissive);
        entry.material.emissiveIntensity = Math.max(
          0,
          Math.min(body.emissiveIntensity, 0.38)
        );
        const atmoUniform = entry.atmosphereMaterial.uniforms['uColor'];
        if (atmoUniform && atmoUniform.value instanceof THREE.Color) {
          hexToClampedColor(body.color, 0.48, atmoUniform.value);
        }
        entry.colorHex = body.color;
        entry.emissiveIntensity = body.emissiveIntensity;
      }
      entry.renderRadius = body.renderRadius;
    }
  }

  private updateStarTransform(
    entry: StarVisualEntry,
    body: BodyState,
    isSurfaceMode: boolean,
    hasSpacePlanet: boolean
  ): void {
    if (!isSurfaceMode) {
      entry.root.position.copy(this.tmpRel);
      const r = Math.max(body.renderRadius, 0.005);
      entry.mesh.scale.setScalar(r);
      entry.corona.scale.setScalar(r * 6.5);
      entry.coronaMaterial.opacity = 0.62;
      entry.light.visible = true;

      // 防止恒星贴近行星时点光源衰减发散导致行星局部超阈值 Bloom
      if (hasSpacePlanet) {
        const distSq = Math.max(
          0.02,
          this.tmpRel.distanceToSquared(this.tmpPlanetPos)
        );
        const maxSafeIntensity = Math.min(
          entry.baseLightIntensity,
          1.35 * Math.pow(distSq, 0.7)
        );
        entry.light.intensity = maxSafeIntensity;
      } else {
        entry.light.intensity = entry.baseLightIntensity;
      }
      return;
    }

    // 近地模式：行星在原点，关闭点光源以保持天空/地貌着色完全由热力学着色器控制
    entry.light.visible = false;

    const trueDist = this.tmpRel.length();
    if (trueDist < 1e-6) {
      entry.root.visible = false;
      return;
    }
    this.tmpDir.copy(this.tmpRel).divideScalar(trueDist);

    // 保持精确方向角，将渲染距离限制在天空穹顶（R=500）之内
    let renderDist = Math.min(trueDist, MAX_SURFACE_STAR_DIST);
    const trueAngRad = Math.atan2(
      Math.max(body.renderRadius, 0.005),
      Math.max(trueDist, 0.01)
    );
    const isFlyingStar = trueAngRad < FLYING_STAR_MIN_ANG_RAD * 1.6;
    const clampedAngRad = Math.max(
      FLYING_STAR_MIN_ANG_RAD,
      Math.min(CLOSE_STAR_MAX_ANG_RAD, trueAngRad)
    );

    let visRadius = renderDist * Math.tan(clampedAngRad);

    // 极端近距保护：确保恒星球面位于地貌球壳（R=0.04）之外，同时维持精确视张角与方位
    if (renderDist - visRadius < MIN_TERRAIN_CLEARANCE) {
      const denom = Math.max(0.25, 1.0 - Math.tan(clampedAngRad));
      renderDist = MIN_TERRAIN_CLEARANCE / denom;
      visRadius = renderDist * Math.tan(clampedAngRad);
    }

    entry.root.position.copy(this.tmpDir).multiplyScalar(renderDist);
    entry.mesh.scale.setScalar(visRadius);

    // 远距“飞星”略微增强星芒比例，便于在夜空中识别；近距大日保持克制柔和日冕
    const coronaScaleMult = isFlyingStar ? 9.5 : 5.2;
    entry.corona.scale.setScalar(visRadius * coronaScaleMult);
    entry.coronaMaterial.opacity = isFlyingStar ? 0.78 : 0.56;
  }

  private updatePlanetTransform(
    entry: PlanetVisualEntry,
    body: BodyState,
    rotationAngle: number
  ): void {
    entry.root.position.copy(this.tmpRel);
    const r = Math.max(body.renderRadius, 0.004);
    entry.mesh.scale.setScalar(r);
    entry.atmosphereMesh.scale.setScalar(r * 1.15);
    entry.spinPivot.rotation.z = rotationAngle;
  }

  private computeStarLightIntensity(luminosity: number): number {
    const lum = Math.max(0.2, luminosity > 0 ? luminosity : 1.0);
    return Math.min(3.2, 1.45 * Math.pow(lum, 0.35));
  }

  private removeEntry(id: string, entry: BodyVisualEntry): void {
    this.group.remove(entry.root);
    if (entry.role === 'star') {
      entry.material.dispose();
      entry.coronaMaterial.dispose();
      entry.light.dispose();
    } else {
      entry.material.dispose();
      entry.atmosphereMaterial.dispose();
    }
    this.entries.delete(id);
  }
}

export type { BodyRole };
