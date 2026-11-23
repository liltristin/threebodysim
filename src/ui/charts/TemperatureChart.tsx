import React, { useEffect, useRef, useState } from 'react';
import {
  HABITABLE_TEMP_MAX_C,
  HABITABLE_TEMP_MIN_C,
  type TemperatureHistoryPoint,
} from '../../types/contracts';
import { formatSimTime, formatTempC, getTemperatureStrokeColor } from '../formatters';

export interface TemperatureChartProps {
  readonly history: readonly TemperatureHistoryPoint[];
  readonly height?: number;
}

/**
 * 轻量原生 <canvas> 三体行星表面温度实时曲线图
 * - 高分屏 DPR 适配
 * - 背景高亮半透明翠绿色宜居带（0°C ~ 45°C）
 * - 曲线分段按恒纪元（翠青）/ 乱纪元（酷热橙红 / 极寒冰蓝 / 剧变琥珀）动态着色
 */
export const TemperatureChart: React.FC<TemperatureChartProps> = ({
  history,
  height = 124,
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

    const padLeft = 42;
    const padRight = 10;
    const padTop = 18;
    const padBottom = 18;
    const plotW = Math.max(1, width - padLeft - padRight);
    const plotH = Math.max(1, height - padTop - padBottom);

    // 绘图底板
    ctx.fillStyle = 'rgba(2, 6, 23, 0.58)';
    ctx.fillRect(padLeft, padTop, plotW, plotH);

    // 左上角图例
    ctx.font = '9.5px "Microsoft YaHei", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#2dd4bf';
    ctx.fillText('● 恒纪元', padLeft, 3);
    ctx.fillStyle = '#fb7185';
    ctx.fillText('● 酷热', padLeft + 52, 3);
    ctx.fillStyle = '#38bdf8';
    ctx.fillText('● 极寒', padLeft + 92, 3);

    if (history.length < 2) {
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(padLeft + 0.5, padTop + 0.5, plotW - 1, plotH - 1);

      ctx.font = '11px "Microsoft YaHei", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('等待行星温度遥测...', padLeft + plotW / 2, padTop + plotH / 2);
      return;
    }

    const tMin = history[0].simTime;
    const tMax = history[history.length - 1].simTime;
    const tSpan = Math.max(tMax - tMin, 1e-6);

    let dataMin = Infinity;
    let dataMax = -Infinity;
    for (let i = 0; i < history.length; i++) {
      const temp = history[i].temperatureC;
      if (Number.isFinite(temp)) {
        if (temp < dataMin) dataMin = temp;
        if (temp > dataMax) dataMax = temp;
      }
    }

    if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) {
      dataMin = -20;
      dataMax = 80;
    }

    // 确保纵轴始终包含宜居带并留出上下余量
    let yMin = Math.min(HABITABLE_TEMP_MIN_C - 25, dataMin - 15);
    let yMax = Math.max(HABITABLE_TEMP_MAX_C + 30, dataMax + 15);
    yMin = Math.floor(yMin / 10) * 10;
    yMax = Math.ceil(yMax / 10) * 10;
    if (yMax - yMin < 80) {
      const mid = (yMax + yMin) / 2;
      yMin = Math.floor((mid - 40) / 10) * 10;
      yMax = Math.ceil((mid + 40) / 10) * 10;
    }
    const ySpan = Math.max(yMax - yMin, 1);

    const mapX = (t: number) => padLeft + ((t - tMin) / tSpan) * plotW;
    const mapY = (tempC: number) => {
      const clamped = Number.isFinite(tempC) ? tempC : 0;
      const norm = (clamped - yMin) / ySpan;
      return padTop + plotH - Math.min(1, Math.max(0, norm)) * plotH;
    };

    // 水平参考网格线与温度刻度
    const tickCount = 4;
    ctx.font = '9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= tickCount; i++) {
      const ratio = i / tickCount;
      const tempTick = yMax - ratio * ySpan;
      const y = padTop + ratio * plotH;

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.11)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, Math.round(y) + 0.5);
      ctx.lineTo(padLeft + plotW, Math.round(y) + 0.5);
      ctx.stroke();

      ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
      ctx.fillText(`${Math.round(tempTick)}°`, padLeft - 5, y);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, padTop, plotW, plotH);
    ctx.clip();

    // 绘制清晰半透明翠绿色宜居带阴影（0°C ~ 45°C）
    const habTop = mapY(HABITABLE_TEMP_MAX_C);
    const habBottom = mapY(HABITABLE_TEMP_MIN_C);
    const habHeight = Math.max(2, habBottom - habTop);

    ctx.fillStyle = 'rgba(16, 185, 129, 0.18)';
    ctx.fillRect(padLeft, habTop, plotW, habHeight);

    // 宜居带上下虚线边界
    ctx.save();
    ctx.strokeStyle = 'rgba(52, 211, 153, 0.52)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padLeft, Math.round(habTop) + 0.5);
    ctx.lineTo(padLeft + plotW, Math.round(habTop) + 0.5);
    ctx.moveTo(padLeft, Math.round(habBottom) + 0.5);
    ctx.lineTo(padLeft + plotW, Math.round(habBottom) + 0.5);
    ctx.stroke();
    ctx.restore();

    // 宜居带标签
    ctx.font = '9px "Microsoft YaHei", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(110, 231, 183, 0.88)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const labelY =
      habHeight >= 13
        ? habTop + habHeight / 2
        : Math.max(padTop + 7, habTop - 6);
    ctx.fillText(
      `宜居带 ${HABITABLE_TEMP_MIN_C}~${HABITABLE_TEMP_MAX_C}°C`,
      padLeft + plotW - 4,
      labelY
    );

    // 分段按纪元着色绘制温度曲线
    ctx.lineWidth = 1.9;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i = 1; i < history.length; i++) {
      const p0 = history[i - 1];
      const p1 = history[i];
      const x0 = mapX(p0.simTime);
      const y0 = mapY(p0.temperatureC);
      const x1 = mapX(p1.simTime);
      const y1 = mapY(p1.temperatureC);

      ctx.strokeStyle = getTemperatureStrokeColor(p1.era, p1.temperatureC);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    // 最新温度点高亮
    const last = history[history.length - 1];
    const lastX = mapX(last.simTime);
    const lastY = mapY(last.temperatureC);
    const lastColor = getTemperatureStrokeColor(last.era, last.temperatureC);

    ctx.beginPath();
    ctx.arc(lastX, lastY, 2.8, 0, Math.PI * 2);
    ctx.fillStyle = lastColor;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lastX, lastY, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = `${lastColor}44`;
    ctx.fill();

    ctx.restore();

    // 边框
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft + 0.5, padTop + 0.5, plotW - 1, plotH - 1);

    // 右上角当前实时温度
    ctx.font = '9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = lastColor;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(formatTempC(last.temperatureC, 1), padLeft + plotW, 3);

    // 底部时间范围
    ctx.fillStyle = 'rgba(148, 163, 184, 0.75)';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText(`T=${formatSimTime(tMin)}`, padLeft, height - 2);
    ctx.textAlign = 'right';
    ctx.fillText(`T=${formatSimTime(tMax)}`, padLeft + plotW, height - 2);
  }, [history, width, height]);

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
