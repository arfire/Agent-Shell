# Ash · Agent Shell

基于 [Tabby](https://github.com/Eugeny/tabby) 的 SSH Agent 终端。

## 功能

- **双模式切换**：原本模式直接使用 SSH，Agent 模式支持识别 Shell 命令与自然语言任务。
- **原生 Agent 输出**：回答直接显示在终端中，支持复制、滚动历史和轻量 Markdown 样式。
- **Shell 交互**：保留补全、历史、多行命令及 Vim、top、less 等交互程序的使用方式。
- **执行控制**：支持命令审批、敏感输入脱敏和停止 Agent。
- **自定义模型**：接入支持 Chat Completions、流式响应和工具调用的模型服务。

操作说明见 [中文使用手册](docs/USER_GUIDE.zh-CN.md)。

## 启动

准备 **Node.js 22、Yarn 1.x**，在 Windows PowerShell 中执行：

```powershell
git clone https://github.com/arfire/Agent-Shell.git
cd Agent-Shell

./scripts/ash-install-dependencies.ps1
./scripts/ash-build.ps1
./scripts/ash-start.ps1
```

启动后进入 **设置 → AI**，填写 API 地址、API Key 和模型名称，保存后打开 SSH 连接即可使用。

## 致谢

Ash 基于 [Tabby](https://github.com/Eugeny/tabby) 二次开发，是独立项目。终端、SSH / SFTP、标签页、主题和插件体系等基础能力来自 Tabby，感谢上游开发者及社区贡献者。

欢迎了解和支持 [Tabby 原项目](https://tabby.sh/)。本项目采用 [MIT License](LICENSE)，保留 Tabby Developers 的版权与许可声明，Ash 新增代码的版权声明见许可证。
