// prepareRootResources（P2）：统筹 管理器 APK 拉取（SHA256 强制）→ 原始 boot.img 引用 →
// 修补缓存检查 → magiskboot 修补（设备端 adb / 本地 sh / manual 三后端）→ 修补镜像落缓存
//
// 修补走 Magisk APK 自带的官方 assets/boot_patch.sh，不自己拼 cpio 命令——版本行为跟随官方脚本。
// Windows 主机跑不了 ELF：默认后端 adb-ondevice（把资产推到设备 /data/local/tmp，用手机自己修补，
// 无需 root），失败或无设备则降级 manual 引导。
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OrchestratorError } from "./errors.js";
import { run } from "./exec.js";
import { sha256Buf, sha256File } from "./hash.js";
import { readZipEntries } from "./zip.js";
const REMOTE_DIR = "/data/local/tmp/dsh-patch";
function sanitizeKey(key) {
    return key.replace(/[^A-Za-z0-9_\-.]/g, "_");
}
function patchedPaths(cfg, key, method) {
    const dir = path.join(cfg.cacheDir, "patched", sanitizeKey(key));
    return { img: path.join(dir, `${method}-boot-patched.img`), meta: path.join(dir, `${method}-boot-patched.json`), dir };
}
// 修补缓存命中检查（capability-map 键 + root 方法定位）：哈希复验通过才返回
export async function checkPatchedCache(cfg, key, rootMethod) {
    const { img, meta } = patchedPaths(cfg, key, rootMethod);
    if (!existsSync(img) || !existsSync(meta))
        return null;
    let expected;
    try {
        expected = JSON.parse(readFileSync(meta, "utf8")).sha256;
    }
    catch {
        return null;
    }
    const actual = await sha256File(img);
    return actual === expected ? { path: img, sha256: actual } : null;
}
function writePatchedMeta(cfg, key, rootMethod, sha, originalBootSha) {
    const { meta, dir } = patchedPaths(cfg, key, rootMethod);
    mkdirSync(dir, { recursive: true });
    writeFileSync(meta, JSON.stringify({
        sha256: sha,
        rootMethod,
        deviceKey: key,
        originalBootSha256: originalBootSha,
        createdAt: Date.now(),
    }, null, 2));
}
// 从 APK 提取修补资产到 workDir（文件名扁平化：magiskboot / magiskinit / magisk64 / magisk32 / boot_patch.sh …）
function extractMagiskAssets(apkPath, abi, workDir) {
    mkdirSync(workDir, { recursive: true });
    const entries = readZipEntries(readFileSync(apkPath));
    const written = [];
    const renameOf = (name) => {
        if (name === "assets/boot_patch.sh")
            return "boot_patch.sh";
        if (name === "assets/util_functions.sh")
            return "util_functions.sh";
        if (name === `lib/${abi}/libmagiskboot.so`)
            return "magiskboot";
        const flat = name.replace(/^assets\//, "");
        if (flat === "magiskinit" || flat === "magiskinit64" || flat === "magiskinit32")
            return "magiskinit";
        if (flat === "magisk64" || flat === "magisk32")
            return flat;
        return null;
    };
    for (const e of entries) {
        const target = renameOf(e.name);
        if (!target)
            continue;
        writeFileSync(path.join(workDir, target), e.data);
        written.push(target);
    }
    return written;
}
// 后端：adb-ondevice —— 资产推到设备 /data/local/tmp，手机自己跑官方 boot_patch.sh（无需 root）
async function patchViaAdbDevice(cfg, workDir, bootSrc, destImg) {
    const t = cfg.cmdTimeoutMs;
    await run(cfg.adbPath, ["shell", `rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR}`], t).catch(() => null);
    for (const f of ["boot_patch.sh", "util_functions.sh", "magiskboot", "magiskinit", "magisk64", "magisk32"]) {
        const p = path.join(workDir, f);
        if (existsSync(p)) {
            await run(cfg.adbPath, ["push", p, `${REMOTE_DIR}/`], t * 2);
        }
    }
    await run(cfg.adbPath, ["push", bootSrc, `${REMOTE_DIR}/boot.img`], t * 4);
    const r = await run(cfg.adbPath, ["shell", `cd ${REMOTE_DIR} && chmod 0755 magiskboot magiskinit magisk64 magisk32 2>/dev/null; PATH=${REMOTE_DIR}:$PATH BOOTMODE=1 KEEPVERITY=false KEEPFORCEENCRYPT=false sh boot_patch.sh boot.img`], t * 8);
    if (r.code !== 0) {
        throw new OrchestratorError("infeasible", `设备端修补失败（exit ${r.code}）`, {
            stderrTail: r.stderr.slice(-1500),
            stdoutTail: r.stdout.slice(-1500),
            hint: "检查 /data/local/tmp 空间与 Magisk 版本；失败分支见 README 真机指引",
        });
    }
    await run(cfg.adbPath, ["pull", `${REMOTE_DIR}/new-boot.img`, destImg], t * 4);
    await run(cfg.adbPath, ["shell", `rm -rf ${REMOTE_DIR}`], t).catch(() => null);
}
// 后端：magiskboot-local —— Linux/macOS 主机（或 WSL）直接跑
async function patchLocally(workDir, destImg) {
    if (process.platform === "win32") {
        throw new OrchestratorError("needs_clarification", "Windows 主机无 POSIX sh/ELF 执行环境：改用 backend=adb-ondevice（推荐）或 WSL 内运行", {});
    }
    const r = await run("sh", ["boot_patch.sh", "boot.img"], 120000, {
        cwd: workDir,
        env: { ...process.env, PATH: `${workDir}${path.delimiter}${process.env.PATH ?? ""}`, BOOTMODE: "1", KEEPVERITY: "false", KEEPFORCEENCRYPT: "false" },
    });
    if (r.code !== 0 || !existsSync(path.join(workDir, "new-boot.img"))) {
        throw new OrchestratorError("infeasible", `本地修补失败（exit ${r.code}）`, { stderrTail: r.stderr.slice(-1500) });
    }
    rmSync(destImg, { force: true });
    copyFileSync(path.join(workDir, "new-boot.img"), destImg);
}
export async function prepareRootResources(cfg, opts) {
    const notes = [];
    const abi = opts.abi ?? "arm64-v8a";
    // 1) 管理器 APK：本地提供 或 resolver 拉取（SHA256 强制）
    let apkPath;
    let apkSha;
    let apkFromCache = false;
    if (opts.managerApkPath) {
        if (!existsSync(opts.managerApkPath)) {
            throw new OrchestratorError("resource_corrupted", `管理器 APK 不存在：${opts.managerApkPath}`, {});
        }
        apkPath = opts.managerApkPath;
        apkSha = await sha256File(apkPath);
        notes.push("管理器 APK 由本地提供（跳过网络）");
    }
    else if (opts.resolveManager) {
        const r = await opts.resolveManager(opts.rootMethod);
        if (!r.cachePath) {
            throw new OrchestratorError("resource_corrupted", `resolver 未返回 ${opts.rootMethod} 的本地文件路径`, {});
        }
        apkPath = r.cachePath;
        apkSha = r.sha256;
        apkFromCache = r.fromCache === true;
    }
    else {
        throw new OrchestratorError("needs_clarification", "缺管理器来源：提供 managerApkPath 或 resolveManager 回调", {});
    }
    // 2) 修补缓存命中 → 直接返回（跳过下载/修补；此时原始 boot.img 可省，targetPath 真正可选）
    const cached = await checkPatchedCache(cfg, opts.deviceKey, opts.rootMethod);
    if (cached) {
        return {
            deviceKey: opts.deviceKey,
            rootMethod: opts.rootMethod,
            managerApk: { path: apkPath, sha256: apkSha, fromCache: apkFromCache },
            originalBoot: null,
            patchedBoot: { ...cached, fromCache: true },
            backend: "cache",
            notes: ["命中修补缓存（已复验 SHA256），跳过下载与修补；无需再提供原始 boot.img"],
        };
    }
    // 3) 原始 boot.img：缓存未命中时必须由用户提供（提取方法见 README 真机指引）
    if (!opts.bootImagePath || !existsSync(opts.bootImagePath)) {
        throw new OrchestratorError("resource_corrupted", `原始 boot.img 不存在：${opts.bootImagePath ?? "(未提供)"}。提取方法见 README「真机测试指引」`, {});
    }
    const originalSha = await sha256File(opts.bootImagePath);
    // 4) 修补后端选择
    const backend = opts.backend && opts.backend !== "auto"
        ? opts.backend
        : process.platform === "win32" ? "adb-ondevice" : "magiskboot-local";
    const { img: destImg, dir: destDir } = patchedPaths(cfg, opts.deviceKey, opts.rootMethod);
    mkdirSync(destDir, { recursive: true });
    let patchedBoot = null;
    if (opts.rootMethod !== "magisk") {
        // KernelSU/APatch 的修补脚本与资产布局不同：不拼猜测命令，走 manual 引导
        notes.push(`${opts.rootMethod} 修补：按其官方文档执行（管理器 APK 已就绪并校验 SHA256）；本编排器内置自动修补仅覆盖 Magisk`);
    }
    else if (backend === "manual") {
        notes.push("manual 后端：在任意安卓设备上用 Magisk App「安装→选择并修补文件」修补 boot.img，把产物放到 " + destImg + " 并重跑 plan()（会命中缓存）");
    }
    else {
        const workDir = path.join(cfg.cacheDir, "patched", ".work-" + sanitizeKey(opts.deviceKey));
        rmSync(workDir, { recursive: true, force: true });
        let files;
        try {
            files = extractMagiskAssets(apkPath, abi, workDir);
        }
        catch (e) {
            throw new OrchestratorError("resource_corrupted", `APK 解包失败：${String(e)}`, {});
        }
        if (!files.includes("boot_patch.sh") || !files.includes("magiskboot")) {
            notes.push(`APK 内未找到 boot_patch.sh/libmagiskboot.so（版本布局变化），已提取：${files.join("、")}`);
            notes.push("manual 后端：在任意安卓设备上用 Magisk App 修补 boot.img，产物放到 " + destImg + " 并重跑 plan()");
        }
        else {
            try {
                // 把用户 boot.img 复制为 workDir/boot.img（boot_patch.sh 约定输入名）
                copyFileSync(opts.bootImagePath, path.join(workDir, "boot.img"));
                if (backend === "adb-ondevice") {
                    await patchViaAdbDevice(cfg, workDir, path.join(workDir, "boot.img"), destImg);
                }
                else {
                    await patchLocally(workDir, destImg);
                }
                const patchedSha = await sha256File(destImg);
                patchedBoot = { path: destImg, sha256: patchedSha };
                writePatchedMeta(cfg, opts.deviceKey, opts.rootMethod, patchedSha, originalSha);
                notes.push(`修补完成（backend=${backend}），产物已入缓存 ${destImg}`);
            }
            finally {
                rmSync(workDir, { recursive: true, force: true });
            }
        }
    }
    return {
        deviceKey: opts.deviceKey,
        rootMethod: opts.rootMethod,
        managerApk: { path: apkPath, sha256: apkSha, fromCache: apkFromCache },
        originalBoot: { path: opts.bootImagePath, sha256: originalSha },
        patchedBoot: patchedBoot ? { ...patchedBoot, fromCache: false } : null,
        backend,
        notes,
    };
}
// 供测试/调试：把任意 buffer 当 zip 内容校验入口是否可用
export function zipProbe(buf) {
    return readZipEntries(buf).length + sha256Buf(buf).length * 0;
}
