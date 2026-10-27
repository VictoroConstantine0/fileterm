import { getTerminalOutputProgress } from '../../bridge/events/terminal-output'
import { observeInteractionPerformance } from './renderer-interaction-performance'
import { DIAGNOSTIC_SCOPES, writeDiagnosticLog } from './diagnostic-log'
import { getRendererWorkSnapshot, resetRendererWork } from './renderer-work-log'
import { observeRendererFrames } from './renderer-frame-log'
import { getTerminalResourceSnapshot } from '../xterm-adapters/terminal-diagnostics'

/** Detect recovered stalls without relying on an exception or animation frames. */
export function installRendererPerformanceLogging(): () => void {
  resetRendererWork()
  let diagnosticsReady = false
  const reportReady = () => {
    if (diagnosticsReady || !window.fileterm) return
    diagnosticsReady = true
    writeDiagnosticLog(
      'INFO',
      DIAGNOSTIC_SCOPES.performance,
      JSON.stringify({
        event: 'renderer-diagnostics-ready',
        schemaVersion: 4,
        version: window.fileterm?.appVersion,
        platform: window.fileterm?.platform
      })
    )
  }
  reportReady()
  const interactions = observeInteractionPerformance()
  let lastFrameReport = -Infinity
  const frames = observeRendererFrames(() => {
    const now = performance.now()
    if (now - lastFrameReport < 30000) return
    lastFrameReport = now
    writeDiagnosticLog(
      'WARN',
      DIAGNOSTIC_SCOPES.performance,
      JSON.stringify({
        event: 'renderer-long-frame',
        ...readContext(),
        terminalOutput: getTerminalOutputProgress(),
        interaction: interactions.snapshot()
      })
    )
  })
  let lastSlowReport = -Infinity
  let previous = performance.now()
  const timeOriginUnixMs = Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : undefined
  const started = previous
  let lastReport = -Infinity
  let lastHealthReport = previous
  let maxEventLoopGapMs = 0
  let longTaskCount = 0
  let longTaskTotalMs = 0
  let maxLongTaskMs = 0
  let longTaskWindowStartedAtMs = previous
  const slowestLongTasks: Array<{ startedAtMs: number; durationMs: number }> = []
  const longTasks =
    typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')
      ? new PerformanceObserver((list) => {
          if (document.hidden) return
          for (const entry of list.getEntries()) {
            longTaskCount++
            longTaskTotalMs += entry.duration
            maxLongTaskMs = Math.max(maxLongTaskMs, entry.duration)
            slowestLongTasks.push({ startedAtMs: Math.round(entry.startTime), durationMs: Math.round(entry.duration) })
            slowestLongTasks.sort((left, right) => right.durationMs - left.durationMs)
            if (slowestLongTasks.length > 4) slowestLongTasks.pop()
          }
        })
      : null
  let longTasksAvailable = Boolean(longTasks)
  try {
    longTasks?.observe({ type: 'longtask' })
  } catch {
    longTasksAvailable = false
    longTasks?.disconnect()
  }
  const resetLongTasks = () => {
    longTaskCount = longTaskTotalMs = maxLongTaskMs = 0
    slowestLongTasks.length = 0
    longTaskWindowStartedAtMs = performance.now()
  }
  const reset = () => {
    previous = performance.now()
    lastHealthReport = previous
    interactions.reset()
    frames.reset()
    resetRendererWork(true)
    maxEventLoopGapMs = 0
    resetLongTasks()
  }
  const readContext = () => {
    const canvases = document.querySelectorAll<HTMLCanvasElement>('canvas')
    let canvasBackingBytesEstimate = 0
    for (let index = 0; index < Math.min(canvases.length, 512); index++) {
      const canvas = canvases[index]
      canvasBackingBytesEstimate += canvas.width * canvas.height * 4
    }
    return {
      visible: !document.hidden,
      focused: document.hasFocus(),
      work: getRendererWorkSnapshot(),
      longFrames: frames.snapshot(),
      longTasks: {
        supported: longTasksAvailable,
        windowStartedAtMs: Math.round(longTaskWindowStartedAtMs),
        count: longTasksAvailable ? longTaskCount : undefined,
        totalMs: longTasksAvailable ? Math.round(longTaskTotalMs) : undefined,
        maxMs: longTasksAvailable ? Math.round(maxLongTaskMs) : undefined,
        slowest: [...slowestLongTasks]
      },
      terminalResources: getTerminalResourceSnapshot(),
      canvasCount: canvases.length,
      canvasBackingBytesEstimate,
      canvasEstimateTruncated: canvases.length > 512
    }
  }
  const timer = window.setInterval(() => {
    reportReady()
    const now = performance.now()
    const lastHeartbeatAtMs = previous
    const elapsed = now - lastHeartbeatAtMs
    previous = now
    if (!document.hidden) maxEventLoopGapMs = Math.max(maxEventLoopGapMs, elapsed)
    const terminalOutput = getTerminalOutputProgress()
    const interaction = interactions.snapshot()
    let capturedContext: ReturnType<typeof readContext> | undefined
    const context = () => (capturedContext ??= readContext())
    const output = terminalOutput as { pendingBatches?: number; busyForMs?: number; sinceLastParsedMs?: number } | null
    const outputStalled =
      !!output?.pendingBatches && Math.min(output.sinceLastParsedMs ?? Infinity, output.busyForMs ?? 0) >= 5000
    if (
      !document.hidden &&
      (outputStalled || (interaction.maxInputDelayMs ?? 0) >= 250 || (interaction.maxDurationMs ?? 0) >= 1000) &&
      now - lastSlowReport >= 30000
    ) {
      lastSlowReport = now
      writeDiagnosticLog(
        'WARN',
        DIAGNOSTIC_SCOPES.performance,
        JSON.stringify({
          event: 'renderer-progress-slow',
          ...context(),
          terminalOutput,
          interaction
        })
      )
    }
    if (!document.hidden && now - lastHealthReport >= 60000) {
      lastHealthReport = now
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } })
        .memory
      const callbacks = (window as unknown as { __TAURI_INTERNALS__?: { callbacks?: Map<number, unknown> } })
        .__TAURI_INTERNALS__?.callbacks
      writeDiagnosticLog(
        'DEBUG',
        DIAGNOSTIC_SCOPES.performance,
        JSON.stringify({
          event: 'renderer-health',
          ...context(),
          terminalOutput,
          interaction,
          uptimeMs: Math.round(now - started),
          usedJSHeapBytes: memory?.usedJSHeapSize,
          totalJSHeapBytes: memory?.totalJSHeapSize,
          ipcCallbackCount: callbacks?.size,
          terminalCount: document.querySelectorAll('.xterm').length,
          domNodeCount: document.getElementsByTagName('*').length,
          maxEventLoopGapMs: Math.round(maxEventLoopGapMs),
          longTaskCount: longTasksAvailable ? longTaskCount : undefined,
          longTaskTotalMs: longTasksAvailable ? Math.round(longTaskTotalMs) : undefined,
          maxLongTaskMs: longTasksAvailable ? Math.round(maxLongTaskMs) : undefined,
          version: window.fileterm?.appVersion,
          platform: window.fileterm?.platform
        })
      )
      maxEventLoopGapMs = 0
      resetLongTasks()
      interactions.reset()
      frames.reset()
      // xterm can rethrow after this heartbeat; retain the bounded failure trail.
      resetRendererWork(true)
    }
    if (document.hidden || elapsed < 2000 || now - lastReport < 30000) return
    lastReport = now
    writeDiagnosticLog(
      'WARN',
      DIAGNOSTIC_SCOPES.performance,
      JSON.stringify({
        event: 'event-loop-gap',
        ...context(),
        terminalOutput,
        interaction,
        elapsedMs: Math.round(elapsed),
        expectedIntervalMs: 1000,
        delayedByMs: Math.max(0, Math.round(elapsed - 1000)),
        lastHeartbeatAtUnixMs:
          timeOriginUnixMs === undefined ? undefined : Math.round(timeOriginUnixMs + lastHeartbeatAtMs),
        expectedNextHeartbeatAtUnixMs:
          timeOriginUnixMs === undefined ? undefined : Math.round(timeOriginUnixMs + lastHeartbeatAtMs + 1000),
        resumedAtUnixMs: timeOriginUnixMs === undefined ? undefined : Math.round(timeOriginUnixMs + now),
        focused: document.hasFocus(),
        version: window.fileterm?.appVersion,
        platform: window.fileterm?.platform
      })
    )
  }, 1000)
  // Background timer throttling must not be reported as a foreground stall.
  document.addEventListener('visibilitychange', reset)
  return () => {
    window.clearInterval(timer)
    longTasks?.disconnect()
    interactions.dispose()
    frames.dispose()
    document.removeEventListener('visibilitychange', reset)
  }
}
