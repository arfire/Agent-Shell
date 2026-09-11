import { Observable, Subscription } from 'rxjs'
import { StringDecoder } from 'string_decoder'
import * as crypto from 'crypto'

import { ShellKind } from './shell-integration'
import { CommandExecutionResult } from './command-framing.middleware'

export interface ExecChannel {
    data$: Observable<Uint8Array>
    extendedData$: Observable<[number, Uint8Array]>
    closed$: Observable<void>
    eof$: Observable<void>
    requestExec: (command: string) => Promise<void>
    eof: () => Promise<void>
    close: () => Promise<void>
}

/** russh does not expose exit-status yet. A per-exec envelope reports it without
 * installing hooks, changing dotfiles, or typing into the interactive PTY. */
export function execEnvelope (command: string, shell: ShellKind, marker: string): string {
    if (shell === 'powershell') {
        return `$global:LASTEXITCODE=0; try { & { ${command}\n}; $ashOK=$?; $ashExit=if ($LASTEXITCODE) {$LASTEXITCODE} elseif ($ashOK) {0} else {1} } catch { Write-Output $_; $ashExit=1 }; [Console]::Out.Write("${marker}:$ashExit" + [char]7); Start-Sleep -Milliseconds 100`
    }
    if (shell === 'fish') {
        const quoted = command.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')
        return `env TERM=dumb PAGER=cat SYSTEMD_PAGER=cat GIT_PAGER=cat fish -c '${quoted}'; set -l ash_exit $status; printf '${marker}:%s\\007' $ash_exit; sleep 0.1`
    }
    return `(export TERM=dumb PAGER=cat SYSTEMD_PAGER=cat GIT_PAGER=cat;\n${command}\n); ash_exit=$?; printf '${marker}:%s\\007' "$ash_exit"; sleep 0.1`
}

export async function executeSSH (
    open: () => Promise<ExecChannel>, command: string, shell: ShellKind,
    onOutput: (text: string) => void, signal?: AbortSignal, timeoutMs = 120000,
): Promise<CommandExecutionResult> {
    signal?.throwIfAborted()
    const subscriptions = new Subscription()
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8')
    const marker = `__ASH_EXEC_${crypto.randomBytes(16).toString('hex')}__`
    const pattern = new RegExp(`${marker}:(-?\\d+)\x07`)
    let channel: ExecChannel|undefined = undefined
    let pending = '', output = ''
    let status: number|undefined = undefined
    let finished = false
    let timer: ReturnType<typeof setTimeout>|undefined = undefined
    let drainTimer: ReturnType<typeof setTimeout>|undefined = undefined
    let abort = (): void => undefined
    const emit = (text: string): void => {
        if (!text) { return }
        output = (output + text).slice(-262144)
        onOutput(text)
    }
    try {
        return await new Promise<CommandExecutionResult>((resolve, reject) => {
            const finish = (error?: unknown): void => {
                if (finished) { return }
                finished = true
                if (error) { reject(error) } else { resolve({ output, exitCode: status! }) }
            }
            abort = () => finish(signal?.reason ?? new DOMException('Agent stopped', 'AbortError'))
            signal?.addEventListener('abort', abort, { once: true })
            timer = setTimeout(() => finish(new Error('命令执行超时，已关闭独立 SSH 通道；远端进程状态需重新确认')), timeoutMs)
            const drain = (): void => {
                clearTimeout(drainTimer)
                // Native stdout, stderr and close callbacks can arrive on different queues.
                drainTimer = setTimeout(() => {
                    emit(pending + stdout.end() + stderr.end())
                    pending = ''
                    finish(status === undefined ? new Error('SSH 执行通道已结束，但未收到退出状态；请勿假定执行成功') : undefined)
                }, 100)
            }
            void open().then(async opened => {
                channel = opened
                if (finished) { await opened.close(); return }
                subscriptions.add(opened.data$.subscribe(data => {
                    if (finished) { return }
                    pending += stdout.write(Buffer.from(data))
                    const match = pattern.exec(pending)
                    if (match) {
                        emit(pending.slice(0, match.index) + pending.slice(match.index + match[0].length))
                        pending = ''
                        status = Number(match[1])
                    } else {
                        // Hold only a possible marker prefix; short prompts/output remain visible.
                        let hold = Math.min(pending.length, marker.length)
                        while (hold && !pending.endsWith(marker.slice(0, hold))) { hold-- }
                        const start = pending.indexOf(marker)
                        const end = start >= 0 ? start : pending.length - hold
                        emit(pending.slice(0, end))
                        pending = pending.slice(end)
                    }
                    if (drainTimer) { drain() }
                }))
                subscriptions.add(opened.extendedData$.subscribe(([, data]) => {
                    if (!finished) { emit(stderr.write(Buffer.from(data))); if (drainTimer) { drain() } }
                }))
                subscriptions.add(opened.eof$.subscribe(drain))
                subscriptions.add(opened.closed$.subscribe(drain))
                await opened.requestExec(execEnvelope(command, shell, marker))
                // This tool is noninteractive: reads must see EOF, never hang awaiting keystrokes.
                // finished may change while requestExec awaits the native callback.
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                if (!finished) { await opened.eof() }
            }).catch(finish)
        })
    } finally {
        finished = true
        clearTimeout(timer)
        clearTimeout(drainTimer)
        signal?.removeEventListener('abort', abort)
        subscriptions.unsubscribe()
        // Do not let a stalled native close keep the Agent locked.
        void (channel as ExecChannel|undefined)?.close().catch(() => undefined)
    }
}
