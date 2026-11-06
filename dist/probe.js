import { OrchestratorError } from "./errors.js";
import { parseGetvar, run } from "./exec.js";
import { P0_FIELDS, P1_FIELDS, P2_FIELDS } from "./types.js";
const REMEDIES = {
    protocol: "检查 USB 连接/驱动/授权弹窗",
    currentSlot: "重启到 fastboot：adb reboot bootloader",
    snapshotUpdateStatus: "重启到 fastboot 读取：adb reboot bootloader",
    oemUnlockChannel: "需要 adb 授权（接受调试弹窗）",
    arbFused: "仅小米类机型支持 fastboot getvar anti",
    pblFused: "需要 EDL（9008）编程器会话判定",
    frpActive: "需要 adb 授权",
    knoxFused: "需要 adb 授权（三星机型）",
    triesRemaining: "重启到 fastboot：adb reboot bootloader",
    storageHealth: "需要 adb；部分 UFS 机型无 eMMC life_time 节点",
    batteryLevel: "需要 adb 授权",
    widevineRecoverability: "需要 adb 授权；属性缺失时不可判",
    escapePathReady: "需要 fastboot 可用或 OEM 解锁通道开启",
};
// 一次 shell 调用拉全部属性 + 电池 + 存储健康；marker 行便于按行解析（值可含空格）
const ADB_PROPS = [
    "ro.boot.slot_suffix",
    "sys.oem_unlock_allowed",
    "ro.frp.pst",
    "ro.boot.warranty_bit",
    "ro.warranty_bit",
    "ro.boot.widevine.base.security_level",
    "ro.vendor.widevine.base.security_level",
    "ro.product.model",
    "ro.build.id",
    "ro.build.version.security_patch", // v3：ARB 降级比对
    "ro.board.platform", // v3：伪回锁 SoC 支持判定（qcom/mtk）
    "ro.csc", // v3：跨区刷机区域码
    "gsm.version.baseband", // v3：基带未知/救砖探测
    "ro.serialno", // v3：多设备防呆
];
async function adbBatch(cfg) {
    const out = new Map();
    const cmd = [
        ...ADB_PROPS.map((p, i) => `echo __P${i}__=$(getprop ${p})`),
        "echo __KERNEL__=$(uname -r)",
        "echo __LIFE__=$(cat /sys/block/mmcblk0/device/life_time 2>/dev/null)",
        "dumpsys battery 2>/dev/null | grep -E '^  level:'",
    ].join("; ");
    try {
        const r = await run(cfg.adbPath, ["shell", cmd], cfg.cmdTimeoutMs);
        const text = r.stdout;
        ADB_PROPS.forEach((p, i) => {
            const m = new RegExp(`^__P${i}__=(.*)$`, "m").exec(text);
            if (m && m[1].trim().length > 0)
                out.set(p, m[1].trim());
        });
        const kernel = /^__KERNEL__=(.*)$/m.exec(text);
        if (kernel && kernel[1].trim().length > 0)
            out.set("__kernel__", kernel[1].trim());
        const life = /^__LIFE__=(.*)$/m.exec(text);
        if (life && life[1].trim().length > 0)
            out.set("__life_time__", life[1].trim());
        const level = /level:\s*(\d+)/.exec(text);
        if (level)
            out.set("__battery__", level[1]);
    }
    catch {
        /* 整批失败 → 所有字段按读取失败处理，不静默编造 */
    }
    return out;
}
async function detectAndCollect(cfg) {
    // adb 快判（2s 短超时）；命中后一次批量 shell
    const adbState = await run(cfg.adbPath, ["get-state"], 2000).catch(() => null);
    if (adbState && adbState.code === 0 && adbState.stdout.trim() === "device") {
        return { protocol: "adb", fbVars: new Map(), props: await adbBatch(cfg) };
    }
    // fastboot：单次 getvar all = 判定 + 全量变量
    const fb = await run(cfg.fastbootPath, ["getvar", "all"], cfg.cmdTimeoutMs).catch(() => null);
    if (fb) {
        const vars = parseGetvar(`${fb.stdout}\n${fb.stderr}`);
        if (vars.size > 0)
            return { protocol: "fastboot", fbVars: vars, props: new Map() };
    }
    return { protocol: "none", fbVars: new Map(), props: new Map() };
}
const KNOWN = [...P0_FIELDS, ...P1_FIELDS, ...P2_FIELDS].filter((f) => f !== "protocol");
function fieldsForPriority(priority) {
    if (priority === 0)
        return [...P0_FIELDS].filter((f) => f !== "protocol");
    if (priority === 1)
        return [...P0_FIELDS, ...P1_FIELDS].filter((f) => f !== "protocol");
    return [...KNOWN]; // priority 2：全量（含 P2 诊断字段 deviceModel/buildId）
}
function derive(batch, requested) {
    const { protocol, fbVars, props } = batch;
    const fields = { protocol };
    const failedP0 = [];
    const failedP1 = [];
    const notApplicable = [];
    const put = (name, outcome) => {
        if (!requested.includes(name))
            return;
        fields[name] = outcome.value;
        if (!outcome.applicable) {
            notApplicable.push(name);
            return;
        }
        if (outcome.value === null) {
            // P2 失败仅丢诊断信息，不计入降级（规范第四章）
            if (P0_FIELDS.includes(name))
                failedP0.push(name);
            else if (P1_FIELDS.includes(name))
                failedP1.push(name);
        }
    };
    if (protocol === "adb") {
        const prop = (k) => props.get(k) ?? null;
        put("currentSlot", { applicable: true, value: prop("ro.boot.slot_suffix")?.replace("_", "") ?? null });
        put("oemUnlockChannel", { applicable: true, value: prop("sys.oem_unlock_allowed") });
        const frp = props.get("ro.frp.pst");
        put("frpActive", { applicable: true, value: frp === undefined ? null : frp.length > 0 });
        const knox = props.get("ro.boot.warranty_bit") ?? props.get("ro.warranty_bit");
        put("knoxFused", { applicable: true, value: knox === undefined ? null : knox === "1" });
        put("widevineRecoverability", {
            applicable: true,
            value: props.get("ro.boot.widevine.base.security_level") ?? props.get("ro.vendor.widevine.base.security_level") ?? null,
        });
        put("storageHealth", { applicable: true, value: props.get("__life_time__") ?? null });
        const bat = props.get("__battery__");
        put("batteryLevel", { applicable: true, value: bat ? Number(bat) : null });
        put("deviceModel", { applicable: true, value: prop("ro.product.model") });
        put("buildId", { applicable: true, value: prop("ro.build.id") });
        put("securityPatch", { applicable: true, value: prop("ro.build.version.security_patch") });
        put("soc", { applicable: true, value: prop("ro.board.platform") });
        put("regionCode", { applicable: true, value: prop("ro.csc") });
        put("basebandStatus", { applicable: true, value: prop("gsm.version.baseband") });
        put("kernelVersion", { applicable: true, value: props.get("__kernel__") ?? null });
        put("deviceSerial", { applicable: true, value: prop("ro.serialno") });
        put("escapePathReady", { applicable: true, value: props.get("sys.oem_unlock_allowed") === "1" });
        // fastboot-only 字段在 adb 协议下 N/A
        for (const n of ["snapshotUpdateStatus", "triesRemaining", "arbFused", "pblFused"]) {
            put(n, { applicable: false, value: null });
        }
    }
    else if (protocol === "fastboot") {
        const v = (name) => fbVars.get(name) ?? null;
        put("currentSlot", { applicable: true, value: v("current-slot") });
        put("snapshotUpdateStatus", { applicable: true, value: v("snapshot-update-status") });
        const anti = v("anti");
        put("arbFused", { applicable: true, value: anti === null ? null : Number(anti) >= 1 });
        const slot = v("current-slot");
        const retryRaw = slot ? v(`slot-retry-count:${slot}`) : null;
        put("triesRemaining", { applicable: true, value: retryRaw === null ? null : Number(retryRaw) });
        put("deviceModel", { applicable: true, value: v("product") });
        put("deviceSerial", { applicable: true, value: v("serialno") }); // v3：fastboot 下多设备防呆
        put("escapePathReady", { applicable: true, value: true });
        // adb-only / EDL-only 字段在 fastboot 协议下 N/A
        for (const n of ["oemUnlockChannel", "frpActive", "knoxFused", "pblFused", "storageHealth", "batteryLevel", "widevineRecoverability", "buildId", "securityPatch", "soc", "regionCode", "basebandStatus", "kernelVersion"]) {
            put(n, { applicable: false, value: null });
        }
    }
    else {
        for (const n of KNOWN)
            put(n, { applicable: false, value: null });
    }
    return {
        protocol,
        fields,
        degraded: failedP1.length > 0,
        failedP0,
        failedP1,
        notApplicable,
        readAt: Date.now(),
    };
}
export async function probeDevice(cfg, req) {
    const batch = await detectAndCollect(cfg);
    const requested = req.fields.includes("all")
        ? fieldsForPriority(req.priority)
        : req.fields.filter((f) => f !== "protocol");
    return derive(batch, requested);
}
// P0 断言：require 是本次操作真正依赖的字段集（全量写操作传默认；计划阶段只传 protocol/currentSlot）
export function assertP0(state, require = [...P0_FIELDS]) {
    if (state.protocol === "none" && require.includes("protocol")) {
        throw new OrchestratorError("infeasible", "未检测到设备：adb 与 fastboot 均无响应（检查连接/驱动/授权）", {});
    }
    const missing = require.filter((f) => state.failedP0.includes(f));
    if (missing.length > 0) {
        throw new OrchestratorError("infeasible", `P0 字段读取失败，立即停止：${missing.join("、")}`, {
            failed: missing,
            remedies: missing.map((f) => REMEDIES[f] ?? "进入手动模式"),
        });
    }
}
export { REMEDIES };
