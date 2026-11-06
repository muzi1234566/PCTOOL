// 全部接口定义（规范第一、三、四、七、十章）
import type { ErrorCode } from "./errors.js";

export type Priority = 0 | 1 | 2;
export type Protocol = "adb" | "fastboot" | "edl" | "none";
export type Slot = "a" | "b" | "current";
export type FieldValue = string | number | boolean | null;

// —— 第四章：字段分级 ——
export const P0_FIELDS = [
  "protocol", "currentSlot", "snapshotUpdateStatus", "oemUnlockChannel",
  "arbFused", "pblFused", "frpActive", "knoxFused",
] as const;

export const P1_FIELDS = [
  "triesRemaining", "storageHealth", "batteryLevel", "widevineRecoverability", "escapePathReady",
] as const;

// P2：诊断增强字段（失败不计入降级），deviceModel/buildId 供 capability-map 定位
export const P2_FIELDS = ["deviceModel", "buildId"] as const;

export interface DeviceState {
  protocol: Protocol;
  fields: Record<string, FieldValue>;
  degraded: boolean;        // P1 缺失 → true（风险 +0.2，强制降级）
  failedP0: string[];       // applicable 但读取失败
  failedP1: string[];
  notApplicable: string[];  // 当前协议下本就不可读（不算失败）
  readAt: number;
}

// —— 第七章：快照 ——
export interface Snapshot {
  timestamp: number;
  deviceHash: string;                          // 设备指纹（不含 PII）
  criticalFields: Record<string, FieldValue>;  // P0 字段子集
  partitionHashes: Record<string, string>;
  temperatureC?: number | null;                // P2：大分区写入 preSnapshot 必含
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

// 写入中途崩溃检测：写入前落盘，完成后清除（P1 迭代：断点恢复状态校验）
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

// —— 第八章：会话状态机 ——
export interface DeviceContext {
  deviceHash: string;
  planId: string;
  barrierStatus: "idle" | "exclusive";
  overrideTokens: OverrideToken[];
  lastSnapshot: Snapshot;
  eventChainHash: string;
  pendingStep?: PendingStep | null; // 存在即代表上一次写入可能崩在中途
  boundSerial?: string | null;      // v3：多设备防呆——计划绑定的设备 serial
}

// —— 第二章：覆写令牌 ——
export interface OverrideToken {
  tokenId: string;
  operation: string;
  expiresAt: number;
  riskAcknowledged: boolean;
  signature: string; // HMAC-SHA256(tokenId + operation + expiresAt, secretKey)
}

// —— 手动引导 ——
export interface ManualGuide {
  operation: string;
  preconditions: string[];
  steps: string[];
  risks: string[];
  warnings: string[];
}

export type GuardDecision =
  | { verdict: "allow"; riskScore: number; degraded: boolean }
  | { verdict: "deny_auto"; reason: string; riskScore: number; guide: ManualGuide }
  | { verdict: "deny_with_override"; reason: string; riskScore: number; guide: ManualGuide }
  | { verdict: "deny_hard"; reason: string; riskScore: number };

// —— 第三章：计划 ——
export interface PlanStep {
  id: string;
  operation: string;
  params: Record<string, FieldValue>;
  calibratedRiskScore: number;
  failureBranches: string[];
  estimatedDurationMs: number;
  preheat: boolean; // 5.4：>30s 物理阻塞时预热
  barrier: "exclusive" | "none";
  physicalOps?: string[]; // v3：必须的物理按键/人工操作（进 fastboot/EDL 的按键组合等）
}

export interface Plan {
  planId: string;
  intent: string;
  mode: "exploration" | "accelerated"; // 3.2 双轨
  estimate: PlanEstimate;
  estimateSource: "history" | "default"; // P1：capability-map 命中 → history，否则默认兜底
  estimateWallClock: string;             // P2：人话耗时（含重启次数），如「预计耗时 4.0 分钟，包含 2 次重启」
  steps: PlanStep[];
  missingVariables: string[];
  notes: string[];                       // P2：资源准备/人工介入说明
}

// —— 第一章：工具接口 ——
export interface ProbeDeviceRequest {
  fields: string[];     // 支持 "all"
  priority: Priority;
}

export interface ResourceResolverRequest {
  query: string; // 精确标识，如 "magisk_canary_27001"
  sources: Array<"github" | "official" | "mirror">;
  requireSHA256: boolean; // 必须为 true
}

export interface FlashPartitionRequest {
  partition: string;
  imagePath: string;
  verifySHA256: string;
  slot?: Slot;                              // A/B 设备必须指定
  sparseHandling: "auto" | "manual";
  fastbootFlags?: string[];                 // 如 vbmeta 的 --disable-verity
}

export interface ErasePartitionRequest {
  partition: string;
  method: "secure_erase" | "sanitize" | "blksecdiscard"; // 禁止 discard/trim
  requireBackup: boolean;
  backupManifestPath?: string;
  forceFastErase?: boolean; // 强行快速擦除 → 返回 LOGICAL_ERASE_ONLY 警告
}

export interface ExecuteScriptRequest {
  script: string;
  timeout?: number; // 毫秒；缺省 5000，硬上限 30000（P2：防卡死宿主）
  barrierMode: "exclusive" | "shared"; // 写入必须 exclusive
}

export interface AuditLogRequest {
  event: string;
  preSnapshotHash: string;
  postSnapshotHash: string;
  riskScore: number;
  overrideToken?: string;
}

// —— 第十章：输出 ——
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
