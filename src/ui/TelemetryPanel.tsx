import React from 'react';
import {
  Activity,
  AlertTriangle,
  Camera,
  ChevronLeft,
  ChevronRight,
  Eraser,
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
import {
  PanelSection,
  SciFiSlider,
  SegmentedControl,
  ToggleSwitch,
} from './components/HudPrimitives';
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

export interface TelemetryPanelContentProps {
  readonly snapshot: HudSnapshot;
  readonly actions: SimulationActions;
  /** 控制内部两张 <canvas> 图表是否处于活跃绘制态 */
  readonly chartsActive: boolean;
  /** 移动端 Bottom Sheet 模式：触控热区 >= 40px */
  readonly touchFriendly?: boolean;
}

/**
 * 遥测与视角面板可复用内容主体（同时用于桌面右侧栏与移动端 Bottom Sheet 遥测页）
 */
export const TelemetryPanelContent: React.FC<TelemetryPanelContentProps> = ({
  snapshot,
  actions,
  chartsActive,
  touchFriendly = false,
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
  const isPerformanceMode = visualOptions.qualityMode === 'performance';

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

  const cameraOptions = [
    { value: 'free' as const, label: '自由' },
    { value: 'com' as const, label: '质心' },
    { value: 'follow' as const, label: '跟随' },
    {
      value: 'planet-surface' as const,
      label: '近地',
      disabled: !hasPlanet,
      title: hasPlanet
        ? '三体行星近地视角'
        : '当前场景无三体行星，请先添加行星或切换三体预设',
    },
  ];

  const eraTheme = planetTelemetry ? getEraTheme(planetTelemetry.eraStatus) : null;
  const eventTheme = planetTelemetry
    ? getAstroEventTheme(
        planetTelemetry.eraStatus.event,
        planetTelemetry.eraStatus.eventLabel
      )
    : null;

  const hasCollisionLoss =
    metrics.cumulativeEnergyLoss > 0 || collisionEvents.length > 0;
  const closeEncounterWarn =
    Number.isFinite(minPairDistance) && minPairDistance < 0.15;

  return (
    <div className="space-y-2.5">
      {/* 1. 相机视角控制 */}
      <PanelSection
        title="相机视角控制"
        icon={<Camera className="h-3.5 w-3.5" />}
        touchFriendly={touchFriendly}
      >
        <SegmentedControl
          value={cameraState.mode}
          options={cameraOptions}
          touchFriendly={touchFriendly}
          onChange={handleSelectCameraMode}
        />

        {!hasPlanet && (
          <p className="text-[10px] leading-relaxed text-slate-500">
            提示：无三体行星时禁用近地视角，可在顶部预设切换至“混沌三体 + 三体行星”或手动添加行星。
          </p>
        )}

        {cameraState.mode === 'follow' && (
          <label className="block space-y-1">
            <span className="text-[10px] text-slate-400">跟随目标天体</span>
            <select
              value={cameraState.targetBodyId ?? bodies[0]?.id ?? ''}
              onChange={(e) => actions.setCameraMode('follow', e.target.value)}
              className={`w-full rounded-lg border border-white/[0.12] bg-black/50 px-2.5 text-xs text-white outline-none focus:border-sky-400/60 ${
                touchFriendly ? 'min-h-[42px]' : 'py-1.5'
              }`}
            >
              {bodies.map((b) => (
                <option key={b.id} value={b.id} className="bg-[#070A12] text-white">
                  [{b.role === 'planet' ? '行星' : '恒星'}] {b.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {hasPlanet && (
          <div className="rounded-lg border border-white/[0.06] bg-black/30 px-2.5 py-2">
            <SciFiSlider
              label="行星自转角速度"
              value={config.planetRotationRate}
              min={0}
              max={Math.max(5, config.planetRotationRate)}
              step={0.05}
              displayValue={`${config.planetRotationRate.toFixed(2)} rad/T`}
              hint="近地视角下调节昼夜交替与三日升落节律"
              onChange={actions.setPlanetRotationRate}
            />
          </div>
        )}

        <button
          type="button"
          onClick={actions.resetCameraView}
          className={`flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.04] px-3 text-xs font-medium text-slate-200 transition-colors hover:border-white/[0.18] hover:bg-white/[0.08] hover:text-white ${
            touchFriendly ? 'min-h-[44px]' : 'py-1.5'
          }`}
        >
          <RotateCcw className="h-3.5 w-3.5 text-slate-400" />
          <span>重置构图</span>
        </button>
      </PanelSection>

      {/* 2. 3D 视觉与辅助显示 */}
      <PanelSection
        title="3D 视觉与辅助"
        icon={<Layers className="h-3.5 w-3.5" />}
        touchFriendly={touchFriendly}
      >
        <div className="space-y-2 rounded-lg border border-white/[0.06] bg-black/30 p-2">
          <ToggleSwitch
            label="轨道轨迹拖尾"
            checked={visualOptions.showTrails}
            touchFriendly={touchFriendly}
            onChange={(val) => actions.updateVisualOptions({ showTrails: val })}
          />

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
                title="清空当前轨迹"
                className={`inline-flex items-center gap-1 rounded-md border border-white/[0.1] bg-white/[0.05] text-[10px] text-slate-300 transition-colors hover:border-white/[0.2] hover:text-white ${
                  touchFriendly ? 'min-h-[40px] min-w-[44px] justify-center px-2.5' : 'px-1.5 py-0.5'
                }`}
              >
                <Eraser className="h-2.5 w-2.5" />
                清空
              </button>
            }
            onChange={(val) => actions.updateVisualOptions({ trailLength: val })}
          />
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <ToggleSwitch
            label="速度矢量"
            checked={visualOptions.showVelocityVectors}
            touchFriendly={touchFriendly}
            onChange={(val) =>
              actions.updateVisualOptions({ showVelocityVectors: val })
            }
          />
          <ToggleSwitch
            label="引力矢量"
            checked={visualOptions.showForceVectors}
            touchFriendly={touchFriendly}
            onChange={(val) =>
              actions.updateVisualOptions({ showForceVectors: val })
            }
          />
          <ToggleSwitch
            label="质心标记"
            checked={visualOptions.showCenterOfMass}
            touchFriendly={touchFriendly}
            onChange={(val) =>
              actions.updateVisualOptions({ showCenterOfMass: val })
            }
          />
          <ToggleSwitch
            label="XY 网格"
            checked={visualOptions.showReferenceGrid}
            touchFriendly={touchFriendly}
            onChange={(val) =>
              actions.updateVisualOptions({ showReferenceGrid: val })
            }
          />
        </div>

        <div className="space-y-2 rounded-lg border border-white/[0.06] bg-black/30 p-2">
          <ToggleSwitch
            label="恒星 HDR 辉光"
            checked={visualOptions.enableBloom && !isPerformanceMode}
            disabled={isPerformanceMode}
            touchFriendly={touchFriendly}
            badge={
              <Sparkles
                className={`h-3 w-3 ${
                  isPerformanceMode ? 'text-slate-500' : 'text-sky-400'
                }`}
              />
            }
            onChange={(val) => actions.updateVisualOptions({ enableBloom: val })}
          />

          {isPerformanceMode ? (
            <p className="px-1 text-[10px] leading-relaxed text-slate-400">
              当前为性能流畅模式，恒星采用轻量 Sprite 光晕
            </p>
          ) : (
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
          )}
        </div>
      </PanelSection>

      {/* 3. 物理守恒监控 */}
      <PanelSection
        title="物理守恒监控"
        icon={<Activity className="h-3.5 w-3.5" />}
        touchFriendly={touchFriendly}
        badge={
          <span
            className={`rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${getDriftToneClass(
              metrics.relativeDrift
            )}`}
          >
            {formatStrictSci(Math.abs(metrics.relativeDrift), 1)}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-1.5">
          <div className="rounded-lg border border-white/[0.06] bg-black/35 px-2 py-1.5">
            <div className="text-[10px] text-slate-500">总机械能 E</div>
            <div className="mt-0.5 font-mono text-[11px] font-semibold tabular-nums text-white">
              {formatSigned(metrics.total, 5)}
            </div>
          </div>

          <div className="rounded-lg border border-white/[0.06] bg-black/35 px-2 py-1.5">
            <div className="text-[10px] text-slate-500">相对漂移 |ΔE/E₀|</div>
            <div
              className={`mt-0.5 font-mono text-[11px] font-semibold tabular-nums ${getDriftToneClass(
                metrics.relativeDrift
              )}`}
            >
              {formatStrictSci(Math.abs(metrics.relativeDrift), 2)}
            </div>
          </div>

          <div className="rounded-lg border border-white/[0.06] bg-black/35 px-2 py-1.5">
            <div className="text-[10px] text-slate-500">动能 K</div>
            <div className="mt-0.5 font-mono text-[11px] tabular-nums text-slate-200">
              {formatFixed(metrics.kinetic, 5)}
            </div>
          </div>

          <div className="rounded-lg border border-white/[0.06] bg-black/35 px-2 py-1.5">
            <div className="text-[10px] text-slate-500">引力势能 U</div>
            <div className="mt-0.5 font-mono text-[11px] tabular-nums text-slate-200">
              {formatSigned(metrics.potential, 5)}
            </div>
          </div>

          <div className="rounded-lg border border-white/[0.06] bg-black/35 px-2 py-1.5">
            <div className="text-[10px] text-slate-500">角动量 |L|</div>
            <div className="mt-0.5 font-mono text-[11px] tabular-nums text-slate-200">
              {formatFixed(metrics.angularMomentumMag, 5)}
            </div>
          </div>

          <div className="rounded-lg border border-white/[0.06] bg-black/35 px-2 py-1.5">
            <div className="text-[10px] text-slate-500">当前步长 h</div>
            <div className="mt-0.5 font-mono text-[11px] tabular-nums text-slate-200">
              {formatStrictSci(lastStepSize, 2)}
            </div>
          </div>

          <div
            className={`rounded-lg border px-2 py-1.5 ${
              hasCollisionLoss ? 'col-span-1' : 'col-span-2'
            } ${
              closeEncounterWarn
                ? 'border-amber-400/35 bg-amber-500/[0.08]'
                : 'border-white/[0.06] bg-black/35'
            }`}
          >
            <div className="text-[10px] text-slate-500">最小天体间距 r_min</div>
            <div
              className={`mt-0.5 font-mono text-[11px] tabular-nums ${
                closeEncounterWarn ? 'font-semibold text-amber-300' : 'text-slate-200'
              }`}
            >
              {Number.isFinite(minPairDistance) ? formatSci(minPairDistance, 3) : '—'}
            </div>
          </div>

          {hasCollisionLoss && (
            <div className="rounded-lg border border-amber-400/30 bg-amber-500/[0.08] px-2 py-1.5">
              <div className="text-[10px] text-amber-300/80">碰撞损耗 ΔE</div>
              <div className="mt-0.5 font-mono text-[11px] font-semibold tabular-nums text-amber-300">
                {formatSci(metrics.cumulativeEnergyLoss, 3)}
              </div>
            </div>
          )}
        </div>

        <EnergyDriftChart
          history={energyHistory}
          collisionEvents={collisionEvents}
          active={chartsActive}
        />
      </PanelSection>

      {/* 4. 三体行星纪元监控 */}
      {planetTelemetry !== null && eraTheme !== null && (
        <PanelSection
          title="三体行星纪元监控"
          icon={<Globe className="h-3.5 w-3.5 text-emerald-400" />}
          touchFriendly={touchFriendly}
          badge={
            <span
              className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${eraTheme.pillClass}`}
            >
              {eraTheme.badgeTitle}
            </span>
          }
        >
          {/* 主纪元状态卡 */}
          <div className={`rounded-xl border p-2.5 ${eraTheme.containerClass}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${eraTheme.dotClass}`} />
                <span className={`text-sm font-bold tracking-wider ${eraTheme.titleClass}`}>
                  {eraTheme.badgeTitle}
                </span>
              </div>
              <span className="rounded bg-black/40 px-1.5 py-0.5 text-[10px] font-medium text-slate-200">
                {eraTheme.subLabel}
              </span>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2 border-t border-white/[0.08] pt-2 font-mono text-[10.5px] tabular-nums">
              <div>
                <span className="block font-sans text-[9.5px] text-slate-400">
                  当前持续
                </span>
                <span className="text-white">
                  T = {formatSimTime(planetTelemetry.eraStatus.eraDuration)}
                </span>
              </div>
              <div className="text-right">
                <span className="block font-sans text-[9.5px] text-slate-400">
                  最长恒纪元
                </span>
                <span className="text-emerald-300">
                  T = {formatSimTime(planetTelemetry.eraStatus.longestStableDuration)}
                </span>
              </div>
            </div>
          </div>

          {/* 特征天文事件警报 */}
          {eventTheme !== null && (
            <div
              className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 ${eventTheme.badgeClass}`}
            >
              <div className="mt-0.5 shrink-0">
                {planetTelemetry.eraStatus.event === 'tri-solar-day' ? (
                  <Flame className="h-3.5 w-3.5" />
                ) : planetTelemetry.eraStatus.event === 'flying-stars' ? (
                  <Snowflake className="h-3.5 w-3.5" />
                ) : planetTelemetry.eraStatus.event === 'bi-solar-glare' ? (
                  <AlertTriangle className="h-3.5 w-3.5" />
                ) : (
                  <Sun className="h-3.5 w-3.5" />
                )}
              </div>
              <div className="min-w-0">
                <div className="text-[11px] font-semibold">
                  天象：{eventTheme.label}
                </div>
                <p className="mt-0.5 text-[10px] opacity-85">
                  {eventTheme.description}
                </p>
              </div>
            </div>
          )}

          {/* 核心热力学指标 */}
          <div className="grid grid-cols-2 gap-1.5">
            <div className="rounded-lg border border-white/[0.06] bg-black/35 px-2 py-1.5">
              <div className="text-[10px] text-slate-500">表面温度</div>
              <div
                className={`mt-0.5 font-mono text-xs font-bold tabular-nums ${getTempToneClass(
                  planetTelemetry.temperatureC
                )}`}
              >
                {formatTempC(planetTelemetry.temperatureC, 1)}
              </div>
            </div>

            <div className="rounded-lg border border-white/[0.06] bg-black/35 px-2 py-1.5">
              <div className="text-[10px] text-slate-500">平衡温度</div>
              <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-slate-200">
                {formatTempC(planetTelemetry.equilibriumTempC, 1)}
              </div>
            </div>

            <div className="rounded-lg border border-white/[0.06] bg-black/35 px-2 py-1.5">
              <div className="text-[10px] text-slate-500">温变率 dT/dt</div>
              <div
                className={`mt-0.5 font-mono text-[11px] tabular-nums ${
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

            <div className="rounded-lg border border-white/[0.06] bg-black/35 px-2 py-1.5">
              <div className="text-[10px] text-slate-500">地平线上太阳</div>
              <div className="mt-0.5 flex items-center justify-between font-mono text-[11px] tabular-nums text-white">
                <span>
                  {planetTelemetry.visibleSunCount}/{planetTelemetry.skyObservations.length}
                </span>
                <span className="flex items-center gap-1">
                  {planetTelemetry.skyObservations.map((obs) => (
                    <span
                      key={obs.starId}
                      title={`${obs.starName}: ${obs.isAboveHorizon ? '地平线上' : '地平线下'}`}
                      className={`h-2 w-2 rounded-full ${
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
            <div className="flex items-center justify-between text-[10px] text-slate-500">
              <span>天空恒星观测</span>
              <span>距离 / 仰角</span>
            </div>
            <div className="space-y-1">
              {planetTelemetry.skyObservations.map((obs) => (
                <div
                  key={obs.starId}
                  className={`flex items-center justify-between gap-1.5 rounded-lg border px-2 py-1.5 text-[10.5px] ${
                    obs.isAboveHorizon
                      ? 'border-white/[0.08] bg-black/40'
                      : 'border-white/[0.04] bg-black/20 opacity-60'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: obs.color }}
                    />
                    <span className="truncate font-medium text-slate-200">
                      {obs.starName}
                    </span>
                    {obs.isFlyingStar && (
                      <span className="shrink-0 rounded border border-sky-400/35 bg-sky-500/15 px-1 py-[1px] text-[9px] text-sky-200">
                        飞星
                      </span>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums">
                    <span className="text-slate-300" title="恒星距离 (AU)">
                      {formatFixed(obs.distance, 2)}
                    </span>
                    <span
                      className={obs.isAboveHorizon ? 'text-amber-300' : 'text-slate-500'}
                      title="本地仰角"
                    >
                      {formatElevationDeg(obs.elevationRad)}
                    </span>
                    <span
                      className={`rounded px-1 py-0.5 font-sans text-[9px] ${
                        obs.isAboveHorizon
                          ? 'bg-white/[0.08] text-slate-200'
                          : 'bg-white/[0.03] text-slate-500'
                      }`}
                    >
                      {obs.isAboveHorizon ? '可见' : '隐没'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <TemperatureChart history={temperatureHistory} active={chartsActive} />
        </PanelSection>
      )}
    </div>
  );
};

export interface TelemetryPanelProps {
  readonly snapshot: HudSnapshot;
  readonly actions: SimulationActions;
  readonly collapsed: boolean;
  readonly chartsActive: boolean;
  readonly onToggleCollapse: () => void;
}

/**
 * 桌面端可折叠右侧栏（288px 航天极简黑曜石玻璃）
 */
export const TelemetryPanel: React.FC<TelemetryPanelProps> = ({
  snapshot,
  actions,
  collapsed,
  chartsActive,
  onToggleCollapse,
}) => {
  return (
    <div className="pointer-events-none fixed bottom-[76px] right-3 top-[64px] z-20">
      <aside
        aria-hidden={collapsed}
        className={`flex h-full w-[288px] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#070A12]/[0.92] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_12px_36px_rgba(0,0,0,0.55)] transition-all duration-300 ease-out md:bg-[#070A12]/80 md:backdrop-blur-md ${
          collapsed
            ? 'pointer-events-none translate-x-[calc(100%+20px)] opacity-0'
            : 'pointer-events-auto translate-x-0 opacity-100'
        }`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/[0.07] px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-sky-400" />
            <span className="text-xs font-semibold tracking-wider text-white">
              视角与物理遥测
            </span>
          </div>
          <button
            type="button"
            onClick={onToggleCollapse}
            title="折叠右侧栏"
            className="inline-flex h-6 items-center gap-0.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 text-[11px] text-slate-400 transition-colors hover:border-white/[0.16] hover:text-white"
          >
            <span>收起</span>
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2.5">
          <TelemetryPanelContent
            snapshot={snapshot}
            actions={actions}
            chartsActive={chartsActive}
          />
        </div>
      </aside>

      {collapsed && (
        <button
          type="button"
          onClick={onToggleCollapse}
          title="展开遥测与视角面板"
          className="pointer-events-auto absolute right-0 top-0 flex items-center gap-1.5 rounded-xl border border-white/[0.08] bg-[#070A12]/[0.92] px-2 py-2.5 text-xs font-medium text-slate-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_12px_36px_rgba(0,0,0,0.55)] transition-colors hover:border-white/[0.18] hover:text-white md:bg-[#070A12]/80 md:backdrop-blur-md"
        >
          <ChevronLeft className="h-3.5 w-3.5 text-slate-400" />
          <span className="[writing-mode:vertical-rl] tracking-widest">遥测</span>
          <Activity className="h-3.5 w-3.5 text-sky-400" />
        </button>
      )}
    </div>
  );
};
