import type { OrchestratorConfig } from "./config.js";
export interface UiNode {
    text: string;
    resourceId: string;
    bounds: [number, number, number, number];
    clickable: boolean;
}
export declare function parseUiDump(xml: string): UiNode[];
export declare function center(n: UiNode): [number, number];
export interface NodeMatcher {
    textExact?: string;
    textContains?: string;
    resourceId?: string;
}
export declare function findNode(nodes: UiNode[], matcher: NodeMatcher): UiNode | null;
export declare function dumpSignature(nodes: UiNode[]): string;
export declare function dumpChanged(a: UiNode[], b: UiNode[]): boolean;
export interface UiConfirmResult {
    tapped: boolean;
    changed: boolean;
    node: UiNode | null;
    fallbackGuide: string | null;
    unlockTried?: boolean;
}
export declare function uiConfirm(cfg: OrchestratorConfig, matcher: NodeMatcher, opts?: {
    timeoutMs?: number;
}): Promise<UiConfirmResult>;
