// 意图展开硬门控（3.1）+ 双轨估算（3.2，P1 起优先查 capability-map 历史）+ 预计算计划（3.3）
import { randomUUID } from "node:crypto";
import type { DeviceState, FieldValue, Plan, PlanEstimate, PlanStep } from "./types.js";

export type Intent = "root" | "unlock" | "erase_userdata" | "flash_rom" | "rescue";

export interface IntentVariables {
  root_method?: "magisk" | "apatch" | "kernelsu";
  hide_target?: boolean;
  bootloader_status?: "unlocked" | "locked" | "unknown";
  backup_preference?: "full" | "critical_only" | "none";
  target_slot?: "a" | "b" | "current";
  vbmeta_state?: "keep_avb" | "disable_verity";
  bootImagePath?: string;   // P2：原始 boot.img 路径（从固件提取），root 计划必填
  managerApkPath?: string;  // P2：本地管理器 APK（提供则跳过网络下载）
  patchBackend?: "adb-ondevice" | "magiskboot-local" | "manual" | "auto"; // P2：修补后端
  rootPersistence?: "temporary" | "permanent"; // v3 四：临时 Root（重启失效）与永久 Root 区分
}

const VAR_LABELS: Record<keyof IntentVariables, string> = {
  root_method: "Root 方案（magisk/apatch/kernelsu）",
  hide_target: "是否需要隐藏 Root 特征（true/false）",
  bootloader_status: "Bootloader 状态（unlocked/locked/unknown）",
  backup_preference: "备份策略（full/critical_only/none）",
  target_slot: "目标槽位（a/b/current，A/B 设备必填）",
  vbmeta_state: "AVB 处理（keep_avb/disable_verity）",
  bootImagePath: "原始 boot.img 路径（从固件提取，见 README 真机指引）",
  managerApkPath: "本地管理器 APK 路径（可选，跳过网络下载）",
  patchBackend: "修补后端（adb-ondevice/magiskboot-local/manual/auto）",
  rootPersistence: "Root 持久性（temporary=重启失效/permanent）",
};

const REQUIRED: Record<Intent, Array<keyof IntentVariables>> = {
  root: ["root_method", "hide_target", "bootloader_status", "backup_preference", "target_slot", "vbmeta_state", "bootImagePath"],
  unlock: ["backup_preference"],
  erase_userdata: ["backup_preference"],
  flash_rom: ["backup_preference", "target_slot"],
  rescue: [],
};

export type ClarifyResult =
  | { status: "needs_clarification"; missing_variables: string[]; message: string }
  | { status: "ok"; intent: Intent; vars: IntentVariables };

// 3.1：关键变量缺失 → needs_clarification 阻塞执行
export function expandIntent(intent: Intent, vars: IntentVariables): ClarifyResult {
  const missing = REQUIRED[intent].filter((k) => vars[k] === undefined);
  if (missing.length > 0) {
    return {
      status: "needs_clarification",
      missing_variables: missing as string[],
      message: `请提供缺失变量：${missing.map((m) => VAR_LABELS[m]).join("；")}`,
    };
  }
  return { status: "ok", intent, vars };
}

// 3.2：默认兜底估算（capability-map 命中时被历史数据取代）
const ESTIMATES: Record<Plan["mode"], PlanEstimate> = {
  exploration: { p50Ms: 7 * 60000, p90Ms: 15 * 60000, successRate: 0.85 },  // 新设备：P50 7min / P90 15min / 85%
  accelerated: { p50Ms: 2.75 * 60000, p90Ms: 5 * 60000, successRate: 0.95 }, // 已知设备：P50 2.75min / P90 5min / 95%
};

function step(
  id: string,
  operation: string,
  risk: number,
  minutes: number,
  branches: string[],
  barrier: PlanStep["barrier"],
  params: Record<string, FieldValue> = {},
  preheat = false,
  physicalOps?: string[],
): PlanStep {
  return {
    id,
    operation,
    params,
    calibratedRiskScore: risk,
    failureBranches: branches,
    estimatedDurationMs: Math.round(minutes * 60000),
    preheat,
    barrier,
    ...(physicalOps ? { physicalOps } : {}),
  };
}

// v3：场景路由（scenarios.ts）复用同一 step 构造器
export const mkStep = step;

export interface PlanInput {
  intent: Intent;
  vars: IntentVariables;
  state: DeviceState;
  cacheHit: boolean; // 资源缓存命中 + 补丁镜像已预取 → 加速档
  estimate?: PlanEstimate; // P1：调用方从 capability-map 算出的历史估算；缺省用默认兜底
}

function rootSteps(input: PlanInput): PlanStep[] {
  const vars = input.vars;
  // v3 四：临时 Root（漏洞/LKM 注入，重启失效）——不走 boot 刷写与模块栈
  if (vars.rootPersistence === "temporary") {
    return [
      step("s1_probe", "probe_bundle", 0, 0.5, ["设备不可见→检查 USB/驱动/授权弹窗", "P0 缺失→进 fastboot 重探"], "none"),
      step("s2_exploit_probe", "exploit_probe", 0.1, 0.5, ["内核版本不在已知适用区间→自行复核公告"], "none"),
      step("s3_payload_exec", "payload_exec", 0.6, 2, ["payload 来源不可信→自行复核签名", "内核 panic→重启即恢复原状"], "none", {}, false, ["按引导在设备上执行用户提供的注入 payload（本工具不提供 payload）"]),
      step("s4_verify_root", "verify_root", 0.1, 0.5, ["su 不可用→路径未生效，换 payload"], "none"),
      step("s5_final_probe", "final_probe", 0, 0.5, ["记录 capability 样本"], "none"),
    ];
  }
  const steps: PlanStep[] = [
    step("s1_probe", "probe_bundle", 0, 0.5, ["设备不可见→检查 USB/驱动/授权弹窗", "P0 缺失→进 fastboot 重探"], "none"),
    step("s2_resources", "resolve_resources", 0.05, 0.5, ["GitHub 限流→mirror 兜底", "sha256 不符→丢弃并标记 resource_corrupted"], "none"),
    step("s3_backup_boot", "backup_boot", 0.1, 1, ["adb 无 root→改用官方固件包提取 boot.img"], "none"),
  ];
  if (vars.bootloader_status === "locked") {
    steps.push(step("s5_unlock", "unlock_bootloader", 0.8, 3, ["解锁清数据→确认 backup_preference", "熔断机型（Knox/eFuse）→不可逆，先复核 knoxFused"], "none", {}, false,
      ["进 fastboot：关机后 音量下 + 连接 USB（多数机型），或 音量下 + 电源"]));
  }
  steps.push(step("s6_flash_boot", "flash_boot", 0.35, 1, [
    "分区名/槽位后缀核对", "sha256 重新校验", "tries_remaining=1→切换槽位（6.2）", "超时→unknown_physical_state，只读验证",
  ], "exclusive", { target_slot: vars.target_slot ?? "current" }, false,
    ["进 fastboot：adb reboot bootloader，或 音量下 + 电源"]));
  if (vars.vbmeta_state === "disable_verity") {
    steps.push(step("s7_vbmeta", "flash_vbmeta_patch", 0.3, 0.5, [
      "AVB 链未闭合→提供全部子 vbmeta（6.3）", "哈希校验失败→放弃关闭验证",
    ], "exclusive", { disableVerity: true, disableVerification: true }));
  }
  steps.push(
    step("s8_reboot_verify", "reboot_verify", 0.1, 1, ["卡 logo→recovery 清 cache/dalvik", "无限重启→fastboot 刷回备份 boot"], "none", {}, false,
      ["重启后卡 logo：按住 音量上 进 recovery"]),
    // v4 五：刷后深度调优（私有 DNS 去广告 / 缓存清理 / 热门应用 AOT 编译 / fstrim 保养）
    step("s8b_post_tune", "post_flash_tune", 0.05, 0.5, ["私有 DNS 不生效→设备不支持 DoT", "编译超时→跳过该项"], "none"),
  );
  if (vars.hide_target === true) {
    // 隐藏栈：[验证 Root] → [baseline 差分] → [Zygisk Next] → [baseline 差分] → [PIF] → [DenyList] → [重启] → [验证 Integrity]
    steps.push(
      step("s10_verify_root", "verify_root", 0.1, 0.5, ["su 不可用→检查 Magisk 是否生效/重启后重试"], "none"),
      step("s11_baseline_zy", "module_baseline", 0.05, 0.5, ["设备未 root→前置 verify_root 失败排查"], "none", { module: "zygisk_next" }),
      step("s12_install_zygisk", "install_module", 0.2, 1, ["模块与 Magisk 版本不兼容→换 release 分支", "装后无法开机→recovery 删除 /data/adb/modules/<id>"], "exclusive", { module: "zygisk_next" }),
      step("s13_baseline_pif", "module_baseline", 0.05, 0.5, ["同前置排查"], "none", { module: "playintegrityfix" }),
      step("s14_install_pif", "install_module", 0.2, 1, ["PIF 指纹过期→更新模块或换社区 fork"], "exclusive", { module: "playintegrityfix" }),
      step("s15_denylist", "configure_denylist", 0.15, 0.5, ["DenyList 不生效→确认 Magisk 设置里 Zygisk 已启用"], "none", {
        apps_json: JSON.stringify(["com.google.android.gms", "com.google.android.gms.unstable", "com.android.vending"]),
      }),
      step("s16_reboot", "reboot", 0.1, 1.5, ["10 分钟无 boot_completed→fastboot 排查"], "none"),
      step("s17_integrity", "verify_integrity", 0.1, 1, ["MEETS_DEVICE_INTEGRITY 失败→更新 PIF 指纹/检查 Zygisk Next 版本"], "none"),
      step("s18_final_probe", "final_probe", 0, 0.5, ["记录 capability 样本"], "none"),
    );
  } else {
    steps.push(step("s9_final_probe", "final_probe", 0, 0.5, [`root 未生效→检查 ${vars.root_method ?? "magisk"} 安装与模块`], "none"));
  }
  return steps;
}

function unlockSteps(): PlanStep[] {
  return [
    step("u1_probe", "probe_bundle", 0, 0.5, ["设备不可见→检查连接"], "none"),
    step("u2_backup", "backup_full", 0.1, 2, ["adb 无 root→critical_only 降级清单"], "none"),
    step("u3_unlock", "unlock_bootloader", 0.8, 3, ["熔断机型→deny_hard 拦截", "数据清空→二次确认备份"], "none"),
    step("u4_verify", "final_probe", 0, 0.5, ["解不开→检查 OEM 解锁开关与机型限制"], "none"),
  ];
}

function eraseSteps(): PlanStep[] {
  return [
    step("e1_probe", "probe_bundle", 0, 0.5, ["设备不可见→检查连接"], "none"),
    step("e2_backup", "backup_critical", 0.1, 2, ["清单缺失→deny_with_override"], "none"),
    step("e3_erase", "erase_partition", 0.7, 2, [
      "擦除命令 5 秒无返回→unknown_physical_state，只读验证", "回读非全零→换 sanitize 方法",
    ], "none", { partition: "userdata", method: "blksecdiscard" }, true), // 5.4：大分区擦除预热
    step("e4_verify", "erase_verify", 0.05, 0.5, ["partition.size 未变→复检节点路径"], "none"),
  ];
}

function flashRomSteps(): PlanStep[] {
  return [
    step("r1_probe", "probe_bundle", 0, 0.5, ["设备不可见→检查连接"], "none"),
    step("r2_backup", "backup_critical", 0.1, 2, ["清单缺失→critical_only 降级"], "none"),
    step("r3_flash_boot", "flash_boot", 0.35, 1, ["槽位核对", "sha256 校验", "tries=1→换槽位"], "exclusive", { target_slot: "current" }),
    step("r4_verify", "reboot_verify", 0.1, 1, ["无法开机→fastboot 刷回备份"], "none"),
  ];
}

function rescueSteps(): PlanStep[] {
  return [
    step("x1_probe", "probe_protocol", 0, 0.5, ["adb/fastboot 均无响应→判定是否 EDL（9008）"], "none"),
    step("x2_classify", "rescue_classify", 0.1, 1, [
      "能进 fastboot→走 fastboot 路线",
      "仅 EDL→firehose 路线（签名独立校验，单分区单会话）",
      "完全无响应→硬件级排查（电池/主板）",
    ], "none"),
    step("x3_path", "choose_recovery_path", 0.5, 3, ["路线失败→换等价载体（换注入点/换协议）"], "none", {}, true),
  ];
}

// P2：人话耗时（含重启次数）——多重启流程必须显式告知
export function wallClock(steps: PlanStep[]): string {
  const totalMs = steps.reduce((a, s) => a + s.estimatedDurationMs, 0);
  const reboots = steps.filter((s) => s.operation.startsWith("reboot")).length;
  return `预计耗时 ${(totalMs / 60000).toFixed(1)} 分钟${reboots > 0 ? `，包含 ${reboots} 次重启` : ""}`;
}

// 3.3 预计算：每步的 calibratedRiskScore / failureBranches / estimatedDuration 执行时直接查表
export function generatePlan(input: PlanInput): Plan {
  const mode: Plan["mode"] = input.cacheHit ? "accelerated" : "exploration";
  const steps =
    input.intent === "root" ? rootSteps(input)
    : input.intent === "unlock" ? unlockSteps()
    : input.intent === "erase_userdata" ? eraseSteps()
    : input.intent === "flash_rom" ? flashRomSteps()
    : rescueSteps();
  const notes: string[] = [];
  if (input.intent === "root" && input.vars.rootPersistence === "temporary") {
    notes.push("临时 Root：重启后失效，无法持久化模块（Magisk 模块不可安装），每次开机需重新注入");
    notes.push("隐藏栈步骤已按临时 Root 跳过：模块栈需要持久 root 才有意义");
  }
  return {
    planId: randomUUID(),
    intent: input.intent,
    mode,
    estimate: input.estimate ?? ESTIMATES[mode],
    estimateSource: input.estimate ? "history" : "default",
    estimateWallClock: wallClock(steps),
    steps,
    missingVariables: [],
    notes,
  };
}
