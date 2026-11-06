// opbus 测试（v4 一）：结构化下发 / 注入拦截 / 2.3 黑名单 / argv 拼装
import assert from "node:assert/strict";
import test from "node:test";
import { materialize, assertOp } from "../opbus.js";
import { OrchestratorError } from "../errors.js";

test("opbus：write_partition 拼出 fastboot argv（纯 TS，无自由拼接）", () => {
  const cmd = materialize({ action: "write_partition", target: "boot_a", file: "C:/imgs/boot.img" });
  assert.equal(cmd.kind, "fastboot");
  assert.deepEqual(cmd.args, ["flash", "boot_a", "C:/imgs/boot.img"]);
});

test("opbus：erase/unlock 类 action 根本不存在 → 拦截（规范 2.3）", () => {
  for (const action of ["erase_partition", "format_partition", "unlock", "firehose"]) {
    assert.throws(
      () => materialize({ action } as never),
      (e: OrchestratorError) => e.details.opbusBlocked === true && /永不自动执行|白名单外/.test(e.message),
    );
  }
});

test("opbus：未知 action 拦截", () => {
  assert.throws(() => materialize({ action: "rm_rf_everything" } as never), /opbus 拦截/);
});

test("opbus：shell 元字符注入拦截（;|&$`）", () => {
  for (const evil of ["boot_a; rm -rf /", "boot_a && reboot", "$(reboot)", "boot_a|reboot", "boot_a`reboot`"]) {
    assert.throws(
      () => materialize({ action: "write_partition", target: evil, file: "x.img" }),
      (e: OrchestratorError) => e.details.opbusBlocked === true && /元字符/.test(e.message),
    );
  }
});

test("opbus：sysfs_write 合法 → 固定模板 argv", () => {
  const cmd = materialize({ action: "sysfs_write", target: "/sys/module/lpm_levels/parameters/sleep_disabled", value: "Y" });
  assert.equal(cmd.kind, "adb");
  assert.deepEqual(cmd.args, ["shell", "su -c sh -c 'echo Y > /sys/module/lpm_levels/parameters/sleep_disabled'"]);
  // 越路径拦截
  assert.throws(() => materialize({ action: "sysfs_write", target: "/data/data/x", value: "Y" }), /opbus 拦截/);
});

test("opbus：push_file 限定 /data/local/tmp/", () => {
  const ok = materialize({ action: "push_file", file: "C:/m.zip", target: "/data/local/tmp/dsh-module.zip" });
  assert.deepEqual(ok.args, ["push", "C:/m.zip", "/data/local/tmp/dsh-module.zip"]);
  assert.throws(() => materialize({ action: "push_file", file: "C:/m.zip", target: "/system/x.zip" }), /opbus 拦截/);
});

test("opbus：ui_tap 仅接受整数坐标", () => {
  assert.deepEqual(materialize({ action: "ui_tap", target: "540,960" }).args, ["shell", "input tap 540 960"]);
  assert.throws(() => materialize({ action: "ui_tap", target: "abc,960" } as never), /opbus 拦截/);
});

test("opbus：shell_read 只允许固定只读模板", () => {
  assert.deepEqual(materialize({ action: "shell_read", value: "getprop", target: "ro.csc" }).args, ["shell", "getprop ro.csc"]);
  assert.throws(() => materialize({ action: "shell_read", value: "shell_inject", target: "rm -rf /" } as never), /opbus 拦截/);
  assert.throws(() => materialize({ action: "shell_read", value: "cat", target: "/data/data/com.tencent.mm/x" } as never), /仅允许/);
});

test("opbus：assertOp 拒绝非对象输入", () => {
  assert.throws(() => assertOp("fastboot erase boot"), OrchestratorError);
});
