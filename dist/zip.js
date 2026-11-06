// 最小 ZIP 读取器：store + deflate，供从 Magisk/KernelSU APK 内提取修补资产
// 覆盖 APK（<4GB，无 ZIP64 加密项）足够；实现基于中央目录遍历 + zlib.inflateRawSync
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
export function readZipEntries(buf) {
    // 从尾部找 EOCD（0x06054b50），允许最长 64KB 注释
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0)
        throw new Error("不是 ZIP 文件（找不到 EOCD）");
    const count = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const entries = [];
    let off = cdOffset;
    for (let i = 0; i < count; i++) {
        if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
            throw new Error("ZIP 中央目录损坏");
        }
        const method = buf.readUInt16LE(off + 10);
        const compSize = buf.readUInt32LE(off + 20);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const lfhOff = buf.readUInt32LE(off + 42);
        const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
        // local file header：文件名/扩展字段长度可能与中央目录不同，必须重读
        const lfhNameLen = buf.readUInt16LE(lfhOff + 26);
        const lfhExtraLen = buf.readUInt16LE(lfhOff + 28);
        const dataStart = lfhOff + 30 + lfhNameLen + lfhExtraLen;
        const raw = buf.subarray(dataStart, dataStart + compSize);
        const data = method === 0
            ? Buffer.from(raw)
            : method === 8
                ? inflateRawSync(raw)
                : (() => { throw new Error(`不支持的压缩方法 ${method}：${name}`); })();
        entries.push({ name, data });
        off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}
// 按选择器提取；rename 映射目标文件名（缺省剥 assets/ 前缀并保留 basename）
export function extractZipEntries(buf, select, destDir, rename) {
    const out = [];
    for (const e of readZipEntries(buf)) {
        if (!select(e.name))
            continue;
        const flat = e.name.replace(/^assets\//, "").replace(/^lib\//, "");
        const target = path.join(destDir, rename ? rename(e.name) : flat);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, e.data);
        out.push(target);
    }
    return out;
}
