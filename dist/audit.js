// 链式哈希审计日志（7.3）：append-only JSONL，PII 剔除，篡改可检测
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
export const GENESIS = "GENESIS";
// 审计剔除 PII（IMEI/MAC/序列号），保留设备快照哈希与操作语义
const PII_PATTERNS = [
    [/\b\d{15}\b/g, "[REDACTED-IMEI]"],
    [/\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g, "[REDACTED-MAC]"],
    [/\b(?:[0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}\b/g, "[REDACTED-MAC]"],
    [/"(imei|serial(?:_no|number)?|mac|meid)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"'],
];
function redact(s) {
    let out = s;
    for (const [re, sub] of PII_PATTERNS)
        out = out.replace(re, sub);
    return out;
}
// currentEventHash = SHA256(previousEventHash + eventId + timestamp + operation + riskScore)
export function hashEvent(previousEventHash, e) {
    return createHash("sha256")
        .update(`${previousEventHash}|${e.eventId}|${e.timestamp}|${e.operation}|${e.riskScore}`)
        .digest("hex");
}
export class AuditLog {
    file;
    constructor(file) {
        this.file = file;
    }
    append(req, previousEventHash) {
        const e = {
            eventId: randomUUID(),
            timestamp: Date.now(),
            operation: redact(req.event),
            preSnapshotHash: redact(req.preSnapshotHash),
            postSnapshotHash: redact(req.postSnapshotHash),
            previousEventHash,
            currentEventHash: "",
            riskScore: req.riskScore,
            ...(req.overrideToken !== undefined ? { overrideToken: redact(req.overrideToken) } : {}),
        };
        e.currentEventHash = hashEvent(previousEventHash, e);
        appendFileSync(this.file, `${JSON.stringify(e)}\n`);
        return e;
    }
    load() {
        if (!existsSync(this.file))
            return { events: [], headHash: GENESIS };
        const lines = readFileSync(this.file, "utf8").split("\n").filter((l) => l.trim().length > 0);
        const events = [];
        let prev = GENESIS;
        for (const line of lines) {
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                // 末行可能是崩溃时写了一半的记录：截断容忍，不中断恢复
                break;
            }
            const expected = hashEvent(parsed.previousEventHash, parsed);
            if (parsed.previousEventHash !== prev || parsed.currentEventHash !== expected) {
                throw new Error(`审计链在事件 ${parsed.eventId} 处校验失败：日志被篡改或损坏`);
            }
            prev = parsed.currentEventHash;
            events.push(parsed);
        }
        return { events, headHash: prev };
    }
}
