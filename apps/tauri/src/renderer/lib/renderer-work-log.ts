export type RendererWorkPhase =
  | 'xterm-parse'
  | 'xterm-render'
  | 'output-prepare'
  | 'log-coloring'
  | 'foreground-adapt'
  | 'symbol-layout'
  | 'block-layout'
  | 'selection-layout'
  | 'terminal-search-results'
  | 'terminal-selection-change'
  | 'terminal-ui-publish'
  | 'terminal-status'
  | 'terminal-input'
  | 'workspace-snapshot'
  | 'session-metrics'
  | 'remote-files'
  | 'transfer-update'
  | 'workspace-snapshot-event'
  | 'session-metrics-event'
  | 'remote-files-event'
  | 'transfer-update-event'

type WorkSummary = { calls: number; totalElapsedMs: number; maxElapsedMs: number }
/**
 * Counters describe how much work a phase skipped or repeated; unlike phases
 * they carry no elapsed time and are only meaningful within one health window.
 */
export type RendererWorkCounter =
  | 'block-observer.batches'
  | 'block-observer.rows'
  | 'block-observer.flushes'
  | 'block-observer.skips'
  | 'block-layout.rows'
  | 'block-layout.unchanged'
  | 'block-layout.styleReads'
  | 'block-layout.canvasDraws'
const phases = new Map<RendererWorkPhase, WorkSummary>()
const counters = new Map<RendererWorkCounter, number>()
const recentSlowWork: Array<{ phase: RendererWorkPhase; startedAtMs: number; elapsedMs: number }> = []
const activeWork: Array<{ phase: RendererWorkPhase; startedAtMs: number }> = []
const recentFailures: Array<{ phase: RendererWorkPhase; startedAtMs: number; elapsedMs: number }> = []

/** Synchronous elapsed time, inclusive of nested callbacks; never terminal contents or CPU samples. */
export function trackRendererWork<Args extends unknown[], Result>(
  phase: RendererWorkPhase,
  work: (...args: Args) => Result
): (...args: Args) => Result {
  return function (this: unknown, ...args: Args): Result {
    const started = performance.now()
    activeWork.push({ phase, startedAtMs: Math.round(started) })
    try {
      return work.apply(this, args)
    } catch (error) {
      recentFailures.push({
        phase,
        startedAtMs: Math.round(started),
        elapsedMs: Math.round(performance.now() - started)
      })
      if (recentFailures.length > 4) recentFailures.shift()
      throw error
    } finally {
      activeWork.pop()
      const elapsed = performance.now() - started
      const summary = phases.get(phase) ?? { calls: 0, totalElapsedMs: 0, maxElapsedMs: 0 }
      summary.calls++
      summary.totalElapsedMs += elapsed
      summary.maxElapsedMs = Math.max(summary.maxElapsedMs, elapsed)
      phases.set(phase, summary)
      if (elapsed >= 16) {
        recentSlowWork.push({ phase, startedAtMs: Math.round(started), elapsedMs: Math.round(elapsed) })
        if (recentSlowWork.length > 6) recentSlowWork.shift()
      }
    }
  }
}

/** Bounded integer counters for work that a phase chooses to skip or repeat. */
export function countRendererWork(counter: RendererWorkCounter, amount = 1) {
  counters.set(counter, (counters.get(counter) ?? 0) + amount)
}

export function getRendererWorkSnapshot() {
  return {
    schemaVersion: 4,
    sampledAtMs: Math.round(performance.now()),
    timeOriginUnixMs: Number.isFinite(performance.timeOrigin) ? Math.round(performance.timeOrigin) : undefined,
    phases: Object.fromEntries(
      [...phases].map(([phase, summary]) => [
        phase,
        {
          calls: summary.calls,
          totalElapsedMs: Math.round(summary.totalElapsedMs),
          maxElapsedMs: Math.round(summary.maxElapsedMs)
        }
      ])
    ),
    counters: Object.fromEntries([...counters]),
    recentSlowWork: [...recentSlowWork],
    activeWork: activeWork.slice(-8).map((entry) => ({ ...entry })),
    recentFailures: recentFailures.map((entry) => ({ ...entry }))
  }
}

export function resetRendererWork(preserveFailures = false) {
  phases.clear()
  counters.clear()
  recentSlowWork.length = 0
  if (!preserveFailures) recentFailures.length = 0
}
