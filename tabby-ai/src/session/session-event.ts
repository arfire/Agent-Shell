export type SessionEventType =
    'user-ai-input' |
    'ssh-input' |
    'ssh-output' |
    'ai-message' |
    'ai-command' |
    'command-result' |
    'approval' |
    'interaction' |
    'agent-state' |
    'summary' |
    'error'

export interface SessionEvent<T = unknown> {
    version: 1
    id: string
    sessionId: string
    seq: number
    time: string
    type: SessionEventType
    runId?: string
    data: T
}

export interface SessionMetadata {
    id: string
    createdAt: string
    updatedAt: string
    profileId?: string
    host?: string
    user?: string
    nextSeq: number
}
