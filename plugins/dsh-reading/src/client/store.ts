import { useSyncExternalStore } from 'react'
import type { BookWithProgress, Locator, ReadingProgress } from '../contracts.ts'
import { readingApi } from './api.ts'

export interface ReadingClientState {
  books: BookWithProgress[]
  loading: boolean
  error: string | null
  /** Book currently open in the reader pane. */
  current: BookWithProgress | null
}

const INITIAL: ReadingClientState = { books: [], loading: false, error: null, current: null }

type Listener = () => void

export class ReadingStore {
  #state: ReadingClientState = INITIAL
  #listeners = new Set<Listener>()
  #progressFlush: { bookId: string; locator: Locator; percent: number; timer: ReturnType<typeof setTimeout> } | null = null

  get snapshot(): ReadingClientState {
    return this.#state
  }

  subscribe = (listener: Listener): () => void => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  useSnapshot = (): ReadingClientState => useSyncExternalStore(this.subscribe, () => this.#state)

  #set(patch: Partial<ReadingClientState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) listener()
  }

  async refresh(): Promise<void> {
    this.#set({ loading: true, error: null })
    try {
      const { books } = await readingApi.library()
      this.#set({
        books,
        loading: false,
        current: this.#state.current === null ? null : books.find(book => book.id === this.#state.current?.id) ?? null,
      })
    } catch (error) {
      this.#set({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  openBook(book: BookWithProgress): void {
    this.#set({ current: book })
  }

  closeBook(): void {
    this.flushProgress()
    this.#set({ current: null })
  }

  async importFile(file: File): Promise<void> {
    await readingApi.importBook(file)
    await this.refresh()
  }

  /** Debounced progress persistence; flushes on close/unmount. */
  reportProgress(bookId: string, locator: Locator, percent: number): void {
    const pending = this.#progressFlush
    if (pending !== null && pending.bookId === bookId) {
      clearTimeout(pending.timer)
    }
    this.#setCurrentProgress(locator, percent)
    this.#progressFlush = {
      bookId, locator, percent,
      timer: setTimeout(() => { void this.flushProgress() }, 1500),
    }
  }

  #setCurrentProgress(locator: Locator, percent: number): void {
    const current = this.#state.current
    if (current === null) return
    const progress: ReadingProgress = { bookId: current.id, locator, percent, updatedAt: new Date().toISOString() }
    const books = this.#state.books.map(book => book.id === current.id ? { ...book, progress } : book)
    this.#set({ books, current: { ...current, progress } })
  }

  async flushProgress(): Promise<void> {
    const pending = this.#progressFlush
    if (pending === null) return
    this.#progressFlush = null
    clearTimeout(pending.timer)
    try {
      await readingApi.setProgress(pending.bookId, pending.locator, pending.percent)
    } catch {
      // Best effort: the reader keeps relocating and will retry on next move.
    }
  }
}
