export interface VersionCandidate {
    id: string;
    family: string;
    label: string;
    androidBase: string;
    securityPatch: string;
    tags: string[];
    notes: string;
}
export declare const VERSION_CANDIDATES: VersionCandidate[];
export declare function matchVersionIntent(query: string, limit?: number): Array<VersionCandidate & {
    score: number;
    hits: string[];
}>;
export declare function candidateById(id: string): VersionCandidate | null;
