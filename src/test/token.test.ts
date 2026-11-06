// Override Token 单元测试（纯逻辑，无设备）
import assert from "node:assert/strict";
import test from "node:test";
import { generateToken, verifyToken } from "../override-token.js";

test("令牌：正常签发与验证通过", () => {
  const t = generateToken("flash_boot", "s3cret");
  const v = verifyToken(t, "flash_boot", "s3cret");
  assert.equal(v.ok, true);
});

test("令牌：篡改签名被拒", () => {
  const t = generateToken("flash_boot", "k1");
  t.signature = (t.signature.startsWith("0") ? "1" : "0") + t.signature.slice(1);
  const v = verifyToken(t, "flash_boot", "k1");
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /签名/);
});

test("令牌：密钥不匹配被拒", () => {
  const t = generateToken("flash_boot", "k1");
  assert.equal(verifyToken(t, "flash_boot", "k2").ok, false);
});

test("令牌：过期被拒（5 分钟有效期）", () => {
  const t = generateToken("erase_partition", "k");
  const v = verifyToken(t, "erase_partition", "k", Date.now() + 6 * 60 * 1000);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /过期/);
});

test("令牌：操作不匹配被拒", () => {
  const t = generateToken("flash_boot", "k");
  const v = verifyToken(t, "erase_partition", "k");
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /不匹配/);
});

test("令牌：riskAcknowledged=false 被拒", () => {
  const t = generateToken("flash_boot", "k");
  t.riskAcknowledged = false;
  const v = verifyToken(t, "flash_boot", "k");
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /riskAcknowledged/);
});
