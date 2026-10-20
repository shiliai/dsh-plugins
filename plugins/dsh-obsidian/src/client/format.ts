/**
 * Small presentation helpers for the Properties dialog. Kept out of the TSX
 * module so they unit-test without a DOM.
 */

/** Human byte size (`1.4 KB`, `812 B`); an absent value renders as an em dash. */
export function formatBytes(size: number | undefined): string {
  if (size === undefined || !Number.isFinite(size) || size < 0) return '—'
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = size / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`
}

/** Local date-time for a stat timestamp; `0`/invalid renders as an em dash. */
export function formatTimestamp(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString()
}
