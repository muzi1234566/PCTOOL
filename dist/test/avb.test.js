// vbmeta 解析与 AVB 链式校验测试（合成镜像，无设备）
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { parseVbmeta, verifyAvbChain } from "../avb.js";
function pad8(n) {
    return Math.ceil(n / 8) * 8;
}
function hashDescriptor(imageSize, name, saltHex, digestHex) {
    const nameB = Buffer.from(`${name}\0`, "ascii");
    const saltB = Buffer.from(saltHex, "hex");
    const digB = Buffer.from(digestHex, "hex");
    const bodyLen = 48 + nameB.length + saltB.length + digB.length; // 4*4 头 + 32 保留 + 数据
    const d = Buffer.alloc(16 + pad8(bodyLen));
    d.writeBigUInt64BE(3n, 0); // TAG_HASH
    d.writeBigUInt64BE(BigInt(pad8(bodyLen)), 8);
    d.writeUInt32BE(imageSize, 16);
    d.writeUInt32BE(nameB.length, 20);
    d.writeUInt32BE(saltB.length, 24);
    d.writeUInt32BE(digB.length, 28);
    Buffer.from(nameB).copy(d, 16 + 48);
    saltB.copy(d, 16 + 48 + nameB.length);
    digB.copy(d, 16 + 48 + nameB.length + saltB.length);
    return d;
}
function chainDescriptor(name, rollbackIndexLocation) {
    const nameB = Buffer.from(`${name}\0`, "ascii");
    const key = Buffer.alloc(64); // 64 字节示例公钥
    const bodyLen = 40 + nameB.length + key.length;
    const d = Buffer.alloc(16 + pad8(bodyLen));
    d.writeBigUInt64BE(2n, 0); // TAG_CHAINED
    d.writeBigUInt64BE(BigInt(pad8(bodyLen)), 8);
    d.writeUInt32BE(rollbackIndexLocation, 16);
    d.writeUInt32BE(nameB.length, 20);
    nameB.copy(d, 16 + 40);
    key.copy(d, 16 + 40 + nameB.length);
    return d;
}
function buildVbmeta(descriptors) {
    const descBuf = Buffer.concat(descriptors);
    const header = Buffer.alloc(256);
    header.write("AVB0", 0, "ascii");
    header.writeBigUInt64BE(0n, 12); // authentication block size
    header.writeBigUInt64BE(BigInt(descBuf.length), 20); // auxiliary block size
    header.writeBigUInt64BE(256n, 96); // descriptors_offset（绝对）
    header.writeBigUInt64BE(BigInt(descBuf.length), 104);
    header.writeBigUInt64BE(42n, 112); // rollback index
    return Buffer.concat([header, descBuf]);
}
test("AVB：解析 hash + chained 描述符", () => {
    const salt = "a".repeat(64);
    const image = Buffer.alloc(1024, 0xab);
    const digest = createHash("sha256").update(Buffer.from(salt, "hex")).update(image).digest("hex");
    const vb = buildVbmeta([
        hashDescriptor(image.length, "boot", salt, digest),
        chainDescriptor("vbmeta_system", 1),
    ]);
    const parsed = parseVbmeta(vb);
    assert.equal(parsed.descriptors.length, 2);
    assert.equal(parsed.rollbackIndex, 42n);
    const h = parsed.descriptors[0];
    assert.equal(h.tag, "hash");
    assert.equal(h.partition, "boot");
    assert.equal(h.digest, digest);
    const c = parsed.descriptors[1];
    assert.equal(c.tag, "chained_partition");
    assert.equal(c.partition, "vbmeta_system");
});
test("AVB：完整链校验通过", () => {
    const salt = "00".repeat(32);
    const bootImg = Buffer.alloc(512, 0x5a);
    const digest = createHash("sha256").update(Buffer.from(salt, "hex")).update(bootImg).digest("hex");
    const sub = buildVbmeta([hashDescriptor(bootImg.length, "system", salt, digest)]);
    const root = buildVbmeta([chainDescriptor("vbmeta_system", 0)]);
    // getImage：链名返回子 vbmeta，分区名返回分区镜像
    const report = verifyAvbChain(root, (name) => name === "vbmeta_system" ? sub : name === "system" ? bootImg : null);
    assert.equal(report.complete, true);
    assert.equal(report.broken.length, 0);
    assert.equal(report.chains[0].resolved, true);
    assert.equal(report.chains[0].subReport?.hashChecks[0].status, "verified");
});
test("AVB：子分区镜像被篡改 → broken", () => {
    const salt = "11".repeat(32);
    const bootImg = Buffer.alloc(512, 0x5a);
    const digest = createHash("sha256").update(Buffer.from(salt, "hex")).update(bootImg).digest("hex");
    const tampered = Buffer.from(bootImg);
    tampered[0] ^= 0xff; // 翻转一个字节
    const sub = buildVbmeta([hashDescriptor(tampered.length, "system", salt, digest)]);
    const root = buildVbmeta([chainDescriptor("vbmeta_system", 0)]);
    const report = verifyAvbChain(root, (name) => name === "vbmeta_system" ? sub : name === "system" ? tampered : null);
    assert.equal(report.complete, false);
    assert.deepEqual(report.broken, ["system"]);
    assert.equal(report.chains[0].subReport?.hashChecks[0].status, "digest_mismatch");
});
test("AVB：子 vbmeta 缺失 → 链未闭合", () => {
    const root = buildVbmeta([chainDescriptor("vbmeta_vendor", 0)]);
    const report = verifyAvbChain(root, () => null);
    assert.equal(report.complete, false);
    assert.equal(report.chains[0].resolved, false);
});
test("AVB：非 vbmeta 文件 → 抛错", () => {
    assert.throws(() => parseVbmeta(Buffer.alloc(300, 0x00)), /AVB0/);
});
