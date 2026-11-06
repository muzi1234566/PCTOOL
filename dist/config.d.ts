export interface OrchestratorConfig {
    adbPath: string;
    fastbootPath: string;
    stateDir: string;
    cacheDir: string;
    secretKey: string;
    cmdTimeoutMs: number;
    mirrorBase?: string;
    onDeviceDownload?: boolean;
}
export declare function resolveConfig(partial?: Partial<OrchestratorConfig>): OrchestratorConfig;
