import React from 'react';
import { Activity, Sliders, X } from 'lucide-react';
import type { HudSnapshot, SimulationActions } from '../types/contracts';
import { ControlPanelContent } from './ControlPanel';
import { SegmentedControl } from './components/HudPrimitives';
import { TelemetryPanelContent } from './TelemetryPanel';

export type MobileSheetTab = 'control' | 'telemetry';

export interface MobileBottomSheetProps {
  readonly snapshot: HudSnapshot;
  readonly actions: SimulationActions;
  readonly activeTab: MobileSheetTab | null;
  readonly onChangeTab: (tab: MobileSheetTab) => void;
  readonly onClose: () => void;
}

const SHEET_TABS: ReadonlyArray<{
  readonly value: MobileSheetTab;
  readonly label: string;
  readonly icon: React.ReactNode;
}> = [
  { value: 'control', label: '控制', icon: <Sliders className="h-3.5 w-3.5" /> },
  { value: 'telemetry', label: '遥测', icon: <Activity className="h-3.5 w-3.5" /> },
];

/**
 * 移动端专属 Bottom Sheet（< 768px）
 * - 最高 max-h-[55vh]，深黑曜石纯半透明 bg-[#070A12]/[0.92]（严禁任何 backdrop-blur）
 * - 顶部含拖动手柄条、控制/遥测分段切换与关闭按钮，内部触控热区均 >= 40px
 * - 仅当 activeTab === 'telemetry' 时激活两张 <canvas> 图表重绘
 */
export const MobileBottomSheet: React.FC<MobileBottomSheetProps> = ({
  snapshot,
  actions,
  activeTab,
  onChangeTab,
  onClose,
}) => {
  const isOpen = activeTab !== null;

  return (
    <div
      aria-hidden={!isOpen}
      className={`pointer-events-none fixed inset-x-2 bottom-[66px] z-20 flex flex-col justify-end transition-all duration-300 ease-out ${
        isOpen ? 'translate-y-0 opacity-100' : 'translate-y-[calc(100%+76px)] opacity-0'
      }`}
    >
      <section
        className={`flex max-h-[55vh] w-full flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#070A12]/[0.92] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_16px_44px_rgba(0,0,0,0.75)] ${
          isOpen ? 'pointer-events-auto' : 'pointer-events-none'
        }`}
      >
        {/* 顶部拖动手柄条 + 分段切换 + 关闭按钮 */}
        <div className="shrink-0 border-b border-white/[0.07] px-3 pb-2.5 pt-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="收起抽屉"
            className="mx-auto mb-2 flex h-4 w-16 items-center justify-center"
          >
            <span className="h-1 w-10 rounded-full bg-white/20" />
          </button>

          <div className="flex items-center gap-2">
            <div className="flex-1">
              <SegmentedControl
                value={activeTab ?? 'control'}
                options={SHEET_TABS}
                pill
                touchFriendly
                onChange={onChangeTab}
              />
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="关闭面板"
              className="inline-flex min-h-[40px] min-w-[40px] shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.04] text-slate-300 active:bg-white/[0.12] active:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* 可滚动内容区（按当前页签渲染，仅遥测页激活 Canvas 重绘） */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-3">
          {activeTab === 'control' && (
            <ControlPanelContent
              snapshot={snapshot}
              actions={actions}
              touchFriendly
            />
          )}
          {activeTab === 'telemetry' && (
            <TelemetryPanelContent
              snapshot={snapshot}
              actions={actions}
              chartsActive={activeTab === 'telemetry'}
              touchFriendly
            />
          )}
        </div>
      </section>
    </div>
  );
};
