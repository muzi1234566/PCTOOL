import type { ManualGuide, Plan, StepResult } from "./types.js";
export interface DshStorage {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
}
export interface DshPluginContext {
    storage: DshStorage;
    tools: {
        register(tool: DshToolDefinition): void;
    };
    logger?: {
        info?(msg: string): void;
        warn?(msg: string): void;
        error?(msg: string): void;
    };
}
export interface DshToolResult {
    content: string;
    data?: Record<string, unknown>;
    require_user_approval?: boolean;
}
export interface DshToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute(args: Record<string, unknown>, ctx: DshPluginContext): Promise<DshToolResult>;
}
export declare function defineTool(def: DshToolDefinition): DshToolDefinition;
export declare function renderProbeMd(fields: {
    protocol: unknown;
    deviceModel: unknown;
    buildId: unknown;
    currentSlot: unknown;
    snapshotUpdateStatus: unknown;
    triesRemaining: unknown;
    batteryLevel: unknown;
    storageHealth: unknown;
    escapePathReady: unknown;
    degraded: boolean;
    failedP0: string[];
    notApplicable: string[];
    patchedCache?: string | null;
    deviceSerial?: unknown;
    kernelVersion?: unknown;
    basebandStatus?: unknown;
    exploitMatches?: Array<{
        id: string;
        title: string;
        kind: string;
    }>;
}): string;
export declare function renderPlanMd(plan: Plan, header: string): string;
export declare function renderGuideMd(g: ManualGuide): string;
export declare function renderDenialMd(res: StepResult, guide: ManualGuide | undefined, token: unknown): string;
export declare function renderStepResultMd(res: StepResult, completed: string[], total: number, nextStepHint: string | null): string;
export declare function registerDshPlugin(ctx: DshPluginContext, opts?: {
    stateDir?: string;
    cacheDir?: string;
    adbPath?: string;
    fastbootPath?: string;
}): void;
