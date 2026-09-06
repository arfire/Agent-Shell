# 原生 SSH Agent 终端

同一个 SSH Tab 提供原本模式和 Agent 模式。新 SSH Tab 默认尝试 Agent 模式；Shell 集成失败时显示原因并回到原本模式。

## 输入与输出

- 原本模式：所有键盘输入直接交给 SSH。
- Agent 模式：确认提示符后，本地保存输入并在 xterm 字符网格中回显。Enter 在本地判断 Shell/自然语言，不调用额外的分类模型。
- Shift+Enter 强制给 Agent，Ctrl+Enter 强制给 Shell。底部提供同等操作，快捷键可在 AI 设置中修改。
- 多行粘贴不会自行提交；显式 Enter 后对整段分类。支持续行、引号、heredoc 和完整 Shell 代码围栏。自定义命令可强制发送 Shell，或加入配置中的命令列表。
- Tab、方向键、Ctrl+R 等把整段草稿交给远端编辑器，本轮保持远端控制，直到新的提示符。
- 执行程序及全屏程序直接使用 SSH 输入；Agent 运行时可通过停止按钮或 Ctrl+C 取消。

AgentTerminalPresenter 将增量按 40 ms 批量提交到 BaseTerminalTab.write，与 SSH 共用串行写入锁、xterm、滚动历史和复制选择。模型返回的 ANSI/OSC/DCS 等控制序列通过有状态过滤器剔除；颜色和 Agent 标签由本地生成。Agent 历史不进入 Angular DOM。

Agent 正文使用终端主题的青色，代码使用默认文字颜色。TerminalMarkdown 增量处理常用 Markdown：ATX 标题、星号粗体/斜体、删除线、列表、引用、行内代码及 fenced code。每个写入片段恢复样式，避免污染 Shell；解析状态跨片段保留，不反复解析已有文本。不完整或复杂 Markdown 可能退化为文字，这是低延迟终端子集，并非完整 CommonMark。链接、表格、HTML 和图片语法保持原文，不执行 HTML 或模型提供的 OSC。解析仅保留最多 32 字符的行首候选和少量样式状态，普通文字无需等待完整行。该处理仍有 CPU 和终端绘制开销，不承诺零延迟。

底部操作区参与 Tab 的正常布局，缩小终端可用高度，不覆盖终端。它只显示模式、短状态、审批、二次确认、敏感输入、补充问题和停止按钮。

## Shell 集成与生命周期

会话脚本以当前 SSH 用户身份载入当前交互 Shell，不需要 sudo，不修改 rc 文件，不创建服务。当前适配 Bash 5.1+、Zsh、Fish 和 PowerShell；更旧 Bash 会安全回退。

SSHShellSession.ready$ 确认 Shell 通道建立后，独立的非 PTY exec 通道探测 Shell 身份。探测仅读取 Shell 身份变量，并使用结束标记；短暂延迟关闭，兼容原生 SSH 回调的到达次序。

脚本输出带本会话随机 nonce 的提示符标记。前端过滤这些标记，等待输出排空和提示符稳定后才启用本地输入。初次安装使用提示符启发式；安装后启发式不授权输入捕获。nonce 用于区分会话，不构成针对恶意远端的信任认证。

Agent 开始时本地记录提示符位置；执行命令前和 Agent 结束后通过远端空输入请求真实提示符，重新对齐 readline。命令运行期间 Presenter 暂停，等下一提示符后恢复输出。

切回原本模式会停止 Agent 后续动作，先收尾仍在本地的输出；已经运行的远端命令继续执行，保留结束标记与退出码，并显示接管提醒。只有停止 Agent/Ctrl+C 才主动中断命令。

脚本卸载只在确认的空提示符发送；程序运行或远端正在编辑时延后。安装异常也保留待清理状态，处理迟到的安装/提示符标记。快速切换等待卸载确认后再安装。正常关闭 Tab 会关闭它自己的 Shell 通道，包括复用 SSH 连接时；崩溃没有持久化脚本需要清除，残留远端进程中的钩子仅输出标记，不执行 Agent 操作。

## 安全和事件

保留现有策略、敏感占位符本地恢复、redaction、审批和编辑后重新评估、request_user_input、begin/end framing、退出码、取消和 JSONL 事件。已知敏感值的增量过滤会保留可能跨块的前缀。命令结果增加退出码与是否交接的事件记录。

PowerShell 命令及包含命令替换的 Fish 命令不能直接套用 POSIX 自动批准规则，保留拒绝规则并要求二次审批。模型上下文会注明当前 Shell。

## 验证方法

使用 Node.js 22、Yarn 1.x，先运行项目构建。测试不调用真实模型服务。

```powershell
yarn test:native-agent
$env:ASH_TEST_PWSH = (Get-Process -Id $PID).Path
yarn test:native-agent:pty
docker build -t ash-native-agent-test:local scripts/native-agent-test
yarn test:native-agent:ssh
```

SSH 测试创建临时容器，端口仅绑定 127.0.0.1，随机生成一次性账号密码，不挂载用户目录。每种 Shell 启动独立配置的 Ash，通过正式 SSH 实现连接容器，只将模型换成本机 SSE 测试服务。测试配置中关闭主机密钥确认仅用于该隔离实例。容器在测试结束后删除；截图和日志保留在 `.build-cache/native-agent-ui-*`。可用 ASH_TEST_SHELLS=bash,zsh,fish 选择子集。

已覆盖：原生回答与历史保留、审批布局、敏感占位符、中文组合输入提交、手动路由快捷键、Vim/less/top 进入与退出、历史/补全、异步输出时保存草稿、中文长输入缩放、断线重连、取消正在执行的命令、运行中切换模式与退出码捕获。单元检查另外覆盖分块控制序列、跨块秘密、heredoc、多行粘贴、失败清理和快速模式切换。

## 验证边界

- Linux SSH 实测环境为隔离 Alpine 的 Bash、Zsh、Fish。PowerShell 已做 Windows 本地 PTY 测试，尚未验证 Windows OpenSSH/ConPTY 的完整远程场景；ConPTY 屏幕重绘可能覆盖本地文字，需要单独验收。
- 中文组合输入通过 Chromium 输入事件模拟；系统输入法候选窗仍需人工检查。
- 命令识别是启发式，不是完整 Shell 解析器；提示符主题、tmux/screen、嵌套 Shell、自定义 readline/ZLE 钩子需进一步兼容验证。
- 超过整个视口的超长本地草稿，重绘可能重复部分滚动历史；完整提交内容保留。普通多行命令和视口内宽字符缩放已有验证。
- 原仓库全量 ESLint 有既有错误；本次新增/修改的终端核心做了针对检查，并对修改文件与 HEAD 逐项比较，未新增 lint 规则错误。
