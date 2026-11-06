import { OrchestratorConfig } from "./config.js";
import { DeviceState } from "./types.js";
export type StorageHealthLevel = "ok" | "warning" | "critical";
export declare function classifyStorageHealth(raw: string | null): {
    level: StorageHealthLevel;
    usedValue: number | null;
    raw: string | null;
};
export declare function assertPhysicalHardStops(state: DeviceState): void;
export declare const LARGE_WRITE_PARTITIONS: readonly string[];
export declare function readTemperatureC(cfg: OrchestratorConfig): Promise<number | null>;
