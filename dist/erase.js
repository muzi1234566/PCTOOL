// erase_partition（第一章接口 + 6.6）：永不自动执行（2.3），只做校验 + 生成手动引导
import { existsSync, readFileSync } from "node:fs";
export const SECURE_METHODS = ["secure_erase", "sanitize", "blksecdiscard"];
// requireBackup 的证据：备份清单文件存在、可解析、且清单内每个文件都存在
export function validateBackupManifest(manifestPath) {
    if (!manifestPath || !existsSync(manifestPath))
        return false;
    try {
        const list = JSON.parse(readFileSync(manifestPath, "utf8"));
        return Array.isArray(list) && list.length > 0 && list.every((e) => typeof e.path === "string" && existsSync(e.path));
    }
    catch {
        return false;
    }
}
export function isSecureMethod(method) {
    return SECURE_METHODS.includes(method);
}
