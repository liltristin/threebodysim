/**
 * Three.js 3D 渲染引擎统一导出入口（严格无 React 与物理内核耦合）
 */

export { SceneRenderer } from './SceneRenderer';
export { BodyVisuals } from './BodyVisuals';
export { Starfield } from './Starfield';
export { SurfaceDome } from './SurfaceDome';
export { TrailSystem, MAX_TRAIL_CAPACITY } from './TrailSystem';
export { VectorHelpers } from './VectorHelpers';
export {
  clampLinearColor,
  computeEquatorialBasisMatrix,
  computeForceHeatColor,
  computeStarEmissive,
  hexToClampedColor,
} from './colorUtils';
