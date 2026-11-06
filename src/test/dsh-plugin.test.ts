// DSH 插件测试：工具注册 / 会话状态机 / 审批闸门 / Markdown 渲染（内存 ctx，全离线）
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerDshPlugin, renderDenialMd, renderPlanMd } from "../dsh-plugin.js";
import type { DshPluginContext, DshToolDefinition, DshToolResult } from "../dsh-plugin.js";
import type { ManualGuide, Plan } from "../types.js";

interface MemoryCtx extends DshPluginContext {
  registered: DshToolDefinition[];
  store: Map<string, unknown>;
}

function memoryCtx(): MemoryCtx {
  const ctx: MemoryCtx = {
    registered: [],
    store: new Map(),
    storage: {
      get: async <T>(key: string) => ((ctx.store.get(key) as T) ?? null),
      set: async <T>(key: string, value: T) => { ctx.store.set(key, value); },
    },
    tools: {
      register: (def: DshToolDefinition) => { ctx.registered.push(def); },
    },
  };
  return ctx;
}

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "dshplugin-"));
}

function fakePlan(): Plan {
  return {
    planId: "11111111-2222-3333-4444-555555555555",
    intent: "root",
    mode: "exploration",
    estimate: { p50Ms: 420000, p90Ms: 600000, successRate: 0.95 },
    estimateSource: "history",
    estimateWallClock: "预计耗时 10.5 分钟，包含 2 次重启",
    steps: [
      { id: "s1_probe", operation: "probe_bundle", params: {}, calibratedRiskScore: 0, failureBranches: ["设备不可见"], estimatedDurationMs: 30000, preheat: false, barrier: "none" },
      { id: "s6_flash_boot", operation: "flash_boot", params: {}, calibratedRiskScore: 0.35, failureBranches: ["tries=1→换槽位"], estimatedDurationMs: 60000, preheat: false, barrier: "exclusive" },
      { id: "s10_verify_root", operation: "verify_root", params: {}, calibratedRiskScore: 0.1, failureBranches: ["su 不可用"], estimatedDurationMs: 30000, preheat: false, barrier: "none" },
    ],
    missingVariables: [],
    notes: ["[资源准备] 修补完成（backend=manual）"],
  };
}

function fakeGuide(): ManualGuide {
  return {
    operation: "unlock_bootloader",
    preconditions: ["已完整备份"],
    steps: ["adb reboot bootloader", "fastboot flashing unlock"],
    risks: ["全部用户数据清空", "部分机型解锁即永久熔断"],
    warnings: [],
  };
}

test("注册：暴露且仅暴露 4 个工具，名称与 schema 正确（v3）", () => {
  const ctx = memoryCtx();
  const dir = tmpDir();
  registerDshPlugin(ctx, { stateDir: dir, cacheDir: path.join(dir, "cache") });
  assert.deepEqual(ctx.registered.map((t) => t.name).sort(),
    ["android_execute_step", "android_plan_root", "android_plan_utility", "android_probe"]);
  const exec = ctx.registered.find((t) => t.name === "android_execute_step")!;
  assert.ok((exec.inputSchema as { properties: Record<string, unknown> }).properties.confirmPlan);
  assert.deepEqual((exec.inputSchema as { required: string[] }).required, ["stepId"]);
  const util = ctx.registered.find((t) => t.name === "android_plan_utility")!;
  const enumScenarios = ((util.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties.scenario.enum) ?? [];
  assert.ok(enumScenarios.includes("ota_keep_root"));
  assert.ok(enumScenarios.includes("downgrade_rom"));
  rmSync(dir, { recursive: true, force: true });
});

test("android_plan_utility：降级意图模糊匹配 → 候选表 + 二次选择（不瞎猜）", async () => {
  const ctx = memoryCtx();
  const dir = tmpDir();
  registerDshPlugin(ctx, { stateDir: dir, cacheDir: path.join(dir, "cache") });
  const util = ctx.registered.find((t) => t.name === "android_plan_utility")!;
  const r = await util.execute({ scenario: "downgrade_rom", versionQuery: "打游戏不发热的版本" }, ctx);
  assert.equal(r.require_user_approval, true);
  assert.match(r.content, /版本候选/);
  assert.match(r.content, /targetVersion/);
  const cands = (r.data as { candidates: Array<{ id: string }> }).candidates;
  assert.ok(cands.length >= 1 && cands.length <= 3);
  rmSync(dir, { recursive: true, force: true });
});

test("android_probe：无设备返回 markdown 画像（协议 none 提示）", async () => {
  const ctx = memoryCtx();
  const dir = tmpDir();
  registerDshPlugin(ctx, { stateDir: dir, cacheDir: path.join(dir, "cache") });
  const probe = ctx.registered.find((t) => t.name === "android_probe")!;
  const r: DshToolResult = await probe.execute({}, ctx);
  assert.match(r.content, /设备画像/);
  assert.match(r.content, /协议 \| none/);
  assert.match(r.content, /未检测到设备/);
  assert.equal(r.require_user_approval, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("android_execute_step：无计划时被引导先 plan（不进入执行）", async () => {
  const ctx = memoryCtx();
  const dir = tmpDir();
  registerDshPlugin(ctx, { stateDir: dir, cacheDir: path.join(dir, "cache") });
  const exec = ctx.registered.find((t) => t.name === "android_execute_step")!;
  const r = await exec.execute({ stepId: "s1_probe" }, ctx);
  assert.match(r.content, /先调用 `android_plan_root`/);
  rmSync(dir, { recursive: true, force: true });
});

test("审批闸门：计划未确认 → require_user_approval=true 且不执行；confirmPlan 后放行", async () => {
  const ctx = memoryCtx();
  const dir = tmpDir();
  registerDshPlugin(ctx, { stateDir: dir, cacheDir: path.join(dir, "cache") });
  const exec = ctx.registered.find((t) => t.name === "android_execute_step")!;

  // 伪造已生成计划（未确认）——绕过 plan 工具直接写会话（plan 工具在无设备下会失败）
  await ctx.storage.set("android-playground-orchestrator/session", {
    planId: "fake-plan", stepIds: ["s1_probe", "s6_flash_boot"], planApproved: false,
    completedSteps: [], awaitingApproval: null, hideMode: "basic",
  });

  const r1 = await exec.execute({ stepId: "s1_probe" }, ctx);
  assert.equal(r1.require_user_approval, true);
  assert.match(r1.content, /计划尚未确认/);

  // confirmPlan 后：放行进入执行层；Orchestrator 内无该计划 → 结构化 blocked（证明闸门已过）
  const r2 = await exec.execute({ stepId: "s1_probe", confirmPlan: true }, ctx);
  assert.notEqual(r2.require_user_approval, true);
  assert.match(r2.content, /计划 fake-plan 不存在/);
  const sessionAfter = await ctx.storage.get<{ planApproved: boolean; completedSteps: string[] }>("android-playground-orchestrator/session");
  assert.equal(sessionAfter!.planApproved, true);
  rmSync(dir, { recursive: true, force: true });
});

test("abortPlan：清空会话并提示审计保留", async () => {
  const ctx = memoryCtx();
  const dir = tmpDir();
  registerDshPlugin(ctx, { stateDir: dir, cacheDir: path.join(dir, "cache") });
  const exec = ctx.registered.find((t) => t.name === "android_execute_step")!;
  await ctx.storage.set("android-playground-orchestrator/session", {
    planId: "fake-plan", stepIds: [], planApproved: true, completedSteps: ["s1_probe"], awaitingApproval: null, hideMode: "basic",
  });
  const r = await exec.execute({ stepId: "x", abortPlan: true }, ctx);
  assert.match(r.content, /计划已中止/);
  const s = await ctx.storage.get<{ planId: string | null }>("android-playground-orchestrator/session");
  assert.equal(s!.planId, null);
  rmSync(dir, { recursive: true, force: true });
});

test("渲染：计划表含 P50/P90/重启次数/依赖顺序/确认提示", () => {
  const md = renderPlanMd(fakePlan(), "strong");
  assert.match(md, /P50 7\.0min/);
  assert.match(md, /P90 10\.0min/);
  assert.match(md, /包含 2 次重启/);
  assert.match(md, /s1_probe → s6_flash_boot → s10_verify_root/);
  assert.match(md, /confirmPlan: true/);
  assert.match(md, /🔒 独占/);
  assert.match(md, /capability-map 历史/);
});

test("渲染：拦截话术含警告框/引导/令牌/阻断指令", () => {
  const res = {
    plan_id: null, step: "unlock_bootloader", status: "blocked" as const,
    pre_snapshot_hash: null, post_snapshot_hash: null, next_step: null,
    risk_score: 0.8, estimated_remaining_time: null, degraded: false,
    error_code: "deny_auto" as const,
    message: "【高风险拦截】检测到您试图执行 unlock_bootloader。该操作不可逆，且由于 属永久类，系统已启用 deny_auto。",
  };
  const token = { tokenId: "t-1", operation: "unlock_bootloader", expiresAt: 1, riskAcknowledged: true, signature: "sig" };
  const md = renderDenialMd(res, fakeGuide(), token);
  assert.match(md, /⚠️ \*\*【高风险拦截/);
  assert.match(md, /\*\*手动步骤\*\*/);
  assert.match(md, /fastboot flashing unlock/);
  assert.match(md, /\*\*风险报告\*\*/);
  assert.match(md, /永久熔断/);
  assert.match(md, /Override Token/);
  assert.match(md, /不要再次调用 `android_execute_step` 自动推进/);
});
