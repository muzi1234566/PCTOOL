// scenarios（v3 二/三/五）：android_plan_utility 的场景路由与计划生成
// 每个 builder 返回 Plan；不可行/硬阻断直接抛 OrchestratorError（deny_hard/deny_auto/infeasible/needs_clarification）
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { OrchestratorError } from "./errors.js";
import { evaluateArb, evaluateFakeRelock } from "./guardrails.js";
import { candidateById, matchVersionIntent } from "./intent-spec.js";
import { matchKernelExploits } from "./exploit-registry.js";
import { mkStep as mkStepBase, wallClock } from "./planner.js";
import type { DeviceState, FieldValue, ManualGuide, Plan, PlanStep } from "./types.js";

export type UtilityScenario =
  | "ota_keep_root"        // 二1：A/B OTA 保 Root 升级
  | "fake_relock"          // 二3：伪回锁（三星 deny_hard）
  | "cross_region_flash"   // 二4：跨区刷机 + 基带保护
  | "no_recovery_rescue"   // 二5：无 Recovery 救砖
  | "gaming_tune"          // 三1：性能/游戏调优
  | "privacy_modules"      // 三2：隐私与去广告
  | "data_rescue"          // 三3：数据抢救（微信等）
  | "advanced_hide"        // 三4：高级隐藏栈（NoMount/Hybrid Mount）
  | "rootless"             // 三5：免 Root（Shizuku / DSU GSI）
  | "unbrick_qcn"          // 五：QCN 与 EDL 救砖
  | "downgrade_rom";       // 一：降级（intent-spec 候选 + ARB 硬拦截）

export interface UtilityVars {
  versionQuery?: string;        // "降级到打游戏不发热的版本"
  targetVersion?: string;       // intent-spec 候选 id
  targetPatchLevel?: string;    // "2021-11-01"
  region?: string;              // 目标固件区域码
  backupManifestPath?: string;
  rescueImgPath?: string;       // fastboot boot 临时镜像
  rescueImgSha?: string;
  mode?: string;                // 场景内子模式（rooted/rootless/temp_boot/disable_modules）
  prefer?: string;              // rootless: shizuku/dsu
  profile?: string;             // gaming_tune: performance/balanced
  stack?: string;               // advanced_hide: nomount/hybrid
  moduleZipPath?: string;
  modulesJson?: string;
  patchesJson?: string;         // build.prop 补丁 [{name,value}]
  qcnPath?: string;             // 本机 QCN 备份（救砖强制）
  devinfoImagePath?: string;    // 伪回锁 devinfo/lk 伪装镜像
  devinfoSha?: string;
  deviceSerial?: string;        // 显式目标校验
}

// ───────────── 多设备防呆（二2） ─────────────
export function checkSerialMatch(bound: string | null, current: string | null): void {
  if (bound && current && bound !== current) {
    throw new OrchestratorError("target_mismatch",
      `目标设备不一致：计划绑定 serial=${bound}，当前设备 serial=${current}。多设备防呆：换设备必须重新生成计划`,
      { bound, current });
  }
}

export function isAbDevice(state: DeviceState): boolean {
  return state.fields.currentSlot !== undefined && state.fields.currentSlot !== null;
}

function otherSlot(slot: string): "a" | "b" {
  return slot.toLowerCase() === "a" ? "b" : "a";
}

function mkStep(
  id: string, operation: string, risk: number, minutes: number, branches: string[],
  barrier: PlanStep["barrier"], params: Record<string, FieldValue> = {}, physicalOps?: string[],
): PlanStep {
  return mkStepBase(id, operation, risk, minutes, branches, barrier, params, false, physicalOps);
}

function planOf(intent: string, steps: PlanStep[], notes: string[]): Plan {
  return {
    planId: randomUUID(),
    intent,
    mode: "exploration",
    estimate: { p50Ms: 7 * 60000, p90Ms: 15 * 60000, successRate: 0.85 }, // 兜底， Orchestrator 层可被历史估算覆盖
    estimateSource: "default",
    estimateWallClock: wallClock(steps),
    steps,
    missingVariables: [],
    notes,
  };
}

const probeStep = () => mkStep("s1_probe", "probe_bundle", 0, 0.5, ["设备不可见→检查 USB/驱动/授权弹窗"], "none");

// ───────────── 二1：OTA 保 Root 升级（仅 A/B） ─────────────
function otaKeepRoot(state: DeviceState): Plan {
  if (!isAbDevice(state)) {
    throw new OrchestratorError("infeasible",
      "OTA 保 Root 升级仅支持 A/B 设备：非 A/B 设备 OTA 会直接覆盖唯一 boot 分区，保 Root 闭环不存在（请走临时断开更新/回锁方案）",
      {});
  }
  const slot = String(state.fields.currentSlot ?? "a");
  const other = otherSlot(slot);
  const steps: PlanStep[] = [
    probeStep(),
    mkStep("s2_backup_active_boot", "backup_partition", 0.1, 1, ["adb 无 root→改用固件包提取当前 boot"], "none", { partition: "boot" }),
    mkStep("s3_ota_install", "ota_install", 0.15, 4, ["OTA 包校验失败→换完整包重试", "提示重启时误点→等 OTA 完成后重新 dump"], "none", {}, ["系统更新内下载安装 OTA；提示重启时**不要点重启**，回到编排器继续"]),
    mkStep("s4_ota_dump_inactive", "ota_dump_inactive", 0.1, 1, ["dump 失败→检查 by-name 节点"], "none", { slot: other }),
    mkStep("s5_ota_patch_inactive", "ota_patch_inactive", 0.2, 1.5, ["boot_patch.sh 不在 /data/adb/magisk→Magisk 版本过旧", "修补产物校验失败→重试一次"], "exclusive", { slot: other }),
    mkStep("s6_ota_flash_inactive", "ota_flash_inactive", 0.45, 1, ["sha256 不符→拒绝写入并回查修补产物", "dd 中断→槽位状态未知，立即停止"], "exclusive", { slot: other }),
    mkStep("s7_ota_verify", "ota_verify_slot", 0.1, 0.5, ["槽位 sha 与修补产物不一致→unknown_physical_state"], "none", { slot: other }),
    mkStep("s8_reboot", "reboot", 0.1, 1.5, ["10 分钟无 boot_completed→fastboot 刷回备份"], "none", {}, ["重启期间勿断电；卡 logo 按住 音量上 进 recovery"]),
    mkStep("s9_verify_root", "verify_root", 0.1, 0.5, ["root 未生效→检查新槽位 boot 是否含 magiskinit"], "none"),
  ];
  return planOf("ota_keep_root", steps, [
    `OTA 闭环：当前槽位 ${slot}，OTA 落在非活动槽位 ${other}，修补后重启自动切换`,
    "前提：当前系统已 Root 且 Magisk 正常（/data/adb/magisk 存在）",
  ]);
}

// ───────────── 二3：伪回锁 ─────────────
function fakeRelock(state: DeviceState, vars: UtilityVars): Plan {
  const d = evaluateFakeRelock(state);
  if (d.verdict === "deny_hard") {
    throw new OrchestratorError("deny_hard", d.reason, {});
  }
  const soc = String(state.fields.soc ?? "").toLowerCase();
  let path: string;
  if (/qcom|sm\d{4}|sdm|msm/.test(soc)) path = "高通 efisp/devinfo 路径";
  else if (/mt\d{4}/.test(soc)) path = "MTK lk 路径";
  else path = "未确认 SoC（efisp/lk 支持需自行复核）";
  const steps: PlanStep[] = [
    probeStep(),
    mkStep("s2_backup_devinfo", "backup_partition", 0.1, 1, ["节点缺失→部分机型无 devinfo，改备份 lk"], "none", { partition: "devinfo" }),
    mkStep("s3_flash_devinfo", "flash_devinfo", 0.5, 1, [
      "伪装镜像与机型不符→无法开机，用 s2 备份还原", "刷入后 BL 实际仍 unlocked（仅报告位伪装）",
    ], "exclusive", {
      imagePath: vars.devinfoImagePath ?? "",
      verifySHA256: vars.devinfoSha ?? "",
    }, ["进 fastboot：音量下 + 电源"]),
    mkStep("s4_verify_relock", "verify_relock", 0.1, 0.5, ["getvar unlocked 变 no 但实际未锁→属预期伪装"], "none"),
  ];
  return planOf("fake_relock", steps, [
    `SoC 路径：${path}`,
    vars.devinfoImagePath ? `伪装镜像：${vars.devinfoImagePath}` : "未提供 devinfoImagePath：执行到 s3 时会拒绝，需提供与机型匹配的伪装镜像并自核 sha256",
    "诚实提示：伪装回锁不改变实际安全状态；配合 PIF 之外的用途（如保修申报）自行承担后果",
  ]);
}

// ───────────── 二4：跨区刷机 + 基带保护 ─────────────
function crossRegionFlash(state: DeviceState, vars: UtilityVars): Plan {
  const deviceRegion = typeof state.fields.regionCode === "string" ? state.fields.regionCode : null;
  const mismatch = !!vars.region && !!deviceRegion && !deviceRegion.toLowerCase().includes(vars.region.toLowerCase());
  const notes: string[] = [];
  if (vars.region) {
    notes.push(mismatch
      ? `区域码不符：设备 ${deviceRegion} vs 目标 ${vars.region} → 基带/EFS 保护强制生效（modemst1/2、fsg、persist 必须先备份）`
      : `区域码匹配（${deviceRegion}）`);
  } else {
    notes.push(`设备区域码：${deviceRegion ?? "未知"}（未提供目标 region，基带保护按最严格执行）`);
  }
  const steps: PlanStep[] = [
    probeStep(),
    mkStep("s2_region_check", "region_check", 0.05, 0.5, ["区域读取失败→按不符处理"], "none", { expectedRegion: vars.region ?? "" }),
    mkStep("s3_backup_modemst1", "backup_partition", 0.1, 0.5, ["dump 失败→分区节点缺失，记录后继续"], "none", { partition: "modemst1" }),
    mkStep("s4_backup_modemst2", "backup_partition", 0.1, 0.5, ["同上"], "none", { partition: "modemst2" }),
    mkStep("s5_backup_fsg", "backup_partition", 0.1, 0.5, ["同上"], "none", { partition: "fsg" }),
    mkStep("s6_backup_persist", "backup_partition", 0.1, 0.5, ["同上"], "none", { partition: "persist" }),
    mkStep("s7_manifest_check", "backup_manifest_check", 0.05, 0.5, ["清单缺失→deny_auto 拒绝继续"], "none", { backupManifestPath: vars.backupManifestPath ?? "" }),
    mkStep("s8_flash_firmware", "flash_firmware_guide", 0.6, 8, ["固件版本不符→刷写失败回原版", "基带丢失→QCN/EDL 救援（unbrick_qcn）"], "none", {}, [
      "进 fastboot：adb reboot bootloader，或 音量下 + 电源",
    ]),
    mkStep("s9_reboot_verify", "reboot_verify", 0.1, 1.5, ["基带未知→unbrick_qcn 场景"], "none"),
  ];
  return planOf("cross_region_flash", steps, notes);
}

// ───────────── 二5：无 Recovery 救砖 ─────────────
function noRecoveryRescue(vars: UtilityVars): Plan {
  const mode = vars.mode ?? "temp_boot";
  if (mode === "temp_boot") {
    if (!vars.rescueImgPath || !existsSync(vars.rescueImgPath)) {
      throw new OrchestratorError("needs_clarification",
        "temp_boot 需要 recovery/引导镜像（rescueImgPath）：与机型严格匹配的 TWRP/OrangeFox recovery.img", {});
    }
    const steps: PlanStep[] = [
      probeStep(),
      mkStep("s2_rescue_img_check", "rescue_img_check", 0.05, 0.5, ["镜像与机型不符→无法引导"], "none", { rescueImgPath: vars.rescueImgPath, rescueImgSha: vars.rescueImgSha ?? "" }),
      mkStep("s3_fastboot_boot_temp", "fastboot_boot_temp", 0.3, 2, ["临时引导失败→确认 recovery 与固件版本匹配", "卡引导→拔线强制重启"], "exclusive", { rescueImgPath: vars.rescueImgPath }, [
        "进 fastboot：adb reboot bootloader，或 音量下 + 电源",
      ]),
      mkStep("s4_rescue_guide", "rescue_guide", 0.05, 1, ["—"], "none"),
    ];
    return planOf("no_recovery_rescue", steps, [
      "fastboot boot 不落盘：临时启动 recovery，重启即回原系统，适合无 Recovery 且不想刷入的设备",
    ]);
  }
  // disable_modules：Magisk 模块冲突（不能进 recovery 时）
  const steps: PlanStep[] = [
    probeStep(),
    mkStep("s2_verify_root", "verify_root", 0.1, 0.5, ["系统起不来→先走 safe_mode（音量下开机）"], "none"),
    mkStep("s3_disable_module", "disable_module", 0.2, 0.5, ["模块目录不可写→用 Magisk 安全模式替代"], "exclusive", { moduleId: vars.modulesJson ?? "all" }),
    mkStep("s4_reboot", "reboot", 0.1, 1.5, ["仍无法开机→safe_mode 引导（开机时按住 音量下 自动禁用全部模块）"], "none", {}, ["开机时长按 音量下 触发 Magisk 安全模式"]),
  ];
  return planOf("no_recovery_rescue", steps, [
    "disable 文件法：在模块目录写入空 disable 文件，Magisk 下次启动跳过该模块",
  ]);
}

// ───────────── 三1：性能/游戏调优 ─────────────
export const PERF_PROFILES: Record<string, Array<{ path: string; value: string }>> = {
  performance: [
    { path: "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor", value: "performance" },
    { path: "/sys/devices/system/cpu/cpu4/cpufreq/scaling_governor", value: "performance" },
    { path: "/sys/module/lpm_levels/parameters/sleep_disabled", value: "Y" },
  ],
  balanced: [
    { path: "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor", value: "schedutil" },
    { path: "/sys/devices/system/cpu/cpu4/cpufreq/scaling_governor", value: "schedutil" },
    { path: "/sys/module/lpm_levels/parameters/sleep_disabled", value: "N" },
  ],
};

function gamingTune(vars: UtilityVars): Plan {
  const profile = vars.profile === "balanced" ? "balanced" : "performance";
  const paths = PERF_PROFILES[profile];
  const steps: PlanStep[] = [
    probeStep(),
    mkStep("s2_verify_root", "verify_root", 0.1, 0.5, ["未 root→sysfs 不可写"], "none"),
    mkStep("s3_perf_baseline", "perf_baseline", 0.05, 0.5, ["部分路径不存在→逐项容错，记录可读项"], "none", { paths_json: JSON.stringify(paths.map((p) => p.path)) }),
    mkStep("s4_apply_perf_profile", "apply_perf_profile", 0.2, 0.5, ["写入失败→内核 ro 约束，跳过该项", "发热异常→回传 baseline 恢复"], "exclusive", {
      values_json: JSON.stringify(paths),
    }),
    mkStep("s5_tune_report", "tune_report", 0, 0.5, ["—"], "none"),
  ];
  return planOf("gaming_tune", steps, [
    `调优档位：${profile}（sysfs 直写，重启后还原为内核默认；需要持久化建议安装 KernelSU Tuner / Scene 类工具）`,
    "FPS 解锁/温控参数因 SoC 差异极大：本计划只覆盖通用 governor 与休眠开关，具体机型参数在 s5 报告里给出排查方向",
  ]);
}

// ───────────── 三2：隐私与去广告 ─────────────
function privacyModules(vars: UtilityVars): Plan {
  const patches = (JSON.parse(vars.patchesJson ?? "[{\"name\":\"ro.build.tags\",\"value\":\"release-keys\"}]") as Array<{ name: string; value: string }>);
  const steps: PlanStep[] = [
    probeStep(),
    mkStep("s2_verify_root", "verify_root", 0.1, 0.5, ["未 root→走免 Root 方案（rootless）"], "none"),
    mkStep("s3_zygisk_check", "zygisk_check", 0.05, 0.5, ["Zygisk 未启用→Magisk 设置里开启后重启"], "none"),
    mkStep("s4_install_lsposed", "install_module", 0.2, 1, ["LSPosed 仓库迁移→改 resources.ts 别名", "与旧 Xposed 冲突→卸载旧框架"], "exclusive", { module: "lsposed" }),
    mkStep("s5_buildprop_baseline", "buildprop_baseline", 0.05, 0.5, ["属性不可读→跳过该项"], "none", { patches_json: JSON.stringify(patches) }),
    mkStep("s6_apply_buildprop_patch", "apply_buildprop_patch", 0.15, 0.5, ["resetprop 失败→Magisk 版本过旧"], "exclusive", { patches_json: JSON.stringify(patches) }),
    mkStep("s7_reboot", "reboot", 0.1, 1.5, ["模块冲突无法开机→安全模式禁用"], "none", {}, ["重启后如无法开机：开机长按 音量下 触发安全模式"]),
    mkStep("s8_verify_modules", "verify_integrity", 0.1, 0.5, ["—"], "none"),
  ];
  return planOf("privacy_modules", steps, [
    "推荐模块（安装走 install_module 或手动导入 zip，以社区实际发布为准）：静盒去广告（广告拦截）、NFC Hider（隐藏 NFC 硬件特征）",
    "build.prop 补丁走 magisk resetprop（免改动真实 prop 分区，重启可还原）",
  ]);
}

// ───────────── 三3：数据抢救（微信等） ─────────────
function dataRescue(vars: UtilityVars): Plan {
  const mode = vars.mode === "rootless" ? "rootless" : "rooted";
  if (mode === "rooted") {
    const steps: PlanStep[] = [
      probeStep(),
      mkStep("s2_verify_root", "verify_root", 0.1, 0.5, ["未 root→改走 rootless 路线（重调本场景 mode=rootless）"], "none"),
      mkStep("s3_force_stop_mm", "force_stop_app", 0.05, 0.5, ["应用未装→确认包名"], "none", { appPackage: "com.tencent.mm" }),
      mkStep("s4_wechat_backup", "wechat_backup", 0.15, 3, ["数据库被占用→确认已强停", "空间不足→清理 /data/local/tmp"], "exclusive", { appPackage: "com.tencent.mm" }),
      mkStep("s5_backup_verify", "backup_verify", 0.05, 0.5, ["归档为 0 字节→tar 失败，查 stderr"], "none"),
    ];
    return planOf("data_rescue", steps, [
      "有 Root 路线：强停微信 → tar 打包 /data/data/com.tencent.mm（含 EnMicroMsg.db）→ 拉回本机 stateDir/backups/",
      "/sdcard/Android/data 下的媒体目录由 adb pull 单独处理（无 root 也可读）",
    ]);
  }
  const steps: PlanStep[] = [
    probeStep(),
    mkStep("s2_shizuku_start", "shizuku_start", 0.1, 1, ["未配对→开发者选项开无线调试并配对", "脚本路径不存在→安装 Shizuku 后重试"], "none"),
    mkStep("s3_lspatch_guide", "lspatch_guide", 0.1, 5, ["—"], "none"),
  ];
  return planOf("data_rescue", steps, [
    "免 Root 路线：Shizuku（无线调试激活）→ LSPatch 把数据导出模块打进目标 APK → 安装修补包",
    "LSPatch 修补属于应用改动：仅对自有设备/自有数据使用",
  ]);
}

// ───────────── 三4：高级隐藏栈 ─────────────
// 已知互斥组合（只读检查用；随生态更新此表）
const HIDE_CONFLICT_PAIRS: Array<[RegExp, RegExp, string]> = [
  [/nomount|uid[-_]?isolat/i, /shamiko|hide[-_]?my[-_]?applist|mount[-_]?hide/i, "NoMount（UID 隔离）与挂载分流类（Shamiko/HMA）同时启用会互相破坏挂载视图"],
];

function advancedHide(vars: UtilityVars): Plan {
  const stack = vars.stack === "hybrid" ? "hybrid" : "nomount";
  const steps: PlanStep[] = [
    probeStep(),
    mkStep("s2_verify_root", "verify_root", 0.1, 0.5, ["未 root→不可用"], "none"),
    mkStep("s3_vfs_conflict_check", "vfs_conflict_check", 0.05, 0.5, ["发现互斥组合→先禁用其一再安装"], "none"),
    mkStep("s4_install_stack", vars.moduleZipPath ? "install_module" : "stack_guide", 0.2, 1.5, ["模块与 Magisk 版本不兼容→换分支", "安装后无法开机→安全模式禁用"], vars.moduleZipPath ? "exclusive" : "none", {
      module: stack,
      moduleZipPath: vars.moduleZipPath ?? "",
    }),
    mkStep("s5_reboot", "reboot", 0.1, 1.5, ["无法开机→安全模式"], "none", {}, ["重启验证挂载视图；卡 logo 按住 音量下"]),
  ];
  return planOf("advanced_hide", steps, [
    "NoMount（UID 隔离）：目标应用以独立 UID 视图运行，root 可见性最低",
    "Hybrid Mount（挂载分流）：按进程分流挂载，兼容性优于全局 MagiskHide 类方案",
    "s3 为只读 VFS 检查：互斥组合见执行报告，不通过则拒绝安装",
  ]);
}

// ───────────── 三5：免 Root ─────────────
function rootless(vars: UtilityVars): Plan {
  const prefer = vars.prefer === "dsu" ? "dsu" : "shizuku";
  if (prefer === "shizuku") {
    const steps: PlanStep[] = [
      probeStep(),
      mkStep("s2_shizuku_start", "shizuku_start", 0.1, 1, ["未配对→开发者选项开无线调试并配对"], "none"),
      mkStep("s3_shizuku_guide", "shizuku_guide", 0.05, 2, ["—"], "none"),
    ];
    return planOf("rootless", steps, [
      "Shizuku：不解锁不 Root，通过 ADB 特权进程给应用提权（rish / 模块化权限管理）",
      "前提：开发者选项已开无线调试并完成配对（物理操作见步骤）",
    ]);
  }
  const steps: PlanStep[] = [
    probeStep(),
    mkStep("s2_dsu_guide", "dsu_guide", 0.1, 10, ["GSI 架构不符→下载对应 arm64/arm GSI", "DSU 空间不足→预留 ≥8GB"], "none", {}, [
      "设置 → 系统 → 开发者选项 → DSU Loader（选择 GSI 包）",
    ]),
  ];
  return planOf("rootless", steps, [
    "DSU（动态系统更新）：临时引导 GSI 试玩，不影响当前系统，重启即回原系统",
    "GSI 需与设备架构/分区布局匹配（Project Treble 设备）",
  ]);
}

// ───────────── 五：QCN 与 EDL 救砖 ─────────────
function unbrickQcn(state: DeviceState, vars: UtilityVars): Plan {
  const baseband = typeof state.fields.basebandStatus === "string" ? state.fields.basebandStatus : null;
  const notes: string[] = [
    baseband ? `当前基带：${baseband.slice(0, 40)}` : "基带未知/为空：IMEI 可能已丢失，按完整救砖流程走",
  ];
  if (!vars.qcnPath) {
    throw new OrchestratorError("deny_auto",
      "未提供本机 QCN 备份：基带强刷会写空 IMEI/串号。必须先提供此前用 QPST 备份的本机 QCN 文件（未备份过则停止，先找同型号备份或 EFS 专业救援）",
      {
        guide: {
          operation: "unbrick_qcn",
          preconditions: ["已有本机 QCN 备份（.qcn）", "PC 装好 Qualcomm USB QDLoader 9008 驱动", "QPST/QFIL 就绪"],
          steps: [
            "进入 9008 模式（见物理操作）",
            "QFIL：Select Programmer → 加载与机型匹配的 firehose .elf/.mbn（先核对签名）",
            "Tools → QCN Backup 先备份现有内容（哪怕为空，留证据）",
            "Tools → Restore QCN → 选择本机 QCN 文件 → 恢复",
            "重启设备回到 adb，执行 s5 post_verify 校验基带恢复",
          ],
          risks: ["写入他人 QCN = 串号违法且基带异常", "programmer 签名未验证可能熔断安全启动"],
          warnings: [],
        },
      });
  }
  if (!existsSync(vars.qcnPath)) {
    throw new OrchestratorError("resource_corrupted", `QCN 文件不存在：${vars.qcnPath}`, {});
  }
  const steps: PlanStep[] = [
    probeStep(),
    mkStep("s2_edl_entry", "edl_entry_guide", 0.2, 2, ["设备无响应→测试点短接", "驱动未装→设备管理器确认 QDLoader 9008"], "none", {}, [
      "进 9008：关机 → 音量下（或测试点短接）+ USB 连接；设备指示灯/管理器出现 9008 端口",
    ]),
    mkStep("s3_qpst_qfil_guide", "qpst_qfil_guide", 0.4, 10, ["programmer 不匹配→卡在 Sahara/Firehose 握手", "签名未校验→禁止继续"], "none", { qcnPath: vars.qcnPath }, [
      "QFIL：Flat Build → 加载 programmer → Download；Restore QCN → 选本机 QCN",
    ]),
    mkStep("s4_post_verify", "baseband_post_verify", 0.1, 2, ["基带仍为空→重试 QCN 恢复或 EFS 深度救援"], "none"),
  ];
  return planOf("unbrick_qcn", steps, notes);
}

// ───────────── 一：降级 ROM（intent-spec + ARB 硬拦截） ─────────────
export function matchDowngradeCandidates(versionQuery: string, limit = 3): Array<{ id: string; label: string; family: string; androidBase: string; securityPatch: string; score: number; notes: string }> {
  return matchVersionIntent(versionQuery, limit).map((c) => ({
    id: c.id, label: c.label, family: c.family, androidBase: c.androidBase, securityPatch: c.securityPatch, score: c.score, notes: c.notes,
  }));
}

function downgradeRom(state: DeviceState, vars: UtilityVars): Plan {
  const cand = vars.targetVersion ? candidateById(vars.targetVersion) : null;
  const targetPatch = vars.targetPatchLevel ?? cand?.securityPatch;
  if (!targetPatch) {
    throw new OrchestratorError("needs_clarification",
      `未指定目标版本：传 targetVersion（intent-spec 候选 id，如 miui-12.5.8）或直接给 targetPatchLevel。当前特征库候选：${matchDowngradeCandidates(vars.versionQuery ?? "").map((c) => c.id).join("、") || "无（换个描述重试）"}`,
      {});
  }
  const currentPatch = typeof state.fields.securityPatch === "string" ? state.fields.securityPatch : null;
  const arb = evaluateArb({ currentPatch, targetPatch });
  if (arb.verdict === "deny_hard") {
    throw new OrchestratorError("deny_hard", arb.reason, {});
  }
  const steps: PlanStep[] = [
    probeStep(),
    mkStep("s2_backup_modemst1", "backup_partition", 0.1, 0.5, ["节点缺失→记录"], "none", { partition: "modemst1" }),
    mkStep("s3_backup_modemst2", "backup_partition", 0.1, 0.5, ["同上"], "none", { partition: "modemst2" }),
    mkStep("s4_backup_fsg", "backup_partition", 0.1, 0.5, ["同上"], "none", { partition: "fsg" }),
    mkStep("s5_backup_persist", "backup_partition", 0.1, 0.5, ["同上"], "none", { partition: "persist" }),
    mkStep("s6_flash_firmware", "flash_firmware_guide", 0.6, 8, ["ARB 已固化→即使补丁级别允许也失败", "固件区域不符→cross_region_flash 场景"], "none", {}, [
      "进 fastboot：adb reboot bootloader，或 音量下 + 电源",
    ]),
    mkStep("s7_reboot_verify", "reboot_verify", 0.1, 1.5, ["降级后卡开机→双清/重刷"], "none"),
  ];
  return planOf("downgrade_rom", steps, [
    `ARB 比对通过：当前补丁 ${currentPatch ?? "未知"} → 目标 ${targetPatch}${cand ? `（${cand.label}，${cand.notes}）` : ""}`,
    "补丁级别只是必要条件：部分厂商另有独立 anti 版本，fastboot getvar anti 需复核",
  ]);
}

// ───────────── 路由 ─────────────
export function buildUtilityPlan(scenario: UtilityScenario, vars: UtilityVars, state: DeviceState): Plan {
  switch (scenario) {
    case "ota_keep_root": return otaKeepRoot(state);
    case "fake_relock": return fakeRelock(state, vars);
    case "cross_region_flash": return crossRegionFlash(state, vars);
    case "no_recovery_rescue": return noRecoveryRescue(vars);
    case "gaming_tune": return gamingTune(vars);
    case "privacy_modules": return privacyModules(vars);
    case "data_rescue": return dataRescue(vars);
    case "advanced_hide": return advancedHide(vars);
    case "rootless": return rootless(vars);
    case "unbrick_qcn": return unbrickQcn(state, vars);
    case "downgrade_rom": return downgradeRom(state, vars);
    default: throw new OrchestratorError("needs_clarification", `未知场景：${String(scenario)}`, {});
  }
}

export const UTILITY_SCENARIOS: UtilityScenario[] = [
  "ota_keep_root", "fake_relock", "cross_region_flash", "no_recovery_rescue",
  "gaming_tune", "privacy_modules", "data_rescue", "advanced_hide", "rootless",
  "unbrick_qcn", "downgrade_rom",
];

// 供 executeStep 使用的互斥组合检查（只读）
export function findHideConflicts(moduleList: string): string[] {
  const ids = moduleList.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  const conflicts: string[] = [];
  for (const [a, b, why] of HIDE_CONFLICT_PAIRS) {
    const hasA = ids.find((id) => a.test(id));
    const hasB = ids.find((id) => b.test(id));
    if (hasA && hasB) conflicts.push(`${hasA} × ${hasB}：${why}`);
  }
  return conflicts;
}
