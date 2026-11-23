import React from 'react';
import {
  Activity,
  AlertTriangle,
  Camera,
  ChevronLeft,
  ChevronRight,
  Compass,
  Crosshair,
  Eraser,
  Eye,
  Flame,
  Globe,
  Layers,
  RotateCcw,
  Snowflake,
  Sparkles,
  Sun,
} from 'lucide-react';
import type {
  CameraMode,
  HudSnapshot,
  SimulationActions,
} from '../types/contracts';
import { EnergyDriftChart } from './charts/EnergyDriftChart';
import { TemperatureChart } from './charts/TemperatureChart';
import { PanelSection, SciFiSlider, ToggleSwitch } from './components/HudPrimitives';
import {
  formatElevationDeg,
  formatFixed,
  formatSci,
  formatSigned,
  formatSimTime,
  formatStrictSci,
  formatTempC,
  getAstroEventTheme,
  getDriftToneClass,
  getEraTheme,
  getTempToneClass,
} from './formatters';

export interface TelemetryPanelProps {
  readonly snapshot: HudSnapshot;
  readonly actions: SimulationActions;
  readonly collapsed: boolean;
  readonly onToggleCollapse: () => void;
}

const CAMERA_MODES: ReadonlyArray<{
  readonly mode: CameraMode;
  readonly label: string;
  readonly requiresPlanet?: boolean;
}> = [
  { mode: 'free', label: '自由视角' },
  { mode: 'com', label: '锁定质心' },
  { mode: 'follow', label: '跟随天体' },
  { mode: 'planet-surface', label: '三体行星近地视角', requiresPlanet: true },
];

/**
 * 可折叠右侧仪表盘与视角栏
 * - 相机视角控制（4 模式切换、跟随目标、重置构图、行星自转速度）
 * - 3D 视觉与辅助显示（轨迹、速度/引力矢量、质心标记、参考网格、Bloom 辉光）
 * - 物理守恒监控（机械能、动势能、角动量、相对漂移、步长、最小间距 + Canvas 曲线）
 * - 三体行星纪元监控（恒/乱纪元徽章、特征天文事件、温度与天空恒星观测 + Canvas 曲线）
 */
export const TelemetryPanel: React.FC<TelemetryPanelProps> = ({
  snapshot,
  actions,
  collapsed,
  onToggleCollapse,
}) => {
  const {
    bodies,
    cameraState,
    visualOptions,
    metrics,
    config,
    planetTelemetry,
    lastStepSize,
    minPairDistance,
    energyHistory,
    collisionEvents,
    temperatureHistory,
  } = snapshot;

  const planetBody = bodies.find((b) => b.role === 'planet') ?? null;
  const hasPlanet = planetBody !== null;

  const handleSelectCameraMode = (mode: CameraMode) => {
    if (mode === 'planet-surface') {
      if (!planetBody) return;
      actions.setCameraMode('planet-surface', planetBody.id);
      return;
    }
    if (mode === 'follow') {
      const validTarget =
        bodies.find((b) => b.id === cameraState.targetBodyId)?.id ??
        bodies[0]?.id ??
        null;
      actions.setCameraMode('follow', validTarget);
      return;
    }
    actions.setCameraMode(mode, null);
  };

  const eraTheme = planetTelemetry ? getEraTheme(planetTelemetry.eraStatus) : null;
  const eventTheme = planetTelemetry
    ? getAstroEventTheme(
        planetTelemetry.eraStatus.event,
        planetTelemetry.eraStatus.eventLabel
      )
    : null;

  const hasCollisionLoss =
    metrics.cumulativeEnergyLoss > 0 || collisionEvents.length > 0;
  const closeEncounterWarn = Number.isFinite(minPairDistance) && minPairDistance < 0.15;

  return (
    <div className="pointer-events-none fixed bottom-[78px] right-3 top-[66px] z-20">
      {/* 面板主体（平滑滑入/滑出） */}
      <aside
        aria-hidden={collapsed}
        className={`flex h-full w-[348px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-2xl border border-cyan-500/20 bg-slate-950/75 shadow-[0_12px_42px_rgba(0,0,0,0.55)] backdrop-blur-md transition-all duration-300 ease-out ${
          collapsed
            ? 'pointer-events-none translate-x-[calc(100%+24px)] opacity-0'
            : 'pointer-events-auto translate-x-0 opacity-100'
        }`}
      >
        {/* 栏头 */}
        <div className="flex shrink-0 items-center justify-between border-b border-cyan-500/15 bg-slate-900/50 px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-cyan-400" />
            <span className="text-xs font-semibold tracking-wider text-slate-100">
              视景视角与物理遥测
            </span>
          </div>
          <button
            type="button"
            onClick={onToggleCollapse}
            title="折叠右侧仪表盘"
            className="inline-flex items-center gap-0.5 rounded-lg border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-[11px] text-slate-300 transition-colors hover:border-cyan-500/40 hover:text-cyan-200"
          >
            <span>收起</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* 滚动内容区 */}
        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          {/* 1. 相机视角控制 */}
          <PanelSection
            title="相机视角控制"
            icon={<Camera className="h-3.5 w-3.5" />}
          >
            <div className="grid grid-cols-2 gap-1.5">
              {CAMERA_MODES.map(({ mode, label, requiresPlanet }) => {
                const disabled = Boolean(requiresPlanet && !hasPlanet);
                const active = cameraState.mode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    disabled={disabled}
                    title={
                      disabled
                        ? '当前场景无三体行星，请先添加行星或切换“混沌三体 + 三体行星”预设'
                        : label
                    }
                    onClick={() => handleSelectCameraMode(mode)}
                    className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-[11px] font-medium transition-all ${
                      disabled
                        ? 'cursor-not-allowed border-slate-800/80 bg-slate-900/40 text-slate-600'
                        : active
                          ? 'border-cyan-400/65 bg-cyan-500/20 text-cyan-100 shadow-[0_0_14px_rgba(34,211,238,0.16)]'
                          : 'border-slate-800 bg-slate-950/60 text-slate-300 hover:border-cyan-500/35 hover:text-cyan-100'
                    }`}
                  >
                    {mode === 'free' && <Compass className="h-3.5 w-3.5 shrink-0" />}
                    {mode === 'com' && <Crosshair className="h-3.5 w-3.5 shrink-0" />}
                    {mode === 'follow' && <Eye className="h-3.5 w-3.5 shrink-0" />}
                    {mode === 'planet-surface' && (
                      <Globe className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="truncate">{label}</span>
                  </button>
                );
              })}
            </div>

            {!hasPlanet && (
              <p className="rounded-lg border border-slate-800/80 bg-slate-950/55 px-2.5 py-1.5 text-[10px] leading-relaxed text-slate-400">
                提示：当前场景无三体行星，近地视角不可用。可在左侧点击“添加三体行星”或载入“混沌三体 + 三体行星”预设。
              </p>
            )}

            {/* 跟随天体目标选择器 */}
            {cameraState.mode === 'follow' && (
              <label className="block space-y-1">
                <span className="text-[10px] text-slate-400">跟随目标天体</span>
                <select
                  value={cameraState.targetBodyId ?? bodies[0]?.id ?? ''}
                  onChange={(e) => actions.setCameraMode('follow', e.target.value)}
                  className="w-full rounded-lg border border-cyan-500/35 bg-slate-950/85 px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-cyan-400"
                >
                  {bodies.map((b) => (
                    <option key={b.id} value={b.id} className="bg-slate-950 text-slate-100">
                      [{b.role === 'planet' ? '行星' : '恒星'}] {b.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {/* 行星自转速度滑块（存在行星时显示） */}
            {hasPlanet && (
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-950/15 p-2.5">
                <SciFiSlider
                  label="行星自转角速度"
                  value={config.planetRotationRate}
                  min={0}
                  max={Math.max(5, config.planetRotationRate)}
                  step={0.05}
                  displayValue={`${config.planetRotationRate.toFixed(2)} rad/T`}
                  hint="在三体行星近地视角下调节昼夜交替与三日升落速率"
                  onChange={actions.setPlanetRotationRate}
                />
              </div>
            )}

            {/* 重置构图 */}
            <button
              type="button"
              onClick={actions.resetCameraView}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-cyan-500/45 hover:bg-slate-800/80 hover:text-cyan-200"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              重置构图
            </button>
          </PanelSection>

          {/* 2. 3D 视觉与辅助显示 */}
          <PanelSection
            title="3D 视觉与辅助显示"
            icon={<Layers className="h-3.5 w-3.5" />}
          >
            {/* 轨迹拖尾 + 长度滑块 + 清空按钮 */}
            <div className="space-y-2 rounded-lg border border-slate-800/80 bg-slate-950/45 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={visualOptions.showTrails}
                  onClick={() =>
                    actions.updateVisualOptions({ showTrails: !visualOptions.showTrails })
                  }
                  className="flex flex-1 items-center justify-between text-left"
                >
                  <span className="text-xs font-medium text-slate-200">轨道轨迹拖尾</span>
                  <span
                    className={`relative inline-flex items-center rounded-full border transition-colors ${
                      visualOptions.showTrails
                        ? 'border-cyan-400/70 bg-cyan-500/40'
                        : 'border-slate-700 bg-slate-800'
                    }`}
                    style={{ height: '18px', width: '32px' }}
                  >
                    <span
                      className={`inline-block h-3 w-3 rounded-full transition-transform ${
                        visualOptions.showTrails
                          ? 'translate-x-[15px] bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.85)]'
                          : 'translate-x-[2px] bg-slate-400'
                      }`}
                    />
                  </span>
                </button>
              </div>

              <SciFiSlider
                label="轨迹采样点数"
                value={visualOptions.trailLength}
                min={100}
                max={2000}
                step={50}
                disabled={!visualOptions.showTrails}
                displayValue={`${visualOptions.trailLength} 点`}
                actionSlot={
                  <button
                    type="button"
                    onClick={actions.clearTrails}
                    title="清空当前已绘制的所有轨道拖尾"
                    className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900/90 px-1.5 py-0.5 text-[10px] text-slate-300 transition-colors hover:border-cyan-500/45 hover:text-cyan-200"
                  >
                    <Eraser className="h-2.5 w-2.5" />
                    清空
                  </button>
                }
                onChange={(val) => actions.updateVisualOptions({ trailLength: val })}
              />
            </div>

            {/* 矢量与辅助标记 */}
            <div className="grid grid-cols-2 gap-1.5">
              <ToggleSwitch
                label="速度矢量"
                checked={visualOptions.showVelocityVectors}
                onChange={(val) =>
                  actions.updateVisualOptions({ showVelocityVectors: val })
                }
              />
              <ToggleSwitch
                label="引力矢量"
                checked={visualOptions.showForceVectors}
                onChange={(val) =>
                  actions.updateVisualOptions({ showForceVectors: val })
                }
              />
              <ToggleSwitch
                label="质心标记"
                checked={visualOptions.showCenterOfMass}
                onChange={(val) =>
                  actions.updateVisualOptions({ showCenterOfMass: val })
                }
              />
              <ToggleSwitch
                label="XY 参考网格"
                checked={visualOptions.showReferenceGrid}
                onChange={(val) =>
                  actions.updateVisualOptions({ showReferenceGrid: val })
                }
              />
            </div>

            {/* 恒星 Bloom 辉光开关 + 强度滑块 */}
            <div className="space-y-2 rounded-lg border border-slate-800/80 bg-slate-950/45 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={visualOptions.enableBloom}
                  onClick={() =>
                    actions.updateVisualOptions({ enableBloom: !visualOptions.enableBloom })
                  }
                  className="flex flex-1 items-center justify-between text-left"
                >
                  <span className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
                    <Sparkles className="h-3.5 w-3.5 text-amber-300" />
                    恒星 HDR 选择性辉光
                  </span>
                  <span
                    className={`relative inline-flex items-center rounded-full border transition-colors ${
                      visualOptions.enableBloom
                        ? 'border-cyan-400/70 bg-cyan-500/40'
                        : 'border-slate-700 bg-slate-800'
                    }`}
                    style={{ height: '18px', width: '32px' }}
                  >
                    <span
                      className={`inline-block h-3 w-3 rounded-full transition-transform ${
                        visualOptions.enableBloom
                          ? 'translate-x-[15px] bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.85)]'
                          : 'translate-x-[2px] bg-slate-400'
                      }`}
                    />
                  </span>
                </button>
              </div>

              <SciFiSlider
                label="辉光强度 (Bloom)"
                value={visualOptions.bloomStrength}
                min={0}
                max={2}
                step={0.05}
                disabled={!visualOptions.enableBloom}
                displayValue={visualOptions.bloomStrength.toFixed(2)}
                onChange={(val) => actions.updateVisualOptions({ bloomStrength: val })}
              />
            </div>
          </PanelSection>

          {/* 3. 物理守恒监控 */}
          <PanelSection
            title="物理守恒监控"
            icon={<Activity className="h-3.5 w-3.5" />}
            badge={
              <span
                className={`rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${getDriftToneClass(
                  metrics.relativeDrift
                )} bg-slate-950/70`}
              >
                {formatStrictSci(Math.abs(metrics.relativeDrift), 1)}
              </span>
            }
          >
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-lg border border-slate-800/80 bg-slate-950/60 px-2.5 py-1.5">
                <div className="text-[10px] text-slate-400">总机械能 E</div>
                <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-slate-100">
                  {formatSigned(metrics.total, 5)}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800/80 bg-slate-950/60 px-2.5 py-1.5">
                <div className="text-[10px] text-slate-400">相对漂移 |ΔE/E₀|</div>
                <div
                  className={`mt-0.5 font-mono text-xs font-semibold tabular-nums ${getDriftToneClass(
                    metrics.relativeDrift
                  )}`}
                >
                  {formatStrictSci(Math.abs(metrics.relativeDrift), 2)}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800/80 bg-slate-950/60 px-2.5 py-1.5">
                <div className="text-[10px] text-slate-400">动能 K</div>
                <div className="mt-0.5 font-mono text-xs tabular-nums text-cyan-200">
                  {formatFixed(metrics.kinetic, 5)}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800/80 bg-slate-950/60 px-2.5 py-1.5">
                <div className="text-[10px] text-slate-400">引力势能 U</div>
                <div className="mt-0.5 font-mono text-xs tabular-nums text-indigo-200">
                  {formatSigned(metrics.potential, 5)}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800/80 bg-slate-950/60 px-2.5 py-1.5">
                <div className="text-[10px] text-slate-400">角动量模长 |L|</div>
                <div className="mt-0.5 font-mono text-xs tabular-nums text-slate-200">
                  {formatFixed(metrics.angularMomentumMag, 5)}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800/80 bg-slate-950/60 px-2.5 py-1.5">
                <div className="text-[10px] text-slate-400">当前积分步长 h</div>
                <div className="mt-0.5 font-mono text-xs tabular-nums text-slate-200">
                  {formatStrictSci(lastStepSize, 2)}
                </div>
              </div>

              <div
                className={`rounded-lg border px-2.5 py-1.5 ${
                  hasCollisionLoss ? 'col-span-1' : 'col-span-2'
                } ${
                  closeEncounterWarn
                    ? 'border-amber-500/45 bg-amber-950/25'
                    : 'border-slate-800/80 bg-slate-950/60'
                }`}
              >
                <div className="text-[10px] text-slate-400">最小天体间距 r_min</div>
                <div
                  className={`mt-0.5 font-mono text-xs tabular-nums ${
                    closeEncounterWarn ? 'font-semibold text-amber-300' : 'text-slate-200'
                  }`}
                >
                  {Number.isFinite(minPairDistance) ? formatSci(minPairDistance, 3) : '—'}
                </div>
              </div>

              {hasCollisionLoss && (
                <div className="rounded-lg border border-amber-500/35 bg-amber-950/20 px-2.5 py-1.5">
                  <div className="text-[10px] text-amber-300/85">碰撞损耗能 ΔE_loss</div>
                  <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-amber-300">
                    {formatSci(metrics.cumulativeEnergyLoss, 3)}
                  </div>
                </div>
              )}
            </div>

            <EnergyDriftChart
              history={energyHistory}
              collisionEvents={collisionEvents}
            />
          </PanelSection>

          {/* 4. 三体行星纪元监控（存在行星遥测时展示） */}
          {planetTelemetry !== null && eraTheme !== null && (
            <PanelSection
              title="三体行星纪元监控"
              icon={<Globe className="h-3.5 w-3.5 text-emerald-400" />}
              accentBorder={
                planetTelemetry.eraStatus.era === 'stable'
                  ? 'border-emerald-500/30'
                  : 'border-amber-500/30'
              }
              badge={
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                    planetTelemetry.eraStatus.era === 'stable'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-rose-500/20 text-rose-300'
                  }`}
                >
                  {eraTheme.badgeTitle}
                </span>
              }
            >
              {/* 恒纪元 / 乱纪元 主状态徽章 */}
              <div className={`rounded-xl border p-3 ${eraTheme.containerClass}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${eraTheme.dotClass}`} />
                    <span className={`text-base font-bold tracking-wider ${eraTheme.titleClass}`}>
                      {eraTheme.badgeTitle}
                    </span>
                  </div>
                  <span className="rounded-md bg-slate-950/55 px-2 py-0.5 text-[11px] font-medium text-slate-100">
                    {eraTheme.subLabel}
                  </span>
                </div>

                <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-white/10 pt-2 font-mono text-[11px] tabular-nums">
                  <div>
                    <span className="block font-sans text-[10px] text-slate-300/75">
                      当前纪元持续
                    </span>
                    <span className="text-slate-100">
                      T = {formatSimTime(planetTelemetry.eraStatus.eraDuration)}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="block font-sans text-[10px] text-slate-300/75">
                      最长恒纪元记录
                    </span>
                    <span className="text-emerald-300">
                      T = {formatSimTime(planetTelemetry.eraStatus.longestStableDuration)}
                    </span>
                  </div>
                </div>
              </div>

              {/* 原著特征天文事件徽章 */}
              {eventTheme !== null && (
                <div
                  className={`flex items-start gap-2 rounded-xl border px-3 py-2 ${eventTheme.badgeClass}`}
                >
                  <div className="mt-0.5 shrink-0">
                    {planetTelemetry.eraStatus.event === 'tri-solar-day' ? (
                      <Flame className="h-4 w-4" />
                    ) : planetTelemetry.eraStatus.event === 'flying-stars' ? (
                      <Snowflake className="h-4 w-4" />
                    ) : planetTelemetry.eraStatus.event === 'bi-solar-glare' ? (
                      <AlertTriangle className="h-4 w-4" />
                    ) : (
                      <Sun className="h-4 w-4" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-bold tracking-wide">
                      天象警报：{eventTheme.label}
                    </div>
                    <p className="mt-0.5 text-[10px] opacity-90">
                      {eventTheme.description}
                    </p>
                  </div>
                </div>
              )}

              {/* 热力学核心读数 */}
              <div className="grid grid-cols-2 gap-1.5">
                <div className="rounded-lg border border-slate-800/80 bg-slate-950/60 px-2.5 py-1.5">
                  <div className="text-[10px] text-slate-400">实时表面温度</div>
                  <div
                    className={`mt-0.5 font-mono text-sm font-bold tabular-nums ${getTempToneClass(
                      planetTelemetry.temperatureC
                    )}`}
                  >
                    {formatTempC(planetTelemetry.temperatureC, 1)}
                  </div>
                </div>

                <div className="rounded-lg border border-slate-800/80 bg-slate-950/60 px-2.5 py-1.5">
                  <div className="text-[10px] text-slate-400">辐射平衡温度</div>
                  <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-slate-200">
                    {formatTempC(planetTelemetry.equilibriumTempC, 1)}
                  </div>
                </div>

                <div className="rounded-lg border border-slate-800/80 bg-slate-950/60 px-2.5 py-1.5">
                  <div className="text-[10px] text-slate-400">温变率 dT/dt</div>
                  <div
                    className={`mt-0.5 font-mono text-xs tabular-nums ${
                      planetTelemetry.tempRateCPerSimTime > 15
                        ? 'text-rose-300'
                        : planetTelemetry.tempRateCPerSimTime < -15
                          ? 'text-sky-300'
                          : 'text-slate-200'
                    }`}
                  >
                    {formatSigned(planetTelemetry.tempRateCPerSimTime, 2)} °C/T
                  </div>
                </div>

                <div className="rounded-lg border border-slate-800/80 bg-slate-950/60 px-2.5 py-1.5">
                  <div className="text-[10px] text-slate-400">地平线以上太阳</div>
                  <div className="mt-0.5 flex items-center justify-between font-mono text-xs tabular-nums text-amber-200">
                    <span>
                      {planetTelemetry.visibleSunCount} /{' '}
                      {planetTelemetry.skyObservations.length} 颗
                    </span>
                    <span className="flex items-center gap-0.5">
                      {planetTelemetry.skyObservations.map((obs) => (
                        <span
                          key={obs.starId}
                          title={`${obs.starName}: ${obs.isAboveHorizon ? '地平线上' : '地平线下'}`}
                          className={`h-2 w-2 rounded-full transition-opacity ${
                            obs.isAboveHorizon ? 'opacity-100' : 'opacity-25'
                          }`}
                          style={{ backgroundColor: obs.color }}
                        />
                      ))}
                    </span>
                  </div>
                </div>
              </div>

              {/* 紧凑天空恒星观测列表 */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[10px] text-slate-400">
                  <span>天空恒星实时观测</span>
                  <span>距离 / 仰角 / 状态</span>
                </div>
                <div className="space-y-1">
                  {planetTelemetry.skyObservations.map((obs) => (
                    <div
                      key={obs.starId}
                      className={`flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-[11px] ${
                        obs.isAboveHorizon
                          ? 'border-slate-700/80 bg-slate-950/70'
                          : 'border-slate-800/60 bg-slate-950/35 opacity-70'
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{
                            backgroundColor: obs.color,
                            boxShadow: obs.isAboveHorizon
                              ? `0 0 8px ${obs.color}`
                              : 'none',
                          }}
                        />
                        <span className="truncate font-medium text-slate-200">
                          {obs.starName}
                        </span>
                        {obs.isFlyingStar && (
                          <span className="shrink-0 rounded border border-indigo-400/50 bg-indigo-500/20 px-1 py-[1px] text-[9px] font-medium text-indigo-200">
                            飞星
                          </span>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] tabular-nums">
                        <span className="text-slate-300" title="恒星距离 (AU)">
                          {formatFixed(obs.distance, 2)} AU
                        </span>
                        <span
                          className={
                            obs.isAboveHorizon ? 'text-amber-300' : 'text-slate-500'
                          }
                          title="本地仰角"
                        >
                          {formatElevationDeg(obs.elevationRad)}
                        </span>
                        <span
                          className={`rounded px-1 py-0.5 font-sans text-[9px] ${
                            obs.isAboveHorizon
                              ? 'bg-amber-500/15 text-amber-200'
                              : 'bg-slate-800/90 text-slate-400'
                          }`}
                        >
                          {obs.isAboveHorizon ? '地平线上' : '地平线下'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 行星温度曲线图 */}
              <TemperatureChart history={temperatureHistory} />
            </PanelSection>
          )}
        </div>
      </aside>

      {/* 折叠状态下的边缘展开按钮 */}
      {collapsed && (
        <button
          type="button"
          onClick={onToggleCollapse}
          title="展开仪表盘与视角面板"
          className="pointer-events-auto absolute right-0 top-0 flex items-center gap-1.5 rounded-xl border border-cyan-500/30 bg-slate-950/80 px-2.5 py-2.5 text-xs font-medium text-cyan-200 shadow-[0_8px_28px_rgba(0,0,0,0.5)] backdrop-blur-md transition-all hover:border-cyan-400/60 hover:bg-slate-900/90"
        >
          <ChevronLeft className="h-3.5 w-3.5 text-cyan-400" />
          <span className="[writing-mode:vertical-rl] tracking-widest">遥测视景</span>
          <Activity className="h-4 w-4 text-cyan-400" />
        </button>
      )}
    </div>
  );
};
