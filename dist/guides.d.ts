import { ManualGuide } from "./types.js";
export interface GuideContext {
    partition?: string;
    method?: string;
    forceFastErase?: boolean;
}
export declare function guideFor(operation: string, ctx: GuideContext): ManualGuide;
export declare function renderGuide(g: ManualGuide): string;
