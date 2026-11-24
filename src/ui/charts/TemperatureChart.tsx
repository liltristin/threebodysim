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
  /** 为 false 时（侧栏折叠、纯净模式、移动端未打开遥测抽屉）跳过 canvas 重绘与尺寸监听 */
  readonly active?: boolean;
}

/**
 * 轻量原生 <canvas> 三体行星表面温度实时曲线图（航天极简黑曜石风格）
 * - 支持高分屏 DPR 自适应与按需暂停重绘（active=false 零 CPU 开销）
 * - 背景绘制清晰的半透明翠绿色宜居带（0°C ~ 45°C）
 * - 曲线分段按恒纪元（翠绿）/ 乱纪元（酷热绯红 / 极寒星蓝 / 剧变琥珀）动态着色
 */
export const TemperatureChart: React.FC<TemperatureChartProps> = ({
  history,
  height = 114,
  active = true,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState<number>(240);

  useEffect(() => {
    if (!active) return;
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
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.max(1, Math.round(width * dpr));
    const targetH = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const padLeft = 40;
    const padRight = 8;
    const padTop = 18;
    const padBottom = 16;
    const plotW = Math.max(1, width - padLeft - padRight);
    const plotH = Math.max(1, height - padTop - padBottom);

    // 黑曜石底板
    ctx.fillStyle = 'rgba(5, 8, 16, 0.72)';
    ctx.fillRect(padLeft, padTop, plotW, plotH);

    // 左上角克制图例
    ctx.font = '9px "Microsoft YaHei", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#34d399';
    ctx.fillText('● 恒纪元', padLeft, 3);
    ctx.fillStyle = '#fb7185';
    ctx.fillText('● 酷热', padLeft + 46, 3);
    ctx.fillStyle = '#38bdf8';
    ctx.fillText('● 极寒', padLeft + 82, 3);

    if (history.length < 2) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.strokeRect(padLeft + 0.5, padTop + 0.5, plotW - 1, plotH - 1);

      ctx.font = '10.5px "Microsoft YaHei", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
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

    // 柔和冷白参考网格线与温度刻度
    const tickCount = 4;
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= tickCount; i++) {
      const ratio = i / tickCount;
      const tempTick = yMax - ratio * ySpan;
      const y = padTop + ratio * plotH;

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.065)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, Math.round(y) + 0.5);
      ctx.lineTo(padLeft + plotW, Math.round(y) + 0.5);
      ctx.stroke();

      ctx.fillStyle = 'rgba(148, 163, 184, 0.72)';
      ctx.fillText(`${Math.round(tempTick)}°`, padLeft - 5, y);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, padTop, plotW, plotH);
    ctx.clip();

    // 清晰半透明翠绿宜居带阴影（0°C ~ 45°C）
    const habTop = mapY(HABITABLE_TEMP_MAX_C);
    const habBottom = mapY(HABITABLE_TEMP_MIN_C);
    const habHeight = Math.max(2, habBottom - habTop);

    ctx.fillStyle = 'rgba(16, 185, 129, 0.16)';
    ctx.fillRect(padLeft, habTop, plotW, habHeight);

    ctx.save();
    ctx.strokeStyle = 'rgba(52, 211, 153, 0.48)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padLeft, Math.round(habTop) + 0.5);
    ctx.lineTo(padLeft + plotW, Math.round(habTop) + 0.5);
    ctx.moveTo(padLeft, Math.round(habBottom) + 0.5);
    ctx.lineTo(padLeft + plotW, Math.round(habBottom) + 0.5);
    ctx.stroke();
    ctx.restore();

    ctx.font = '8.5px "Microsoft YaHei", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(110, 231, 183, 0.82)';
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

    // 按纪元分段着色绘制温度曲线
    ctx.lineWidth = 1.75;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i = 1; i < history.length; i++) {
      const p0 = history[i - 1];
      const p1 = history[i];
      ctx.strokeStyle = getTemperatureStrokeColor(p1.era, p1.temperatureC);
      ctx.beginPath();
      ctx.moveTo(mapX(p0.simTime), mapY(p0.temperatureC));
      ctx.lineTo(mapX(p1.simTime), mapY(p1.temperatureC));
      ctx.stroke();
    }

    // 最新温度点
    const last = history[history.length - 1];
    const lastX = mapX(last.simTime);
    const lastY = mapY(last.temperatureC);
    const lastColor = getTemperatureStrokeColor(last.era, last.temperatureC);

    ctx.beginPath();
    ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.restore();

    // 发丝边框
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft + 0.5, padTop + 0.5, plotW - 1, plotH - 1);

    // 右上角实时温度
    ctx.font = '9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = lastColor;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(formatTempC(last.temperatureC, 1), padLeft + plotW, 3);

    // 底部时间跨度
    ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText(`T=${formatSimTime(tMin)}`, padLeft, height - 1);
    ctx.textAlign = 'right';
    ctx.fillText(`T=${formatSimTime(tMax)}`, padLeft + plotW, height - 1);
  }, [active, history, width, height]);

  return (
    <div
      ref={containerRef}
      className="w-full overflow-hidden rounded-lg border border-white/[0.07] bg-black/40"
    >
      <canvas
        ref={canvasRef}
        style={{ width: `${width}px`, height: `${height}px`, display: 'block' }}
      />
    </div>
  );
};
