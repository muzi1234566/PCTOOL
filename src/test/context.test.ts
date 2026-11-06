// 断点恢复测试：pendingStep 崩溃检测 / 恢复点给出规则 / 链头一致性
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditLog, GENESIS } from "../audit.js";
import { loadContext, recoverSession, saveContext } from "../context.js";
import type { DeviceContext } from "../types.js";

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "recover-"));
}

function mkContext(deviceHash: string, chainHash: string, pendingStep?: DeviceContext["pendingStep"]): DeviceContext {
  return {
    deviceHash,
    planId: "plan-1",
    barrierStatus: "idle",
    overrideTokens: [],
    lastSnapshot: { timestamp: Date.now(), deviceHash, criticalFields: {}, partitionHashes: {} },
    eventChainHash: chainHash,
    pendingStep: pendingStep ?? null,
  };
}

test("恢复：pendingStep 存在 → interrupted，且不给续跑点（禁止直接续跑）", () => {
  const dir = tmpDir();
  const log = new AuditLog(path.join(dir, "audit.jsonl"));
  const e1 = log.append({ event: "backup_boot", preSnapshotHash: "n/a", postSnapshotHash: "n/a", riskScore: 0.1 }, GENESIS);

  saveContext(dir, mkContext("hash-1", e1.currentEventHash, {
    operation: "flash_boot",
    stepId: "s6",
    preSnapshotHash: "abc123",
    startedAt: Date.now() - 30000,
  }));

  const r = recoverSession(dir, log)!;
  assert.equal(r.interrupted, true);
  assert.equal(r.pendingStep?.operation, "flash_boot");
  assert.equal(r.pendingStep?.preSnapshotHash, "abc123");
  assert.equal(r.resumedAtStep, null); // 关键：不给出续跑点
  rmSync(dir, { recursive: true, force: true });
});

test("恢复：无 pendingStep → resumedAtStep = 最近完成操作", () => {
  const dir = tmpDir();
  const log = new AuditLog(path.join(dir, "audit.jsonl"));
  const e1 = log.append({ event: "flash_boot", preSnapshotHash: "a", postSnapshotHash: "b", riskScore: 0.35 }, GENESIS);
  const e2 = log.append({ event: "verify_avb", preSnapshotHash: "b", postSnapshotHash: "c", riskScore: 0.1 }, e1.currentEventHash);

  saveContext(dir, mkContext("hash-1", e2.currentEventHash));
  const r = recoverSession(dir, log)!;
  assert.equal(r.interrupted, false);
  assert.equal(r.pendingStep, null);
  assert.equal(r.resumedAtStep, "verify_avb");
  rmSync(dir, { recursive: true, force: true });
});

test("恢复：无 pendingStep 但末事件是 unknown_physical_state → 跳过它找最近完成操作", () => {
  const dir = tmpDir();
  const log = new AuditLog(path.join(dir, "audit.jsonl"));
  const e1 = log.append({ event: "backup_boot", preSnapshotHash: "a", postSnapshotHash: "b", riskScore: 0.1 }, GENESIS);
  const e2 = log.append({ event: "flash_boot:error", preSnapshotHash: "b", postSnapshotHash: "unknown_physical_state", riskScore: 0.4 }, e1.currentEventHash);

  saveContext(dir, mkContext("hash-1", e2.currentEventHash));
  const r = recoverSession(dir, log)!;
  assert.equal(r.resumedAtStep, "backup_boot");
  rmSync(dir, { recursive: true, force: true });
});

test("恢复：链头不一致 → 抛错拒绝恢复", () => {
  const dir = tmpDir();
  const log = new AuditLog(path.join(dir, "audit.jsonl"));
  log.append({ event: "op", preSnapshotHash: "a", postSnapshotHash: "b", riskScore: 0.1 }, GENESIS);
  saveContext(dir, mkContext("hash-1", "stale-hash"));
  assert.throws(() => recoverSession(dir, log), /不一致/);
  rmSync(dir, { recursive: true, force: true });
});

test("恢复：无上下文文件 → null", () => {
  const dir = tmpDir();
  const log = new AuditLog(path.join(dir, "audit.jsonl"));
  assert.equal(recoverSession(dir, log), null);
  rmSync(dir, { recursive: true, force: true });
});

test("上下文：pendingStep roundtrip 保留", () => {
  const dir = tmpDir();
  const pending = { operation: "flash_boot", stepId: "s6", preSnapshotHash: "xyz", startedAt: 12345 };
  saveContext(dir, mkContext("h", "c", pending));
  const loaded = loadContext(dir)!;
  assert.deepEqual(loaded.pendingStep, pending);
  rmSync(dir, { recursive: true, force: true });
});
