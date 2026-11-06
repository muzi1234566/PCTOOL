import { AuditLog } from "./audit.js";
import { DeviceContext, AuditEvent, PendingStep } from "./types.js";
export declare function saveContext(stateDir: string, ctx: DeviceContext): void;
export declare function loadContext(stateDir: string): DeviceContext | null;
export interface RecoveryResult {
    ctx: DeviceContext;
    events: AuditEvent[];
    pendingStep: PendingStep | null;
    interrupted: boolean;
    resumedAtStep: string | null;
}
export declare function recoverSession(stateDir: string, audit: AuditLog): RecoveryResult | null;
