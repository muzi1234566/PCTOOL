// 物理约束硬阻断（P2）：电量/存储健康度/温度
import { OrchestratorConfig } from "./config.js";
import { OrchestratorError } from "./errors.js";
import { run } from "./exec.js";
import { DeviceState } from "./types.js";

export type StorageHealthLevel = "ok" | "warning" | "critical";

// eMMC life_time 形如 "0x0A 0x0B"（Type A / Type B 磨损估计，0x01 最新 → 0x0B 寿命耗尽）
// 取两者较大值分级：≤0x03 ok；0x04-0x07 warning；≥0x08 critical
export function classifyStorageHealth(raw: string | null): { level: StorageHealthLevel; usedValue: number | null; raw: string | null } {
  if (!raw) return { level: "ok", usedValue: null, raw: null }; // 不可判不算 warning：降级规则另行处理
  const vals = [...raw.matchAll(/0x([0-9A-Fa-f]{1,2})/g)]
    .map((m) => parseInt(m[1], 16))
    .filter((v) => v >= 1 && v <= 11);
  if (vals.length === 0) return { level: "ok", usedValue: null, raw };
  const used = Math.max(...vals);
  const level: StorageHealthLevel = used >= 8 ? "critical" : used >= 4 ? "warning" : "ok";
  return { level, usedValue: used, raw };
}

// 硬阻断：电量 <20%（且可读）→ infeasible；存储 warning → infeasible；寿命极低（critical）→ deny_hard（v4 四：物理级拒绝）。
// 电量不可读（fastboot 下 N/A）不触发硬阻断——由 P1 降级规则另行处理。
export function assertPhysicalHardStops(state: DeviceState): void {
  const battery = state.fields.batteryLevel;
  if (typeof battery === "number" && battery < 20) {
    throw new OrchestratorError("infeasible", `电量 ${battery}% 低于 20% 硬阈值：拒绝进入 fastboot/EDL/写入流程（先充电到 ≥20%）`, {
      batteryLevel: battery,
    });
  }
  const sh = typeof state.fields.storageHealth === "string" ? state.fields.storageHealth : null;
  const health = classifyStorageHealth(sh);
  if (health.level === "critical") {
    throw new OrchestratorError(
      "deny_hard",
      `闪存寿命极低（life_time=${health.raw ?? "未知"}，磨损值 ${health.usedValue}）：写入可能直接击穿剩余寿命导致存储永久故障，物理级拒绝`,
      { level: health.level, usedValue: health.usedValue, raw: health.raw },
    );
  }
  if (health.level === "warning") {
    throw new OrchestratorError(
      "infeasible",
      `存储健康度 warning（life_time=${health.raw ?? "未知"}，磨损值 ${health.usedValue}）：写入可能失败或加速损耗，拒绝写入流程`,
      { level: health.level, usedValue: health.usedValue, raw: health.raw },
    );
  }
}

// 大分区写入集合：preSnapshot 必含温度 + 超时提示高温擦除延迟
export const LARGE_WRITE_PARTITIONS: readonly string[] = ["system", "super", "vendor", "product", "odm"];

// 温度采集（毫摄氏度兼容）：/sys/class/thermal/thermal_zone{0,1,2}/temp，adb 可读；fastboot/无节点 → null
export async function readTemperatureC(cfg: OrchestratorConfig): Promise<number | null> {
  for (const zone of [0, 1, 2]) {
    const r = await run(cfg.adbPath, ["shell", `cat /sys/class/thermal/thermal_zone${zone}/temp 2>/dev/null`], 5000).catch(() => null);
    if (r && r.code === 0) {
      const line = r.stdout.trim().split("\n")[0] ?? "";
      const v = Number(line);
      if (Number.isFinite(v) && v > 0) return Math.round(v > 1000 ? v / 1000 : v);
    }
  }
  return null;
}
