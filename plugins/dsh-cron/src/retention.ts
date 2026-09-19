/**
 * Post-run session retention. Disposing an AgentHandle also removes its
 * session from the host's live store, which makes the web client drop it
 * from every grouping (`host/session-removed`) and `sessions.open()` fail —
 * so a finished cron run used to vanish from the UI the moment it ended.
 * Keeping the newest N handles alive leaves their sessions listed and
 * replayable; evicted ones stay durable (journal + workspace membership) and
 * reappear on the next client rebaseline or host restart.
 * @module @dsh-plugins/dsh-cron/retention
 */

export interface RetainableHandle {
  sessionId: string
  dispose(): Promise<void>
}

export class SessionRetainer {
  private readonly entries: RetainableHandle[] = []

  constructor(
    private readonly limit: number,
    private readonly info: (message: string) => void,
  ) {}

  /** Track a finished run's handle, evicting (disposing) the oldest beyond the limit. */
  keep(handle: RetainableHandle): void {
    if (this.limit <= 0) {
      void handle.dispose().catch(() => undefined)
      return
    }
    const existing = this.entries.findIndex(entry => entry.sessionId === handle.sessionId)
    if (existing >= 0) this.entries.splice(existing, 1)
    this.entries.unshift(handle)
    while (this.entries.length > this.limit) {
      const evicted = this.entries.pop()
      if (evicted === undefined) break
      void evicted.dispose().catch(() => undefined)
      this.info(`retained session evicted: ${evicted.sessionId}`)
    }
  }

  /** Dispose every retained handle (plugin shutdown / retention disabled). */
  async disposeAll(): Promise<void> {
    const entries = this.entries.splice(0, this.entries.length)
    for (const entry of entries) {
      await entry.dispose().catch(() => undefined)
    }
  }
}
