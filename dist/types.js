// —— 第四章：字段分级 ——
export const P0_FIELDS = [
    "protocol", "currentSlot", "snapshotUpdateStatus", "oemUnlockChannel",
    "arbFused", "pblFused", "frpActive", "knoxFused",
];
export const P1_FIELDS = [
    "triesRemaining", "storageHealth", "batteryLevel", "widevineRecoverability", "escapePathReady",
];
// P2：诊断增强字段（失败不计入降级），deviceModel/buildId 供 capability-map 定位
export const P2_FIELDS = ["deviceModel", "buildId"];
