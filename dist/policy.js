// 操作策略表：手工引导类操作集合 + 关键分区清单（与 guardrails 解耦，便于按机型扩展）
export const MANUAL_ONLY_OPS = new Set([
    "unlock_bootloader",
    "super_merge",
    "flash_super",
    "flash_abl",
    "flash_xbl",
    "flash_firehose_programmer",
    "firehose_write",
    "erase_partition",
    "format_partition",
]);
export const MANUAL_ONLY_PREFIXES = ["erase_", "format_"];
// 擦除/覆盖即功能丢失的分区（2.1 deny_with_override 触发面；按机型可扩展）
export const CRITICAL_PARTITIONS = [
    "persist", "persistbak",
    "modemst1", "modemst2", "fsc", "fsg",
    "frp",
    "xbl", "xbl_config",
    "abl",
    "keymaster", "devinfo",
];
