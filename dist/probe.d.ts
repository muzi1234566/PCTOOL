import { OrchestratorConfig } from "./config.js";
import { DeviceState, ProbeDeviceRequest } from "./types.js";
declare const REMEDIES: Record<string, string>;
export declare function probeDevice(cfg: OrchestratorConfig, req: ProbeDeviceRequest): Promise<DeviceState>;
export declare function assertP0(state: DeviceState, require?: string[]): void;
export { REMEDIES };
