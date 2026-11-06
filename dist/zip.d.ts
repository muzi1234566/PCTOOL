export interface ZipEntry {
    name: string;
    data: Buffer;
}
export declare function readZipEntries(buf: Buffer): ZipEntry[];
export declare function extractZipEntries(buf: Buffer, select: (name: string) => boolean, destDir: string, rename?: (name: string) => string): string[];
