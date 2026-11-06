// 下载竞速 Mock 测试（v4 二）：并发探测延迟 → 最快节点优先 → 逐源 SHA256 校验
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { raceDownload, shouldDownloadOnDevice, ONDEVICE_MIN_BYTES } from "../resources.js";
// 捕获 fetch 调用：Range 头 = 探测；否则 = 下载
function mockFetch(scenario) {
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        const url = String(input);
        calls.push(url);
        const range = init?.headers?.Range !== undefined;
        if (range) {
            for (const [key, ms] of Object.entries(scenario.probeMs)) {
                if (url.includes(key)) {
                    if (ms === "fail")
                        throw new Error("probe fail");
                    await new Promise((r) => setTimeout(r, ms));
                    return new Response(new ArrayBuffer(1), { status: 206 });
                }
            }
            return new Response(new ArrayBuffer(1), { status: 206 });
        }
        for (const [key, fail] of Object.entries(scenario.downloadFail ?? {})) {
            if (url.includes(key) && fail)
                return new Response("server error", { status: 500 });
        }
        return new Response(scenario.content ?? Buffer.alloc(10));
    });
    return { calls, restore: () => { globalThis.fetch = realFetch; } };
}
const CONTENT = Buffer.alloc(2048, 0x5a);
const SHA = createHash("sha256").update(CONTENT).digest("hex");
const URL = "https://github.com/topjohnwu/Magisk/releases/x.bin";
test("竞速：并发探测后选最快存活节点下载，内容 sha256 校验通过", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "race-"));
    const dest = path.join(dir, "x.bin");
    const m = mockFetch({ probeMs: { "ghproxy.net": "fail", "gh-proxy.com": 15, "github.com": 120 }, content: CONTENT });
    try {
        const r = await raceDownload(URL, dest, { sha256: SHA, size: CONTENT.length });
        assert.equal(r.mirror, "gh-proxy.com"); // 存活节点中延迟最低
        assert.equal(readFileSync(dest).length, CONTENT.length);
        // 3 次探测（并发）+ 1 次下载
        assert.equal(m.calls.filter((u) => u.includes("gh-proxy.com")).length >= 2, true);
    }
    finally {
        m.restore();
        rmSync(dir, { recursive: true, force: true });
    }
});
test("竞速：最快节点内容损坏 → 自动切换下一个存活源，最终交付正确文件", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "race2-"));
    const dest = path.join(dir, "x.bin");
    const m = mockFetch({
        probeMs: { "gh-proxy.com": 10, "github.com": 50, "ghproxy.net": 60 },
        content: CONTENT,
        downloadFail: { "gh-proxy.com": true }, // 最快节点 500 → 切 direct
    });
    try {
        const r = await raceDownload(URL, dest, { sha256: SHA, size: CONTENT.length });
        assert.equal(r.mirror, "direct");
        assert.equal(readFileSync(dest).length, CONTENT.length);
    }
    finally {
        m.restore();
        rmSync(dir, { recursive: true, force: true });
    }
});
test("竞速：全部源损坏 → resource_corrupted（不留残文件）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "race3-"));
    const dest = path.join(dir, "x.bin");
    const bad = Buffer.alloc(2048, 0x00);
    const m = mockFetch({ probeMs: {}, content: bad });
    try {
        await assert.rejects(() => raceDownload(URL, dest, { sha256: SHA, size: CONTENT.length }), /SHA256 不匹配/);
        assert.throws(() => readFileSync(dest), /ENOENT/);
    }
    finally {
        m.restore();
        rmSync(dir, { recursive: true, force: true });
    }
});
test("手机端自主下载阈值：≥50MB 且显式开启才启用", () => {
    assert.equal(ONDEVICE_MIN_BYTES, 50 * 1024 * 1024);
    assert.equal(shouldDownloadOnDevice(60 * 1024 * 1024, true), true);
    assert.equal(shouldDownloadOnDevice(60 * 1024 * 1024, false), false); // 未开启 → PC 竞速
    assert.equal(shouldDownloadOnDevice(10 * 1024 * 1024, true), false); // 小文件 → PC 竞速更快
});
