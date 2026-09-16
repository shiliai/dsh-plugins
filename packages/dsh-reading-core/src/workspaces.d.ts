export interface WorkspaceService {
    create(input: {
        path: string;
    }): Promise<{
        workspaceId: string;
    }>;
}
/** Registers source roots once per client session and returns stable ids. */
export declare class WorkspaceRegistry {
    private readonly service;
    private readonly paths;
    constructor(service: WorkspaceService);
    register(path: string): Promise<string>;
}
//# sourceMappingURL=workspaces.d.ts.map