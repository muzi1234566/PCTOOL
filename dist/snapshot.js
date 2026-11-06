import { createHash } from "node:crypto";
import { sha256Buf } from "./hash.js";
import { run } from "./exec.js";
import { readTemperatureC } from "./physical.js";
import { probeDevice } from "./probe.js";
import { P0_FIELDS } from "./types.js";
export function deviceHashOf(fields) {
    const critical = {};
    for (const f of P0_FIELDS)
        critical[f] = fields[f] ?? null;
    return createHash("sha256").update(JSON.stringify(critical)).digest("hex");
}
export function snapshotHash(s) {
    return createHash("sha256").update(JSON.stringify(s)).digest("hex");
}
// 分区哈希：需要已 root 的 adb（su cat 分区节点 → 本地哈希）；失败返回 null，不编造
async function partitionHash(cfg, partition) {
    for (const base of [`/dev/block/bootdevice/by-name/${partition}`, `/dev/block/by-name/${partition}`]) {
        const r = await run(cfg.adbPath, ["exec-out", `su -c cat ${base}`], cfg.cmdTimeoutMs * 8).catch(() => null);
        if (r && r.code === 0 && r.stdoutBuf.length > 0)
            return sha256Buf(r.stdoutBuf);
    }
    return null;
}
export async function captureSnapshot(cfg, partitions = [], opts) {
    const state = await probeDevice(cfg, { fields: ["all"], priority: 0 });
    const criticalFields = {};
    for (const f of P0_FIELDS)
        criticalFields[f] = state.fields[f] ?? null;
    const deviceHash = createHash("sha256").update(JSON.stringify(criticalFields)).digest("hex");
    const partitionHashes = {};
    for (const p of partitions) {
        const h = await partitionHash(cfg, p);
        if (h)
            partitionHashes[p] = h;
    }
    const snap = { timestamp: Date.now(), deviceHash, criticalFields, partitionHashes };
    // 大分区写入：preSnapshot 必含当前温度（fastboot 下读不到 → null，超时提示降级为「温度未知」）
    if (opts?.includeTemperature)
        snap.temperatureC = await readTemperatureC(cfg);
    return snap;
}
