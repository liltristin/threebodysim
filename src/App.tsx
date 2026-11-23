import { useEffect, useMemo, useRef, useState } from 'react';
import { SimulationController } from './engine';
import type { HudSnapshot, SimulationActions } from './types/contracts';
import { HudOverlay } from './ui';

/**
 * 3D 三体运动模拟器根组件
 * - 全屏视口挂载 Three.js Canvas，通过 ResizeObserver 同步画布尺寸
 * - 严禁每帧 React setState：仅订阅 SimulationController 10~15 Hz 节流推送的 HudSnapshot
 * - 严格兼容 React 18 StrictMode 双重挂载/卸载
 */
export default function App() {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<SimulationController | null>(null);
  const [snapshot, setSnapshot] = useState<HudSnapshot | null>(null);

  // 引用稳定的动作代理，确保 HudOverlay 全局快捷键监听不会因重新渲染反复解绑/重绑
  const actions = useMemo<SimulationActions>(
    () => ({
      play: () => controllerRef.current?.getActions().play(),
      pause: () => controllerRef.current?.getActions().pause(),
      togglePlay: () => controllerRef.current?.getActions().togglePlay(),
      stepOnce: (dt) => controllerRef.current?.getActions().stepOnce(dt),
      reset: () => controllerRef.current?.getActions().reset(),
      randomize: (bodyCount) =>
        controllerRef.current?.getActions().randomize(bodyCount),
      setTimeScale: (scale) =>
        controllerRef.current?.getActions().setTimeScale(scale),
      setAutoSlowMo: (enabled) =>
        controllerRef.current?.getActions().setAutoSlowMo(enabled),
      loadPreset: (presetId) =>
        controllerRef.current?.getActions().loadPreset(presetId),
      setIntegrator: (integrator) =>
        controllerRef.current?.getActions().setIntegrator(integrator),
      setSoftening: (softening) =>
        controllerRef.current?.getActions().setSoftening(softening),
      setEnableCollisions: (enabled) =>
        controllerRef.current?.getActions().setEnableCollisions(enabled),
      setPlanetAsTestParticle: (enabled) =>
        controllerRef.current?.getActions().setPlanetAsTestParticle(enabled),
      setPlanetRotationRate: (rate) =>
        controllerRef.current?.getActions().setPlanetRotationRate(rate),
      normalizeCenterOfMass: () =>
        controllerRef.current?.getActions().normalizeCenterOfMass(),
      addBody: (input) => controllerRef.current?.getActions().addBody(input),
      addTrisolarisPlanet: () =>
        controllerRef.current?.getActions().addTrisolarisPlanet(),
      removeBody: (bodyId) =>
        controllerRef.current?.getActions().removeBody(bodyId),
      updateBody: (bodyId, patch) =>
        controllerRef.current?.getActions().updateBody(bodyId, patch),
      setCameraMode: (mode, targetBodyId) =>
        controllerRef.current?.getActions().setCameraMode(mode, targetBodyId),
      resetCameraView: () =>
        controllerRef.current?.getActions().resetCameraView(),
      updateVisualOptions: (patch) =>
        controllerRef.current?.getActions().updateVisualOptions(patch),
      clearTrails: () => controllerRef.current?.getActions().clearTrails(),
    }),
    []
  );

  useEffect(() => {
    const container = viewportRef.current;
    if (!container) return;

    const controller = new SimulationController();
    controllerRef.current = controller;

    const unsubscribe = controller.subscribe((nextSnapshot) => {
      setSnapshot(nextSnapshot);
    });

    controller.mount(container);

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          controller.resize(width, height);
        }
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      unsubscribe();
      controller.dispose();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#020617]">
      {/* 全屏 3D Three.js 渲染视口 */}
      <div
        ref={viewportRef}
        className="absolute inset-0 h-full w-full"
        aria-label="3D 三体仿真视口"
      />

      {/* 深空科幻毛玻璃 HUD 覆盖层 */}
      {snapshot !== null && (
        <HudOverlay snapshot={snapshot} actions={actions} />
      )}
    </div>
  );
}
