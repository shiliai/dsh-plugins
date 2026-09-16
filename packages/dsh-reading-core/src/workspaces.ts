export interface WorkspaceService {
  create(input: { path: string }): Promise<{ workspaceId: string }>
}

/** Registers source roots once per client session and returns stable ids. */
export class WorkspaceRegistry {
  private readonly paths = new Map<string, string>()

  constructor(private readonly service: WorkspaceService) {}

  async register(path: string): Promise<string> {
    const existing = this.paths.get(path)
    if (existing !== undefined) return existing
    const workspace = await this.service.create({ path })
    this.paths.set(path, workspace.workspaceId)
    return workspace.workspaceId
  }
}
