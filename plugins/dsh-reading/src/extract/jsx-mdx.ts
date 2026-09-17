/**
 * Minimal parser for MDX-compiled client bundles (`(0,x.jsx)(Component, props)`
 * call shape produced by the MDX compiler).
 *
 * This is deliberately NOT a general JavaScript parser: it only recognizes the
 * code shapes emitted for MDX content pages. Any unexpected shape makes the
 * parse fail with `undefined` instead of producing half-written markup.
 */

export interface MdxBundleResult {
  html: string
  title?: string
  date?: string
}

/** Refuse to parse huge inputs; real MDX bundles are a few dozen KB. */
const MAX_SOURCE_LENGTH = 2_000_000
/** Guard against pathological nesting depth. */
const MAX_DEPTH = 200

const WHITESPACE = new Set([' ', '\t', '\r', '\n', '\f', '\uFEFF'])

/** HTML elements the extracted markup is allowed to produce. */
const SAFE_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'cite', 'code', 'dd', 'del', 'details', 'div', 'em',
  'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd',
  'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
])

/** Elements rendered without a closing tag. */
const VOID_TAGS = new Set(['img', 'br', 'hr'])

type Expr =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'ref'; name: string }
  | { kind: 'jsx'; component: string; props: Map<string, Expr> }
  | { kind: 'array'; items: Expr[] }
  | { kind: 'object'; entries: Map<string, Expr> }

class BundleParseError extends Error {
  constructor(position: number, reason: string) {
    super(`Unexpected MDX bundle shape at ${position}: ${reason}`)
    this.name = 'BundleParseError'
  }
}

const TEMPLATE_ESCAPES: Record<string, string> = {
  n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0',
}

/** Decode the escape sequences MDX bundles use inside string literals. */
function decodeEscapes(raw: string): string {
  let result = ''
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!
    if (char !== '\\') { result += char; continue }
    index += 1
    const next = raw[index]
    if (next === undefined) throw new BundleParseError(index, 'dangling escape')
    if (next === '\n') continue // line continuation
    result += TEMPLATE_ESCAPES[next] ?? next
  }
  return result
}

class Parser {
  readonly #source: string
  #pos: number

  constructor(source: string, start: number) {
    this.#source = source
    this.#pos = start
  }

  get pos(): number { return this.#pos }

  /** Parse a dotted identifier such as `t.p` or `u.Fragment`. */
  #parseDottedName(): string {
    this.#skipWhitespace()
    const match = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/u.exec(this.#source.slice(this.#pos, this.#pos + 512))
    if (match === null || match[0] === undefined) throw new BundleParseError(this.#pos, 'expected identifier')
    this.#pos += match[0].length
    return match[0].replace(/\s*\.\s*/gu, '.')
  }

  #parseTemplate(): Expr {
    this.#pos += 1 // opening backtick
    let raw = ''
    for (;;) {
      const char = this.#peek()
      if (char === undefined) throw new BundleParseError(this.#pos, 'unterminated template literal')
      if (char === '`') { this.#pos += 1; return { kind: 'string', value: decodeEscapes(raw) } }
      if (char === '\\') {
        const next = this.#peek(1)
        if (next === undefined) throw new BundleParseError(this.#pos, 'dangling escape')
        raw += char + next
        this.#pos += 2
        continue
      }
      // Unescaped `${` means runtime interpolation, which we refuse to guess at.
      if (char === '$' && this.#peek(1) === '{') throw new BundleParseError(this.#pos, 'template interpolation is not supported')
      raw += char
      this.#pos += 1
    }
  }

  #parseQuoted(): Expr {
    const quote = this.#peek()
    if (quote !== '"' && quote !== "'") throw new BundleParseError(this.#pos, 'expected quote')
    this.#pos += 1
    let raw = ''
    for (;;) {
      const char = this.#peek()
      if (char === undefined || char === '\n') throw new BundleParseError(this.#pos, 'unterminated string literal')
      if (char === quote) { this.#pos += 1; return { kind: 'string', value: decodeEscapes(raw) } }
      if (char === '\\') {
        const next = this.#peek(1)
        if (next === undefined) throw new BundleParseError(this.#pos, 'dangling escape')
        raw += char + next
        this.#pos += 2
        continue
      }
      raw += char
      this.#pos += 1
    }
  }

  #parseNumber(): Expr {
    const match = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(this.#source.slice(this.#pos, this.#pos + 64))
    if (match === null || match[0] === undefined) throw new BundleParseError(this.#pos, 'expected number')
    this.#pos += match[0].length
    return { kind: 'number', value: Number(match[0]) }
  }

  parseObjectEntries(depth: number): Map<string, Expr> {
    if (depth > MAX_DEPTH) throw new BundleParseError(this.#pos, 'depth limit exceeded')
    const entries = new Map<string, Expr>()
    this.#expect('{')
    for (;;) {
      this.#skipWhitespace()
      const char = this.#peek()
      if (char === '}') { this.#pos += 1; return entries }
      if (char === undefined) throw new BundleParseError(this.#pos, 'unterminated object literal')
      if (char === '.' && this.#peek(1) === '.' && this.#peek(2) === '.') {
        // Spread of a runtime value (e.g. `...e.components`): ignore it.
        this.#pos += 3
        this.#parseDottedName()
      } else {
        let key: string
        if (char === '"' || char === "'" || char === '`') {
          const parsed = char === '`' ? this.#parseTemplate() : this.#parseQuoted()
          if (parsed.kind !== 'string') throw new BundleParseError(this.#pos, 'object key must be a string')
          key = parsed.value
        } else {
          key = this.#parseDottedName()
        }
        this.#expect(':')
        entries.set(key, this.parseExpression(depth + 1))
      }
      this.#skipWhitespace()
      const separator = this.#peek()
      if (separator === ',') { this.#pos += 1; continue }
      if (separator === '}') { this.#pos += 1; return entries }
      throw new BundleParseError(this.#pos, 'expected , or } in object literal')
    }
  }

  #parseArrayItems(depth: number): Expr[] {
    if (depth > MAX_DEPTH) throw new BundleParseError(this.#pos, 'depth limit exceeded')
    const items: Expr[] = []
    this.#expect('[')
    for (;;) {
      this.#skipWhitespace()
      const char = this.#peek()
      if (char === ']') { this.#pos += 1; return items }
      if (char === undefined) throw new BundleParseError(this.#pos, 'unterminated array literal')
      if (char === ',') { this.#pos += 1; continue }
      items.push(this.parseExpression(depth + 1))
      this.#skipWhitespace()
      const separator = this.#peek()
      if (separator === ',') { this.#pos += 1; continue }
      if (separator === ']') { this.#pos += 1; return items }
      throw new BundleParseError(this.#pos, 'expected , or ] in array literal')
    }
  }

  /**
   * Parse a JSX factory invocation `(0,x.jsx)(Component, props)` / `(0,x.jsxs)(...)`
   * and return `{ kind: 'jsx' }`; anything else parses as a plain value.
   */
  #parseParenthesized(depth: number): Expr {
    if (depth > MAX_DEPTH) throw new BundleParseError(this.#pos, 'depth limit exceeded')
    this.#expect('(')
    this.#skipWhitespace()
    const items: Expr[] = []
    for (;;) {
      items.push(this.parseExpression(depth + 1))
      this.#skipWhitespace()
      const separator = this.#peek()
      if (separator === ',') { this.#pos += 1; this.#skipWhitespace(); continue }
      if (separator === ')') { this.#pos += 1; break }
      throw new BundleParseError(this.#pos, 'expected , or ) in parenthesized expression')
    }
    const factory = items.length === 2 && items[0]?.kind === 'number' && items[0]?.value === 0 ? items[1] : undefined
    if (factory?.kind !== 'ref' || !/\.(?:jsx|jsxs)$/u.test(factory.name)) {
      if (items.length === 1) return items[0]!
      return { kind: 'object', entries: new Map() }
    }
    // JSX factory: `(Component, props)` must follow immediately.
    this.#expect('(')
    const componentExpr = this.parseExpression(depth + 1)
    if (componentExpr.kind !== 'ref') throw new BundleParseError(this.#pos, 'JSX component must be an identifier')
    this.#expect(',')
    const props = this.parseObjectEntries(depth + 1)
    this.#expect(')')
    return { kind: 'jsx', component: componentExpr.name, props }
  }

  parseExpression(depth = 0): Expr {
    if (depth > MAX_DEPTH) throw new BundleParseError(this.#pos, 'depth limit exceeded')
    this.#skipWhitespace()
    const char = this.#peek()
    if (char === undefined) throw new BundleParseError(this.#pos, 'unexpected end of input')
    if (char === '`') return this.#parseTemplate()
    if (char === '"' || char === "'") return this.#parseQuoted()
    if (char === '{') return { kind: 'object', entries: this.parseObjectEntries(depth + 1) }
    if (char === '[') return { kind: 'array', items: this.#parseArrayItems(depth + 1) }
    if (char === '(') return this.#parseParenthesized(depth + 1)
    if (char === '!') {
      // Minified booleans: `!0` → true, `!1` → false.
      const next = this.#peek(1)
      if (next === '0') { this.#pos += 2; return { kind: 'boolean', value: true } }
      if (next === '1') { this.#pos += 2; return { kind: 'boolean', value: false } }
      throw new BundleParseError(this.#pos, 'unsupported ! expression')
    }
    if (/\d/u.test(char)) return this.#parseNumber()
    if (/[A-Za-z_$]/u.test(char)) {
      const name = this.#parseDottedName()
      this.#skipWhitespace()
      if (this.#peek() === '(') throw new BundleParseError(this.#pos, 'runtime function calls are not supported')
      return { kind: 'ref', name }
    }
    throw new BundleParseError(this.#pos, `unsupported character '${char}'`)
  }

  #peek(offset = 0): string | undefined {
    return this.#source[this.#pos + offset]
  }

  #skipWhitespace(): void {
    while (this.#pos < this.#source.length && WHITESPACE.has(this.#source[this.#pos]!)) this.#pos += 1
  }

  #expect(char: string): void {
    this.#skipWhitespace()
    if (this.#peek() !== char) throw new BundleParseError(this.#pos, `expected '${char}'`)
    this.#pos += 1
  }
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;')
}

function lastSegment(name: string): string {
  const index = name.lastIndexOf('.')
  return index === -1 ? name : name.slice(index + 1)
}

function attributeValue(entry: Expr | undefined): string | undefined {
  return entry?.kind === 'string' ? entry.value : undefined
}

function attributesFor(tag: string, props: Map<string, Expr>): string {
  let result = ''
  const append = (name: string, value: string): void => { result += ` ${name}="${escapeAttribute(value)}"` }
  const className = attributeValue(props.get('className'))
  if (className !== undefined) append('class', className)
  if (tag === 'a') {
    const href = attributeValue(props.get('href'))
    // Only absolute http(s) links survive; relative and exotic schemes are dropped.
    if (href !== undefined && /^https?:\/\//iu.test(href)) append('href', href)
  }
  if (tag === 'img') {
    for (const key of ['src', 'alt', 'title'] as const) {
      const value = attributeValue(props.get(key))
      if (value !== undefined) append(key, value)
    }
  }
  return result
}

function renderValue(expr: Expr, tags: Map<string, string>, depth: number): string {
  if (depth > MAX_DEPTH) throw new BundleParseError(0, 'render depth limit exceeded')
  switch (expr.kind) {
    case 'string':
      // Pure-whitespace separators between elements (e.g. "\n") are skipped;
      // meaningful text keeps its newlines (`pre`/`code` rely on that).
      return expr.value.trim() === '' ? '' : escapeText(expr.value)
    case 'array':
      return expr.items.map(item => renderValue(item, tags, depth + 1)).join('')
    case 'jsx': {
      const component = lastSegment(expr.component)
      const tag = component === 'Fragment' ? undefined : tags.get(component)
      if (tag === undefined) {
        // `x.Fragment` and unknown components render transparently.
        const children = expr.props.get('children')
        return children === undefined ? '' : renderValue(children, tags, depth + 1)
      }
      if (VOID_TAGS.has(tag)) return `<${tag}${attributesFor(tag, expr.props)}>`
      const children = expr.props.get('children')
      const inner = children === undefined ? '' : renderValue(children, tags, depth + 1)
      return `<${tag}${attributesFor(tag, expr.props)}>${inner}</${tag}>`
    }
    case 'object':
    case 'boolean':
    case 'number':
      return ''
    case 'ref':
      // Runtime references must never appear where content is expected.
      throw new BundleParseError(0, `unexpected reference '${expr.name}' in content position`)
  }
}

interface TagMapping {
  tags: Map<string, string>
  end: number
}

const MAPPING_START = /\b(?:let|const|var)\s+[A-Za-z_$][\w$]*\s*=\s*\{/gu

function findTagMapping(source: string): TagMapping | undefined {
  MAPPING_START.lastIndex = 0
  for (;;) {
    const match = MAPPING_START.exec(source)
    if (match === null) return undefined
    const braceIndex = match.index + match[0].length - 1
    try {
      const parser = new Parser(source, braceIndex)
      const entries = parser.parseObjectEntries(0)
      const tags = new Map<string, string>()
      let valid = true
      for (const [key, value] of entries) {
        if (value.kind !== 'string' || value.value !== key || !SAFE_TAGS.has(key)) { valid = false; break }
        tags.set(key, value.value)
      }
      if (valid && tags.has('p') && tags.has('h1')) return { tags, end: parser.pos }
    } catch {
      // Try the next declaration that looks like a mapping object.
    }
  }
}

const TEMPLATE_VALUE = /\b(title|date)\s*:\s*`((?:\\.|[^`\\])*)`/gu

function lastTemplateValue(source: string, key: 'title' | 'date'): string | undefined {
  TEMPLATE_VALUE.lastIndex = 0
  let result: string | undefined
  for (;;) {
    const match = TEMPLATE_VALUE.exec(source)
    if (match === null) break
    if (match[1] === key && match[2] !== undefined) result = decodeEscapes(match[2])
  }
  return result
}

/**
 * Parse an MDX-compiled bundle into article HTML. Returns `undefined` for any
 * input that does not match the known compiler output shape.
 */
export function parseMdxBundle(source: string): MdxBundleResult | undefined {
  if (source.length > MAX_SOURCE_LENGTH) return undefined
  const mapping = findTagMapping(source)
  if (mapping === undefined) return undefined
  // The content tree is the expression after the first return following the
  // component mapping. Occurrences that fail to parse (e.g. the word "return"
  // inside article text) are skipped, mirroring the lenient mapping scan.
  const content = /\breturn\b/gu
  content.lastIndex = mapping.end
  for (;;) {
    const match = content.exec(source)
    if (match === null) return undefined
    let tree: Expr
    try {
      const parser = new Parser(source, match.index + match[0].length)
      tree = parser.parseExpression()
    } catch {
      continue
    }
    try {
      const html = renderValue(tree, mapping.tags, 0)
      const title = lastTemplateValue(source, 'title')
      const date = lastTemplateValue(source, 'date')
      return { html, ...(title !== undefined ? { title } : {}), ...(date !== undefined ? { date } : {}) }
    } catch {
      // Renderable shape but unusable content (e.g. runtime reference in text).
      return undefined
    }
  }
}
