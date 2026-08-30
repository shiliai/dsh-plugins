import type { AgentSkillInput } from './contracts.ts'

const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024
const MAX_WHEN_TO_USE_LENGTH = 2048
const MAX_INSTRUCTIONS_LENGTH = 65536
const PORTABLE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const YAML_RESERVED_NAMES = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off'])

export type AgentSkillValidationField = 'name' | 'description' | 'whenToUse' | 'instructions'

export class AgentSkillValidationError extends Error {
  constructor(
    readonly field: AgentSkillValidationField,
    message: string,
  ) {
    super(message)
    this.name = 'AgentSkillValidationError'
  }
}

export function validateAgentSkillName(name: string): string | null {
  if (!name) {
    return 'Skill name is required'
  }
  if (name.length > MAX_NAME_LENGTH) {
    return `Skill name must be ${MAX_NAME_LENGTH} characters or fewer`
  }
  if (!PORTABLE_NAME_PATTERN.test(name)) {
    return 'Skill name must contain lowercase letters or numbers separated by single hyphens'
  }
  if (YAML_RESERVED_NAMES.has(name)) {
    return 'Skill name cannot be a YAML reserved word'
  }
  return null
}

export function validateAgentSkillInput(input: AgentSkillInput): void {
  const nameError = validateAgentSkillName(input.name)
  if (nameError) {
    throw new AgentSkillValidationError('name', nameError)
  }

  const description = input.description.trim()
  if (!description) {
    throw new AgentSkillValidationError('description', 'Skill description is required')
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new AgentSkillValidationError('description', `Skill description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`)
  }

  if (input.whenToUse !== undefined && input.whenToUse.trim().length > MAX_WHEN_TO_USE_LENGTH) {
    throw new AgentSkillValidationError('whenToUse', `Skill whenToUse must be ${MAX_WHEN_TO_USE_LENGTH} characters or fewer`)
  }

  if (!input.instructions.trim()) {
    throw new AgentSkillValidationError('instructions', 'Skill instructions are required')
  }
  if (input.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw new AgentSkillValidationError('instructions', 'Skill instructions exceed the size limit')
  }

  if (typeof input.modelInvocable !== 'boolean' || typeof input.userInvocable !== 'boolean') {
    throw new AgentSkillValidationError('instructions', 'Skill invocation flags must be booleans')
  }
}
