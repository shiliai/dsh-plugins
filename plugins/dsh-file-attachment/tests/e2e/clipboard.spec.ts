import { expect, test } from '@playwright/test'
import { clipboardFiles } from '../../src/client/clipboard.ts'

test('pastes Safari files and Chromium items into a composer without duplicates', async ({ page }) => {
  await page.setContent('<textarea aria-label="composer"></textarea><output></output>')
  await page.evaluate((source) => {
    const extract = (0, eval)(`(${source})`) as (data: DataTransfer) => File[]
    const textarea = document.querySelector('textarea')!
    const output = document.querySelector('output')!
    textarea.addEventListener('paste', event => {
      const files = extract(event.clipboardData!)
      if (files.length === 0) return
      event.preventDefault()
      output.textContent = files.map(file => file.name).join(',')
    })
  }, clipboardFiles.toString())

  const safari = await page.evaluate(() => {
    const file = new File(['safari'], 'safari.png', { type: 'image/png', lastModified: 1 })
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: {
      files: { length: 1, item: (index: number) => index === 0 ? file : null },
      items: { length: 0 },
    } })
    return { accepted: !document.querySelector('textarea')!.dispatchEvent(event), value: document.querySelector('output')!.textContent }
  })
  expect(safari).toEqual({ accepted: true, value: 'safari.png' })

  const chromium = await page.evaluate(() => {
    const file = new File(['chrome'], 'chrome.png', { type: 'image/png', lastModified: 2 })
    const clone = new File(['chrome'], 'chrome.png', { type: 'image/png', lastModified: 2 })
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: {
      files: { length: 1, item: (index: number) => index === 0 ? file : null },
      items: { 0: { kind: 'file', getAsFile: () => clone }, length: 1 },
    } })
    return { accepted: !document.querySelector('textarea')!.dispatchEvent(event), value: document.querySelector('output')!.textContent }
  })
  expect(chromium).toEqual({ accepted: true, value: 'chrome.png' })
})
