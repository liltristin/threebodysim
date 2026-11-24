import React, { useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Cpu,
  Crosshair,
  Gauge,
  Globe,
  Plus,
  Shuffle,
  Sliders,
  Sparkles,
  StepForward,
} from 'lucide-react';
import { PRESET_MAP } from '../presets/presets';
import {
  MAX_BODIES,
  MIN_BODIES,
  type HudSnapshot,
  type IntegratorType,
  type SimulationActions,
} from '../types/contracts';
import { BodyEditorCard } from './components/BodyEditorCard';
import {
  PanelSection,
  SciFiSlider,
  SegmentedControl,
  ToggleSwitch,
} from './components/HudPrimitives';
import { formatFixed } from './formatters';

export interface ControlPanelContentProps {
  readonly snapshot: HudSnapshot;
  readonly actions: SimulationActions;
  /** 移动端 Bottom Sheet 模式：放大触控热区至 >= 40px 并补充倍速/单步/随机控制 */
  readonly touchFriendly?: boolean;
}

const INTEGRATOR_OPTIONS: ReadonlyArray<{
  readonly value: IntegratorType;
  readonly label: string;
  readonly subLabel: string;
}> = [
  { value: 'dopri54', label: 'DOPRI5(4)', subLabel: '自适应精度' },
  { value: 'verlet', label: 'Verlet', subLabel: '辛积分保能' },
];

/**
 * 控制面板可复用内容主体（同时用于桌面左侧栏与移动端 Bottom Sheet 控制页）
 */
export const ControlPanelContent: React.FC<ControlPanelContentProps> = ({
  snapshot,
  actions,
  touchFriendly = false,
}) => {
  const [expandedBodyId, setExpandedBodyId] = useState<string | null>(null);

  const {
    bodies,
    config,
    presetId,
    collisionEvents,
    metrics,
    effectiveTimeScale,
    isAutoSlowMoActive,
  } = snapshot;
  const hasPlanet = bodies.some((b) => b.role === 'planet');
  const canAddBody = bodies.length < MAX_BODIES;
  const canDeleteBody = bodies.length > MIN_BODIES;
  const activePreset = presetId ? PRESET_MAP[presetId] : undefined;
  const needsZeroSofteningHint =
    activePreset !== undefined &&
    activePreset.defaultSoftening === 0 &&
    config.softening > 0;

  const comDriftMag = Math.hypot(
    metrics.centerOfMass[0],
    metrics.centerOfMass[1],
    metrics.centerOfMass[2]
  );

  const maxScale = Math.max(5.0, config.timeScale);

  return (
    <div className="space-y-2.5">
      {/* 移动端专属快捷仿真控制（倍速 / 单步 / 自动慢动作 / 随机生成） */}
      {touchFriendly && (
        <PanelSection
          title="时间与生成控制"
          icon={<Gauge className="h-3.5 w-3.5" />}
          touchFriendly
        >
          <SciFiSlider
            label="时间倍速"
            value={config.timeScale}
            min={0.05}
            max={maxScale}
            step={0.05}
            displayValue={
              isAutoSlowMoActive
                ? `${config.timeScale.toFixed(2)}x (有效 ${effectiveTimeScale.toFixed(2)}x)`
                : `${config.timeScale.toFixed(2)}x`
            }
            accent={isAutoSlowMoActive ? 'amber' : 'sky'}
            actionSlot={
              <button
                type="button"
                onClick={() => actions.setTimeScale(1.0)}
                className="min-h-[40px] min-w-[44px] rounded-md border border-white/[0.1] bg-white/[0.05] px-2 font-mono text-[11px] text-slate-300 active:bg-white/[0.12]"
              >
                1.0x
              </button>
            }
            onChange={actions.setTimeScale}
          />

          <ToggleSwitch
            label="近距自动慢动作"
            description="天体近距交汇时自动平滑降速"
            checked={config.enableAutoSlowMo}
            touchFriendly
            onChange={actions.setAutoSlowMo}
          />

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => actions.stepOnce()}
              className="inline-flex min-h-[42px] items-center justify-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.04] px-3 text-xs font-medium text-white active:bg-white/[0.12]"
            >
              <StepForward className="h-3.5 w-3.5 text-slate-300" />
              单步推进
            </button>
            <button
              type="button"
              onClick={() => actions.randomize()}
              className="inline-flex min-h-[42px] items-center justify-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.04] px-3 text-xs font-medium text-white active:bg-white/[0.12]"
            >
              <Shuffle className="h-3.5 w-3.5 text-sky-400" />
              随机生成
            </button>
          </div>
        </PanelSection>
      )}

      {/* 1. 物理引擎与数值设置 */}
      <PanelSection
        title="物理引擎与数值设置"
        icon={<Cpu className="h-3.5 w-3.5" />}
        touchFriendly={touchFriendly}
      >
        {/* 积分器分段胶囊 */}
        <div className="space-y-1.5">
          <span className="block text-[11px] font-medium text-slate-400">数值积分器</span>
          <SegmentedControl
            value={config.integrator}
            options={INTEGRATOR_OPTIONS}
            touchFriendly={touchFriendly}
            onChange={actions.setIntegrator}
          />
        </div>

        {/* 引力软化滑块 */}
        <div className="rounded-lg border border-white/[0.06] bg-black/30 px-2.5 py-2">
          <SciFiSlider
            label="引力软化项 (ε)"
            value={config.softening}
            min={0}
            max={0.1}
            step={0.001}
            displayValue={config.softening.toFixed(3)}
            accent={needsZeroSofteningHint ? 'amber' : 'sky'}
            actionSlot={
              <button
                type="button"
                disabled={config.softening === 0}
                onClick={() => actions.setSoftening(0)}
                className={`rounded-md border text-[10px] font-medium transition-colors ${
                  touchFriendly ? 'min-h-[40px] min-w-[44px] px-2.5' : 'px-1.5 py-0.5'
                } ${
                  config.softening === 0
                    ? 'cursor-default border-white/[0.06] bg-transparent text-slate-600'
                    : 'border-white/[0.14] bg-white/[0.08] text-white hover:bg-white/[0.14]'
                }`}
              >
                归零
              </button>
            }
            hint={
              needsZeroSofteningHint
                ? '当前为精密周期解预设，推荐软化归零（0.000）防止势能畸变。'
                : '精密周期解推荐设为 0；混沌近距交汇可适度增大。'
            }
            onChange={actions.setSoftening}
          />
        </div>

        {/* 天体碰撞合并开关 */}
        <ToggleSwitch
          label="天体碰撞合并"
          description="物理碰撞半径相交时执行完全非弹性合并"
          checked={config.enableCollisions}
          touchFriendly={touchFriendly}
          onChange={actions.setEnableCollisions}
          badge={
            <span
              className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${
                collisionEvents.length > 0
                  ? 'border border-amber-400/35 bg-amber-500/15 text-amber-300'
                  : 'bg-white/[0.06] text-slate-400'
              }`}
            >
              {collisionEvents.length} 次
            </span>
          }
        />

        {/* 行星零反作用测试粒子开关 */}
        <ToggleSwitch
          label="行星零反作用测试粒子"
          description={
            hasPlanet
              ? '行星仅受力运动，不对恒星施加反作用力'
              : '当前场景无三体行星'
          }
          checked={config.planetAsTestParticle}
          disabled={!hasPlanet}
          touchFriendly={touchFriendly}
          onChange={actions.setPlanetAsTestParticle}
        />

        {/* 一键消除质心漂移 */}
        <button
          type="button"
          onClick={actions.normalizeCenterOfMass}
          className={`flex w-full items-center justify-between gap-2 rounded-lg border border-white/[0.1] bg-white/[0.04] px-2.5 text-xs font-medium text-white transition-colors hover:border-white/[0.18] hover:bg-white/[0.08] ${
            touchFriendly ? 'min-h-[44px]' : 'py-1.5'
          }`}
        >
          <span className="flex items-center gap-1.5">
            <Crosshair className="h-3.5 w-3.5 text-sky-400" />
            <span>质心静止归零 (CoM)</span>
          </span>
          <span className="font-mono text-[10px] tabular-nums text-slate-400">
            |R|={formatFixed(comDriftMag, 3)}
          </span>
        </button>
      </PanelSection>

      {/* 2. 天体管理与手风琴参数编辑器 */}
      <PanelSection
        title="天体管理与参数"
        icon={<Sparkles className="h-3.5 w-3.5" />}
        touchFriendly={touchFriendly}
        badge={
          <span className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-slate-300">
            {bodies.length}/{MAX_BODIES}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            disabled={!canAddBody}
            onClick={() => actions.addBody()}
            title={canAddBody ? '新增一颗恒星' : `已达上限（最多 ${MAX_BODIES} 颗）`}
            className={`inline-flex items-center justify-center gap-1 rounded-lg border px-2 text-xs font-medium transition-colors ${
              touchFriendly ? 'min-h-[44px]' : 'py-1.5'
            } ${
              canAddBody
                ? 'border-white/[0.1] bg-white/[0.05] text-white hover:border-white/[0.2] hover:bg-white/[0.10]'
                : 'cursor-not-allowed border-white/[0.04] bg-white/[0.015] text-slate-600'
            }`}
          >
            <Plus className="h-3.5 w-3.5 text-sky-400" />
            <span>新增恒星</span>
          </button>

          <button
            type="button"
            disabled={!canAddBody || hasPlanet}
            onClick={actions.addTrisolarisPlanet}
            title={
              hasPlanet
                ? '当前已存在三体行星'
                : !canAddBody
                  ? `已达上限（最多 ${MAX_BODIES} 颗）`
                  : '添加三体行星并开启热力学与纪元监控'
            }
            className={`inline-flex items-center justify-center gap-1 rounded-lg border px-2 text-xs font-medium transition-colors ${
              touchFriendly ? 'min-h-[44px]' : 'py-1.5'
            } ${
              canAddBody && !hasPlanet
                ? 'border-emerald-400/25 bg-emerald-500/[0.09] text-emerald-200 hover:border-emerald-400/45 hover:bg-emerald-500/[0.16]'
                : 'cursor-not-allowed border-white/[0.04] bg-white/[0.015] text-slate-600'
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
            <span>三体行星</span>
          </button>
        </div>

        <div className="space-y-1.5">
          {bodies.map((body) => (
            <BodyEditorCard
              key={body.id}
              body={body}
              canDelete={canDeleteBody}
              isExpanded={expandedBodyId === body.id}
              touchFriendly={touchFriendly}
              onToggleExpand={() =>
                setExpandedBodyId((prev) => (prev === body.id ? null : body.id))
              }
              onUpdate={actions.updateBody}
              onRemove={(id) => {
                if (expandedBodyId === id) setExpandedBodyId(null);
                actions.removeBody(id);
              }}
            />
          ))}
        </div>
      </PanelSection>
    </div>
  );
};

export interface ControlPanelProps {
  readonly snapshot: HudSnapshot;
  readonly actions: SimulationActions;
  readonly collapsed: boolean;
  readonly onToggleCollapse: () => void;
}

/**
 * 桌面端可折叠左侧栏（288px 航天极简黑曜石玻璃）
 */
export const ControlPanel: React.FC<ControlPanelProps> = ({
  snapshot,
  actions,
  collapsed,
  onToggleCollapse,
}) => {
  return (
    <div className="pointer-events-none fixed bottom-[76px] left-3 top-[64px] z-20">
      {collapsed && (
        <button
          type="button"
          onClick={onToggleCollapse}
          title="展开控制面板"
          className="pointer-events-auto absolute left-0 top-0 flex items-center gap-1.5 rounded-xl border border-white/[0.08] bg-[#070A12]/[0.92] px-2 py-2.5 text-xs font-medium text-slate-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_12px_36px_rgba(0,0,0,0.55)] transition-colors hover:border-white/[0.18] hover:text-white md:bg-[#070A12]/80 md:backdrop-blur-md"
        >
          <Sliders className="h-3.5 w-3.5 text-sky-400" />
          <span className="[writing-mode:vertical-rl] tracking-widest">控制</span>
          <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
        </button>
      )}

      <aside
        aria-hidden={collapsed}
        className={`flex h-full w-[288px] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#070A12]/[0.92] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_12px_36px_rgba(0,0,0,0.55)] transition-all duration-300 ease-out md:bg-[#070A12]/80 md:backdrop-blur-md ${
          collapsed
            ? 'pointer-events-none -translate-x-[calc(100%+20px)] opacity-0'
            : 'pointer-events-auto translate-x-0 opacity-100'
        }`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/[0.07] px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Sliders className="h-3.5 w-3.5 text-sky-400" />
            <span className="text-xs font-semibold tracking-wider text-white">
              物理与天体控制
            </span>
          </div>
          <button
            type="button"
            onClick={onToggleCollapse}
            title="折叠左侧栏"
            className="inline-flex h-6 items-center gap-0.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 text-[11px] text-slate-400 transition-colors hover:border-white/[0.16] hover:text-white"
          >
            <ChevronLeft className="h-3 w-3" />
            <span>收起</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2.5">
          <ControlPanelContent snapshot={snapshot} actions={actions} />
        </div>
      </aside>
    </div>
  );
};
