import type { DeviceState, FieldValue, Plan, PlanEstimate, PlanStep } from "./types.js";
export type Intent = "root" | "unlock" | "erase_userdata" | "flash_rom" | "rescue";
export interface IntentVariables {
    root_method?: "magisk" | "apatch" | "kernelsu";
    hide_target?: boolean;
    bootloader_status?: "unlocked" | "locked" | "unknown";
    backup_preference?: "full" | "critical_only" | "none";
    target_slot?: "a" | "b" | "current";
    vbmeta_state?: "keep_avb" | "disable_verity";
    bootImagePath?: string;
    managerApkPath?: string;
    patchBackend?: "adb-ondevice" | "magiskboot-local" | "manual" | "auto";
    rootPersistence?: "temporary" | "permanent";
}
export type ClarifyResult = {
    status: "needs_clarification";
    missing_variables: string[];
    message: string;
} | {
    status: "ok";
    intent: Intent;
    vars: IntentVariables;
};
export declare function expandIntent(intent: Intent, vars: IntentVariables): ClarifyResult;
declare function step(id: string, operation: string, risk: number, minutes: number, branches: string[], barrier: PlanStep["barrier"], params?: Record<string, FieldValue>, preheat?: boolean, physicalOps?: string[]): PlanStep;
export declare const mkStep: typeof step;
export interface PlanInput {
    intent: Intent;
    vars: IntentVariables;
    state: DeviceState;
    cacheHit: boolean;
    estimate?: PlanEstimate;
}
export declare function wallClock(steps: PlanStep[]): string;
export declare function generatePlan(input: PlanInput): Plan;
export {};
