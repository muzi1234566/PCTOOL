# android-playground-orchestrator

Android 刷机 / Root / 救砖安全编排层。不是 adb 命令拼接器：所有写入动作先过三级护栏（deny_auto / deny_with_override / deny_hard），执行带快照与链式审计，会话可断点恢复。

## 目录结构

```
android-playground-orchestrator/
├── package.json            # Node ≥18，零运行时依赖
├── tsconfig.json
├── src/
│   ├── index.ts            # Orchestrator 门面（probe/plan/flash/erase/executeScript/override/recover）
│   ├── types.ts            # 全部接口：DeviceState/Snapshot/OverrideToken/Plan/StepResult 等
│   ├── errors.ts           # 8 个错误码 + 可重试性表 + LOGICAL_ERASE_ONLY 警告码
│   ├── config.ts           # 配置解析（adb/fastboot 路径、stateDir、HMAC 密钥持久化）
│   ├── exec.ts             # 进程执行层：超时杀进程树（win32 走 taskkill /t）、getvar 解析
│   ├── lock.ts             # 写入屏障（互斥队列，写入操作独占）
│   ├── hash.ts             # 流式 SHA256
│   ├── probe.ts            # probe_device：P0/P1/P2 分级读取，N/A 与失败区分
│   ├── snapshot.ts         # pre/post 快照 + 设备指纹哈希（不含 PII）
│   ├── audit.ts            # 链式哈希审计日志（append-only JSONL，PII 剔除，篡改可检测）
│   ├── override-token.ts   # HMAC-SHA256 一次性令牌（5 分钟过期、操作绑定、防重放）
│   ├── policy.ts           # 手工引导类操作清单 + 关键分区清单
│   ├── guides.ts           # 手动引导模板（unlock/erase/abl-xbl/super/firehose/降级刷写）
│   ├── guardrails.ts       # 三级护栏引擎 + 10.1 拦截话术
│   ├── flash.ts            # 刷写预检（SHA256/槽位/tries=1/稀疏）+ 执行
│   ├── erase.ts            # 备份清单校验 + 合法擦除方式判定（禁 discard/trim）
│   ├── resources.ts        # 资源解析（GitHub Releases/mirror/本地缓存）强制 SHA256
│   ├── avb.ts              # vbmeta 解析 + AVB 链式校验（hash/hashtree/chained 描述符）
│   ├── sparse.ts           # 稀疏镜像解析、DONT_CARE 重叠检测、sparse→raw 转换
│   ├── capability-map.ts   # P1：按 型号::buildId 记录真实耗时/成功率，历史估算 P50/P90
│   ├── physical.ts         # P2：电量/存储健康硬阻断、温度采集、大分区清单
│   ├── zip.ts              # P2：最小 ZIP 读取器（APK 资产提取，store+deflate）
│   ├── root-prep.ts        # P2：prepareRootResources（缓存→下载→官方 boot_patch.sh 修补→产物入缓存）
│   ├── dsh-plugin.ts       # DSH 插件入口（android_probe / android_plan_root / android_plan_utility / android_execute_step）
│   ├── scenarios.ts        # v3：场景路由（OTA保Root/伪回锁/跨区/救砖/调优/隐藏栈/免Root/QCN/降级）
│   ├── intent-spec.ts      # v3：版本特征库（模糊匹配候选）
│   ├── exploit-registry.ts # v3：内核能力/漏洞适用性登记表（只做区间匹配）
│   ├── opbus.ts            # v4：结构化命令总线（LLM 不接触命令串，argv 纯 TS 拼装，erase/unlock 根本不存在）
│   ├── ui-auto.ts          # v4：uiautomator dump 解析 → 定位 → opbus tap → 前后状态比对
│   ├── blind-ops.ts        # v4：硬件盲操时序库（小米/三星/Pixel/一加/华为 失联按键指引）
│   ├── usb-diag.ts         # v4：USB 探针（连续超时 → 驱动/线材/USB3 兼容性诊断）
│   ├── executor.ts         # execute_script 沙箱（P2：全局遮蔽 + api 白名单 Proxy + 超时硬上限）
│   ├── planner.ts          # 意图门控 + 双轨估算 + 隐藏栈分阶段计划 + estimateWallClock
│   ├── context.ts          # 会话持久化（原子写）+ 断点恢复（pendingStep 崩溃检测）
│   ├── scripts/
│   │   └── smoke-test.mjs  # 真机冒烟（探测→计划→写入尝试→护栏拦截→恢复校验，全程零设备写入）
│   └── test/               # 80 个单元测试（纯逻辑，无设备依赖）
└── dist/                   # 编译产物
```

## 依赖与安装

运行时零依赖，仅 Node ≥ 18 内置模块。设备侧需要 `adb` / `fastboot` 在 PATH（或构造时传 `adbPath`/`fastbootPath`）。

```bash
npm install       # 仅安装 devDependencies：typescript + @types/node
npm run build     # tsc → dist/
npm test          # node --test dist/test/*.test.js（122 个用例）
npm run smoke     # 真机冒烟：设备可连可不连，全程零设备写入
```

## 验证方法

**1. 纯逻辑（无设备）**：`npm test`，预期 122 pass / 0 fail。v4 新增：opbus 结构化下发与注入拦截、uiautomator XML 解析 Mock、多镜像竞速下载 Mock（最快节点选择/损坏源自动切换）、盲操时序库、闪存 deny_hard 升级、手机端下载阈值。覆盖：令牌签发/篡改/过期/操作绑定、审计链追加与篡改检测、PII 剔除、vbmeta 描述符解析与链校验（含篡改检出）、稀疏布局解析与 DONT_CARE 重叠、三级护栏全部分支（含 tries N/A 收紧）、意图门控、capability-map 分位数与滚动窗口、pendingStep 恢复语义、沙箱遮蔽/白名单/超时、存储健康分级与硬阻断、ZIP 解析、隐藏栈计划顺序断言、DSH 插件会话状态机与审批闸门。

**1.5 真机冒烟**：`npm run smoke`。流程：probeBundle → 意图门控 → plan（估算来源 default→history 切换）→ flash 尝试（故意 SHA256 不匹配，在只读预检层被拒）→ erase persist 无备份拦截（10.1 话术 + 手动引导）→ unlock 仅产出引导 → 注入伪造 pendingStep 后 recover() 必须先探测、快照不一致即抛 unknown_physical_state。无设备时自动走无设备路径并明确标注。

**2. 设备探测（接真机）**：

```bash
node --input-type=module -e "
import { Orchestrator } from './dist/index.js';
const o = new Orchestrator();
console.log(JSON.stringify(await o.probeBundle(), null, 2));
"
```

预期：设备在 adb/fastboot 时返回协议、槽位、snapshot 状态等真实字段；无设备时 `protocol: "none"`。

**3. 护栏验证（无设备也能跑通决策链）**：

```bash
node --input-type=module -e "
import { Orchestrator } from './dist/index.js';
const o = new Orchestrator();
console.log(JSON.stringify(await o.erase({ partition: 'persist', method: 'blksecdiscard', requireBackup: false }), null, 2));
"
```

预期：`status: "blocked"`、`error_code: "deny_with_override"`、message 为 10.1 格式拦截话术 + 手动引导（无备份擦除 persist 被拦截）。

## 规范映射

| 规范条目 | 实现位置 |
|:---|:---|
| 2.1 三级护栏 | `guardrails.ts:evaluate()` |
| 2.2 Override Token | `override-token.ts` + `index.ts:generateOverride/submitOverride` |
| 2.3 erase/format/unlock/abl/xbl/firehose/super 永不自动执行 | `policy.ts:MANUAL_ONLY_*` + guardrails 规则顺序（令牌只放行引导） |
| 3.1 意图展开硬门控 | `planner.ts:expandIntent()` → needs_clarification |
| 3.2 双轨估算 | `planner.ts:ESTIMATES`（探索 7/15min/85%，加速 2.75/5min/95%） |
| 3.3 预计算 | PlanStep.calibratedRiskScore / failureBranches / estimatedDurationMs |
| 4 字段分级 P0/P1/P2 | `probe.ts`：P0 失败→infeasible；P1 失败→degraded、风险 +0.2、写操作降级 |
| 5.1 PTC 并发 | `index.ts:probeBundle()` |
| 5.2 增量探测 | captureSnapshot(partitions) 按操作指定增量分区 |
| 5.3 确定性资源获取 | `resources.ts`：别名表 + 强制 SHA256 + 不匹配即丢弃 + 本地缓存复验 |
| 5.4 预热标记 | PlanStep.preheat（firehose/大分区擦除） |
| 6.1 super 禁止自动 | `flash.ts:flashPrecheck()` partition=super 直接拒绝，两步引导在 `guides.ts` |
| 6.2 tries=1 写 boot → infeasible | `flash.ts` 预检 + `guardrails.ts` 双层 |
| 6.3 AVB 链式验证 | `avb.ts:verifyAvbChain()` + `index.ts:flashVbmeta()`（链未闭合→deny_auto） |
| 6.4 EDL 协议隔离 | firehose 引导（签名独立校验、单分区单会话）；EDL 会话为扩展点 |
| 6.5 稀疏 DONT_CARE 重叠 | `sparse.ts:dontCareOverlaps()` + flash 预检拒绝 |
| 6.6 禁 discard/trim | `erase.ts` 白名单 + LOGICAL_ERASE_ONLY 警告 |
| 7.1 快照 | `snapshot.ts`（pre/post + deviceHash） |
| 7.2 超时→unknown_physical_state | `flash.ts:flashImage()` / `executor.ts:withTimeout()` |
| 7.3 链式审计 | `audit.ts`（GENESIS 起链，篡改抛错） |
| 8.2 断点恢复 | `context.ts:recoverSession()` + `index.ts:recover()`（恢复已用令牌） |
| 9 错误码 | `errors.ts`（含可重试性） |
| 10.1/10.2/10.3 输出格式 | `guardrails.ts:formatIntercept()` / `index.ts:stepResult()` / `planner.ts:expandIntent()` |

## P1 迭代变更

| 项 | 实现 |
|:---|:---|
| 动态耗时估算 | `capability-map.ts`：flash/root 完成后按 `型号::buildId` 记录真实耗时+成功率（滚动 50 条窗口）；`plan()` 先查历史（线性插值 P50/P90），样本 <5 条放宽 mode，再不足走默认兜底；`Plan.estimateSource` 标注来源 |
| 断点恢复收紧 | flash 写入前落盘 `context.pendingStep`（pre-snapshot 哈希）；`recoverSession` 检测到挂起步骤 → 不给续跑点；`recover()` 第一步强制 `probeBundle()` 只读探测 + 快照比对，不一致 → 步骤置 unknown_physical_state 并抛错要求手动验证，一致 → 清标记允许续跑；超时失败的 flash 保留挂起标记 |
| P1 收紧 | `tries_remaining` N/A（协议下不可读或未采集）+ flash_boot → 直接 deny_auto（+0.2 风险分），不再只靠降级规则 |
| 批量探测 | `probe.ts` 重写：adb 单条 shell 批量拉 9 个属性+电池+存储健康（marker 行解析）；fastboot 单条 `getvar all`；probeBundle 的 health 从同一次探测派生，不再二次 spawn。写入操作仍走 lock.ts 独占屏障 |
| 真机冒烟 | `scripts/smoke-test.mjs` + `npm run smoke`：6 段流程断言，零设备写入（flash 用错误 SHA256 在预检层被拒；erase/unlock 本就永不自动执行） |

## P2 迭代变更

| 项 | 实现 |
|:---|:---|
| 资源拉取与预缓存 | 默认缓存目录 `~/.dsh-orchestrator/cache/`。`prepareRootResources()`：管理器 APK（本地提供或 GitHub Releases 拉取，SHA256 强制）→ 修补缓存命中检查（`cache/patched/<机型::buildId>/`，哈希复验）→ 无缓存走修补 → 产物与元数据落缓存。`plan("root")` 自动调用并把修补镜像写进 flash 步骤参数 |
| 修补后端 | 用 Magisk APK 自带的官方 `assets/boot_patch.sh` 修补（不自拼 cpio 命令）。三后端：`adb-ondevice`（Windows 默认：资产推到设备 /data/local/tmp，手机自己修补，无需 root）、`magiskboot-local`（Linux/macOS/WSL）、`manual`（Magisk App 修补指引）。KernelSU/APatch 走 manual 引导 |
| 物理硬阻断 | `assertPhysicalHardStops()`：电量 <20%（可读时）或存储健康 warning+（eMMC life_time ≥0x04）→ `infeasible`，拒绝进入 fastboot/EDL/写入流程；`plan()`/`flash()`/`erase()` 三处设卡。大分区（system/super/vendor/product/odm）preSnapshot 必含 `temperatureC`；超时错误自动附「可能因高温导致 eMMC 擦除延迟（pre 温度 X℃）」 |
| 隐藏栈计划 | `hide_target=true` → 分阶段：刷修补 boot → 重启 → verify_root → module_baseline（Zygisk Next）→ install_module → module_baseline（PIF）→ install_module → configure_denylist → reboot → verify_integrity。install 前缺 baseline 差分 → deny_auto 拒装。`Plan.estimateWallClock` 明示重启次数（如「预计耗时 6.5 分钟，包含 2 次重启」） |
| 模块执行器 | `executeStep` 新增真实实现：reboot（轮询 sys.boot_completed，180s 超时）、verify_root（su -c id -u）、module_baseline（模块列表+指纹哈希落审计）、install_module（resolveResource → push → magisk --install-module，独占屏障）、configure_denylist（--denylist enable + add）、verify_integrity（PIF 模块检查 + 检测指引） |
| 沙箱收紧 | `new Function` 形参遮蔽 process/require/module/exports/globalThis/global/self/Function/eval（脚本体内全部 undefined）；api 面 Proxy 白名单——未知属性访问即抛「副作用必须退回 Orchestrator 主入口」，api 禁止写入；超时缺省 5s、硬上限 30s |

## 真机测试指引（第一次带护栏的完整闭环）

**准备**

1. 用一台**非日用**测试机（后续步骤会清数据/刷 boot）。Windows/Linux 均可，装好 platform-tools（adb/fastboot 在 PATH）。
2. 设备开启「开发者选项 → USB 调试」，首次连接在手机上接受指纹授权；`adb devices` 应显示 device。
3. 电量 ≥ 50%，`fastboot --version` 可执行。

**第一步：提取原始 boot.img**（三选一）

```bash
# A. 官方 OTA 包（最通用）：下载与设备版本完全一致的 OTA zip，用 payload-dumper-go 解出
#    https://github.com/lucasmz1/payload-dumper-go（或 cstkas/payload-dumper-go 分支）
payload-dumper-go -o firmware-out ota-package.zip
#    → firmware-out/boot.img（A/B 设备取 boot.img 即可）

# B. Pixel 类设备支持 fastboot 直接拉：
fastboot fetch boot boot.img

# C. 已 root 的设备：
adb exec-out su -c cat /dev/block/bootdevice/by-name/boot > boot.img
```

**第二步：跑冒烟确认环境**（可选但建议）

```bash
npm run smoke   # 9 项断言，零设备写入
```

**第三步：准备资源并生成计划**

```bash
node --input-type=module -e "
import { Orchestrator } from './dist/index.js';
const o = new Orchestrator();
// 资源准备：boot.img 必填；managerApkPath 可选（提供则跳过 GitHub 下载）；backend=auto 时
// Windows 自动选 adb-ondevice（手机自己修补），Linux/macOS 选 magiskboot-local
const prep = await o.prepareRootResources({
  rootMethod: 'magisk',
  bootImagePath: './boot.img',
  // managerApkPath: './Magisk-v27.apk',
  // backend: 'manual',           // 任意安卓设备用 Magisk App 修补时选这个
});
console.log(JSON.stringify(prep, null, 2));
// 修补产物在 ~/.dsh-orchestrator/cache/patched/<机型::buildId>/magisk-boot-patched.img
"
```

预期输出：`patchedBoot.path` + `patchedBoot.sha256`；再次运行同设备同版本时 `backend: "cache"` 直接命中。

**第四步：生成带隐藏栈的完整计划**

```bash
node --input-type=module -e "
import { Orchestrator } from './dist/index.js';
const o = new Orchestrator();
const plan = await o.plan('root', {
  root_method: 'magisk', hide_target: true, bootloader_status: 'unlocked',
  backup_preference: 'critical_only', target_slot: 'current', vbmeta_state: 'keep_avb',
  bootImagePath: './boot.img',
});
console.log(plan.estimateWallClock);   // 如：预计耗时 10.5 分钟，包含 2 次重启
console.log(plan.steps.map(s => s.id + ':' + s.operation).join(' → '));
"
```

**第五步：逐步执行（每步过护栏）**

```bash
node --input-type=module -e "
import { Orchestrator } from './dist/index.js';
const o = new Orchestrator();
const planId = process.argv[2];
// 逐步推进；flash_boot 会走预检（SHA256/槽位/tries=1）+ 独占屏障 + pre/post 快照
for (const stepId of ['s1_probe','s2_resources','s6_flash_boot','s8_reboot_verify']) {
  const r = await o.executeStep(planId, stepId);
  console.log(r.step, r.status, r.error_code ?? '');
  if (r.status !== 'success') { console.log(JSON.stringify(r, null, 2)); break; }
}
" <planId>
```

BL 未解锁时 flash_boot 会先被 `unlock` 步骤拦截（deny_auto 引导，人工按引导执行 `fastboot flashing unlock` 后重试）。模块安装（s11-s17）要求 root 已生效。

**第六步：验证硬阻断生效**

```bash
adb shell cmd battery unplug && adb shell cmd battery set level 15
# 重跑第四步 plan()：应返回 infeasible「电量 15% 低于 20% 硬阈值」
adb shell cmd battery reset
```

## DSH 插件（P3）

**组合包声明（v5 RC1 修复）**：DSH 安装器要求包必须声明组合包，否则报「这个包没有声明组合包，不能作为插件管理」。本包由 `package.json` 的 `dsh.bundle` 字段声明（entry/export/tools/permissions/configSchema），加载配置由仓库根的 `cordis.patch.yml` 提供（enabled / entry / tools / permissions / config 注入 `registerDshPlugin(ctx, opts)`）。若你的 DSH 版本读取的字段名不同（如 `cordis.bundle`），只需同步改这两处的键名。

`src/dsh-plugin.ts` 把编排器包装成 DSH 原生工具。内部 Orchestrator 类对对话框完全隐藏。

**工具面**

| 工具 | 入参 | 行为 |
|:---|:---|:---|
| `android_probe` | 无 | 只读批量探测，Markdown 设备画像（协议/型号/serial/buildId/槽位/snapshot/tries/电量/存储健康/内核/基带/修补缓存/临时 Root 内核适用性） |
| `android_plan_root` | `targetPath`、`hideMode`（basic/strong）、`persistence`（permanent/temporary）、`bootloaderStatus`、`managerApkPath`、`patchBackend` | prepareRootResources + plan → Markdown 计划表（P50/P90 及来源、estimateWallClock 含重启次数、依赖顺序、物理按键、逐步风险分与失败分支）；temporary=内核漏洞/LKM 临时 Root（重启失效，无模块栈，明确告知） |
| `android_plan_utility` | `scenario` + 场景参数 | v3 场景矩阵：ota_keep_root（A/B OTA 保 Root 闭环）、fake_relock（伪回锁，三星 deny_hard）、cross_region_flash（跨区+modemst/fsg/persist 强制备份）、no_recovery_rescue（fastboot boot / disable 文件）、gaming_tune（sysfs 调优+baseline）、privacy_modules（LSPosed/去广告/resetprop）、data_rescue（微信 tar / Shizuku+LSPatch）、advanced_hide（NoMount/Hybrid Mount+VFS 冲突只读检查）、rootless（Shizuku/DSU）、unbrick_qcn（9008 救砖，强制本机 QCN）、downgrade_rom（intent-spec 模糊匹配候选 + ARB 补丁级别 deny_hard） |
| `android_execute_step` | `stepId`；首次须 `confirmPlan: true`；`overrideToken` / `acknowledgeDeny` / `abortPlan` | 确认闸门后单步执行。deny_auto/deny_with_override → 返回 `require_user_approval: true` + Markdown 警告框 + 手动引导 + （override 场景）一次性令牌；deny_auto 人工执行完传 `acknowledgeDeny: true` 继续 |

**审批与持久化**

- 计划/审批态（planId、planApproved、completedSteps、awaitingApproval、待回传令牌）经 `ctx.storage` 持久化（key：`android-playground-orchestrator/session`）。
- 写入中途崩溃的 `pendingStep` 由 Orchestrator 落本地 `~/.dsh-orchestrator/state/context.json`，插件首次执行时若发现计划丢失会自动走 `recover()`（探测校验 → 不一致即抛 unknown_physical_state）。
- 所有拦截输出为标准 Markdown：`>` 警告框、编号手动步骤、风险列表、JSON 代码块令牌，DSH 对话框直接渲染。

**打包与加载**

`package.json` 已含 DSH 字段：

```json
"dsh": {
  "id": "android-playground-orchestrator",
  "kind": "tool",
  "entry": "./dist/dsh-plugin.js",
  "export": "registerDshPlugin",
    "tools": ["android_probe", "android_plan_root", "android_plan_utility", "android_execute_step"],
  "permissions": ["storage", "process:adb", "process:fastboot", "network:github"]
}
```

安装：

```bash
npm install && npm run build

# 方式 A：DSH CLI
dsh plugin add "$(pwd)"

# 方式 B：手动拷贝到 DSH 插件目录后重载
mkdir -p ~/.dsh/plugins
cp -r "$(pwd)" ~/.dsh/plugins/android-playground-orchestrator
dsh restart

# 验证
dsh plugin list | grep android-playground-orchestrator
```

对话框里第一句：`调用 android_probe 看设备状态`。

**适配说明（诚实边界）**：`ctx.tools.register` / `ctx.storage` 命名按本项目给定的 DSH 规范实现；若 DSH 实际 API 是 `defineTool` 风格或 storage 方法名不同，只需改 `dsh-plugin.ts` 顶部 `DshPluginContext` 适配层（约 20 行，已导出 `defineTool` 别名），编排核心（其余 20+ 模块）零改动。插件逻辑（注册/会话状态机/审批闸门/渲染）有 8 个离线单测覆盖。

## 真机实战联调指南（RC 验收清单）

> 按顺序跑通以下四步即完成 RC 验收。全程只有第三步会产生真实写入（boot 分区），其余步骤零写入。

### 第一步：设备画像与降级路径（零写入）

1. 插上手机（USB 调试已授权），在 DSH 对话框输入：`调用 android_probe 看设备状态`
2. **验收点 A（在线路径）**：返回的 Markdown 表应包含 型号/serial/buildId/槽位/snapshot/tries/电量/存储健康/内核/基带/修补缓存 行
3. **验收点 B（失联降级）**：拔掉数据线再跑一次 `android_probe`——应看到 `协议 | none`、**硬件盲操时序表**（按键指引）、`未检测到设备` 提示；不应出现任何异常堆栈

### 第二步：物理硬阻断验证（零写入）

```bash
adb shell cmd battery unplug && adb shell cmd battery set level 15
```

1. 重新调用 `android_plan_root`（带 bootImagePath）或任意 utility 场景
2. **验收点 C**：返回 `infeasible`（电量 <20% 硬阈值），模型被 `require_user_approval` 阻断，无法推进任何写入步骤
3. 恢复：`adb shell cmd battery reset`

### 第三步：opbus 审计链验证（唯一真实写入）

1. 准备好 boot.img 与已解锁 BL 的测试机，生成并确认 Root 计划（`android_plan_root` → 用户确认 → `android_execute_step { confirmPlan: true }`）
2. 执行到 `flash_boot` 步骤，观察：
   - **验收点 D（审计链）**：`~/.dsh-orchestrator/state/audit.jsonl` 中出现 `flash_boot`（pre/post 快照哈希）事件；写入前 `context.json` 的 `pendingStep` 落盘、成功后清除
   - **验收点 E（拦截审计）**：故意触发一次 opbus 拦截（如构造越权操作），`audit.jsonl` 应出现 `opbus:block:<action>` 事件——篡改 audit.jsonl 后再 `recover()` 应被链校验拒绝
3. **验收点 F（刷后保养）**：final_probe 步骤的 details 中应包含 `fstrim` 结果

### 第四步：USB 探针与盲操（拔线场景）

1. 在 `flash_boot` 执行中途主动拔掉数据线 → fastboot 超时
2. **验收点 G（USB 探针）**：连续第 2 次超时起，错误详情包含 `usbHints`（USB3 xHCI / 线材 / 供电 / 驱动四大病因；Windows 另附 pnputil 枚举结果）
3. **验收点 H（盲操）**：此时调用 `android_probe` → 返回盲操按键时序表；若目标为三星/小米机型，时序应与品牌匹配（小米含 9008 测试点条目）

### 回归底线

任何一步失败先跑：`npm test`（126 用例）与 `npm run smoke`（9 项，零设备写入）——单测全绿而真机失败 → 按验收点编号定位设备环境问题；单测红 → 提 issue 带最小复现。

## 诚实边界





- `pblFused` 本实现恒返回 N/A：PBL 熔断只能在 EDL 编程器会话判定，接入 EDL 层后补真值。
- 分区哈希采集（快照 partitionHashes）需要已 root 的 adb；未 root 时该字段为空，快照其余部分照常生成。
- `official` 资源源未注册解析器（厂商固件库按机型配置后启用）；github 别名表覆盖 Magisk/KernelSU/APatch，可扩展。
- execute_script 用 `new Function` 隔离：脚本只拿到注入的 api 对象（probe/snapshot/audit/resource），无 require/child_process。这是第一方脚本约定，不是对抗性沙箱——不要把不可信脚本喂进来。
- capability-map 的 load-modify-save 在单进程编排器场景下安全；多进程同时写靠原子 rename 保证不出半文件，但极端并发下可能互覆样本（按当前使用形态可接受）。
- `zygisk_next` / `playintegrityfix` 的 GitHub 仓库归属随社区维护迁移可能变动：resolver 报「未找到资产」时改 `resources.ts:GITHUB_ALIASES` 的 owner/repo 即可。
- 修补后端 `magiskboot-local` 在 Windows 原生环境不可用（无 POSIX sh/ELF）；`adb-ondevice` 依赖设备 /data/local/tmp 可写且 ≥200MB 空闲；`boot_patch.sh` 的行为随 Magisk 版本浮动，APK 内找不到修补脚本时自动降级 manual 引导。
- `cmd battery set level` 模拟电量依赖设备支持 battery 命令覆盖；不支持时以真实电量触发硬阻断。
- 沙箱是约定加固而非对抗性隔离（动态 import 残留绕过面）：不要把不可信脚本喂给 execute_script，这一点与 P1 交付时一致。


## v4.0.0 迭代变更

| 维度 | 实现 |
|:---|:---|
| 执行层物理隔离 | `opbus.ts`：LLM 只能下发 `{action,target,file,value}` 结构化操作，argv 由纯 TS 拼装（spawn 不经 shell）；shell 元字符注入、越权路径、未知 action 全部拦截并落审计链 `opbus:block:*`；erase/format/unlock/firehose 在白名单外**根本不存在**（2.3 由架构而非提示词保证）。`flashImage` 写入路径已接入 |
| 多源竞速下载 | `raceDownload`：direct + ghproxy.net + gh-proxy.com 并发 Range 探测延迟，最快存活节点优先，SHA256 逐源校验，损坏/失败源自动切下一个，全部失败不留残文件 |
| 手机端自主下载 | ≥50MB 且 `onDeviceDownload: true` 时：`adb shell wget/curl` 让手机走 Wi-Fi 下载到 `/data/local/tmp`，设备端 sha256 校验后 pull 回缓存，PC 不搬运流量 |
| 流水线预取 | `executeStep` 执行当前步时后台预取后续 install_module/resolve_resources 的资源（去重、失败可重试） |
| UI 自动化 | `ui-auto.ts`：uiautomator dump XML 解析（属性顺序容错）→ text/resource-id 定位 → 中心点走 opbus ui_tap → 点击前后 dump 比对，无变化给人工备用指引；executeStep 新增 `ui_confirm` 步骤 |
| USB 探针 | flash 连续 ≥2 次超时 → `diagnoseUsb()`（Windows 走 pnputil 枚举 Android/9008 设备）+ USB3 xHCI/线材/供电/驱动四大常见病因，注入错误详情 |
| 闪存保养 | `storageHealth` 极低（critical）升级为 **deny_hard** 物理级拒绝；warning 仍 infeasible；刷机收尾（final_probe）自动 `fstrim -v /data` 保养 |
| 盲操时序库 | 设备彻底失联时 android_probe 输出机型匹配的按键时序表（小米/三星/Pixel/一加/华为 + 通用），含 9008 进入方法 |
| 刷后深度调优 | 永久 Root 计划新增 `post_flash_tune` 步骤：私有 DNS（AdGuard DoT）系统级去广告、pm trim-caches、热门应用 `cmd package compile -m speed`、fstrim |

## v4 全量测试报告（122 用例 + 9 冒烟）

| 分组 | 覆盖 |
|:---|:---|
| opbus（9） | write_partition argv 拼装、erase/unlock/firehose 拦截（2.3 架构化）、未知 action、5 类 shell 元字符注入、sysfs 路径/值白名单、push 路径限定 /data/local/tmp、ui_tap 整数坐标、只读模板限定、非对象输入 |
| 下载竞速（4，全 Mock fetch） | 并发探测选最快存活节点、最快节点 500 自动切 direct、全部源 SHA256 不符 → resource_corrupted 且无残文件、on-device 50MB 阈值 |
| UI 解析（6，Mock dump XML） | 属性顺序容错解析、text/resource-id/contains 定位、bounds→中心点、前后 dump 比对、tap 走 opbus 且伪造坐标被拦、损坏 dump 不抛 |
| 硬件（3） | 盲操机型匹配（小米 12 秒时序/三星/Pixel/通用）、失联完整表格、warning→infeasible 与极低→deny_hard 分级 |
| 此前全量（100） | 令牌/审计链/AVB/稀疏/护栏/意图/capability-map/pendingStep/沙箱/物理硬阻断/ZIP/隐藏栈计划/DSH 插件/v3 场景矩阵 |
| 冒烟（9） | 探测→意图门控→计划（含资源准备）→写入拦截→护栏话术→恢复校验，零设备写入 |

## v5.0.0-RC1 交房变更

| 项 | 实现 |
|:---|:---|
| 中文/空格路径兜底 | opbus `HOST_PATH_RE` 扩展 CJK 区段：`C:\Users\张三\Desktop\boot.img` 全链路（opbus→spawn→fs）不崩溃；元字符拦截不受影响 |
| 锁屏兜底 | `uiConfirm` 首次 dump 为空 → `keyevent 82` 唤醒（opbus 新增 `wake_unlock` action）→ 重试一次 → 指引合并进 fallbackGuide，绝不抛异常 |
| 预取防呆 | `prefetchAsync` 双层 try/catch：单项异常不影响其余项，整体异常等于无预取，主流程零阻塞 |
| 发布包装 | package.json 补 `main`/`types`/`exports`（`.` 与 `./plugin` 双入口）/`files`；`RELEASE.md` 对外文案；真机验收清单（8 个验收点 A-H） |
