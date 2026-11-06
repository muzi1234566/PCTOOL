// intent-spec（v3 一）：本地版本特征库——用户说"降级到打游戏不发热的版本"时，
// 不在对话里瞎猜，用特征匹配出 2-3 个候选版本供二次选择。
// 数据可扩展：往 CANDIDATES 里加条目即可，无网络依赖。
export interface VersionCandidate {
  id: string;           // 精确标识（回传 targetVersion 用）
  family: string;       // ROM 家族
  label: string;
  androidBase: string;
  securityPatch: string; // YYYY-MM-DD，ARB 比对用
  tags: string[];
  notes: string;
}

// 意图同义词 → 特征 tag（覆盖"打游戏不发热""养老""省电"这类口语）
const SYNONYMS: Record<string, string[]> = {
  游戏: ["游戏", "流畅"],
  打游戏: ["游戏", "流畅"],
  帧率: ["游戏", "流畅"],
  发热: ["发热"],
  不发热: ["发热"],
  温控: ["发热"],
  省电: ["省电"],
  续航: ["省电"],
  流畅: ["流畅"],
  养老: ["养老", "省电"],
  稳定: ["稳定"],
  干净: ["干净"],
  纯净: ["干净"],
};

export const VERSION_CANDIDATES: VersionCandidate[] = [
  { id: "miui-12.5.8", family: "MIUI", label: "MIUI 12.5.8 稳定版", androidBase: "11", securityPatch: "2021-11-01", tags: ["发热", "游戏", "流畅", "养老", "省电"], notes: "口碑养老版：温控宽松、发热控制好；小米机型注意 ARB" },
  { id: "coloros-11.3", family: "ColorOS", label: "ColorOS 11.3", androidBase: "11", securityPatch: "2021-10-01", tags: ["流畅", "发热", "游戏"], notes: "调度偏激进，游戏帧稳" },
  { id: "oneui-4.1", family: "One UI", label: "One UI 4.1", androidBase: "12", securityPatch: "2022-03-01", tags: ["省电", "稳定"], notes: "三星机型：Knox 熔断风险见 fake_relock 护栏" },
  { id: "lineageos-19", family: "LineageOS", label: "LineageOS 19（A12）", androidBase: "12", securityPatch: "2022-05-05", tags: ["流畅", "干净", "游戏", "发热"], notes: "无预装接近 AOSP，第三方包需自核签名" },
  { id: "hyperos-1.0", family: "HyperOS", label: "HyperOS 1.0", androidBase: "14", securityPatch: "2024-01-01", tags: ["新功能", "流畅"], notes: "新版本，游戏/发热口碑分化" },
];

// 评分：同义词命中 tag +1 / 条；家族名直接命中 +2
export function matchVersionIntent(query: string, limit = 3): Array<VersionCandidate & { score: number; hits: string[] }> {
  const q = query.toLowerCase();
  const wanted = new Set<string>();
  for (const [word, tags] of Object.entries(SYNONYMS)) {
    if (q.includes(word.toLowerCase())) for (const t of tags) wanted.add(t);
  }
  const scored = VERSION_CANDIDATES.map((c) => {
    let score = 0;
    const hits: string[] = [];
    for (const t of c.tags) {
      if (wanted.has(t)) {
        score += 1;
        hits.push(t);
      }
    }
    if (q.includes(c.family.toLowerCase())) {
      score += 2;
      hits.push(c.family);
    }
    return { ...c, score, hits };
  });
  return scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function candidateById(id: string): VersionCandidate | null {
  return VERSION_CANDIDATES.find((c) => c.id.toLowerCase() === id.toLowerCase()) ?? null;
}
