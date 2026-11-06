export declare class Barrier {
    status: "idle" | "exclusive";
    private tail;
    runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}
