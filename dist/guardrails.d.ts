import type { GuideContext } from "./guides.js";
import type { DeviceState, GuardDecision } from "./types.js";
export interface GuardContext extends GuideContext {
    state: DeviceState;
    partition?: string;
    backupPresent?: boolean;
    overrideCleared?: boolean;
}
export declare function evaluate(operation: string, ctx: GuardContext): GuardDecision;
export declare function evaluateArb(input: {
    currentPatch: string | null;
    targetPatch: string;
}): GuardDecision;
export declare function evaluateFakeRelock(state: DeviceState): GuardDecision;
export declare function formatIntercept(operation: string, decision: GuardDecision): string;
