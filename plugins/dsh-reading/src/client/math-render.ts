/**
 * Client-side math rendering for article HTML.
 *
 * The Wallabag pipeline (patched graby) converts WeChat formula spans into
 * plain-text LaTeX delimited by \( ... \) and \[ ... \]. This module walks an
 * article's rendered DOM, converts those fragments into MathJax SVG output,
 * and swaps them in place. MathJax is loaded lazily (and only when the content
 * actually contains math delimiters) so article-free sessions never pay for it.
 */

export interface TextFragment { kind: 'text'; value: string }
export interface MathFragment { kind: 'math'; latex: string; display: boolean }
export type MathSplitFragment = TextFragment | MathFragment

/** Matches non-greedy \( ... \) or \[ ... \) runs, tolerating newlines inside. */
const MATH_PATTERN = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g
/** Cheap pre-check used to skip DOM subtrees (and lazy-load) when no math exists. */
const MATH_HINT = /\\\(|\\\]/

/**
 * Split a text run into literal text and LaTeX fragments. Empty math bodies and
 * unbalanced delimiters stay literal so they can never corrupt plain content.
 */
export function splitMathFragments(text: string): MathSplitFragment[] {
  const fragments: MathSplitFragment[] = []
  let cursor = 0
  MATH_PATTERN.lastIndex = 0
  for (let match = MATH_PATTERN.exec(text); match !== null; match = MATH_PATTERN.exec(text)) {
    const index = match.index ?? 0
    if (index > cursor) fragments.push({ kind: 'text', value: text.slice(cursor, index) })
    const inline = match[1] !== undefined
    const latex = (inline ? match[1] : match[2])?.trim() ?? ''
    if (latex === '') {
      fragments.push({ kind: 'text', value: match[0] })
    } else {
      fragments.push({ kind: 'math', latex, display: !inline })
    }
    cursor = index + match[0].length
  }
  if (cursor < text.length) fragments.push({ kind: 'text', value: text.slice(cursor) })
  return fragments
}

type LatexConverter = (latex: string, display: boolean) => Node

let converterPromise: Promise<LatexConverter | null> | null = null

/** Lazily bundle-initialize MathJax (TeX input, SVG output — no webfont assets). */
function ensureConverter(): Promise<LatexConverter | null> {
  converterPromise ??= (async () => {
    try {
      const [{ mathjax }, { TeX }, { SVG }, { browserAdaptor }, { RegisterHTMLHandler }, { AllPackages }] = await Promise.all([
        import('mathjax-full/js/mathjax.js'),
        import('mathjax-full/js/input/tex.js'),
        import('mathjax-full/js/output/svg.js'),
        import('mathjax-full/js/adaptors/browserAdaptor.js'),
        import('mathjax-full/js/handlers/html.js'),
        import('mathjax-full/js/input/tex/AllPackages.js'),
      ])
      RegisterHTMLHandler(browserAdaptor())
      const tex = new TeX({
        packages: AllPackages,
        // Compilation errors fall back to the literal delimiter text instead of
        // an opaque red error node inside the reading pane.
        formatError: (_jax: unknown, error: Error) => { throw error },
      })
      const svg = new SVG({ fontCache: 'local' })
      const mathDocument = mathjax.document('', { InputJax: tex, OutputJax: svg })
      const styleNode = svg.styleSheet(mathDocument) as HTMLStyleElement | null
      if (styleNode !== null && typeof document !== 'undefined') {
        styleNode.dataset.plugin = '@dsh-plugins/dsh-reading'
        if (document.querySelector('style[data-plugin="@dsh-plugins/dsh-reading"][data-mathjax="tex-svg"]') === null) {
          styleNode.dataset.mathjax = 'tex-svg'
          document.head.appendChild(styleNode)
        }
      }
      return (latex: string, display: boolean): Node =>
        mathDocument.convert(latex, { display }) as unknown as Node
    } catch {
      return null
    }
  })()
  return converterPromise
}

const SKIP_INSIDE = /^(?:script|style|code|pre|textarea)$/i

/**
 * Render \( ... \) / \[ ... \] fragments inside `root` in place. Safe to call
 * repeatedly: text without delimiters is left untouched, and nodes whose math
 * fails to compile keep their literal source.
 */
export async function renderMathInPlace(root: HTMLElement): Promise<void> {
  if (typeof document === 'undefined' || !MATH_HINT.test(root.textContent ?? '')) return
  const convert = await ensureConverter()
  if (convert === null) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement
      if (parent !== null && SKIP_INSIDE.test(parent.tagName)) return NodeFilter.FILTER_REJECT
      return MATH_HINT.test(node.nodeValue ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  const targets: Text[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) targets.push(node as Text)
  for (const textNode of targets) {
    const value = textNode.nodeValue ?? ''
    const fragments = splitMathFragments(value)
    // Skip pure-text nodes; a node that is entirely one formula must still convert.
    if (!fragments.some(fragment => fragment.kind === 'math')) continue
    const replacement = document.createDocumentFragment()
    for (const fragment of fragments) {
      if (fragment.kind === 'text') {
        replacement.appendChild(document.createTextNode(fragment.value))
        continue
      }
      try {
        replacement.appendChild(convert(fragment.latex, fragment.display))
      } catch {
        replacement.appendChild(document.createTextNode(fragment.display ? `\\[${fragment.latex}\\]` : `\\(${fragment.latex}\\)`))
      }
    }
    textNode.parentNode?.replaceChild(replacement, textNode)
  }
}
