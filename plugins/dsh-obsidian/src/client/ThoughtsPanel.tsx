import { useEffect, useState } from 'react'
import X from 'lucide-react/dist/esm/icons/x'
import Plus from 'lucide-react/dist/esm/icons/plus'
import { vaultApi } from './api.ts'
import type { Thought } from '../contracts.ts'
import css from './styles.module.css?dsh-inline'

export function ThoughtsPanel({ close }: { close(): void }) {
  const [items, setItems] = useState<Thought[]>([])
  const [text, setText] = useState(''); const [query, setQuery] = useState(''); const [error, setError] = useState<string | null>(null)
  const refresh = () => { void vaultApi.thoughts(query || undefined).then(result => setItems(result.thoughts)).catch(error => setError(error instanceof Error ? error.message : 'Could not load thoughts.')) }
  useEffect(refresh, [query])
  const create = async () => { if (!text.trim()) return; await vaultApi.createThought(text.trim()); setText(''); refresh() }
  const toggle = async (item: Thought) => { await vaultApi.updateThought(item.id, item.status === 'done' ? 'inbox' : 'done'); refresh() }
  return <section className={css.thoughtsPanel} role="dialog" aria-label="Thoughts inbox"><header className={css.skillEditorHeader}><strong>Thoughts</strong><button className={css.iconButton} aria-label="Close thoughts" title="Close" onClick={close}><X size={15} /></button></header><div className={css.thoughtsToolbar}><input aria-label="Search thoughts" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)} /><input aria-label="New thought" placeholder="Capture an idea" value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void create() }} /><button className={css.iconButton} aria-label="Add thought" title="Add" onClick={() => void create()}><Plus size={15} /></button></div>{error && <div role="alert" className={css.panelError}>{error}</div>}<ul className={css.thoughtList}>{items.map(item => <li key={item.id} className={item.status === 'done' ? css.thoughtDone : ''}><button type="button" onClick={() => void toggle(item)}>{item.status === 'done' ? 'x' : ' '}</button><span>{item.text}</span><small>{item.date}</small></li>)}</ul></section>
}
