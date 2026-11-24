import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Trash2 } from 'lucide-react';
import type { BodyPatch, BodyState } from '../../types/contracts';
import { formatDraftNumber, formatMass } from '../formatters';

type FieldKey = 'name' | 'mass' | 'px' | 'py' | 'pz' | 'vx' | 'vy' | 'vz';

const QUICK_COLORS = [
  '#60a5fa',
  '#38bdf8',
  '#34d399',
  '#fde047',
  '#fb923c',
  '#f87171',
] as const;

export interface BodyEditorCardProps {
  readonly body: BodyState;
  readonly canDelete: boolean;
  readonly isExpanded: boolean;
  readonly touchFriendly?: boolean;
  readonly onToggleExpand: () => void;
  readonly onUpdate: (bodyId: string, patch: BodyPatch) => void;
  readonly onRemove: (bodyId: string) => void;
}

/**
 * 航天极简手风琴天体编辑器卡片
 * - 默认折叠态仅展示「色标圆点 + 名称 + 质量」及删除/展开按钮（无杂乱外发光）
 * - 点击展开显示名称、质量、位置/速度 6 个数值框、快速选色与“应用”按钮
 * - 本地受控草稿防抖机制：失焦 / 回车 / 点击“应用”提交 `updateBody`，不被 8~15Hz 遥测打断
 */
export const BodyEditorCard: React.FC<BodyEditorCardProps> = ({
  body,
  canDelete,
  isExpanded,
  touchFriendly = false,
  onToggleExpand,
  onUpdate,
  onRemove,
}) => {
  const [drafts, setDrafts] = useState<Partial<Record<FieldKey, string>>>({});
  const [invalidFields, setInvalidFields] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [appliedFlash, setAppliedFlash] = useState(false);
  const flashTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isExpanded) {
      setDrafts({});
      setInvalidFields({});
    }
  }, [isExpanded]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
    };
  }, []);

  const getLiveString = (key: FieldKey, forEditing: boolean): string => {
    const precision = forEditing ? 7 : 4;
    switch (key) {
      case 'name':
        return body.name;
      case 'mass':
        return formatDraftNumber(body.mass, precision);
      case 'px':
        return formatDraftNumber(body.position[0], precision);
      case 'py':
        return formatDraftNumber(body.position[1], precision);
      case 'pz':
        return formatDraftNumber(body.position[2], precision);
      case 'vx':
        return formatDraftNumber(body.velocity[0], precision);
      case 'vy':
        return formatDraftNumber(body.velocity[1], precision);
      case 'vz':
        return formatDraftNumber(body.velocity[2], precision);
    }
  };

  const getDisplayValue = (key: FieldKey): string => {
    const draft = drafts[key];
    return draft !== undefined ? draft : getLiveString(key, false);
  };

  const handleFocus = (key: FieldKey) => {
    setDrafts((prev) => {
      if (prev[key] !== undefined) return prev;
      return { ...prev, [key]: getLiveString(key, true) };
    });
  };

  const handleChange = (key: FieldKey, value: string) => {
    setDrafts((prev) => ({ ...prev, [key]: value }));
    setInvalidFields((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const triggerAppliedFeedback = () => {
    setAppliedFlash(true);
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
    }
    flashTimerRef.current = window.setTimeout(() => {
      setAppliedFlash(false);
      flashTimerRef.current = null;
    }, 1100);
  };

  const commitDrafts = (targetKeys?: readonly FieldKey[], revertInvalid = false) => {
    const keysToProcess: FieldKey[] = targetKeys
      ? [...targetKeys]
      : (Object.keys(drafts) as FieldKey[]);

    if (keysToProcess.length === 0) return;

    const patch: {
      name?: string;
      mass?: number;
      position?: [number, number, number];
      velocity?: [number, number, number];
    } = {};

    const nextInvalid: Partial<Record<FieldKey, boolean>> = { ...invalidFields };
    const clearedKeys: FieldKey[] = [];

    const parseFinite = (raw: string): number | null => {
      const trimmed = raw.trim();
      if (trimmed === '') return null;
      const num = Number(trimmed);
      return Number.isFinite(num) ? num : null;
    };

    let posModified = false;
    const nextPos: [number, number, number] = [
      body.position[0],
      body.position[1],
      body.position[2],
    ];

    let velModified = false;
    const nextVel: [number, number, number] = [
      body.velocity[0],
      body.velocity[1],
      body.velocity[2],
    ];

    for (const key of keysToProcess) {
      const raw = drafts[key];
      if (raw === undefined) continue;

      if (key === 'name') {
        const trimmed = raw.trim();
        if (trimmed.length === 0) {
          if (revertInvalid) {
            clearedKeys.push(key);
            delete nextInvalid[key];
          } else {
            nextInvalid[key] = true;
          }
        } else {
          if (trimmed !== body.name) {
            patch.name = trimmed;
          }
          clearedKeys.push(key);
          delete nextInvalid[key];
        }
        continue;
      }

      if (key === 'mass') {
        const num = parseFinite(raw);
        if (num === null || num <= 0) {
          if (revertInvalid) {
            clearedKeys.push(key);
            delete nextInvalid[key];
          } else {
            nextInvalid[key] = true;
          }
        } else {
          if (num !== body.mass) {
            patch.mass = num;
          }
          clearedKeys.push(key);
          delete nextInvalid[key];
        }
        continue;
      }

      const num = parseFinite(raw);
      if (num === null) {
        if (revertInvalid) {
          clearedKeys.push(key);
          delete nextInvalid[key];
        } else {
          nextInvalid[key] = true;
        }
        continue;
      }

      delete nextInvalid[key];
      clearedKeys.push(key);

      if (key === 'px') {
        if (num !== body.position[0]) {
          nextPos[0] = num;
          posModified = true;
        }
      } else if (key === 'py') {
        if (num !== body.position[1]) {
          nextPos[1] = num;
          posModified = true;
        }
      } else if (key === 'pz') {
        if (num !== body.position[2]) {
          nextPos[2] = num;
          posModified = true;
        }
      } else if (key === 'vx') {
        if (num !== body.velocity[0]) {
          nextVel[0] = num;
          velModified = true;
        }
      } else if (key === 'vy') {
        if (num !== body.velocity[1]) {
          nextVel[1] = num;
          velModified = true;
        }
      } else if (key === 'vz') {
        if (num !== body.velocity[2]) {
          nextVel[2] = num;
          velModified = true;
        }
      }
    }

    if (posModified) patch.position = nextPos;
    if (velModified) patch.velocity = nextVel;

    setInvalidFields(nextInvalid);

    if (clearedKeys.length > 0) {
      setDrafts((prev) => {
        const next = { ...prev };
        for (const key of clearedKeys) {
          delete next[key];
        }
        return next;
      });
    }

    if (
      patch.name !== undefined ||
      patch.mass !== undefined ||
      patch.position !== undefined ||
      patch.velocity !== undefined
    ) {
      onUpdate(body.id, patch);
      triggerAppliedFeedback();
    }
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    key: FieldKey
  ) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitDrafts(undefined, false);
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setInvalidFields((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      e.currentTarget.blur();
    }
  };

  const handleBlur = (key: FieldKey) => {
    commitDrafts([key], true);
  };

  const hasPendingDrafts = Object.keys(drafts).length > 0;
  const isPlanet = body.role === 'planet';
  const safeHexColor = /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : '#38bdf8';

  const inputBaseClass = (key: FieldKey) =>
    `w-full select-text rounded-md border px-2 font-mono text-[11px] tabular-nums text-white outline-none transition-colors ${
      touchFriendly ? 'min-h-[38px] py-1.5' : 'py-1'
    } ${
      invalidFields[key]
        ? 'border-rose-400/70 bg-rose-500/10'
        : drafts[key] !== undefined
          ? 'border-sky-400/60 bg-white/[0.06]'
          : 'border-white/[0.08] bg-black/40 hover:border-white/[0.16] focus:border-sky-400/60'
    }`;

  return (
    <div
      className={`rounded-lg border transition-colors ${
        isExpanded
          ? 'border-white/[0.14] bg-white/[0.04]'
          : 'border-white/[0.06] bg-white/[0.015] hover:border-white/[0.12]'
      }`}
    >
      {/* 手风琴极简折叠行：仅展示「色标圆点 + 名称 + 质量」及删除/展开按钮 */}
      <div
        className={`flex items-center justify-between gap-1.5 px-2.5 ${
          touchFriendly ? 'min-h-[44px] py-1' : 'py-1.5'
        }`}
      >
        <button
          type="button"
          onClick={onToggleExpand}
          className={`flex min-w-0 flex-1 items-center gap-2 text-left ${
            touchFriendly ? 'min-h-[40px]' : ''
          }`}
        >
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: safeHexColor }}
          />
          <span className="truncate text-xs font-medium text-white">
            {body.name}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <span className="min-w-[44px] text-right font-mono text-[11px] tabular-nums text-slate-400">
            {formatMass(body.mass)}
          </span>
          <button
            type="button"
            disabled={!canDelete}
            title={canDelete ? '删除此天体' : '系统至少保留 2 颗天体'}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(body.id);
            }}
            className={`inline-flex items-center justify-center rounded-md transition-colors ${
              touchFriendly ? 'min-h-[40px] min-w-[40px]' : 'h-6 w-6'
            } ${
              canDelete
                ? 'text-slate-500 hover:bg-rose-500/15 hover:text-rose-300'
                : 'cursor-not-allowed text-slate-700'
            }`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onToggleExpand}
            aria-label={isExpanded ? '收起参数' : '展开参数'}
            className={`inline-flex items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200 ${
              touchFriendly ? 'min-h-[40px] min-w-[40px]' : 'h-6 w-6'
            }`}
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform duration-200 ${
                isExpanded ? 'rotate-180' : ''
              }`}
            />
          </button>
        </div>
      </div>

      {/* 展开后的参数表单 */}
      {isExpanded && (
        <div className="space-y-2 border-t border-white/[0.06] px-2.5 py-2.5">
          {/* 角色元信息微标 */}
          <div className="flex items-center gap-1.5 text-[10px]">
            <span
              className={`rounded border px-1.5 py-0.5 font-medium ${
                isPlanet
                  ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-white/[0.1] bg-white/[0.05] text-slate-300'
              }`}
            >
              {isPlanet ? '三体行星' : '恒星'}
            </span>
            {isPlanet && body.isTestParticle && (
              <span className="rounded border border-sky-400/25 bg-sky-500/10 px-1.5 py-0.5 text-sky-300">
                零反作用测试粒子
              </span>
            )}
          </div>

          {/* 名称 + 质量 */}
          <div className="grid grid-cols-5 gap-1.5">
            <label className="col-span-3 space-y-1">
              <span className="block text-[10px] text-slate-400">名称</span>
              <input
                type="text"
                value={getDisplayValue('name')}
                onFocus={() => handleFocus('name')}
                onChange={(e) => handleChange('name', e.target.value)}
                onBlur={() => handleBlur('name')}
                onKeyDown={(e) => handleKeyDown(e, 'name')}
                className={`w-full select-text rounded-md border px-2 text-[11px] text-white outline-none transition-colors ${
                  touchFriendly ? 'min-h-[38px] py-1.5' : 'py-1'
                } ${
                  invalidFields.name
                    ? 'border-rose-400/70 bg-rose-500/10'
                    : drafts.name !== undefined
                      ? 'border-sky-400/60 bg-white/[0.06]'
                      : 'border-white/[0.08] bg-black/40 focus:border-sky-400/60'
                }`}
              />
            </label>
            <label className="col-span-2 space-y-1">
              <span className="block text-[10px] text-slate-400">质量 (M)</span>
              <input
                type="text"
                inputMode="decimal"
                value={getDisplayValue('mass')}
                onFocus={() => handleFocus('mass')}
                onChange={(e) => handleChange('mass', e.target.value)}
                onBlur={() => handleBlur('mass')}
                onKeyDown={(e) => handleKeyDown(e, 'mass')}
                className={inputBaseClass('mass')}
              />
            </label>
          </div>

          {/* 位置 (X, Y, Z) */}
          <div className="space-y-1">
            <span className="block text-[10px] text-slate-400">位置 (X, Y, Z)</span>
            <div className="grid grid-cols-3 gap-1">
              {(['px', 'py', 'pz'] as const).map((key, idx) => (
                <div key={key} className="relative">
                  <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 font-mono text-[9px] text-slate-500">
                    {['X', 'Y', 'Z'][idx]}
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={getDisplayValue(key)}
                    onFocus={() => handleFocus(key)}
                    onChange={(e) => handleChange(key, e.target.value)}
                    onBlur={() => handleBlur(key)}
                    onKeyDown={(e) => handleKeyDown(e, key)}
                    className={`${inputBaseClass(key)} pl-4`}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* 速度 (Vx, Vy, Vz) */}
          <div className="space-y-1">
            <span className="block text-[10px] text-slate-400">速度 (Vx, Vy, Vz)</span>
            <div className="grid grid-cols-3 gap-1">
              {(['vx', 'vy', 'vz'] as const).map((key, idx) => (
                <div key={key} className="relative">
                  <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 font-mono text-[9px] text-slate-500">
                    {['Vx', 'Vy', 'Vz'][idx]}
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={getDisplayValue(key)}
                    onFocus={() => handleFocus(key)}
                    onChange={(e) => handleChange(key, e.target.value)}
                    onBlur={() => handleBlur(key)}
                    onKeyDown={(e) => handleKeyDown(e, key)}
                    className={`${inputBaseClass(key)} pl-5`}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* 快速选色 + 应用按钮 */}
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <div className="flex items-center gap-1.5">
              <label
                className={`relative flex cursor-pointer items-center gap-1 rounded-md border border-white/[0.08] bg-black/40 px-1.5 hover:border-white/[0.18] ${
                  touchFriendly ? 'min-h-[40px]' : 'py-1'
                }`}
              >
                <input
                  type="color"
                  value={safeHexColor}
                  onChange={(e) => onUpdate(body.id, { color: e.target.value })}
                  className="h-3.5 w-3.5 cursor-pointer rounded border-0 bg-transparent p-0"
                />
                <span className="font-mono text-[10px] uppercase text-slate-300">
                  {safeHexColor}
                </span>
              </label>
              <div className="flex items-center gap-0.5">
                {QUICK_COLORS.slice(0, touchFriendly ? 3 : 5).map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    title={`切换颜色 ${hex}`}
                    onClick={() => onUpdate(body.id, { color: hex })}
                    className={`inline-flex items-center justify-center rounded-md ${
                      touchFriendly ? 'min-h-[40px] min-w-[40px]' : 'h-5 w-5'
                    }`}
                  >
                    <span
                      className={`h-3.5 w-3.5 rounded-full border transition-transform hover:scale-110 ${
                        safeHexColor.toLowerCase() === hex
                          ? 'scale-110 border-white'
                          : 'border-white/20'
                      }`}
                      style={{ backgroundColor: hex }}
                    />
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commitDrafts(undefined, false)}
              className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 text-[11px] font-medium transition-colors ${
                touchFriendly ? 'min-h-[40px]' : 'py-1'
              } ${
                appliedFlash
                  ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                  : hasPendingDrafts
                    ? 'border-sky-400/50 bg-sky-400/20 text-white hover:bg-sky-400/30'
                    : 'border-white/[0.12] bg-white/[0.06] text-slate-200 hover:border-white/20 hover:bg-white/[0.10]'
              }`}
            >
              <Check className="h-3 w-3" />
              {appliedFlash ? '已应用' : '应用'}
            </button>
          </div>

          {Object.keys(invalidFields).length > 0 && (
            <p className="text-[10px] text-rose-400">
              请输入有效数值（质量须大于 0，位置与速度须为有限实数）。
            </p>
          )}
        </div>
      )}
    </div>
  );
};
