// ui-auto 测试（v4 三）：XML 树解析 / 节点定位 / 中心点 / 状态比对 / tap 走 opbus（Mock，无设备）
import assert from "node:assert/strict";
import test from "node:test";
import { parseUiDump, findNode, center, dumpChanged } from "../ui-auto.js";
import { materialize } from "../opbus.js";

// 模拟 uiautomator dump 的授权弹窗 XML（属性顺序故意打乱，考验容错）
const DUMP_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="com.android.packageinstaller:id/container" bounds="[0,0][1080,2400]"/>
  <node index="1" clickable="true" text="不允许" resource-id="com.android.packageinstaller:id/deny_button" bounds="[54,2200][500,2300]"/>
  <node index="2" clickable="true" text="允许" resource-id="com.android.packageinstaller:id/allow_button" bounds="[580,2200][1026,2300]"/>
  <node index="3" text="是否允许访问照片和视频？" bounds="[54,200][1026,300]"/>
</hierarchy>`;

test("UI 解析：从 dump XML 定位「允许」节点（属性顺序容错）", () => {
  const nodes = parseUiDump(DUMP_XML);
  assert.equal(nodes.length, 4);
  const allow = findNode(nodes, { textExact: "允许" });
  assert.ok(allow);
  assert.equal(allow!.resourceId, "com.android.packageinstaller:id/allow_button");
  assert.equal(allow!.clickable, true);
});

test("UI 解析：中心点计算（bounds → tap 坐标）", () => {
  const allow = findNode(parseUiDump(DUMP_XML), { textExact: "允许" })!;
  assert.deepEqual(center(allow), [803, 2250]);
});

test("UI 解析：resource-id 定位与 contains 匹配", () => {
  const nodes = parseUiDump(DUMP_XML);
  const byId = findNode(nodes, { resourceId: "com.android.packageinstaller:id/deny_button" });
  assert.equal(byId!.text, "不允许");
  const byContains = findNode(nodes, { textContains: "访问照片" });
  assert.equal(byContains!.bounds[0], 54);
});

test("UI 解析：前后 dump 比对（状态校验）", () => {
  const a = parseUiDump(DUMP_XML);
  const b = parseUiDump(DUMP_XML);
  assert.equal(dumpChanged(a, b), false);
  const c = parseUiDump(DUMP_XML.replace('text="允许"', 'text="已允许"'));
  assert.equal(dumpChanged(a, c), true);
});

test("UI 点击走 opbus：坐标只能整数，argv 固定模板", () => {
  const allow = findNode(parseUiDump(DUMP_XML), { textExact: "允许" })!;
  const [x, y] = center(allow);
  const cmd = materialize({ action: "ui_tap", target: `${x},${y}` });
  assert.deepEqual(cmd.args, ["shell", "input tap 803 2250"]);
  // 模型伪造坐标 → 拦截
  assert.throws(() => materialize({ action: "ui_tap", target: "1;reboot,960" } as never), /opbus 拦截/);
});

test("UI 解析：损坏/空 dump → 空数组不抛", () => {
  assert.deepEqual(parseUiDump(""), []);
  assert.deepEqual(parseUiDump("Service published: uiautomator"), []);
});
