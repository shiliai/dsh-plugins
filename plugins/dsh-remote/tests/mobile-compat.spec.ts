import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  clearMobileCompatibility,
  syncMobileCompatibility,
  syncMobileSessionCollapse,
} from '../src/client/mobile-compat.ts'
import { openMobileSidebar } from '../src/client/index.tsx'

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
    conversation.select('header, [role="banner"]', header)
    center.append(conversation)
    frame.select('[data-phase="active"]', conversation)

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

    const marked = new Set<Element>()
    syncMobileCompatibility(document as unknown as Document, marked)

    expect(frame.attributes).toContain('data-dsh-remote-mobile-frame')
    expect(frame.attributes).toContain('data-dsh-remote-mobile-session-active')
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

    clearMobileCompatibility(marked)
    expect(marked.size).toBe(0)
    for (const element of [frame, sidebar, center, details, conversation, header, composer, card, row, tools, trailing, footer]) {
      expect([...element.attributes].filter(name => name.startsWith('data-dsh-remote-mobile-'))).toEqual([])
    }
  })

  it('pins mobile-only responsive rules and desktop isolation', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/client/styles.module.css'), 'utf8')
    expect(css).toContain('@media (max-width: 640px)')
    expect(css).toContain('grid-template-columns: 56px minmax(0, 1fr) 0 !important')
    expect(css).toContain('grid-template-columns: 0 minmax(0, 1fr) 0 !important')
    expect(css).toContain('[data-dsh-remote-mobile-center] { grid-column: 2; }')
    expect(css).toContain('[data-dsh-remote-mobile-session-active] .mobileSidebarButton')
    expect(css).toContain(':not([data-sidebar-collapsed])')
    expect(css).toContain(':not([data-details-collapsed])')
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(css).toContain('height: 100dvh')
  })

  it('forwards the mobile navigation button to the upstream sidebar toggle', () => {
    const click = vi.fn()
    const upstreamButton = {
      getAttribute: () => '打开侧边栏',
      click,
    }
    const document = {
      querySelectorAll: () => [upstreamButton],
    }

    expect(openMobileSidebar(document as unknown as Document)).toBe(true)
    expect(click).toHaveBeenCalledOnce()
  })

  it('collapses the sidebar once when a conversation becomes active', () => {
    const click = vi.fn()
    const collapseButton = {
      getAttribute: () => 'Collapse sidebar',
      click,
    }
    const frame = new FakeElement()
    frame.attributes.add('data-dsh-remote-mobile-session-active')
    const document = new FakeElement()
      .select('[data-dsh-remote-mobile-frame]', frame)
      .select('button[aria-label]', collapseButton as unknown as FakeElement)
    const activeFrames = new Set<Element>()

    syncMobileSessionCollapse(document as unknown as Document, activeFrames, true)
    syncMobileSessionCollapse(document as unknown as Document, activeFrames, true)

    expect(click).toHaveBeenCalledOnce()

    activeFrames.clear()
    syncMobileSessionCollapse(document as unknown as Document, activeFrames, false)
    expect(click).toHaveBeenCalledOnce()
  })

  it('retries collapsing until the upstream sidebar control is available', () => {
    const frame = new FakeElement()
    frame.attributes.add('data-dsh-remote-mobile-session-active')
    const document = new FakeElement().select('[data-dsh-remote-mobile-frame]', frame)
    const activeFrames = new Set<Element>()

    syncMobileSessionCollapse(document as unknown as Document, activeFrames, true)

    expect(activeFrames.size).toBe(0)
  })
})
