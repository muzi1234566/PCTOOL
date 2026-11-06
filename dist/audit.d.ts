import type { AuditEvent, AuditLogRequest } from "./types.js";
export declare const GENESIS = "GENESIS";
export declare function hashEvent(previousEventHash: string, e: {
    eventId: string;
    timestamp: number;
    operation: string;
    riskScore: number;
}): string;
export declare class AuditLog {
    private readonly file;
    constructor(file: string);
    append(req: AuditLogRequest, previousEventHash: string): AuditEvent;
    load(): {
        events: AuditEvent[];
        headHash: string;
    };
}
