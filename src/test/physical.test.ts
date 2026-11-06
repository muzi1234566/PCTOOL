// 物理约束测试（P2）：存储健康分级 / 硬阻断 / 温度解析
import assert from "node:assert/strict";
import test from "node:test";
import { assertPhysicalHardStops, classifyStorageHealth } from "../physical.js";
import type { DeviceState, FieldValue } from "../types.js";

function fakeState(fields: Record<string, FieldValue>): DeviceState {
  return {
    protocol: "adb",
    fields: { protocol: "adb", ...fields },
    degraded: false,
    failedP0: [],
    failedP1: [],
    notApplicable: [],
    readAt: 0,
  };
}

test("存储健康：life_time 分级（0x01-03 ok / 0x04-07 warning / 0x08+ critical）", () => {
  assert.equal(classifyStorageHealth("0x01 0x02").level, "ok");
  assert.equal(classifyStorageHealth("0x03 0x02").level, "ok");
  assert.equal(classifyStorageHealth("0x05 0x04").level, "warning");
  assert.equal(classifyStorageHealth("0x08 0x07").level, "critical");
  assert.equal(classifyStorageHealth("0x0B 0x0A").level, "critical");
  // 取两个值中较大者
  assert.equal(classifyStorageHealth("0x01 0x09").level, "critical");
  assert.equal(classifyStorageHealth(null).level, "ok"); // 不可判不算 warning
  assert.equal(classifyStorageHealth("garbage").level, "ok");
});

test("硬阻断：电量 <20% → infeasible", () => {
  assert.throws(
    () => assertPhysicalHardStops(fakeState({ batteryLevel: 15, storageHealth: "0x01 0x01" })),
    /低于 20% 硬阈值/,
  );
});

test("硬阻断：电量恰好 20% → 通过", () => {
  assert.doesNotThrow(() => assertPhysicalHardStops(fakeState({ batteryLevel: 20, storageHealth: "0x01 0x01" })));
});

test("硬阻断：存储 warning → infeasible；极低 → deny_hard（v4 四升级）", () => {
  assert.throws(
    () => assertPhysicalHardStops(fakeState({ batteryLevel: 90, storageHealth: "0x05 0x03" })),
    (e: { code?: string }) => e.code === "infeasible",
  );
  assert.throws(
    () => assertPhysicalHardStops(fakeState({ batteryLevel: 90, storageHealth: "0x0A 0x0B" })),
    (e: { code?: string }) => e.code === "deny_hard",
  );
});

test("硬阻断：电量不可读（fastboot N/A）→ 不触发硬阻断（P1 降级规则另行处理）", () => {
  assert.doesNotThrow(() => assertPhysicalHardStops(fakeState({ batteryLevel: null, storageHealth: "0x01 0x01" })));
});
