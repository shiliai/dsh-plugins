import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AgentSkillDiagnostic, AgentSkillDocument, AgentSkillInput, AgentSkillListResult } from './contracts.ts'
import { AgentSkillCodecError, parseAgentSkillMarkdown, serializeAgentSkillMarkdown } from './skill-codec.ts'
import { AgentSkillValidationError, validateAgentSkillInput, validateAgentSkillName } from './validate-skill.ts'

const SKILL_FILENAME = 'SKILL.md'

export class AgentSkillStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AgentSkillStoreError'
  }
}

export class AgentSkillCollisionError extends AgentSkillStoreError {
  constructor(readonly skillName: string, options?: ErrorOptions) {
    super(`A skill package named "${skillName}" already exists`, options)
    this.name = 'AgentSkillCollisionError'
  }
}

export class AgentSkillRevisionConflictError extends AgentSkillStoreError {
  constructor(readonly skillName: string) {
    super(`Skill "${skillName}" changed since it was loaded`)
    this.name = 'AgentSkillRevisionConflictError'
  }
}

export class AgentSkillRollbackError extends AgentSkillStoreError {
  readonly rollbackErrors: readonly Error[]

  constructor(message: string, cause: unknown, rollbackErrors: Error[]) {
    super(message, { cause })
    this.name = 'AgentSkillRollbackError'
    this.rollbackErrors = rollbackErrors
  }
}

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export class SkillStore {
  private readonly _root: string
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(vaultRoot: string, relativeSkillsDir = '.agents/skills') {
    this._root = resolve(vaultRoot, relativeSkillsDir)
  }

  get root(): string {
    return this._root
  }

  private packageDir(name: string): string {
    return resolve(this._root, name)
  }

  private skillFile(name: string): string {
    return resolve(this._root, name, SKILL_FILENAME)
  }

  async list(): Promise<AgentSkillListResult> {
    const skills: AgentSkillDocument[] = []
    const diagnostics: AgentSkillDiagnostic[] = []
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(this._root, { withFileTypes: true })
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return { skills: [], diagnostics: [] }
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      const nameError = validateAgentSkillName(name)
      const directoryPath = `.agents/skills/${name}`
      try {
        if (nameError) throw new AgentSkillCodecError(nameError)
        const skill = await this.read(name)
        skills.push(skill)
      } catch (error) {
        diagnostics.push({
          directoryPath,
          message: error instanceof Error ? error.message : 'Could not read skill package',
        })
      }
    }
    skills.sort((left, right) => left.name.localeCompare(right.name))
    diagnostics.sort((left, right) => (
      left.directoryPath.localeCompare(right.directoryPath)
      || left.message.localeCompare(right.message)
    ))
    return { skills, diagnostics }
  }

  async create(input: AgentSkillInput): Promise<AgentSkillDocument> {
    validateAgentSkillInput(input)
    return this.withMutation(async () => {
      await mkdir(this.root, { recursive: true })
      const directory = this.packageDir(input.name)
      try {
        await mkdir(directory, { recursive: false })
      } catch (error) {
        if (isNodeError(error, 'EEXIST')) {
          throw new AgentSkillCollisionError(input.name, { cause: error })
        }
        throw error
      }
      const filePath = this.skillFile(input.name)
      const content = serializeAgentSkillMarkdown({}, input)
      try {
        await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        const rollbackErrors: Error[] = []
        try { await rm(filePath, { force: true }) } catch (e) { rollbackErrors.push(toError(e)) }
        try { await rm(directory, { recursive: true, force: true }) } catch (e) { rollbackErrors.push(toError(e)) }
        if (rollbackErrors.length > 0) {
          throw new AgentSkillRollbackError(`Could not create skill "${input.name}" and rollback was incomplete`, error, rollbackErrors)
        }
        throw error
      }
      return this.read(input.name)
    })
  }

  async update(previousName: string, expectedRevision: string, input: AgentSkillInput): Promise<AgentSkillDocument> {
    this.assertValidName(previousName)
    validateAgentSkillInput(input)
    return this.withMutation(async () => {
      const current = await this.read(previousName)
      if (current.revision !== expectedRevision) {
        throw new AgentSkillRevisionConflictError(previousName)
      }
      const content = serializeAgentSkillMarkdown(current.frontmatter, input)
      if (previousName === input.name) {
        await writeFile(this.skillFile(input.name), content, { encoding: 'utf8' })
        return this.read(input.name)
      }
      // Rename: relocate the package directory then write, with rollback on failure.
      const oldDirectory = this.packageDir(previousName)
      const newDirectory = this.packageDir(input.name)
      const oldRaw = await this.rawContentFor(previousName)
      try {
        if (previousName !== input.name && await pathExists(newDirectory)) {
          throw new AgentSkillCollisionError(input.name)
        }
        await rename(oldDirectory, newDirectory)
      } catch (error) {
        if (error instanceof AgentSkillCollisionError) throw error
        if (isNodeError(error, 'ENOENT')) {
          throw new AgentSkillRevisionConflictError(previousName)
        }
        throw error
      }
      const newFilePath = this.skillFile(input.name)
      try {
        await writeFile(newFilePath, content, { encoding: 'utf8' })
      } catch (error) {
        const rollbackErrors: Error[] = []
        try { await writeFile(newFilePath, oldRaw, { encoding: 'utf8' }) } catch (e) { rollbackErrors.push(toError(e)) }
        try { await rename(newDirectory, oldDirectory) } catch (e) { rollbackErrors.push(toError(e)) }
        if (rollbackErrors.length > 0) {
          throw new AgentSkillRollbackError(`Could not rename skill "${previousName}" and rollback was incomplete`, error, rollbackErrors)
        }
        throw error
      }
      return this.read(input.name)
    })
  }

  async delete(name: string, expectedRevision: string): Promise<void> {
    this.assertValidName(name)
    await this.withMutation(async () => {
      const current = await this.read(name)
      if (current.revision !== expectedRevision) {
        throw new AgentSkillRevisionConflictError(name)
      }
      await rm(this.packageDir(name), { recursive: true, force: true })
    })
  }

  async read(name: string): Promise<AgentSkillDocument> {
    this.assertValidName(name)
    const filePath = this.skillFile(name)
    let raw: string
    try {
      const info = await stat(filePath)
      if (!info.isFile()) throw new AgentSkillCodecError('SKILL.md is not a file')
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw new AgentSkillCodecError('SKILL.md not found')
      throw error
    }
    return this.documentFromRaw(name, raw)
  }

  async readRaw(name: string): Promise<{ skill: AgentSkillDocument; raw: string }> {
    this.assertValidName(name)
    const filePath = this.skillFile(name)
    const fileInfo = await stat(filePath).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) throw new AgentSkillCodecError('SKILL.md not found')
      throw error
    })
    if (!fileInfo.isFile()) throw new AgentSkillCodecError('SKILL.md is not a file')
    const raw = await readFile(filePath, 'utf8')
    return { skill: this.documentFromRaw(name, raw), raw }
  }

  private documentFromRaw(name: string, raw: string): AgentSkillDocument {
    let parsed
    try {
      parsed = parseAgentSkillMarkdown(raw, name)
    } catch (error) {
      if (error instanceof AgentSkillCodecError) throw error
      throw new AgentSkillCodecError('Could not parse SKILL.md', { cause: error })
    }
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
      modelInvocable: parsed.modelInvocable,
      userInvocable: parsed.userInvocable,
      instructions: parsed.instructions,
      frontmatter: parsed.frontmatter,
      directoryPath: `.agents/skills/${name}`,
      filePath: `.agents/skills/${name}/${SKILL_FILENAME}`,
      revision: digest(raw),
    }
  }

  rawContentFor(name: string): Promise<string> {
    return this.readRaw(name).then(({ raw }) => raw)
  }

  private assertValidName(name: string): void {
    const error = validateAgentSkillName(name)
    if (error) {
      throw new AgentSkillValidationError('name', error)
    }
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
