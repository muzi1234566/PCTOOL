// capability-map 测试：采样落盘 / 分位数计算 / 样本不足兜底 / 损坏容忍
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { capabilityKey, capabilityKeyFromState, estimateFromHistory, loadCapabilityMap, MIN_SAMPLES_FOR_ESTIMATE, percentile, recordSample, } from "../capability-map.js";
function tmpDir() {
    return mkdtempSync(path.join(tmpdir(), "capmap-"));
}
test("分位数：线性插值", () => {
    const sorted = [100, 200, 300, 400, 500, 600];
    assert.equal(percentile(sorted, 0.5), 350); // (5-1)*0.5=2.5 → 300+(400-300)*0.5
    assert.equal(percentile(sorted, 0.9), 550); // 4.5 → 500+(600-500)*0.5
    assert.equal(percentile([100], 0.9), 100);
    assert.equal(percentile([], 0.5), 0);
});
test("键：型号::buildId，缺失用 unknown", () => {
    assert.equal(capabilityKey("Pixel 7", "TQ3A"), "Pixel 7::TQ3A");
    assert.equal(capabilityKey(null, null), "unknown::unknown");
    assert.equal(capabilityKeyFromState({ deviceModel: "Pixel 7" }), "Pixel 7::unknown");
});
test("采样：记录并算出历史估算", () => {
    const dir = tmpDir();
    const key = "Pixel 7::TQ3A";
    // 6 条 root 样本：120s..125s，全成功
    for (let i = 0; i < 6; i++) {
        recordSample(dir, key, { intent: "root", durationMs: 120000 + i * 1000, success: true, mode: "exploration", timestamp: Date.now() });
    }
    const est = estimateFromHistory(dir, key, "root", "exploration");
    assert.ok(est);
    assert.equal(est.p50Ms, 122500); // 中位：122000/123000 插值
    assert.equal(est.p90Ms, 124500);
    assert.equal(est.successRate, 1.0);
    rmSync(dir, { recursive: true, force: true });
});
test("估算：样本不足 MIN_SAMPLES → null（调用方走默认兜底）", () => {
    const dir = tmpDir();
    const key = "P::B";
    for (let i = 0; i < MIN_SAMPLES_FOR_ESTIMATE - 1; i++) {
        recordSample(dir, key, { intent: "flash", durationMs: 60000, success: true, mode: "exploration", timestamp: Date.now() });
    }
    assert.equal(estimateFromHistory(dir, key, "flash", "exploration"), null);
    // 补足一条 → 命中
    recordSample(dir, key, { intent: "flash", durationMs: 60000, success: true, mode: "exploration", timestamp: Date.now() });
    const est = estimateFromHistory(dir, key, "flash", "exploration");
    assert.ok(est);
    assert.equal(est.p50Ms, 60000);
    rmSync(dir, { recursive: true, force: true });
});
test("估算：mode 样本不足时放宽 mode 过滤", () => {
    const dir = tmpDir();
    const key = "P::B";
    // exploration 4 条 + accelerated 2 条：按 mode 精确过滤不足 → 放宽到 intent 全量（6 条）
    for (let i = 0; i < 4; i++) {
        recordSample(dir, key, { intent: "root", durationMs: 100000 + i, success: true, mode: "exploration", timestamp: Date.now() });
    }
    for (let i = 0; i < 2; i++) {
        recordSample(dir, key, { intent: "root", durationMs: 90000 + i, success: false, mode: "accelerated", timestamp: Date.now() });
    }
    const est = estimateFromHistory(dir, key, "root", "accelerated");
    assert.ok(est);
    assert.equal(est.successRate, 4 / 6); // 6 条里 4 条成功
    rmSync(dir, { recursive: true, force: true });
});
test("估算：intent 不匹配 → null", () => {
    const dir = tmpDir();
    for (let i = 0; i < 6; i++) {
        recordSample(dir, "K::V", { intent: "flash", durationMs: 1000, success: true, mode: "exploration", timestamp: Date.now() });
    }
    assert.equal(estimateFromHistory(dir, "K::V", "root", "exploration"), null);
    rmSync(dir, { recursive: true, force: true });
});
test("滚动窗口：超过 50 条只留最近 50 条", () => {
    const dir = tmpDir();
    for (let i = 0; i < 55; i++) {
        recordSample(dir, "K::V", { intent: "flash", durationMs: i, success: true, mode: "exploration", timestamp: i });
    }
    const map = loadCapabilityMap(dir);
    const samples = map.entries["K::V"].samples;
    assert.equal(samples.length, 50);
    assert.equal(samples[0].durationMs, 5); // 最早的 5 条被挤出
    rmSync(dir, { recursive: true, force: true });
});
test("容错：map 文件损坏 → 视为空", () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "capability-map.json"), "{not json");
    const map = loadCapabilityMap(dir);
    assert.deepEqual(map.entries, {});
    rmSync(dir, { recursive: true, force: true });
});
