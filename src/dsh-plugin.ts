// DSH 插件入口（v3）：4 个工具——android_probe / android_plan_root / android_plan_utility / android_execute_step
//
// 适配说明：ctx.tools.register / ctx.storage 按 DSH 插件规范命名；若实际 API 有出入
// （如 defineTool 风格），只需调整本文件顶部 DshPluginContext 适配层，编排核心零改动。
// 状态持久化：计划/审批态存 DSH storage；pendingStep 由 Orchestrator 落本地 context.json（双层）。
import { Orchestrator } from "./index.js";
import { capabilityKeyFromState } from "./capability-map.js";
import { matchKernelExploits } from "./exploit-registry.js";
import { checkPatchedCache } from "./root-prep.js";
import { matchDowngradeCandidates, UTILITY_SCENARIOS, UtilityScenario, UtilityVars } from "./scenarios.js";
import { blindSequenceTable } from "./blind-ops.js";
import { OrchestratorError } from "./errors.js";
import type { ManualGuide, Plan, StepResult } from "./types.js";

// ───────────── DSH 适配层（唯一需要与 DSH 实际 API 对齐的部分） ─────────────

export interface DshStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}

export interface DshPluginContext {
  storage: DshStorage;
  tools: { register(tool: DshToolDefinition): void };
  logger?: { info?(msg: string): void; warn?(msg: string): void; error?(msg: string): void };
}

export interface DshToolResult {
  content: string;                     // 终端呈现的 Markdown
  data?: Record<string, unknown>;      // 结构化数据
  require_user_approval?: boolean;     // true = 阻断自动继续，等用户确认
}

export interface DshToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: DshPluginContext): Promise<DshToolResult>;
}

// defineTool 风格的别名（若 DSH 暴露的是 defineTool 而非 tools.register）
export function defineTool(def: DshToolDefinition): DshToolDefinition {
  return def;
}

// ───────────── 插件会话状态 ─────────────

const STATE_KEY = "android-playground-orchestrator/session";

interface AwaitingApproval {
  stepId: string;
  operation: string;
  verdict: "deny_auto" | "deny_with_override";
  token?: unknown;          // deny_with_override：已生成待回传令牌
  guideMd: string;
}

interface PluginSession {
  planId: string | null;
  stepIds: string[];
  planApproved: boolean;
  completedSteps: string[];
  awaitingApproval: AwaitingApproval | null;
  hideMode: "basic" | "strong";
  scenario: string | null; // v3：当前计划来源（root / utility 场景名）
}

function blankSession(): PluginSession {
  return { planId: null, stepIds: [], planApproved: false, completedSteps: [], awaitingApproval: null, hideMode: "basic", scenario: null };
}

// ───────────── Markdown 渲染 ─────────────

function fmtMs(ms: number): string {
  return ms >= 60000 ? `${(ms / 60000).toFixed(1)}min` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

function riskStars(score: number): string {
  const n = Math.max(1, Math.min(5, Math.round(score * 5)));
  return "★".repeat(n) + "☆".repeat(5 - n);
}

export function renderProbeMd(fields: {
  protocol: unknown; deviceModel: unknown; buildId: unknown; currentSlot: unknown;
  snapshotUpdateStatus: unknown; triesRemaining: unknown; batteryLevel: unknown;
  storageHealth: unknown; escapePathReady: unknown; degraded: boolean;
  failedP0: string[]; notApplicable: string[]; patchedCache?: string | null;
  deviceSerial?: unknown; kernelVersion?: unknown; basebandStatus?: unknown;
  exploitMatches?: Array<{ id: string; title: string; kind: string }>;
}): string {
  const health = typeof fields.storageHealth === "string" ? fields.storageHealth : null;
  const lines: string[] = [
    "### 设备画像（android_probe）",
    "",
    "| 项 | 值 |",
    "|---|---|",
    `| 协议 | ${fmtVal(fields.protocol)} |`,
    `| 型号 / buildId | ${fmtVal(fields.deviceModel)} :: ${fmtVal(fields.buildId)} |`,
    `| 设备 serial | ${fmtVal(fields.deviceSerial)} |`,
    `| 当前槽位 | ${fmtVal(fields.currentSlot)} |`,
    `| snapshot 状态 | ${fmtVal(fields.snapshotUpdateStatus)} |`,
    `| tries 剩余 | ${fmtVal(fields.triesRemaining)} |`,
    `| 电量 | ${fields.batteryLevel != null ? `${fields.batteryLevel}%` : "—"} |`,
    `| 存储健康 (life_time) | ${fmtVal(health)} |`,
    `| 内核版本 | ${fmtVal(fields.kernelVersion)} |`,
    `| 基带 | ${fmtVal(fields.basebandStatus)} |`,
    `| Root 逃生通道 | ${fields.escapePathReady === true ? "✓" : fields.escapePathReady === false ? "✗" : "—"} |`,
    `| 降级标记 | ${fields.degraded ? "⚠️ degraded（P1 缺失）" : "无"} |`,
    `| 修补缓存 | ${fields.patchedCache ? `已有：${fields.patchedCache}` : "无"} |`,
    "",
  ];
  if (fields.exploitMatches && fields.exploitMatches.length > 0) {
    lines.push("**临时 Root 适用性（内核能力/漏洞匹配）**", ...fields.exploitMatches.map((m) => `- \`${m.id}\`（${m.kind}）：${m.title}`), "");
  }
  if ((fields.basebandStatus === null || fields.basebandStatus === undefined) && fields.protocol !== "none") {
    lines.push("> ⚠️ 基带未知/为空：如需救砖（IMEI/基带恢复），走 `android_plan_utility { scenario: \"unbrick_qcn\" }`。", "");
  }
  if (fields.failedP0.length > 0) {
    lines.push(`**P0 读取失败**：${fields.failedP0.join("、")}（先解决再计划写入流程）`, "");
  }
  if (fields.protocol === "none") {
    lines.push("> 未检测到设备：检查 USB 连接/驱动/授权弹窗，或设备未在 adb/fastboot 模式。", "");
    // v4 五：彻底失联 → 盲操时序库
    const model = typeof fields.deviceModel === "string" ? fields.deviceModel : null;
    lines.push("", "### 硬件盲操时序（设备失联时的物理按键指引）", "", "| 操作 | 时序 |", "|---|---|", ...blindSequenceTable(model), "");
  }
  return lines.join("\n");
}

export function renderPlanMd(plan: Plan, header: string): string {
  const rows = plan.steps.map((s, i) =>
    `| ${i + 1} | \`${s.id}\` | ${s.operation} | ${riskStars(s.calibratedRiskScore)} ${s.calibratedRiskScore.toFixed(2)} | ${fmtMs(s.estimatedDurationMs)} | ${s.barrier === "exclusive" ? "🔒 独占" : "—"} | ${s.failureBranches[0] ?? "—"} |`,
  );
  const p50 = fmtMs(plan.estimate.p50Ms);
  const p90 = fmtMs(plan.estimate.p90Ms);
  const lines: string[] = [
    `### ${header}（planId: \`${plan.planId.slice(0, 8)}…\`）`,
    "",
    `**估算**：P50 ${p50} / P90 ${p90}（来源：${plan.estimateSource === "history" ? "capability-map 历史" : "默认兜底"}）`,
    `**全流程**：${plan.estimateWallClock}`,
    "",
    "| # | 步骤 | 操作 | 风险 | 预计耗时 | 屏障 | 关键失败分支 |",
    "|---|------|------|------|----------|------|--------------|",
    ...rows,
    "",
    `**依赖顺序**：${plan.steps.map((s) => s.id).join(" → ")}`,
  ];
  const phys = plan.steps.filter((s) => s.physicalOps && s.physicalOps.length > 0);
  if (phys.length > 0) {
    lines.push("", "**必须的物理按键操作**", ...phys.flatMap((s) => (s.physicalOps ?? []).map((p) => `- \`${s.id}\`：${p}`)));
  }
  if (plan.notes.length > 0) {
    lines.push("", "**说明与风险提示**", ...plan.notes.map((n) => `- ${n}`));
  }
  lines.push(
    "",
    "> 📋 **请人工审阅以上步骤与风险。** 确认后调用 `android_execute_step`（首次调用必须携带 `confirmPlan: true`）。",
    "> 每一步都会先过护栏；被拦截的步骤会返回 `require_user_approval: true` 并给出手动引导。",
  );
  return lines.join("\n");
}

export function renderGuideMd(g: ManualGuide): string {
  const lines: string[] = [];
  if (g.preconditions.length > 0) lines.push("**前置条件**", ...g.preconditions.map((s) => `- ${s}`), "");
  if (g.steps.length > 0) lines.push("**手动步骤**", ...g.steps.map((s, i) => `${i + 1}. ${s}`), "");
  if (g.risks.length > 0) lines.push("**风险报告**", ...g.risks.map((s) => `- ⚠️ ${s}`), "");
  if (g.warnings.length > 0) lines.push("**警告**", ...g.warnings.map((s) => `- ❗ ${s}`), "");
  return lines.join("\n");
}

export function renderDenialMd(res: StepResult, guide: ManualGuide | undefined, token: unknown): string {
  const verdictLabel = res.error_code === "deny_with_override" ? "deny_with_override（可回传令牌放行）" : "deny_auto（仅手动引导）";
  const head = (res.message ?? "").split("\n")[0] ?? "操作被护栏拦截";
  const lines: string[] = [
    `> ⚠️ **【高风险拦截 · ${verdictLabel}】**`,
    ">",
    `> ${head.replace(/^【高风险拦截】/, "").trim() || "检测到危险操作，已被三级护栏拦截。"}`,
    "",
  ];
  if (guide) lines.push(renderGuideMd(guide));
  lines.push("**恢复路径**", "");
  if (res.error_code === "deny_auto") {
    lines.push(
      "- 人工按上述引导执行完成后，调用 `android_execute_step` 传 `acknowledgeDeny: true` 以继续（可重试本步骤或指定下一步骤）",
    );
  } else {
    lines.push(
      "- 确认理解上述风险后，把下方一次性令牌原样传入 `android_execute_step` 的 `overrideToken` 参数重试本步骤（5 分钟内有效，单次使用）",
    );
  }
  if (token) {
    lines.push("", "**Override Token**", "", "```json", JSON.stringify(token, null, 2), "```");
  }
  lines.push("", "⛔ **在未获用户确认前，不要再次调用 `android_execute_step` 自动推进。**");
  return lines.join("\n");
}

export function renderStepResultMd(res: StepResult, completed: string[], total: number, nextStepHint: string | null): string {
  const icon = res.status === "success" ? "✅" : res.status === "failed" ? "❌" : "🚫";
  const lines: string[] = [
    `${icon} **${res.step} — ${res.status === "success" ? "完成" : res.status === "failed" ? "失败" : "被拦截"}**`,
    "",
    `| 项 | 值 |`,
    `|---|---|`,
    `| 状态 | ${res.status}${res.error_code ? `（${res.error_code}）` : ""} |`,
    `| 风险分 | ${res.risk_score.toFixed(2)} |`,
    `| pre-snapshot | ${res.pre_snapshot_hash ? res.pre_snapshot_hash.slice(0, 12) + "…" : "—"} |`,
    `| post-snapshot | ${res.post_snapshot_hash ? res.post_snapshot_hash.slice(0, 12) + "…" : "—"} |`,
    `| 剩余预估 | ${res.estimated_remaining_time ?? "—"} |`,
    "",
    `**进度**：${completed.length}/${total} 步完成${completed.length > 0 ? `（${completed.join("、")}）` : ""}`,
  ];
  if (res.message && res.error_code !== "deny_auto" && res.error_code !== "deny_with_override") {
    lines.push("", `> ${res.message.split("\n").join("\n> ")}`);
  }
  if (nextStepHint) lines.push("", `**下一步**：\`${nextStepHint}\``);
  return lines.join("\n");
}

// ───────────── 注册入口 ─────────────

export function registerDshPlugin(
  ctx: DshPluginContext,
  opts?: { stateDir?: string; cacheDir?: string; adbPath?: string; fastbootPath?: string },
): void {
  const o = new Orchestrator(opts ?? {});

  const load = async (): Promise<PluginSession> =>
    (await ctx.storage.get<PluginSession>(STATE_KEY)) ?? blankSession();
  const save = (s: PluginSession) => ctx.storage.set(STATE_KEY, s);
  const log = (m: string) => ctx.logger?.info?.(m);

  function asErrorMd(e: unknown, headline: string): DshToolResult {
    if (e instanceof OrchestratorError) {
      const md =
        e.code === "needs_clarification"
          ? `> 📋 **${headline}**\n>\n> ${e.message}\n`
          : `> 🚫 **${headline}（${e.code}）**\n>\n> ${e.message}\n`;
      return { content: md, data: { error_code: e.code, details: e.details }, require_user_approval: e.code === "needs_clarification" };
    }
    return { content: `> 🚫 **${headline}**\n>\n> ${String(e)}\n`, data: { error_code: "infeasible" } };
  }

  // v3：护栏类错误（deny_*）→ 漂亮的拦截渲染（引用块警告 + 分步引导）
  function errorToDenial(e: OrchestratorError): DshToolResult {
    const guide = (e.details as { guide?: ManualGuide }).guide ?? undefined;
    const fake: StepResult = {
      plan_id: null,
      step: "plan",
      status: "blocked",
      pre_snapshot_hash: null,
      post_snapshot_hash: null,
      next_step: null,
      risk_score: e.code === "deny_hard" ? 1.0 : 0.7,
      estimated_remaining_time: null,
      degraded: false,
      error_code: e.code,
      message: e.message,
    };
    return {
      content: renderDenialMd(fake, guide, null),
      data: { error_code: e.code, details: e.details },
      require_user_approval: e.code !== "deny_hard",
    };
  }

  // ── android_probe：只读探测，简化设备画像 ──
  ctx.tools.register({
    name: "android_probe",
    description:
      "只读探测已连接的 Android 设备，返回简化设备画像（协议/型号/buildId/槽位/snapshot 状态/tries 剩余/电量/存储健康/修补缓存）。无副作用，可随时调用。",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      try {
        const bundle = await o.probeBundle();
        const st = bundle.state;
        let patchedCache: string | null = null;
        const key = capabilityKeyFromState(st.fields);
        if (key !== "unknown::unknown") {
          const hit = await checkPatchedCache(o.cfg, key, "magisk").catch(() => null);
          if (hit) patchedCache = hit.path;
        }
        const content = renderProbeMd({
          protocol: st.protocol,
          deviceModel: st.fields.deviceModel,
          buildId: st.fields.buildId,
          deviceSerial: st.fields.deviceSerial,
          currentSlot: st.fields.currentSlot,
          snapshotUpdateStatus: st.fields.snapshotUpdateStatus,
          triesRemaining: st.fields.triesRemaining,
          batteryLevel: st.fields.batteryLevel,
          storageHealth: st.fields.storageHealth,
          kernelVersion: st.fields.kernelVersion,
          basebandStatus: st.fields.basebandStatus,
          escapePathReady: st.fields.escapePathReady,
          degraded: st.degraded,
          failedP0: st.failedP0,
          notApplicable: st.notApplicable,
          patchedCache,
          exploitMatches: matchKernelExploits(typeof st.fields.kernelVersion === "string" ? st.fields.kernelVersion : null),
        });
        log(`probe: protocol=${st.protocol} degraded=${st.degraded}`);
        return { content, data: { state: st.fields, degraded: st.degraded, failedP0: st.failedP0 } };
      } catch (e) {
        return asErrorMd(e, "探测失败");
      }
    },
  });

  // ── android_plan_root：生成 Root 计划并输出确认表 ──
  ctx.tools.register({
    name: "android_plan_root",
    description:
      "生成 Root（可选隐藏栈）执行计划：统筹资源准备（修补缓存/管理器 APK/修补 boot），输出 Markdown 计划表（P50/P90、重启次数、依赖步骤、风险分）供用户确认。不执行任何写入。",
    inputSchema: {
      type: "object",
      properties: {
        targetPath: { type: "string", description: "原始 boot.img 路径（可选：修补缓存命中时可省）" },
        hideMode: { type: "string", enum: ["basic", "strong"], default: "basic", description: "basic=仅 Root；strong=Root+Zygisk Next/PIF/DenyList 隐藏栈" },
        persistence: { type: "string", enum: ["permanent", "temporary"], default: "permanent", description: "temporary=内核漏洞/LKM 临时 Root（重启失效，无模块栈）" },
        bootloaderStatus: { type: "string", enum: ["unlocked", "locked", "unknown"], default: "unknown" },
        managerApkPath: { type: "string", description: "本地 Magisk APK（可选，提供则跳过网络下载）" },
        patchBackend: { type: "string", enum: ["auto", "adb-ondevice", "magiskboot-local", "manual"] },
      },
    },
    async execute(args) {
      const hideMode = args.hideMode === "strong" ? "strong" : "basic";
      const persistence = args.persistence === "temporary" ? "temporary" : "permanent";
      const vars = {
        root_method: "magisk" as const,
        hide_target: hideMode === "strong" && persistence === "permanent",
        bootloader_status: (args.bootloaderStatus ?? "unknown") as "unlocked" | "locked" | "unknown",
        backup_preference: "critical_only" as const,
        target_slot: "current" as const,
        vbmeta_state: "keep_avb" as const,
        bootImagePath: typeof args.targetPath === "string" && args.targetPath.length > 0 ? args.targetPath : undefined,
        managerApkPath: typeof args.managerApkPath === "string" && args.managerApkPath.length > 0 ? args.managerApkPath : undefined,
        patchBackend: args.patchBackend as "auto" | "adb-ondevice" | "magiskboot-local" | "manual" | undefined,
        rootPersistence: persistence as "temporary" | "permanent",
      };
      let plan: Plan;
      try {
        const r = await o.plan("root", vars);
        if ("status" in r) {
          if (r.status === "needs_clarification") {
            return {
              content: `> 📋 **计划无法生成：缺少变量**\n>\n> ${r.message}\n`,
              data: { missing_variables: r.missing_variables },
              require_user_approval: true,
            };
          }
          throw new OrchestratorError("infeasible", "计划返回了未展开的意图状态（不应发生）", {});
        }
        plan = r;
      } catch (e) {
        if (e instanceof OrchestratorError && e.code === "needs_clarification") {
          return asErrorMd(e, "需要补充信息");
        }
        if (e instanceof OrchestratorError && e.code === "resource_corrupted" && /boot\.img/.test(e.message)) {
          return {
            content: [
              "> 📋 **需要原始 boot.img（targetPath）**",
              ">",
              "> 未提供 boot 镜像且无修补缓存。提取方法（三选一）：",
              ">",
              "> 1. 官方 OTA 包：`payload-dumper-go -o out ota.zip` → `out/boot.img`",
              "> 2. Pixel 类：`fastboot fetch boot boot.img`",
              "> 3. 已 root：`adb exec-out su -c cat /dev/block/bootdevice/by-name/boot > boot.img`",
              ">",
              "> 拿到后重新调用 `android_plan_root { targetPath: \"./boot.img\" }`。",
            ].join("\n"),
            data: { error_code: "needs_clarification" },
            require_user_approval: true,
          };
        }
        return asErrorMd(e, "计划生成失败");
      }
      const s = await load();
      s.planId = plan.planId;
      s.stepIds = plan.steps.map((x) => x.id);
      s.planApproved = false;
      s.completedSteps = [];
      s.awaitingApproval = null;
      s.hideMode = hideMode;
      s.scenario = `root(${persistence})`;
      await save(s);
      return {
        content: renderPlanMd(plan, `Root 计划已生成（hideMode: ${hideMode}，persistence: ${persistence}）`),
        data: {
          planId: plan.planId,
          stepCount: plan.steps.length,
          estimate: plan.estimate,
          estimateSource: plan.estimateSource,
          estimateWallClock: plan.estimateWallClock,
          approved: false,
        },
      };
    },
  });

  // ── android_plan_utility（v3）：非标准 Root 的复杂场景编排 ──
  ctx.tools.register({
    name: "android_plan_utility",
    description:
      "复杂玩机场景编排：ota_keep_root（A/B OTA 保 Root）、fake_relock（伪回锁，三星硬拒）、cross_region_flash（跨区+基带保护）、no_recovery_rescue（无 Rec 救砖）、gaming_tune（性能调优）、privacy_modules（LSPosed/去广告）、data_rescue（微信数据抢救）、advanced_hide（NoMount/Hybrid Mount）、rootless（Shizuku/DSU）、unbrick_qcn（9008 QCN 救砖，需本机 QCN）、downgrade_rom（降级，intent-spec 候选 + ARB 硬拦截）。输出 Markdown 计划表（P50/P90、重启次数、物理按键、风险星级）。",
    inputSchema: {
      type: "object",
      properties: {
        scenario: { type: "string", enum: UTILITY_SCENARIOS as unknown as string[] },
        versionQuery: { type: "string", description: "降级意图描述（如“打游戏不发热的版本”）→ 返回候选表二次选择" },
        targetVersion: { type: "string", description: "intent-spec 候选 id（如 miui-12.5.8）" },
        targetPatchLevel: { type: "string", description: "目标安全补丁级别（YYYY-MM-DD）" },
        region: { type: "string", description: "目标固件区域码" },
        backupManifestPath: { type: "string" },
        rescueImgPath: { type: "string", description: "无 Rec 救砖：临时 recovery 镜像路径" },
        rescueImgSha: { type: "string" },
        mode: { type: "string", description: "子模式：rooted/rootless/temp_boot/disable_modules" },
        prefer: { type: "string", enum: ["shizuku", "dsu"] },
        profile: { type: "string", enum: ["performance", "balanced"] },
        stack: { type: "string", enum: ["nomount", "hybrid"] },
        moduleZipPath: { type: "string" },
        modulesJson: { type: "string", description: "disable_module 的模块 id（或 all）" },
        patchesJson: { type: "string", description: "build.prop 补丁 [{name,value}] JSON" },
        qcnPath: { type: "string", description: "本机 QCN 备份路径（救砖强制）" },
        devinfoImagePath: { type: "string", description: "伪回锁 devinfo/lk 伪装镜像" },
        devinfoSha: { type: "string" },
        deviceSerial: { type: "string", description: "显式目标 serial 校验（多设备防呆）" },
      },
      required: ["scenario"],
    },
    async execute(args) {
      const scenario = String(args.scenario ?? "") as UtilityScenario;
      const vars: UtilityVars = {
        versionQuery: typeof args.versionQuery === "string" ? args.versionQuery : undefined,
        targetVersion: typeof args.targetVersion === "string" ? args.targetVersion : undefined,
        targetPatchLevel: typeof args.targetPatchLevel === "string" ? args.targetPatchLevel : undefined,
        region: typeof args.region === "string" ? args.region : undefined,
        backupManifestPath: typeof args.backupManifestPath === "string" ? args.backupManifestPath : undefined,
        rescueImgPath: typeof args.rescueImgPath === "string" ? args.rescueImgPath : undefined,
        rescueImgSha: typeof args.rescueImgSha === "string" ? args.rescueImgSha : undefined,
        mode: typeof args.mode === "string" ? args.mode : undefined,
        prefer: typeof args.prefer === "string" ? args.prefer : undefined,
        profile: typeof args.profile === "string" ? args.profile : undefined,
        stack: typeof args.stack === "string" ? args.stack : undefined,
        moduleZipPath: typeof args.moduleZipPath === "string" ? args.moduleZipPath : undefined,
        modulesJson: typeof args.modulesJson === "string" ? args.modulesJson : undefined,
        patchesJson: typeof args.patchesJson === "string" ? args.patchesJson : undefined,
        qcnPath: typeof args.qcnPath === "string" ? args.qcnPath : undefined,
        devinfoImagePath: typeof args.devinfoImagePath === "string" ? args.devinfoImagePath : undefined,
        devinfoSha: typeof args.devinfoSha === "string" ? args.devinfoSha : undefined,
        deviceSerial: typeof args.deviceSerial === "string" ? args.deviceSerial : undefined,
      };

      // 一：意图澄清——"忘了版本号"先出候选表，确认后再继续
      if (scenario === "downgrade_rom" && !vars.targetVersion && !vars.targetPatchLevel && vars.versionQuery) {
        const candidates = matchDowngradeCandidates(vars.versionQuery);
        if (candidates.length === 0) {
          return {
            content: `> 📋 **特征库无匹配候选**：换一下描述（如“省电养老”“流畅游戏”），或直接指定 targetPatchLevel。`,
            data: { error_code: "needs_clarification", candidates: [] },
            require_user_approval: true,
          };
        }
        const rows = candidates.map((c, i) =>
          `| ${i + 1} | \`${c.id}\` | ${c.family} | ${c.label} | Android ${c.androidBase} | ${c.securityPatch} | ${c.score} | ${c.notes} |`,
        );
        return {
          content: [
            "### 版本候选（intent-spec 特征库匹配）",
            "",
            "| # | 候选 | 家族 | 版本 | 安卓底层 | 补丁级别 | 匹配分 | 备注 |",
            "|---|------|------|------|----------|----------|--------|------|",
            ...rows,
            "",
            "> 📋 **请用户选择候选。** 确认后调用 `android_plan_utility { scenario: \"downgrade_rom\", targetVersion: \"<候选id>\" }` 继续；",
            "> 降级计划生成时会自动比对安全补丁级别，触发 ARB 熔断风险将被 deny_hard 硬拦截。",
          ].join("\n"),
          data: { error_code: "needs_clarification", candidates },
          require_user_approval: true,
        };
      }

      let plan: Plan;
      try {
        plan = await o.planUtility(scenario, vars);
      } catch (e) {
        if (e instanceof OrchestratorError) {
          if (e.code === "deny_auto" || e.code === "deny_hard" || e.code === "deny_with_override") {
            return errorToDenial(e);
          }
          if (scenario === "downgrade_rom" && e.code === "needs_clarification") {
            return asErrorMd(e, "需要指定目标版本");
          }
        }
        return asErrorMd(e, "场景计划生成失败");
      }
      const s = await load();
      s.planId = plan.planId;
      s.stepIds = plan.steps.map((x) => x.id);
      s.planApproved = false;
      s.completedSteps = [];
      s.awaitingApproval = null;
      s.scenario = scenario;
      await save(s);
      return {
        content: renderPlanMd(plan, `场景计划已生成（${scenario}）`),
        data: {
          planId: plan.planId,
          scenario,
          stepCount: plan.steps.length,
          estimateWallClock: plan.estimateWallClock,
          approved: false,
        },
      };
    },
  });

  // ── android_execute_step：确认后单步执行 ──
  ctx.tools.register({
    name: "android_execute_step",
    description:
      "单步执行已确认的 Root 计划。首次调用必须携带 confirmPlan: true（用户确认后）。被护栏拦截时返回 require_user_approval + 手动引导；deny_with_override 时回传 overrideToken 重试。结果为结构化状态。",
    inputSchema: {
      type: "object",
      properties: {
        stepId: { type: "string", description: "计划内的步骤 ID（如 s6_flash_boot）" },
        confirmPlan: { type: "boolean", description: "首次执行：用户已确认计划后携带 true" },
        overrideToken: { type: "object", description: "deny_with_override 拦截后回传的一次性令牌（JSON 原样）" },
        acknowledgeDeny: { type: "boolean", description: "deny_auto 引导人工执行完毕后的确认" },
        abortPlan: { type: "boolean", description: "中止当前计划（审计日志保留）" },
      },
      required: ["stepId"],
    },
    async execute(args) {
      const s = await load();

      if (args.abortPlan === true) {
        await save(blankSession());
        return { content: "🗑️ **计划已中止。** 审计日志保留（stateDir/audit.jsonl），pendingStep 校验逻辑不受影响。", data: { aborted: true } };
      }

      if (!s.planId) {
        return {
          content: "> 📋 **尚无已生成的计划。** 先调用 `android_plan_root` 生成并确认计划，再单步执行。",
          data: { error_code: "needs_clarification" },
        };
      }

      // 待审批状态：阻断自动推进（P3 审批闸门）
      if (s.awaitingApproval) {
        const a = s.awaitingApproval;
        if (a.verdict === "deny_auto") {
          if (args.acknowledgeDeny !== true) {
            return {
              content: [
                `> ⛔ **步骤 \`${a.stepId}\` 此前被 deny_auto 拦截，等待人工处理确认。**`,
                "",
                a.guideMd,
                "",
                "人工按引导执行完毕后，调用 `android_execute_step` 传 `acknowledgeDeny: true` 继续。",
                "⛔ 未获用户确认前不要自动重试。",
              ].join("\n"),
              data: { awaiting: a.stepId, verdict: a.verdict },
              require_user_approval: true,
            };
          }
          s.awaitingApproval = null;
          await save(s);
        } else {
          if (!args.overrideToken) {
            return {
              content: [
                `> ⛔ **步骤 \`${a.stepId}\` 此前被 deny_with_override 拦截，等待一次性令牌回传。**`,
                "",
                a.guideMd,
                "",
                a.token ? "```json\n" + JSON.stringify(a.token, null, 2) + "\n```" : "",
                "⛔ 未获用户确认前不要自动重试。",
              ].join("\n"),
              data: { awaiting: a.stepId, verdict: a.verdict, token: a.token },
              require_user_approval: true,
            };
          }
          const v = o.submitOverride(args.overrideToken as never, a.operation);
          if (!v.ok) {
            return {
              content: `> 🚫 **令牌无效：${v.reason}**。重新触发拦截步骤以生成新令牌，或人工执行引导。`,
              data: { error_code: "deny_with_override", reason: v.reason },
              require_user_approval: true,
            };
          }
          s.awaitingApproval = null;
          await save(s);
        }
      }

      // 计划确认闸门：首次执行必须显式 confirmPlan
      if (!s.planApproved) {
        if (args.confirmPlan !== true) {
          return {
            content: [
              "> 📋 **计划尚未确认。** 请把上一次 `android_plan_root` 输出的计划表转给用户审阅；",
              "> 用户确认后，调用 `android_execute_step { stepId, confirmPlan: true }` 开始执行。",
              "⛔ 不要代替用户确认。",
            ].join("\n"),
            data: { planId: s.planId, approved: false },
            require_user_approval: true,
          };
        }
        s.planApproved = true;
        await save(s);
      }

      const stepId = String(args.stepId ?? "");
      let res: StepResult;
      try {
        res = await o.executeStep(s.planId, stepId);
        // 进程重启后计划内存丢失 → 尝试会话恢复后重试一次
        if ((res.message ?? "").includes("计划不存在")) {
          await o.recover();
          res = await o.executeStep(s.planId, stepId);
        }
      } catch (e) {
        // 恢复校验失败（pendingStep 快照不一致）→ 手动验证指引
        return asErrorMd(e, "执行前会话校验失败");
      }

      const denied = res.status === "blocked" && (res.error_code === "deny_auto" || res.error_code === "deny_with_override");
      if (denied) {
        let token: unknown = null;
        if (res.error_code === "deny_with_override") {
          const g = o.generateOverride(res.step);
          token = g.token;
        }
        s.awaitingApproval = {
          stepId,
          operation: res.step,
          verdict: res.error_code as "deny_auto" | "deny_with_override",
          token,
          guideMd: res.guide ? renderGuideMd(res.guide) : "",
        };
        await save(s);
        return {
          content: renderDenialMd(res, res.guide, token),
          data: { ...res, require_user_approval: true, token },
          require_user_approval: true,
        };
      }

      if (res.status === "success") {
        s.completedSteps.push(stepId);
        s.awaitingApproval = null;
        await save(s);
      }
      const idx = s.stepIds.indexOf(stepId);
      const next = idx >= 0 && idx + 1 < s.stepIds.length ? s.stepIds[idx + 1] : null;
      return {
        content: renderStepResultMd(res, s.completedSteps, s.stepIds.length, next),
        data: { ...res, progress: { completed: s.completedSteps, total: s.stepIds.length } },
      };
    },
  });

  ctx.logger?.info?.("android-playground-orchestrator v3 已注册 4 个工具：android_probe / android_plan_root / android_plan_utility / android_execute_step");
}
