// 配置解析（P2：默认目录迁到 ~/.dsh-orchestrator/{state,cache}），密钥持久化到 stateDir
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
function loadOrCreateSecret(stateDir) {
    const file = path.join(stateDir, "secret.key");
    if (existsSync(file))
        return readFileSync(file, "utf8").trim();
    const key = randomBytes(32).toString("hex");
    writeFileSync(file, key, { mode: 0o600 });
    try {
        chmodSync(file, 0o600); // Windows 上 mode 参数不生效，补一次显式 chmod
    }
    catch {
        /* 权限位不生效不致命：密钥文件仍在用户目录下 */
    }
    return key;
}
export function resolveConfig(partial = {}) {
    const dshRoot = path.join(os.homedir(), ".dsh-orchestrator");
    const stateDir = partial.stateDir ?? path.join(dshRoot, "state");
    const cacheDir = partial.cacheDir ?? path.join(dshRoot, "cache");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    return {
        adbPath: partial.adbPath ?? "adb",
        fastbootPath: partial.fastbootPath ?? "fastboot",
        stateDir,
        cacheDir,
        secretKey: partial.secretKey ?? loadOrCreateSecret(stateDir),
        cmdTimeoutMs: partial.cmdTimeoutMs ?? 30000,
        mirrorBase: partial.mirrorBase,
        onDeviceDownload: partial.onDeviceDownload ?? false,
    };
}
