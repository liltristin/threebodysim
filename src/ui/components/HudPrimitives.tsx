import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface ToggleSwitchProps {
  readonly label: string;
  readonly description?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly badge?: React.ReactNode;
  readonly onChange: (checked: boolean) => void;
}

/** 深空科幻紧凑开关行 */
export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
  label,
  description,
  checked,
  disabled = false,
  badge,
  onChange,
}) => {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`group flex w-full items-center justify-between gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
        disabled
          ? 'cursor-not-allowed border-slate-800/70 bg-slate-900/30 opacity-50'
          : checked
            ? 'border-cyan-500/35 bg-cyan-500/10 hover:border-cyan-400/50'
            : 'border-slate-800/80 bg-slate-900/50 hover:border-slate-700 hover:bg-slate-900/80'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-slate-200">{label}</span>
          {badge}
        </div>
        {description && (
          <p className="mt-0.5 text-[10px] leading-snug text-slate-400">{description}</p>
        )}
      </div>
      <span
        className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors ${
          checked
            ? 'border-cyan-400/70 bg-cyan-500/40'
            : 'border-slate-700 bg-slate-800/90'
        }`}
      >
        <span
          className={`inline-block h-3 w-3 rounded-full transition-transform ${
            checked
              ? 'translate-x-[15px] bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.85)]'
              : 'translate-x-[2px] bg-slate-400'
          }`}
        />
      </span>
    </button>
  );
};

export interface SciFiSliderProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly displayValue: string;
  readonly disabled?: boolean;
  readonly actionSlot?: React.ReactNode;
  readonly hint?: string;
  readonly accent?: 'cyan' | 'amber';
  readonly onChange: (value: number) => void;
}

/** 深空科幻数值滑块 */
export const SciFiSlider: React.FC<SciFiSliderProps> = ({
  label,
  value,
  min,
  max,
  step,
  displayValue,
  disabled = false,
  actionSlot,
  hint,
  accent = 'cyan',
  onChange,
}) => {
  const accentClass =
    accent === 'amber' ? 'accent-amber-400' : 'accent-cyan-400';

  return (
    <div className={`space-y-1.5 ${disabled ? 'opacity-50' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-300">{label}</span>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs tabular-nums text-cyan-300">
            {displayValue}
          </span>
          {actionSlot}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className={`h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-800/90 ${accentClass} disabled:cursor-not-allowed`}
      />
      {hint && <p className="text-[10px] leading-snug text-slate-400">{hint}</p>}
    </div>
  );
};

export interface PanelSectionProps {
  readonly title: string;
  readonly icon?: React.ReactNode;
  readonly badge?: React.ReactNode;
  readonly defaultOpen?: boolean;
  readonly accentBorder?: string;
  readonly children: React.ReactNode;
}

/** 面板内可折叠分区卡片 */
export const PanelSection: React.FC<PanelSectionProps> = ({
  title,
  icon,
  badge,
  defaultOpen = true,
  accentBorder = 'border-cyan-500/15',
  children,
}) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section
      className={`rounded-xl border ${accentBorder} bg-slate-900/45 transition-colors`}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-slate-800/35 rounded-t-xl"
      >
        <div className="flex min-w-0 items-center gap-2">
          {icon && <span className="text-cyan-400/90 shrink-0">{icon}</span>}
          <h3 className="truncate text-xs font-semibold tracking-wider text-slate-100">
            {title}
          </h3>
          {badge}
        </div>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      {open && <div className="space-y-2.5 border-t border-slate-800/70 px-3 py-2.5">{children}</div>}
    </section>
  );
};
