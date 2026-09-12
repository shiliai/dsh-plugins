/** User-level reading preferences (M1: localStorage; M4 moves to DSH settings panel). */

export type ThemeName = 'dark' | 'paper' | 'sepia'

export interface ReadingTheme {
  background: string
  color: string
  linkColor: string
}

export const READING_THEMES: Record<ThemeName, ReadingTheme> = {
  dark: { background: '#16181d', color: '#e8e6e3', linkColor: '#7fb4e8' },
  paper: { background: '#ffffff', color: '#1f2328', linkColor: '#1a5fb4' },
  sepia: { background: '#f5ecd9', color: '#4b3a24', linkColor: '#8a5a2b' },
}

export interface ReadingPrefs {
  fontSize: number
  lineHeight: number
  fontFamily: string
  themeName: ThemeName
  theme: ReadingTheme
  /** EPUB flow: paginated columns or scrolled. */
  flow: 'paginated' | 'scrolled'
}

export const FONT_FAMILY_OPTIONS: Array<{ label: string; value: string }> = [
  { label: '系统默认', value: "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif" },
  { label: '宋体 / 衬线', value: "'Songti SC', 'Noto Serif CJK SC', 'SimSun', serif" },
  { label: '黑体 / 无衬线', value: "'PingFang SC', 'Noto Sans CJK SC', 'SimHei', sans-serif" },
  { label: '西文衬线', value: "Georgia, 'Times New Roman', serif" },
]

const STORAGE_KEY = 'dsh-reading.prefs'

export function loadPrefs(): ReadingPrefs {
  const fallback: ReadingPrefs = {
    fontSize: 18,
    lineHeight: 1.7,
    fontFamily: FONT_FAMILY_OPTIONS[0]?.value ?? 'system-ui',
    themeName: 'dark',
    theme: READING_THEMES.dark,
    flow: 'paginated',
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return fallback
    const value = JSON.parse(raw) as Partial<ReadingPrefs>
    const themeName = value.themeName === 'paper' || value.themeName === 'sepia' ? value.themeName : 'dark'
    return {
      fontSize: clampNumber(value.fontSize, 12, 28, fallback.fontSize),
      lineHeight: clampNumber(value.lineHeight, 1.2, 2.4, fallback.lineHeight),
      fontFamily: typeof value.fontFamily === 'string' ? value.fontFamily : fallback.fontFamily,
      themeName,
      theme: READING_THEMES[themeName],
      flow: value.flow === 'scrolled' ? 'scrolled' : 'paginated',
    }
  } catch {
    return fallback
  }
}

export function savePrefs(prefs: ReadingPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch { /* private mode etc. */ }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}
