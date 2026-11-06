// capability-map（P1 迭代）：按 设备型号::buildId 记录真实耗时/成功率，估算优先查历史
// 文件：stateDir/capability-map.json；原子写；损坏视为空（下次写入覆盖）
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FieldValue, PlanEstimate } from "./types.js";

export interface CapabilitySample {
  intent: "flash" | "root" | string;
  durationMs: number;
  success: boolean;
  mode: "exploration" | "accelerated" | string;
  timestamp: number;
}

export interface CapabilityEntry {
  samples: CapabilitySample[];
}

export interface CapabilityMap {
  version: 1;
  entries: Record<string, CapabilityEntry>;
}

const MAX_SAMPLES_PER_ENTRY = 50;
export const MIN_SAMPLES_FOR_ESTIMATE = 5;

function mapFile(stateDir: string): string {
  return path.join(stateDir, "capability-map.json");
}

// 键：型号::buildId（任一缺失用 unknown 占位）
export function capabilityKey(model: string | null, buildId: string | null): string {
  return `${model ?? "unknown"}::${buildId ?? "unknown"}`;
}

export function capabilityKeyFromState(fields: Record<string, FieldValue>): string {
  return capabilityKey(
    fields.deviceModel !== undefined && fields.deviceModel !== null ? String(fields.deviceModel) : null,
    fields.buildId !== undefined && fields.buildId !== null ? String(fields.buildId) : null,
  );
}

export function loadCapabilityMap(stateDir: string): CapabilityMap {
  const f = mapFile(stateDir);
  if (!existsSync(f)) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(f, "utf8")) as CapabilityMap;
    if (parsed.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
      throw new Error("bad shape");
    }
    return parsed;
  } catch {
    return { version: 1, entries: {} }; // 损坏 → 视为空，不阻塞主流程
  }
}

export function saveCapabilityMap(stateDir: string, map: CapabilityMap): void {
  mkdirSync(stateDir, { recursive: true });
  const tmp = path.join(stateDir, `capability-map.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, JSON.stringify(map, null, 2));
  renameSync(tmp, mapFile(stateDir)); // 原子替换
}

// 单进程编排器场景下 load-modify-save 足够；多进程并发写入靠原子 rename 保证不出现半文件
export function recordSample(stateDir: string, key: string, sample: CapabilitySample): void {
  const map = loadCapabilityMap(stateDir);
  const entry = (map.entries[key] ??= { samples: [] });
  entry.samples.push(sample);
  // 滚动窗口：只保留最近 50 条，老样本对当前固件版本已无参考价值
  if (entry.samples.length > MAX_SAMPLES_PER_ENTRY) {
    entry.samples.splice(0, entry.samples.length - MAX_SAMPLES_PER_ENTRY);
  }
  saveCapabilityMap(stateDir, map);
}

// 线性插值分位数：pos = (n-1)*q，落在两采样点之间时线性插值
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * 历史估算：先按 intent+mode 精确过滤；样本不足放宽 mode；再不足返回 null（调用方兜底默认值）。
 * estimateIntent 映射：root 计划查 "root" 全流程样本；flash_rom 计划查 "flash" 单次刷写样本。
 */
export function estimateFromHistory(
  stateDir: string,
  key: string,
  intent: string,
  mode: string,
  opts?: { minSamples?: number },
): PlanEstimate | null {
  const map = loadCapabilityMap(stateDir);
  const entry = map.entries[key];
  if (!entry || entry.samples.length === 0) return null;
  const min = opts?.minSamples ?? MIN_SAMPLES_FOR_ESTIMATE;

  let samples = entry.samples.filter((s) => s.intent === intent && s.mode === mode);
  if (samples.length < min) samples = entry.samples.filter((s) => s.intent === intent);
  if (samples.length < min) return null;

  const durations = samples.map((s) => s.durationMs).sort((a, b) => a - b);
  return {
    p50Ms: Math.round(percentile(durations, 0.5)),
    p90Ms: Math.round(percentile(durations, 0.9)),
    successRate: samples.filter((s) => s.success).length / samples.length,
  };
}
