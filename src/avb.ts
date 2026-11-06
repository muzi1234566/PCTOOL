// AVB vbmeta 解析 + 链式校验（6.3）：解析描述符、显式遍历 chained vbmeta、核对子分区哈希
import { createHash } from "node:crypto";

// 描述符 tag（avb_descriptor.h）
const TAG_HASHTREE = 1n;
const TAG_CHAINED = 2n;
const TAG_HASH = 3n;

export interface ChainDescriptor {
  tag: "chained_partition";
  partition: string;
  rollbackIndexLocation: number;
}
export interface HashDescriptor {
  tag: "hash";
  partition: string;
  imageSize: number;
  salt: string;  // hex
  digest: string; // hex（sha256(salt + image)）
}
export interface HashtreeDescriptor {
  tag: "hashtree";
  partition: string;
  imageSize: number;
}
export type AvbDescriptor = ChainDescriptor | HashDescriptor | HashtreeDescriptor;

export interface VbmetaImage {
  releaseString: string;
  rollbackIndex: bigint;
  flags: number;
  descriptors: AvbDescriptor[];
  unparsedCount: number;
}

// AvbVBMetaImageHeader 固定 256 字节；descriptors_offset 是绝对偏移
const AUTH_BLOCK_SIZE_OFF = 12;
const DESC_OFFSET_OFF = 96;
const DESC_SIZE_OFF = 104;
const ROLLBACK_OFF = 112;
const FLAGS_OFF = 120;
const RELEASE_OFF = 124;
const RELEASE_LEN = 48;

const NAME_RE = /^[A-Za-z0-9_\-.]+$/;

export function parseVbmeta(buf: Buffer): VbmetaImage {
  if (buf.length < 256 || !buf.subarray(0, 4).equals(Buffer.from("AVB0", "ascii"))) {
    throw new Error("不是合法的 AVB vbmeta 镜像（缺少 AVB0 magic）");
  }
  const descOffset = Number(buf.readBigUInt64BE(DESC_OFFSET_OFF));
  const descSize = Number(buf.readBigUInt64BE(DESC_SIZE_OFF));
  const rollbackIndex = buf.readBigUInt64BE(ROLLBACK_OFF);
  const flags = buf.readUInt32BE(FLAGS_OFF);
  const releaseString = buf.subarray(RELEASE_OFF, RELEASE_OFF + RELEASE_LEN).toString("ascii").replace(/\0.*$/, "");

  const descriptors: AvbDescriptor[] = [];
  let unparsedCount = 0;
  let off = descOffset;
  const end = Math.min(descOffset + descSize, buf.length);

  while (off + 16 <= end) {
    const tag = buf.readBigUInt64BE(off);
    const follow = Number(buf.readBigUInt64BE(off + 8)); // 含 8 字节对齐补齐，不含 16 字节描述符头
    const body = off + 16;
    if (body + follow > buf.length) break;
    try {
      if (tag === TAG_CHAINED) {
        // payload: u32 rollback_index_location @0 | u32 name_len @4 | reserved[32] @8 | name(name_len 含 NUL) @40 | public_key
        const rollbackIndexLocation = buf.readUInt32BE(body);
        const nameLen = buf.readUInt32BE(body + 4);
        const name = buf.subarray(body + 40, body + 40 + Math.max(nameLen - 1, 0)).toString("ascii");
        if (NAME_RE.test(name)) descriptors.push({ tag: "chained_partition", partition: name, rollbackIndexLocation });
        else unparsedCount++;
      } else if (tag === TAG_HASH) {
        // payload: u32 image_size @0 | u32 name_len @4 | u32 salt_len @8 | u32 digest_len @12 | reserved[32] | name | salt | digest
        const imageSize = buf.readUInt32BE(body);
        const nameLen = buf.readUInt32BE(body + 4);
        const saltLen = buf.readUInt32BE(body + 8);
        const digestLen = buf.readUInt32BE(body + 12);
        const base = body + 48;
        const partition = buf.subarray(base, base + Math.max(nameLen - 1, 0)).toString("ascii");
        const salt = buf.subarray(base + nameLen, base + nameLen + saltLen).toString("hex");
        const digest = buf.subarray(base + nameLen + saltLen, base + nameLen + saltLen + digestLen).toString("hex");
        if (NAME_RE.test(partition)) descriptors.push({ tag: "hash", partition, imageSize, salt, digest });
        else unparsedCount++;
      } else if (tag === TAG_HASHTREE) {
        // payload: u32 dm_verity_version @0 | u64 image_size @4 | u32 tree_offset @12 | u32 digest_size @16
        //         | u32 salt_size @20 | u32 name_len @24 | ... | reserved 到 @116 | name
        const imageSize = Number(buf.readBigUInt64BE(body + 4));
        const nameLen = buf.readUInt32BE(body + 24);
        const name = buf.subarray(body + 116, body + 116 + Math.max(nameLen - 1, 0)).toString("ascii");
        if (NAME_RE.test(name)) descriptors.push({ tag: "hashtree", partition: name, imageSize });
        else unparsedCount++;
      }
      // property(0) 等其他 tag：跳过（不参与链校验）
    } catch {
      unparsedCount++;
    }
    off = body + follow;
  }

  return { releaseString, rollbackIndex, flags, descriptors, unparsedCount };
}

export interface HashCheck {
  partition: string;
  status: "verified" | "missing_image" | "size_mismatch" | "digest_mismatch" | "hashtree_skipped";
}

export interface AvbChainReport {
  chains: Array<{ partition: string; rollbackIndexLocation: number; resolved: boolean; subReport?: AvbChainReport }>;
  hashChecks: HashCheck[];
  complete: boolean; // 所有链已解析且无未解析描述符
  broken: string[];  // 哈希校验失败的分区
}

// 递归校验：getImage 返回子分区 vbmeta/镜像内容（无则 null）
export function verifyAvbChain(
  buf: Buffer,
  getImage: (name: string) => Buffer | null,
  depth = 0,
): AvbChainReport {
  if (depth > 8) {
    return { chains: [], hashChecks: [], complete: false, broken: ["链深度超过 8：疑似循环引用"] };
  }
  const img = parseVbmeta(buf);
  const report: AvbChainReport = { chains: [], hashChecks: [], complete: img.unparsedCount === 0, broken: [] };
  if (img.unparsedCount > 0) {
    report.broken.push(`unparsed_descriptors(${img.unparsedCount})`);
  }
  for (const d of img.descriptors) {
    if (d.tag === "hash") {
      const sub = getImage(d.partition);
      if (!sub) {
        report.hashChecks.push({ partition: d.partition, status: "missing_image" });
        report.complete = false;
        continue;
      }
      if (sub.length !== d.imageSize) {
        report.hashChecks.push({ partition: d.partition, status: "size_mismatch" });
        report.broken.push(d.partition);
        continue;
      }
      const actual = createHash("sha256").update(Buffer.from(d.salt, "hex")).update(sub).digest("hex");
      const ok = actual === d.digest;
      report.hashChecks.push({ partition: d.partition, status: ok ? "verified" : "digest_mismatch" });
      if (!ok) report.broken.push(d.partition);
    } else if (d.tag === "chained_partition") {
      const sub = getImage(d.partition);
      if (!sub) {
        report.chains.push({ partition: d.partition, rollbackIndexLocation: d.rollbackIndexLocation, resolved: false });
        report.complete = false;
        continue;
      }
      const subReport = verifyAvbChain(sub, getImage, depth + 1);
      report.chains.push({ partition: d.partition, rollbackIndexLocation: d.rollbackIndexLocation, resolved: true, subReport });
      if (!subReport.complete || subReport.broken.length > 0) report.complete = false;
      report.broken.push(...subReport.broken);
    } else if (d.tag === "hashtree") {
      // hashtree 需要 dm-verity 树数据，仅有镜像内容无法本地核对 → 显式标注而非假装通过
      report.hashChecks.push({ partition: d.partition, status: "hashtree_skipped" });
    }
  }
  return report;
}
