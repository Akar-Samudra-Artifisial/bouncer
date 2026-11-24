// Shared contract between the Bouncer server and the G2 glasses app.

export const ALERT_SOURCES = ['telegram'] as const
export type AlertSource = (typeof ALERT_SOURCES)[number]

export const ALERT_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number]

export const ALERT_STATUSES = ['open', 'acked', 'resolved', 'muted'] as const
export type AlertStatus = (typeof ALERT_STATUSES)[number]

export interface Alert {
  /** Stable UUID. */
  id: string
  /**
   * Monotonic sequence used as the polling cursor (`GET /api/alerts?since=`).
   * A status change (e.g. dismiss from the glasses) moves the alert to a new,
   * higher `seq`, so the SAME `id` can be returned again with the new `status`:
   * clients must upsert by `id`, never append.
   */
  seq: number
  source: AlertSource
  /** Source-specific kind: `telegram.report`, `telegram.keyword`, `telegram.link`. */
  kind: string
  severity: AlertSeverity
  status: AlertStatus
  /** `@username: <message text>` (truncated). */
  title: string
  /** Flag reason(s), reporter and the message text (≤ 500 chars). */
  summary: string
  /** Group title (or chat id when the group has no title). */
  scope: string | null
  url: string | null
  /** ISO-8601 timestamp. */
  createdAt: string
  /** Provider object the write actions operate on; null when the alert has none. */
  target?: AlertTarget | null
  /** Write actions the server will accept an intent for (source matrix + allowlist). */
  actions?: ActionKind[]
}

/**
 * Flagged Telegram message. Ids are numbers: Bot API chat/user ids fit in 52 bits,
 * so a JS number (double) holds them exactly.
 */
export interface TelegramTarget {
  chatId: number
  messageId: number
  /** Author of the flagged message (the moderation target). */
  userId: number
  username?: string
  chatTitle?: string
}

export type AlertTarget = TelegramTarget

export interface AlertsResponse {
  /** Ascending `seq`; may contain alerts seen before (status changed) — upsert by `id`. */
  alerts: Alert[]
  /** Highest `seq` known to the server; pass back as `since` on the next poll. */
  cursor: number
}

// ---------------------------------------------------------------------------
// Write actions: intent → preview + nonce → confirm.

/**
 * Moderation actions. `delete`/`mute`/`ban` call the Telegram Bot API (wired in H2; until then
 * only `ACTIONS_DRY_RUN=1` succeeds); `dismiss` has no provider call and only closes the alert.
 */
export const ACTION_KINDS = ['delete', 'mute', 'ban', 'dismiss'] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

export function isActionKind(value: unknown): value is ActionKind {
  return typeof value === 'string' && (ACTION_KINDS as readonly string[]).includes(value)
}

/** Error body for every non-2xx JSON response. */
export interface ApiError {
  error: string
}

/** `POST /api/actions/intent` body. */
export interface ActionIntentRequest {
  alertId: string
  action: ActionKind
}

/** `POST /api/actions/intent` 201 response: what will happen, plus a one-time nonce. */
export interface ActionPreview {
  requestId: string
  /** One-time secret to echo back in confirm; valid until `expiresAt` (60 s). */
  nonce: string
  expiresAt: string
  alertId: string
  action: ActionKind
  /** Short line for the glasses, e.g. `Delete message`. */
  headline: string
  /** Target in human form, e.g. `@spammer · Group name · msg 123`. */
  target: string
  /** One or two sentences describing the effect. */
  detail: string
  /** True when the server runs with `ACTIONS_DRY_RUN=1` (provider is not called). */
  dryRun: boolean
}

/** `POST /api/actions/confirm` body. */
export interface ActionConfirmRequest {
  requestId: string
  nonce: string
}

export const ACTION_REQUEST_STATUSES = ['pending', 'confirmed', 'expired', 'failed', 'succeeded'] as const
export type ActionRequestStatus = (typeof ACTION_REQUEST_STATUSES)[number]

/**
 * `POST /api/actions/confirm` 200 response (provider errors are `failed`, not HTTP errors).
 * `failed` also covers an allowlist/matrix re-check at confirm time and internal errors;
 * `message` is generic text safe to display (provider details stay in the audit log).
 */
export interface ActionConfirmResult {
  requestId: string
  alertId: string
  action: ActionKind
  status: 'succeeded' | 'failed'
  message: string
  /** HTTP status from the Telegram Bot API; null on dry run, dismiss or network error. */
  providerStatus: number | null
  dryRun: boolean
  /** Alert status after the action (`resolved` after a successful action). */
  alertStatus: AlertStatus
}

// ---------------------------------------------------------------------------
// Device pairing.

/** `POST /api/pair/start` 201 response. Show `code` on the glasses; keep `pollSecret` private. */
export interface PairStartResponse {
  /** 6 characters, A–Z/2–9 without ambiguous glyphs. */
  code: string
  pollSecret: string
  expiresAt: string
  pollIntervalMs: number
}

/** `GET /api/pair/status` (Authorization: Bearer <pollSecret>) 200 response. */
export type PairStatusResponse =
  | { status: 'pending'; expiresAt: string }
  /** Returned exactly once; store `token` and use it as the device bearer token. */
  | { status: 'approved'; deviceId: string; deviceName: string; token: string }
  | { status: 'claimed' }
  | { status: 'expired' }

// ---------------------------------------------------------------------------
// Voice commands (H4) and AI summaries (H5).

/**
 * What a spoken command maps to. Action intents are NEVER executed by `/api/voice`:
 * the glasses must still call `POST /api/actions/intent` and show the Confirm screen.
 * TODO H3: voice phrases for `mute`/`ban`.
 */
export const VOICE_INTENTS = ['delete', 'dismiss', 'next', 'back', 'inbox', 'summary', 'unknown'] as const
export type VoiceIntent = (typeof VOICE_INTENTS)[number]

/**
 * `POST /api/voice[?alertId=&sampleRate=]` 200 response.
 * Body = audio: raw PCM s16le mono (`Content-Type: audio/pcm` or `application/octet-stream`,
 * `sampleRate` default 16000) or a container (`audio/wav`, `audio/webm`, `audio/ogg`, `audio/mpeg`, `audio/mp4`).
 */
export interface VoiceResponse {
  /** Transcript (English, ≤ 200 chars). */
  transcript: string
  intent: VoiceIntent
  /** Echo of the `alertId` context, when given and the alert exists. */
  alertId?: string
}

export type SummarySource = 'ai' | 'cache' | 'fallback'

/**
 * Advisory risk label from the AI (on demand, when Detail opens). It is display-only:
 * the server's action matrix alone decides `Alert.actions`.
 */
export const RISK_LABELS = ['spam', 'scam', 'toxic', 'ok', 'unclear'] as const
export type RiskLabel = (typeof RISK_LABELS)[number]

/** `POST /api/alerts/{id}/summary[?refresh=1]` 200 response. */
export interface SummaryResponse {
  alertId: string
  /** `unclear` whenever the AI is off, unavailable, or its output failed validation. */
  label: RiskLabel
  /** Why the label was given: plain text, ≤ 200 characters. */
  summary: string
  /** `ai` = generated now, `cache` = stored AI summary, `fallback` = heuristic (AI unavailable). */
  source: SummarySource
  /** When the AI summary was generated; null for `fallback`. */
  generatedAt: string | null
}

// ---------------------------------------------------------------------------
// Audit log.

export interface AuditEntry {
  id: number
  /** e.g. `action.intent`, `action.succeeded`, `pair.approved`, `webhook.telegram`. */
  event: string
  actor: string | null
  alertId: string | null
  detail: Record<string, unknown>
  createdAt: string
}

/** `GET /api/audit?limit=&before=` response, newest first. A device token sees only its own entries. */
export interface AuditResponse {
  entries: AuditEntry[]
  /** Pass as `before` for the next (older) page; null when exhausted. */
  nextBefore: number | null
}
