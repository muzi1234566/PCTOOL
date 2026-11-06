// 最小 ZIP 读取器测试（P2）：手工构造 store 型 zip → 解析/提取
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractZipEntries, readZipEntries } from "../zip.js";
function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        let c = (crc ^ buf[i]) & 0xff;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
// store（不压缩）型 zip 构造器：local header + data + central dir + EOCD
function buildZip(entries) {
    const parts = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
        const nameB = Buffer.from(e.name, "utf8");
        const local = Buffer.alloc(30 + nameB.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0, 8); // method = store
        local.writeUInt32LE(crc32(e.data), 14);
        local.writeUInt32LE(e.data.length, 18);
        local.writeUInt32LE(e.data.length, 22);
        local.writeUInt16LE(nameB.length, 26);
        nameB.copy(local, 30);
        parts.push(local, e.data);
        const cd = Buffer.alloc(46 + nameB.length);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 8);
        cd.writeUInt16LE(0, 10); // method = store
        cd.writeUInt32LE(crc32(e.data), 16);
        cd.writeUInt32LE(e.data.length, 20);
        cd.writeUInt32LE(e.data.length, 24);
        cd.writeUInt16LE(nameB.length, 28);
        cd.writeUInt32LE(offset, 42); // local header offset
        nameB.copy(cd, 46);
        centrals.push(cd);
        offset += local.length + e.data.length;
    }
    const cdBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, cdBuf, eocd]);
}
test("zip：解析 store 型条目", () => {
    const buf = buildZip([
        { name: "assets/boot_patch.sh", data: Buffer.from("#!/system/bin/sh\necho hi\n") },
        { name: "assets/magiskinit", data: Buffer.from("MAGISKINIT-BINARY") },
        { name: "lib/arm64-v8a/libmagiskboot.so", data: Buffer.from("MAGISKBOOT-BINARY") },
    ]);
    const entries = readZipEntries(buf);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].name, "assets/boot_patch.sh");
    assert.equal(entries[0].data.toString(), "#!/system/bin/sh\necho hi\n");
    assert.equal(entries[2].name, "lib/arm64-v8a/libmagiskboot.so");
});
test("zip：按名提取到目录", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zip-"));
    const buf = buildZip([
        { name: "assets/boot_patch.sh", data: Buffer.from("SCRIPT") },
        { name: "lib/arm64-v8a/libmagiskboot.so", data: Buffer.from("BIN") },
    ]);
    const files = extractZipEntries(buf, (n) => n.endsWith(".sh") || n.includes("libmagiskboot"), dir);
    assert.equal(files.length, 2);
    assert.equal(readFileSync(path.join(dir, "boot_patch.sh"), "utf8"), "SCRIPT");
    assert.equal(readFileSync(path.join(dir, "arm64-v8a/libmagiskboot.so"), "utf8"), "BIN");
    rmSync(dir, { recursive: true, force: true });
});
test("zip：非 zip 输入抛错", () => {
    assert.throws(() => readZipEntries(Buffer.alloc(100, 0x00)), /EOCD/);
});
