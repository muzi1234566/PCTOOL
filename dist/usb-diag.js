// usb-diag（v4 四）：USB 探针——fastboot 连续握手超时时，读取宿主机驱动状态并给出常见病因
import { run } from "./exec.js";
export const COMMON_HINTS = [
    "USB 3.0 xHCI 控制器兼容性冲突：改插 USB 2.0 口（机箱前面板优先试主机后置）或经 USB 2.0 Hub 转接",
    "线材质量：换一根可传数据的短粗线（不少『充电线』无数据芯）",
    "供电不足：前置面板口功率弱，换后置主板直出口",
    "驱动：Windows 装 Google USB Driver / 设备厂商 fastboot 驱动，设备管理器看是否有黄色感叹号",
];
export async function diagnoseUsb() {
    const hints = [...COMMON_HINTS];
    if (process.platform === "win32") {
        // Windows：pnputil 枚举已连接设备，捞 Android/9008/Fastboot 关键字（失败静默，不阻塞主流程）
        try {
            const r = await run("pnputil", ["/enum-devices", "/connected"], 8000);
            const interesting = r.stdout
                .split("\n")
                .filter((l) => /android|9008|fastboot|adb|qualcomm/i.test(l))
                .slice(0, 6);
            if (interesting.length > 0)
                hints.push(`驱动层相关条目：${interesting.map((s) => s.trim()).join(" / ")}`);
            else
                hints.push("pnputil 未发现 Android/9008 相关设备：可能驱动未安装或设备未枚举");
        }
        catch {
            hints.push("pnputil 不可用：请手动打开设备管理器检查");
        }
    }
    return hints;
}
