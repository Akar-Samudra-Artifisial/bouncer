import type { TelegramTarget } from '@bouncer/shared'
import { obj, str } from './payload'

/** Outcome of a provider write. Provider/network errors are data here, never thrown. */
export interface ProviderOutcome {
  ok: boolean
  /** HTTP status from the provider; null on network error / missing config / dry run. */
  status: number | null
  /** Safe for clients: generic text derived from the status code only. */
  message: string
  /** Provider's own error text, truncated; audit log only, never sent to clients. */
  detail?: string
}

const TIMEOUT_MS = 10_000
const DETAIL_MAX = 200

/** Client-facing message for a provider result, from the status code alone. */
export function publicMessage(label: string, status: number | null, ok: boolean): string {
  if (ok) return `${label}: ok${status === null ? '' : ` (${status})`}`
  if (status === null) return `${label}: provider unreachable or not configured`
  if (status === 401 || status === 403) return `${label}: provider refused (${status}): missing permission or not allowed`
  if (status === 404) return `${label}: not found at provider (404)`
  if (status === 409 || status === 422) return `${label}: provider rejected the request in the current state (${status})`
  if (status === 429) return `${label}: provider rate limit (429), try again later`
  if (status >= 500) return `${label}: provider error (${status}), try again later`
  return `${label}: provider returned ${status}`
}

async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const body = obj(JSON.parse(text))
    const msg = str(body.message) ?? str(body.detail)
    if (msg) return msg.slice(0, DETAIL_MAX)
  } catch {
    // Non-JSON error body: fall through to the raw text.
  }
  return text.slice(0, DETAIL_MAX) || res.statusText || 'request failed'
}

/** Provider HTTP call with timeout and status → safe message mapping (used by the H2 Bot API wiring). */
export async function call(url: string, init: RequestInit, label: string): Promise<ProviderOutcome> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, status: null, message: publicMessage(label, null, false), detail: `network error: ${reason}`.slice(0, DETAIL_MAX) }
  }
  if (res.ok) return { ok: true, status: res.status, message: publicMessage(label, res.status, true) }
  return { ok: false, status: res.status, message: publicMessage(label, res.status, false), detail: await errorDetail(res) }
}

export const TELEGRAM_LABEL: Record<'delete' | 'mute' | 'ban', string> = {
  delete: 'Telegram deleteMessage',
  mute: 'Telegram restrictChatMember',
  ban: 'Telegram banChatMember',
}

/**
 * Telegram Bot API moderation call. TODO H2: wire `deleteMessage` / `restrictChatMember` /
 * `banChatMember` through `call()`; until then every non-dry-run call fails without a request.
 */
export async function telegramModerate(action: 'delete' | 'mute' | 'ban', _target: TelegramTarget): Promise<ProviderOutcome> {
  const label = TELEGRAM_LABEL[action]
  return { ok: false, status: null, message: publicMessage(label, null, false), detail: 'Telegram provider not wired yet (H2)' }
}
