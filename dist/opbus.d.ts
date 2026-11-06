import { run } from "./exec.js";
import type { OrchestratorConfig } from "./config.js";
export type OpAction = "write_partition" | "boot_temp" | "reboot" | "reboot_bootloader" | "push_file" | "sysfs_write" | "install_module_zip" | "ui_tap" | "wake_unlock" | "fs_trim" | "shell_read";
export interface StructuredOp {
    action: OpAction;
    target?: string;
    file?: string;
    value?: string;
}
export interface MaterializedCmd {
    kind: "adb" | "fastboot";
    args: string[];
}
export declare function assertOp(input: unknown): asserts input is StructuredOp;
export declare function materialize(op: StructuredOp): MaterializedCmd;
export declare function runStructured(cfg: OrchestratorConfig, op: StructuredOp, timeoutMs?: number): Promise<ReturnType<typeof run>>;
