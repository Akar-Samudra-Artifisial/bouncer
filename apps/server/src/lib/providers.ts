import type { TelegramTarget } from '@bouncer/shared'
import { obj, str } from './payload'

/** Outcome of a provider write. Provider/network errors are data here, never thrown. */
export interface ProviderOutcome {
  ok: boolean
  /** HTTP status (Telegram `error_code` when present); null on network error / missing config / dry run. */
  status: number | null
  /** Safe for clients: generic text derived from the status code only. */
  message: string
  /** Provider's own error text, token-scrubbed and truncated; audit log only, never sent to clients. */
  detail?: string
}

const TIMEOUT_MS = 10_000
const DETAIL_MAX = 200
const API_BASE = 'https://api.telegram.org'
/** Bot API token shape (`<bot id>:<secret>`), as it appears inside request URLs. */
const TOKEN_PATTERN = /\d{3,}:[A-Za-z0-9_-]{10,}/g

/** Client-facing message for a provider result, from the status code alone. */
export function publicMessage(label: string, status: number | null, ok: boolean): string {
  if (ok) return `${label}: ok${status === null ? '' : ` (${status})`}`
  if (status === null) return `${label}: provider unreachable or not configured`
  if (status === 401 || status === 403) return `${label}: provider refused (${status}): missing permission or not allowed`
  if (status === 404) return `${label}: not found at provider (404)`
  if (status === 400) return `${label}: provider rejected the request (400)`
  if (status === 409 || status === 422) return `${label}: provider rejected the request in the current state (${status})`
  if (status === 429) return `${label}: provider rate limit (429), try again later`
  if (status >= 500) return `${label}: provider error (${status}), try again later`
  return `${label}: provider returned ${status}`
}

/** Removes the bot token (configured value and anything token-shaped) from text bound for logs/audit. */
export function scrubSecrets(text: string): string {
  const token = process.env.TELEGRAM_BOT_TOKEN
  let out = token ? text.split(token).join('<redacted>') : text
  out = out.replace(TOKEN_PATTERN, '<redacted>')
  return out.slice(0, DETAIL_MAX)
}

/** Outcome for a request that never got an HTTP response; the raw error is scrubbed before storing. */
export function networkFailure(label: string, err: unknown): ProviderOutcome {
  const reason = err instanceof Error ? err.message : String(err)
  return { ok: false, status: null, message: publicMessage(label, null, false), detail: scrubSecrets(`network error: ${reason}`) }
}

export interface TgResult {
  outcome: ProviderOutcome
  /** `result` field of a successful Bot API response. */
  result?: unknown
}

/**
 * POST a Bot API method as JSON. Telegram answers `{ok, result}` or `{ok:false, error_code, description}`;
 * the description goes to `detail` (scrubbed), clients only see `publicMessage`.
 */
export async function tgCall(method: string, params: Record<string, unknown>, label: string): Promise<TgResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    return { outcome: { ok: false, status: null, message: publicMessage(label, null, false), detail: 'TELEGRAM_BOT_TOKEN is not set' } }
  }
  let res: Response
  try {
    res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    return { outcome: networkFailure(label, err) }
  }
  const text = await res.text().catch(() => '')
  let body: Record<string, unknown> = {}
  try {
    body = obj(JSON.parse(text))
  } catch {
    // Non-JSON body (proxy error page etc.): handled below via the HTTP status.
  }
  if (res.ok && body.ok === true) {
    return { outcome: { ok: true, status: res.status, message: publicMessage(label, res.status, true) }, result: body.result }
  }
  const code = typeof body.error_code === 'number' ? body.error_code : res.status
  const description = str(body.description) ?? (text || res.statusText || 'request failed')
  return { outcome: { ok: false, status: code, message: publicMessage(label, code, false), detail: scrubSecrets(description) } }
}

export const TELEGRAM_LABEL: Record<'delete' | 'mute' | 'ban', string> = {
  delete: 'Telegram deleteMessage',
  mute: 'Telegram restrictChatMember',
  ban: 'Telegram banChatMember',
}

export const MUTE_SECONDS = 3600

/** Every ChatPermissions flag set to false: the member cannot post anything until `until_date`. */
const NO_PERMISSIONS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_react_to_messages: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
  can_edit_tag: false,
}

/** A message that is already gone counts as deleted (idempotent retry / deleted by another admin). */
const ALREADY_DELETED = /message to delete not found/i

/** Bot API params for a moderation action (exported for the dry-run provider and tests). */
export function moderationRequest(action: 'delete' | 'mute' | 'ban', target: TelegramTarget, nowSec: number) {
  if (action === 'delete') return { method: 'deleteMessage', params: { chat_id: target.chatId, message_id: target.messageId } }
  if (action === 'mute') {
    return {
      method: 'restrictChatMember',
      params: {
        chat_id: target.chatId,
        user_id: target.userId,
        permissions: NO_PERMISSIONS,
        use_independent_chat_permissions: true,
        until_date: nowSec + MUTE_SECONDS,
      },
    }
  }
  return { method: 'banChatMember', params: { chat_id: target.chatId, user_id: target.userId } }
}

/** Telegram Bot API moderation call: deleteMessage / restrictChatMember (1 h) / banChatMember. */
export async function telegramModerate(action: 'delete' | 'mute' | 'ban', target: TelegramTarget): Promise<ProviderOutcome> {
  const label = TELEGRAM_LABEL[action]
  const { method, params } = moderationRequest(action, target, Math.floor(Date.now() / 1000))
  const { outcome } = await tgCall(method, params, label)
  if (!outcome.ok && action === 'delete' && outcome.detail && ALREADY_DELETED.test(outcome.detail)) {
    return { ok: true, status: outcome.status, message: `${label}: message already deleted`, detail: outcome.detail }
  }
  return outcome
}

export type MemberStatus = 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked'
const MEMBER_STATUSES: readonly string[] = ['creator', 'administrator', 'member', 'restricted', 'left', 'kicked']

export function parseMemberStatus(result: unknown): MemberStatus | null {
  const status = str(obj(result).status)
  return status && MEMBER_STATUSES.includes(status) ? (status as MemberStatus) : null
}

/** getChatMember → the member's status, or the failed outcome when Telegram could not answer. */
export async function telegramMemberStatus(
  chatId: number,
  userId: number,
): Promise<{ ok: true; status: MemberStatus } | { ok: false; outcome: ProviderOutcome }> {
  const label = 'Telegram getChatMember'
  const { outcome, result } = await tgCall('getChatMember', { chat_id: chatId, user_id: userId }, label)
  if (!outcome.ok) return { ok: false, outcome }
  const status = parseMemberStatus(result)
  if (!status) return { ok: false, outcome: { ok: false, status: outcome.status, message: `${label}: unexpected response`, detail: 'missing ChatMember.status' } }
  return { ok: true, status }
}
