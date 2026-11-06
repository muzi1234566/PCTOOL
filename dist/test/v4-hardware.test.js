// 盲操时序库 + 闪存物理级拒绝测试（v4 四/五）
import assert from "node:assert/strict";
import test from "node:test";
import { blindSequence, blindSequenceTable } from "../blind-ops.js";
import { assertPhysicalHardStops, classifyStorageHealth } from "../physical.js";
function fakeState(fields) {
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
test("盲操：小米/三星/Pixel 机型匹配各自时序，未知机型走通用表", () => {
    const mi = blindSequence("Redmi K60");
    assert.match(mi.forceReboot, /12 秒/);
    assert.ok(mi.edl); // 小米有 9008 条目
    const samsung = blindSequence("SM-G9910");
    assert.match(samsung.brand, /三星/);
    const pixel = blindSequence("Pixel 7");
    assert.match(pixel.forceReboot, /音量上/);
    const unknown = blindSequence(null);
    assert.match(unknown.brand, /通用/);
});
test("盲操：失联场景输出完整表格（forceReboot/fastboot/recovery/edl）", () => {
    const rows = blindSequenceTable("Poco F5");
    assert.equal(rows.length, 4);
    assert.match(rows.join("\n"), /9008/);
});
test("闪存寿命：warning → infeasible（拒绝写入流程）；极低 → deny_hard（物理级拒绝）（v4 四）", () => {
    assert.equal(classifyStorageHealth("0x05 0x03").level, "warning");
    try {
        assertPhysicalHardStops(fakeState({ batteryLevel: 90, storageHealth: "0x05 0x03" }));
        assert.fail("warning 应拒绝");
    }
    catch (e) {
        assert.equal(e.code, "infeasible");
    }
    try {
        assertPhysicalHardStops(fakeState({ batteryLevel: 90, storageHealth: "0x0B 0x0A" }));
        assert.fail("极低寿命应 deny_hard");
    }
    catch (e) {
        assert.equal(e.code, "deny_hard");
        assert.match(e.message, /物理级拒绝/);
    }
    assert.doesNotThrow(() => assertPhysicalHardStops(fakeState({ batteryLevel: 90, storageHealth: "0x01 0x02" })));
});
