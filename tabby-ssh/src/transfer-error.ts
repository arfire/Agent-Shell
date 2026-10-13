/** Translate transport errors into a useful message without exposing native structs. */
export function transferErrorMessage (error: unknown): string {
    const text = error instanceof Error ? error.message : String(error)
    if (/permission.?denied|PermissionDenied|access.?denied/i.test(text)) { return '权限不足，请检查目标目录或文件的访问权限。' }
    if (/no such file|not.?found|NoSuchFile/i.test(text)) { return '文件或目录不存在，请刷新后重试。' }
    if (/no space|disk.?full|NoSpace/i.test(text)) { return '磁盘空间不足，请清理空间后重试。' }
    if (/cancelled|canceled/i.test(text)) { return '传输已取消。' }
    if (/timeout|timed out/i.test(text)) { return '传输超时，请检查连接后重试。' }
    if (/disconnect|connection.?lost|closed|eof/i.test(text)) { return '连接已中断，请重新连接后重试。' }
    if (/size.*match|verify/i.test(text)) { return '文件校验失败，未确认传输完成，请重试。' }
    return '传输未完成，请检查连接和目标目录后重试。'
}
