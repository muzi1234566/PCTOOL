import type { ErrorCode } from "./errors.js";
export type Priority = 0 | 1 | 2;
export type Protocol = "adb" | "fastboot" | "edl" | "none";
export type Slot = "a" | "b" | "current";
export type FieldValue = string | number | boolean | null;
export declare const P0_FIELDS: readonly ["protocol", "currentSlot", "snapshotUpdateStatus", "oemUnlockChannel", "arbFused", "pblFused", "frpActive", "knoxFused"];
export declare const P1_FIELDS: readonly ["triesRemaining", "storageHealth", "batteryLevel", "widevineRecoverability", "escapePathReady"];
export declare const P2_FIELDS: readonly ["deviceModel", "buildId"];
export interface DeviceState {
    protocol: Protocol;
    fields: Record<string, FieldValue>;
    degraded: boolean;
    failedP0: string[];
    failedP1: string[];
    notApplicable: string[];
    readAt: number;
}
export interface Snapshot {
    timestamp: number;
    deviceHash: string;
    criticalFields: Record<string, FieldValue>;
    partitionHashes: Record<string, string>;
    temperatureC?: number | null;
}
export interface AuditEvent {
    eventId: string;
    timestamp: number;
    operation: string;
    preSnapshotHash: string;
    postSnapshotHash: string;
    previousEventHash: string;
    currentEventHash: string;
    riskScore: number;
    overrideToken?: string;
}
export interface PendingStep {
    operation: string;
    stepId: string;
    preSnapshotHash: string;
    startedAt: number;
}
export interface PlanEstimate {
    p50Ms: number;
    p90Ms: number;
    successRate: number;
}
export interface DeviceContext {
    deviceHash: string;
    planId: string;
    barrierStatus: "idle" | "exclusive";
    overrideTokens: OverrideToken[];
    lastSnapshot: Snapshot;
    eventChainHash: string;
    pendingStep?: PendingStep | null;
    boundSerial?: string | null;
}
export interface OverrideToken {
    tokenId: string;
    operation: string;
    expiresAt: number;
    riskAcknowledged: boolean;
    signature: string;
}
export interface ManualGuide {
    operation: string;
    preconditions: string[];
    steps: string[];
    risks: string[];
    warnings: string[];
}
export type GuardDecision = {
    verdict: "allow";
    riskScore: number;
    degraded: boolean;
} | {
    verdict: "deny_auto";
    reason: string;
    riskScore: number;
    guide: ManualGuide;
} | {
    verdict: "deny_with_override";
    reason: string;
    riskScore: number;
    guide: ManualGuide;
} | {
    verdict: "deny_hard";
    reason: string;
    riskScore: number;
};
export interface PlanStep {
    id: string;
    operation: string;
    params: Record<string, FieldValue>;
    calibratedRiskScore: number;
    failureBranches: string[];
    estimatedDurationMs: number;
    preheat: boolean;
    barrier: "exclusive" | "none";
    physicalOps?: string[];
}
export interface Plan {
    planId: string;
    intent: string;
    mode: "exploration" | "accelerated";
    estimate: PlanEstimate;
    estimateSource: "history" | "default";
    estimateWallClock: string;
    steps: PlanStep[];
    missingVariables: string[];
    notes: string[];
}
export interface ProbeDeviceRequest {
    fields: string[];
    priority: Priority;
}
export interface ResourceResolverRequest {
    query: string;
    sources: Array<"github" | "official" | "mirror">;
    requireSHA256: boolean;
}
export interface FlashPartitionRequest {
    partition: string;
    imagePath: string;
    verifySHA256: string;
    slot?: Slot;
    sparseHandling: "auto" | "manual";
    fastbootFlags?: string[];
}
export interface ErasePartitionRequest {
    partition: string;
    method: "secure_erase" | "sanitize" | "blksecdiscard";
    requireBackup: boolean;
    backupManifestPath?: string;
    forceFastErase?: boolean;
}
export interface ExecuteScriptRequest {
    script: string;
    timeout?: number;
    barrierMode: "exclusive" | "shared";
}
export interface AuditLogRequest {
    event: string;
    preSnapshotHash: string;
    postSnapshotHash: string;
    riskScore: number;
    overrideToken?: string;
}
export interface StepResult {
    plan_id: string | null;
    step: string;
    status: "success" | "failed" | "blocked";
    pre_snapshot_hash: string | null;
    post_snapshot_hash: string | null;
    next_step: string | null;
    risk_score: number;
    estimated_remaining_time: string | null;
    degraded: boolean;
    error_code: ErrorCode | null;
    message?: string;
    guide?: ManualGuide;
    details?: Record<string, unknown>;
}
