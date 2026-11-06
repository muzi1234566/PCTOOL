import type { ExecuteScriptRequest, ProbeDeviceRequest, AuditLogRequest, ResourceResolverRequest } from "./types.js";
import type { DeviceState, Snapshot, ResolvedResourceLike } from "./executor-types.js";
export interface ScriptApi {
    probe(req?: {
        fields?: string[];
        priority?: 0 | 1 | 2;
    }): Promise<DeviceState>;
    probeDevice(req: ProbeDeviceRequest): Promise<DeviceState>;
    captureSnapshot(partitions?: string[]): Promise<Snapshot>;
    appendAudit(req: AuditLogRequest): Promise<{
        eventId: string;
        currentEventHash: string;
    }>;
    resolveResource(req: ResourceResolverRequest): Promise<ResolvedResourceLike>;
    state: Record<string, unknown>;
}
export interface ScriptRunResult {
    result: unknown;
    eventId: string;
    preHash: string;
    postHash: string;
}
export declare const DEFAULT_SCRIPT_TIMEOUT_MS = 5000;
export declare const MAX_SCRIPT_TIMEOUT_MS = 30000;
export declare class ScriptExecutor {
    private readonly api;
    constructor(api: ScriptApi);
    execute(req: ExecuteScriptRequest): Promise<ScriptRunResult>;
}
