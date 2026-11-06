// v3 场景矩阵测试：intent-spec 匹配 / ARB 硬拦截 / 伪回锁 / 场景计划生成 / serial 防呆 / 漏洞登记表
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildUtilityPlan, checkSerialMatch, findHideConflicts, isAbDevice, matchDowngradeCandidates, UtilityVars } from "../scenarios.js";
import { matchKernelExploits, parseKernelVersion } from "../exploit-registry.js";
import type { DeviceState, FieldValue } from "../types.js";

function fakeState(fields: Record<string, FieldValue>): DeviceState {
  return {
    protocol: "adb",
    fields: { protocol: "adb", ...fields },
    degraded: false,
    failedP0: [],
    failedP1: [],
    notApplicable: [],
    readAt: 0,
  };
}

const BASE: UtilityVars = {};

// ───────────── 一：意图澄清与 ARB ─────────────

test("intent-spec：「打游戏不发热」→ 2-3 个候选（含 MIUI 12.5.8），每个带补丁级别", () => {
  const c = matchDowngradeCandidates("打游戏不发热的版本");
  assert.ok(c.length >= 2 && c.length <= 3);
  assert.ok(c.some((x) => x.id === "miui-12.5.8"));
  for (const x of c) assert.match(x.securityPatch, /^\d{4}-\d{2}-\d{2}$/);
});

test("ARB 硬拦截：目标补丁级别早于当前 → deny_hard（eFuse 熔断）", () => {
  const st = fakeState({ securityPatch: "2024-01-01" });
  assert.throws(
    () => buildUtilityPlan("downgrade_rom", { ...BASE, targetVersion: "miui-12.5.8" }, st),
    (e: { code: string; message: string }) => e.code === "deny_hard" && /ARB 熔断/.test(e.message),
  );
});

test("ARB：目标补丁级别晚于当前 → 放行生成计划（含基带备份步骤）", () => {
  const st = fakeState({ securityPatch: "2020-01-01" });
  const p = buildUtilityPlan("downgrade_rom", { ...BASE, targetVersion: "miui-12.5.8" }, st);
  const ops = p.steps.map((s) => s.operation);
  assert.ok(ops.filter((o) => o === "backup_partition").length === 4); // modemst1/2 + fsg + persist
  assert.ok(ops.includes("flash_firmware_guide"));
  assert.match(p.notes.join("\n"), /ARB 比对通过/);
});

// ───────────── 二：核心场景 ─────────────

test("OTA 保 Root：非 A/B 设备 → 直接拒绝", () => {
  const st = fakeState({ currentSlot: null });
  assert.equal(isAbDevice(st), false);
  assert.throws(
    () => buildUtilityPlan("ota_keep_root", BASE, st),
    /仅支持 A\/B 设备/,
  );
});

test("OTA 保 Root：A/B 设备 → 完整闭环（dump→修补→刷非活动槽→校验→重启），物理按键已标注", () => {
  const st = fakeState({ currentSlot: "a" });
  const p = buildUtilityPlan("ota_keep_root", BASE, st);
  const ops = p.steps.map((s) => s.operation);
  for (const op of ["ota_dump_inactive", "ota_patch_inactive", "ota_flash_inactive", "ota_verify_slot", "reboot", "verify_root"]) {
    assert.ok(ops.includes(op), `缺少步骤 ${op}`);
  }
  const flash = p.steps.find((s) => s.operation === "ota_flash_inactive")!;
  assert.equal(flash.barrier, "exclusive");
  // 计划内显式重启 1 次（OTA 安装阶段的重启由用户在 s3 引导内完成，不计入）
  assert.match(p.estimateWallClock, /包含 1 次重启/);
  assert.ok(p.steps.some((s) => (s.physicalOps ?? []).length > 0));
});

test("伪回锁：三星（SM- 前缀）→ deny_hard Knox；非三星 → 计划含 devinfo 备份+刷写", () => {
  const samsung = fakeState({ deviceModel: "SM-G9910" });
  assert.throws(
    () => buildUtilityPlan("fake_relock", BASE, samsung),
    (e: { code: string; message: string }) => e.code === "deny_hard" && /KNOX/.test(e.message),
  );
  const pixel = fakeState({ deviceModel: "Pixel 7", soc: "tensor" });
  const p = buildUtilityPlan("fake_relock", BASE, pixel);
  const ops = p.steps.map((s) => s.operation);
  assert.ok(ops.includes("backup_partition") && ops.includes("flash_devinfo") && ops.includes("verify_relock"));
  assert.match(p.notes.join("\n"), /未确认 SoC/); // tensor 不在 qcom/mtk 表内 → 诚实提示
});

test("跨区刷机：区域不符 → 强制 4 个基带分区备份 + 清单检查步骤", () => {
  const st = fakeState({ regionCode: "CN" });
  const p = buildUtilityPlan("cross_region_flash", { ...BASE, region: "EU" }, st);
  const backups = p.steps.filter((s) => s.operation === "backup_partition").map((s) => String(s.params.partition));
  assert.deepEqual(backups.sort(), ["fsg", "modemst1", "modemst2", "persist"]);
  assert.ok(p.steps.some((s) => s.operation === "backup_manifest_check"));
  assert.match(p.notes.join("\n"), /区域码不符/);
});

test("无 Recovery 救砖：temp_boot 缺镜像 → needs_clarification；给真实镜像 → fastboot boot 步骤", () => {
  assert.throws(
    () => buildUtilityPlan("no_recovery_rescue", { ...BASE, mode: "temp_boot" }, fakeState({})),
    /rescueImgPath/,
  );
  const dir = mkdtempSync(path.join(tmpdir(), "rescue-"));
  const img = path.join(dir, "twrp.img");
  writeFileSync(img, Buffer.alloc(512, 0x5a));
  const p = buildUtilityPlan("no_recovery_rescue", { ...BASE, mode: "temp_boot", rescueImgPath: img }, fakeState({}));
  assert.ok(p.steps.some((s) => s.operation === "fastboot_boot_temp"));
  const p2 = buildUtilityPlan("no_recovery_rescue", { ...BASE, mode: "disable_modules" }, fakeState({}));
  assert.ok(p2.steps.some((s) => s.operation === "disable_module"));
  rmSync(dir, { recursive: true, force: true });
});

// ───────────── 三：玩机生态 ─────────────

test("gaming_tune：baseline → 应用（独占）→ 报告", () => {
  const p = buildUtilityPlan("gaming_tune", { ...BASE, profile: "performance" }, fakeState({}));
  const ops = p.steps.map((s) => s.operation);
  assert.ok(ops.indexOf("perf_baseline") < ops.indexOf("apply_perf_profile"));
  assert.equal(p.steps.find((s) => s.operation === "apply_perf_profile")!.barrier, "exclusive");
  assert.match(p.notes.join("\n"), /performance/);
});

test("privacy_modules：LSPosed 安装前有 Zygisk 检查，补丁前有 baseline", () => {
  const p = buildUtilityPlan("privacy_modules", BASE, fakeState({}));
  const ops = p.steps.map((s) => s.operation);
  assert.ok(ops.indexOf("zygisk_check") < ops.indexOf("install_module"));
  assert.ok(ops.indexOf("buildprop_baseline") < ops.indexOf("apply_buildprop_patch"));
});

test("data_rescue：有 Root 走 tar 打包；免 Root 走 Shizuku", () => {
  const rooted = buildUtilityPlan("data_rescue", { ...BASE, mode: "rooted" }, fakeState({}));
  const opsR = rooted.steps.map((s) => s.operation);
  assert.ok(opsR.includes("force_stop_app") && opsR.includes("wechat_backup"));
  const rootless = buildUtilityPlan("data_rescue", { ...BASE, mode: "rootless" }, fakeState({}));
  assert.ok(rootless.steps.some((s) => s.operation === "shizuku_start"));
});

test("advanced_hide：VFS 冲突只读检查在安装之前（提供模块包时走 install_module）", () => {
  const p = buildUtilityPlan("advanced_hide", { ...BASE, stack: "nomount", moduleZipPath: "/modules/nomount.zip" }, fakeState({}));
  const ops = p.steps.map((s) => s.operation);
  assert.ok(ops.indexOf("vfs_conflict_check") < ops.indexOf("install_module"));
  // 未提供模块包 → 走引导步骤
  const p2 = buildUtilityPlan("advanced_hide", { ...BASE, stack: "hybrid" }, fakeState({}));
  assert.ok(p2.steps.some((s) => s.operation === "stack_guide"));
});

test("rootless：DSU 引导带物理按键路径", () => {
  const p = buildUtilityPlan("rootless", { ...BASE, prefer: "dsu" }, fakeState({}));
  const dsu = p.steps.find((s) => s.operation === "dsu_guide")!;
  assert.ok((dsu.physicalOps ?? []).length > 0);
});

// ───────────── 五：QCN 救砖 ─────────────

test("unbrick_qcn：无 QCN → deny_auto + QPST 引导；有 QCN → 计划含 post_verify", () => {
  const st = fakeState({ basebandStatus: null });
  try {
    buildUtilityPlan("unbrick_qcn", BASE, st);
    assert.fail("应抛 deny_auto");
  } catch (e) {
    const err = e as { code: string; details: { guide: { steps: string[] } } };
    assert.equal(err.code, "deny_auto");
    assert.ok(err.details.guide.steps.length >= 3);
    assert.match(err.details.guide.steps.join("\n"), /Restore QCN/);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "qcn-"));
  const qcn = path.join(dir, "mine.qcn");
  writeFileSync(qcn, Buffer.alloc(4096, 0x5a)); // 本机 QCN 备份必须真实存在
  const p = buildUtilityPlan("unbrick_qcn", { ...BASE, qcnPath: qcn }, fakeState({ basebandStatus: null }));
  assert.ok(p.steps.some((s) => s.operation === "baseband_post_verify"));
  assert.ok(p.steps.some((s) => (s.physicalOps ?? []).some((x) => x.includes("9008"))));
  rmSync(dir, { recursive: true, force: true });
});

// ───────────── 二2：serial 防呆 ─────────────

test("serial 防呆：绑定与当前不一致 → target_mismatch；一致/未绑 → 放行", () => {
  assert.throws(() => checkSerialMatch("ABC123", "XYZ789"), (e: { code: string }) => e.code === "target_mismatch");
  assert.doesNotThrow(() => checkSerialMatch("ABC123", "ABC123"));
  assert.doesNotThrow(() => checkSerialMatch(null, "ABC123"));
  assert.doesNotThrow(() => checkSerialMatch("ABC123", null)); // 读不到 serial → 不误杀（文档化行为）
});

// ───────────── 四：漏洞登记表 ─────────────

test("内核版本解析与匹配：GKI LKM 能力命中，占位 CVE 永不匹配", () => {
  assert.deepEqual(parseKernelVersion("5.10.66-android13-abc"), [5, 10, 66]);
  const m = matchKernelExploits("5.10.66-android13");
  assert.ok(m.some((e) => e.id === "lkm-gki"));
  assert.ok(!m.some((e) => e.id === "CVE-2026-98260")); // 占位条目区间 0.0.0 → 永不匹配
  assert.deepEqual(matchKernelExploits(null), []);
});

// ───────────── 互斥组合检查 ─────────────

test("findHideConflicts：NoMount × 挂载分流类 → 冲突报告", () => {
  const conflicts = findHideConflicts("shamiko\nnomount_uid\nzygisk_next\n");
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /UID 隔离/);
  assert.deepEqual(findHideConflicts("zygisk_next\n"), []);
});

// ───────────── 输出格式（六） ─────────────

test("输出格式：场景计划包含物理按键操作与依赖顺序（六1）", () => {
  const p = buildUtilityPlan("ota_keep_root", BASE, fakeState({ currentSlot: "a" }));
  assert.ok(p.steps.some((s) => (s.physicalOps ?? []).length > 0));
  assert.match(p.estimateWallClock, /预计耗时/);
  assert.ok(p.steps.every((s) => typeof s.calibratedRiskScore === "number"));
});
