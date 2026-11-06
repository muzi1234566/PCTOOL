import { OrchestratorConfig } from "./config.js";
import { OrchestratorError, ErrorCode } from "./errors.js";
import { ClarifyResult, Intent, IntentVariables } from "./planner.js";
import { PatchBackend, PreparedRootResources } from "./root-prep.js";
import { UtilityScenario, UtilityVars } from "./scenarios.js";
import { NodeMatcher } from "./ui-auto.js";
import { DeviceState, ErasePartitionRequest, ExecuteScriptRequest, FlashPartitionRequest, ManualGuide, OverrideToken, Plan, Priority, ResourceResolverRequest, Snapshot, StepResult } from "./types.js";
declare function stepResult(step: string, status: StepResult["status"], o: {
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
}): StepResult;
export interface RecoveryReport {
    planId: string | null;
    resumedFrom: string | null;
    eventCount: number;
    interrupted: boolean;
    pendingStep: {
        operation: string;
        stepId: string;
        preSnapshotHash: string;
        startedAt: number;
    } | null;
    verified: boolean;
}
export declare class Orchestrator {
    readonly cfg: OrchestratorConfig;
    private readonly barrier;
    private readonly audit;
    private headHash;
    private context;
    private readonly plans;
    private readonly planRuns;
    private readonly baselineStore;
    private readonly scratch;
    private boundSerial;
    private fastbootTimeoutStreak;
    private readonly prefetchDone;
    private readonly usedTokenIds;
    private readonly executor;
    constructor(partial?: Partial<OrchestratorConfig>);
    probe(fields?: string[], priority?: Priority): Promise<DeviceState>;
    resolveResource(query: string, sources?: ResourceResolverRequest["sources"], requireSHA256?: boolean): Promise<import("./resources.js").ResolvedResource>;
    probeBundle(): Promise<{
        state: DeviceState;
        magisk: import("./resources.js").ResolvedResource | {
            error: string;
        };
        vbmetaPatch: import("./resources.js").ResolvedResource | {
            error: string;
        };
        health: {
            storageHealth: string | number | boolean | null;
            batteryLevel: string | number | boolean | null;
            deviceModel: string | number | boolean | null;
            buildId: string | number | boolean | null;
        };
    }>;
    clarify(intent: Intent, vars: IntentVariables): ClarifyResult;
    plan(intent: Intent, vars: IntentVariables): Promise<Plan | ClarifyResult>;
    prepareRootResources(opts?: {
        rootMethod?: "magisk" | "kernelsu" | "apatch";
        bootImagePath?: string;
        managerApkPath?: string;
        backend?: PatchBackend | "auto";
        abi?: string;
        state?: DeviceState;
    }): Promise<PreparedRootResources>;
    private hasCachedResources;
    private bindSerialFrom;
    private assertTarget;
    private assertTargetLive;
    planUtility(scenario: UtilityScenario, vars: UtilityVars): Promise<Plan>;
    executeStep(planId: string, stepId: string): Promise<StepResult>;
    private guideOnlyStep;
    flash(req: FlashPartitionRequest): Promise<StepResult>;
    flashVbmeta(o: {
        imagePath: string;
        verifySHA256: string;
        disableVerity?: boolean;
        disableVerification?: boolean;
        subImages?: Record<string, string>;
    }): Promise<StepResult>;
    erase(req: ErasePartitionRequest): Promise<StepResult>;
    executeScript(req: ExecuteScriptRequest): Promise<StepResult>;
    generateOverride(operation: string): {
        token: OverrideToken;
        note: string;
    };
    submitOverride(token: OverrideToken, operation: string): {
        ok: boolean;
        reason?: string;
    };
    /**
     * 恢复第一步绝对不是续跑：
     * · 无挂起步骤 → 正常返回续跑点
     * · 有 pendingStep（崩在中途）→ 先 probeBundle 只读探测 + 快照比对：
     *   不一致 → 步骤强制置 unknown_physical_state，抛错要求手动验证
     *   一致   → 清除挂起标记，允许从该操作之后继续
     */
    recover(): Promise<RecoveryReport>;
    private resolveOverride;
    private intercepted;
    private errorToStep;
    private adbShellChecked;
    uiConfirm(matcher: NodeMatcher, timeoutMs?: number): Promise<import("./ui-auto.js").UiConfirmResult>;
    private prefetchAsync;
    private deviceReboot;
    private appendAudit;
    private recordCapability;
    private ensureContext;
    private markPending;
    private clearPendingStep;
    private persistContext;
    private buildScriptApi;
}
export { OrchestratorError, stepResult };
export type { DeviceState, Plan, StepResult, ManualGuide, OverrideToken, ClarifyResult, Intent, IntentVariables, Snapshot };
