// execute_script 沙箱测试（P2）：遮蔽全局 / api 白名单 / 超时硬上限
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SCRIPT_TIMEOUT_MS, ScriptExecutor } from "../executor.js";
import type { ScriptApi } from "../executor.js";
import type { DeviceState, Snapshot } from "../types.js";

function fakeApi(): ScriptApi {
  const state: DeviceState = {
    protocol: "adb",
    fields: { protocol: "adb", batteryLevel: 80 },
    degraded: false,
    failedP0: [],
    failedP1: [],
    notApplicable: [],
    readAt: 0,
  };
  const snap = (): Snapshot => ({ timestamp: Date.now(), deviceHash: "test", criticalFields: {}, partitionHashes: {} });
  return {
    probe: async () => state,
    probeDevice: async () => state,
    captureSnapshot: async () => snap(),
    appendAudit: async () => ({ eventId: "evt", currentEventHash: "hash" }),
    resolveResource: async () => { throw new Error("测试桩不触网"); },
    state: {},
  };
}

const REQ = { barrierMode: "shared" as const };

test("沙箱：process / require 不可访问（遮蔽为 undefined）", async () => {
  const ex = new ScriptExecutor(fakeApi());
  const r = await ex.execute({ ...REQ, script: "return { p: typeof process, q: typeof require, m: typeof module, g: typeof globalThis, f: typeof Function, e: typeof eval };", timeout: 3000 });
  assert.deepEqual(r.result, { p: "undefined", q: "undefined", m: "undefined", g: "undefined", f: "undefined", e: "undefined" });
});

test("沙箱：api.probe 可用（查询状态唯一入口）", async () => {
  const ex = new ScriptExecutor(fakeApi());
  const r = await ex.execute({ ...REQ, script: "const st = await api.probe(); return st.protocol;", timeout: 3000 });
  assert.equal(r.result, "adb");
});

test("沙箱：访问未暴露的 api 属性 → 抛错（副作用强制退回主入口）", async () => {
  const ex = new ScriptExecutor(fakeApi());
  await assert.rejects(
    () => ex.execute({ ...REQ, script: "return api.flash;", timeout: 3000 }),
    /副作用必须退回 Orchestrator 主入口/,
  );
  await assert.rejects(
    () => ex.execute({ ...REQ, script: "return api.write;", timeout: 3000 }),
    /副作用必须退回 Orchestrator 主入口/,
  );
});

test("沙箱：Function 构造器被遮蔽为 undefined，无法借道逃逸", async () => {
  const ex = new ScriptExecutor(fakeApi());
  const r = await ex.execute({ ...REQ, script: "try { const F = Function; return 'escape:' + typeof F; } catch (e) { return 'blocked'; }", timeout: 3000 });
  // Function 在脚本体内解析为 undefined（遮蔽生效），构造器逃逸不可用
  assert.equal(r.result, "escape:undefined");
});

test("沙箱：缺省超时 5s，硬上限 30s 生效", async () => {
  const ex = new ScriptExecutor(fakeApi());
  const started = Date.now();
  await assert.rejects(
    () => ex.execute({ ...REQ, script: "await new Promise(() => {});", timeout: 400 }),
    (e: NodeJS.ErrnoException & { code?: string }) => e.code === "unknown_physical_state",
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `应在 400ms 超时附近中断，实际 ${elapsed}ms`);
  assert.ok(MAX_SCRIPT_TIMEOUT_MS === 30000);
});

test("沙箱：api 不可被脚本改写", async () => {
  const ex = new ScriptExecutor(fakeApi());
  await assert.rejects(
    () => ex.execute({ ...REQ, script: "api.captureSnapshot = async () => ({}); return 'replaced';", timeout: 3000 }),
    /api 不可写入/,
  );
});

test("沙箱：脚本抛错 → 结构化错误（含审计事件）", async () => {
  const ex = new ScriptExecutor(fakeApi());
  await assert.rejects(
    () => ex.execute({ ...REQ, script: "throw new Error('boom');", timeout: 3000 }),
    /脚本执行错误：Error: boom/,
  );
});
