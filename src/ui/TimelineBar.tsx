import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Camera,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  Shuffle,
  Sliders,
  StepForward,
} from 'lucide-react';
import type {
  CameraMode,
  HudSnapshot,
  SimulationActions,
} from '../types/contracts';
import type { MobileSheetTab } from './MobileBottomSheet';

export interface TimelineBarProps {
  readonly snapshot: HudSnapshot;
  readonly actions: SimulationActions;
  readonly isMobile?: boolean;
  readonly activeSheet?: MobileSheetTab | null;
  readonly onToggleSheet?: (tab: MobileSheetTab) => void;
}

const MIN_TIME_SCALE = 0.05;
const DEFAULT_MAX_TIME_SCALE = 5.0;

const DOCK_CAMERA_MODES: ReadonlyArray<{
  readonly mode: CameraMode;
  readonly label: string;
  readonly requiresPlanet?: boolean;
}> = [
  { mode: 'free', label: '自由' },
  { mode: 'com', label: '质心' },
  { mode: 'follow', label: '跟随' },
  { mode: 'planet-surface', label: '近地', requiresPlanet: true },
];

/**
 * 底部居中悬浮控制坞（Floating Dock）
 * - 桌面端（>= 768px）：圆角胶囊单行悬浮坞（播放/暂停、单步、.aero-slider 倍速、自动慢动作、重置、随机、相机快捷切换）
 * - 移动端（< 768px）：紧凑操作条（全部按钮 >= 40px 热区：播放/暂停、重置、控制/遥测 Bottom Sheet 切换）
 */
export const TimelineBar: React.FC<TimelineBarProps> = ({
  snapshot,
  actions,
  isMobile = false,
  activeSheet = null,
  onToggleSheet,
}) => {
  const [followPopoverOpen, setFollowPopoverOpen] = useState(false);
  const cameraGroupRef = useRef<HTMLDivElement | null>(null);

  const {
    isRunning,
    config,
    effectiveTimeScale,
    isAutoSlowMoActive,
    bodies,
    cameraState,
    planetTelemetry,
  } = snapshot;

  const planetBody = bodies.find((b) => b.role === 'planet') ?? null;
  const hasPlanet = planetBody !== null;
  const maxScale = Math.max(DEFAULT_MAX_TIME_SCALE, config.timeScale);
  const clampedScale = Math.min(maxScale, Math.max(MIN_TIME_SCALE, config.timeScale));
  const sliderPct = ((clampedScale - MIN_TIME_SCALE) / (maxScale - MIN_TIME_SCALE)) * 100;
  const showEffectiveDiff =
    isAutoSlowMoActive || Math.abs(effectiveTimeScale - config.timeScale) > 0.02;

  useEffect(() => {
    if (!followPopoverOpen) return;

    const handleOutside = (e: PointerEvent) => {
      if (
        cameraGroupRef.current &&
        e.target instanceof Node &&
        !cameraGroupRef.current.contains(e.target)
      ) {
        setFollowPopoverOpen(false);
      }
    };

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFollowPopoverOpen(false);
    };

    window.addEventListener('pointerdown', handleOutside);
    window.addEventListener('keydown', handleEsc);
    return () => {
      window.removeEventListener('pointerdown', handleOutside);
      window.removeEventListener('keydown', handleEsc);
    };
  }, [followPopoverOpen]);

  useEffect(() => {
    if (cameraState.mode !== 'follow') {
      setFollowPopoverOpen(false);
    }
  }, [cameraState.mode]);

  const handleDockCameraClick = (mode: CameraMode) => {
    if (mode === 'planet-surface') {
      if (!planetBody) return;
      actions.setCameraMode('planet-surface', planetBody.id);
      setFollowPopoverOpen(false);
      return;
    }

    if (mode === 'follow') {
      if (cameraState.mode === 'follow') {
        setFollowPopoverOpen((prev) => !prev);
      } else {
        const targetId =
          bodies.find((b) => b.id === cameraState.targetBodyId)?.id ??
          bodies[0]?.id ??
          null;
        actions.setCameraMode('follow', targetId);
        setFollowPopoverOpen(true);
      }
      return;
    }

    setFollowPopoverOpen(false);
    actions.setCameraMode(mode, null);
  };

  // =========================================================================
  // 移动端紧凑悬浮操作条（< 768px，严禁 backdrop-blur，全部按钮 >= 40px）
  // =========================================================================
  if (isMobile) {
    return (
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-2xl border border-white/[0.08] bg-[#070A12]/[0.92] px-2 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_12px_36px_rgba(0,0,0,0.65)]">
        <button
          type="button"
          onClick={actions.togglePlay}
          aria-label={isRunning ? '暂停' : '播放'}
          className={`inline-flex min-h-[40px] min-w-[44px] items-center justify-center rounded-xl border transition-colors ${
            isRunning
              ? 'border-white/20 bg-white/[0.12] text-white'
              : 'border-emerald-400/40 bg-emerald-500/20 text-emerald-200'
          }`}
        >
          {isRunning ? (
            <Pause className="h-4 w-4 fill-current" />
          ) : (
            <Play className="h-4 w-4 fill-current" />
          )}
        </button>

        <button
          type="button"
          onClick={actions.reset}
          aria-label="重置模拟"
          className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-slate-200 active:bg-white/[0.12]"
        >
          <RotateCcw className="h-4 w-4" />
        </button>

        <span className="h-5 w-px bg-white/[0.08]" />

        <button
          type="button"
          onClick={() => onToggleSheet?.('control')}
          className={`inline-flex min-h-[40px] min-w-[72px] items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors ${
            activeSheet === 'control'
              ? 'border-white/20 bg-white/[0.14] text-white'
              : 'border-white/[0.08] bg-white/[0.04] text-slate-300 active:bg-white/[0.1]'
          }`}
        >
          <Sliders className="h-3.5 w-3.5 text-sky-400" />
          <span>控制</span>
        </button>

        <button
          type="button"
          onClick={() => onToggleSheet?.('telemetry')}
          className={`inline-flex min-h-[40px] min-w-[72px] items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors ${
            activeSheet === 'telemetry'
              ? 'border-white/20 bg-white/[0.14] text-white'
              : 'border-white/[0.08] bg-white/[0.04] text-slate-300 active:bg-white/[0.1]'
          }`}
        >
          <Activity className="h-3.5 w-3.5 text-sky-400" />
          <span>遥测</span>
          {planetTelemetry !== null && (
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                planetTelemetry.eraStatus.era === 'stable'
                  ? 'bg-emerald-400'
                  : 'bg-amber-400'
              }`}
            />
          )}
        </button>
      </div>
    );
  }

  // =========================================================================
  // 桌面端圆角胶囊 Floating Dock（>= 768px）
  // =========================================================================
  const sliderStyle = {
    '--slider-pct': `${sliderPct.toFixed(2)}%`,
    ...(isAutoSlowMoActive
      ? { '--slider-fill': 'rgba(251, 191, 36, 0.85)' }
      : {}),
  } as React.CSSProperties;

  return (
    <div className="pointer-events-auto flex max-w-full flex-nowrap items-center gap-1.5 whitespace-nowrap rounded-full border border-white/[0.08] bg-[#070A12]/80 px-2.5 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_12px_36px_rgba(0,0,0,0.6)] md:backdrop-blur-md">
      {/* 播放 / 暂停 & 单步 */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={actions.togglePlay}
          title={isRunning ? '暂停模拟 (Space)' : '继续模拟 (Space)'}
          className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors ${
            isRunning
              ? 'border-white/20 bg-white/[0.12] text-white hover:bg-white/[0.18]'
              : 'border-emerald-400/35 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30'
          }`}
        >
          {isRunning ? (
            <>
              <Pause className="h-3.5 w-3.5 fill-current" />
              <span>暂停</span>
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5 fill-current" />
              <span>播放</span>
            </>
          )}
        </button>

        <button
          type="button"
          onClick={() => actions.stepOnce()}
          title="单步推进物理积分"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.03] text-slate-300 transition-colors hover:border-white/[0.16] hover:bg-white/[0.08] hover:text-white"
        >
          <StepForward className="h-3.5 w-3.5" />
        </button>
      </div>

      <span className="h-5 w-px shrink-0 bg-white/[0.08]" />

      {/* 时间倍速（.aero-slider + 等宽读数 + 慢动作有效倍速） */}
      <div className="flex shrink-0 items-center gap-2 px-1">
        <div className="w-[96px] lg:w-[126px]">
          <input
            type="range"
            aria-label="时间倍速"
            min={MIN_TIME_SCALE}
            max={maxScale}
            step={0.05}
            value={clampedScale}
            style={sliderStyle}
            onChange={(e) => actions.setTimeScale(parseFloat(e.target.value))}
            className="aero-slider"
          />
        </div>

        <div className="flex items-center gap-1 font-mono text-[11px] tabular-nums">
          <button
            type="button"
            title="点击恢复 1.00x 标准倍速"
            onClick={() => actions.setTimeScale(1.0)}
            className={`min-w-[40px] rounded-md px-1 py-0.5 text-right transition-colors hover:bg-white/[0.08] ${
              showEffectiveDiff
                ? 'text-slate-500 line-through'
                : 'font-medium text-white'
            }`}
          >
            {config.timeScale.toFixed(2)}x
          </button>
          {showEffectiveDiff && (
            <span className="inline-flex min-w-[60px] items-center justify-center gap-1 rounded-full border border-amber-400/35 bg-amber-500/[0.14] px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
              {effectiveTimeScale.toFixed(2)}x
            </span>
          )}
        </div>

        {/* 自动慢动作图标按钮 */}
        <button
          type="button"
          role="switch"
          aria-checked={config.enableAutoSlowMo}
          onClick={() => actions.setAutoSlowMo(!config.enableAutoSlowMo)}
          title={
            config.enableAutoSlowMo
              ? '自动慢动作：已开启（近距交汇自动降速）'
              : '自动慢动作：已关闭'
          }
          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors ${
            isAutoSlowMoActive
              ? 'border-amber-400/45 bg-amber-500/20 text-amber-300'
              : config.enableAutoSlowMo
                ? 'border-sky-400/35 bg-sky-400/15 text-sky-300 hover:bg-sky-400/25'
                : 'border-white/[0.07] bg-white/[0.03] text-slate-500 hover:border-white/[0.16] hover:text-slate-200'
          }`}
        >
          <Gauge className={`h-3.5 w-3.5 ${isAutoSlowMoActive ? 'animate-pulse' : ''}`} />
        </button>
      </div>

      <span className="h-5 w-px shrink-0 bg-white/[0.08]" />

      {/* 重置 & 随机生成 */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={actions.reset}
          title="重置模拟至初始状态"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.03] text-slate-300 transition-colors hover:border-white/[0.16] hover:bg-white/[0.08] hover:text-white"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          onClick={() => actions.randomize()}
          title="随机生成三维混沌三体系统"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.03] text-slate-300 transition-colors hover:border-white/[0.16] hover:bg-white/[0.08] hover:text-white"
        >
          <Shuffle className="h-3.5 w-3.5" />
        </button>
      </div>

      <span className="h-5 w-px shrink-0 bg-white/[0.08]" />

      {/* 相机快捷切换胶囊（全屏观赏时无需展开右侧栏即可秒切视角） */}
      <div ref={cameraGroupRef} className="relative flex shrink-0 items-center gap-1">
        <Camera className="ml-0.5 hidden h-3.5 w-3.5 shrink-0 text-slate-500 lg:block" />
        <div
          role="radiogroup"
          aria-label="相机快捷视角"
          className="inline-flex items-center gap-0.5 rounded-full border border-white/[0.08] bg-white/[0.03] p-0.5"
        >
          {DOCK_CAMERA_MODES.map(({ mode, label, requiresPlanet }) => {
            const disabled = Boolean(requiresPlanet && !hasPlanet);
            const active = cameraState.mode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                title={
                  disabled
                    ? '需先存在三体行星才可切入近地视角'
                    : mode === 'follow' && active
                      ? '点击选择跟随目标天体'
                      : `切换至${label}视角`
                }
                onClick={() => handleDockCameraClick(mode)}
                className={`h-7 rounded-full border px-2 text-[11px] font-medium transition-colors ${
                  disabled
                    ? 'cursor-not-allowed border-transparent text-slate-600'
                    : active
                      ? 'border-white/20 bg-white/[0.13] text-white'
                      : 'border-transparent text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* 跟随模式目标天体快捷弹出菜单 */}
        {followPopoverOpen && cameraState.mode === 'follow' && (
          <div className="absolute bottom-[calc(100%+10px)] right-0 z-40 w-[188px] rounded-xl border border-white/[0.1] bg-[#070A12]/95 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_16px_40px_rgba(0,0,0,0.75)] md:backdrop-blur-md">
            <div className="px-2 py-1 text-[10px] font-medium text-slate-400">
              选择跟随天体
            </div>
            <div className="max-h-[180px] space-y-0.5 overflow-y-auto">
              {bodies.map((b) => {
                const selected = cameraState.targetBodyId === b.id;
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => {
                      actions.setCameraMode('follow', b.id);
                      setFollowPopoverOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs transition-colors ${
                      selected
                        ? 'border-white/20 bg-white/[0.1] text-white'
                        : 'border-transparent text-slate-300 hover:bg-white/[0.05] hover:text-white'
                    }`}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: b.color }}
                    />
                    <span className="truncate">{b.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
