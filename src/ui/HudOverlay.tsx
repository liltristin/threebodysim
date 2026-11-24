import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Eye,
  EyeOff,
  Gauge,
  Globe,
  Orbit,
  ShieldAlert,
  Sparkles,
  Zap,
} from 'lucide-react';
import { PRESETS, PRESET_MAP } from '../presets/presets';
import type {
  HudSnapshot,
  QualityMode,
  SimulationActions,
} from '../types/contracts';
import { ControlPanel } from './ControlPanel';
import { MobileBottomSheet, type MobileSheetTab } from './MobileBottomSheet';
import { TelemetryPanel } from './TelemetryPanel';
import { TimelineBar } from './TimelineBar';
import {
  formatSimTime,
  formatTempC,
  getAstroEventTheme,
  getEraTheme,
  getTempToneClass,
} from './formatters';
import { useIsMobile } from './hooks/useIsMobile';

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
 * 航天遥测极简风主 HUD 覆盖层
 * - 深黑曜石暗色玻璃（桌面 md:backdrop-blur-md；移动端纯半透明严禁 backdrop-blur）
 * - 顶部精简悬浮条：左预设快速切换下拉、中三体纪元/温度或模拟时间、右画质模式切换+固定宽FPS+纯净模式
 * - 桌面端（>= 768px）：288px 左右可折叠侧栏 + 圆角胶囊 Floating Dock
 * - 移动端（< 768px）：全屏无遮挡默认态 + 底部操作条 + 最高 55vh Bottom Sheet
 */
export const HudOverlay: React.FC<HudOverlayProps> = ({ snapshot, actions }) => {
  const isMobile = useIsMobile();

  const [pureMode, setPureMode] = useState(false);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth < 1024
  );
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth < 1024
  );
  const [mobileSheet, setMobileSheet] = useState<MobileSheetTab | null>(null);

  const presetMenuRef = useRef<HTMLDivElement | null>(null);

  // 点击外部或 Esc 关闭预设下拉菜单
  useEffect(() => {
    if (!presetMenuOpen) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (
        presetMenuRef.current &&
        e.target instanceof Node &&
        !presetMenuRef.current.contains(e.target)
      ) {
        setPresetMenuOpen(false);
      }
    };

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPresetMenuOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleEsc);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleEsc);
    };
  }, [presetMenuOpen]);

  // 全局快捷键：H 纯净模式 / Space 播放暂停 / Esc 收起移动端抽屉
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
          setPresetMenuOpen(false);
        }
        return;
      }

      if (e.key === 'Escape') {
        setMobileSheet(null);
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
      ? 'text-emerald-400'
      : roundedFps >= 30
        ? 'text-amber-300'
        : 'text-rose-400';

  const qualityMode: QualityMode = snapshot.visualOptions.qualityMode;
  const planetTelemetry = snapshot.planetTelemetry;
  const eraTheme = planetTelemetry ? getEraTheme(planetTelemetry.eraStatus) : null;
  const eventTheme = planetTelemetry
    ? getAstroEventTheme(
        planetTelemetry.eraStatus.event,
        planetTelemetry.eraStatus.eventLabel
      )
    : null;

  const handleToggleMobileSheet = (tab: MobileSheetTab) => {
    setMobileSheet((prev) => (prev === tab ? null : tab));
  };

  if (pureMode) {
    return (
      <div className="pointer-events-none fixed inset-0 z-20 select-none overflow-hidden">
        <button
          type="button"
          onClick={() => setPureMode(false)}
          title="退出纯净观赏模式 (快捷键 H)"
          className="pointer-events-auto fixed right-3 top-3 z-30 inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-white/[0.12] bg-[#070A12]/[0.92] px-3.5 py-1.5 text-xs font-medium text-slate-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_12px_36px_rgba(0,0,0,0.55)] transition-colors hover:border-white/25 hover:text-white md:min-h-0 md:bg-[#070A12]/80 md:backdrop-blur-md"
        >
          <Eye className="h-3.5 w-3.5 text-sky-400" />
          <span>显示界面{isMobile ? '' : ' (H)'}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-20 select-none overflow-hidden">
      {/* 顶部精简悬浮条 */}
      <header className="pointer-events-auto fixed inset-x-2.5 top-2.5 z-30 flex items-center justify-between gap-2 rounded-2xl border border-white/[0.08] bg-[#070A12]/[0.92] px-2 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_12px_36px_rgba(0,0,0,0.55)] md:inset-x-3 md:top-3 md:h-[44px] md:bg-[#070A12]/80 md:px-2.5 md:py-0 md:backdrop-blur-md">
        {/* 左：预设快速切换下拉胶囊（移动端 flex-1 + overflow-hidden 严格截断绝不溢出） */}
        <div ref={presetMenuRef} className="relative min-w-0 flex-1 md:flex-initial md:shrink">
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={presetMenuOpen}
            onClick={() => setPresetMenuOpen((prev) => !prev)}
            className="inline-flex min-h-[40px] max-w-full items-center gap-1.5 overflow-hidden rounded-full border border-white/[0.09] bg-white/[0.04] px-2.5 text-xs font-medium text-white transition-colors hover:border-white/[0.18] hover:bg-white/[0.08] md:h-8 md:min-h-0 md:max-w-[260px]"
          >
            <Orbit className="h-3.5 w-3.5 shrink-0 text-sky-400" />
            <span className="min-w-0 truncate">{presetLabel}</span>
            <ChevronDown
              className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200 ${
                presetMenuOpen ? 'rotate-180 text-white' : ''
              }`}
            />
          </button>

          {presetMenuOpen && (
            <div
              role="listbox"
              aria-label="经典预设切换"
              className="absolute left-0 top-[calc(100%+8px)] z-50 w-[min(320px,calc(100vw-20px))] rounded-2xl border border-white/[0.1] bg-[#070A12]/95 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_20px_54px_rgba(0,0,0,0.78)] md:bg-[#070A12]/90 md:backdrop-blur-md"
            >
              <div className="flex items-center justify-between px-2.5 py-1.5 text-[10px] font-medium tracking-wider text-slate-400">
                <span>经典三体预设库</span>
                <span className="font-mono text-slate-500">{PRESETS.length} 套</span>
              </div>

              <div className="max-h-[60vh] space-y-1 overflow-y-auto">
                {PRESETS.map((preset) => {
                  const isActive = snapshot.presetId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => {
                        actions.loadPreset(preset.id);
                        setPresetMenuOpen(false);
                      }}
                      className={`w-full rounded-xl border p-2.5 text-left transition-colors ${
                        isActive
                          ? 'border-white/20 bg-white/[0.09]'
                          : 'border-transparent bg-white/[0.02] hover:border-white/[0.09] hover:bg-white/[0.05]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                isActive ? 'bg-sky-400' : 'bg-slate-600'
                              }`}
                            />
                            <span className="truncate text-xs font-semibold text-white">
                              {preset.name}
                            </span>
                          </div>
                          <p className="mt-0.5 truncate pl-3 font-mono text-[10px] text-slate-500">
                            {preset.subtitle}
                          </p>
                        </div>

                        <div className="flex shrink-0 items-center gap-1">
                          {preset.hasTrisolarisPlanet && (
                            <span className="inline-flex items-center gap-0.5 rounded-full border border-emerald-400/30 bg-emerald-500/[0.12] px-1.5 py-0.5 text-[9.5px] font-medium text-emerald-300">
                              <Globe className="h-2.5 w-2.5" />
                              三体行星
                            </span>
                          )}
                          {preset.defaultSoftening === 0 && (
                            <span className="rounded-full border border-white/[0.1] bg-white/[0.05] px-1.5 py-0.5 font-mono text-[9.5px] text-slate-300">
                              ε=0
                            </span>
                          )}
                        </div>
                      </div>
                      <p className="mt-1.5 line-clamp-2 text-[10.5px] leading-relaxed text-slate-400">
                        {preset.description}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* 中：仅桌面端（>= 768px）居中展示三体纪元/表面温度 或 模拟时间 T */}
        <div className="hidden min-w-0 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap md:flex">
          {planetTelemetry !== null && eraTheme !== null ? (
            <>
              <div
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] md:h-8 md:py-0 ${eraTheme.pillClass}`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${eraTheme.dotClass}`} />
                <span className="font-semibold">{eraTheme.badgeTitle}</span>
                <span className="hidden text-[10.5px] opacity-80 lg:inline">
                  {eraTheme.subLabel}
                </span>
                <span className="h-3 w-px bg-white/15" />
                <span
                  className={`min-w-[52px] text-right font-mono font-semibold tabular-nums ${getTempToneClass(
                    planetTelemetry.temperatureC
                  )}`}
                >
                  {formatTempC(planetTelemetry.temperatureC, 1)}
                </span>
              </div>

              {eventTheme !== null && (
                <span
                  className={`hidden items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold sm:inline-flex ${eventTheme.compactClass}`}
                >
                  {eventTheme.label}
                </span>
              )}

              {snapshot.isAutoSlowMoActive && (
                <span
                  title="近距慢动作已激活"
                  className="hidden items-center gap-1 rounded-full border border-amber-400/35 bg-amber-500/[0.14] px-2 py-0.5 text-[10.5px] font-medium text-amber-300 xl:inline-flex"
                >
                  <Gauge className="h-3 w-3 animate-pulse" />
                  慢动作
                </span>
              )}

              {snapshot.substepClamped && (
                <span
                  title="单帧子步数触及上限，已启用防卡死步长保护"
                  className="hidden items-center gap-1 rounded-full border border-rose-400/35 bg-rose-500/[0.14] px-2 py-0.5 text-[10.5px] font-medium text-rose-300 xl:inline-flex"
                >
                  <ShieldAlert className="h-3 w-3" />
                  步长保护
                </span>
              )}
            </>
          ) : (
            <>
              <div className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] px-2.5 py-1 font-mono text-[11px] tabular-nums md:h-8 md:py-0">
                <span className="text-[10px] text-slate-500">T</span>
                <span className="min-w-[46px] text-right font-medium text-white">
                  {formatSimTime(snapshot.simTime)}
                </span>
              </div>

              {snapshot.isAutoSlowMoActive && (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/35 bg-amber-500/[0.14] px-2 py-0.5 text-[10.5px] font-medium text-amber-300">
                  <Gauge className="h-3 w-3 animate-pulse" />
                  <span className="hidden sm:inline">近距慢动作</span>
                </span>
              )}

              {snapshot.substepClamped && (
                <span
                  title="单帧子步数触及上限，已启用防卡死步长保护"
                  className="inline-flex items-center gap-1 rounded-full border border-rose-400/35 bg-rose-500/[0.14] px-2 py-0.5 text-[10.5px] font-medium text-rose-300"
                >
                  <ShieldAlert className="h-3 w-3" />
                  <span className="hidden sm:inline">步长保护</span>
                </span>
              )}
            </>
          )}
        </div>

        {/* 右：画质模式切换胶囊 + 固定宽 FPS + 纯净模式 */}
        <div className="flex shrink-0 items-center gap-1.5">
          {/* 桌面端：两段式画质胶囊 */}
          <div
            role="radiogroup"
            aria-label="渲染画质模式"
            className="hidden items-center gap-0.5 rounded-full border border-white/[0.08] bg-white/[0.03] p-0.5 md:inline-flex"
          >
            <button
              type="button"
              role="radio"
              aria-checked={qualityMode === 'high'}
              onClick={() => actions.setQualityMode('high')}
              title="桌面高画质模式（HDR 选择性辉光 + 高密星空）"
              className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors ${
                qualityMode === 'high'
                  ? 'border-white/20 bg-white/[0.12] text-white'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Sparkles className="h-3 w-3 text-sky-400" />
              <span>高画质</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={qualityMode === 'performance'}
              onClick={() => actions.setQualityMode('performance')}
              title="性能流畅模式（绕过 Bloom 后处理，高帧率省电）"
              className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors ${
                qualityMode === 'performance'
                  ? 'border-white/20 bg-white/[0.12] text-white'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Zap className="h-3 w-3 text-emerald-400" />
              <span>性能流畅</span>
            </button>
          </div>

          {/* 移动端：紧凑单键画质切换胶囊 */}
          <button
            type="button"
            onClick={() =>
              actions.setQualityMode(qualityMode === 'high' ? 'performance' : 'high')
            }
            title={
              qualityMode === 'high'
                ? '当前高画质，点击切至性能流畅模式'
                : '当前性能流畅，点击切至高画质模式'
            }
            className="inline-flex min-h-[40px] items-center gap-1 rounded-full border border-white/[0.1] bg-white/[0.05] px-2 text-[11px] font-medium text-white active:bg-white/[0.12] md:hidden"
          >
            {qualityMode === 'high' ? (
              <>
                <Sparkles className="h-3 w-3 text-sky-400" />
                <span>高画</span>
              </>
            ) : (
              <>
                <Zap className="h-3 w-3 text-emerald-400" />
                <span>流畅</span>
              </>
            )}
          </button>

          {/* 固定宽度 FPS 读数 */}
          <div className="inline-flex min-w-[46px] items-baseline justify-end gap-0.5 rounded-full border border-white/[0.07] bg-white/[0.03] px-2 py-1 font-mono tabular-nums md:h-8 md:min-w-[58px] md:items-center md:py-0">
            <span className={`text-[11px] font-semibold ${fpsToneClass}`}>
              {roundedFps}
            </span>
            <span className="text-[9px] text-slate-500">FPS</span>
          </div>

          {/* 纯净模式切换按钮 */}
          <button
            type="button"
            onClick={() => {
              setPureMode(true);
              setPresetMenuOpen(false);
            }}
            title="隐藏全部界面进入纯净观赏模式 (快捷键 H)"
            className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] text-xs font-medium text-slate-300 transition-colors hover:border-white/[0.18] hover:bg-white/[0.09] hover:text-white md:h-8 md:min-h-0 md:min-w-0 md:px-2.5"
          >
            <EyeOff className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">纯净</span>
            <kbd className="hidden rounded border border-white/[0.1] bg-black/50 px-1 py-[1px] font-mono text-[9.5px] text-slate-400 md:inline">
              H
            </kbd>
          </button>
        </div>
      </header>

      {/* 移动端专属二级居中微胶囊（< 768px）：单行呈现纪元/温度/天象 或 模拟时间 T，彻底杜绝 390px 顶栏拥挤折行 */}
      <div className="pointer-events-none fixed inset-x-2.5 top-[70px] z-20 flex justify-center md:hidden">
        {planetTelemetry !== null && eraTheme !== null ? (
          <div className="pointer-events-auto inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border border-white/[0.08] bg-[#070A12]/[0.92] px-3 py-1 text-[11px] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_24px_rgba(0,0,0,0.55)]">
            <span className={`h-2 w-2 shrink-0 rounded-full ${eraTheme.dotClass}`} />
            <span className={`font-semibold ${eraTheme.titleClass}`}>
              {eraTheme.badgeTitle}
            </span>
            <span className="text-slate-500">·</span>
            <span
              className={`min-w-[52px] text-right font-mono font-semibold tabular-nums ${getTempToneClass(
                planetTelemetry.temperatureC
              )}`}
            >
              {formatTempC(planetTelemetry.temperatureC, 1)}
            </span>
            {eventTheme !== null && (
              <>
                <span className="h-3 w-px bg-white/15" />
                <span
                  className={`rounded-full border px-1.5 py-[1px] text-[10px] font-semibold ${eventTheme.compactClass}`}
                >
                  {eventTheme.label}
                </span>
              </>
            )}
            {snapshot.isAutoSlowMoActive && (
              <Gauge className="h-3 w-3 shrink-0 animate-pulse text-amber-300" />
            )}
          </div>
        ) : (
          <div className="pointer-events-auto inline-flex max-w-full items-center gap-2 whitespace-nowrap rounded-full border border-white/[0.08] bg-[#070A12]/[0.92] px-3 py-1 text-[11px] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_24px_rgba(0,0,0,0.55)]">
            <span className="inline-flex items-center gap-1 font-mono tabular-nums">
              <span className="text-[10px] text-slate-500">T</span>
              <span className="min-w-[46px] text-right font-medium text-white">
                {formatSimTime(snapshot.simTime)}
              </span>
            </span>
            {snapshot.isAutoSlowMoActive && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/35 bg-amber-500/[0.14] px-1.5 py-[1px] text-[10px] font-medium text-amber-300">
                <Gauge className="h-3 w-3 animate-pulse" />
                近距慢动作
              </span>
            )}
            {snapshot.substepClamped && (
              <span className="inline-flex items-center gap-1 rounded-full border border-rose-400/35 bg-rose-500/[0.14] px-1.5 py-[1px] text-[10px] font-medium text-rose-300">
                <ShieldAlert className="h-3 w-3" />
                步长保护
              </span>
            )}
          </div>
        )}
      </div>

      {/* 桌面端（>= 768px）：288px 左右可折叠黑曜石侧栏 */}
      {!isMobile && (
        <>
          <ControlPanel
            snapshot={snapshot}
            actions={actions}
            collapsed={leftCollapsed}
            onToggleCollapse={() => setLeftCollapsed((prev) => !prev)}
          />

          <TelemetryPanel
            snapshot={snapshot}
            actions={actions}
            collapsed={rightCollapsed}
            chartsActive={!rightCollapsed}
            onToggleCollapse={() => setRightCollapsed((prev) => !prev)}
          />
        </>
      )}

      {/* 移动端（< 768px）：最高 55vh Bottom Sheet */}
      {isMobile && (
        <MobileBottomSheet
          snapshot={snapshot}
          actions={actions}
          activeTab={mobileSheet}
          onChangeTab={(tab) => setMobileSheet(tab)}
          onClose={() => setMobileSheet(null)}
        />
      )}

      {/* 底部居中悬浮控制坞 */}
      <footer className="pointer-events-none fixed inset-x-2.5 bottom-2.5 z-30 flex justify-center md:inset-x-3 md:bottom-3">
        <TimelineBar
          snapshot={snapshot}
          actions={actions}
          isMobile={isMobile}
          activeSheet={mobileSheet}
          onToggleSheet={handleToggleMobileSheet}
        />
      </footer>
    </div>
  );
};
