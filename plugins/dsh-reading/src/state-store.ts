import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Annotation, ReadingProgress, ReadingStateSnapshot } from './contracts.ts'

const EMPTY_STATE: ReadingStateSnapshot = { progress: {}, annotations: [] }

/**
 * JSON-file-backed store for reading progress and annotations.
 * Atomic via write-to-temp + rename; all mutations funnel through `update`.
 * (Design allows swapping in SQLite later without touching callers.)
 */
export class ReadingStateStore {
  readonly #path: string
  #state: ReadingStateSnapshot = EMPTY_STATE
  #writeQueue: Promise<void> = Promise.resolve()

  private constructor(path: string) {
    this.#path = path
  }

  static async create(dataDir: string): Promise<ReadingStateStore> {
    await mkdir(dataDir, { recursive: true })
    const store = new ReadingStateStore(join(dataDir, 'state.json'))
    try {
      const raw = await readFile(store.#path, 'utf8')
      const parsed = JSON.parse(raw) as Partial<ReadingStateSnapshot>
      store.#state = {
        progress: isRecord(parsed.progress) ? parsed.progress as ReadingStateSnapshot['progress'] : {},
        annotations: Array.isArray(parsed.annotations) ? parsed.annotations as Annotation[] : [],
      }
    } catch {
      store.#state = structuredClone(EMPTY_STATE)
    }
    return store
  }

  get snapshot(): ReadingStateSnapshot {
    return structuredClone(this.#state)
  }

  getProgress(bookId: string): ReadingProgress | undefined {
    const value = this.#state.progress[bookId]
    return value === undefined ? undefined : structuredClone(value)
  }

  async setProgress(progress: ReadingProgress): Promise<ReadingProgress> {
    await this.update(state => {
      state.progress[progress.bookId] = progress
    })
    return structuredClone(progress)
  }

  async addAnnotation(annotation: Annotation): Promise<Annotation> {
    await this.update(state => {
      state.annotations = state.annotations.filter(item => item.id !== annotation.id)
      state.annotations.push(annotation)
      state.annotations.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    })
    return structuredClone(annotation)
  }

  async removeAnnotation(id: string): Promise<boolean> {
    let removed = false
    await this.update(state => {
      const next = state.annotations.filter(item => item.id !== id)
      removed = next.length !== state.annotations.length
      state.annotations = next
    })
    return removed
  }

  listAnnotations(bookId?: string): Annotation[] {
    const all = this.#state.annotations
    const filtered = bookId === undefined ? all : all.filter(item => item.bookId === bookId)
    return structuredClone(filtered)
  }

  /** Serialize mutations so concurrent writers never interleave temp writes. */
  async update(mutate: (state: ReadingStateSnapshot) => void): Promise<void> {
    const run = async (): Promise<void> => {
      const draft = structuredClone(this.#state)
      mutate(draft)
      this.#state = draft
      await mkdir(dirname(this.#path), { recursive: true })
      const temp = `${this.#path}.tmp-${process.pid}-${Date.now()}`
      await writeFile(temp, `${JSON.stringify(draft, null, 2)}\n`, 'utf8')
      await rename(temp, this.#path)
    }
    this.#writeQueue = this.#writeQueue.then(run, run)
    return this.#writeQueue
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
