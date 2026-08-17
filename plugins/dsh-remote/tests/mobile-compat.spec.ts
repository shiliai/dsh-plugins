import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { syncMobileCompatibility } from '../src/client/mobile-compat.ts'

class FakeElement {
  readonly attributes = new Set<string>()
  readonly children: FakeElement[] = []
  parentElement: FakeElement | null = null
  private readonly selectors = new Map<string, FakeElement[]>()

  append(...children: FakeElement[]): this {
    for (const child of children) {
      child.parentElement = this
      this.children.push(child)
    }
    return this
  }

  select(selector: string, ...elements: FakeElement[]): this {
    this.selectors.set(selector, elements)
    return this
  }

  querySelector(selector: string): FakeElement | null {
    return this.selectors.get(selector)?.[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.selectors.get(selector) ?? []
  }

  contains(element: FakeElement): boolean {
    for (let current: FakeElement | null = element; current !== null; current = current.parentElement) {
      if (current === this) return true
    }
    return false
  }

  hasAttribute(name: string): boolean { return this.attributes.has(name) }
  setAttribute(name: string): void { this.attributes.add(name) }
  removeAttribute(name: string): void { this.attributes.delete(name) }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null }
  get lastElementChild(): FakeElement | null { return this.children.at(-1) ?? null }
}

describe('mobile compatibility markers', () => {
  it('marks stable shell, conversation, and composer structures without hashed classes', () => {
    const sidebar = new FakeElement()
    const center = new FakeElement()
    const details = new FakeElement()
    const overlay = new FakeElement()
    const frame = new FakeElement().append(sidebar, center, details, overlay)

    const header = new FakeElement()
    const scroll = new FakeElement()
    const conversation = new FakeElement().append(header, scroll)
    conversation.attributes.add('data-phase')
    conversation.select('[role="banner"]', header)

    const textarea = new FakeElement()
    const grow = new FakeElement().append(textarea)
    const inputScroll = new FakeElement().append(grow)
    const tools = new FakeElement()
    const trailing = new FakeElement()
    const rowButton = new FakeElement()
    const row = new FakeElement().append(tools, trailing).select('button', rowButton)
    const card = new FakeElement().append(inputScroll, row)
    const footer = new FakeElement()
    const composer = new FakeElement().append(card, footer)
    const seat = new FakeElement().append(composer).select('textarea', textarea)

    const document = new FakeElement()
      .select('[data-shell-overlay]', overlay)
      .select('[data-conversation-scroll]', scroll)
      .select('[data-composer-seat]', seat)

    syncMobileCompatibility(document as unknown as Document, new Set())

    expect(frame.attributes).toContain('data-dsh-remote-mobile-frame')
    expect(sidebar.attributes).toContain('data-dsh-remote-mobile-sidebar')
    expect(center.attributes).toContain('data-dsh-remote-mobile-center')
    expect(details.attributes).toContain('data-dsh-remote-mobile-details')
    expect(conversation.attributes).toContain('data-dsh-remote-mobile-conversation')
    expect(header.attributes).toContain('data-dsh-remote-mobile-header')
    expect(composer.attributes).toContain('data-dsh-remote-mobile-composer')
    expect(card.attributes).toContain('data-dsh-remote-mobile-composer-card')
    expect(row.attributes).toContain('data-dsh-remote-mobile-composer-row')
    expect(tools.attributes).toContain('data-dsh-remote-mobile-composer-tools')
    expect(trailing.attributes).toContain('data-dsh-remote-mobile-composer-trailing')
    expect(footer.attributes).toContain('data-dsh-remote-mobile-composer-footer')
  })

  it('pins mobile-only responsive rules and desktop isolation', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/client/styles.module.css'), 'utf8')
    expect(css).toContain('@media (max-width: 640px)')
    expect(css).toContain('grid-template-columns: 56px minmax(0, 1fr) 0 !important')
    expect(css).toContain(':not([data-sidebar-collapsed])')
    expect(css).toContain(':not([data-details-collapsed])')
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(css).toContain('height: 100dvh')
  })
})
