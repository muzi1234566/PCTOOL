// 三级护栏决策测试（纯逻辑，注入合成 DeviceState）
import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, formatIntercept } from "../guardrails.js";
import { WARN_LOGICAL_ERASE_ONLY } from "../errors.js";
import type { DeviceState, FieldValue } from "../types.js";

function fakeState(fields: Record<string, FieldValue>, opts?: Partial<DeviceState>): DeviceState {
  return {
    protocol: (fields.protocol as DeviceState["protocol"]) ?? "fastboot",
    fields: { protocol: "fastboot", ...fields },
    degraded: false,
    failedP0: [],
    failedP1: [],
    notApplicable: [],
    readAt: 0,
    ...opts,
  };
}

const OK = { snapshotUpdateStatus: "none", triesRemaining: 7, currentSlot: "a", arbFused: false };

test("护栏：正常状态 flash_boot → allow，基础风险 0.35", () => {
  const d = evaluate("flash_boot", { state: fakeState({ ...OK }) });
  assert.equal(d.verdict, "allow");
  assert.equal(d.riskScore, 0.35);
});

test("护栏：snapshot merging → deny_with_override", () => {
  const d = evaluate("flash_boot", { state: fakeState({ ...OK, snapshotUpdateStatus: "merging" }) });
  assert.equal(d.verdict, "deny_with_override");
  assert.ok(d.guide);
});

test("护栏：snapshot merging + 令牌已消费（overrideCleared）→ allow", () => {
  const d = evaluate("flash_boot", {
    state: fakeState({ ...OK, snapshotUpdateStatus: "merging" }),
    overrideCleared: true,
  });
  assert.equal(d.verdict, "allow");
});

test("护栏：无备份擦除 persist → deny_with_override", () => {
  const d = evaluate("erase_partition", { state: fakeState({ ...OK, protocol: "adb" }), partition: "persist" });
  assert.equal(d.verdict, "deny_with_override");
});

test("护栏：有备份擦除 persist → 令牌放行后仍仅手动引导（2.3）", () => {
  const d = evaluate("erase_partition", {
    state: fakeState({ ...OK, protocol: "adb" }),
    partition: "persist",
    backupPresent: true,
    overrideCleared: true,
  });
  assert.equal(d.verdict, "deny_auto");
  assert.match(d.reason, /永不自动执行/);
  assert.ok(d.guide.steps.length > 0);
});

test("护栏：unlock_bootloader → deny_auto 附引导", () => {
  const d = evaluate("unlock_bootloader", { state: fakeState({ ...OK }) });
  assert.equal(d.verdict, "deny_auto");
  assert.ok(d.guide.steps.length >= 3);
  assert.ok(d.guide.risks.some((r) => r.includes("熔断")));
});

test("护栏：Knox 熔断 → deny_hard", () => {
  const d = evaluate("flash_boot", { state: fakeState({ ...OK, knoxFused: true }) });
  assert.equal(d.verdict, "deny_hard");
});

test("护栏：tries_remaining=1 写 boot → infeasible（6.2）", () => {
  assert.throws(
    () => evaluate("flash_boot", { state: fakeState({ ...OK, triesRemaining: 1 }) }),
    /重试次数仅剩 1/,
  );
});

test("护栏：P1 缺失 → 风险 +0.2 且写操作降级 deny_auto", () => {
  const d = evaluate("flash_boot", {
    state: fakeState({ ...OK }, { failedP1: ["batteryLevel"], degraded: true }),
  });
  assert.equal(d.verdict, "deny_auto");
  assert.equal(d.riskScore, 0.55); // 0.35 + 0.2
});

test("护栏：tries_remaining N/A + flash_boot → 直接 deny_auto（P1 收紧）", () => {
  const st = fakeState({ ...OK });
  st.notApplicable = ["triesRemaining"];
  delete st.fields.triesRemaining;
  const d = evaluate("flash_boot", { state: st });
  assert.equal(d.verdict, "deny_auto");
  assert.equal(d.riskScore, 0.55); // 0.35 + 0.2
  assert.match(d.reason, /tries_remaining/);
});

test("护栏：tries_remaining 未采集（undefined）+ flash_boot → deny_auto", () => {
  const st = fakeState({ ...OK });
  delete st.fields.triesRemaining;
  const d = evaluate("flash_boot", { state: st });
  assert.equal(d.verdict, "deny_auto");
});

test("护栏：tries_remaining 读取失败（null → failedP1）走降级规则", () => {
  const d = evaluate("flash_boot", {
    state: fakeState({ ...OK }, { failedP1: ["triesRemaining"], degraded: true }),
  });
  assert.equal(d.verdict, "deny_auto");
});

test("护栏：tries_remaining 可读且 >1 → 不触发收紧规则（仍 allow）", () => {
  const d = evaluate("flash_boot", { state: fakeState({ ...OK, triesRemaining: 7 }) });
  assert.equal(d.verdict, "allow");
});

test("护栏：P0 失败 → infeasible", () => {
  assert.throws(
    () => evaluate("flash_boot", { state: fakeState({ ...OK }, { failedP0: ["currentSlot"] }) }),
    /P0 字段读取失败/,
  );
});

test("护栏：强行快速擦除 → 引导含 LOGICAL_ERASE_ONLY 警告（6.6）", () => {
  const d = evaluate("erase_partition", {
    state: fakeState({ ...OK, protocol: "adb" }),
    partition: "userdata",
    forceFastErase: true,
  });
  assert.equal(d.verdict, "deny_auto");
  assert.ok(d.guide.warnings.some((w) => w.includes(WARN_LOGICAL_ERASE_ONLY)));
});

test("护栏：10.1 拦截话术格式", () => {
  const d = evaluate("unlock_bootloader", { state: fakeState({ ...OK }) });
  const msg = formatIntercept("unlock_bootloader", d);
  assert.match(msg, /【高风险拦截】检测到您试图执行 unlock_bootloader/);
  assert.match(msg, /系统已启用 deny_auto/);
  assert.match(msg, /手动执行引导/);
});
