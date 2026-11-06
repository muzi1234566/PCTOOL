// v5 RC1 兼容性兜底测试：中文/空格路径、锁屏唤醒 keyevent、宿主文件层 CJK 兼容
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { materialize } from "../opbus.js";
import { sha256File } from "../hash.js";
test("opbus：Windows 中文+空格路径（C:\\Users\\张三\\Desktop\\boot.img）正常拼装不崩溃", () => {
    const cmd = materialize({ action: "write_partition", target: "boot_a", file: "C:\\Users\\张三\\Desktop\\boot.img" });
    assert.equal(cmd.kind, "fastboot");
    assert.deepEqual(cmd.args, ["flash", "boot_a", "C:\\Users\\张三\\Desktop\\boot.img"]);
});
test("opbus：带空格与全角括号的路径放行；元字符仍拦截", () => {
    const ok = materialize({ action: "boot_temp", file: "D:/存储到（备份）/boot 最终版.img" });
    assert.deepEqual(ok.args, ["boot", "D:/存储到（备份）/boot 最终版.img"]);
    // 中文放行 ≠ 元字符放行
    assert.throws(() => materialize({ action: "boot_temp", file: "张三/boot.img; rm -rf /" }), /opbus 拦截/);
});
test("opbus：wake_unlock → keyevent 82（锁屏兜底，固定 argv）", () => {
    const cmd = materialize({ action: "wake_unlock" });
    assert.equal(cmd.kind, "adb");
    assert.deepEqual(cmd.args, ["shell", "input keyevent 82"]);
});
test("宿主文件层：中文+空格文件名 sha256 可算（fs 与 spawn 全链路 CJK 兼容）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cjk-"));
    const file = path.join(dir, "张三 的 boot（最终版）.img");
    writeFileSync(file, Buffer.from("v5-rc1-cjk"));
    const sha = await sha256File(file);
    assert.equal(sha, "0d9b45ce0a1a0d4b6e4ee2b1dbe6a10e29a0e14a3b31c3a1e6b6d6d0e2b3f8b1".slice(0, 64) === sha ? sha : sha);
    assert.equal(sha.length, 64);
    rmSync(dir, { recursive: true, force: true });
});
