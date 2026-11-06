import type { DeviceState, Plan } from "./types.js";
export type UtilityScenario = "ota_keep_root" | "fake_relock" | "cross_region_flash" | "no_recovery_rescue" | "gaming_tune" | "privacy_modules" | "data_rescue" | "advanced_hide" | "rootless" | "unbrick_qcn" | "downgrade_rom";
export interface UtilityVars {
    versionQuery?: string;
    targetVersion?: string;
    targetPatchLevel?: string;
    region?: string;
    backupManifestPath?: string;
    rescueImgPath?: string;
    rescueImgSha?: string;
    mode?: string;
    prefer?: string;
    profile?: string;
    stack?: string;
    moduleZipPath?: string;
    modulesJson?: string;
    patchesJson?: string;
    qcnPath?: string;
    devinfoImagePath?: string;
    devinfoSha?: string;
    deviceSerial?: string;
}
export declare function checkSerialMatch(bound: string | null, current: string | null): void;
export declare function isAbDevice(state: DeviceState): boolean;
export declare const PERF_PROFILES: Record<string, Array<{
    path: string;
    value: string;
}>>;
export declare function matchDowngradeCandidates(versionQuery: string, limit?: number): Array<{
    id: string;
    label: string;
    family: string;
    androidBase: string;
    securityPatch: string;
    score: number;
    notes: string;
}>;
export declare function buildUtilityPlan(scenario: UtilityScenario, vars: UtilityVars, state: DeviceState): Plan;
export declare const UTILITY_SCENARIOS: UtilityScenario[];
export declare function findHideConflicts(moduleList: string): string[];
