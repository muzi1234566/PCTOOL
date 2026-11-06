// 进程执行层：spawn 超时强杀（Windows 用 taskkill /t 杀进程树），getvar 输出解析
import { spawn } from "node:child_process";
import { OrchestratorError } from "./errors.js";
export function run(cmd, args, timeoutMs, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { windowsHide: true, cwd: opts.cwd, env: opts.env });
        const outChunks = [];
        const errChunks = [];
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child);
        }, Math.max(timeoutMs, 1000));
        child.stdout?.on("data", (d) => outChunks.push(d));
        child.stderr?.on("data", (d) => errChunks.push(d));
        child.on("error", (e) => {
            clearTimeout(timer);
            reject(new OrchestratorError("infeasible", `无法启动 ${cmd}：${e.message}（检查是否在 PATH）`, { cmd }));
        });
        child.on("exit", (code) => {
            clearTimeout(timer);
            const stdoutBuf = Buffer.concat(outChunks);
            resolve({
                code,
                stdout: stdoutBuf.toString("utf8"),
                stderr: Buffer.concat(errChunks).toString("utf8"),
                stdoutBuf,
                timedOut,
            });
        });
    });
}
function killTree(child) {
    if (child.pid === undefined)
        return;
    if (process.platform === "win32") {
        // Windows 上 child.kill() 不杀子进程树，必须 taskkill /t
        spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { windowsHide: true });
    }
    else {
        child.kill("SIGKILL");
    }
}
// fastboot getvar 输出解析：部分构建把 (bootloader) 行打在 stderr，合并后解析
export function parseGetvar(text) {
    const map = new Map();
    const re = /\(bootloader\)\s+([A-Za-z0-9_:\-.]+):\s*(.*)/g;
    for (const m of text.matchAll(re))
        map.set(m[1], m[2].trim());
    return map;
}
