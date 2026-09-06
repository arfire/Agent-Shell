# Ash · Agent Shell

**基于 [Tabby](https://github.com/Eugeny/tabby) 的 SSH Agent 终端。一个原生终端，两种输入模式。**

Ash 是在 Tabby 基础上进行的二次开发，不是从零编写的终端，也不是 Tabby 官方发行版。终端引擎、SSH / SFTP、本地终端、标签页、主题和插件体系等基础能力来自 Tabby。感谢 Tabby 开发者和贡献者提供的开源基础。

Ash 的主要工作，是在这套基础上增加 SSH Agent：让自然语言任务、命令执行和回答共用同一个终端，同时保留人工使用 Shell 的方式。

- 上游项目：[Eugeny/tabby](https://github.com/Eugeny/tabby)
- Tabby 官网：[tabby.sh](https://tabby.sh/)
- 本项目：[arfire/Agent-Shell](https://github.com/arfire/Agent-Shell)

## 当前状态

当前 Ash 版本为 **0.0.2**，记录的 Tabby 基础版本为 **1.0.235**，以根目录 [version.json](version.json) 为准。项目仍在开发中，当前重点是 Windows x64 下的原生 SSH Agent 工作流；继承上游的跨平台代码不代表 Ash 新增能力已在所有平台验证。

## 使用方式

同一个 SSH 标签页提供两种模式：

| 模式 | 行为 |
| --- | --- |
| 原本模式 | 输入直接交给 SSH，不进行 Agent 自动识别。 |
| Agent 模式 | 在已识别的 Shell 提示符下，本地暂存输入，按 Enter 后判断交给 Shell 还是 Agent。 |

新 SSH 标签默认尝试启用 Agent 模式；Shell 集成失败时显示原因并回到原本模式。

在 Agent 模式下：

- 输入 Shell 命令，仍由当前 SSH Shell 执行。
- 输入自然语言任务，Agent 可读取当前会话上下文，提出并执行命令，再根据输出与退出码继续处理。
- 支持多行命令、heredoc 和多行自然语言处理；粘贴不会自行提交，需要明确按键发送。
- Tab、方向键、Ctrl+R 等需要远端 readline 的操作，会把当前草稿交回 SSH，直到下一次确认提示符。
- 命令运行和 Vim、top、less 等交互程序期间，输入直接透传 SSH。

默认快捷键可在 AI 设置中修改，底部也提供手动路由操作：

| 操作 | 默认按键 |
| --- | --- |
| 自动识别并发送 | Enter |
| 强制交给 Agent | Shift+Enter |
| 强制交给 Shell | Ctrl+Enter |
| 中止正在运行的 Agent | Ctrl+C 或停止按钮 |

命令识别采用本地规则，并非完整 Shell 语法解析器；自定义命令识别不符合预期时，可以手动指定 Shell。

## Agent 输出与交互

Agent 回答直接写入 xterm，与 SSH 输出共享字符网格、滚动历史、选择和复制，不使用悬浮聊天框或 inline DOM 输出块。

```text
模型增量文本
  → 控制序列过滤与轻量 Markdown 转换
  → AgentTerminalPresenter 批量写入
  → BaseTerminalTab.write()
  → xterm
```

正文使用终端主题青色，代码使用默认文字色。支持标题、加粗、斜体、删除线、列表、引用、行内代码和代码块；不是完整 CommonMark 渲染器，链接、表格和 HTML 等复杂语法保持文字形式。增量解析不反复重绘整段回答，但仍有解析与终端绘制开销。

终端底部的临时操作区负责命令审批、危险命令二次确认、密码或 Token 输入、补充问题、停止和模式切换，不承载历史回答。

## 执行与数据处理

- 命令由本地策略进行风险判断，包含审批、二次确认和禁止规则。
- 敏感输入通过本地占位符传递给模型，实际执行时在本地恢复；提供输入输出脱敏处理。
- 使用命令开始／结束标记和退出码跟踪执行结果，处理取消及输出过滤。
- 会话事件保存为本地 JSONL。恢复带有原 Agent 会话 ID 的 SSH 标签时，可加载已保存的上下文；目前尚无手动选择历史会话的管理界面。
- 切回原本模式会停止 Agent 的后续动作，已经运行的远端命令可以继续；主动中断请使用停止操作。

使用配置的模型服务时，任务文本和经过处理的相关终端上下文会发送给该服务。脱敏与审批是辅助保护，不保证识别所有敏感信息或危险命令；请留意审批内容与目标服务器。

Shell Integration 目前适配 Bash 5.1+、Zsh、Fish 和 PowerShell。脚本以当前 SSH 用户权限加载到当前 Shell，不修改 Shell 启动配置、不安装服务，也不要求 sudo。

## 从源码运行

建议使用 **Node.js 22、Yarn 1.x**。在 Windows PowerShell 中：

```powershell
git clone https://github.com/arfire/Agent-Shell.git
cd Agent-Shell

./scripts/ash-install-dependencies.ps1
./scripts/ash-build.ps1
./scripts/ash-start.ps1
```

安装和打包脚本使用了 npmmirror 下载源，运行时需要能访问相应服务。Docker 仅用于隔离 SSH 测试，不是运行 Ash 的必要条件。

启动后，进入 **设置 → AI**，填写支持 Chat Completions、流式响应和工具调用的模型服务地址、API Key 与模型名称。可以从服务的 `/models` 接口获取模型列表，也可以手动输入。保存配置后重启 Ash，再打开 SSH 连接。

### Windows x64 便携包

```powershell
./scripts/ash-package-windows-x64.ps1
```

打包脚本会先构建，产物位于 `dist/`。便携版默认在可执行文件旁创建 `data/`；使用上述源码启动脚本时，数据保存在项目根目录的 `data/`。

AI 配置与会话记录位于应用数据目录下的 `tabby-ai/`。更新便携版时保留原 `data/`，才能继续使用原配置与已保存的会话记录。

本地 `.env`、数据目录、构建缓存和产物应保持在 Git 之外；不要将含密钥的配置或真实服务器日志放入提交。

## 代码结构

| 目录 | 职责 |
| --- | --- |
| `app/` | Electron 应用入口与窗口管理 |
| `tabby-core/` | Tabby 核心服务与通用界面 |
| `tabby-terminal/` | 终端标签、输入输出与 xterm 前端 |
| `tabby-ssh/` | SSH、SFTP 与连接管理 |
| `tabby-ai/` | Ash Agent、模型接口、策略、会话记录、原生呈现及底部操作区 |
| `scripts/` | 构建、打包和专项验证脚本 |

## 验证与兼容范围

构建完成后，可按需运行以下专项验证：

```powershell
yarn test:native-agent
yarn test:native-agent:pty
# 需要 Docker Desktop 已启动
yarn test:native-agent:ssh
```

SSH 验证使用本机模拟模型服务和临时 SSH 容器，不调用真实模型 API。日志和截图写入 `.build-cache/`，测试容器在结束时清理。

已有验证包括 Bash、Zsh、Fish 的隔离 SSH 场景，以及 Windows 本地 PowerShell PTY。Windows OpenSSH 完整远程链路、系统中文输入法候选窗、复杂提示符主题、tmux/screen、嵌套 Shell 等仍需进一步验证。全量仓库 ESLint 尚有既有问题，专项检查通过不等于全仓库检查全部通过。

## 后续计划

以下功能已讨论，**尚未实现**：

- 左侧工作面板：服务器连接配置、SFTP 文件管理、Agent 会话管理。
- 复用 Tabby 连接配置与分组，快速连接服务器。
- 可选的 SFTP 跟随当前 Shell 工作目录。
- 按服务器分组的 Agent 历史列表、预览与上下文加载；恢复上下文无需恢复旧 SSH 连接。
- 更广泛的 Shell 与平台兼容验证。

## 致谢与许可证

**Tabby 是 Ash 的基础。** 本项目保留上游提交历史与版权声明，Ash 的新增工作主要集中在 SSH Agent 工作流及其集成。终端、连接和插件等基础能力应归功于 Tabby 开发者与社区贡献者。

本项目采用 [MIT License](LICENSE)。许可证保留 `Copyright (c) 2017 Tabby Developers`，并包含 Ash 的新增版权声明。再分发时请保留相关版权和许可声明；第三方依赖遵循各自的许可证。
