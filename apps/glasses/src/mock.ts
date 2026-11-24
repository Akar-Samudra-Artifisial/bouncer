import type {
  ActionConfirmResult,
  ActionKind,
  ActionPreview,
  Alert,
  PairStartResponse,
  PairStatusResponse,
  RiskLabel,
  SummaryResponse,
  VoiceIntent,
  VoiceResponse,
} from '@bouncer/shared'
import { ApiError } from './errors'

const now = Date.now()
const ago = (min: number) => new Date(now - min * 60_000).toISOString()

/** Offline demo data used when no server is configured (VITE_MOCK=1 or no VITE_API_BASE). */
export const MOCK_ALERTS: Alert[] = [
  {
    id: 'mock-1',
    seq: 1,
    source: 'telegram',
    kind: 'telegram.link',
    severity: 'medium',
    status: 'open',
    title: '@cheap_followers: Grow your channel fast → bit.ly/x…',
    summary: 'link — Grow your channel fast → bit.ly/x… 10k followers for $5',
    scope: 'Hiking Club Bandung',
    url: null,
    createdAt: ago(14),
    target: { chatId: -1001000000001, messageId: 4210, userId: 70001, username: 'cheap_followers', chatTitle: 'Hiking Club Bandung' },
    actions: ['delete', 'mute', 'ban', 'dismiss'],
  },
  {
    id: 'mock-2',
    seq: 2,
    source: 'telegram',
    kind: 'telegram.report',
    severity: 'high',
    status: 'open',
    title: '@shouty_guy: you are all idiots, leave this group',
    summary: 'reported by @rina — you are all idiots, leave this group',
    scope: 'Hiking Club Bandung',
    url: null,
    createdAt: ago(6),
    target: { chatId: -1001000000001, messageId: 4233, userId: 70002, username: 'shouty_guy', chatTitle: 'Hiking Club Bandung' },
    actions: ['delete', 'mute', 'ban', 'dismiss'],
  },
  {
    id: 'mock-3',
    seq: 3,
    source: 'telegram',
    kind: 'telegram.keyword',
    severity: 'high',
    status: 'open',
    title: 'Budi: DM me for crypto airdrop, guaranteed 10x',
    summary: 'keyword "airdrop" — DM me for crypto airdrop, guaranteed 10x',
    scope: 'Dev Meetup JKT',
    url: null,
    createdAt: ago(2),
    // messageId 9999…400: provider actions fail (like the server's dry-run simulation).
    target: { chatId: -1001000000002, messageId: 9999400, userId: 70003, chatTitle: 'Dev Meetup JKT' },
    actions: ['delete', 'mute', 'ban', 'dismiss'],
  },
  {
    id: 'mock-4',
    seq: 4,
    source: 'telegram',
    kind: 'telegram.link',
    severity: 'medium',
    status: 'open',
    title: '@rina_mod: Meetup moved to Saturday → meet.example/hc',
    summary: 'link — Meetup moved to Saturday → meet.example/hc',
    scope: 'Hiking Club Bandung',
    url: null,
    createdAt: ago(1),
    // Group admin: delete/mute/ban are refused with "cannot moderate admins".
    target: { chatId: -1001000000001, messageId: 4240, userId: 70010, username: 'rina_mod', chatTitle: 'Hiking Club Bandung' },
    actions: ['delete', 'mute', 'ban', 'dismiss'],
  },
]

/** Mock group admins (the server asks Telegram getChatMember). */
const MOCK_ADMIN_IDS = new Set([70010])

const MOCK_HEADLINE: Record<ActionKind, string> = {
  delete: 'Delete message',
  mute: 'Mute user 1 hour',
  ban: 'Ban user',
  dismiss: 'Dismiss flag',
}

const MOCK_DETAIL: Record<ActionKind, string> = {
  delete: 'Deletes the flagged message from the group.',
  mute: 'Stops the author from sending messages for 1 hour.',
  ban: 'Removes the author from the group and blocks rejoining.',
  dismiss: 'Closes the flag without touching Telegram.',
}

// ---- pairing: auto-approves a few seconds after the code is shown ----------

const MOCK_APPROVE_AFTER_MS = 4000
const mockPairings = new Map<string, number>()

export function mockPairStart(): PairStartResponse {
  const pollSecret = `mock-poll-${mockPairings.size + 1}`
  mockPairings.set(pollSecret, Date.now())
  return {
    code: 'MOCK42',
    pollSecret,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    pollIntervalMs: 1000,
  }
}

export function mockPairStatus(pollSecret: string): PairStatusResponse {
  const startedAt = mockPairings.get(pollSecret)
  if (startedAt === undefined) return { status: 'expired' }
  if (Date.now() - startedAt < MOCK_APPROVE_AFTER_MS) {
    return { status: 'pending', expiresAt: new Date(startedAt + 10 * 60_000).toISOString() }
  }
  mockPairings.delete(pollSecret)
  return { status: 'approved', deviceId: 'mock-device', deviceName: 'Mock G2', token: 'mock-device-token' }
}

// ---- write actions: same intent → nonce → confirm flow as the server ---------

const MOCK_TTL_MS = 60_000
const mockRequests = new Map<string, { nonce: string; alertId: string; action: ActionKind; expiresAt: number }>()
let mockSeq = 0

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function mockIntent(alertId: string, action: ActionKind): Promise<ActionPreview> {
  await delay(300)
  const alert = MOCK_ALERTS.find((a) => a.id === alertId)
  if (!alert) throw new ApiError(404, 'alert not found')
  if (!alert.actions?.includes(action)) throw new ApiError(422, `${action} is not available for this alert`)
  if (action === 'dismiss' && alert.status === 'resolved') throw new ApiError(422, 'alert is already closed')
  if (action !== 'dismiss' && alert.target && MOCK_ADMIN_IDS.has(alert.target.userId)) {
    throw new ApiError(422, 'cannot moderate admins')
  }
  const requestId = `mock-req-${++mockSeq}`
  const nonce = `mock-nonce-${mockSeq}`
  const expiresAt = Date.now() + MOCK_TTL_MS
  mockRequests.set(requestId, { nonce, alertId, action, expiresAt })
  const t = alert.target
  const who = t ? (t.username ? `@${t.username}` : `user ${t.userId}`) : '?'
  return {
    requestId,
    nonce,
    expiresAt: new Date(expiresAt).toISOString(),
    alertId,
    action,
    headline: MOCK_HEADLINE[action],
    target: t ? `${who} · ${t.chatTitle ?? t.chatId} · msg ${t.messageId}` : '?',
    detail: MOCK_DETAIL[action],
    dryRun: true,
  }
}

// ---- voice + summary -----------------------------------------------------------

/**
 * Mock "speech": each recording yields the next command in this script, so every
 * intent can be demoed without a microphone. `{action}` = the alert's first action.
 */
const MOCK_VOICE_SCRIPT: { transcript: string; intent: VoiceIntent | 'action' }[] = [
  { transcript: 'summarize this', intent: 'summary' },
  { transcript: '{action} it', intent: 'action' },
  { transcript: 'next alert', intent: 'next' },
  { transcript: 'banana pancakes', intent: 'unknown' },
  { transcript: 'go back', intent: 'back' },
]
let mockVoiceTurn = 0

export async function mockVoice(alertId: string): Promise<VoiceResponse> {
  await delay(700)
  const alert = MOCK_ALERTS.find((a) => a.id === alertId)
  const step = MOCK_VOICE_SCRIPT[mockVoiceTurn++ % MOCK_VOICE_SCRIPT.length]
  // Cycle through the alert's actions so every voice verb gets demoed.
  const actions = alert?.actions ?? []
  const action = actions.length ? actions[mockVoiceTurn % actions.length] : undefined
  if (step.intent === 'action') {
    // Alerts without an action: the "command" is simply not understood.
    if (!action) return { transcript: 'fix it', intent: 'unknown', alertId }
    return { transcript: step.transcript.replace('{action}', action), intent: action, alertId }
  }
  return { transcript: step.transcript, intent: step.intent, alertId }
}

const mockSummaryAt = new Map<string, string>()
const MOCK_LABELS: Record<string, RiskLabel> = { 'mock-1': 'spam', 'mock-2': 'toxic', 'mock-3': 'scam', 'mock-4': 'ok' }

export async function mockSummary(alertId: string, refresh: boolean): Promise<SummaryResponse> {
  await delay(900)
  const alert = MOCK_ALERTS.find((a) => a.id === alertId)
  if (!alert) throw new ApiError(404, 'alert not found')
  const cached = mockSummaryAt.get(alertId)
  const generatedAt = !cached || refresh ? new Date().toISOString() : cached
  mockSummaryAt.set(alertId, generatedAt)
  const label = MOCK_LABELS[alertId] ?? 'unclear'
  const summary = `Mock label: ${alert.title}`.slice(0, 200)
  return { alertId, label, summary, source: cached && !refresh ? 'cache' : 'ai', generatedAt }
}

export async function mockConfirm(requestId: string, nonce: string): Promise<ActionConfirmResult> {
  await delay(600)
  const req = mockRequests.get(requestId)
  if (!req) throw new ApiError(404, 'action request not found')
  if (req.nonce !== nonce) throw new ApiError(403, 'invalid nonce')
  mockRequests.delete(requestId)
  if (Date.now() > req.expiresAt) throw new ApiError(410, 'action request expired')
  const alert = MOCK_ALERTS.find((a) => a.id === req.alertId)
  const simulated = req.action === 'dismiss' ? null : /^9999\d*([1-5]\d\d)$/.exec(String(alert?.target?.messageId ?? ''))
  if (simulated) {
    const status = Number(simulated[1])
    return {
      requestId,
      alertId: req.alertId,
      action: req.action,
      status: 'failed',
      message: `mock: Telegram rejected the request (${status})`,
      providerStatus: status,
      dryRun: true,
      alertStatus: alert?.status ?? 'open',
    }
  }
  // Same transitions as the server: mute → acked (message stays), the rest close the flag.
  if (alert) alert.status = req.action === 'mute' ? 'acked' : 'resolved'
  return {
    requestId,
    alertId: req.alertId,
    action: req.action,
    status: 'succeeded',
    message: `mock: ${req.action} accepted`,
    providerStatus: null,
    dryRun: true,
    alertStatus: alert?.status ?? 'open',
  }
}
