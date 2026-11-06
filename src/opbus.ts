// opbus（v4 一）：结构化命令总线——执行层物理隔离。
// LLM/调用方不允许自由拼接命令字符串；只能下发结构化操作，由本模块的纯 TS 逻辑拼接 argv。
// spawn 不经 shell，argv 数组天然免疫注入；任何越权 action / 元字符注入 → 拦截 + 抛结构化错误（调用方落审计链）。
// 规范 2.3：erase/format/unlock 永不自动执行 —— opbus 根本不暴露这些 action。
import { OrchestratorError } from "./errors.js";
import { run } from "./exec.js";
import type { OrchestratorConfig } from "./config.js";

export type OpAction =
  | "write_partition"      // fastboot flash <target> <file>
  | "boot_temp"            // fastboot boot <file>（不落盘）
  | "reboot"               // adb reboot
  | "reboot_bootloader"    // adb reboot bootloader
  | "push_file"            // adb push <file> <target:devicePath>
  | "sysfs_write"          // su echo value > path
  | "install_module_zip"   // su magisk --install-module <target:devicePath>
  | "ui_tap"               // input tap x,y（坐标只能来自 uiautomator 解析）
  | "wake_unlock"          // input keyevent 82（锁屏时尝试唤醒，v5 RC1）
  | "fs_trim"              // su fstrim -v /data（硬件保养）
  | "shell_read";          // 固定模板只读：cat/getprop/sha256sum/ls

// 显式黑名单：即使未来有人往白名单里塞，也不允许这几类动作出现
const NEVER_ACTIONS = ["erase_partition", "format_partition", "unlock", "oem_unlock", "flash_bootloader", "firehose"];

const PARTITION_RE = /^[A-Za-z0-9_]+(_[ab])?$/;
const SLOT_RE = /^[ab]$/;
// v5 RC1：宿主路径允许中文/CJK 与空格（张三\Desktop\boot.img），但 shell 元字符仍被 SHELL_META 拦截
const HOST_PATH_RE = /^[A-Za-z0-9_\-\\/:.（）()~\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF ]+$/;
const DEVICE_PATH_RE = /^\/data\/local\/tmp\/[A-Za-z0-9._\-]+$/;
const SYSFS_PATH_RE = /^\/sys\/[A-Za-z0-9_\/.\-]+$/;
const SYSFS_VALUE_RE = /^[A-Za-z0-9_.\-]+$/;
const PROP_RE = /^[A-Za-z0-9_.]+$/;
const XY_RE = /^\d+,\d+$/;
// shell 元字符：任何 value/target 字段出现即拦截（argv 免疫注入，此为纵深防御）
const SHELL_META = /[;|&$`><\n\r]/;

export interface StructuredOp {
  action: OpAction;
  target?: string; // 分区/槽位/设备路径/属性名/坐标
  file?: string;   // 宿主镜像路径
  value?: string;  // sysfs 值 / 只读模板参数
}

export interface MaterializedCmd {
  kind: "adb" | "fastboot";
  args: string[];
}

function fail(op: Partial<StructuredOp>, reason: string): never {
  throw new OrchestratorError("infeasible", `opbus 拦截：${reason}`, { opbusBlocked: true, op });
}

export function assertOp(input: unknown): asserts input is StructuredOp {
  const op = input as StructuredOp;
  if (!op || typeof op !== "object" || typeof op.action !== "string") {
    fail(op, "缺少 action");
  }
  if ((NEVER_ACTIONS as string[]).includes(op.action)) {
    fail(op, `action ${op.action} 属永不自动执行类（规范 2.3），opbus 不暴露`);
  }
  const allowed: OpAction[] = ["write_partition", "boot_temp", "reboot", "reboot_bootloader", "push_file", "sysfs_write", "install_module_zip", "ui_tap", "wake_unlock", "fs_trim", "shell_read"];
  if (!allowed.includes(op.action)) {
    fail(op, `未知 action ${op.action}（白名单外）`);
  }
  for (const field of ["target", "file", "value"] as const) {
    const v = op[field];
    if (v !== undefined && (typeof v !== "string" || SHELL_META.test(v))) {
      fail(op, `字段 ${field} 含 shell 元字符或类型非法`);
    }
  }
}

// 纯函数：结构化操作 → argv。无任何自由拼接路径。
export function materialize(op: StructuredOp): MaterializedCmd {
  assertOp(op);
  switch (op.action) {
    case "write_partition": {
      if (!op.target || !PARTITION_RE.test(op.target) || !op.file || !HOST_PATH_RE.test(op.file)) fail(op, "write_partition 需要 target=分区名、file=宿主镜像路径");
      return { kind: "fastboot", args: ["flash", op.target, op.file] };
    }
    case "boot_temp": {
      if (!op.file || !HOST_PATH_RE.test(op.file)) fail(op, "boot_temp 需要 file=宿主镜像路径");
      return { kind: "fastboot", args: ["boot", op.file] };
    }
    case "reboot":
      return { kind: "adb", args: ["reboot"] };
    case "reboot_bootloader":
      return { kind: "adb", args: ["reboot", "bootloader"] };
    case "push_file": {
      if (!op.file || !HOST_PATH_RE.test(op.file) || !op.target || !DEVICE_PATH_RE.test(op.target)) fail(op, "push_file 需要 file=宿主路径、target=/data/local/tmp/ 下路径");
      return { kind: "adb", args: ["push", op.file, op.target] };
    }
    case "sysfs_write": {
      if (!op.target || !SYSFS_PATH_RE.test(op.target) || !op.value || !SYSFS_VALUE_RE.test(op.value)) fail(op, "sysfs_write 需要 target=/sys/ 路径、value=白名单字符");
      return { kind: "adb", args: ["shell", `su -c sh -c 'echo ${op.value} > ${op.target}'`] };
    }
    case "install_module_zip": {
      if (!op.target || !DEVICE_PATH_RE.test(op.target)) fail(op, "install_module_zip 需要 target=/data/local/tmp/ 下 zip 路径");
      return { kind: "adb", args: ["shell", `su -c magisk --install-module ${op.target}`] };
    }
    case "ui_tap": {
      if (!op.target || !XY_RE.test(op.target)) fail(op, "ui_tap 需要 target=x,y（整数坐标，来源仅限 uiautomator 解析）");
      const [x, y] = op.target.split(",");
      return { kind: "adb", args: ["shell", `input tap ${x} ${y}`] };
    }
    case "wake_unlock":
      // v5 RC1：锁屏兜底——KEYCODE_MENU（82）尝试唤起解锁界面；不触碰数据
      return { kind: "adb", args: ["shell", "input keyevent 82"] };
    case "fs_trim":
      return { kind: "adb", args: ["shell", "su -c fstrim -v /data"] };
    case "shell_read": {
      // 只读固定模板：value 携带参数，路径/属性名单独校验
      if (!op.value || !op.target) fail(op, "shell_read 需要 value=模板名、target=参数");
      const t = op.value;
      if (t === "getprop") {
        if (!PROP_RE.test(op.target)) fail(op, "getprop 参数非法");
        return { kind: "adb", args: ["shell", `getprop ${op.target}`] };
      }
      if (t === "cat" || t === "sha256sum" || t === "ls") {
        const path = t === "cat" && op.target.startsWith("/sys/") ? op.target : op.target.startsWith("/data/local/tmp/") || op.target.startsWith("/sys/") ? op.target : null;
        if (!path) fail(op, `${t} 仅允许 /data/local/tmp/ 或 /sys/ 下路径`);
        return { kind: "adb", args: ["shell", `su -c ${t} ${path}`] };
      }
      fail(op, `未知只读模板 ${t}`);
    }
  }
}

// 执行入口：校验 → 拼装 → spawn（不经 shell）。超时语义与 exec.run 一致。
export async function runStructured(cfg: OrchestratorConfig, op: StructuredOp, timeoutMs?: number): Promise<ReturnType<typeof run>> {
  const cmd = materialize(op);
  const bin = cmd.kind === "fastboot" ? cfg.fastbootPath : cfg.adbPath;
  return run(bin, cmd.args, timeoutMs ?? cfg.cmdTimeoutMs);
}
