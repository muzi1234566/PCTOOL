export declare const SECURE_METHODS: readonly ["secure_erase", "sanitize", "blksecdiscard"];
export interface BackupEntry {
    path: string;
    sha256: string;
}
export declare function validateBackupManifest(manifestPath?: string): boolean;
export declare function isSecureMethod(method: string): boolean;
