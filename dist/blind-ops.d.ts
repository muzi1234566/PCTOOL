export interface BlindSequence {
    brand: string;
    forceReboot: string;
    fastboot: string;
    recovery: string;
    edl?: string;
}
export declare function blindSequence(model: string | null): BlindSequence;
export declare function blindSequenceTable(model: string | null): string[];
