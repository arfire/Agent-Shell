# Ash

<img src="app/assets/logo.png" width="96" alt="Ash Logo">

SSH Agent 终端，由 Arfire 开发和维护。

## v0.0.9

- 连接服务器支持图形表单；登录密码不会写入最近连接或恢复记录。
- SFTP 显示进度和失败原因，支持文件夹进度及取消。
- 前三个权限档位保留任务与凭据检查；“放手一搏”保留完全放行行为。部署可使用已有配置，支持查询配置字段状态。

验证：完整构建、代码检查、66 项原生检查、真实 SSH/SFTP，以及模型部署测试通过。命令检查不等于操作系统沙箱，详细边界见 [凭据保护说明](docs/AGENT_CREDENTIAL_SAFETY.zh-CN.md)。

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

## 版本管理与构建

GitHub 仓库用于代码版本管理，不运行 CI/CD、自动发布或依赖更新机器人。构建、测试和打包在本地执行；Windows 便携包可通过 `./scripts/ash-package-windows-x64.ps1` 生成到 `dist/`。

## 开源许可

Ash 基于 [Tabby](https://github.com/Eugeny/tabby) 二次开发，采用 [MIT License](LICENSE)，保留上游及 Ash 的版权与许可声明。
