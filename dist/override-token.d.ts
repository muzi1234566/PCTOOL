import type { OverrideToken } from "./types.js";
export declare function generateToken(operation: string, secretKey: string): OverrideToken;
export declare function verifyToken(token: OverrideToken, operation: string, secretKey: string, now?: number): {
    ok: boolean;
    reason?: string;
};
