import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { VaultError } from './vault-service.ts'

export type ThoughtStatus = 'inbox' | 'next' | 'done'
export interface Thought { id: string; date: string; text: string; status: ThoughtStatus; created: string; file: string; archived?: boolean; deletedAt?: string }

const MARKER = /<!-- dsh-thought id="([^"]+)" status="(inbox|next|done)" created="([^"]+)" -->/u
const DAY = /^\d{4}-\d{2}-\d{2}$/u

export class ThoughtService {
  constructor(readonly root: string) {}
  private dir(kind: 'inbox' | 'archive' | 'trash'): string { return join(this.root, `.${kind}`) }
  private async ensure(): Promise<void> { await Promise.all(['inbox', 'archive', 'trash'].map(kind => mkdir(this.dir(kind as never), { recursive: true }))) }
  private async files(kind: 'inbox' | 'archive' | 'trash'): Promise<string[]> {
    await this.ensure(); const { readdir } = await import('node:fs/promises'); return (await readdir(this.dir(kind))).filter(name => name.endsWith('.md')).sort()
  }
  async list(options?: { status?: ThoughtStatus; q?: string; includeArchived?: boolean }): Promise<Thought[]> {
    const out: Thought[] = []; const query = options?.q?.toLocaleLowerCase()
    for (const kind of ['inbox', 'archive', 'trash'] as const) for (const file of await this.files(kind)) {
      const content = await readFile(join(this.dir(kind), file), 'utf8'); const date = file.slice(0, 10)
      for (const line of content.split(/\r?\n/u)) { const match = line.match(MARKER); if (!match) continue
        const [, id, status, created] = match; const text = line.replace(/^- \[[ x]\] /u, '').replace(MARKER, '').trim()
        const thought: Thought = { id: id!, date, text, status: status as ThoughtStatus, created: created!, file: `.${kind}/${file}`, ...(kind !== 'inbox' ? { archived: kind === 'archive' } : {}), ...(kind === 'trash' ? { deletedAt: created } : {}) }
        if ((options?.status === undefined || thought.status === options.status) && (query === undefined || `${thought.text} ${thought.id}`.toLocaleLowerCase().includes(query)) && (options?.includeArchived || kind === 'inbox')) out.push(thought)
      }
    }
    return out.sort((a, b) => b.created.localeCompare(a.created))
  }
  async create(text: string, date = new Date().toISOString().slice(0, 10)): Promise<Thought> {
    if (!text.trim()) throw new VaultError('Thought text is required.', 'INVALID_THOUGHT', 400); if (!DAY.test(date)) throw new VaultError('Invalid thought date.', 'INVALID_THOUGHT', 400)
    await this.ensure(); const id = randomUUID(); const created = new Date().toISOString(); const file = join(this.dir('inbox'), `${date}.md`)
    let content = ''; try { content = await readFile(file, 'utf8') } catch { content = `---\ndsh: inbox\ndate: ${date}\n---\n\n` }
    content += `- [ ] ${text.trim()} ${this.marker(id, 'inbox', created)}\n`; await writeFile(file, content, 'utf8')
    return { id, date, text: text.trim(), status: 'inbox', created, file: `.inbox/${date}.md` }
  }
  async update(id: string, status: ThoughtStatus, text?: string): Promise<Thought> {
    const found = (await this.list({ includeArchived: true })).find(item => item.id === id); if (!found) throw new VaultError('Thought not found.', 'THOUGHT_NOT_FOUND', 404)
    const path = resolve(this.root, found.file); let content = await readFile(path, 'utf8')
    content = content.split(/\r?\n/u).map(line => line.includes(`dsh-thought id="${id}"`) ? `- [${status === 'done' ? 'x' : ' '}] ${text?.trim() ?? found.text} ${this.marker(id, status, found.created)}` : line).join('\n'); await writeFile(path, content, 'utf8')
    return { ...found, status, text: text?.trim() ?? found.text }
  }
  async archive(id: string): Promise<Thought> { return this.move(id, 'archive') }
  async restore(id: string): Promise<Thought> { return this.move(id, 'inbox') }
  async remove(id: string): Promise<Thought> { return this.move(id, 'trash') }
  private async move(id: string, target: 'inbox' | 'archive' | 'trash'): Promise<Thought> {
    const found = (await this.list({ includeArchived: true })).find(item => item.id === id); if (!found) throw new VaultError('Thought not found.', 'THOUGHT_NOT_FOUND', 404)
    const source = resolve(this.root, found.file); const targetFile = join(this.dir(target), found.file.split('/').at(-1)!); await mkdir(this.dir(target), { recursive: true }); await rename(source, targetFile)
    return { ...found, file: `.${target}/${found.file.split('/').at(-1)!}`, ...(target === 'archive' ? { archived: true } : {}), ...(target === 'trash' ? { deletedAt: new Date().toISOString() } : {}) }
  }
  private marker(id: string, status: ThoughtStatus, created: string): string { return `<!-- dsh-thought id="${id}" status="${status}" created="${created}" -->` }
}
