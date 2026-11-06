// 意图展开（3.1）与计划生成（3.2/3.3）测试
import assert from "node:assert/strict";
import test from "node:test";
import { expandIntent, generatePlan } from "../planner.js";
import type { DeviceState } from "../types.js";

function fakeState(): DeviceState {
  return {
    protocol: "adb",
    fields: { protocol: "adb", currentSlot: "a" },
    degraded: false,
    failedP0: [],
    failedP1: [],
    notApplicable: [],
    readAt: 0,
  };
}

test("意图：root 缺全部变量 → needs_clarification 列出 7 项（P2 加 bootImagePath）", () => {
  const r = expandIntent("root", {});
  assert.equal(r.status, "needs_clarification");
  if (r.status === "needs_clarification") {
    assert.equal(r.missing_variables.length, 7);
    assert.ok(r.missing_variables.includes("root_method"));
    assert.ok(r.missing_variables.includes("target_slot"));
    assert.ok(r.missing_variables.includes("bootImagePath"));
  }
});

test("意图：变量齐全 → ok", () => {
  const r = expandIntent("root", {
    root_method: "magisk",
    hide_target: false,
    bootloader_status: "locked",
    backup_preference: "critical_only",
    target_slot: "current",
    vbmeta_state: "keep_avb",
    bootImagePath: "/firmware/boot.img",
  });
  assert.equal(r.status, "ok");
});

test("计划：root 探索档估算（3.2）", () => {
  const r = expandIntent("root", {
    root_method: "magisk", hide_target: false, bootloader_status: "unlocked",
    backup_preference: "critical_only", target_slot: "current", vbmeta_state: "keep_avb",
    bootImagePath: "/firmware/boot.img",
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  const p = generatePlan({ intent: r.intent, vars: r.vars, state: fakeState(), cacheHit: false });
  assert.equal(p.mode, "exploration");
  assert.equal(p.estimate.p50Ms, 7 * 60000);
  assert.equal(p.estimate.p90Ms, 15 * 60000);
  assert.equal(p.estimate.successRate, 0.85);
  assert.ok(p.steps.length >= 6);
  // 3.3 预计算：每步都有风险分、失败分支、耗时
  for (const s of p.steps) {
    assert.equal(typeof s.calibratedRiskScore, "number");
    assert.ok(s.failureBranches.length > 0);
    assert.ok(s.estimatedDurationMs > 0);
  }
  // P2：estimateWallClock 含重启次数
  assert.match(p.estimateWallClock, /预计耗时/);
  assert.match(p.estimateWallClock, /包含 1 次重启/);
  // v4 五：永久 Root 计划末尾含刷后深度调优步骤
  assert.ok(p.steps.some((s) => s.operation === "post_flash_tune"));
  // v4 五：物理按键操作已注入（unlock/flash/reboot 步骤）
  assert.ok(p.steps.some((s) => (s.physicalOps ?? []).length > 0));
});

test("计划：缓存命中 → 加速档", () => {
  const r = expandIntent("unlock", { backup_preference: "full" });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  const p = generatePlan({ intent: r.intent, vars: r.vars, state: fakeState(), cacheHit: true });
  assert.equal(p.mode, "accelerated");
  assert.equal(p.estimate.p50Ms, 2.75 * 60000);
  assert.equal(p.estimate.successRate, 0.95);
  assert.equal(p.estimateSource, "default");
});

test("计划：传入历史估算 → estimateSource=history（P1）", () => {
  const r = expandIntent("root", {
    root_method: "magisk", hide_target: false, bootloader_status: "unlocked",
    backup_preference: "critical_only", target_slot: "current", vbmeta_state: "keep_avb",
    bootImagePath: "/firmware/boot.img",
  });
  if (r.status !== "ok") return assert.fail("展开失败");
  const p = generatePlan({
    intent: r.intent, vars: r.vars, state: fakeState(), cacheHit: false,
    estimate: { p50Ms: 183000, p90Ms: 240000, successRate: 1.0 },
  });
  assert.equal(p.estimateSource, "history");
  assert.equal(p.estimate.p50Ms, 183000);
  assert.equal(p.estimate.p90Ms, 240000);
});

test("计划：locked BL 会插入 unlock 步骤；disable_verity 插入 vbmeta 步骤", () => {
  const r = expandIntent("root", {
    root_method: "kernelsu", hide_target: true, bootloader_status: "locked",
    backup_preference: "full", target_slot: "b", vbmeta_state: "disable_verity",
    bootImagePath: "/firmware/boot.img",
  });
  if (r.status !== "ok") return assert.fail("展开失败");
  const p = generatePlan({ intent: r.intent, vars: r.vars, state: fakeState(), cacheHit: false });
  assert.ok(p.steps.some((s) => s.operation === "unlock_bootloader"));
  assert.ok(p.steps.some((s) => s.operation === "flash_vbmeta_patch"));
  const flash = p.steps.find((s) => s.operation === "flash_boot");
  assert.ok(flash);
  assert.equal(flash.params.target_slot, "b");
  assert.equal(flash.barrier, "exclusive"); // 写入步骤独占屏障
});

test("计划：hide_target → 隐藏栈分阶段编排（P2）", () => {
  const r = expandIntent("root", {
    root_method: "magisk", hide_target: true, bootloader_status: "unlocked",
    backup_preference: "critical_only", target_slot: "current", vbmeta_state: "keep_avb",
    bootImagePath: "/firmware/boot.img",
  });
  if (r.status !== "ok") return assert.fail("展开失败");
  const p = generatePlan({ intent: r.intent, vars: r.vars, state: fakeState(), cacheHit: false });
  const ops = p.steps.map((s) => s.operation);
  // 顺序断言：flash boot → reboot → verify root → baseline×2 → install×2 → denylist → reboot → integrity
  const idx = (op: string, from = 0) => ops.indexOf(op, from);
  const flashIdx = idx("flash_boot");
  const reboot1 = idx("reboot_verify");
  const verifyRoot = idx("verify_root");
  const baseline1 = idx("module_baseline");
  const installZy = idx("install_module");
  const baseline2 = idx("module_baseline", baseline1 + 1);
  const installPif = idx("install_module", installZy + 1);
  const denylist = idx("configure_denylist");
  const reboot2 = idx("reboot");
  const integrity = idx("verify_integrity");
  assert.ok(flashIdx < reboot1 && reboot1 < verifyRoot, "刷入→重启→验证 root 顺序");
  assert.ok(verifyRoot < baseline1 && baseline1 < installZy, "baseline 先于安装（Zygisk Next）");
  assert.ok(installZy < baseline2 && baseline2 < installPif, "PIF 安装前再次 baseline 差分");
  assert.ok(installPif < denylist && denylist < reboot2 && reboot2 < integrity, "DenyList → 重启 → Integrity");
  // 每个模块的 baseline 都在对应 install 之前
  assert.ok(baseline1 < installZy && baseline2 < installPif);
  // estimateWallClock 明确告知 2 次重启
  assert.match(p.estimateWallClock, /包含 2 次重启/);
});

test("计划：hide_target=false → 无隐藏栈步骤（P2）", () => {
  const r = expandIntent("root", {
    root_method: "magisk", hide_target: false, bootloader_status: "unlocked",
    backup_preference: "critical_only", target_slot: "current", vbmeta_state: "keep_avb",
    bootImagePath: "/firmware/boot.img",
  });
  if (r.status !== "ok") return assert.fail("展开失败");
  const p = generatePlan({ intent: r.intent, vars: r.vars, state: fakeState(), cacheHit: false });
  const ops = p.steps.map((s) => s.operation);
  assert.ok(!ops.includes("install_module"));
  assert.ok(!ops.includes("verify_integrity"));
  assert.match(p.estimateWallClock, /包含 1 次重启/);
});

test("计划：persistence=temporary → 临时 Root（无刷写/模块栈，明确告知重启失效）（v3 四）", () => {
  const r = expandIntent("root", {
    root_method: "magisk", hide_target: true, bootloader_status: "unlocked",
    backup_preference: "critical_only", target_slot: "current", vbmeta_state: "keep_avb",
    bootImagePath: "/firmware/boot.img", rootPersistence: "temporary",
  });
  if (r.status !== "ok") return assert.fail("展开失败");
  const p = generatePlan({ intent: r.intent, vars: r.vars, state: fakeState(), cacheHit: false });
  const ops = p.steps.map((s) => s.operation);
  assert.ok(ops.includes("exploit_probe"));
  assert.ok(ops.includes("payload_exec"));
  assert.ok(ops.includes("verify_root"));
  assert.ok(!ops.includes("flash_boot"));      // 临时 Root 不刷 boot
  assert.ok(!ops.includes("install_module"));  // 模块栈不可持久化
  assert.match(p.notes.join("\n"), /重启后失效/);
  assert.match(p.notes.join("\n"), /无法持久化模块/);
  // 物理操作注入：payload 步骤有引导
  const payload = p.steps.find((s) => s.operation === "payload_exec")!;
  assert.ok((payload.physicalOps ?? []).length > 0);
});

test("计划：erase_userdata 擦除步骤预热标记（5.4）", () => {
  const r = expandIntent("erase_userdata", { backup_preference: "critical_only" });
  if (r.status !== "ok") return assert.fail("展开失败");
  const p = generatePlan({ intent: r.intent, vars: r.vars, state: fakeState(), cacheHit: false });
  const erase = p.steps.find((s) => s.operation === "erase_partition");
  assert.ok(erase);
  assert.equal(erase.preheat, true);
});
