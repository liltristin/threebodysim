import React, { useEffect, useState } from 'react';
import {
  Eye,
  EyeOff,
  Gauge,
  Orbit,
  ShieldAlert,
} from 'lucide-react';
import { PRESET_MAP } from '../presets/presets';
import type { HudSnapshot, SimulationActions } from '../types/contracts';
import { ControlPanel } from './ControlPanel';
import { TelemetryPanel } from './TelemetryPanel';
import { TimelineBar } from './TimelineBar';
import { formatSimTime } from './formatters';

export interface HudOverlayProps {
  readonly snapshot: HudSnapshot;
  readonly actions: SimulationActions;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

/**
 * 深空科幻毛玻璃主 HUD 覆盖层
 * - 外层 pointer-events-none，面板本体 pointer-events-auto，不阻挡 3D 视口拖拽与缩放
 * - 支持快捷键 H 切换纯净观赏模式、Space 切换播放/暂停（自动避开表单输入焦点）
 */
export const HudOverlay: React.FC<HudOverlayProps> = ({ snapshot, actions }) => {
  const [pureMode, setPureMode] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth < 1024
  );
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth < 1024
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableElement(e.target)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) {
          actions.togglePlay();
        }
        return;
      }

      if (e.key === 'h' || e.key === 'H') {
        if (!e.repeat) {
          e.preventDefault();
          setPureMode((prev) => !prev);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [actions]);

  const presetLabel =
    snapshot.presetId && PRESET_MAP[snapshot.presetId]
      ? PRESET_MAP[snapshot.presetId].name
      : '自定义 / 随机系统';

  const roundedFps = Number.isFinite(snapshot.fps) ? Math.round(snapshot.fps) : 0;
  const fpsToneClass =
    roundedFps >= 50
      ? 'text-emerald-300'
      : roundedFps >= 30
        ? 'text-amber-300'
        : 'text-rose-400';

  if (pureMode) {
    return (
      <div className="pointer-events-none fixed inset-0 z-20 select-none overflow-hidden">
        <button
          type="button"
          onClick={() => setPureMode(false)}
          title="退出纯净观赏模式 (快捷键 H)"
          className="pointer-events-auto fixed right-3 top-3 z-30 inline-flex items-center gap-1.5 rounded-xl border border-cyan-500/25 bg-slate-950/55 px-3 py-1.5 text-xs font-medium text-slate-300 shadow-[0_6px_24px_rgba(0,0,0,0.45)] backdrop-blur-md transition-all hover:border-cyan-400/60 hover:bg-slate-950/85 hover:text-cyan-200"
        >
          <Eye className="h-3.5 w-3.5 text-cyan-400" />
          <span>显示界面 (H)</span>
        </button>
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-20 select-none overflow-hidden">
      {/* 顶部极简深空状态条 */}
      <header className="pointer-events-auto fixed left-3 right-3 top-3 z-30 flex h-[44px] items-center justify-between gap-2 rounded-2xl border border-cyan-500/20 bg-slate-950/75 px-3 shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-md">
        {/* 左：标题 + 当前预设 */}
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex shrink-0 items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-cyan-400/35 bg-cyan-500/15 text-cyan-300 shadow-[0_0_14px_rgba(34,211,238,0.18)]">
              <Orbit className="h-4 w-4" />
            </span>
            <h1 className="truncate text-sm font-bold tracking-wide text-slate-100">
              3D 三体运动模拟器
            </h1>
          </div>

          <span className="hidden h-4 w-px bg-slate-800 sm:inline-block" />

          <span
            title={`当前场景：${presetLabel}`}
            className="hidden max-w-[190px] truncate rounded-lg border border-cyan-500/20 bg-slate-900/75 px-2.5 py-1 text-xs font-medium text-cyan-200 sm:inline-block"
          >
            {presetLabel}
          </span>
        </div>

        {/* 中：模拟时间 / FPS / 自动慢动作与步长保护徽章 */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2.5 rounded-xl border border-slate-800/80 bg-slate-900/65 px-2.5 py-1 font-mono text-xs tabular-nums sm:gap-3 sm:px-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-400">T</span>
              <span className="font-semibold text-cyan-300">
                {formatSimTime(snapshot.simTime)}
              </span>
            </div>
            <span className="h-3 w-px bg-slate-700/80" />
            <div className="flex items-center gap-1">
              <span className={`font-semibold ${fpsToneClass}`}>{roundedFps}</span>
              <span className="text-[10px] text-slate-400">FPS</span>
            </div>
          </div>

          {snapshot.isAutoSlowMoActive && (
            <div className="inline-flex animate-pulse items-center gap-1.5 rounded-full border border-amber-400/60 bg-amber-500/20 px-2.5 py-1 text-[11px] font-semibold text-amber-200 shadow-[0_0_18px_rgba(245,158,11,0.3)]">
              <Gauge className="h-3.5 w-3.5 text-amber-300" />
              <span>近距慢动作激活</span>
            </div>
          )}

          {snapshot.substepClamped && (
            <div
              title="近距奇点导致单帧子步数达到保护上限，已触发防卡死步长保护"
              className="inline-flex items-center gap-1 rounded-full border border-rose-400/55 bg-rose-500/20 px-2.5 py-1 text-[11px] font-semibold text-rose-200 shadow-[0_0_14px_rgba(244,63,94,0.22)]"
            >
              <ShieldAlert className="h-3.5 w-3.5 text-rose-300" />
              <span>步长保护</span>
            </div>
          )}
        </div>

        {/* 右：纯净模式切换 */}
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setPureMode(true)}
            title="隐藏全部 HUD 面板进入纯净观赏模式 (快捷键 H)"
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700/80 bg-slate-900/75 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-cyan-400/50 hover:bg-cyan-500/15 hover:text-cyan-200"
          >
            <EyeOff className="h-3.5 w-3.5 text-cyan-400" />
            <span className="hidden sm:inline">纯净模式</span>
            <kbd className="rounded border border-slate-700 bg-slate-950 px-1 py-[1px] font-mono text-[10px] text-slate-400">
              H
            </kbd>
          </button>
        </div>
      </header>

      {/* 可折叠左侧控制栏 */}
      <ControlPanel
        snapshot={snapshot}
        actions={actions}
        collapsed={leftCollapsed}
        onToggleCollapse={() => setLeftCollapsed((prev) => !prev)}
      />

      {/* 可折叠右侧遥测仪表盘与视角栏 */}
      <TelemetryPanel
        snapshot={snapshot}
        actions={actions}
        collapsed={rightCollapsed}
        onToggleCollapse={() => setRightCollapsed((prev) => !prev)}
      />

      {/* 底部悬浮时间控制条 */}
      <footer className="pointer-events-none fixed inset-x-3 bottom-3 z-30 flex justify-center">
        <TimelineBar snapshot={snapshot} actions={actions} />
      </footer>
    </div>
  );
};
