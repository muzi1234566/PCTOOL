// flash_partition（第一章接口 + 6.1/6.2/6.5 + 5.2 增量探测配合）
// v4：写入路径全部走 opbus 结构化命令（自由拼接的命令串在执行层物理不可达）
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { OrchestratorConfig } from "./config.js";
import { OrchestratorError } from "./errors.js";
import { parseGetvar, run } from "./exec.js";
import { materialize } from "./opbus.js";
import { sha256File } from "./hash.js";
import { detectSparse, dontCareOverlaps, parseSparseInfo, sparseToRaw, SparseInfo } from "./sparse.js";
import { FlashPartitionRequest, Slot } from "./types.js";

export interface FlashPrecheck {
  ok: boolean;
  deviceIsAb: boolean;
  resolvedSlot: "a" | "b" | null;
  fastbootPartition: string;  // A/B 设备带槽位后缀，如 boot_a
  imageToFlash: string;       // 稀疏镜像转换后的 raw 路径
  sparse?: SparseInfo;
}

async function getvarAll(cfg: OrchestratorConfig): Promise<Map<string, string>> {
  const r = await run(cfg.fastbootPath, ["getvar", "all"], cfg.cmdTimeoutMs).catch(() => null);
  if (!r) return new Map();
  return parseGetvar(`${r.stdout}\n${r.stderr}`);
}

function readHead(p: string, n: number): Buffer {
  const fd = openSync(p, "r");
  try {
    const b = Buffer.alloc(n);
    const read = readSync(fd, b, 0, n, 0);
    return b.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

// 刷写前预检：镜像存在 + SHA256 比对（5.3）+ 槽位解析（A/B 必须）+ 6.2 重试次数 + 稀疏处理（6.5）
export async function flashPrecheck(
  cfg: OrchestratorConfig,
  req: FlashPartitionRequest,
  metadataRanges: Array<{ startBlock: number; blocks: number }> = [],
): Promise<FlashPrecheck> {
  if (req.partition === "super") {
    throw new OrchestratorError("deny_auto", "super 分区禁止自动刷写（6.1）：先只读 verify-super-layout 获取元数据，再按拆分流程手动执行", { partition: "super" });
  }
  if (!existsSync(req.imagePath)) {
    throw new OrchestratorError("resource_corrupted", `镜像不存在：${req.imagePath}`, {});
  }
  const actual = await sha256File(req.imagePath);
  if (actual.toLowerCase() !== req.verifySHA256.toLowerCase()) {
    throw new OrchestratorError("resource_corrupted", `镜像 SHA256 不匹配：期望 ${req.verifySHA256}，实际 ${actual}`, {});
  }

  const vars = await getvarAll(cfg);
  const isAb = vars.get(`has-slot:${req.partition}`) === "yes" || vars.has("current-slot");
  let slot: "a" | "b" | null = null;
  if (isAb) {
    const want: Slot = req.slot ?? "current";
    slot = want === "current" ? ((vars.get("current-slot") as "a" | "b" | null) ?? null) : want;
    if (slot !== "a" && slot !== "b") {
      throw new OrchestratorError("needs_clarification", "无法确定目标槽位：getvar current-slot 不可读，请在请求中显式指定 slot a/b", {
        currentSlotRaw: vars.get("current-slot") ?? null,
      });
    }
    // 6.2：tries=1 时写当前 slot 的 boot → infeasible
    if (req.partition === "boot" && vars.get(`slot-retry-count:${slot}`) === "1") {
      throw new OrchestratorError("infeasible", `当前槽位 ${slot} 重试次数仅剩 1（6.2）：写 boot 可能失去最后可启动槽位`, {
        hint: "fastboot --set-other=next && fastboot set_active other，或提供另一槽位镜像",
      });
    }
  }

  let imageToFlash = req.imagePath;
  let sparse: SparseInfo | undefined;
  if (detectSparse(readHead(req.imagePath, 512))) {
    if (req.sparseHandling === "manual") {
      throw new OrchestratorError("deny_auto", "稀疏镜像按 manual 策略不自动处理：先 simg2img 转换为 raw 再刷", {});
    }
    const full = readFileSync(req.imagePath);
    sparse = parseSparseInfo(full);
    const overlaps = dontCareOverlaps(sparse, metadataRanges);
    if (overlaps.length > 0) {
      throw new OrchestratorError("deny_auto", "DONT_CARE 段与元数据重叠（6.5）：必须先 erase 归零该区域再刷写", { overlaps });
    }
    const rawPath = `${req.imagePath}.raw`;
    sparseToRaw(req.imagePath, rawPath);
    imageToFlash = rawPath;
  }

  return {
    ok: true,
    deviceIsAb: isAb,
    resolvedSlot: slot,
    fastbootPartition: isAb && slot ? `${req.partition}_${slot}` : req.partition,
    imageToFlash,
    sparse,
  };
}

export async function flashImage(cfg: OrchestratorConfig, req: FlashPartitionRequest, precheck: FlashPrecheck): Promise<{ output: string }> {
  // v4 一：write_partition 走 opbus 结构化下发（argv 由纯 TS 拼装，注入串物理不可达）
  const cmd = materialize({ action: "write_partition", target: precheck.fastbootPartition, file: precheck.imageToFlash });
  const args = [...(req.fastbootFlags ?? []), ...cmd.args];
  const r = await run(cfg.fastbootPath, args, cfg.cmdTimeoutMs * 20); // 大镜像预留
  if (r.timedOut) {
    // 7.2：超时 → unknown_physical_state，禁止自动重试，下一步必须只读验证
    throw new OrchestratorError("unknown_physical_state", "flash 超时：物理状态未知（7.2）。禁止自动重试，下一步必须只读验证", {
      partition: precheck.fastbootPartition,
    });
  }
  if (r.code !== 0) {
    throw new OrchestratorError("infeasible", `fastboot flash ${precheck.fastbootPartition} 失败（exit ${r.code}）`, {
      stderrTail: r.stderr.slice(-1500),
      stdoutTail: r.stdout.slice(-1500),
    });
  }
  return { output: `${r.stdout}\n${r.stderr}`.slice(-4000) };
}
