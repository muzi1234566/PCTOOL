// resource_resolver（第一章接口 + 5.3 确定性获取）：别名表 → GitHub Releases / mirror，
// 强制 SHA256（5.3），本地预缓存命中直接跳过网络
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { OrchestratorConfig } from "./config.js";
import { OrchestratorError } from "./errors.js";
import { run } from "./exec.js";
import { sha256File } from "./hash.js";
import { ResourceResolverRequest } from "./types.js";

export interface ResolvedResource {
  url: string;
  sha256: string;
  size: number;
  metadata: Record<string, unknown>;
  cachePath?: string;
  fromCache: boolean;
}

interface GithubRelease {
  tag_name: string;
  name?: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
    digest?: string;
  }>;
}

// 精确资源标识 → 仓库 + 资产匹配模式（5.3：禁止自然语言搜索）
// 注：ZygiskNext/PIF 的仓库归属若随社区迁移变动，改这里即可（README「诚实边界」有说明）
const GITHUB_ALIASES: Record<string, { owner: string; repo: string; assetPattern: RegExp }> = {
  magisk: { owner: "topjohnwu", repo: "Magisk", assetPattern: /Magisk-.*\.apk$/i },
  kernelsu: { owner: "tiann", repo: "KernelSU", assetPattern: /KernelSU.*\.apk$/i },
  apatch: { owner: "bmax121", repo: "APatch", assetPattern: /APatch.*\.apk$/i },
  zygisk_next: { owner: "JingMatrix", repo: "ZygiskNext", assetPattern: /ZygiskNext.*\.zip$/i },
  playintegrityfix: { owner: "chiteroman", repo: "PlayIntegrityFix", assetPattern: /PlayIntegrityFix.*\.zip$/i },
  // LSPosed 官方仓库曾下架，社区 fork 持续维护；归属变动时改这里
  lsposed: { owner: "JingMatrix", repo: "LSPosed", assetPattern: /LSPosed.*\.zip$/i },
};

function sanitizeQuery(query: string): string {
  return query.replace(/[^A-Za-z0-9_\-.]/g, "_");
}

async function fetchJson<T>(url: string): Promise<T> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "android-playground-orchestrator", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new OrchestratorError("resource_corrupted", `HTTP ${resp.status}：${url}`, { url });
  return (await resp.json()) as T;
}

async function resolveGithub(cfg: OrchestratorConfig, query: string): Promise<ResolvedResource> {
  const tokens = query.split("_").filter((t) => t.length > 0);
  const aliasKey = tokens[0].toLowerCase();
  const alias = GITHUB_ALIASES[aliasKey];
  if (!alias) {
    throw new OrchestratorError("resource_corrupted", `未注册的 GitHub 别名 "${aliasKey}"：请扩展 GITHUB_ALIASES 或改用 mirror 源`, { query });
  }
  const filters = tokens.slice(1).map((t) => t.toLowerCase()); // 如 canary / 27001
  const releases = await fetchJson<GithubRelease[]>(
    `https://api.github.com/repos/${alias.owner}/${alias.repo}/releases?per_page=30`,
  );

  // 版本 token 过滤：tag 或资产名包含即命中；无 token 取最新
  const matched = releases.filter((r) => {
    if (filters.length === 0) return true;
    const hay = `${r.tag_name} ${r.name ?? ""} ${r.assets.map((a) => a.name).join(" ")}`.toLowerCase();
    return filters.every((t) => hay.includes(t));
  });
  const release = matched[0] ?? releases[0];
  if (!release) throw new OrchestratorError("resource_corrupted", "仓库无可用 release", { query });

  const asset = release.assets.find(
    (a) => alias.assetPattern.test(a.name) && filters.every((t) => a.name.toLowerCase().includes(t)),
  ) ?? release.assets.find((a) => alias.assetPattern.test(a.name));
  if (!asset) throw new OrchestratorError("resource_corrupted", "release 中无匹配资产", { query, tag: release.tag_name });

  // requireSHA256 强制：GitHub 资产无 digest 字段时拒绝交付，绝不静默放行
  const digest = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7).toLowerCase() : asset.digest?.toLowerCase();
  if (!digest) {
    throw new OrchestratorError("resource_corrupted", "该资产未提供 sha256，按规范拒绝交付（requireSHA256=true）", { asset: asset.name });
  }
  return {
    url: asset.browser_download_url,
    sha256: digest,
    size: asset.size,
    metadata: { source: "github", repo: `${alias.owner}/${alias.repo}`, tag: release.tag_name, asset: asset.name },
    fromCache: false,
  };
}

async function resolveMirror(cfg: OrchestratorConfig, query: string): Promise<ResolvedResource> {
  if (!cfg.mirrorBase) throw new OrchestratorError("resource_corrupted", "mirrorBase 未配置，mirror 源不可用", { query });
  // mirror 返回固定结构 { url, sha256, size }，确定性拼接，不做搜索
  return fetchJson<ResolvedResource>(`${cfg.mirrorBase.replace(/\/$/, "")}/${encodeURIComponent(query)}`);
}

async function downloadTo(url: string, dest: string, expected: { sha256: string; size: number }): Promise<void> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "android-playground-orchestrator" },
    signal: AbortSignal.timeout(300000),
  });
  if (!resp.ok || !resp.body) {
    throw new OrchestratorError("resource_corrupted", `下载失败 HTTP ${resp.status}`, { url });
  }
  const hash = createHash("sha256");
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  const ws = createWriteStream(dest);
  try {
    await pipeline(Readable.fromWeb(resp.body as unknown as NodeWebReadableStream), tap, ws);
  } catch (e) {
    try { unlinkSync(dest); } catch { /* 清理失败不影响主错误 */ }
    throw new OrchestratorError("resource_corrupted", `下载中断：${String(e)}`, { url });
  }
  const actual = hash.digest("hex");
  if (actual !== expected.sha256.toLowerCase()) {
    unlinkSync(dest); // 不匹配 → 丢弃（5.3）
    throw new OrchestratorError("resource_corrupted", `SHA256 不匹配：期望 ${expected.sha256}，实际 ${actual}，文件已丢弃`, { url });
  }
  if (expected.size > 0 && size !== expected.size) {
    unlinkSync(dest);
    throw new OrchestratorError("resource_corrupted", `大小不匹配：期望 ${expected.size}，实际 ${size}，文件已丢弃`, { url });
  }
}

// ───────────── v4 二：多源并发测速竞速下载 ─────────────
// GitHub 直连 + 内置镜像前缀；Range 0-0 探测延迟，按延迟排序逐个下载，sha256 逐源校验，损坏源自动切下一个。
const MIRRORS: Array<{ name: string; prefix: string }> = [
  { name: "direct", prefix: "" },
  { name: "ghproxy.net", prefix: "https://ghproxy.net/" },
  { name: "gh-proxy.com", prefix: "https://gh-proxy.com/" },
];

async function probeLatency(url: string): Promise<number | null> {
  const t = Date.now();
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0", "User-Agent": "android-playground-orchestrator" },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return null;
    await resp.arrayBuffer();
    return Date.now() - t;
  } catch {
    return null;
  }
}

export async function raceDownload(url: string, dest: string, expected: { sha256: string; size: number }): Promise<{ mirror: string; ms: number | null }> {
  const candidates = MIRRORS.map((m) => ({ name: m.name, url: `${m.prefix}${url}` }));
  const probed = await Promise.all(candidates.map(async (c) => ({ ...c, ms: await probeLatency(c.url) })));
  const alive = probed.filter((p) => p.ms !== null).sort((a, b) => (a.ms as number) - (b.ms as number));
  const order = alive.length > 0 ? alive : probed;
  let lastError: unknown = null;
  for (const c of order) {
    try {
      await downloadTo(c.url, dest, expected);
      return { mirror: c.name, ms: c.ms };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new OrchestratorError("resource_corrupted", `所有镜像源均失败：${url}`, { url });
}

// ───────────── v4 二：手机端自主下载（>50MB 不走 adb push） ─────────────
export const ONDEVICE_MIN_BYTES = 50 * 1024 * 1024;

export function shouldDownloadOnDevice(size: number, enabled: boolean): boolean {
  return enabled && size >= ONDEVICE_MIN_BYTES;
}

// 手机经 Wi-Fi 自主下载到 /data/local/tmp，设备端 sha256 校验通过后 pull 回缓存
async function downloadOnDevice(cfg: OrchestratorConfig, url: string, dest: string, expected: { sha256: string; size: number }): Promise<void> {
  const remote = `/data/local/tmp/dsh-dl-${Date.now()}.bin`;
  const tool = await run(cfg.adbPath, ["shell", "command -v wget || command -v curl"], 8000).catch(() => null);
  const bin = tool?.stdout.trim().split("\n")[0]?.trim() ?? "";
  if (bin.length === 0) {
    throw new OrchestratorError("infeasible", "设备端无 wget/curl：回退 PC 下载", {});
  }
  const cmd = bin.endsWith("wget") ? `wget -q -O ${remote} ${url}` : `curl -fsSL -o ${remote} ${url}`;
  const dl = await run(cfg.adbPath, ["shell", cmd], 600000);
  if (dl.code !== 0) {
    throw new OrchestratorError("resource_corrupted", `设备端下载失败：${dl.stderr.slice(-300)}`, { url });
  }
  const sha = await run(cfg.adbPath, ["shell", `sha256sum ${remote}`], 30000);
  const deviceSha = sha.stdout.trim().split(/\s+/)[0] ?? "";
  if (deviceSha !== expected.sha256.toLowerCase()) {
    await run(cfg.adbPath, ["shell", `rm -f ${remote}`], 8000).catch(() => null);
    throw new OrchestratorError("resource_corrupted", `设备端 SHA256 不匹配：期望 ${expected.sha256}，实际 ${deviceSha}，已删除`, { url });
  }
  const pull = await run(cfg.adbPath, ["pull", remote, dest], 600000);
  await run(cfg.adbPath, ["shell", `rm -f ${remote}`], 8000).catch(() => null);
  if (pull.code !== 0) {
    throw new OrchestratorError("resource_corrupted", `拉取失败：${pull.stderr.slice(-300)}`, { url });
  }
}

export async function resolveResource(cfg: OrchestratorConfig, req: ResourceResolverRequest): Promise<ResolvedResource> {
  if (req.requireSHA256 !== true) {
    throw new OrchestratorError("needs_clarification", "requireSHA256 必须为 true（规范强制）", { query: req.query });
  }
  const key = sanitizeQuery(req.query);
  const metaPath = path.join(cfg.cacheDir, `${key}.res.json`);

  // 5.3：本地预缓存命中 → 跳过网络；缓存文件哈希复验
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { url: string; sha256: string; size: number; bin: string };
      const binPath = path.join(cfg.cacheDir, meta.bin);
      if (existsSync(binPath) && (await sha256File(binPath)) === meta.sha256.toLowerCase()) {
        return { url: meta.url, sha256: meta.sha256, size: meta.size, metadata: { source: "local-cache" }, cachePath: binPath, fromCache: true };
      }
    } catch {
      // 缓存元数据损坏 → 当作未命中重新解析
    }
  }

  const errors: string[] = [];
  for (const source of req.sources) {
    try {
      const res =
        source === "github" ? await resolveGithub(cfg, req.query)
        : source === "mirror" ? await resolveMirror(cfg, req.query)
        : (() => { throw new OrchestratorError("resource_corrupted", "official 源未注册解析器（厂商固件库需按机型配置）", { query: req.query }); })();
      const binName = `${key}.bin`;
      const binPath = path.join(cfg.cacheDir, binName);
      const expected = { sha256: res.sha256, size: res.size };
      let mirrorInfo: Record<string, unknown> = {};
      if (shouldDownloadOnDevice(res.size, cfg.onDeviceDownload === true)) {
        // v4 二：大文件让手机走 Wi-Fi 自主下载，PC 只下发指令和校验 SHA256
        await downloadOnDevice(cfg, res.url, binPath, expected);
        mirrorInfo = { transport: "on-device-wifi" };
      } else {
        const raced = await raceDownload(res.url, binPath, expected);
        mirrorInfo = { transport: "pc-race", mirror: raced.mirror, probeMs: raced.ms };
      }
      writeFileSync(metaPath, JSON.stringify({ url: res.url, sha256: res.sha256, size: res.size, bin: binName, transport: mirrorInfo.transport }));
      return { ...res, cachePath: binPath, fromCache: false, metadata: { ...res.metadata, ...mirrorInfo } };
    } catch (e) {
      errors.push(String(e));
    }
  }
  throw new OrchestratorError("resource_corrupted", `所有源均失败：${errors.join(" | ")}`, { query: req.query, sources: req.sources });
}
