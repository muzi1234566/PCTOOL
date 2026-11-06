// 审计链测试：追加、校验、篡改检测
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditLog, GENESIS } from "../audit.js";

function tmpFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-"));
  return path.join(dir, "audit.jsonl");
}

test("审计：链式追加并校验通过", () => {
  const file = tmpFile();
  const log = new AuditLog(file);
  const e1 = log.append({ event: "flash_boot", preSnapshotHash: "a", postSnapshotHash: "b", riskScore: 0.35 }, GENESIS);
  const e2 = log.append({ event: "verify_avb", preSnapshotHash: "b", postSnapshotHash: "c", riskScore: 0.1 }, e1.currentEventHash);
  assert.equal(e2.previousEventHash, e1.currentEventHash);

  const { events, headHash } = log.load();
  assert.equal(events.length, 2);
  assert.equal(headHash, e2.currentEventHash);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("审计：篡改事件内容 → 校验失败", () => {
  const file = tmpFile();
  const log = new AuditLog(file);
  const e1 = log.append({ event: "flash_boot", preSnapshotHash: "a", postSnapshotHash: "b", riskScore: 0.35 }, GENESIS);
  log.append({ event: "erase_partition", preSnapshotHash: "b", postSnapshotHash: "c", riskScore: 0.9 }, e1.currentEventHash);

  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  const tampered = JSON.parse(lines[1]);
  tampered.riskScore = 0.01; // 改小风险分 → 哈希对不上
  lines[1] = JSON.stringify(tampered);
  writeFileSync(file, lines.join("\n") + "\n");

  assert.throws(() => log.load(), /校验失败/);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("审计：PII 剔除", () => {
  const file = tmpFile();
  const log = new AuditLog(file);
  const e = log.append(
    { event: "probe imei=860123456789012 mac=AA:BB:CC:DD:EE:FF", preSnapshotHash: "a", postSnapshotHash: "b", riskScore: 0 },
    GENESIS,
  );
  assert.match(e.operation, /\[REDACTED-IMEI\]/);
  assert.match(e.operation, /\[REDACTED-MAC\]/);
  assert.doesNotMatch(e.operation, /860123456789012/);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("审计：崩溃半行截断容忍", () => {
  const file = tmpFile();
  const log = new AuditLog(file);
  log.append({ event: "op1", preSnapshotHash: "a", postSnapshotHash: "b", riskScore: 0.1 }, GENESIS);
  writeFileSync(file, readFileSync(file, "utf8") + '{"eventId":"half');
  const { events } = log.load();
  assert.equal(events.length, 1);
  rmSync(path.dirname(file), { recursive: true, force: true });
});
