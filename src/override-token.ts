// Override Token（2.2）：HMAC-SHA256 一次性令牌，5 分钟过期
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { OverrideToken } from "./types.js";

const TTL_MS = 5 * 60 * 1000;

function sign(t: OverrideToken, secret: string): string {
  return createHmac("sha256", secret).update(`${t.tokenId}${t.operation}${t.expiresAt}`).digest("hex");
}

export function generateToken(operation: string, secretKey: string): OverrideToken {
  const t: OverrideToken = {
    tokenId: randomUUID(),
    operation,
    expiresAt: Date.now() + TTL_MS,
    riskAcknowledged: true, // 签发即表示已向用户展示风险告知
    signature: "",
  };
  t.signature = sign(t, secretKey);
  return t;
}

export function verifyToken(
  token: OverrideToken,
  operation: string,
  secretKey: string,
  now = Date.now(),
): { ok: boolean; reason?: string } {
  const expected = sign(token, secretKey);
  const a = Buffer.from(token.signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "签名无效" };
  if (token.riskAcknowledged !== true) return { ok: false, reason: "riskAcknowledged 必须为 true" };
  if (token.operation !== operation) {
    return { ok: false, reason: `令牌操作不匹配：期望 ${operation}，实际 ${token.operation}` };
  }
  if (now > token.expiresAt) return { ok: false, reason: "令牌已过期（5 分钟有效期）" };
  return { ok: true };
}
