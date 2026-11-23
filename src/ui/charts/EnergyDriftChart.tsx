import React, { useEffect, useRef, useState } from 'react';
import type { CollisionEvent, EnergyHistoryPoint } from '../../types/contracts';
import { formatSimTime } from '../formatters';

export interface EnergyDriftChartProps {
  readonly history: readonly EnergyHistoryPoint[];
  readonly collisionEvents: readonly CollisionEvent[];
  readonly height?: number;
}

const LOG_FLOOR = 1e-15;

/**
 * 轻量原生 <canvas> 相对能量漂移实时曲线图
 * - 支持高分屏 DPR 自适应
 * - 采用对数纵轴展示 |ΔE / E₀|，并叠加碰撞合并事件虚线竖线与标注
 */
export const EnergyDriftChart: React.FC<EnergyDriftChartProps> = ({
  history,
  collisionEvents,
  height = 114,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState<number>(280);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateWidth = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) {
        setWidth(Math.floor(rect.width));
      }
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const targetW = Math.max(1, Math.round(width * dpr));
    const targetH = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const padLeft = 46;
    const padRight = 10;
    const padTop = 18;
    const padBottom = 18;
    const plotW = Math.max(1, width - padLeft - padRight);
    const plotH = Math.max(1, height - padTop - padBottom);

    // 深空微暗绘图底板
    ctx.fillStyle = 'rgba(2, 6, 23, 0.58)';
    ctx.fillRect(padLeft, padTop, plotW, plotH);

    // 图表标题角标
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('log₁₀ |ΔE/E₀|', padLeft, 3);

    if (history.length < 2) {
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(padLeft + 0.5, padTop + 0.5, plotW - 1, plotH - 1);

      ctx.font = '11px "Microsoft YaHei", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('等待积分采样数据...', padLeft + plotW / 2, padTop + plotH / 2);
      return;
    }

    const tMin = history[0].simTime;
    const tMax = history[history.length - 1].simTime;
    const tSpan = Math.max(tMax - tMin, 1e-6);

    // 计算对数纵轴范围
    let minLog = Infinity;
    let maxLog = -Infinity;
    for (let i = 0; i < history.length; i++) {
      const absDrift = Math.abs(history[i].relativeDrift);
      const clamped = Number.isFinite(absDrift) ? Math.max(absDrift, LOG_FLOOR) : LOG_FLOOR;
      const lv = Math.log10(clamped);
      if (lv < minLog) minLog = lv;
      if (lv > maxLog) maxLog = lv;
    }

    if (!Number.isFinite(minLog) || !Number.isFinite(maxLog)) {
      minLog = -12;
      maxLog = -6;
    }

    let minExp = Math.floor(minLog) - 1;
    let maxExp = Math.ceil(maxLog) + 1;
    if (maxExp - minExp < 3) {
      const mid = (maxExp + minExp) / 2;
      minExp = Math.floor(mid - 1.5);
      maxExp = Math.ceil(mid + 1.5);
    }
    minExp = Math.max(-16, minExp);
    maxExp = Math.min(3, maxExp);
    const expSpan = Math.max(maxExp - minExp, 1);

    const mapX = (t: number) => padLeft + ((t - tMin) / tSpan) * plotW;
    const mapY = (absDrift: number) => {
      const clamped = Math.max(Number.isFinite(absDrift) ? absDrift : LOG_FLOOR, LOG_FLOOR);
      const lv = Math.log10(clamped);
      const norm = (lv - minExp) / expSpan;
      return padTop + plotH - Math.min(1, Math.max(0, norm)) * plotH;
    };

    // 绘制水平网格与科学计数法刻度
    const tickCount = 3;
    ctx.font = '9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= tickCount; i++) {
      const ratio = i / tickCount;
      const exp = maxExp - ratio * expSpan;
      const y = padTop + ratio * plotH;

      ctx.strokeStyle =
        i === 0 || i === tickCount
          ? 'rgba(56, 189, 248, 0.16)'
          : 'rgba(148, 163, 184, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, Math.round(y) + 0.5);
      ctx.lineTo(padLeft + plotW, Math.round(y) + 0.5);
      ctx.stroke();

      const expLabel = `1e${Math.round(exp)}`;
      ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
      ctx.fillText(expLabel, padLeft - 5, y);
    }

    // 绘制曲线下方渐层填充
    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, padTop, plotW, plotH);
    ctx.clip();

    const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    grad.addColorStop(0, 'rgba(34, 211, 238, 0.24)');
    grad.addColorStop(1, 'rgba(34, 211, 238, 0.01)');

    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
      const x = mapX(history[i].simTime);
      const y = mapY(Math.abs(history[i].relativeDrift));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const lastPt = history[history.length - 1];
    const lastX = mapX(lastPt.simTime);
    const lastY = mapY(Math.abs(lastPt.relativeDrift));
    ctx.lineTo(lastX, padTop + plotH);
    ctx.lineTo(mapX(history[0].simTime), padTop + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // 绘制漂移折线
    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
      const x = mapX(history[i].simTime);
      const y = mapY(Math.abs(history[i].relativeDrift));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // 绘制碰撞合并事件的虚线竖线与标注
    const visibleCollisions = collisionEvents.filter(
      (ev) => ev.simTime >= tMin && ev.simTime <= tMax
    );

    let lastLabelX = -100;
    let stagger = 0;

    for (let i = 0; i < visibleCollisions.length; i++) {
      const ev = visibleCollisions[i];
      const cx = mapX(ev.simTime);

      ctx.save();
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.85)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, padTop);
      ctx.lineTo(cx, padTop + plotH);
      ctx.stroke();
      ctx.restore();

      // 顶部菱形节点
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.moveTo(cx, padTop + 1);
      ctx.lineTo(cx + 3.5, padTop + 4.5);
      ctx.lineTo(cx, padTop + 8);
      ctx.lineTo(cx - 3.5, padTop + 4.5);
      ctx.closePath();
      ctx.fill();

      // 碰撞合并文字标记（防相邻碰撞重叠）
      const label = '碰撞合并';
      if (cx - lastLabelX < 46) {
        stagger = (stagger + 1) % 2;
      } else {
        stagger = 0;
      }
      lastLabelX = cx;

      const labelY = padTop + 12 + stagger * 12;
      const alignRight = cx > padLeft + plotW - 48;
      ctx.font = '9.5px "Microsoft YaHei", system-ui, sans-serif';
      ctx.textAlign = alignRight ? 'right' : 'left';
      ctx.textBaseline = 'middle';

      const textX = alignRight ? cx - 4 : cx + 4;
      const textW = ctx.measureText(label).width;
      const boxX = alignRight ? textX - textW - 3 : textX - 3;

      ctx.fillStyle = 'rgba(24, 18, 6, 0.82)';
      ctx.fillRect(boxX, labelY - 6, textW + 6, 12);
      ctx.fillStyle = '#fcd34d';
      ctx.fillText(label, textX, labelY);
    }

    // 最新采样高亮圆点
    ctx.beginPath();
    ctx.arc(lastX, lastY, 2.8, 0, Math.PI * 2);
    ctx.fillStyle = '#67e8f9';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lastX, lastY, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(34, 211, 238, 0.25)';
    ctx.fill();

    ctx.restore();

    // 边框
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft + 0.5, padTop + 0.5, plotW - 1, plotH - 1);

    // 右上角最新漂移读数
    const latestAbs = Math.abs(lastPt.relativeDrift);
    ctx.font = '9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#67e8f9';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(
      latestAbs === 0 ? '0.00e+0' : latestAbs.toExponential(2),
      padLeft + plotW,
      3
    );

    // 底部时间轴两端标注
    ctx.fillStyle = 'rgba(148, 163, 184, 0.75)';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText(`T=${formatSimTime(tMin)}`, padLeft, height - 2);
    ctx.textAlign = 'right';
    ctx.fillText(`T=${formatSimTime(tMax)}`, padLeft + plotW, height - 2);
  }, [history, collisionEvents, width, height]);

  return (
    <div
      ref={containerRef}
      className="w-full overflow-hidden rounded-lg border border-cyan-500/15 bg-slate-950/60"
    >
      <canvas
        ref={canvasRef}
        style={{ width: `${width}px`, height: `${height}px`, display: 'block' }}
      />
    </div>
  );
};
