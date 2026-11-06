// 写入屏障：flash_partition / erase_partition / exclusive 脚本互斥（规范【并发性】）
export class Barrier {
    status = "idle";
    tail = Promise.resolve();
    runExclusive(fn) {
        const exec = this.tail.then(async () => {
            this.status = "exclusive";
            try {
                return await fn();
            }
            finally {
                this.status = "idle";
            }
        });
        // 吞错防断链；错误本身由 exec 承接给调用方
        this.tail = exec.then(() => undefined, () => undefined);
        return exec;
    }
}
