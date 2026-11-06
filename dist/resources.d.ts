import { OrchestratorConfig } from "./config.js";
import { ResourceResolverRequest } from "./types.js";
export interface ResolvedResource {
    url: string;
    sha256: string;
    size: number;
    metadata: Record<string, unknown>;
    cachePath?: string;
    fromCache: boolean;
}
export declare function raceDownload(url: string, dest: string, expected: {
    sha256: string;
    size: number;
}): Promise<{
    mirror: string;
    ms: number | null;
}>;
export declare const ONDEVICE_MIN_BYTES: number;
export declare function shouldDownloadOnDevice(size: number, enabled: boolean): boolean;
export declare function resolveResource(cfg: OrchestratorConfig, req: ResourceResolverRequest): Promise<ResolvedResource>;
