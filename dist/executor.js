// execute_script（P2 收紧）：
// · 参数遮蔽 process/require/module/exports/globalThis/global/self/Function/eval —— 脚本内全部为 undefined
// · api 走 Proxy 白名单：未知属性访问直接抛错（写入/flash 类副作用强制退回 Orchestrator 主入口）
// · 单次执行超时：缺省 5s，硬上限 30s，防脚本卡死宿主
// · 脚本为第一方操作者编写，纯 JS 语法（不做 TS 转译）；本沙箱是约定加固而非对抗性隔离
import { OrchestratorError } from "./errors.js";
import { snapshotHash } from "./snapshot.js";
// 遮蔽的全局名：脚本体内这些标识符解析到 undefined（含 Function/eval，堵构造器逃逸主路）
const SHADOW_NAMES = ["process", "require", "module", "exports", "globalThis", "global", "self", "Function", "eval"];
export const DEFAULT_SCRIPT_TIMEOUT_MS = 5000;
export const MAX_SCRIPT_TIMEOUT_MS = 30000;
function buildSandboxApi(api) {
    const allowed = new Set(Object.keys(api));
    return new Proxy(api, {
        get(target, prop) {
            if (typeof prop !== "string" || !allowed.has(prop)) {
                throw new Error(`脚本沙箱：api.${String(prop)} 不可访问 —— 写入/flash 类副作用必须退回 Orchestrator 主入口`);
            }
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
        },
        set() {
            throw new Error("脚本沙箱：api 不可写入");
        },
    });
}
function withTimeout(p, ms) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new OrchestratorError("timeout", `脚本超时（${ms}ms，硬上限 ${MAX_SCRIPT_TIMEOUT_MS}ms）：若脚本含写入，物理状态未知，下一步必须只读验证`, { timeoutMs: ms })), ms);
        p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}
export class ScriptExecutor {
    api;
    constructor(api) {
        this.api = api;
    }
    async execute(req) {
        const effectiveTimeout = Math.min(req.timeout ?? DEFAULT_SCRIPT_TIMEOUT_MS, MAX_SCRIPT_TIMEOUT_MS);
        const pre = await this.api.captureSnapshot();
        const preHash = snapshotHash(pre);
        let result;
        let postHash;
        try {
            // 参数遮蔽：不使用 "use strict"（strict 下形参不能用 eval/Function 名）
            const fn = new Function(...SHADOW_NAMES, "api", `return (async () => {\n${req.script}\n})();`);
            const sandboxApi = buildSandboxApi(this.api);
            result = await withTimeout(fn(...SHADOW_NAMES.map(() => undefined), sandboxApi), effectiveTimeout);
            const post = await this.api.captureSnapshot();
            postHash = snapshotHash(post);
        }
        catch (e) {
            const timedOut = e instanceof OrchestratorError && e.code === "timeout";
            if (timedOut) {
                // 7.2：物理状态未知 → 审计标记 + 结构化错误，禁止自动重试
                const evt = await this.api.appendAudit({ event: "execute_script:timeout", preSnapshotHash: preHash, postSnapshotHash: "unknown_physical_state", riskScore: 0.4 });
                throw new OrchestratorError("unknown_physical_state", "脚本超时：物理状态未知，禁止自动重试，下一步必须只读验证", { eventId: evt.eventId });
            }
            const post = await this.api.captureSnapshot().catch(() => pre);
            postHash = snapshotHash(post);
            const evt = await this.api.appendAudit({ event: "execute_script:error", preSnapshotHash: preHash, postSnapshotHash: postHash, riskScore: 0.3 });
            if (e instanceof OrchestratorError) {
                throw new OrchestratorError(e.code, e.message, { ...e.details, eventId: evt.eventId });
            }
            throw new OrchestratorError("infeasible", `脚本执行错误：${String(e)}`, { eventId: evt.eventId });
        }
        const evt = await this.api.appendAudit({ event: "execute_script", preSnapshotHash: preHash, postSnapshotHash: postHash, riskScore: 0.2 });
        return { result, eventId: evt.eventId, preHash, postHash };
    }
}
