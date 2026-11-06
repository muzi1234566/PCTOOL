// 三级护栏引擎（第二章）：deny_auto / deny_with_override / deny_hard 决策 + 10.1 拦截话术
import { OrchestratorError } from "./errors.js";
import { guideFor, renderGuide } from "./guides.js";
import { CRITICAL_PARTITIONS, MANUAL_ONLY_PREFIXES, MANUAL_ONLY_OPS } from "./policy.js";
function hard(reason, risk) {
    return { verdict: "deny_hard", reason, riskScore: risk };
}
function auto(operation, reason, risk, ctx) {
    return { verdict: "deny_auto", reason, riskScore: risk, guide: guideFor(operation, ctx) };
}
function override(operation, reason, risk, ctx) {
    return { verdict: "deny_with_override", reason, riskScore: risk, guide: guideFor(operation, ctx) };
}
function isWrite(operation) {
    return (operation.startsWith("flash_") ||
        operation.startsWith("erase_") ||
        operation.startsWith("format_") ||
        operation === "unlock_bootloader" ||
        operation === "super_merge" ||
        operation === "firehose_write");
}
function baseRisk(operation, ctx) {
    if (operation === "flash_boot")
        return 0.35;
    if (operation === "flash_vbmeta_patch")
        return 0.3;
    if (operation.startsWith("flash_"))
        return 0.5;
    if (operation === "unlock_bootloader")
        return 0.8;
    if (operation === "super_merge" || operation === "flash_super" || operation.startsWith("firehose"))
        return 0.85;
    if (operation.startsWith("erase_") || operation.startsWith("format_")) {
        if (CRITICAL_PARTITIONS.includes(ctx.partition ?? ""))
            return 0.9;
        if (ctx.partition === "userdata")
            return 0.7;
        return 0.8;
    }
    return 0.5;
}
// 第四章：P1 读不到 → 风险 +0.2
function riskBump(ctx) {
    return ctx.state.failedP1.length > 0 ? 0.2 : 0;
}
// tries_remaining 不可读的两种形态：N/A（协议下不可读/未采集）与 读取失败（null → failedP1 走降级规则）
function triesUnreadable(state) {
    return state.notApplicable.includes("triesRemaining") || state.fields.triesRemaining === undefined;
}
export function evaluate(operation, ctx) {
    const { state } = ctx;
    const f = state.fields;
    // P0 读取失败 → infeasible（第四章：读不到立即停）
    if (state.failedP0.length > 0) {
        throw new OrchestratorError("infeasible", `P0 字段读取失败，无法决策：${state.failedP0.join("、")}`, {
            failedP0: state.failedP0,
        });
    }
    if (state.protocol === "none") {
        throw new OrchestratorError("infeasible", "未检测到设备：adb 与 fastboot 均无响应", {});
    }
    const write = isWrite(operation);
    const risk = baseRisk(operation, ctx) + riskBump(ctx);
    // —— deny_hard：不可恢复且无法承担判决后果 ——
    if (f.knoxFused === true && write) {
        return hard("Knox 已熔断（warranty bit = 1）：任何写入都会永久固化熔断状态且丧失功能", 1.0);
    }
    if (f.pblFused === true && ["firehose_write", "flash_abl", "flash_xbl"].includes(operation)) {
        return hard("PBL 已熔断：EDL/引导链写入物理上不可行", 1.0);
    }
    if (f.frpActive === true &&
        operation.startsWith("erase_") &&
        ctx.partition !== undefined &&
        CRITICAL_PARTITIONS.includes(ctx.partition)) {
        return hard(`FRP 处于激活状态：擦除 ${ctx.partition} 属不可恢复操作`, 1.0);
    }
    // 6.2：tries_remaining = 1 时写当前 slot 的 boot → infeasible
    if (operation === "flash_boot" && f.triesRemaining !== null && f.triesRemaining !== undefined && Number(f.triesRemaining) === 1) {
        throw new OrchestratorError("infeasible", "当前 slot 重试次数仅剩 1：写 boot 可能失去最后可启动槽位（6.2）", {
            hint: "先 fastboot --set-other=next 再 fastboot set_active other，或提供另一槽位镜像",
        });
    }
    // P1 收紧：tries_remaining N/A（协议下不可读或未采集）+ flash_boot → 直接 deny_auto
    // 仅 +0.2 风险分不够：无法执行 6.2 槽位保护判定时，不允许自动写 boot
    if (operation === "flash_boot" && triesUnreadable(state)) {
        return auto(operation, "tries_remaining 在当前协议下不可读（N/A）：无法执行 6.2 槽位保护判定，flash_boot 强制降级为手动引导", baseRisk(operation, ctx) + 0.2, ctx);
    }
    // —— deny_with_override：会丢失功能但可恢复 ——
    if (!ctx.overrideCleared && f.snapshotUpdateStatus === "merging" && write) {
        return override(operation, "snapshot-update 处于 merging 状态：此时写入会打断合并", risk, ctx);
    }
    if (!ctx.overrideCleared && operation.startsWith("erase_") && ctx.backupPresent !== true &&
        ctx.partition !== undefined && CRITICAL_PARTITIONS.includes(ctx.partition)) {
        return override(operation, `未检测到 ${ctx.partition} 的有效备份清单：擦除将丢失功能（可 EDL 恢复但代价极高）`, risk, ctx);
    }
    // —— 2.3 绝对禁令：erase/format/unlock/abl/xbl/firehose/super 永远只生成引导，令牌也不能放行自动执行 ——
    if (MANUAL_ONLY_OPS.has(operation) || MANUAL_ONLY_PREFIXES.some((p) => operation.startsWith(p))) {
        return auto(operation, `该操作（${operation}）属永久/高危类：按规范永不自动执行，仅提供手动引导（Override 令牌也只放行引导，不放行自动执行）`, risk, ctx);
    }
    // P1 缺失 + 写操作 → 强制降级为手动引导（第四章）
    if (state.failedP1.length > 0 && write) {
        return auto(operation, `P1 字段缺失（${state.failedP1.join("、")}）：风险上调 0.2，强制降级为手动引导`, risk, ctx);
    }
    return { verdict: "allow", riskScore: risk, degraded: state.degraded };
}
// v3 一：ARB（防回滚）硬拦截——降级动作必须先比对安全补丁级别
export function evaluateArb(input) {
    const cur = input.currentPatch;
    if (cur && input.targetPatch.slice(0, 10) < cur.slice(0, 10)) {
        // YYYY-MM-DD 字典序即时间序：目标更旧 → 降级 → ARB 熔断风险
        return {
            verdict: "deny_hard",
            reason: `降级将导致 ARB 熔断变砖：目标安全补丁级别 ${input.targetPatch.slice(0, 10)} 早于当前 ${cur.slice(0, 10)}（eFuse 熔断不可逆，fastboot getvar anti 已固化的机型必死）`,
            riskScore: 1.0,
        };
    }
    return { verdict: "allow", riskScore: 0.5, degraded: false };
}
// v3 二：伪回锁（Fake Relock）——三星设备无条件 deny_hard
export function evaluateFakeRelock(state) {
    const model = String(state.fields.deviceModel ?? "").toLowerCase();
    const samsung = state.fields.knoxFused === true || /samsung|^sm-/.test(model);
    if (samsung) {
        return {
            verdict: "deny_hard",
            reason: "三星设备禁止伪回锁：KNOX 熔断不可逆（0x1），eFuse 状态无法伪装，任何 lk/devinfo 伪装写入只会固化熔断并永久丧失支付/DRM 功能",
            riskScore: 1.0,
        };
    }
    return { verdict: "allow", riskScore: 0.7, degraded: false };
}
// 10.1 危险操作拦截话术
export function formatIntercept(operation, decision) {
    if (decision.verdict === "deny_hard") {
        return `【高风险拦截·硬阻断】检测到您试图执行 ${operation}。${decision.reason}。该操作不可恢复，系统已启用 deny_hard，不提供任何绕过路径。`;
    }
    if (decision.verdict === "deny_with_override") {
        return [
            `【高风险拦截】检测到您试图执行 ${operation}。该操作不可逆，且由于 ${decision.reason}，系统已启用 deny_with_override。`,
            "请查阅以下手动执行引导及风险报告，并在 5 分钟内回传 Override Token（generateOverride → submitOverride）：",
            renderGuide(decision.guide),
        ].join("\n");
    }
    if (decision.verdict === "deny_auto") {
        return [
            `【高风险拦截】检测到您试图执行 ${operation}。该操作不可逆，且由于 ${decision.reason}，系统已启用 deny_auto。`,
            "请查阅以下手动执行引导及风险报告：",
            renderGuide(decision.guide),
        ].join("\n");
    }
    return `【高风险拦截】操作 ${operation} 未生成拦截决策（allow 状态不应进入本函数）。`;
}
