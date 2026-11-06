import { OrchestratorConfig } from "./config.js";
import { SparseInfo } from "./sparse.js";
import { FlashPartitionRequest } from "./types.js";
export interface FlashPrecheck {
    ok: boolean;
    deviceIsAb: boolean;
    resolvedSlot: "a" | "b" | null;
    fastbootPartition: string;
    imageToFlash: string;
    sparse?: SparseInfo;
}
export declare function flashPrecheck(cfg: OrchestratorConfig, req: FlashPartitionRequest, metadataRanges?: Array<{
    startBlock: number;
    blocks: number;
}>): Promise<FlashPrecheck>;
export declare function flashImage(cfg: OrchestratorConfig, req: FlashPartitionRequest, precheck: FlashPrecheck): Promise<{
    output: string;
}>;
