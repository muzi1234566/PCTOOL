// 稀疏镜像测试：解析 / DONT_CARE 重叠检测（6.5）/ sparse→raw 转换
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectSparse, dontCareOverlaps, parseSparseInfo, sparseToRaw } from "../sparse.js";

const BLK = 4096;

// 文件头 28 字节：magic u32@0 | major u16@4 | minor u16@6 | file_hdr_sz u16@8 | chunk_hdr_sz u16@10
//                 | blk_sz u32@12 | total_blks u32@16 | total_chunks u32@20 | checksum u32@24
function buildSparse(rawBlocks: number, dontCareBlocks: number): Buffer {
  const h = Buffer.alloc(28);
  h.writeUInt32LE(0xed26ff3a, 0);
  h.writeUInt16LE(1, 4);    // major
  h.writeUInt16LE(0, 6);    // minor
  h.writeUInt16LE(28, 8);   // file_hdr_sz
  h.writeUInt16LE(12, 10);  // chunk_hdr_sz
  h.writeUInt32LE(BLK, 12);
  h.writeUInt32LE(rawBlocks + dontCareBlocks, 16);
  h.writeUInt32LE(2, 20);   // total_chunks

  // RAW：rawBlocks 个块，值 = 0xAA
  const rawHeader = Buffer.alloc(12);
  rawHeader.writeUInt16LE(0xcac1, 0);
  rawHeader.writeUInt32LE(rawBlocks * BLK, 4); // chunk_data_size

  // DONT_CARE：dontCareBlocks 个块
  const dcHeader = Buffer.alloc(12 + 4);
  dcHeader.writeUInt16LE(0xcac3, 0);
  dcHeader.writeUInt32LE(4, 4);              // chunk_data_size = 4
  dcHeader.writeUInt32LE(dontCareBlocks, 12);

  return Buffer.concat([h, rawHeader, Buffer.alloc(rawBlocks * BLK, 0xaa), dcHeader]);
}

test("稀疏：解析块布局", () => {
  const buf = buildSparse(4, 3);
  assert.equal(detectSparse(buf), true);
  const info = parseSparseInfo(buf);
  assert.equal(info.blockSize, BLK);
  assert.equal(info.totalBlocks, 7);
  assert.equal(info.chunks[0].type, "raw");
  assert.equal(info.chunks[0].blocks, 4);
  assert.equal(info.chunks[1].type, "dont_care");
  assert.equal(info.chunks[1].blocks, 3);
});

test("稀疏：DONT_CARE 与元数据重叠检测（6.5）", () => {
  const info = parseSparseInfo(buildSparse(4, 3));
  // 元数据区间块 5-6 → 与 DONT_CARE（4-6）重叠
  const hit = dontCareOverlaps(info, [{ startBlock: 5, blocks: 2 }]);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].startBlock, 4);
  // 元数据区间块 0-1 → 不重叠
  assert.equal(dontCareOverlaps(info, [{ startBlock: 0, blocks: 1 }]).length, 0);
});

test("稀疏：sparse→raw 转换", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sparse-"));
  const src = path.join(dir, "img.sparse");
  const dst = path.join(dir, "img.raw");
  writeFileSync(src, buildSparse(4, 3));
  const out = sparseToRaw(src, dst);
  assert.equal(out.totalBlocks, 7);
  const raw = readFileSync(dst);
  assert.equal(raw.length, 7 * BLK);
  // RAW 区全 0xAA
  assert.equal(raw[0], 0xaa);
  assert.equal(raw[3 * BLK + 100], 0xaa);
  // DONT_CARE 区全 0（留洞 + truncate）
  assert.equal(raw[5 * BLK + 10], 0x00);
  rmSync(dir, { recursive: true, force: true });
});

test("稀疏：非稀疏文件解析抛错", () => {
  assert.throws(() => parseSparseInfo(Buffer.alloc(64, 0x00)), /稀疏镜像/);
});
