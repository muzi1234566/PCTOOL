// 手动引导模板（2.1 deny_auto / deny_with_override 附带的手动执行引导 + 风险报告）
import { WARN_LOGICAL_ERASE_ONLY } from "./errors.js";
export function guideFor(operation, ctx) {
    if (operation === "unlock_bootloader")
        return unlockGuide();
    if (operation.startsWith("erase_") || operation.startsWith("format_")) {
        return eraseGuide(ctx.partition ?? "?", ctx.method ?? "blksecdiscard", ctx.forceFastErase === true);
    }
    if (operation === "flash_abl" || operation === "flash_xbl")
        return xblAblGuide(operation);
    if (operation === "super_merge" || operation === "flash_super")
        return superGuide();
    if (operation === "firehose_write" || operation === "flash_firehose_programmer")
        return firehoseGuide();
    return degradedFlashGuide(operation);
}
function unlockGuide() {
    return {
        operation: "unlock_bootloader",
        preconditions: [
            "已完整备份（解锁会清空 userdata，全部用户数据丢失）",
            "开发者选项中 OEM 解锁已开启（oemUnlockChannel = 1）",
            "电量 ≥ 50%，过程不得断电",
        ],
        steps: [
            "adb reboot bootloader",
            "fastboot flashing unlock   # 老机型：fastboot oem unlock",
            "设备上用音量键选择 Unlock 并按电源键确认",
            "等待自动恢复出厂并重启（约 1-5 分钟）",
        ],
        risks: [
            "全部用户数据被清空，不可恢复",
            "部分机型解锁即永久熔断（Knox / eFuse / warranty bit），不可逆",
            "Widevine L1 降级为 L3，受 DRM 内容不再可播",
            "保修失效；部分售后渠道拒修",
        ],
        warnings: [],
    };
}
function eraseGuide(partition, method, forceFastErase) {
    const node = `/dev/block/by-name/${partition}`;
    const stepsByMethod = {
        blksecdiscard: [
            `adb shell su -c 'ls -l /dev/block/bootdevice/by-name/${partition} || ls -l ${node}'   # 确认分区节点存在且拼写正确`,
            `adb shell su -c 'blkdiscard -s -f ${node}'   # -s 触发 BLKSECDISCARD 安全擦除；返回 EINVAL 表示控制器不支持 → 改用 sanitize`,
            `adb shell su -c 'dd if=${node} bs=4096 count=64 | od -An -tx1 | sort -u'   # 回读校验必须全 00`,
        ],
        sanitize: [
            `adb shell su -c 'sg_sanitize --overwrite /dev/block/sdX'   # 需要 SCSI SG 支持；UFS 机型多数只支持 blksecdiscard 路径`,
            `adb shell su -c 'dd if=${node} bs=4096 count=64 | od -An -tx1 | sort -u'   # 回读校验必须全 00`,
        ],
        secure_erase: [
            `adb shell su -c 'blkdiscard -s -f ${node}'   # 第一段：BLKSECDISCARD`,
            `adb shell su -c 'sg_sanitize /dev/block/sdX'   # 第二段：控制器 SANITIZE（设备支持时）`,
            `adb shell su -c 'dd if=${node} bs=4096 count=64 | od -An -tx1 | sort -u'   # 回读校验必须全 00`,
        ],
    };
    return {
        operation: `erase_${partition}`,
        preconditions: [
            "备份清单已校验存在（persist/modemst 类分区一旦丢失，基带/指纹/DRM 功能不可逆损坏）",
            "电量 ≥ 50%，擦除过程不得断电",
            "分区节点已确认（第 1 步输出存在且与目标一致）",
        ],
        steps: [
            ...(stepsByMethod[method] ?? stepsByMethod.blksecdiscard),
            "若擦除命令超过 5 秒无返回：立即停止，视为 unknown_physical_state，禁止重试，先做只读探测",
        ],
        risks: [
            "数据不可恢复（含密钥与凭据）",
            "擦错分区（如 modemst1/2）导致基带丢失，只能 EDL 救援",
            "擦除中断电可能导致超级分区元数据损坏",
        ],
        warnings: [
            "严禁用 discard/trim/fastboot erase 代替本流程：那只是逻辑擦除，数据仍可恢复",
            ...(forceFastErase
                ? [`${WARN_LOGICAL_ERASE_ONLY}：用户强行要求快速擦除 —— 本工具拒绝生成 discard/trim 引导，仅支持 secure_erase/sanitize/blksecdiscard`]
                : []),
        ],
    };
}
function xblAblGuide(operation) {
    const partition = operation.replace("flash_", "");
    return {
        operation,
        preconditions: [
            `镜像与设备代号、当前固件版本严格匹配（${partition} 错版本直接变砖）`,
            "镜像 sha256 已本地校验",
            "救砖通道可用：EDL 9008 + 官方 firehose 编程器已就绪",
        ],
        steps: [
            "fastboot getvar current-slot   # 确认槽位",
            `fastboot flash ${partition}_<slot> ${partition}.img   # A/B 设备分区名带槽位后缀`,
            "fastboot reboot-bootloader   # 必须先验证能回到 fastboot 再继续刷其他分区",
            "无法进入 fastboot 时：进 EDL，用官方 firehose 编程器恢复",
        ],
        risks: [
            "刷入不匹配版本 → 引导链损坏 → 只能 EDL 救援",
            "PBL 已熔断机型刷写引导链即永久失砖（不可救）",
        ],
        warnings: [],
    };
}
function superGuide() {
    return {
        operation: "super_merge",
        preconditions: [
            "已执行只读 verify-super-layout 获取动态分区元数据",
            "fastboot getvar snapshot-update-status = none（merging 状态下操作会被 deny_with_override 拦截）",
        ],
        steps: [
            "fastboot getvar snapshot-update-status   # 复核",
            "按元数据把 super 拆分为 system/product/vendor 等子镜像",
            "逐个子分区刷写（每次一个，禁止一次刷整个 super）",
            "每次刷写后 fastboot getvar partition-size:<子分区> 核对大小",
        ],
        risks: [
            "动态分区总大小超过 super 一半会刷写失败",
            "合并状态被打断 → 数据分区损坏",
        ],
        warnings: ["禁止自动合并（6.1）：本操作永远由人工分步执行"],
    };
}
function firehoseGuide() {
    return {
        operation: "firehose_write",
        preconditions: [
            "firehose/编程器文件签名已独立校验（Sahara 握手成功 ≠ 信任根验证通过，6.4）",
            "目标分区表已备份",
        ],
        steps: [
            "进入 EDL（9008）模式",
            "加载已验证签名的 programmer（单会话）",
            "单分区单会话写入：每个分区独立会话，禁止批量（Firehose 无事务回滚原语）",
            "写完立即回读校验该分区",
        ],
        risks: [
            "Firehose 无事务回滚：写错不可回退",
            "未验证签名的 programmer 可能触发安全启动熔断",
        ],
        warnings: [],
    };
}
function degradedFlashGuide(operation) {
    return {
        operation,
        preconditions: ["重新完整探测 P0/P1 字段后风险再评估"],
        steps: [
            "重新连接设备并完整重探（probe all）",
            "fastboot getvar current-slot   # 确认槽位",
            "核对镜像 sha256",
            "fastboot flash <分区>_<槽位> <镜像>",
            "fastboot reboot-bootloader 验证可引导",
        ],
        risks: ["P1 字段缺失：电量/存储健康未知，写入中断风险自担"],
        warnings: [],
    };
}
export function renderGuide(g) {
    const lines = [];
    lines.push(`── 手动执行引导：${g.operation} ──`);
    if (g.preconditions.length > 0)
        lines.push("前置条件:", ...g.preconditions.map((s) => `  · ${s}`));
    if (g.steps.length > 0)
        lines.push("步骤:", ...g.steps.map((s, i) => `  ${i + 1}. ${s}`));
    if (g.risks.length > 0)
        lines.push("风险报告:", ...g.risks.map((s) => `  · ${s}`));
    if (g.warnings.length > 0)
        lines.push("警告:", ...g.warnings.map((s) => `  ! ${s}`));
    return lines.join("\n");
}
