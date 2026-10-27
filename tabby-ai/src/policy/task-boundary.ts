import { executionBoundary } from './execution-boundary'

export interface TaskRestrictions {
    tools: boolean
    commands: boolean
    changes: boolean
    install: boolean
    sourceChanges: boolean
}

/** Only the current user's request can establish these limits, never model/file text. */
export function taskRestrictions (input: string, afterFailure = false): TaskRestrictions {
    if (!afterFailure) { input = String(input).replace(/(?:若|如果|假如|万一|\bif\b)[^。.;\n]*(?:失败|出错|fails?|failure)[^。.;\n]*/gi, '') }
    const noTools = /(?:不要|禁止|不得|不许|不)\s*(?:调用|使用)\s*(?:任何)?工具|\b(?:no tools|do not (?:call|use) (?:any )?tools|without (?:calling|using) tools)\b/i.test(input)
    const noCommands = /只(?:做)?分析|仅(?:做)?分析|(?:不要|禁止|不得|不许|不)\s*执行(?:任何)?(?:命令|操作)|\b(?:analysis only|explain only|do not (?:execute|run) (?:any )?(?:commands?|anything))\b/i.test(input)
    const intent = String(input).replace(/(?:不要|禁止|不得|不许|不)[^，,。.;\n]*/g, '')
    const query = /查看|检查|查询|诊断|读取|列出|概括|总结|状态|版本|\b(?:inspect|check|read|list|summarize|status|version)\b/i.test(intent)
    const operation = /部署|安装|创建|启动|停止|重启|修复|更新|升级|删除|上传|下载|修改|执行|运行|写入|\b(?:deploy|install|create|start|stop|restart|repair|fix|update|upgrade|delete|upload|download|modify|execute|run|write)\b/i.test(intent)
    const noChanges = query && !operation || /只(?:做)?(?:诊断|检查|查看)|只读|(?:不要|禁止|不得|不许|不)\s*(?:修改|改动|写入)(?:任何)?(?:文件|环境|服务器)|(?:不要|禁止|不得)\s*(?:进行)?任何修改|\b(?:read[- ]only|diagnos(?:e|is) only|do not (?:modify|change|write) (?:any )?(?:files|environment|server))\b/i.test(input)
    const noInstall = /(?:不要|禁止|不得|不许|不)\s*安装|do not install/i.test(input)
    const noSource = /(?:不要|禁止|不得|不许|不)\s*(?:修改|改动|改)(?:应用|源|项目)?代码|do not (?:modify|change) (?:source |application )?code/i.test(input)
    return { tools: !noTools, commands: !noTools && !noCommands, changes: !noTools && !noCommands && !noChanges, install: !noInstall, sourceChanges: !noSource }
}

export function taskCommandReason (goal: string, command: string, afterFailure = false): string|undefined {
    const limits = taskRestrictions(goal, afterFailure)
    if (!limits.commands) { return '本次任务只允许分析，执行工具已被禁用。若需要操作，请发起新的执行任务。' }
    if (!limits.install && /(?:^|[;|&\n])\s*(?:sudo\s+(?:-n\s+)?)?(?:apt(?:-get)?|apk|dnf|yum|pacman|pip\d*|npm|yarn)\b[^;\n]*\b(?:install|add|upgrade|update)\b/i.test(command)) {
        return '本次任务明确禁止安装或更新软件，命令未执行。'
    }
    if (!limits.sourceChanges && /\.(?:py|js|ts|tsx|jsx|java|go|rb|php|vue|rs)\b/i.test(command) &&
        /\b(?:tee|Set-Content|Add-Content|sed\s+[^;\n]*-i|git\s+(?:apply|checkout))\b|(?:^|[^<])>{1,2}/i.test(command)) {
        return '本次任务明确禁止修改应用代码，命令未执行。'
    }
    if (limits.changes) { return undefined }
    const changes = executionBoundary(command).risk === 'DANGEROUS' ||
        /(?:^|[;|&\n])\s*(?:sudo\s+(?:-\w+\s+)*)?(?:touch|mkdir|tee|cp|mv|ln|install|kill|pkill|killall)\b/i.test(command) ||
        /(?:^|[^<])>(?!&)|\b(?:write_text|write_bytes|writeFile|writeFileSync|unlink|rmtree)\s*\(/.test(command) ||
        /\b(?:systemctl|service)\s+(?:\S+\s+)?(?:start|stop|restart|reload|enable|disable)\b|\b(?:docker|podman)(?:\s+compose)?\s+(?:up|start|stop|restart|create|build|pull|run|exec)\b/i.test(command) ||
        /\bcurl\b[^\n]*(?:--data|--json|--upload-file|-d\s|-T\s|(?:-X|--request)\s+(?:POST|PUT|PATCH|DELETE))/.test(command) ||
        /(?:^|[;&|\n])\s*(?:sh|bash|zsh|fish)\s+\S+\.sh\b/.test(command)
    return changes ? '本次任务明确只读，此命令会修改文件、服务或远端状态，未执行。' : undefined
}
