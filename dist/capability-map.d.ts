import type { FieldValue, PlanEstimate } from "./types.js";
export interface CapabilitySample {
    intent: "flash" | "root" | string;
    durationMs: number;
    success: boolean;
    mode: "exploration" | "accelerated" | string;
    timestamp: number;
}
export interface CapabilityEntry {
    samples: CapabilitySample[];
}
export interface CapabilityMap {
    version: 1;
    entries: Record<string, CapabilityEntry>;
}
export declare const MIN_SAMPLES_FOR_ESTIMATE = 5;
export declare function capabilityKey(model: string | null, buildId: string | null): string;
export declare function capabilityKeyFromState(fields: Record<string, FieldValue>): string;
export declare function loadCapabilityMap(stateDir: string): CapabilityMap;
export declare function saveCapabilityMap(stateDir: string, map: CapabilityMap): void;
export declare function recordSample(stateDir: string, key: string, sample: CapabilitySample): void;
export declare function percentile(sorted: number[], q: number): number;
/**
 * 历史估算：先按 intent+mode 精确过滤；样本不足放宽 mode；再不足返回 null（调用方兜底默认值）。
 * estimateIntent 映射：root 计划查 "root" 全流程样本；flash_rom 计划查 "flash" 单次刷写样本。
 */
export declare function estimateFromHistory(stateDir: string, key: string, intent: string, mode: string, opts?: {
    minSamples?: number;
}): PlanEstimate | null;
