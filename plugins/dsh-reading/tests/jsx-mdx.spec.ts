import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseMdxBundle } from '../src/extract/jsx-mdx.ts'

const MAPPING = 'let t={a:`a`,blockquote:`blockquote`,code:`code`,h1:`h1`,h2:`h2`,h3:`h3`,img:`img`,li:`li`,p:`p`,pre:`pre`,strong:`strong`,ul:`ul`,...e.components}'

const jsx = (component: string, props: string): string => `(0,u.jsx)(t.${component},{${props}})`
const jsxs = (component: string, props: string): string => `(0,u.jsxs)(t.${component},{${props}})`
const text = (value: string): string => '`' + value + '`'
const bundle = (children: string, tail = ''): string =>
  `function d(e){${MAPPING};return(0,u.jsxs)(u.Fragment,{children:[${children}]})}function f(e={}){}${tail}`

describe('parseMdxBundle', () => {
  it('renders paragraphs and h1-h3 headings', () => {
    const result = parseMdxBundle(bundle([
      jsx('p', `children:${text('First paragraph.')}`),
      jsx('h1', `children:${text('Top heading')}`),
      jsx('h2', `children:${text('Section')}`),
      jsx('h3', `children:${text('Subsection')}`),
    ].join(',')))
    expect(result?.html).toBe('<p>First paragraph.</p><h1>Top heading</h1><h2>Section</h2><h3>Subsection</h3>')
  })

  it('escapes &, < and > in text nodes', () => {
    const result = parseMdxBundle(bundle(jsx('p', `children:${text('1 < 2 & 3 > 2 <b>bold</b>')}`)))
    expect(result?.html).toBe('<p>1 &lt; 2 &amp; 3 &gt; 2 &lt;b&gt;bold&lt;/b&gt;</p>')
  })

  it('skips whitespace separator strings between children', () => {
    const result = parseMdxBundle(bundle([
      jsx('p', `children:${text('A')}`), text('\\n'),
      jsx('p', `children:${text('B')}`), text('\\n'),
    ].join(',')))
    expect(result?.html).toBe('<p>A</p><p>B</p>')
    expect(result?.html.includes('\n')).toBe(false)
  })

  it('renders ul/li lists', () => {
    const result = parseMdxBundle(bundle(jsxs('ul', `children:[${jsx('li', `children:${text('one')}`)},${jsx('li', `children:${text('two')}`)}]`)))
    expect(result?.html).toBe('<ul><li>one</li><li>two</li></ul>')
  })

  it('renders blockquote with nested strong paragraph', () => {
    const result = parseMdxBundle(bundle(jsxs('blockquote', `children:[${text('\\n')},${jsx('p', `children:(0,u.jsx)(t.strong,{children:${text('Figure 1: caption')}})`)},${text('\\n')}]`)))
    expect(result?.html).toBe('<blockquote><p><strong>Figure 1: caption</strong></p></blockquote>')
  })

  it('renders inline strong and code inside a paragraph', () => {
    const result = parseMdxBundle(bundle(jsxs('p', `children:[${text('Set ')},${jsx('code', `children:${text('input_precision')}`)},${text(' for both, ')},${jsx('strong', `children:${text('it matters')}`)},${text(' indeed.')}]`)))
    expect(result?.html).toBe('<p>Set <code>input_precision</code> for both, <strong>it matters</strong> indeed.</p>')
  })

  it('keeps newlines in pre/code and escapes markup characters', () => {
    const result = parseMdxBundle(bundle(jsx('pre', `children:(0,u.jsx)(t.code,{className:\`language-Python\`,children:${text('if x < 3:\\n    a & b\\n')}})`)))
    expect(result?.html).toBe('<pre><code class="language-Python">if x &lt; 3:\n    a &amp; b\n</code></pre>')
  })

  it('renders links with http(s) href only', () => {
    const result = parseMdxBundle(bundle([
      jsx('a', `href:\`https://example.com/x?a=1&b=2\`,children:${text('link')}`),
      jsx('a', `href:\`javascript:alert(1)\`,children:${text('bad')}`),
      jsx('a', `href:\`/relative/path\`,children:${text('rel')}`),
    ].join(',')))
    expect(result?.html).toBe('<a href="https://example.com/x?a=1&amp;b=2">link</a><a>bad</a><a>rel</a>')
  })

  it('renders img as a void element with src/alt/title', () => {
    const result = parseMdxBundle(bundle(jsx('img', `src:\`https://img.example/p.png?a=1&b=2\`,alt:${text('Alt & text')}`)))
    expect(result?.html).toBe('<img src="https://img.example/p.png?a=1&amp;b=2" alt="Alt &amp; text">')
    expect(result?.html.includes('</img>')).toBe(false)
  })

  it('ignores non-whitelisted attributes and minified booleans', () => {
    const result = parseMdxBundle(bundle(jsx('img', `src:\`https://img.example/p.png\`,alt:\`\`,subscribeZai:!0,hidden:!1,date:\`ignored\``)))
    expect(result?.html).toBe('<img src="https://img.example/p.png" alt="">')
  })

  it('renders unknown components transparently', () => {
    const result = parseMdxBundle(bundle([
      '(0,u.jsx)(t.Custom,{children:`bare text`})',
      '(0,u.jsx)(u.Fragment,{children:`fragment text`})',
    ].join(',')))
    expect(result?.html).toBe('bare textfragment text')
  })

  it('renders an empty Fragment to empty html', () => {
    const result = parseMdxBundle(`function d(e){${MAPPING};return(0,u.jsxs)(u.Fragment,{children:[]})}`)
    expect(result?.html).toBe('')
  })

  it('extracts title and date from the trailing render call', () => {
    const result = parseMdxBundle(bundle(
      jsx('p', `children:${text('Body')}`),
      '(0,c.createRoot)(document.getElementById(`root`)).render((0,u.jsx)(a,{date:`2026-09-17`,title:`Synthetic Title`,subscribeZai:!0,children:null}));',
    ))
    expect(result?.title).toBe('Synthetic Title')
    expect(result?.date).toBe('2026-09-17')
    expect(result?.html).toBe('<p>Body</p>')
  })

  it('returns undefined when a template contains an unescaped interpolation', () => {
    expect(parseMdxBundle(bundle(jsx('p', 'children:`a ${dynamic} b`')))).toBeUndefined()
  })

  it('returns undefined for syntactically broken bundles', () => {
    expect(parseMdxBundle(`function d(e){${MAPPING};return(0,u.jsxs)(u.Fragment,{children:[(0,u.jsx)(t.p,{children:\`x\`})`)).toBeUndefined()
    expect(parseMdxBundle(bundle(jsx('p', 'children:`unterminated')))).toBeUndefined()
    expect(parseMdxBundle(bundle(jsx('p', 'children:(0,u.jsx)(t.p,{children:`nested`)')))).toBeUndefined()
  })

  it('returns undefined when no tag mapping is present', () => {
    expect(parseMdxBundle('function d(e){return(0,u.jsx)(t.p,{children:`x`})}')).toBeUndefined()
    expect(parseMdxBundle(`function d(e){let t={p:\`p\`,code:\`code\`};return(0,u.jsxs)(u.Fragment,{children:[]})}`)).toBeUndefined()
    expect(parseMdxBundle(`function d(e){let t={p:\`div\`,h1:\`h1\`};return(0,u.jsxs)(u.Fragment,{children:[]})}`)).toBeUndefined()
  })

  it('rejects sources above the size limit', () => {
    const huge = `function d(e){${MAPPING};return(0,u.jsxs)(u.Fragment,{children:[]})}` + 'x'.repeat(2_100_000)
    expect(parseMdxBundle(huge)).toBeUndefined()
  })

  it('parses a real z.ai MDX bundle fixture end-to-end', () => {
    const source = readFileSync(new URL('./fixtures/zai-post.js', import.meta.url), 'utf8')
    const result = parseMdxBundle(source)
    expect(result).toBeDefined()
    expect(result?.title).toBe('Toward Recursive Self-Improvement: How GLM Built Its Own Inference Infrastructure')
    expect(result?.date).toBe('2026-09-17')
    expect(result?.html.startsWith('<p>As we develop GLM')).toBe(true)
    expect(result?.html.endsWith('</p>')).toBe(true)
    expect(result?.html).toContain('<pre><code class="language-Python">')
    expect(result?.html).toContain('<img src="https://z-cdn-media.chatglm.cn/')
    expect(result?.html).toContain('<strong>')
  })
})
