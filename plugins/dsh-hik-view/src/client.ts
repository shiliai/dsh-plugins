/**
 * dsh-hik-view client half: registers one single-instance better-sidebar tab
 * showing the MJPEG relay of the selected NVR channel. The module loader
 * wrapper (window.__ModuleLoader__ / CJS factory) is added by the tsdown
 * client build; react stays external and resolves through the loader seed.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'

const { createElement } = React

/** Services required before mounting: the better-sidebar tab registry. */
export const inject = ['betterSidebar']

const CHANNELS_FALLBACK = [
  { index: 1, id: 'cam1', label: '通道 1' },
  { index: 2, id: 'cam2', label: '通道 2' },
  { index: 3, id: 'cam3', label: '通道 3' },
  { index: 4, id: 'cam4', label: '通道 4' },
]

const FPS_PRESETS: Array<[label: string, value: number]> = [['流畅', 4], ['标准', 8], ['顺滑', 15]]

interface ChannelInfo {
  index: number
  id: string
  label?: string
}

/** Live-view tab body: channel switcher + MJPEG <img>. Pauses (empties
 *  the img src) when the tab is not visible, so a background tab costs
 *  no relay bandwidth and no NVR stream. */
function CameraView({ visible }: { visible: boolean }) {
  const [channels, setChannels] = useState<ChannelInfo[]>(CHANNELS_FALLBACK)
  const [current, setCurrent] = useState<ChannelInfo>(CHANNELS_FALLBACK[0]!)
  const [fps, setFps] = useState(8)
  const [key, setKey] = useState(0)
  const [state, setState] = useState<'loading' | 'live' | 'error'>('loading')
  const imgRef = useRef<HTMLImageElement | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/hik-view/api/info').then((r) => r.json()).then((body: { ok?: boolean; channels?: ChannelInfo[] }) => {
      if (!alive || !body.ok) return
      if (Array.isArray(body.channels) && body.channels.length > 0) {
        setChannels(body.channels)
        setCurrent((prev) => body.channels?.find((c) => c.id === prev?.id) ?? body.channels![0]!)
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  const src = visible ? `/hik-view/stream?ch=${encodeURIComponent(current.id)}&fps=${fps}&t=${key}` : undefined
  const retriesRef = useRef(0)

  const onImgLoad = useCallback(() => { retriesRef.current = 0; setState('live') }, [])
  const onImgError = useCallback(() => {
    setState('error')
    // The NVR frees its per-channel RTSP slot asynchronously after the
    // previous viewer disconnects — retry a few times before giving up.
    if (retriesRef.current < 4) {
      retriesRef.current += 1
      setTimeout(() => setKey((k) => k + 1), 2500)
    }
  }, [])

  const btn = (active: boolean): React.CSSProperties => ({
    padding: '4px 10px',
    borderRadius: 8,
    border: '1px solid ' + (active ? 'var(--dsh-color-brand, #4b7bec)' : 'transparent'),
    background: active ? 'color-mix(in srgb, var(--dsh-color-brand, #4b7bec) 15%, transparent)' : 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 12,
  })

  return createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8, height: '100%', padding: 8, boxSizing: 'border-box' } },
    createElement(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
      channels.map((ch) =>
        createElement('button', {
          key: ch.id,
          style: btn(current?.id === ch.id),
          onClick: () => { setCurrent(ch); setState('loading') },
        }, ch.label ?? ch.id),
      ),
      createElement('span', { style: { flex: 1 } }),
      FPS_PRESETS.map(([label, value]) =>
        createElement('button', {
          key: value,
          style: btn(fps === value),
          onClick: () => { setFps(value); setState('loading') },
        }, label),
      ),
      createElement('button', { style: btn(false), title: '重新连接', onClick: () => { setKey((k) => k + 1); setState('loading') } }, '⟳'),
    ),
    createElement(
      'div',
      { style: { flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.85)', borderRadius: 10, overflow: 'hidden', position: 'relative' } },
      visible && src
        ? createElement('img', {
            ref: imgRef,
            key: src,
            src,
            alt: current?.label ?? 'camera',
            onLoad: onImgLoad,
            onError: onImgError,
            style: { maxWidth: '100%', maxHeight: '100%', display: 'block' },
          })
        : createElement('div', { style: { color: '#9aa3ad', fontSize: 13 } }, '标签页不可见，已暂停拉流'),
      createElement(
        'div',
        { style: { position: 'absolute', top: 6, left: 8, fontSize: 11, color: state === 'live' ? '#7bd88f' : state === 'error' ? '#ff7b72' : '#d7ba7d', textShadow: '0 1px 2px rgba(0,0,0,0.8)' } },
        state === 'live' ? `● LIVE · ${current?.label ?? ''} · ${fps}fps` : state === 'error' ? '⚠ 拉流失败（NVR 不可达或并发已满）' : '… 连接中',
      ),
    ),
  )
}

/** Diagnostic channel: surfaces client-side lifecycle events/failures to the host journal. */
function report(event: string, detail?: unknown): void {
  try {
    fetch('/hik-view/api/client-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, detail: detail === undefined ? null : String(detail), at: Date.now() }),
    }).catch(() => {})
  } catch { /* diagnostics must never throw */ }
}

interface SidebarTabService {
  registerTab(tab: {
    id: string
    title: () => string
    order: number
    single: boolean
    component: (props: { visible: boolean }) => React.ReactElement
  }): () => void
}

interface ClientContext {
  inject?: (names: string[], callback: (sctx: { betterSidebar?: SidebarTabService; ctx?: { betterSidebar?: SidebarTabService } }) => void) => void
  betterSidebar?: SidebarTabService
  effect?(dispose: () => void, label?: string): void
}

/**
 * Client plugin body: registers one single-instance sidebar tab.
 */
export function apply(ctx: ClientContext): void {
  report('apply-enter', `hasInject=${typeof ctx.inject} hasService=${typeof ctx.betterSidebar}`)
  let registered = false
  const register = (sctx?: { betterSidebar?: SidebarTabService; ctx?: { betterSidebar?: SidebarTabService } } | null): void => {
    try {
      const service = (sctx && (sctx.betterSidebar ?? sctx.ctx?.betterSidebar)) || ctx.betterSidebar
      if (!service || typeof service.registerTab !== 'function') {
        report('no-service', sctx && JSON.stringify(Object.keys(sctx).slice(0, 30)))
        return
      }
      const dispose = service.registerTab({
        id: 'hik-view:camera',
        title: () => '实时视频',
        order: 60,
        single: true,
        component: ({ visible }) => createElement(CameraView, { visible }),
      })
      registered = true
      report('tab-registered')
      ctx.effect?.(() => dispose, 'dsh-hik-view: tab')
    } catch (error) {
      report('register-error', error instanceof Error ? (error.stack ?? error.message) : error)
    }
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['betterSidebar'], register)
      setTimeout(() => { if (!registered) report('inject-timeout', 'betterSidebar service never resolved') }, 8000)
    } else if (ctx.betterSidebar) {
      register(ctx)
    } else {
      report('no-inject-api', 'ctx.inject missing')
    }
  } catch (error) {
    report('apply-error', error instanceof Error ? (error.stack ?? error.message) : error)
  }
}
