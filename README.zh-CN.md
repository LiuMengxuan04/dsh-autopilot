<p align="center">
  <img src="./assets/dsh-autopilot-logo.png" width="220" alt="Oh My DSH 标志">
</p>

<h1 align="center">Oh My DSH</h1>

<p align="center">面向 DeepSeek Harness 长时开发任务的持久控制层。</p>

<p align="center"><strong>（别名：DSH Autopilot · npm 注册包：<code>dsh-autopilot</code>）</strong></p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./docs/architecture.md">架构</a> ·
  <a href="./docs/autonomy-and-security.md">安全</a> ·
  <a href="./docs/testing.md">测试</a>
</p>

DeepSeek Harness 本身已经能够让 Goal 持续推进。Oh My DSH 补上了长任务更容易缺失的部分：可以跨重启保存的任务图、有界 worker、固定完成检查、恢复流程，以及不会完全交给模型临场发挥的最终汇报。

它运行在 DSH 之上，而不是替换 DSH。原生 Agent loop、Goal 生命周期、权限、session、工具和 Cordis runtime 仍然是执行基础。

## 开发者预览

`0.1.0-alpha.3` 是面向 DSH 与插件系统开发者的预发布版本。DSH 本身仍在快速开发中，公开 API、插件组合、配置和持久化状态都可能在后续预发布版本中发生非兼容性修改。

请使用隔离 profile，备份重要数据，并安装精确支持的版本：

- DeepSeek Harness `0.1.0-rc.6`
- Cordis `4.0.1`
- Node.js `^22.19.0 || >=24.0.0`

这是独立的社区项目，不是 DeepSeek 官方产品。

## 适合什么任务

如果需求只是“让模型继续下一轮”，原生 Goal 模式通常已经足够。任务还需要跨重启规划、依赖顺序、委派执行、验收证据和明确完成门槛时，才适合使用 Autopilot。

一次 Autopilot 运行包含：

- 持久租约，以及 round、时长、验证、动态 package 和 worker 上限；
- 需求访谈，以及固定的三角色方案审查；
- 记录依赖、尝试、阻塞和证据的持久 DAG；
- 受控一次性委派、可续接 Team worker、有界 Ralph 循环、固定 Workflow 和 Mission 队列；
- 冻结的项目检查和全新只读完成 reviewer；
- 压缩、Agent 错误、插件重载和进程重启后的恢复；
- pause、resume、stop、audit 和完成记录；
- 展示 Goal、DAG、worker、验证、预算和清理状态的文本 dashboard。

状态无法安全对账时，运行会停在 `needs-attention`，不会自行猜测后续动作。

## 快速开始

从 npm 把预发布版本安装到隔离的 DSH profile：

```sh
dsh plugin --profile web add dsh-autopilot@next
dsh --profile web --dump-config
dsh plugin --profile web exec dsh-autopilot doctor --profile web
```

在目标项目中打开一个顶层 DSH session，然后启动运行：

```text
/autopilot start --rounds 256 --duration 2d 实现所需改动，补充聚焦测试和文档，运行仓库检查，并用文件与命令证据汇报结果。
```

Autopilot 命令必须写明操作。单独输入 `/autopilot` 不会自动执行 `status` 或 `start`。

```text
/autopilot status
/autopilot dashboard
/autopilot audit --limit 20
/autopilot pause
/autopilot resume [--duration 1d]
/autopilot stop
```

`pause` 会保留运行状态，但解除 Goal 与 runtime 授权。`resume` 必须由人类触发。`stop` 会撤销运行并清除匹配的原生 Goal，但不会删除 DSH transcript 或 Autopilot 审计历史。

## 一次运行如何推进

1. Autopilot 访谈需求并记录回答。
2. 它写入依赖图，再让三个固定方案 reviewer 检查计划。
3. 已就绪任务在本地或受控 worker 中执行；任务完成时必须附带证据。
4. Autopilot 冻结完成策略并运行选定的项目检查。
5. 全新只读 reviewer 检查结果。门槛未通过时进入修复循环；全部通过后完成精确匹配的 Goal，并交付最终汇报。

随包 profile 默认提供 1,024 个 Goal round 和七天活跃时间，部署上限为 4,096 round 与 30 天。暂停时间不消耗活跃时间租约。profile 还会限制验证次数、动态 package、subagent 启动次数，以及每次受控 dispatch 或 reviewer fan-out 的规模。

项目检查只从有限的 manifest recipe 中发现。选定检查、工作区和相关根 manifest 哈希会在本次运行中冻结。根 manifest 变化后，验证会明确报告漂移，不会静默换成另一套检查。

## 查看 DAG

当前 dashboard 是文本视图，不是自定义 Web 图形面板。

执行：

```text
/autopilot dashboard
```

快照会显示任务依赖和状态，并列出 Goal、worker、验证结果、预算与未完成清理。它只在请求时生成，运行结束后不会自动弹出。

需要完整机器可读状态时使用 `/autopilot status`。使用 `/autopilot audit --json` 前请检查输出内容；审计数据可能包含目标、证据、发现和可信 Host 源码。

## 安全与权限

- Autopilot 不替代 DSH 权限系统或原生 Goal 所有权。
- Client Cordis 代码仍然经过 DSH 原生审批流程。
- `selfModification` 默认是 `off`。
- `host-only` Cordis 代码在 DSH 进程内运行。Cordis VM 不是安全沙箱，只应在可信、可丢弃、无凭据的环境中启用，或放在操作系统级隔离之后。
- 受控资源清理失败会形成 cleanup debt；清理成功前，后续模型工作会被阻止。
- DSH 与 Autopilot 无法共享事务的恢复路径采用至少一次语义。如果完成报告已经显示、但确认前发生崩溃，报告可能重复。
- Visual QA 使用精确 origin allowlist，但不是网络沙箱。
- Delivery 只准备有界的本地 worktree 和命令计划，不会静默 commit、push、创建、合并或发布 PR。

启用 Host 自修改、外部通知、MCP server、浏览器访问或交付集成之前，请阅读[自治与安全](./docs/autonomy-and-security.md)。

## 从源码构建

```sh
git clone https://github.com/LiuMengxuan04/oh-my-dsh.git
cd oh-my-dsh
pnpm install --frozen-lockfile
pnpm run check
pnpm pack --pack-destination .artifacts
```

使用 `dsh plugin --profile web add <tarball>` 安装生成的 tarball。

发布检查包括：

```sh
pnpm run capabilities:check
pnpm run typecheck
pnpm run lint
pnpm run test:coverage
pnpm run build
pnpm exec publint
DSH_AUTOPILOT_E2E_BROWSER_CHANNEL=msedge pnpm run test:e2e
```

[测试说明](./docs/testing.md)记录了 unit、packed 和真实模型证据的区别。详细实现账本位于 [`capabilities.lock.json`](./capabilities.lock.json)。

卸载插件：

```sh
dsh plugin --profile web remove dsh-autopilot
dsh --profile web --dump-config
```

卸载 package 不会删除已有 DSH transcript 或 Autopilot storage 记录。

## 灵感来源

Oh My DSH 的灵感来自 [oh-my-codex（OMX）](https://github.com/Yeachan-Heo/oh-my-codex)，尤其是先澄清任务再执行、让长时工作保持持久、使用专门角色审查，以及让进度可见这些设计取向。

本仓库是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立实现，与 OMX 项目没有从属或官方合作关系。DSH 仍是执行平台；Autopilot 组合其公开的 Goal、Agent、session、storage、subagent、Skill 和 Cordis 接口。

## 许可证

[MIT](./LICENSE)
