// ui-auto（v4 三）：UI 自动化降维打击——放弃 input tap 盲猜。
// uiautomator dump 解析 XML 树 → 按 text/resource-id 定位节点 → 计算中心点走 opbus ui_tap → 前后 dump 比对做状态校验，无变化触发备用指引。
// 坐标只能来自 dump 解析结果（LLM 无法直接传坐标）。
import { run } from "./exec.js";
import { runStructured } from "./opbus.js";
import type { OrchestratorConfig } from "./config.js";

export interface UiNode {
  text: string;
  resourceId: string;
  bounds: [number, number, number, number]; // l, t, r, b
  clickable: boolean;
}

// 容忍属性顺序差异：逐节点提取需要的属性
export function parseUiDump(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  const nodeRe = /<node\b[^>]*>/g;
  for (const tag of xml.matchAll(nodeRe)) {
    const attr = (name: string): string => {
      const m = new RegExp(`${name}="([^"]*)"`).exec(tag[0]);
      return m ? m[1] : "";
    };
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag[0]);
    if (!b) continue;
    nodes.push({
      text: attr("text"),
      resourceId: attr("resource-id"),
      bounds: [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])],
      clickable: attr("clickable") === "true",
    });
  }
  return nodes;
}

export function center(n: UiNode): [number, number] {
  return [Math.round((n.bounds[0] + n.bounds[2]) / 2), Math.round((n.bounds[1] + n.bounds[3]) / 2)];
}

export interface NodeMatcher {
  textExact?: string;     // 如 "允许"
  textContains?: string;
  resourceId?: string;
}

export function findNode(nodes: UiNode[], matcher: NodeMatcher): UiNode | null {
  for (const n of nodes) {
    if (matcher.textExact !== undefined && n.text !== matcher.textExact) continue;
    if (matcher.textContains !== undefined && !n.text.includes(matcher.textContains)) continue;
    if (matcher.resourceId !== undefined && n.resourceId !== matcher.resourceId) continue;
    return n;
  }
  return null;
}

export function dumpSignature(nodes: UiNode[]): string {
  return nodes.map((n) => `${n.text}|${n.resourceId}|${n.bounds.join(",")}`).sort().join("\n");
}

export function dumpChanged(a: UiNode[], b: UiNode[]): boolean {
  return dumpSignature(a) !== dumpSignature(b);
}

async function dumpOnce(cfg: OrchestratorConfig): Promise<UiNode[]> {
  // 优先 dump 到 /dev/tty 直接回读；失败回退文件 + cat
  const r = await run(cfg.adbPath, ["exec-out", "uiautomator dump /dev/tty"], 10000).catch(() => null);
  if (r && r.stdout.includes("<node")) return parseUiDump(r.stdout);
  const r2 = await run(cfg.adbPath, ["shell", "uiautomator dump /data/local/tmp/ui.xml && cat /data/local/tmp/ui.xml"], 15000).catch(() => null);
  return r2 && r2.stdout.includes("<node") ? parseUiDump(r2.stdout) : [];
}

export interface UiConfirmResult {
  tapped: boolean;
  changed: boolean;
  node: UiNode | null;
  fallbackGuide: string | null; // 状态无变化/找不到节点时的人工指引
  unlockTried?: boolean;        // v5 RC1：是否触发过锁屏唤醒
}

// 授权弹窗一键处理：等待节点 → 点击 → 前后比对 → 无变化给备用方案
// v5 RC1：dump 为空（疑似锁屏/熄屏）→ 先 keyevent 82 尝试唤醒再重试一次，绝不直接抛异常
export async function uiConfirm(
  cfg: OrchestratorConfig,
  matcher: NodeMatcher,
  opts?: { timeoutMs?: number },
): Promise<UiConfirmResult> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 12000);
  let node: UiNode | null = null;
  let unlockTried = false;
  let unlockHint: string | null = null;
  while (Date.now() < deadline) {
    let nodes = await dumpOnce(cfg);
    if (nodes.length === 0 && !unlockTried) {
      // dump 拿不到任何节点：大概率锁屏/熄屏 → keyevent 82 唤醒后再试，只试一次
      unlockTried = true;
      await runStructured(cfg, { action: "wake_unlock" }).catch(() => null);
      await new Promise((res) => setTimeout(res, 900));
      nodes = await dumpOnce(cfg);
      unlockHint = "屏幕疑似锁屏/熄屏：已尝试 keyevent 82 唤醒；若仍失败请先解锁屏幕（物理操作）";
    }
    const hit = findNode(nodes, matcher);
    if (hit) {
      node = hit;
      break;
    }
    await new Promise((res) => setTimeout(res, 800));
  }
  if (!node) {
    const why = `未找到目标节点（text=${matcher.textExact ?? matcher.textContains ?? "-"} / id=${matcher.resourceId ?? "-"}）：请在设备上手动点击，或确认弹窗已出现（物理操作）`;
    return {
      tapped: false, changed: false, node: null, unlockTried,
      fallbackGuide: unlockHint ? `${unlockHint}\n${why}` : why,
    };
  }
  const [x, y] = center(node);
  await runStructured(cfg, { action: "ui_tap", target: `${x},${y}` });
  // 状态校验：比对点击前后窗口
  const before = await dumpOnce(cfg);
  const after = await dumpOnce(cfg);
  const changed = dumpChanged(before, after);
  return {
    tapped: true,
    changed,
    node,
    unlockTried,
    fallbackGuide: changed ? null : "点击后界面无变化：可能节点已失效或弹窗有防呆，请改用物理点击；确认后重试",
  };
}
