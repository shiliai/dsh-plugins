import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channels = [0, 2, 4].map(index => Number.parseInt(hex.slice(index + 1, index + 3), 16) / 255)
    const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
  }
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

describe('WeCom diagnostic styles', () => {
  it('separates indicator states from readable diagnostic text', async () => {
    const css = await readFile(new URL('../src/client/styles.module.css', import.meta.url), 'utf8')
    expect(css).toContain('.indicatorError')
    expect(css).toContain('.diagnostic, .requestError')
    expect(css).not.toContain('.diagnostic, .error')
    expect(contrast('#991b1b', '#fef2f2')).toBeGreaterThanOrEqual(4.5)
  })
})
