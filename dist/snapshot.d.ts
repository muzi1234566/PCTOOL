import { OrchestratorConfig } from "./config.js";
import { FieldValue, Snapshot } from "./types.js";
export declare function deviceHashOf(fields: Record<string, FieldValue>): string;
export declare function snapshotHash(s: Snapshot): string;
export declare function captureSnapshot(cfg: OrchestratorConfig, partitions?: string[], opts?: {
    includeTemperature?: boolean;
}): Promise<Snapshot>;
