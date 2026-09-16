export interface AgentSkillSummary {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  directoryPath: string
}

export interface AgentSkillDocument extends AgentSkillSummary {
  instructions: string
  frontmatter: Record<string, unknown>
  filePath: string
  revision: string
}

export interface AgentSkillInput {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  instructions: string
}

export interface AgentSkillDiagnostic {
  directoryPath: string
  message: string
}

export interface AgentSkillListResult {
  skills: AgentSkillDocument[]
  diagnostics: AgentSkillDiagnostic[]
}
