// Orchestrator 门面（v3）：+ planUtility 场景路由 / deviceSerial 防呆 / 场景步骤执行器
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AuditLog, GENESIS } from "./audit.js";
import { verifyAvbChain } from "./avb.js";
import { capabilityKeyFromState, estimateFromHistory, recordSample } from "./capability-map.js";
import { OrchestratorConfig, resolveConfig } from "./config.js";
import { loadContext, recoverSession, saveContext } from "./context.js";
import { isSecureMethod, validateBackupManifest } from "./erase.js";
import { OrchestratorError, ErrorCode } from "./errors.js";
import { ScriptExecutor, ScriptApi } from "./executor.js";
import { flashImage, flashPrecheck } from "./flash.js";
import { sha256Buf } from "./hash.js";
import { evaluate, formatIntercept } from "./guardrails.js";
import type { GuardContext } from "./guardrails.js";
import { matchKernelExploits } from "./exploit-registry.js";
import { Barrier } from "./lock.js";
import { generateToken, verifyToken } from "./override-token.js";
import { assertPhysicalHardStops, LARGE_WRITE_PARTITIONS } from "./physical.js";
import { assertP0, probeDevice } from "./probe.js";
import { ClarifyResult, expandIntent, generatePlan, Intent, IntentVariables } from "./planner.js";
import { resolveResource } from "./resources.js";
import { prepareRootResources, PatchBackend, PreparedRootResources } from "./root-prep.js";
import { buildUtilityPlan, checkSerialMatch, findHideConflicts, UtilityScenario, UtilityVars } from "./scenarios.js";
import { uiConfirm, NodeMatcher } from "./ui-auto.js";
import { diagnoseUsb } from "./usb-diag.js";
import { captureSnapshot, deviceHashOf, snapshotHash } from "./snapshot.js";
import { run } from "./exec.js";
import { AuditEvent, DeviceContext, DeviceState, ErasePartitionRequest, ExecuteScriptRequest, FlashPartitionRequest, ManualGuide, OverrideToken, Plan, PlanEstimate, PlanStep, ProbeDeviceRequest, Priority, ResourceResolverRequest, Slot, Snapshot, StepResult, AuditLogRequest } from "./types.js";

function minutesFmt(ms: number): string {
  return `${(ms / 60000).toFixed(1)}min`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function stepResult(step: string, status: StepResult["status"], o: {
  planId?: string | null;
  preHash?: string | null;
  postHash?: string | null;
  nextStep?: string | null;
  riskScore?: number;
  remainingMs?: number | null;
  degraded?: boolean;
  errorCode?: ErrorCode | null;
  message?: string;
  guide?: ManualGuide;
  details?: Record<string, unknown>;
}): StepResult {
  return {
    plan_id: o.planId ?? null,
    step,
    status,
    pre_snapshot_hash: o.preHash ?? null,
    post_snapshot_hash: o.postHash ?? null,
    next_step: o.nextStep ?? null,
    risk_score: o.riskScore ?? 0,
    estimated_remaining_time: o.remainingMs != null ? minutesFmt(o.remainingMs) : null,
    degraded: o.degraded ?? false,
    error_code: o.errorCode ?? null,
    ...(o.message ? { message: o.message } : {}),
    ...(o.guide ? { guide: o.guide } : {}),
    ...(o.details ? { details: o.details } : {}),
  };
}

export interface RecoveryReport {
  planId: string | null;
  resumedFrom: string | null;     // 无挂起步骤时为最近完成操作；有挂起且校验通过时为挂起操作
  eventCount: number;
  interrupted: boolean;           // 检测到崩在中途的 step
  pendingStep: { operation: string; stepId: string; preSnapshotHash: string; startedAt: number } | null;
  verified: boolean;              // 设备快照与 pre-snapshot 一致（可安全续跑）
}

export class Orchestrator {
  readonly cfg: OrchestratorConfig;
  private readonly barrier = new Barrier();
  private readonly audit: AuditLog;
  private headHash: string = GENESIS;
  private context: DeviceContext | null = null;
  private readonly plans = new Map<string, Plan>();
  private readonly planRuns = new Map<string, number>(); // planId → 全流程开始时间（capability 采样用）
  private readonly baselineStore = new Map<string, { moduleListHash: string; at: number }>(); // P2：模块安装前 baseline 差分
  private readonly scratch = new Map<string, string>(); // v3：步骤间传值（如 OTA 修补产物 sha）
  private boundSerial: string | null = null; // v3：多设备防呆
  private fastbootTimeoutStreak = 0; // v4 四：fastboot 连续超时计数 → USB 探针
  private readonly prefetchDone = new Set<string>(); // v4 二：流水线预取去重
  private readonly usedTokenIds = new Set<string>();
  private readonly executor: ScriptExecutor;

  constructor(partial: Partial<OrchestratorConfig> = {}) {
    this.cfg = resolveConfig(partial);
    this.audit = new AuditLog(path.join(this.cfg.stateDir, "audit.jsonl"));
    this.headHash = this.audit.load().headHash;
    const loaded = loadContext(this.cfg.stateDir);
    if (loaded) {
      this.context = loaded;
      this.boundSerial = loaded.boundSerial ?? null;
    }
    this.executor = new ScriptExecutor(this.buildScriptApi());
  }

  // ───────────────────────── 只读工具 ─────────────────────────

  // probe_device：只读，可并发。内部单次批量采集（adb 一条 shell / fastboot 一条 getvar all）
  async probe(fields: string[] = ["all"], priority: Priority = 0): Promise<DeviceState> {
    return probeDevice(this.cfg, { fields, priority });
  }

  // resource_resolver：requireSHA256 强制为 true（5.3）
  async resolveResource(query: string, sources: ResourceResolverRequest["sources"] = ["github"], requireSHA256 = true) {
    return resolveResource(this.cfg, { query, sources, requireSHA256 });
  }

  // 5.1 PTC（P1 收紧）：一次批量探测（内部单 spawn 拿全字段）+ 资源预取并发；健康数据从同一次探测派生
  async probeBundle() {
    const [state, magisk, vbmetaPatch] = await Promise.all([
      probeDevice(this.cfg, { fields: ["all"], priority: 2 }),
      resolveResource(this.cfg, { query: "magisk", sources: ["github"], requireSHA256: true }).catch((e) => ({ error: String(e) })),
      resolveResource(this.cfg, { query: "vbmeta_patch", sources: ["github", "mirror"], requireSHA256: true }).catch((e) => ({ error: String(e) })),
    ]);
    return {
      state,
      magisk,
      vbmetaPatch,
      health: {
        storageHealth: state.fields.storageHealth ?? null,
        batteryLevel: state.fields.batteryLevel ?? null,
        deviceModel: state.fields.deviceModel ?? null,
        buildId: state.fields.buildId ?? null,
      },
    };
  }

  // ───────────────────────── 意图与计划 ─────────────────────────

  // 3.1 意图展开硬门控
  clarify(intent: Intent, vars: IntentVariables): ClarifyResult {
    return expandIntent(intent, vars);
  }

  // 3.2/3.3 计划生成：估算优先查 capability-map；P2：物理硬阻断 + root 资源统筹
  async plan(intent: Intent, vars: IntentVariables): Promise<Plan | ClarifyResult> {
    const c = expandIntent(intent, vars);
    if (c.status === "needs_clarification") return c;
    const state = await probeDevice(this.cfg, { fields: ["all"], priority: 2 });
    assertP0(state, ["protocol", "currentSlot"]);
    assertPhysicalHardStops(state); // 电量 <20% / 存储健康 warning+ → infeasible（进入 fastboot/EDL/写入前）
    const cacheHit = this.hasCachedResources(intent);
    const mode: "exploration" | "accelerated" = cacheHit ? "accelerated" : "exploration";
    // 估算意图映射：root 计划查 root 全流程样本；flash_rom 计划查 flash 单次刷写样本
    const estimateIntent = intent === "flash_rom" ? "flash" : intent;
    const estimate: PlanEstimate | undefined =
      estimateFromHistory(this.cfg.stateDir, capabilityKeyFromState(state.fields), estimateIntent, mode) ?? undefined;
    const p = generatePlan({ intent, vars, state, cacheHit, estimate });

    // P2：root 计划 → 统筹资源准备（缓存/下载/修补），修补镜像直接写进 flash 步骤参数
    if (intent === "root") {
      const prep = await this.prepareRootResources({
        rootMethod: (vars.root_method ?? "magisk") as "magisk" | "kernelsu" | "apatch",
        bootImagePath: vars.bootImagePath,
        managerApkPath: vars.managerApkPath,
        backend: vars.patchBackend,
        state,
      });
      const flashStep = p.steps.find((s) => s.operation === "flash_boot");
      if (flashStep && prep.patchedBoot) {
        flashStep.params.imagePath = prep.patchedBoot.path;
        flashStep.params.verifySHA256 = prep.patchedBoot.sha256;
      }
      if (!prep.patchedBoot) {
        p.notes.push(`修补后镜像未就绪（backend=${prep.backend}）：先按下方资源准备说明完成修补，再执行 flash_boot 步骤`);
      }
      p.notes.push(`管理器 APK：${prep.managerApk.path}（sha256 ${prep.managerApk.sha256.slice(0, 12)}…${prep.managerApk.fromCache ? "，缓存命中" : "，刚下载"}）`);
      if (prep.originalBoot) {
        p.notes.push(`原始 boot.img：${prep.originalBoot.path}（sha256 ${prep.originalBoot.sha256.slice(0, 12)}…）`);
      }
      p.notes.push(...prep.notes.map((n) => `[资源准备] ${n}`));
    }

    this.plans.set(p.planId, p);
    const deviceHash = deviceHashOf(state.fields);
    this.persistContext(deviceHash, this.headHash);
    if (this.context) {
      this.context.planId = p.planId;
      saveContext(this.cfg.stateDir, this.context);
    }
    return p;
  }

  // P2：prepareRootResources —— 缓存检查 → 管理器 APK 拉取（SHA256 强制）→ 修补 → 产物入缓存
  async prepareRootResources(opts?: {
    rootMethod?: "magisk" | "kernelsu" | "apatch";
    bootImagePath?: string;
    managerApkPath?: string; // 提供 → 跳过网络下载
    backend?: PatchBackend | "auto";
    abi?: string;
    state?: DeviceState;
  }): Promise<PreparedRootResources> {
    const state = opts?.state ?? (await probeDevice(this.cfg, { fields: ["all"], priority: 2 }));
    const rawKey = capabilityKeyFromState(state.fields);
    const deviceKey = rawKey === "unknown::unknown" ? "generic" : rawKey;
    const bootImagePath = opts?.bootImagePath;
    if (!bootImagePath) {
      throw new OrchestratorError("needs_clarification", "缺少原始 boot.img：通过 opts.bootImagePath 提供（提取方法见 README「真机测试指引」）", {});
    }
    return prepareRootResources(this.cfg, {
      rootMethod: opts?.rootMethod ?? "magisk",
      deviceKey,
      bootImagePath,
      managerApkPath: opts?.managerApkPath,
      backend: opts?.backend,
      abi: opts?.abi,
      state,
      resolveManager: async (query) => {
        const r = await resolveResource(this.cfg, { query, sources: ["github"], requireSHA256: true });
        return { cachePath: r.cachePath, sha256: r.sha256, fromCache: r.fromCache };
      },
    });
  }

  private hasCachedResources(intent: Intent): boolean {
    if (intent === "root") {
      return existsSync(path.join(this.cfg.cacheDir, "magisk.res.json"));
    }
    return false;
  }

  // ── v3：多设备防呆 ──
  private bindSerialFrom(state: DeviceState): void {
    const ser = state.fields.deviceSerial;
    if (typeof ser === "string" && ser.length > 0) this.boundSerial = ser;
  }

  private assertTarget(state: DeviceState): void {
    checkSerialMatch(this.boundSerial, typeof state.fields.deviceSerial === "string" ? state.fields.deviceSerial : null);
  }

  // 需要写设备的场景步骤：先探测 + 校验 serial 一致
  private async assertTargetLive(): Promise<DeviceState> {
    const st = await probeDevice(this.cfg, { fields: ["all"], priority: 1 });
    this.assertTarget(st);
    return st;
  }

  // ── v3：场景路由（android_plan_utility 后端） ──
  async planUtility(scenario: UtilityScenario, vars: UtilityVars): Promise<Plan> {
    const state = await probeDevice(this.cfg, { fields: ["all"], priority: 2 });
    assertP0(state, ["protocol"]);
    if (state.protocol === "none") {
      throw new OrchestratorError("infeasible", "未检测到设备：adb 与 fastboot 均无响应", {});
    }
    assertPhysicalHardStops(state);
    this.bindSerialFrom(state);
    checkSerialMatch(this.boundSerial, vars.deviceSerial ?? null); // 显式传入 serial 也必须一致
    const p = buildUtilityPlan(scenario, vars, state);
    this.plans.set(p.planId, p);
    const deviceHash = deviceHashOf(state.fields);
    this.persistContext(deviceHash, this.headHash);
    if (this.context) {
      this.context.planId = p.planId;
      this.context.boundSerial = this.boundSerial;
      saveContext(this.cfg.stateDir, this.context);
    }
    return p;
  }

  // 计划步执行路由（8.2 恢复后可按 planId 续跑）
  async executeStep(planId: string, stepId: string): Promise<StepResult> {
    const plan = this.plans.get(planId);
    if (!plan) {
      return stepResult("execute_step", "blocked", {
        errorCode: "needs_clarification",
        message: `计划 ${planId} 不存在：本进程内未生成，或进程重启后需先调用 recover()`,
      });
    }
    const idx = plan.steps.findIndex((s) => s.id === stepId);
    if (idx < 0) {
      return stepResult("execute_step", "blocked", {
        errorCode: "needs_clarification",
        message: `步骤 ${stepId} 不在计划 ${planId} 中`,
      });
    }
    const step = plan.steps[idx];
    const remainingMs = plan.steps.slice(idx + 1).reduce((a, s) => a + s.estimatedDurationMs, 0);
    if (!this.planRuns.has(planId)) this.planRuns.set(planId, Date.now());
    this.prefetchAsync(planId, idx); // v4 二：执行本步的同时后台预取后续资源

    let res: StepResult;
    switch (step.operation) {
      case "flash_boot":
        res = await this.flash({
          partition: "boot",
          imagePath: String(step.params.imagePath ?? ""),
          verifySHA256: String(step.params.verifySHA256 ?? ""),
          slot: (step.params.target_slot as Slot | undefined) ?? "current",
          sparseHandling: "auto",
        });
        break;
      case "flash_vbmeta_patch":
        res = await this.flashVbmeta({
          imagePath: String(step.params.imagePath ?? ""),
          verifySHA256: String(step.params.verifySHA256 ?? ""),
          disableVerity: step.params.disableVerity === true,
          disableVerification: step.params.disableVerification === true,
          subImages: (step.params.subImages as unknown as Record<string, string> | undefined) ?? {},
        });
        break;
      case "probe_bundle":
      case "probe_protocol": {
        const bundle = await this.probeBundle();
        res = stepResult(step.operation, "success", { planId, riskScore: 0, details: { bundle } });
        break;
      }
      case "resolve_resources": {
        const r = await this.resolveResource("magisk").catch((e) => ({ error: String(e) }));
        res = stepResult(step.operation, "success", { planId, riskScore: 0.05, details: { magisk: r } });
        break;
      }
      case "final_probe":
      case "reboot_verify": {
        const st = await probeDevice(this.cfg, { fields: ["all"], priority: 2 });
        // v4 四：刷机收尾——fstrim 保养闪存（adb 可用时 best-effort）
        let trimResult: string | null = null;
        if (st.protocol === "adb") {
          trimResult = await this.adbShellChecked("su -c fstrim -v /data", 30000)
            ?? await this.adbShellChecked("fstrim -v /data", 30000);
        }
        // root 全流程完成 → 记录 capability 样本（真实耗时 + 成功率）
        let recorded = false;
        if (plan.intent === "root" && step.operation === "final_probe" && this.planRuns.has(planId)) {
          const startedAt = this.planRuns.get(planId)!;
          const key = capabilityKeyFromState(st.fields);
          if (key !== "unknown::unknown") {
            recordSample(this.cfg.stateDir, key, {
              intent: "root",
              durationMs: Date.now() - startedAt,
              success: st.protocol !== "none",
              mode: plan.mode,
              timestamp: Date.now(),
            });
            recorded = true;
          }
          this.planRuns.delete(planId);
        }
        res = stepResult(step.operation, "success", {
          planId,
          riskScore: 0.05,
          details: { state: st.fields, capabilityRecorded: recorded, fstrim: trimResult ?? "skipped(非 adb 模式)" },
        });
        break;
      }
      case "reboot":
        res = await this.deviceReboot(planId);
        break;
      case "verify_root": {
        const uid = await this.adbShellChecked("su -c id -u", 10000);
        if (uid === "0") {
          const ver = await this.adbShellChecked("su -c magisk -v", 10000);
          res = stepResult("verify_root", "success", { planId, riskScore: 0.1, details: { uid: 0, magiskVersion: ver ?? null } });
        } else {
          res = stepResult("verify_root", "blocked", {
            planId,
            riskScore: 0.1,
            errorCode: "needs_clarification",
            message: `root 未生效：su -c id -u 返回「${uid ?? "无输出"}」。检查 Magisk 安装与重启；${step.failureBranches.join("；")}`,
          });
        }
        break;
      }
      case "module_baseline": {
        // P2：模块安装前 baseline 差分（模块列表 + 指纹哈希落审计）
        const module = String(step.params.module ?? "?");
        const list = await this.adbShellChecked("su -c ls /data/adb/modules 2>/dev/null", 10000);
        const fp = await this.adbShellChecked("getprop ro.build.fingerprint", 10000);
        const moduleListHash = createHash("sha256").update(`${list ?? ""}|${fp ?? ""}`).digest("hex");
        this.baselineStore.set(module, { moduleListHash, at: Date.now() });
        const evt = this.appendAudit(`module_baseline:${module}`, "n/a", "n/a", 0.05);
        res = stepResult("module_baseline", "success", {
          planId,
          riskScore: 0.05,
          postHash: evt.currentEventHash,
          details: { module, moduleListHash, fingerprint: fp ?? null },
        });
        break;
      }
      case "install_module": {
        const module = String(step.params.module ?? "");
        const base = this.baselineStore.get(module);
        if (!base) {
          res = stepResult("install_module", "blocked", {
            planId,
            errorCode: "deny_auto",
            riskScore: 0.2,
            message: `安装模块 ${module} 前必须先执行 module_baseline 差分（P2 规范强制）：缺少差分记录，拒绝安装`,
          });
          break;
        }
        res = await this.barrier.runExclusive(async () => {
          try {
            const res0 = await resolveResource(this.cfg, { query: module, sources: ["github"], requireSHA256: true });
            if (!res0.cachePath) {
              throw new OrchestratorError("resource_corrupted", `${module} 模块包未落盘`, {});
            }
            await run(this.cfg.adbPath, ["push", res0.cachePath, "/data/local/tmp/dsh-module.zip"], this.cfg.cmdTimeoutMs * 2);
            const out = await this.adbShellChecked("su -c magisk --install-module /data/local/tmp/dsh-module.zip", 60000);
            await run(this.cfg.adbPath, ["shell", "rm -f /data/local/tmp/dsh-module.zip"], this.cfg.cmdTimeoutMs).catch(() => null);
            return stepResult("install_module", "success", {
              planId,
              riskScore: 0.2,
              details: { module, outputTail: (out ?? "").slice(-500), baselineAt: base.at, moduleSha256: res0.sha256 },
            });
          } catch (e) {
            return this.errorToStep("install_module", e, false);
          }
        });
        break;
      }
      case "configure_denylist": {
        const apps = (JSON.parse(String(step.params.apps_json ?? "[]")) as string[]) ??
          ["com.google.android.gms", "com.google.android.gms.unstable", "com.android.vending"];
        const outputs: string[] = [];
        await this.adbShellChecked("su -c magisk --denylist enable", 10000);
        outputs.push("denylist enabled");
        for (const app of apps) {
          outputs.push(await this.adbShellChecked(`su -c magisk --denylist add ${app}`, 10000) ?? `add ${app}: 无输出`);
        }
        res = stepResult("configure_denylist", "success", { planId, riskScore: 0.15, details: { apps, outputs } });
        break;
      }
      case "verify_integrity": {
        const pif = await this.adbShellChecked("su -c ls /data/adb/modules | grep -iE 'playintegrity|fix'", 10000);
        res = stepResult("verify_integrity", "success", {
          planId,
          riskScore: 0.1,
          details: {
            pifModulePresent: !!pif,
            howToVerify: [
              "在设备上安装 Play Integrity 检测器（SPIC / MiniPhone 等）",
              "确认 MEETS_DEVICE_INTEGRITY 通过",
              `失败分支：${step.failureBranches.join("；")}`,
            ],
          },
        });
        break;
      }
      case "flash_devinfo":
        res = await this.flash({ partition: "devinfo", imagePath: String(step.params.imagePath ?? ""), verifySHA256: String(step.params.verifySHA256 ?? ""), sparseHandling: "auto" });
        break;
      case "backup_partition": {
        const partition = String(step.params.partition ?? "");
        const r = await run(this.cfg.adbPath, ["exec-out", `su -c cat /dev/block/by-name/${partition}`], this.cfg.cmdTimeoutMs * 8).catch(() => null);
        if (!r || r.stdoutBuf.length === 0) {
          res = stepResult("backup_partition", "failed", { planId, errorCode: "infeasible", message: `dump ${partition} 失败：分区节点缺失或 su 被拒`, details: { partition } });
          break;
        }
        const serial = (this.boundSerial ?? "unknown").replace(/[^A-Za-z0-9_\-.]/g, "_");
        const dir = path.join(this.cfg.stateDir, "backups", serial);
        mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${partition}-${Date.now()}.img`);
        writeFileSync(file, r.stdoutBuf);
        const sha = sha256Buf(r.stdoutBuf);
        this.appendAudit(`backup:${partition}`, "n/a", "n/a", 0.1);
        res = stepResult("backup_partition", "success", { planId, riskScore: 0.1, postHash: sha.slice(0, 16), details: { partition, file, sha256: sha, bytes: r.stdoutBuf.length } });
        break;
      }
      case "region_check": {
        const csc = await this.adbShellChecked("getprop ro.csc", 10000);
        const expected = String(step.params.expectedRegion ?? "");
        const mismatch = !!expected && !!csc && !csc.toLowerCase().includes(expected.toLowerCase());
        res = stepResult("region_check", "success", { planId, riskScore: 0.05, details: { deviceRegion: csc ?? null, expectedRegion: expected || null, mismatch } });
        break;
      }
      case "backup_manifest_check": {
        const ok = validateBackupManifest(String(step.params.backupManifestPath ?? "") || undefined);
        if (!ok) {
          res = stepResult("backup_manifest_check", "blocked", {
            planId, errorCode: "deny_auto", riskScore: 0.6,
            message: "【高风险拦截】基带/EFS 备份清单缺失（跨区刷机强制保护）：先完成 s3-s6 备份步骤并生成清单，或提供 backupManifestPath。系统已启用 deny_auto。",
          });
        } else {
          res = stepResult("backup_manifest_check", "success", { planId, riskScore: 0.05, details: { manifest: String(step.params.backupManifestPath ?? "") } });
        }
        break;
      }
      case "ota_dump_inactive": {
        const slot = String(step.params.slot ?? "b");
        const r = await run(this.cfg.adbPath, ["shell", `su -c dd if=/dev/block/by-name/boot_${slot} of=/data/local/tmp/ota-boot.img bs=4096`], this.cfg.cmdTimeoutMs * 4);
        if (r.code !== 0) {
          res = stepResult("ota_dump_inactive", "failed", { planId, errorCode: "infeasible", message: `dump boot_${slot} 失败：${r.stderr.slice(-300)}` });
          break;
        }
        res = stepResult("ota_dump_inactive", "success", { planId, riskScore: 0.1, details: { slot, remote: "/data/local/tmp/ota-boot.img" } });
        break;
      }
      case "ota_patch_inactive": {
        const r = await run(this.cfg.adbPath, ["shell", `su -c sh -c 'cd /data/adb/magisk && BOOTMODE=1 KEEPVERITY=false KEEPFORCEENCRYPT=false sh boot_patch.sh /data/local/tmp/ota-boot.img'`], this.cfg.cmdTimeoutMs * 6);
        const loc = await this.adbShellChecked("su -c sh -c 'ls /data/adb/magisk/new-boot.img /data/local/tmp/new-boot.img 2>/dev/null'", 10000);
        const remote = loc ? loc.split("\n")[0].trim() : null;
        const sha = remote ? await this.adbShellChecked(`su -c sha256sum ${remote}`, 10000) : null;
        if (r.code !== 0 || !remote || !sha) {
          res = stepResult("ota_patch_inactive", "failed", { planId, errorCode: "infeasible", message: "设备端修补失败：确认 /data/adb/magisk/boot_patch.sh 存在（Magisk ≥24）且 /data/local/tmp 可写", details: { stderrTail: r.stderr.slice(-500), found: remote, sha: sha?.split(/\s+/)[0] ?? null } });
          break;
        }
        this.scratch.set("ota:newboot:remote", remote);
        this.scratch.set("ota:newboot:sha", sha.split(/\s+/)[0]);
        res = stepResult("ota_patch_inactive", "success", { planId, riskScore: 0.2, details: { remote, sha256: sha.split(/\s+/)[0], outputTail: r.stdout.slice(-400) } });
        break;
      }
      case "ota_flash_inactive": {
        const slot = String(step.params.slot ?? "b");
        const remote = this.scratch.get("ota:newboot:remote");
        const expected = this.scratch.get("ota:newboot:sha");
        if (!remote || !expected) {
          res = stepResult("ota_flash_inactive", "blocked", { planId, errorCode: "deny_auto", riskScore: 0.45, message: "【高风险拦截】修补产物缺失：必须先执行 ota_patch_inactive 并通过校验，才允许写入非活动槽位。系统已启用 deny_auto。" });
          break;
        }
        res = await this.barrier.runExclusive(async () => {
          try {
            const w = await run(this.cfg.adbPath, ["shell", `su -c dd if=${remote} of=/dev/block/by-name/boot_${slot} bs=4096`], this.cfg.cmdTimeoutMs * 6);
            if (w.timedOut) throw new OrchestratorError("unknown_physical_state", "槽位写入超时：物理状态未知，禁止重试，先只读探测", { slot });
            const actual = await this.adbShellChecked(`su -c sha256sum /dev/block/by-name/boot_${slot}`, 15000);
            const actualSha = actual?.split(/\s+/)[0] ?? null;
            if (actualSha !== expected) {
              throw new OrchestratorError("unknown_physical_state", `槽位写入后 sha 不符：期望 ${expected}，实际 ${actualSha}。立即停止，不要重启`, { slot });
            }
            return stepResult("ota_flash_inactive", "success", { planId, riskScore: 0.45, details: { slot, sha256: actualSha } });
          } catch (e) {
            return this.errorToStep("ota_flash_inactive", e, false);
          }
        });
        break;
      }
      case "ota_verify_slot": {
        const expected = this.scratch.get("ota:newboot:sha") ?? null;
        res = stepResult("ota_verify_slot", "success", { planId, riskScore: 0.1, details: { patchedSha: expected, note: "以 ota_flash_inactive 的写入后校验为准；本步为计划闸位" } });
        break;
      }
      case "fastboot_boot_temp": {
        const img = String(step.params.rescueImgPath ?? "");
        if (!img || !existsSync(img)) {
          res = stepResult("fastboot_boot_temp", "failed", { planId, errorCode: "resource_corrupted", message: `临时镜像不存在：${img}` });
          break;
        }
        await this.assertTargetLive();
        res = await this.barrier.runExclusive(async () => {
          const r = await run(this.cfg.fastbootPath, ["boot", img], this.cfg.cmdTimeoutMs * 4);
          if (r.timedOut) return stepResult("fastboot_boot_temp", "blocked", { planId, errorCode: "unknown_physical_state", message: "临时引导超时：设备可能已进入 recovery，直接观察屏幕状态" });
          return stepResult("fastboot_boot_temp", "success", { planId, riskScore: 0.3, details: { outputTail: `${r.stdout}\n${r.stderr}`.slice(-400) } });
        });
        break;
      }
      case "perf_baseline": {
        const paths = JSON.parse(String(step.params.paths_json ?? "[]")) as string[];
        const values: Record<string, string> = {};
        for (const p of paths) {
          const v = await this.adbShellChecked(`su -c cat ${p}`, 8000);
          if (v) values[p] = v.trim();
        }
        this.scratch.set("perf:baseline", JSON.stringify(values));
        res = stepResult("perf_baseline", "success", { planId, riskScore: 0.05, details: { recorded: Object.keys(values).length, values } });
        break;
      }
      case "apply_perf_profile": {
        await this.assertTargetLive();
        const pairs = JSON.parse(String(step.params.values_json ?? "[]")) as Array<{ path: string; value: string }>;
        res = await this.barrier.runExclusive(async () => {
          const applied: string[] = [];
          const failed: Array<{ path: string; error: string }> = [];
          for (const pair of pairs) {
            const w = await this.adbShellChecked(`su -c sh -c 'echo ${pair.value} > ${pair.path}'`, 8000);
            const back = await this.adbShellChecked(`su -c cat ${pair.path}`, 8000);
            if (back?.trim() === pair.value) applied.push(pair.path);
            else failed.push({ path: pair.path, error: w ?? "写入后读回不符" });
          }
          return stepResult("apply_perf_profile", "success", { planId, riskScore: 0.2, details: { applied, failed, note: "sysfs 直写重启即还原；恢复用 perf_baseline 记录值" } });
        });
        break;
      }
      case "zygisk_check": {
        const z = await this.adbShellChecked("su -c ls /data/adb/modules | grep -i zygisk", 10000);
        res = stepResult("zygisk_check", "success", { planId, riskScore: 0.05, details: { zygiskModulePresent: !!z, module: z ?? null } });
        break;
      }
      case "buildprop_baseline": {
        const patches = JSON.parse(String(step.params.patches_json ?? "[]")) as Array<{ name: string; value: string }>;
        const values: Record<string, string> = {};
        for (const p of patches) {
          const v = await this.adbShellChecked(`getprop ${p.name}`, 8000);
          if (v) values[p.name] = v.trim();
        }
        this.scratch.set("prop:baseline", JSON.stringify(values));
        res = stepResult("buildprop_baseline", "success", { planId, riskScore: 0.05, details: { recorded: values } });
        break;
      }
      case "apply_buildprop_patch": {
        await this.assertTargetLive();
        const patches = JSON.parse(String(step.params.patches_json ?? "[]")) as Array<{ name: string; value: string }>;
        res = await this.barrier.runExclusive(async () => {
          const applied: string[] = [];
          const failed: Array<{ name: string; error: string }> = [];
          for (const p of patches) {
            await this.adbShellChecked(`su -c magisk --resetprop ${p.name} ${p.value}`, 8000);
            const back = await this.adbShellChecked(`getprop ${p.name}`, 8000);
            if (back?.trim() === p.value) applied.push(p.name);
            else failed.push({ name: p.name, error: "resetprop 后读回不符" });
          }
          return stepResult("apply_buildprop_patch", "success", { planId, riskScore: 0.15, details: { applied, failed } });
        });
        break;
      }
      case "force_stop_app": {
        const pkg = String(step.params.appPackage ?? "com.tencent.mm");
        const r = await run(this.cfg.adbPath, ["shell", `am force-stop ${pkg}`], 10000);
        res = stepResult("force_stop_app", "success", { planId, riskScore: 0.05, details: { pkg, code: r.code } });
        break;
      }
      case "wechat_backup": {
        await this.assertTargetLive();
        const pkg = String(step.params.appPackage ?? "com.tencent.mm");
        res = await this.barrier.runExclusive(async () => {
          try {
            const ts = Date.now();
            const serial = (this.boundSerial ?? "unknown").replace(/[^A-Za-z0-9_\-.]/g, "_");
            const remote = `/data/local/tmp/wechat-backup-${ts}.tar.gz`;
            const t = await run(this.cfg.adbPath, ["shell", `su -c tar -czf ${remote} -C / data/data/${pkg}`], this.cfg.cmdTimeoutMs * 8);
            if (t.code !== 0) throw new OrchestratorError("infeasible", `设备端打包失败：${t.stderr.slice(-300)}`, {});
            const dir = path.join(this.cfg.stateDir, "backups", serial);
            mkdirSync(dir, { recursive: true });
            const local = path.join(dir, `wechat-${ts}.tar.gz`);
            const p = await run(this.cfg.adbPath, ["pull", remote, local], this.cfg.cmdTimeoutMs * 8);
            if (p.code !== 0 || !existsSync(local)) throw new OrchestratorError("infeasible", `拉取失败：${p.stderr.slice(-300)}`, {});
            const size = statSync(local).size;
            await run(this.cfg.adbPath, ["shell", `rm -f ${remote}`], 10000).catch(() => null);
            if (size < 1024) throw new OrchestratorError("infeasible", `归档仅 ${size} 字节：tar 失败或数据为空`, { local });
            return stepResult("wechat_backup", "success", { planId, riskScore: 0.15, details: { local, bytes: size } });
          } catch (e) {
            return this.errorToStep("wechat_backup", e, false);
          }
        });
        break;
      }
      case "backup_verify":
        res = stepResult("backup_verify", "success", { planId, riskScore: 0.05, details: { note: "归档大小校验已在 wechat_backup 内完成；查看其 details.bytes" } });
        break;
      case "shizuku_start": {
        const r = await run(this.cfg.adbPath, ["shell", "sh /storage/emulated/0/Android/data/moe.shizuku.privileged.api/start.sh"], this.cfg.cmdTimeoutMs);
        res = stepResult("shizuku_start", "success", {
          planId, riskScore: 0.1,
          details: { outputTail: `${r.stdout}\n${r.stderr}`.slice(-500), hint: "未配对时：开发者选项 → 无线调试 → 配对（物理操作）" },
        });
        break;
      }
      case "vfs_conflict_check": {
        const modules = await this.adbShellChecked("su -c ls /data/adb/modules", 10000) ?? "";
        const overlays = await this.adbShellChecked("su -c sh -c 'cat /proc/mounts | grep overlay | wc -l'", 10000) ?? "0";
        const conflicts = findHideConflicts(modules);
        res = stepResult("vfs_conflict_check", "success", {
          planId, riskScore: 0.05,
          details: { modules: modules.split("\n").filter((s) => s.trim()), overlayMounts: Number(overlays) || 0, conflicts, verdict: conflicts.length === 0 ? "无互斥组合" : "存在互斥组合，先禁用其一" },
        });
        break;
      }
      case "exploit_probe": {
        const st = await probeDevice(this.cfg, { fields: ["all"], priority: 1 });
        const matches = matchKernelExploits(typeof st.fields.kernelVersion === "string" ? st.fields.kernelVersion : null);
        res = stepResult("exploit_probe", "success", {
          planId, riskScore: 0.1,
          details: { kernel: st.fields.kernelVersion ?? null, matches, note: "占位条目永不匹配；实际 payload 由用户提供并自行承担来源" },
        });
        break;
      }
      case "disable_module": {
        await this.assertTargetLive();
        const moduleId = String(step.params.moduleId ?? "all");
        res = await this.barrier.runExclusive(async () => {
          const ids = moduleId === "all"
            ? (await this.adbShellChecked("su -c ls /data/adb/modules", 10000) ?? "").split("\n").map((s) => s.trim()).filter((s) => s.length > 0)
            : [moduleId];
          const disabled: string[] = [];
          for (const id of ids) {
            const w = await this.adbShellChecked(`su -c touch /data/adb/modules/${id}/disable`, 8000);
            if (w === null || w.length === 0) disabled.push(id);
          }
          return stepResult("disable_module", "success", { planId, riskScore: 0.2, details: { disabled, note: "写入空 disable 文件，下次启动 Magisk 跳过该模块" } });
        });
        break;
      }
      case "baseband_post_verify": {
        const bb = await this.adbShellChecked("getprop gsm.version.baseband", 15000);
        res = stepResult("baseband_post_verify", bb && bb.length > 0 ? "success" : "blocked", {
          planId, riskScore: 0.1, errorCode: bb && bb.length > 0 ? null : "needs_clarification",
          message: bb && bb.length > 0 ? undefined : `基带仍为空（${bb ?? "无属性"}）：重试 QCN 恢复或 EFS 深度救援`,
          details: { baseband: bb ?? null },
        });
        break;
      }
      case "rescue_img_check": {
        const img = String(step.params.rescueImgPath ?? "");
        const exists = img.length > 0 && existsSync(img);
        res = stepResult("rescue_img_check", exists ? "success" : "failed", {
          planId, riskScore: 0.05, errorCode: exists ? null : "resource_corrupted",
          message: exists ? undefined : `救援镜像不存在：${img}`,
          details: { img, sha: step.params.rescueImgSha ?? null },
        });
        break;
      }
      case "ui_confirm": {
        // v4 三：UI 自动化——uiautomator 定位 + opbus ui_tap + 前后比对
        const matcher = JSON.parse(String(step.params.matcher_json ?? "{}")) as NodeMatcher;
        const r = await this.uiConfirm(matcher);
        res = stepResult("ui_confirm", r.fallbackGuide ? "blocked" : "success", {
          planId, riskScore: 0.1,
          errorCode: r.fallbackGuide ? "needs_clarification" : null,
          message: r.fallbackGuide ?? undefined,
          details: { tapped: r.tapped, changed: r.changed, node: r.node },
        });
        break;
      }
      case "post_flash_tune": {
        // v4 五：刷后深度调优——私有 DNS / 缓存清理 / 热门应用编译 / fstrim
        await this.assertTargetLive();
        const applied: Record<string, unknown> = {};
        await this.adbShellChecked("settings put global private_dns_mode hostname", 8000);
        await this.adbShellChecked("settings put global private_dns_specifier dns.adguard.com", 8000);
        applied.privateDns = "dns.adguard.com（AdGuard DoT，系统级去广告）";
        await this.adbShellChecked("pm trim-caches 999999999999999", 15000);
        applied.trimCaches = "done";
        const hot = ["com.tencent.mm", "com.android.chrome", "com.android.vending"];
        const compiled: string[] = [];
        for (const pkg of hot) {
          const r = await this.adbShellChecked(`cmd package compile -m speed --check-prof false -f ${pkg}`, 30000);
          if (r !== null) compiled.push(pkg);
        }
        applied.compiled = compiled;
        const trim = await this.adbShellChecked("su -c fstrim -v /data", 30000) ?? await this.adbShellChecked("fstrim -v /data", 30000);
        applied.fstrim = trim ?? "skipped";
        res = stepResult("post_flash_tune", "success", { planId, riskScore: 0.05, details: applied });
        break;
      }
      default:
        res = await this.guideOnlyStep(step);
    }

    return { ...res, plan_id: planId, estimated_remaining_time: minutesFmt(remainingMs) };
  }

  // 引导类步骤（unlock/erase/super/firehose…）：永不自动执行，只出拦截话术 + 引导
  private async guideOnlyStep(step: PlanStep): Promise<StepResult> {
    const state = await probeDevice(this.cfg, { fields: ["all"], priority: 2 });
    if (state.protocol === "none") {
      return stepResult(step.operation, "blocked", { errorCode: "infeasible", message: "未检测到设备" });
    }
    const decision = evaluate(step.operation, {
      state,
      partition: step.params.partition !== undefined ? String(step.params.partition) : undefined,
      method: step.params.method !== undefined ? String(step.params.method) : undefined,
      backupPresent: step.params.backupManifestPath !== undefined ? validateBackupManifest(String(step.params.backupManifestPath)) : undefined,
    });
    if (decision.verdict === "allow") {
      // 引导类步骤即使评估可自动也不自动执行（2.3 兜底）
      return stepResult(step.operation, "blocked", {
        errorCode: "deny_auto",
        riskScore: decision.riskScore,
        message: "该步骤被标记为手动引导类，永不自动执行",
      });
    }
    const res = this.intercepted(step.operation, decision, {});
    this.appendAudit(step.operation, "n/a", "n/a", decision.riskScore);
    return res;
  }

  // ───────────────────────── 危险操作 ─────────────────────────

  // flash_partition：独占屏障 + pendingStep 崩溃检测 + 快照 + 审计 + capability 采样
  async flash(req: FlashPartitionRequest): Promise<StepResult> {
    const startedAt = Date.now();
    const state = await probeDevice(this.cfg, { fields: ["all"], priority: 2 });
    if (state.protocol === "none") {
      return stepResult(`flash_${req.partition}`, "blocked", { errorCode: "infeasible", message: "未检测到设备：adb 与 fastboot 均无响应" });
    }
    if (state.protocol !== "fastboot") {
      return stepResult(`flash_${req.partition}`, "blocked", {
        errorCode: "needs_clarification",
        message: "刷写需在 fastboot 模式执行：先 adb reboot bootloader",
        degraded: state.degraded,
      });
    }
    assertP0(state);
    assertPhysicalHardStops(state); // P2：电量/存储硬阻断（fastboot 下电量 N/A 不触发，plan() 已在 adb 模式先行校验）
    this.assertTarget(state); // v3：多设备防呆
    const op = `flash_${req.partition}`;
    const isLarge = LARGE_WRITE_PARTITIONS.includes(req.partition); // P2：大分区 preSnapshot 必含温度
    const ctx: GuardContext = { state, partition: req.partition };
    const decision = evaluate(op, ctx);
    const resolved = this.resolveOverride(op, decision, ctx);
    if (!resolved.allow) return resolved.result;

    return this.barrier.runExclusive(async () => {
      let preHash = "n/a";
      let preTemp: number | null | undefined;
      try {
        const pre = await captureSnapshot(this.cfg, [req.partition], { includeTemperature: isLarge });
        preHash = snapshotHash(pre);
        preTemp = pre.temperatureC;
        const precheck = await flashPrecheck(this.cfg, req); // 只读预检（SHA256/槽位/稀疏），无设备写入
        this.ensureContext(pre.deviceHash);
        this.markPending(op, "direct", preHash); // 写入前落盘挂起标记：崩在这里 → 下次 recover 强制校验
        const out = await flashImage(this.cfg, req, precheck); // 唯一写入点
        this.fastbootTimeoutStreak = 0; // v4：成功即清零超时连击
        const post = await captureSnapshot(this.cfg, [req.partition]);
        const postHash = snapshotHash(post);
        this.clearPendingStep();
        const evt = this.appendAudit(op, preHash, postHash, resolved.decision.riskScore);
        this.recordCapability("flash", startedAt, true, state);
        this.persistContext(post.deviceHash, evt.currentEventHash, post);
        return stepResult(op, "success", {
          preHash,
          postHash,
          nextStep: "verify_avb",
          riskScore: resolved.decision.riskScore,
          degraded: state.degraded,
          details: { precheck, fastbootOutput: out.output, temperatureC: preTemp ?? null },
        });
      } catch (e) {
        const isUnknown = e instanceof OrchestratorError && (e.code === "unknown_physical_state" || e.code === "timeout");
        if (!isUnknown) this.clearPendingStep(); // 超时/未知态保留挂起标记：下次 recover 先验证再谈续跑
        this.appendAudit(`${op}:error`, preHash, isUnknown ? "unknown_physical_state" : "n/a", resolved.decision.riskScore);
        this.recordCapability("flash", startedAt, false, state);
        // v4 一：opbus 拦截落审计链
        if (e instanceof OrchestratorError && e.details.opbusBlocked === true) {
          const blockedAction = (e.details.op as { action?: string } | undefined)?.action ?? "?";
          this.appendAudit(`opbus:block:${blockedAction}`, "n/a", "n/a", 0.5);
        }
        // v4 四：连续 fastboot 超时 → USB 探针
        if (isUnknown) {
          this.fastbootTimeoutStreak += 1;
          if (this.fastbootTimeoutStreak >= 2 && e instanceof OrchestratorError) {
            const hints = await diagnoseUsb().catch(() => []);
            e = new OrchestratorError(e.code, `${e.message}（USB 探针：连续 ${this.fastbootTimeoutStreak} 次超时，${hints.slice(0, 2).join("；")}）`, {
              ...e.details, usbHints: hints,
            });
          }
        } else {
          this.fastbootTimeoutStreak = 0;
        }
        // P2：大分区超时 → 错误信息提示高温擦除延迟
        if (isUnknown && isLarge && e instanceof OrchestratorError) {
          e = new OrchestratorError(
            e.code,
            `${e.message}（大分区写入：可能因高温导致 eMMC 擦除延迟，pre 温度 ${preTemp != null ? `${preTemp}℃` : "未知"}）`,
            { ...e.details, temperatureC: preTemp ?? null },
          );
        }
        return this.errorToStep(op, e, state.degraded);
      }
    });
  }

  // 6.3：vbmeta 补丁刷写前必须显式遍历 chained vbmeta
  async flashVbmeta(o: {
    imagePath: string;
    verifySHA256: string;
    disableVerity?: boolean;
    disableVerification?: boolean;
    subImages?: Record<string, string>;
  }): Promise<StepResult> {
    let report;
    try {
      const buf = readFileSync(o.imagePath);
      report = verifyAvbChain(buf, (name) => (o.subImages && o.subImages[name] ? readFileSync(o.subImages[name]) : null));
    } catch (e) {
      return stepResult("flash_vbmeta_patch", "failed", { errorCode: "resource_corrupted", message: String(e) });
    }
    const unresolved = report.chains.filter((c) => !c.resolved).map((c) => c.partition);
    if (!report.complete || report.broken.length > 0) {
      const msg = [
        `【高风险拦截】检测到您试图执行 flash_vbmeta_patch。只关顶层验证没用：AVB 链未确认完整（6.3）。`,
        `未解析的链式子分区：${unresolved.join("、") || "无"}；哈希校验失败：${report.broken.join("、") || "无"}。`,
        `系统已启用 deny_auto。请通过 subImages 参数提供全部子分区 vbmeta 后重试。`,
      ].join("\n");
      return stepResult("flash_vbmeta_patch", "blocked", {
        errorCode: "deny_auto",
        riskScore: 0.3,
        message: msg,
        details: { report },
      });
    }
    const flags: string[] = [];
    if (o.disableVerity) flags.push("--disable-verity");
    if (o.disableVerification) flags.push("--disable-verification");
    return this.flash({ partition: "vbmeta", imagePath: o.imagePath, verifySHA256: o.verifySHA256, sparseHandling: "auto", fastbootFlags: flags });
  }

  // erase_partition：永不自动执行（2.3），一律生成手动引导；discard/trim 拒绝（6.6）
  async erase(req: ErasePartitionRequest): Promise<StepResult> {
    const state = await probeDevice(this.cfg, { fields: ["all"], priority: 2 });
    if (state.protocol === "none") {
      return stepResult("erase_partition", "blocked", { errorCode: "infeasible", message: "未检测到设备" });
    }
    assertP0(state, ["protocol"]);
    assertPhysicalHardStops(state); // P2：电量/存储硬阻断
    this.assertTarget(state); // v3：多设备防呆

    const method = String(req.method);
    if (!isSecureMethod(method)) {
      // 6.6：强行快速擦除 → LOGICAL_ERASE_ONLY 警告
      return stepResult("erase_partition", "blocked", {
        errorCode: "deny_auto",
        riskScore: 0.9,
        message: [
          `【高风险拦截】检测到您试图执行 erase ${req.partition}（method=${method}）。`,
          `LOGICAL_ERASE_ONLY_DATA_REMAINS_RECOVERABLE：discard/trim 属逻辑擦除，数据仍可恢复，本工具仅支持 secure_erase/sanitize/blksecdiscard。`,
          "系统已启用 deny_auto，请查阅手动执行引导。",
        ].join("\n"),
        guide: {
          operation: `erase_${req.partition}`,
          preconditions: ["改用 secure_erase/sanitize/blksecdiscard 之一"],
          steps: ["向 erase() 传入合规 method 后重新发起，将生成完整安全擦除引导"],
          risks: ["逻辑擦除后数据可被恢复工具还原"],
          warnings: ["LOGICAL_ERASE_ONLY_DATA_REMAINS_RECOVERABLE"],
        },
      });
    }

    const backupPresent = req.requireBackup ? validateBackupManifest(req.backupManifestPath) : undefined;
    const decision = evaluate("erase_partition", {
      state,
      partition: req.partition,
      method,
      backupPresent,
      forceFastErase: req.forceFastErase,
    });
    if (decision.verdict === "allow") {
      // 理论不可达：erase 恒为 manual-only；防御性兜底
      return stepResult("erase_partition", "blocked", { errorCode: "deny_auto", riskScore: decision.riskScore, message: "erase 类操作永不自动执行（2.3）" });
    }
    const res = this.intercepted(`erase_${req.partition}`, decision, {
      partition: req.partition,
      method,
      backupPresent: backupPresent === true,
    });
    this.appendAudit(`erase_guide:${req.partition}`, "n/a", "n/a", decision.riskScore);
    return res;
  }

  // execute_script：exclusive 走设备屏障；shared 内部仍串行
  async executeScript(req: ExecuteScriptRequest): Promise<StepResult> {
    try {
      const run =
        req.barrierMode === "exclusive"
          ? () => this.barrier.runExclusive(() => this.executor.execute(req))
          : () => this.executor.execute(req);
      const r = await run();
      return stepResult("execute_script", "success", {
        preHash: r.preHash,
        postHash: r.postHash,
        riskScore: 0.2,
        details: { result: r.result, eventId: r.eventId },
      });
    } catch (e) {
      return this.errorToStep("execute_script", e, false);
    }
  }

  // ───────────────────────── Override Token 流程（2.2） ─────────────────────────

  generateOverride(operation: string): { token: OverrideToken; note: string } {
    const token = generateToken(operation, this.cfg.secretKey);
    this.ensureContext(this.context?.deviceHash ?? "unknown");
    this.context!.overrideTokens.push(token);
    saveContext(this.cfg.stateDir, this.context!);
    return { token, note: "5 分钟内有效、一次性使用、仅绑定上述操作；回传时 riskAcknowledged 必须为 true" };
  }

  submitOverride(token: OverrideToken, operation: string): { ok: boolean; reason?: string } {
    const v = verifyToken(token, operation, this.cfg.secretKey);
    if (!v.ok) return v;
    if (this.usedTokenIds.has(token.tokenId)) return { ok: false, reason: "令牌已使用（一次性）" };
    this.usedTokenIds.add(token.tokenId);
    this.appendAudit(`override_accepted:${operation}`, "n/a", "n/a", 0, token.tokenId);
    return { ok: true };
  }

  // ───────────────────────── 会话恢复（8.2，P1 收紧） ─────────────────────────

  /**
   * 恢复第一步绝对不是续跑：
   * · 无挂起步骤 → 正常返回续跑点
   * · 有 pendingStep（崩在中途）→ 先 probeBundle 只读探测 + 快照比对：
   *   不一致 → 步骤强制置 unknown_physical_state，抛错要求手动验证
   *   一致   → 清除挂起标记，允许从该操作之后继续
   */
  async recover(): Promise<RecoveryReport> {
    let r: ReturnType<typeof recoverSession>;
    try {
      r = recoverSession(this.cfg.stateDir, this.audit);
    } catch (e) {
      throw new OrchestratorError("infeasible", `审计链校验失败，拒绝恢复：${String(e)}`, {});
    }
    if (!r) {
      return { planId: null, resumedFrom: null, eventCount: 0, interrupted: false, pendingStep: null, verified: false };
    }
    this.context = r.ctx;
    this.headHash = r.ctx.eventChainHash;
    for (const e of r.events) {
      if (e.overrideToken) this.usedTokenIds.add(e.overrideToken);
    }

    if (r.pendingStep) {
      // 恢复第一步：只读 PTC 探测（绝不直接续跑）
      const bundle = await this.probeBundle();
      const fresh = await captureSnapshot(this.cfg);
      const freshHash = snapshotHash(fresh);
      const match = freshHash === r.pendingStep.preSnapshotHash;
      if (!match) {
        // 物理状态已漂移 → 强制 unknown_physical_state + 抛错要求手动验证
        this.appendAudit(`recover_abort:${r.pendingStep.operation}`, r.pendingStep.preSnapshotHash, freshHash, 0.9);
        this.clearPendingStep();
        throw new OrchestratorError(
          "unknown_physical_state",
          `断点恢复被拦截：步骤「${r.pendingStep.operation}」崩于写入中途，且当前设备快照与崩溃前 pre-snapshot 不一致。该步骤已标记为 unknown_physical_state，请手动验证设备状态（当前协议/槽位/分区完整性）后再决定下一步。`,
          {
            pendingStep: r.pendingStep,
            expectedPreHash: r.pendingStep.preSnapshotHash,
            freshHash,
            probeProtocol: bundle.state.protocol,
          },
        );
      }
      // 状态一致 → 清挂起标记，允许续跑
      this.appendAudit(`recover_verified:${r.pendingStep.operation}`, r.pendingStep.preSnapshotHash, freshHash, 0.3);
      this.clearPendingStep();
      return {
        planId: r.ctx.planId || null,
        resumedFrom: r.pendingStep.operation,
        eventCount: r.events.length,
        interrupted: true,
        pendingStep: r.pendingStep,
        verified: true,
      };
    }

    return {
      planId: r.ctx.planId || null,
      resumedFrom: r.resumedAtStep,
      eventCount: r.events.length,
      interrupted: false,
      pendingStep: null,
      verified: false,
    };
  }

  // ───────────────────────── 内部 ─────────────────────────

  private resolveOverride(
    op: string,
    decision: ReturnType<typeof evaluate>,
    ctx: GuardContext,
  ): { allow: true; decision: ReturnType<typeof evaluate> } | { allow: false; result: StepResult } {
    if (decision.verdict === "allow") return { allow: true, decision };
    if (decision.verdict === "deny_with_override") {
      const tok = (this.context?.overrideTokens ?? []).find(
        (t) => t.operation === op && !this.usedTokenIds.has(t.tokenId),
      );
      if (!tok) {
        return {
          allow: false,
          result: this.intercepted(op, decision, {
            tokenInstruction: `调用 generateOverride("${op}") 获取令牌 → 确认风险后 submitOverride(token, "${op}") → 重试`,
          }),
        };
      }
      const v = verifyToken(tok, op, this.cfg.secretKey);
      if (!v.ok) {
        return { allow: false, result: this.intercepted(op, decision, { tokenInstruction: `令牌无效：${v.reason}；重新 generateOverride` }) };
      }
      this.usedTokenIds.add(tok.tokenId);
      this.appendAudit(`override_consumed:${op}`, "n/a", "n/a", decision.riskScore, tok.tokenId);
      const cleared = evaluate(op, { ...ctx, overrideCleared: true });
      if (cleared.verdict === "allow") return { allow: true, decision: cleared };
      return { allow: false, result: this.intercepted(op, cleared, {}) };
    }
    return { allow: false, result: this.intercepted(op, decision, {}) };
  }

  private intercepted(op: string, decision: ReturnType<typeof evaluate>, extra: Record<string, unknown>): StepResult {
    const code: ErrorCode =
      decision.verdict === "deny_hard" ? "deny_hard" : decision.verdict === "deny_with_override" ? "deny_with_override" : "deny_auto";
    const guide = decision.verdict === "deny_auto" || decision.verdict === "deny_with_override" ? decision.guide : undefined;
    return stepResult(op, "blocked", {
      errorCode: code,
      riskScore: decision.riskScore,
      message: formatIntercept(op, decision),
      guide,
      details: extra,
    });
  }

  private errorToStep(op: string, e: unknown, degraded: boolean): StepResult {
    if (e instanceof OrchestratorError) {
      const status: StepResult["status"] = e.code === "resource_corrupted" || e.code === "infeasible" ? "failed" : "blocked";
      return stepResult(op, status, { errorCode: e.code, message: e.message, details: e.details, degraded });
    }
    return stepResult(op, "failed", { errorCode: "infeasible", message: String(e), degraded });
  }

  // P2：模块编排辅助 —— adb shell 便捷调用（失败返回 stdout/stderr 混合或 null）
  private async adbShellChecked(cmd: string, timeoutMs: number): Promise<string | null> {
    const r = await run(this.cfg.adbPath, ["shell", cmd], timeoutMs).catch(() => null);
    if (!r) return null;
    const out = r.stdout.trim();
    return out.length > 0 ? out : r.stderr.trim() || null;
  }

  // v4 三：UI 自动化（uiautomator 定位 + opbus ui_tap + 状态校验）
  async uiConfirm(matcher: NodeMatcher, timeoutMs = 12000) {
    return uiConfirm(this.cfg, matcher, { timeoutMs });
  }

  // v4 二：流水线预取——本步执行期间后台下载后续步骤的资源（fire-and-forget，失败静默重试）
  // v5 RC1：双层兜底——预取任何环节出错都绝不阻塞主流程的计划执行
  private prefetchAsync(planId: string, fromIdx: number): void {
    try {
      const plan = this.plans.get(planId);
      if (!plan) return;
      for (let i = fromIdx + 1; i < plan.steps.length; i++) {
        const st = plan.steps[i];
        const key = `${planId}:${st.id}`;
        try {
          const query = st.operation === "install_module" ? String(st.params.module ?? "")
            : st.operation === "resolve_resources" ? "magisk" : "";
          if (query.length === 0 || this.prefetchDone.has(key)) continue;
          this.prefetchDone.add(key);
          void resolveResource(this.cfg, { query, sources: ["github"], requireSHA256: true })
            .catch(() => {
              this.prefetchDone.delete(key); // 失败允许下次重试
            });
        } catch {
          this.prefetchDone.delete(key); // 单项预取异常不影响其余项与主流程
        }
      }
    } catch {
      /* 预取整体失败 = 无预取，主流程零影响 */
    }
  }

  private async deviceReboot(planId: string | null): Promise<StepResult> {
    const bootTimeoutMs = 180000;
    const started = Date.now();
    const r = await run(this.cfg.adbPath, ["reboot"], 15000).catch(() => null);
    if (!r || r.code !== 0) {
      return stepResult("reboot", "blocked", { planId, errorCode: "infeasible", message: `adb reboot 失败：${r ? r.stderr.slice(-300) : "无法启动 adb"}` });
    }
    // 轮询 sys.boot_completed（每 3s），超时即结构化报错，禁止盲重试
    while (Date.now() - started < bootTimeoutMs) {
      await sleep(3000);
      const st = await run(this.cfg.adbPath, ["shell", "getprop sys.boot_completed"], 5000).catch(() => null);
      if (st && st.stdout.trim() === "1") {
        return stepResult("reboot", "success", { planId, riskScore: 0.1, details: { rebootMs: Date.now() - started } });
      }
    }
    return stepResult("reboot", "blocked", {
      planId,
      errorCode: "timeout",
      message: `重启后 ${bootTimeoutMs / 1000}s 内未见 sys.boot_completed=1：检查设备屏幕；卡 logo → recovery 清 cache；无限重启 → fastboot 刷回备份`,
    });
  }

  private appendAudit(operation: string, preHash: string, postHash: string, riskScore: number, overrideTokenId?: string): AuditEvent {
    const evt = this.audit.append(
      { event: operation, preSnapshotHash: preHash, postSnapshotHash: postHash, riskScore, ...(overrideTokenId ? { overrideToken: overrideTokenId } : {}) },
      this.headHash,
    );
    this.headHash = evt.currentEventHash;
    if (this.context) {
      this.context.eventChainHash = evt.currentEventHash;
    }
    return evt;
  }

  // P1：capability-map 采样（flash 单次耗时 / root 全流程耗时）。无设备身份不记录，避免污染键空间
  private recordCapability(intent: "flash" | "root", startedAt: number, success: boolean, state: DeviceState, mode = "exploration"): void {
    const key = capabilityKeyFromState(state.fields);
    if (key === "unknown::unknown") return;
    recordSample(this.cfg.stateDir, key, {
      intent,
      durationMs: Date.now() - startedAt,
      success,
      mode,
      timestamp: Date.now(),
    });
  }

  private ensureContext(deviceHash: string): void {
    if (!this.context) {
      this.context = {
        deviceHash,
        planId: "",
        barrierStatus: this.barrier.status,
        overrideTokens: [],
        lastSnapshot: { timestamp: Date.now(), deviceHash, criticalFields: {}, partitionHashes: {} },
        eventChainHash: this.headHash,
        pendingStep: null,
      };
      saveContext(this.cfg.stateDir, this.context);
    }
  }

  private markPending(operation: string, stepId: string, preSnapshotHash: string): void {
    if (!this.context) return;
    this.context.pendingStep = { operation, stepId, preSnapshotHash, startedAt: Date.now() };
    saveContext(this.cfg.stateDir, this.context);
  }

  private clearPendingStep(): void {
    if (!this.context || !this.context.pendingStep) return;
    this.context.pendingStep = null;
    saveContext(this.cfg.stateDir, this.context);
  }

  private persistContext(deviceHash: string, chainHash: string, snapshot?: Snapshot): void {
    if (!this.context || this.context.deviceHash !== deviceHash) {
      this.context = {
        deviceHash,
        planId: this.context?.planId ?? "",
        barrierStatus: this.barrier.status,
        overrideTokens: this.context?.overrideTokens ?? [],
        lastSnapshot: snapshot ?? this.context?.lastSnapshot ?? { timestamp: Date.now(), deviceHash, criticalFields: {}, partitionHashes: {} },
        eventChainHash: chainHash,
        pendingStep: this.context?.pendingStep ?? null,
      };
    } else {
      this.context.eventChainHash = chainHash;
      if (snapshot) this.context.lastSnapshot = snapshot;
    }
    this.context.barrierStatus = this.barrier.status;
    saveContext(this.cfg.stateDir, this.context);
  }

  private buildScriptApi(): ScriptApi {
    const self = this;
    return {
      probe: (req?: { fields?: string[]; priority?: Priority }) => probeDevice(self.cfg, { fields: req?.fields ?? ["all"], priority: req?.priority ?? 2 }),
      probeDevice: (req: ProbeDeviceRequest) => probeDevice(self.cfg, req),
      captureSnapshot: (partitions?: string[]) => captureSnapshot(self.cfg, partitions ?? []),
      appendAudit: async (req: AuditLogRequest) => {
        const evt = self.appendAudit(req.event, req.preSnapshotHash, req.postSnapshotHash, req.riskScore, req.overrideToken);
        return { eventId: evt.eventId, currentEventHash: evt.currentEventHash };
      },
      resolveResource: (req: ResourceResolverRequest) => resolveResource(self.cfg, req),
      state: {},
    };
  }
}

export { OrchestratorError, stepResult };
export type { DeviceState, Plan, StepResult, ManualGuide, OverrideToken, ClarifyResult, Intent, IntentVariables, Snapshot };
