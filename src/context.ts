// 会话持久化 + 断点恢复（7.1 / 8.2，P1 收紧）：上下文原子写（tmp + rename），审计链校验后恢复
// 恢复语义：检测到 pendingStep（崩在中途）→ 绝不直接续跑，交由编排器先做只读探测校验
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AuditLog } from "./audit.js";
import { DeviceContext, AuditEvent, PendingStep } from "./types.js";

export function saveContext(stateDir: string, ctx: DeviceContext): void {
  const tmp = path.join(stateDir, `context.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, JSON.stringify(ctx, null, 2));
  // 原子替换：libuv 在 Windows 上 rename 带 MOVEFILE_REPLACE_EXISTING
  renameSync(tmp, path.join(stateDir, "context.json"));
}

export function loadContext(stateDir: string): DeviceContext | null {
  const file = path.join(stateDir, "context.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DeviceContext;
  } catch {
    return null; // 上下文损坏 → 从头开始，不阻塞主流程
  }
}

export interface RecoveryResult {
  ctx: DeviceContext;
  events: AuditEvent[];
  pendingStep: PendingStep | null;
  interrupted: boolean;      // true = 检测到崩在中途的 step
  resumedAtStep: string | null; // 无 pendingStep 时：最近完成的操作；有 pendingStep 时为 null（禁止直接续跑）
}

// 8.2：根据 device_context 与审计链恢复。链校验失败（日志被篡改）直接抛错拒绝恢复。
export function recoverSession(stateDir: string, audit: AuditLog): RecoveryResult | null {
  const ctx = loadContext(stateDir);
  if (!ctx) return null;
  const { events, headHash } = audit.load();
  if (headHash !== ctx.eventChainHash) {
    throw new Error(`审计链头（${headHash.slice(0, 12)}…）与上下文记录（${ctx.eventChainHash.slice(0, 12)}…）不一致，会话恢复失败`);
  }
  const pending = ctx.pendingStep ?? null;
  const last = [...events]
    .reverse()
    .find((e) => e.postSnapshotHash !== "n/a" && e.postSnapshotHash !== "" && e.postSnapshotHash !== "unknown_physical_state");
  return {
    ctx,
    events,
    pendingStep: pending,
    interrupted: pending !== null,
    // 有挂起步骤时禁止给出续跑点：必须先过编排器的探测校验
    resumedAtStep: pending ? null : (last?.operation ?? null),
  };
}
