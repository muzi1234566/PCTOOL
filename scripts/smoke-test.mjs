#!/usr/bin/env node
// 真机冒烟测试：探测 → 意图门控 → 计划（capability-map 估算）→ 写入尝试 → 护栏拦截 + 手动引导 → 断点恢复校验
//
// 安全设计（全程零设备写入）：
//   · flash 尝试使用故意错误的 SHA256 → 在只读预检层被拒，绝不触达设备写入
//   · erase / unlock 本就永不自动执行（2.3），只产出拦截话术 + 手动引导
//   · 恢复校验只做只读探测
//
// 用法：先 npm run build，然后 npm run smoke（设备可连可不连；未连接时验证无设备路径）
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../dist/index.js";
import { capabilityKeyFromState, recordSample } from "../dist/capability-map.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(here, "..", "smoke-state");
const results = [];

function check(name, cond, detail = "") {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  → ${detail}` : ""}`);
}

function section(title) {
  console.log(`\n━━━ ${title} ━━━`);
}

rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });
const o = new Orchestrator({ stateDir, cacheDir: path.join(stateDir, "cache") });

// ─── [1/6] 批量探测 ───
section("[1/6] probeBundle：批量探测 + 资源预取");
const bundle = await o.probeBundle();
const state = bundle.state;
console.log("protocol   :", state.protocol);
console.log("degraded   :", state.degraded);
console.log("failedP0   :", JSON.stringify(state.failedP0));
console.log("N/A        :", JSON.stringify(state.notApplicable));
console.log("fields     :", JSON.stringify(state.fields));
check("探测返回有效状态对象", !!state && typeof state.protocol === "string");
check("health 派生自同一次批量探测", "batteryLevel" in bundle.health && "deviceModel" in bundle.health);

// ─── [2/6] 意图门控 ───
section("[2/6] 意图展开硬门控");
const c1 = o.clarify("root", {});
check("缺 7 个变量 → needs_clarification 阻塞（P2 加 bootImagePath）",
  c1.status === "needs_clarification",
  c1.status === "needs_clarification" ? `missing=[${c1.missing_variables.join(",")}]` : "");
console.log(JSON.stringify(c1, null, 2));

// ─── [3/6] 计划生成 ───
section("[3/6] 生成 plan（含 P2 资源准备：manual 后端离线走通）");
const dummyBoot = path.join(stateDir, "test-boot.img");
writeFileSync(dummyBoot, Buffer.alloc(1024, 0x5a));
const dummyApk = path.join(stateDir, "test-magisk.apk");
writeFileSync(dummyApk, Buffer.alloc(256, 0x41)); // manual 后端不解包，离线可走通
const vars = {
  root_method: "magisk",
  hide_target: false,
  bootloader_status: "locked",
  backup_preference: "critical_only",
  target_slot: "current",
  vbmeta_state: "keep_avb",
  bootImagePath: dummyBoot,
  managerApkPath: dummyApk,
  patchBackend: "manual",
};
let plan = null;
try {
  const p = await o.plan("root", vars);
  if (p.status === "needs_clarification") {
    check("plan 生成", false, p.message);
    printSummaryAndExit();
  } else {
    plan = p;
  }
} catch (e) {
  // 无设备时 plan 抛 infeasible 是正确行为（P0 断言）
  if (e.code === "infeasible" && /未检测到设备/.test(e.message)) {
    check("无设备时 plan 抛 infeasible（P0 断言生效）", true, e.message);
  } else {
    check("plan 生成", false, String(e));
  }
}
if (!plan) {
  check("后续计划步骤跳过（无设备）", true);
} else {
  check("plan 生成", true, `planId=${plan.planId.slice(0, 8)}… mode=${plan.mode}`);
  check("估算来源 = default（尚无历史）", plan.estimateSource === "default", JSON.stringify(plan.estimate));
  check("locked BL → 计划含 unlock 步骤", plan.steps.some((s) => s.operation === "unlock_bootloader"));
  check("P2 资源准备说明注入 notes", (plan.notes ?? []).some((n) => n.includes("[资源准备]")), `notes=${plan.notes.length} 条`);
  check("estimateWallClock 含重启告知", /包含.*次重启/.test(plan.estimateWallClock ?? ""), plan.estimateWallClock);
  console.log("steps:", plan.steps.map((s) => `${s.id}:${s.operation}(risk=${s.calibratedRiskScore})`).join(" → "));

  // ─── [3.5] capability-map 历史估算生效 ───
  section("[3.5] capability-map：灌入历史样本后估算应切换为 history");
  const key = capabilityKeyFromState(state.fields);
  if (key === "unknown::unknown") {
    check("capability 采样跳过（无设备身份）", true, "protocol=none 或型号未知");
  } else {
    for (let i = 0; i < 6; i++) {
      recordSample(stateDir, key, {
        intent: "root",
        durationMs: 120000 + i * 1000,
        success: true,
        mode: "exploration",
        timestamp: Date.now(),
      });
    }
    const plan2 = await o.plan("root", vars);
    if (plan2.status === "needs_clarification") {
      check("历史估算生效", false, plan2.message);
    } else {
      check("估算来源切换为 history", plan2.estimateSource === "history", JSON.stringify(plan2.estimate));
      console.log(`capability key: ${key}`);
    }
  }
}

// ─── [4/6] flash 写入尝试（故意 SHA256 不匹配）───
section("[4/6] flash 写入尝试（SHA256 故意不匹配 → 只读预检层拒绝，零设备写入）");
const dummy = path.join(stateDir, "dummy-boot.img");
writeFileSync(dummy, Buffer.alloc(64, 0x41));
const wrongSha = createHash("sha256").update("definitely-not-this-image").digest("hex");
const flashRes = await o.flash({
  partition: "boot",
  imagePath: dummy,
  verifySHA256: wrongSha,
  slot: "current",
  sparseHandling: "auto",
});
console.log("flash 结果:", JSON.stringify({ status: flashRes.status, error_code: flashRes.error_code }, null, 2));
if (state.protocol === "fastboot") {
  check("fastboot 模式：SHA256 校验拦截（resource_corrupted）",
    flashRes.status === "failed" && flashRes.error_code === "resource_corrupted",
    flashRes.message ?? "");
} else {
  check("非 fastboot 模式：flash 被阻塞（需先进 bootloader）",
    flashRes.status === "blocked" && (flashRes.error_code === "needs_clarification" || flashRes.error_code === "infeasible"),
    flashRes.error_code ?? "");
}

// ─── [5/6] erase + unlock 护栏拦截 ───
section("[5/6] 护栏拦截：erase persist（无备份）+ unlock 引导");
if (state.protocol === "none") {
  check("无设备：护栏真机路径跳过", true, "protocol=none，仅验证了无设备路径");
} else {
  const er = await o.erase({ partition: "persist", method: "blksecdiscard", requireBackup: false });
  check("erase persist 被拦截", er.status === "blocked", er.error_code ?? "");
  check("拦截话术含 10.1 格式", typeof er.message === "string" && er.message.includes("【高风险拦截】"));
  check("拦截话术含手动引导", typeof er.message === "string" && er.message.includes("手动执行引导"));
  check("deny_with_override 或 deny_auto", er.error_code === "deny_with_override" || er.error_code === "deny_auto", er.error_code ?? "");
  console.log("── 拦截话术全文 ──");
  console.log(er.message ?? "(无)");

  const rootPlan = plan;
  const unlockStep = rootPlan?.steps.find((s) => s.operation === "unlock_bootloader");
  if (unlockStep) {
    const ul = await o.executeStep(rootPlan.planId, unlockStep.id);
    check("unlock 步骤仅产出引导（永不自动执行）", ul.status === "blocked" && ul.error_code === "deny_auto", ul.error_code ?? "");
    check("引导含风险报告", !!ul.guide && ul.guide.risks.length > 0);
    console.log("── unlock 引导步骤 ──");
    ul.guide?.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  }

  // 非法擦除方式 → LOGICAL_ERASE_ONLY 警告
  const badErase = await o.erase({ partition: "userdata", method: "discard", requireBackup: false });
  check("discard/trim 被拒 + LOGICAL_ERASE_ONLY 警告",
    badErase.status === "blocked" && (badErase.message ?? "").includes("LOGICAL_ERASE_ONLY_DATA_REMAINS_RECOVERABLE"),
    badErase.error_code ?? "");
}

// ─── [6/6] 断点恢复校验 ───
section("[6/6] 断点恢复：注入挂起步骤（模拟写入中途崩溃）→ recover 必须先探测并拒绝续跑");
const ctxPath = path.join(stateDir, "context.json");
if (!existsSync(ctxPath)) {
  // 无设备路径：审计链为空（headHash=GENESIS），手工落一份带挂起步骤的上下文
  writeFileSync(ctxPath, JSON.stringify({
    deviceHash: "unknown",
    planId: "",
    barrierStatus: "idle",
    overrideTokens: [],
    lastSnapshot: { timestamp: Date.now(), deviceHash: "unknown", criticalFields: {}, partitionHashes: {} },
    eventChainHash: "GENESIS",
    pendingStep: null,
  }, null, 2));
}
{
  const ctx = JSON.parse(readFileSync(ctxPath, "utf8"));
  ctx.pendingStep = {
    operation: "flash_boot",
    stepId: "s6_flash_boot",
    preSnapshotHash: "deadbeef".repeat(8), // 伪造：与真实设备快照必然不一致
    startedAt: Date.now() - 60000,
  };
  writeFileSync(ctxPath, JSON.stringify(ctx, null, 2));

  let threw = null;
  try {
    await o.recover();
  } catch (e) {
    threw = e;
  }
  check("recover 遇挂起步骤 + 快照不一致 → 抛 unknown_physical_state",
    threw !== null && threw.code === "unknown_physical_state",
    threw ? String(threw.message).slice(0, 80) + "…" : "未抛错");
  check("错误信息要求手动验证", threw?.message?.includes("手动验证") ?? false);
  console.log(threw ? String(threw.message) : "(未抛错)");
}

// ─── 汇总 ───
printSummaryAndExit();

function printSummaryAndExit() {
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n═════ 冒烟结果：${pass} pass / ${fail} fail ═════`);
  if (fail > 0) {
    for (const r of results.filter((x) => !x.pass)) console.log(`  FAIL: ${r.name}`);
    process.exit(1);
  }
  process.exit(0);
}
