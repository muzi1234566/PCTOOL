export type SparseChunkType = "raw" | "fill" | "dont_care" | "crc32";
export interface SparseChunk {
    type: SparseChunkType;
    startBlock: number;
    blocks: number;
    dataOffset?: number;
    fillVal?: number;
}
export interface SparseInfo {
    blockSize: number;
    totalBlocks: number;
    chunks: SparseChunk[];
}
export declare function detectSparse(head: Buffer): boolean;
export declare function parseSparseInfo(buf: Buffer): SparseInfo;
export declare function dontCareOverlaps(info: SparseInfo, ranges: Array<{
    startBlock: number;
    blocks: number;
}>): Array<{
    startBlock: number;
    blocks: number;
}>;
export declare function sparseToRaw(src: string, dest: string): {
    blockSize: number;
    totalBlocks: number;
};
