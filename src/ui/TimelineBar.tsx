import React from 'react';
import {
  Gauge,
  Pause,
  Play,
  RotateCcw,
  Shuffle,
  StepForward,
} from 'lucide-react';
import type { HudSnapshot, SimulationActions } from '../types/contracts';

export interface TimelineBarProps {
  readonly snapshot: HudSnapshot;
  readonly actions: SimulationActions;
}

const MIN_TIME_SCALE = 0.05;
const DEFAULT_MAX_TIME_SCALE = 5.0;

/**
 * 底部悬浮时间控制条
 * - 播放/暂停、单步推进、时间倍速滑块（慢动作生效时并列展示目标倍速与有效倍速）、
 *   自动慢动作开关、重置、随机生成
 */
export const TimelineBar: React.FC<TimelineBarProps> = ({ snapshot, actions }) => {
  const { isRunning, config, effectiveTimeScale, isAutoSlowMoActive } = snapshot;
  const maxScale = Math.max(DEFAULT_MAX_TIME_SCALE, config.timeScale);
  const showEffectiveDiff =
    isAutoSlowMoActive || Math.abs(effectiveTimeScale - config.timeScale) > 0.02;

  return (
    <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-2 whitespace-nowrap rounded-2xl border border-cyan-500/25 bg-slate-950/75 px-3 py-1.5 shadow-[0_10px_40px_rgba(0,0,0,0.6),0_0_24px_rgba(6,182,212,0.08)] backdrop-blur-md md:flex-nowrap">
      {/* 播放 / 暂停 & 单步 */}
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={actions.togglePlay}
          title={isRunning ? '暂停模拟 (Space)' : '继续模拟 (Space)'}
          className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition-all ${
            isRunning
              ? 'border-cyan-400/50 bg-cyan-500/20 text-cyan-200 shadow-[0_0_16px_rgba(34,211,238,0.2)] hover:bg-cyan-500/30'
              : 'border-emerald-400/55 bg-emerald-500/20 text-emerald-200 shadow-[0_0_16px_rgba(16,185,129,0.2)] hover:bg-emerald-500/30'
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
          className="inline-flex h-9 shrink-0 items-center gap-1 rounded-xl border border-slate-700/80 bg-slate-900/75 px-2.5 text-xs text-slate-200 transition-colors hover:border-cyan-500/40 hover:bg-slate-800/90 hover:text-cyan-200"
        >
          <StepForward className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">单步</span>
        </button>
      </div>

      <div className="hidden h-6 w-px shrink-0 bg-slate-800 sm:block" />

      {/* 时间倍速滑块 + 慢动作有效倍速双读数 */}
      <div className="flex shrink-0 items-center gap-2 px-0.5">
        <div className="flex min-w-[160px] flex-col justify-center gap-1 sm:min-w-[184px]">
          <div className="flex items-center justify-between gap-1.5 text-[11px] leading-4">
            <span className="text-slate-400">时间倍速</span>
            <div className="flex items-center gap-1 font-mono tabular-nums">
              <button
                type="button"
                title="点击恢复 1.00x 标准倍速"
                onClick={() => actions.setTimeScale(1.0)}
                className={`rounded px-1 transition-colors hover:bg-slate-800 ${
                  showEffectiveDiff
                    ? 'text-slate-400 line-through decoration-slate-500/70'
                    : 'font-semibold text-cyan-300'
                }`}
              >
                {config.timeScale.toFixed(2)}x
              </button>
              {showEffectiveDiff && (
                <span className="inline-flex items-center gap-1 rounded border border-amber-400/45 bg-amber-500/15 px-1 py-[1px] text-[10px] font-semibold leading-none text-amber-300">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                  有效 {effectiveTimeScale.toFixed(2)}x
                </span>
              )}
            </div>
          </div>
          <input
            type="range"
            aria-label="时间倍速"
            min={MIN_TIME_SCALE}
            max={maxScale}
            step={0.05}
            value={Math.min(maxScale, Math.max(MIN_TIME_SCALE, config.timeScale))}
            onChange={(e) => actions.setTimeScale(parseFloat(e.target.value))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-800 accent-cyan-400"
          />
        </div>

        {/* 自动慢动作开关 */}
        <button
          type="button"
          role="switch"
          aria-checked={config.enableAutoSlowMo}
          onClick={() => actions.setAutoSlowMo(!config.enableAutoSlowMo)}
          title="近距交汇自动慢动作（Auto Slow-Mo）"
          className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium transition-all ${
            isAutoSlowMoActive
              ? 'border-amber-400/70 bg-amber-500/20 text-amber-200 shadow-[0_0_16px_rgba(245,158,11,0.28)]'
              : config.enableAutoSlowMo
                ? 'border-cyan-500/40 bg-cyan-500/15 text-cyan-200 hover:border-cyan-400/60'
                : 'border-slate-700/80 bg-slate-900/70 text-slate-400 hover:border-slate-600 hover:text-slate-200'
          }`}
        >
          <Gauge className={`h-3.5 w-3.5 ${isAutoSlowMoActive ? 'animate-pulse text-amber-300' : ''}`} />
          <span>自动慢动作</span>
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              isAutoSlowMoActive
                ? 'animate-ping bg-amber-400'
                : config.enableAutoSlowMo
                  ? 'bg-cyan-400'
                  : 'bg-slate-600'
            }`}
          />
        </button>
      </div>

      <div className="hidden h-6 w-px shrink-0 bg-slate-800 sm:block" />

      {/* 重置 & 随机生成 */}
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={actions.reset}
          title="重置当前模拟至初始状态"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-slate-700/80 bg-slate-900/75 px-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-cyan-500/40 hover:bg-slate-800/90 hover:text-cyan-200"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          <span>重置</span>
        </button>

        <button
          type="button"
          onClick={() => actions.randomize()}
          title="随机生成三维混沌三体系统"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-amber-500/35 bg-amber-500/10 px-2.5 text-xs font-medium text-amber-200 transition-colors hover:border-amber-400/60 hover:bg-amber-500/20"
        >
          <Shuffle className="h-3.5 w-3.5" />
          <span>随机生成</span>
        </button>
      </div>
    </div>
  );
};
