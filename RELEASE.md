# v5.0.0-RC1 — 对外发布文案（GitHub Release）

> 标签：`v5.0.0-rc1` ｜ 标题：**Android Playground Orchestrator — 把 AI 关进物理笼子的玩机编排器**

## 一句话

一个把 LLM 关进结构化笼子的 Android 刷机/Root/救砖编排器：模型只能下达**结构化意图**，所有命令由确定性代码拼装——危险操作在物理上不可达，而不是在提示词上不可达。

## 核心卖点

### 🧱 物理级防呆（danger is unreachable, not discouraged）
- **三级护栏**（deny_auto / deny_with_override / deny_hard）：熔断机型（Knox/PBL）、FRP 激活、tries=1 写 boot、闪存寿命极低——全部硬拒绝，Override 令牌也放不进 deny_hard。
- **opbus 结构化命令总线**：`erase/format/unlock/firehose` 在执行层白名单外**根本不存在**；shell 元字符注入、越权路径全部拦截并落审计链。
- **ARB 熔断拦截**：降级前自动比对安全补丁级别，目标更旧 → deny_hard「eFuse 熔断变砖」。
- **基带保护**：跨区刷机强制备份 modemst1/2、fsg、persist，未备份 deny_auto。
- **三星伪回锁**：无条件 deny_hard（KNOX 不可逆）。

### 🤖 AI 幻觉屏蔽（execution layer trusts nothing from the model)
- LLM 不接触任何命令字符串：坐标只能来自 uiautomator 解析、路径受白名单约束、中文/空格路径（`C:\Users\张三\Desktop\boot.img`）全链路兼容。
- execute_script 沙箱：process/require/Function/eval 全部遮蔽为 undefined，api 面走 Proxy 白名单，写入类副作用强制退回主入口。
- 每次拦截、每次快照、每条操作——链式哈希审计（append-only JSONL，篡改可检出，PII 剔除）。

### ⚡ 无感提效（speed you don't configure）
- 探测批量采集：adb 一条 shell / fastboot 一条 `getvar all`，不再逐行 spawn。
- 下载竞速：direct + ghproxy 镜像并发测延迟，最快节点优先，SHA256 逐源校验，坏源自动切换。
- 手机端自主下载：≥50MB 大文件走设备 Wi-Fi（`onDeviceDownload: true`），PC 不搬运流量。
- 流水线预取：刷写/重启的等待期，后台预取后续模块（双层异常兜底，绝不阻塞主流程）。
- capability-map 动态估算：按 `机型::buildId` 记录真实耗时，P50/P90 越用越准。

### 🧰 全场景覆盖（11 个 utility 场景 + Root/隐藏栈）
- Root 全流程：boot 提取 → Magisk 官方脚本修补（多后端）→ 带槽位刷写 → AVB 链式校验 → 隐藏栈（Zygisk Next / PIF / DenyList / LSPosed）
- OTA 保 Root（A/B 闭环）、降级（intent-spec 模糊匹配 + ARB 拦截）、伪回锁、跨区刷机、无 Recovery 救砖、gaming_tune、privacy_modules、data_rescue（微信）、advanced_hide（NoMount/Hybrid Mount + VFS 冲突检查）、rootless（Shizuku/DSU）、unbrick_qcn（9008 + 强制本机 QCN）
- 临时 Root（内核能力登记表适用性探测，重启失效明示）与永久 Root 双轨
- 断点恢复：崩溃中途的写入步骤落 pendingStep，恢复先只读校验快照，不一致即拒绝续跑
- 失联兜底：USB 探针诊断 + 机型盲操按键时序表

## 安装

```bash
git clone <repo> && cd android-playground-orchestrator
npm install && npm run build && npm test   # 126 用例全绿
npm run smoke                              # 真机冒烟（零设备写入）
# DSH 插件
dsh plugin add "$(pwd)"   # 或拷贝到 ~/.dsh/plugins/ 后 dsh restart
```

对话框第一句：`调用 android_probe 看设备状态`。

## RC 阶段已知边界

- EDL（9008）会话目前以引导+QPST/QFIL 指引为主，编程器自动化在路线图
- exploit-registry 为登记表机制：条目必须来自经复核的公告，占位 ID 永不匹配
- 沙箱为第一方脚本约定加固，不是对抗性隔离——不要喂不可信脚本
- ZygiskNext/LSPosed 等社区仓库归属迁移时改 `resources.ts` 别名一处即可

## 质量凭证

| 检查项 | 结果 |
|---|---|
| 类型检查 | 0 错误 |
| 单元测试 | 126 pass / 0 fail |
| 真机冒烟（零写入） | 9 pass / 0 fail |
| 审计链完整性 | 篡改即拒载 |
| MIT | 允许改、允许商用，保留署名 |
