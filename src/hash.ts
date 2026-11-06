// SHA256 工具：文件流式哈希（大镜像不占内存）+ Buffer 哈希
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function sha256File(p: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(p);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function sha256Buf(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}
