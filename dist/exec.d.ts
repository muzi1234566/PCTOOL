export interface RunResult {
    code: number | null;
    stdout: string;
    stderr: string;
    stdoutBuf: Buffer;
    timedOut: boolean;
}
export interface RunOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}
export declare function run(cmd: string, args: string[], timeoutMs: number, opts?: RunOptions): Promise<RunResult>;
export declare function parseGetvar(text: string): Map<string, string>;
