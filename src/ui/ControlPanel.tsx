import React, { useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Cpu,
  Crosshair,
  Globe,
  Orbit,
  Plus,
  Sliders,
  Sparkles,
} from 'lucide-react';
import { PRESETS, PRESET_MAP } from '../presets/presets';
import {
  MAX_BODIES,
  MIN_BODIES,
  type HudSnapshot,
  type SimulationActions,
} from '../types/contracts';
import { BodyEditorCard } from './components/BodyEditorCard';
import { PanelSection, SciFiSlider, ToggleSwitch } from './components/HudPrimitives';
import { formatFixed } from './formatters';

export interface ControlPanelProps {
  readonly snapshot: HudSnapshot;
  readonly actions: SimulationActions;
  readonly collapsed: boolean;
  readonly onToggleCollapse: () => void;
}

/**
 * 可折叠左侧控制栏
 * - 经典预设库（5 套预设卡片）
 * - 物理引擎与数值设置（积分器、软化项、碰撞合并、行星测试粒子、CoM 归零）
 * - 天体管理与参数编辑器（2 ~ 8 颗，支持防抖本地草稿）
 */
export const ControlPanel: React.FC<ControlPanelProps> = ({
  snapshot,
  actions,
  collapsed,
  onToggleCollapse,
}) => {
  const [expandedBodyId, setExpandedBodyId] = useState<string | null>(null);

  const { bodies, config, presetId, collisionEvents, metrics } = snapshot;
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

  return (
    <div className="pointer-events-none fixed bottom-[78px] left-3 top-[66px] z-20">
      {/* 折叠状态下的边缘展开按钮 */}
      {collapsed && (
        <button
          type="button"
          onClick={onToggleCollapse}
          title="展开控制面板"
          className="pointer-events-auto absolute left-0 top-0 flex items-center gap-1.5 rounded-xl border border-cyan-500/30 bg-slate-950/80 px-2.5 py-2.5 text-xs font-medium text-cyan-200 shadow-[0_8px_28px_rgba(0,0,0,0.5)] backdrop-blur-md transition-all hover:border-cyan-400/60 hover:bg-slate-900/90"
        >
          <Sliders className="h-4 w-4 text-cyan-400" />
          <span className="[writing-mode:vertical-rl] tracking-widest">控制中心</span>
          <ChevronRight className="h-3.5 w-3.5 text-cyan-400" />
        </button>
      )}

      {/* 面板主体（平滑滑入/滑出） */}
      <aside
        aria-hidden={collapsed}
        className={`flex h-full w-[328px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-2xl border border-cyan-500/20 bg-slate-950/75 shadow-[0_12px_42px_rgba(0,0,0,0.55)] backdrop-blur-md transition-all duration-300 ease-out ${
          collapsed
            ? 'pointer-events-none -translate-x-[calc(100%+24px)] opacity-0'
            : 'pointer-events-auto translate-x-0 opacity-100'
        }`}
      >
        {/* 栏头 */}
        <div className="flex shrink-0 items-center justify-between border-b border-cyan-500/15 bg-slate-900/50 px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <Sliders className="h-4 w-4 text-cyan-400" />
            <span className="text-xs font-semibold tracking-wider text-slate-100">
              系统预设与物理控制
            </span>
          </div>
          <button
            type="button"
            onClick={onToggleCollapse}
            title="折叠左侧面板"
            className="inline-flex items-center gap-0.5 rounded-lg border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-[11px] text-slate-300 transition-colors hover:border-cyan-500/40 hover:text-cyan-200"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            <span>收起</span>
          </button>
        </div>

        {/* 滚动内容区 */}
        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          {/* 1. 经典预设库 */}
          <PanelSection
            title="经典预设库"
            icon={<Orbit className="h-3.5 w-3.5" />}
            badge={
              <span className="rounded bg-slate-800/90 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                {PRESETS.length} 套
              </span>
            }
          >
            <div className="space-y-2">
              {PRESETS.map((preset) => {
                const isActive = presetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => actions.loadPreset(preset.id)}
                    className={`group w-full rounded-xl border p-2.5 text-left transition-all ${
                      isActive
                        ? 'border-cyan-400/60 bg-cyan-500/15 shadow-[0_0_18px_rgba(34,211,238,0.12)]'
                        : 'border-slate-800/90 bg-slate-950/55 hover:border-cyan-500/35 hover:bg-slate-900/80'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              isActive
                                ? 'bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.95)]'
                                : 'bg-slate-600 group-hover:bg-cyan-400/70'
                            }`}
                          />
                          <span
                            className={`truncate text-xs font-semibold ${
                              isActive ? 'text-cyan-200' : 'text-slate-100'
                            }`}
                          >
                            {preset.name}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate pl-3 font-mono text-[10px] text-slate-400">
                          {preset.subtitle}
                        </p>
                      </div>

                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {preset.hasTrisolarisPlanet && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/45 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                            <Globe className="h-2.5 w-2.5" />
                            三体行星
                          </span>
                        )}
                        {preset.defaultSoftening === 0 && (
                          <span className="rounded border border-cyan-500/25 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[9px] text-cyan-300/90">
                            ε=0 精密
                          </span>
                        )}
                      </div>
                    </div>

                    <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-slate-400">
                      {preset.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </PanelSection>

          {/* 2. 物理引擎与数值设置 */}
          <PanelSection
            title="物理引擎与数值设置"
            icon={<Cpu className="h-3.5 w-3.5" />}
          >
            {/* 积分器切换 */}
            <div className="space-y-1.5">
              <span className="block text-[11px] font-medium text-slate-300">
                数值积分器
              </span>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => actions.setIntegrator('dopri54')}
                  className={`rounded-lg border px-2 py-2 text-left transition-all ${
                    config.integrator === 'dopri54'
                      ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-100 shadow-[0_0_12px_rgba(34,211,238,0.14)]'
                      : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                  }`}
                >
                  <div className="font-mono text-[11px] font-semibold">DOPRI5(4) 自适应</div>
                  <div className="mt-0.5 text-[10px] opacity-80">变步长高精度</div>
                </button>
                <button
                  type="button"
                  onClick={() => actions.setIntegrator('verlet')}
                  className={`rounded-lg border px-2 py-2 text-left transition-all ${
                    config.integrator === 'verlet'
                      ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-100 shadow-[0_0_12px_rgba(34,211,238,0.14)]'
                      : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                  }`}
                >
                  <div className="font-mono text-[11px] font-semibold">Velocity Verlet</div>
                  <div className="mt-0.5 text-[10px] opacity-80">辛积分无长期漂移</div>
                </button>
              </div>
            </div>

            {/* 引力软化滑块 */}
            <div className="rounded-lg border border-slate-800/80 bg-slate-950/50 p-2.5">
              <SciFiSlider
                label="引力软化项 (Softening ε)"
                value={config.softening}
                min={0}
                max={0.1}
                step={0.001}
                displayValue={config.softening.toFixed(3)}
                accent={needsZeroSofteningHint ? 'amber' : 'cyan'}
                actionSlot={
                  <button
                    type="button"
                    disabled={config.softening === 0}
                    onClick={() => actions.setSoftening(0)}
                    className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                      config.softening === 0
                        ? 'cursor-default border-slate-800 bg-slate-900/60 text-slate-500'
                        : 'border-cyan-500/40 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25'
                    }`}
                  >
                    归零
                  </button>
                }
                hint={
                  needsZeroSofteningHint
                    ? '提示：当前为精密周期解预设，建议软化归零（0.000）以防势能畸变退化为混沌。'
                    : '精密周期解（8字/拉格朗日/蝴蝶）推荐设为 0；混沌近距可适度增大。'
                }
                onChange={actions.setSoftening}
              />
            </div>

            {/* 天体碰撞合并开关 */}
            <ToggleSwitch
              label="天体碰撞合并"
              description="物理碰撞半径相交时执行完全非弹性动量守恒合并"
              checked={config.enableCollisions}
              onChange={actions.setEnableCollisions}
              badge={
                <span
                  className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${
                    collisionEvents.length > 0
                      ? 'border border-amber-400/45 bg-amber-500/20 text-amber-300'
                      : 'bg-slate-800/90 text-slate-400'
                  }`}
                >
                  已碰撞 {collisionEvents.length} 次
                </span>
              }
            />

            {/* 行星零反作用测试粒子开关 */}
            <ToggleSwitch
              label="行星零反作用测试粒子"
              description={
                hasPlanet
                  ? '开启后三体行星仅受力运动，不对恒星施加反作用力'
                  : '当前场景无三体行星（请先在下方添加三体行星）'
              }
              checked={config.planetAsTestParticle}
              disabled={!hasPlanet}
              onChange={actions.setPlanetAsTestParticle}
            />

            {/* 一键消除质心漂移 */}
            <button
              type="button"
              onClick={actions.normalizeCenterOfMass}
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-cyan-500/35 bg-cyan-500/10 px-3 py-2 text-xs font-medium text-cyan-200 transition-all hover:border-cyan-400/60 hover:bg-cyan-500/20"
            >
              <span className="flex items-center gap-1.5">
                <Crosshair className="h-3.5 w-3.5 text-cyan-300" />
                消除质心漂移 (CoM 归零)
              </span>
              <span className="font-mono text-[10px] tabular-nums text-cyan-300/80">
                |R|={formatFixed(comDriftMag, 3)}
              </span>
            </button>
          </PanelSection>

          {/* 3. 天体管理与参数编辑器（2 ~ 8 颗） */}
          <PanelSection
            title="天体管理与参数编辑"
            icon={<Sparkles className="h-3.5 w-3.5" />}
            badge={
              <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-cyan-300">
                {bodies.length} / {MAX_BODIES}
              </span>
            }
          >
            {/* 新增恒星 / 添加三体行星 */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={!canAddBody}
                onClick={() => actions.addBody()}
                title={canAddBody ? '新增一颗恒星' : `已达到上限（最多 ${MAX_BODIES} 颗）`}
                className={`inline-flex items-center justify-center gap-1 rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors ${
                  canAddBody
                    ? 'border-cyan-500/35 bg-cyan-500/10 text-cyan-200 hover:border-cyan-400/60 hover:bg-cyan-500/20'
                    : 'cursor-not-allowed border-slate-800 bg-slate-900/50 text-slate-600'
                }`}
              >
                <Plus className="h-3.5 w-3.5" />
                新增恒星
              </button>

              <button
                type="button"
                disabled={!canAddBody || hasPlanet}
                onClick={actions.addTrisolarisPlanet}
                title={
                  hasPlanet
                    ? '当前已存在三体行星'
                    : !canAddBody
                      ? `已达到上限（最多 ${MAX_BODIES} 颗）`
                      : '向系统添加三体行星并开启热力学与纪元监控'
                }
                className={`inline-flex items-center justify-center gap-1 rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors ${
                  canAddBody && !hasPlanet
                    ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200 hover:border-emerald-400/60 hover:bg-emerald-500/20'
                    : 'cursor-not-allowed border-slate-800 bg-slate-900/50 text-slate-600'
                }`}
              >
                <Globe className="h-3.5 w-3.5" />
                添加三体行星
              </button>
            </div>

            {/* 天体可展开列表 */}
            <div className="space-y-2">
              {bodies.map((body) => (
                <BodyEditorCard
                  key={body.id}
                  body={body}
                  canDelete={canDeleteBody}
                  isExpanded={expandedBodyId === body.id}
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
      </aside>
    </div>
  );
};
