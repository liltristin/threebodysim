import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface ToggleSwitchProps {
  readonly label: string;
  readonly description?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly badge?: React.ReactNode;
  readonly touchFriendly?: boolean;
  readonly onChange: (checked: boolean) => void;
}

/** 航天极简开关行（克制黑曜石质感 + 移动端 >= 40px 触控热区） */
export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
  label,
  description,
  checked,
  disabled = false,
  badge,
  touchFriendly = false,
  onChange,
}) => {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`group flex w-full items-center justify-between gap-2.5 rounded-lg border px-2.5 text-left transition-colors ${
        touchFriendly ? 'min-h-[44px] py-2' : 'py-1.5'
      } ${
        disabled
          ? 'cursor-not-allowed border-white/[0.04] bg-white/[0.015] opacity-45'
          : checked
            ? 'border-white/[0.12] bg-white/[0.06] hover:border-white/[0.18]'
            : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.04]'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-slate-100">{label}</span>
          {badge}
        </div>
        {description && (
          <p className="mt-0.5 text-[10px] leading-snug text-slate-500">{description}</p>
        )}
      </div>
      <span
        className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors ${
          checked
            ? 'border-sky-400/50 bg-sky-400/75'
            : 'border-white/[0.12] bg-white/[0.08]'
        }`}
      >
        <span
          className={`inline-block h-3 w-3 rounded-full transition-transform ${
            checked
              ? 'translate-x-[15px] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.45)]'
              : 'translate-x-[2px] bg-slate-300'
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
  readonly accent?: 'sky' | 'amber';
  readonly onChange: (value: number) => void;
}

/** 航天极简精密滑块（对接 src/index.css `.aero-slider` 与 `--slider-pct`） */
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
  accent = 'sky',
  onChange,
}) => {
  const clamped = Math.min(max, Math.max(min, value));
  const pct = max > min ? ((clamped - min) / (max - min)) * 100 : 0;
  const sliderStyle = {
    '--slider-pct': `${pct.toFixed(2)}%`,
    ...(accent === 'amber'
      ? { '--slider-fill': 'rgba(251, 191, 36, 0.85)' }
      : {}),
  } as React.CSSProperties;

  return (
    <div className={`space-y-1 ${disabled ? 'opacity-45' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-slate-300">{label}</span>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px] tabular-nums text-white">
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
        value={clamped}
        disabled={disabled}
        style={sliderStyle}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="aero-slider"
      />
      {hint && <p className="text-[10px] leading-snug text-slate-500">{hint}</p>}
    </div>
  );
};

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly subLabel?: string;
  readonly icon?: React.ReactNode;
  readonly disabled?: boolean;
  readonly title?: string;
}

export interface SegmentedControlProps<T extends string> {
  readonly value: T;
  readonly options: readonly SegmentedOption<T>[];
  readonly onChange: (value: T) => void;
  readonly pill?: boolean;
  readonly compact?: boolean;
  readonly touchFriendly?: boolean;
  readonly className?: string;
}

/** 苹果/航天风暗轨分段胶囊控制器 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  pill = false,
  compact = false,
  touchFriendly = false,
  className = '',
}: SegmentedControlProps<T>): React.ReactElement {
  const outerRadius = pill ? 'rounded-full' : 'rounded-lg';
  const itemRadius = pill ? 'rounded-full' : 'rounded-md';

  return (
    <div
      role="radiogroup"
      className={`inline-flex w-full items-center gap-0.5 border border-white/[0.08] bg-white/[0.03] p-0.5 ${outerRadius} ${className}`}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const sizeClass = touchFriendly
          ? 'min-h-[40px] px-2.5 py-1.5 text-xs'
          : compact
            ? 'h-7 px-2 text-[11px]'
            : 'px-2 py-1.5 text-[11px]';

        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={opt.disabled}
            title={opt.title ?? opt.label}
            onClick={() => {
              if (!opt.disabled) onChange(opt.value);
            }}
            className={`flex flex-1 flex-col items-center justify-center border font-medium transition-colors ${itemRadius} ${sizeClass} ${
              opt.disabled
                ? 'cursor-not-allowed border-transparent text-slate-600'
                : active
                  ? 'border-white/20 bg-white/[0.12] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]'
                  : 'border-transparent text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
            }`}
          >
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              {opt.icon}
              <span>{opt.label}</span>
            </span>
            {opt.subLabel && (
              <span className="mt-0.5 text-[9.5px] font-normal text-slate-400">
                {opt.subLabel}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface PanelSectionProps {
  readonly title: string;
  readonly icon?: React.ReactNode;
  readonly badge?: React.ReactNode;
  readonly defaultOpen?: boolean;
  readonly touchFriendly?: boolean;
  readonly children: React.ReactNode;
}

/** 航天极简分区折叠卡（克制 1px 浅白发丝边框） */
export const PanelSection: React.FC<PanelSectionProps> = ({
  title,
  icon,
  badge,
  defaultOpen = true,
  touchFriendly = false,
  children,
}) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="rounded-xl border border-white/[0.07] bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`flex w-full items-center justify-between gap-2 rounded-t-xl px-3 text-left transition-colors hover:bg-white/[0.03] ${
          touchFriendly ? 'min-h-[44px] py-2.5' : 'py-2'
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          {icon && <span className="shrink-0 text-slate-400">{icon}</span>}
          <h3 className="truncate text-[11px] font-semibold tracking-wider text-white">
            {title}
          </h3>
          {badge}
        </div>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      {open && (
        <div className="space-y-2 border-t border-white/[0.06] px-2.5 py-2.5">
          {children}
        </div>
      )}
    </section>
  );
};
