/**
 * `src/physics/` 统一出口 — 导出 PhysicsEngine 与全部核心物理纯函数及常数
 */

export { PhysicsEngine, type StepOptions } from './PhysicsEngine';

export {
  computeAccelerationsFlat,
  computeGravityForBodies,
  computeLuminosity,
  computeMinPairDistance,
  computeMinStarPairDistance,
  type GravityResult,
} from './gravity';

export {
  DEFAULT_DOPRI_INITIAL_DT,
  H_MAX,
  H_MIN,
  MAX_SUBSTEPS_PER_FRAME,
  createIntegratorWorkspace,
  ensureWorkspaceCapacity,
  integrateBodies,
  integrateFlatDopri54,
  integrateFlatVerlet,
  invalidateWorkspaceCache,
  packBodiesToWorkspace,
  unpackWorkspaceToBodies,
  type AcceptedSubstepHook,
  type Dopri54FlatOptions,
  type FlatIntegrationResult,
  type IntegrateBodiesOptions,
  type IntegrateBodiesResult,
  type IntegratorWorkspace,
  type VerletFlatOptions,
} from './integrators';

export {
  hasAnyCollisionFlat,
  mergePair,
  resolveCollisions,
  type CollisionResolutionResult,
} from './collisions';

export {
  computeEnergyMetrics,
  normalizeCenterOfMass,
} from './diagnostics';

export {
  ERA_WINDOW_DURATION,
  FLYING_STAR_MAX_ANGULAR_DIAMETER,
  FLYING_STAR_MIN_DISTANCE,
  KELVIN_OFFSET,
  MAX_PLANET_TEMP_K,
  MIN_PLANET_TEMP_K,
  PlanetThermodynamicsTracker,
  RADIATION_SOFTENING,
  REFERENCE_EQUILIBRIUM_TEMP_K,
  REFERENCE_FLUX,
  STABLE_TEMP_RATE_THRESHOLD,
  THERMAL_ALPHA,
  THERMAL_BETA,
  computeObserverBasis,
  computeRadiativeFlux,
  computeSkyObservations,
  computeTempRate,
  detectAstronomicalEvent,
  stepPlanetTemperature,
  type FluxEvaluation,
  type ObserverBasis,
} from './thermodynamics';
