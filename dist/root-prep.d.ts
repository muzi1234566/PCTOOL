import { OrchestratorConfig } from "./config.js";
import { DeviceState } from "./types.js";
export type PatchBackend = "adb-ondevice" | "magiskboot-local" | "manual" | "cache";
export interface PreparedBootFile {
    path: string;
    sha256: string;
}
export interface PreparedRootResources {
    deviceKey: string;
    rootMethod: string;
    managerApk: PreparedBootFile & {
        fromCache: boolean;
    };
    originalBoot: PreparedBootFile | null;
    patchedBoot: (PreparedBootFile & {
        fromCache: boolean;
    }) | null;
    backend: PatchBackend;
    notes: string[];
}
interface ResolveManagerResult {
    cachePath?: string;
    sha256: string;
    fromCache?: boolean;
}
export declare function checkPatchedCache(cfg: OrchestratorConfig, key: string, rootMethod: string): Promise<PreparedBootFile | null>;
export declare function prepareRootResources(cfg: OrchestratorConfig, opts: {
    rootMethod: "magisk" | "kernelsu" | "apatch";
    deviceKey: string;
    bootImagePath: string;
    managerApkPath?: string;
    backend?: PatchBackend | "auto";
    abi?: string;
    state?: DeviceState;
    resolveManager?: (query: string) => Promise<ResolveManagerResult>;
}): Promise<PreparedRootResources>;
export declare function zipProbe(buf: Buffer): number;
export {};
