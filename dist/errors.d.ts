export type ErrorCode = "infeasible" | "needs_clarification" | "deny_auto" | "deny_with_override" | "deny_hard" | "unknown_physical_state" | "resource_corrupted" | "timeout" | "target_mismatch";
export declare class OrchestratorError extends Error {
    readonly code: ErrorCode;
    readonly details: Record<string, unknown>;
    constructor(code: ErrorCode, message: string, details?: Record<string, unknown>);
    get retryable(): boolean;
    toJSON(): Record<string, unknown>;
}
export declare const WARN_LOGICAL_ERASE_ONLY = "LOGICAL_ERASE_ONLY_DATA_REMAINS_RECOVERABLE";
