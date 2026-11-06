export interface ChainDescriptor {
    tag: "chained_partition";
    partition: string;
    rollbackIndexLocation: number;
}
export interface HashDescriptor {
    tag: "hash";
    partition: string;
    imageSize: number;
    salt: string;
    digest: string;
}
export interface HashtreeDescriptor {
    tag: "hashtree";
    partition: string;
    imageSize: number;
}
export type AvbDescriptor = ChainDescriptor | HashDescriptor | HashtreeDescriptor;
export interface VbmetaImage {
    releaseString: string;
    rollbackIndex: bigint;
    flags: number;
    descriptors: AvbDescriptor[];
    unparsedCount: number;
}
export declare function parseVbmeta(buf: Buffer): VbmetaImage;
export interface HashCheck {
    partition: string;
    status: "verified" | "missing_image" | "size_mismatch" | "digest_mismatch" | "hashtree_skipped";
}
export interface AvbChainReport {
    chains: Array<{
        partition: string;
        rollbackIndexLocation: number;
        resolved: boolean;
        subReport?: AvbChainReport;
    }>;
    hashChecks: HashCheck[];
    complete: boolean;
    broken: string[];
}
export declare function verifyAvbChain(buf: Buffer, getImage: (name: string) => Buffer | null, depth?: number): AvbChainReport;
