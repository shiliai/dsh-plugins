/** Type shims for foliate-js (ships no type declarations). */

declare module 'foliate-js/view.js' {
  export interface FoliateTocItem {
    label: string
    href: string
    subitems?: FoliateTocItem[]
  }

  export interface FoliateRelocateDetail {
    /** Book-wide progress fraction, 0..1. */
    fraction?: number
    index?: number
    /** epubcfi string for the current position. */
    cfi?: string
    tocItem?: { label?: string; href?: string }
    [key: string]: unknown
  }

  export interface FoliateAnnotation {
    value: string
    color?: string
  }

  export class View extends HTMLElement {
    book: {
      metadata?: { title?: unknown; author?: unknown; language?: unknown }
      toc?: FoliateTocItem[]
      sections: Array<{ id?: unknown; linear?: string }>
      dir?: string
      resolveHref?: (href: string) => unknown
      landmarks?: Array<{ type: string[]; href: string }>
    } | null
    lastLocation: FoliateRelocateDetail | null
    open(book: string | Blob | File): Promise<void>
    close(): void
    goTo(target: unknown): Promise<unknown>
    goToTextStart(): Promise<unknown>
    goToFraction(frac: number): Promise<void>
    next(distance?: number): Promise<void>
    prev(distance?: number): Promise<void>
    addAnnotation(annotation: FoliateAnnotation, remove?: boolean): Promise<{ index: number; label: string } | void>
    deleteAnnotation(annotation: FoliateAnnotation): Promise<{ index: number; label: string } | void>
    showAnnotation(annotation: FoliateAnnotation): Promise<void>
    renderer?: HTMLElement & {
      setStyles?(css: string): void
      getContents?(): Array<{ index: number; doc: Document | null; overlayer?: unknown }>
    }
  }
}

declare module 'foliate-js/epubcfi.js' {
  export function isCFIString(value: string): boolean
  export const isCFI: RegExp
}
