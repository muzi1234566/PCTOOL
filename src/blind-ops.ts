// blind-ops（v4 五）：硬件盲操时序库——设备彻底失联（无 adb/fastboot）时给人工按键指引
export interface BlindSequence {
  brand: string;
  forceReboot: string;
  fastboot: string;
  recovery: string;
  edl?: string;
}

const LIB: Array<{ match: RegExp; seq: BlindSequence }> = [
  {
    match: /xiaomi|redmi|poco|^mi\s?\d/i,
    seq: { brand: "小米 / Redmi / POCO", forceReboot: "长按 音量下 + 电源 ≥12 秒", fastboot: "关机后按住 音量下 并连接 USB（部分机型 音量下 + 电源）", recovery: "关机后 音量上 + 电源", edl: "进 9008：关机，按住 音量上+音量下 再插线；无效则拆机测试点短接" },
  },
  {
    match: /samsung|^sm-/i,
    seq: { brand: "三星", forceReboot: "音量下 + 电源 长按 ≥10 秒", fastboot: "音量下 + 电源 + 连接电脑（Download/Odin 模式）", recovery: "音量上 + 电源 + 连线" },
  },
  {
    match: /pixel|android one|nexus/i,
    seq: { brand: "Pixel / Nexus", forceReboot: "电源 + 音量上 长按 ≥10 秒", fastboot: "关机后 音量下 + 电源", recovery: "fastboot 界面用音量键选 Recovery mode，电源键确认" },
  },
  {
    match: /oneplus|realme|oppo/i,
    seq: { brand: "一加 / realme / OPPO", forceReboot: "长按 电源 ≥10 秒（或 音量下 + 电源）", fastboot: "关机后 音量下 + 电源", recovery: "关机后 音量下 + 音量上 + 电源（进后再选 Recovery）", edl: "高通机型可测 9008（音量组合 + 线）" },
  },
  {
    match: /huawei|harmony|honor/i,
    seq: { brand: "华为 / 荣耀", forceReboot: "长按 电源 ≥10 秒", fastboot: "关机后 音量下 + 电源（多数新机型 BL 无法解锁，仅维修通道）", recovery: "eRecovery：关机后 音量上 + 电源 + 连线" },
  },
];

const GENERIC: BlindSequence = {
  brand: "通用 Android",
  forceReboot: "长按 电源 ≥10 秒（无效则 音量下 + 电源）",
  fastboot: "关机后 音量下 + 电源",
  recovery: "关机后 音量上 + 电源",
  edl: "高通机型：特定音量组合 + USB 进 9008（机型差异大，先查该机型文档）",
};

export function blindSequence(model: string | null): BlindSequence {
  const m = (model ?? "").toLowerCase();
  for (const e of LIB) {
    if (e.match.test(m)) return e.seq;
  }
  return GENERIC;
}

export function blindSequenceTable(model: string | null): string[] {
  const seq = blindSequence(model);
  const rows = [
    `| 强制重启 | ${seq.forceReboot} |`,
    `| 进 fastboot / Download | ${seq.fastboot} |`,
    `| 进 recovery | ${seq.recovery} |`,
  ];
  if (seq.edl) rows.push(`| 进 EDL (9008) | ${seq.edl} |`);
  return rows;
}
