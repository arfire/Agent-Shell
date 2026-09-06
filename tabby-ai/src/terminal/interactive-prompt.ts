export type InteractivePromptKind = 'password'|'yes-no'|'text'

function stripTerminalControls (content: string): string {
    return content
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
        .replace(/\x1b[ -\/]*[0-~]/g, '')
}

export function detectInteractivePrompt (content: string): { prompt: string, kind: InteractivePromptKind }|null {
    const normalized = stripTerminalControls(content).replace(/\r(?!\n)/g, '\n')
    const password = /([^\r\n]*(?:password|passphrase|verification code|one[- ]time code|otp|密码|口令|验证码)[^\r\n]{0,160}(?:[:：]|\?))\s*$/i.exec(normalized)
    if (password) {
        return { prompt: password[1].trim(), kind: 'password' }
    }
    const yesNo = /([^\r\n]*(?:\[[Yy](?:es)?\s*\/\s*[Nn](?:o)?\]|\[[Nn](?:o)?\s*\/\s*[Yy](?:es)?\]|\([Yy](?:es)?\s*\/\s*[Nn](?:o)?\)|\([Nn](?:o)?\s*\/\s*[Yy](?:es)?\)|continue\?|proceed\?|are you sure|确认|是否)[^\r\n]*)\s*$/i.exec(normalized)
    if (yesNo) {
        return { prompt: yesNo[1].trim(), kind: 'yes-no' }
    }
    const text = /([^\r\n]{2,240}(?:enter|input|select|choose|provide|port|path|name|username|请输入|请选择|输入|端口|路径|名称|用户名)[^\r\n]*(?:[:：]|\?))\s*$/i.exec(normalized)
    if (text) {
        return { prompt: text[1].trim(), kind: 'text' }
    }
    return null
}

export function looksLikeShellPrompt (content: string): boolean {
    const normalized = stripTerminalControls(content).replace(/\r(?!\n)/g, '')
    return /(?:^|\n)[^\r\n]{0,200}(?:[$#>%])\s*$/u.test(normalized)
}
