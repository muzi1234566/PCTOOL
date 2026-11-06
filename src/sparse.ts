// Android 稀疏镜像：解析、DONT_CARE 重叠检测（6.5）、sparse→raw 转换（无外部依赖）
import { closeSync, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs";

const SPARSE_MAGIC = 0xed26ff3a;

export type SparseChunkType = "raw" | "fill" | "dont_care" | "crc32";

export interface SparseChunk {
  type: SparseChunkType;
  startBlock: number;
  blocks: number;
  dataOffset?: number; // raw：数据在文件内的偏移
  fillVal?: number;    // fill：填充值（LE 存储）
}

export interface SparseInfo {
  blockSize: number;
  totalBlocks: number;
  chunks: SparseChunk[];
}

export function detectSparse(head: Buffer): boolean {
  return head.length >= 4 && head.readUInt32LE(0) === SPARSE_MAGIC;
}

// 布局：file header 28B（magic u32@0 | major u16@4 | minor u16@6 | file_hdr_sz u16@8 | chunk_hdr_sz u16@10
//       | blk_sz u32@12 | total_blks u32@16 | total_chunks u32@20 | image_checksum u32@24）
// chunk header 12B(type u16 | reserved u16 | data_sz u32)
// RAW data_sz=数据字节；FILL data_sz=8(fill_val+chunk_size)；DONT_CARE data_sz=4(chunk_size)；CRC32 data_sz=4
export function parseSparseInfo(buf: Buffer): SparseInfo {
  if (buf.length < 24) throw new Error("文件太小，不是稀疏镜像");
  if (buf.readUInt32LE(0) !== SPARSE_MAGIC) throw new Error("不是 Android 稀疏镜像（magic 不符）");
  const fileHdrSz = buf.readUInt16LE(8);
  const blockSize = buf.readUInt32LE(12);
  const totalBlocks = buf.readUInt32LE(16);
  const totalChunks = buf.readUInt32LE(20);
  if (blockSize < 512 || blockSize % 4 !== 0) throw new Error(`非法块大小 ${blockSize}`);

  let off = fileHdrSz;
  let block = 0;
  const chunks: SparseChunk[] = [];
  for (let i = 0; i < totalChunks && off + 12 <= buf.length; i++) {
    const type = buf.readUInt16LE(off);
    const dataSz = buf.readUInt32LE(off + 4);
    if (off + 12 + dataSz > buf.length) throw new Error(`稀疏块 ${i} 越界：文件被截断`);
    switch (type) {
      case 0xcac1: {
        const blocks = Math.floor(dataSz / blockSize);
        chunks.push({ type: "raw", startBlock: block, blocks, dataOffset: off + 12 });
        block += blocks;
        break;
      }
      case 0xcac2: {
        const blocks = buf.readUInt32LE(off + 16);
        chunks.push({ type: "fill", startBlock: block, blocks, fillVal: buf.readUInt32LE(off + 12) });
        block += blocks;
        break;
      }
      case 0xcac3: {
        const blocks = buf.readUInt32LE(off + 12);
        chunks.push({ type: "dont_care", startBlock: block, blocks });
        block += blocks;
        break;
      }
      case 0xcac4: {
        chunks.push({ type: "crc32", startBlock: block, blocks: 0 });
        break;
      }
      default:
        throw new Error(`未知稀疏块类型 0x${type.toString(16)} @ offset ${off}`);
    }
    off += 12 + dataSz;
  }
  return { blockSize, totalBlocks, chunks };
}

// 6.5：DONT_CARE 段与元数据块区间重叠 → 必须先 erase 归零再刷
export function dontCareOverlaps(
  info: SparseInfo,
  ranges: Array<{ startBlock: number; blocks: number }>,
): Array<{ startBlock: number; blocks: number }> {
  const overlaps: Array<{ startBlock: number; blocks: number }> = [];
  for (const c of info.chunks) {
    if (c.type !== "dont_care") continue;
    const cEnd = c.startBlock + c.blocks;
    const hit = ranges.some((r) => {
      const rEnd = r.startBlock + r.blocks;
      return c.startBlock < rEnd && r.startBlock < cEnd;
    });
    if (hit) overlaps.push({ startBlock: c.startBlock, blocks: c.blocks });
  }
  return overlaps;
}

// sparse → raw：raw 直拷、fill 展开成重复模式、dont_care/crc 留空洞（truncate 后读回为 0）
// 注意：DONT_CARE 转换为 0x00 的前提是已按 6.5 确认与元数据无重叠
// 复杂度 O(totalBlocks)；超大镜像（>2GB）建议外接 simg2img，本实现覆盖常规分区
export function sparseToRaw(src: string, dest: string): { blockSize: number; totalBlocks: number } {
  const buf = readFileSync(src);
  const info = parseSparseInfo(buf);
  const fd = openSync(dest, "w");
  try {
    for (const c of info.chunks) {
      const byteStart = c.startBlock * info.blockSize;
      if (c.type === "raw" && c.dataOffset !== undefined) {
        const len = c.blocks * info.blockSize;
        writeSync(fd, buf, c.dataOffset, len, byteStart);
      } else if (c.type === "fill") {
        const unit = Buffer.alloc(4);
        unit.writeUInt32LE(c.fillVal ?? 0, 0);
        const pattern = Buffer.concat(Array.from({ length: info.blockSize / 4 }, () => unit));
        for (let i = 0; i < c.blocks; i++) writeSync(fd, pattern, 0, info.blockSize, byteStart + i * info.blockSize);
      }
      // dont_care / crc32：不写，留洞
    }
    ftruncateSync(fd, info.totalBlocks * info.blockSize); // 尾部空洞补零
  } finally {
    closeSync(fd);
  }
  return { blockSize: info.blockSize, totalBlocks: info.totalBlocks };
}
