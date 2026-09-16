export interface ContextWorkspace {
    id: string;
    label: string;
    path: string;
    writable?: boolean;
}
export interface ContextEntry {
    type: string;
    title?: string;
    path?: string;
    absolutePath?: string;
    workspaceId?: string;
    writable?: boolean;
    metadata?: Readonly<Record<string, unknown>>;
}
export interface ContextReference {
    source: string;
    entries: readonly ContextEntry[];
    workspaces: readonly ContextWorkspace[];
    instructions?: readonly string[];
}
export declare function formatContext(reference: ContextReference): string;
export declare function appendContext(draft: string, reference: ContextReference): string;
//# sourceMappingURL=context.d.ts.map