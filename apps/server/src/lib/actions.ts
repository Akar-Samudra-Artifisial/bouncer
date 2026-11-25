import { ACTION_KINDS, type ActionConfirmResult, type ActionKind, type ActionPreview, type AlertStatus, type AlertTarget, type TelegramTarget } from '@bouncer/shared'
import { and, count, eq, gt, sql } from 'drizzle-orm'
import { getDb, schema } from '@/db/client'
import { audit } from './audit'
import { randomSecret, sha256Hex } from './crypto'
import { setAlertStatus } from './ingest'
import {
  type MemberStatus,
  moderationRequest,
  networkFailure,
  publicMessage,
  scrubSecrets,
  TELEGRAM_LABEL,
  telegramMemberStatus,
  telegramModerate,
  type ProviderOutcome,
} from './providers'
import { allowedChats, csv } from './telegram'

const RATE_WINDOW_MS = 10 * 60_000
const RATE_LIMIT = 10
/** Advisory lock namespace (two-int form) for the per-device intent count + insert. */
const ACTION_RATE_LOCK = 0x504c_02

/** Nonce lifetime: 60 s; `ACTION_NONCE_TTL_SECONDS` (1–300) overrides outside production tests. */
function nonceTtlMs(): number {
  const n = Number(process.env.ACTION_NONCE_TTL_SECONDS ?? '60')
  return (Number.isFinite(n) && n >= 1 && n <= 300 ? n : 60) * 1000
}

export function isDryRun(): boolean {
  return process.env.ACTIONS_DRY_RUN === '1'
}

function isTelegramTarget(t: AlertTarget | null): t is TelegramTarget {
  return (
    t !== null &&
    Number.isSafeInteger((t as TelegramTarget).chatId) &&
    Number.isSafeInteger((t as TelegramTarget).messageId) &&
    Number.isSafeInteger((t as TelegramTarget).userId)
  )
}

type ProviderAction = Exclude<ActionKind, 'dismiss'>

interface AlertForAction {
  id: string
  source: string
  kind: string
  title: string
  status: string
  target: AlertTarget | null
}

type Check = { ok: true } | { ok: false; status: 403 | 422; error: string }

/** Source matrix: `dismiss` works on any open alert; delete/mute/ban need a Telegram message target. */
function checkMatrix(alert: AlertForAction, action: ActionKind): Check {
  if (action === 'dismiss') {
    return alert.status === 'resolved' ? { ok: false, status: 422, error: 'alert is already closed' } : { ok: true }
  }
  if (alert.source !== 'telegram') return { ok: false, status: 422, error: `${action} is only available for Telegram alerts` }
  if (!isTelegramTarget(alert.target)) return { ok: false, status: 422, error: 'alert has no Telegram message target' }
  // restrictChatMember only works in supergroups (chat ids of the form -100…).
  if (action === 'mute' && !String(alert.target.chatId).startsWith('-100')) {
    return { ok: false, status: 422, error: 'mute needs a supergroup' }
  }
  return { ok: true }
}

/** Server-side allowlist: provider actions only in chats listed in `TELEGRAM_ALLOWED_CHATS`. */
function checkAllowlist(alert: AlertForAction, action: ActionKind): Check {
  if (action === 'dismiss') return { ok: true }
  const t = alert.target
  if (!isTelegramTarget(t)) return { ok: false, status: 422, error: 'alert has no action target' }
  return allowedChats().has(String(t.chatId))
    ? { ok: true }
    : { ok: false, status: 403, error: `chat ${t.chatId} is not in the action allowlist` }
}

/** Actions the glasses may offer for an alert (matrix + allowlist). */
export function availableActions(alert: AlertForAction): ActionKind[] {
  return ACTION_KINDS.filter((a) => checkMatrix(alert, a).ok && checkAllowlist(alert, a).ok)
}

const HEADLINE: Record<ActionKind, string> = {
  delete: 'Delete message',
  mute: 'Mute user 1 hour',
  ban: 'Ban user',
  dismiss: 'Dismiss flag',
}

const DETAIL: Record<ActionKind, string> = {
  delete: 'Deletes the flagged message from the group.',
  mute: 'Stops the author from sending messages for 1 hour.',
  ban: 'Removes the author from the group and blocks rejoining.',
  dismiss: 'Closes the flag without touching Telegram.',
}

function describe(alert: AlertForAction, action: ActionKind): Pick<ActionPreview, 'headline' | 'target' | 'detail'> {
  const t = isTelegramTarget(alert.target) ? alert.target : null
  const who = t ? (t.username ? `@${t.username}` : `user ${t.userId}`) : '?'
  return {
    headline: HEADLINE[action],
    target: t ? `${who} · ${t.chatTitle ?? t.chatId} · msg ${t.messageId}` : alert.title,
    detail: `${DETAIL[action]} “${alert.title}”`,
  }
}

export type IntentResult = { ok: true; preview: ActionPreview } | { ok: false; status: 403 | 404 | 422 | 429 | 502; error: string }

export type MemberCheck = { ok: true; status: MemberStatus } | { ok: false; outcome: ProviderOutcome }

/** Dry-run getChatMember: user ids in `DRY_RUN_ADMIN_IDS` (csv) are administrators, everyone else a member. */
function fakeMemberStatus(userId: number): MemberCheck {
  return { ok: true, status: csv('DRY_RUN_ADMIN_IDS').includes(String(userId)) ? 'administrator' : 'member' }
}

/** getChatMember, or the fake under `ACTIONS_DRY_RUN=1`. */
export function lookupMember(chatId: number, userId: number): Promise<MemberCheck> {
  return isDryRun() ? Promise.resolve(fakeMemberStatus(userId)) : telegramMemberStatus(chatId, userId)
}

/** Chat owners and admins are never moderated from the glasses (fails closed if Telegram cannot answer). */
async function checkTargetMember(target: TelegramTarget): Promise<{ ok: true } | { ok: false; status: 422 | 502; error: string; detail?: string }> {
  const member = await lookupMember(target.chatId, target.userId)
  if (!member.ok) {
    return { ok: false, status: 502, error: `could not check the target member: ${member.outcome.message}`, detail: member.outcome.detail }
  }
  if (member.status === 'creator' || member.status === 'administrator') {
    return { ok: false, status: 422, error: 'cannot moderate admins' }
  }
  return { ok: true }
}

export async function createIntent(deviceId: string, alertId: string, action: ActionKind): Promise<IntentResult> {
  const db = getDb()
  const a = schema.alerts
  const actor = `device:${deviceId}`
  const [alert] = await db
    .select({ id: a.id, source: a.source, kind: a.kind, title: a.title, status: a.status, target: a.target })
    .from(a)
    .where(eq(a.id, alertId))
    .limit(1)
  if (!alert) return { ok: false, status: 404, error: 'alert not found' }

  const denied = [checkMatrix(alert, action), checkAllowlist(alert, action)].find((c) => !c.ok)
  if (denied && !denied.ok) {
    await audit({ event: 'action.denied', actor, alertId, detail: { action, reason: denied.error } })
    return { ok: false, status: denied.status, error: denied.error }
  }

  if (action !== 'dismiss' && isTelegramTarget(alert.target)) {
    const member = await checkTargetMember(alert.target)
    if (!member.ok) {
      await audit({
        event: 'action.denied',
        actor,
        alertId,
        detail: { action, reason: member.error, ...(member.detail ? { providerDetail: member.detail } : {}) },
      })
      return { ok: false, status: member.status, error: member.error }
    }
  }

  const r = schema.actionRequests
  const nonce = randomSecret(24)
  const expiresAt = new Date(Date.now() + nonceTtlMs())
  // Count + insert under a per-device advisory lock: parallel intents cannot exceed the limit.
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ACTION_RATE_LOCK}::int, hashtext(${deviceId}))`)
    const [{ n }] = await tx
      .select({ n: count() })
      .from(r)
      .where(and(eq(r.deviceId, deviceId), gt(r.createdAt, new Date(Date.now() - RATE_WINDOW_MS))))
    if (n >= RATE_LIMIT) return null
    const [inserted] = await tx
      .insert(r)
      .values({ alertId, deviceId, action, nonceHash: sha256Hex(nonce), expiresAt })
      .returning({ id: r.id })
    return inserted
  })
  if (!row) {
    await audit({ event: 'action.denied', actor, alertId, detail: { action, reason: 'rate limited' } })
    return { ok: false, status: 429, error: `rate limit: ${RATE_LIMIT} actions per 10 minutes per device` }
  }
  const info = describe(alert, action)
  await audit({ event: 'action.intent', actor, alertId, detail: { requestId: row.id, action, target: info.target } })
  return {
    ok: true,
    preview: {
      requestId: row.id,
      nonce,
      expiresAt: expiresAt.toISOString(),
      alertId,
      action,
      ...info,
      dryRun: isDryRun(),
    },
  }
}

export type ConfirmResult =
  | { ok: true; result: ActionConfirmResult }
  | { ok: false; status: 403 | 404 | 409 | 410; error: string }

/**
 * Dry-run stand-in for the provider. A message id that starts with `9999` and ends in an
 * HTTP status (e.g. `9999…400`) simulates that provider error, so the failure path is
 * testable without a bot token. A message id starting with `8888` simulates a network error whose
 * raw text contains the request URL (with the bot token), exercising the same scrubbing as a real
 * failure. Anything else succeeds.
 */
function fakeProvider(action: ProviderAction, target: AlertTarget | null): ProviderOutcome {
  const label = TELEGRAM_LABEL[action]
  const id = isTelegramTarget(target) ? String(target.messageId) : ''
  if (isTelegramTarget(target) && id.startsWith('8888')) {
    const { method } = moderationRequest(action, target, Math.floor(Date.now() / 1000))
    const token = process.env.TELEGRAM_BOT_TOKEN ?? '123456789:dry-run-placeholder-token'
    return networkFailure(label, new Error(`connect ECONNREFUSED https://api.telegram.org/bot${token}/${method}`))
  }
  const simulated = /^9999\d*([1-5]\d\d)$/.exec(id)
  if (simulated) {
    const status = Number(simulated[1])
    return { ok: false, status, message: publicMessage(label, status, false), detail: 'dry run: simulated provider error' }
  }
  return { ok: true, status: null, message: `dry run: ${action} not sent to Telegram` }
}

async function runProvider(action: ActionKind, target: AlertTarget | null): Promise<ProviderOutcome> {
  if (action === 'dismiss') return { ok: true, status: null, message: 'dismissed' }
  if (isDryRun()) return fakeProvider(action, target)
  if (isTelegramTarget(target)) return telegramModerate(action, target)
  return { ok: false, status: null, message: 'alert target no longer matches the action' }
}

export async function confirmIntent(deviceId: string, requestId: string, nonce: string): Promise<ConfirmResult> {
  const db = getDb()
  const r = schema.actionRequests
  const actor = `device:${deviceId}`
  const nonceHash = sha256Hex(nonce)

  // Single atomic transition: only one confirm can win pending → confirmed.
  const [won] = await db
    .update(r)
    .set({ status: 'confirmed' })
    .where(
      and(
        eq(r.id, requestId),
        eq(r.deviceId, deviceId),
        eq(r.nonceHash, nonceHash),
        eq(r.status, 'pending'),
        gt(r.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: r.id, alertId: r.alertId, action: r.action })

  if (!won) {
    const [row] = await db
      .select({ status: r.status, nonceHash: r.nonceHash, expiresAt: r.expiresAt, alertId: r.alertId })
      .from(r)
      .where(and(eq(r.id, requestId), eq(r.deviceId, deviceId)))
      .limit(1)
    if (!row) return { ok: false, status: 404, error: 'action request not found' }
    if (row.nonceHash !== nonceHash) {
      await audit({ event: 'action.denied', actor, alertId: row.alertId, detail: { requestId, reason: 'bad nonce' } })
      return { ok: false, status: 403, error: 'invalid nonce' }
    }
    if (row.status === 'pending' || row.status === 'expired') {
      await db
        .update(r)
        .set({ status: 'expired' })
        .where(and(eq(r.id, requestId), eq(r.status, 'pending')))
      return { ok: false, status: 410, error: 'confirmation expired, start the action again' }
    }
    return { ok: false, status: 409, error: `action request already ${row.status}` }
  }

  const action = won.action as ActionKind
  const dryRun = isDryRun()
  let alertStatus: AlertStatus = 'open'
  let outcome: ProviderOutcome | null = null
  let result: ActionConfirmResult | null = null

  // From here the request is `confirmed`; the finally block always records a terminal status.
  try {
    await audit({ event: 'action.confirm', actor, alertId: won.alertId, detail: { requestId, action } })

    const a = schema.alerts
    const [alert] = await db
      .select({ id: a.id, source: a.source, kind: a.kind, title: a.title, status: a.status, target: a.target })
      .from(a)
      .where(eq(a.id, won.alertId))
      .limit(1)
    if (!alert) {
      outcome = { ok: false, status: null, message: 'alert no longer exists' }
    } else {
      alertStatus = alert.status as AlertStatus
      // Re-check: the allowlist/env or the alert may have changed since the intent.
      const denied = [checkMatrix(alert, action), checkAllowlist(alert, action)].find((c) => !c.ok)
      if (denied && !denied.ok) {
        outcome = { ok: false, status: null, message: `no longer allowed: ${denied.error}` }
        await audit({ event: 'action.denied', actor, alertId: alert.id, detail: { requestId, action, reason: denied.error } })
      } else {
        outcome = await runProvider(action, alert.target)
        if (outcome.ok) {
          // Mute leaves the message in place (it can still be deleted): acked. Others close the flag.
          alertStatus = action === 'mute' ? 'acked' : 'resolved'
          await setAlertStatus(alert.id, alertStatus)
        }
      }
    }
    result = toResult(requestId, won.alertId, action, outcome, dryRun, alertStatus)
  } catch (err) {
    const reason = scrubSecrets(err instanceof Error ? err.message : String(err))
    console.error(`[bouncer] confirm ${requestId} failed:`, reason)
    const message = outcome?.ok
      ? 'the provider accepted the action, but the server failed to record it'
      : 'internal error while running the action'
    outcome = { ok: false, status: outcome?.status ?? null, message, detail: reason }
    result = toResult(requestId, won.alertId, action, outcome, dryRun, alertStatus)
  } finally {
    const final = result ?? toResult(requestId, won.alertId, action, null, dryRun, alertStatus)
    await db
      .update(r)
      .set({ status: final.status, result: final })
      .where(and(eq(r.id, requestId), eq(r.status, 'confirmed')))
  }

  await audit({
    event: `action.${result.status}`,
    actor,
    alertId: won.alertId,
    detail: {
      requestId,
      action,
      providerStatus: result.providerStatus,
      message: result.message,
      ...(outcome?.detail ? { providerDetail: outcome.detail.slice(0, 200) } : {}),
      dryRun,
    },
  })
  return { ok: true, result }
}

export type CancelResult = { ok: true } | { ok: false; status: 403 | 404 | 409; error: string }

/**
 * Cancel on the Confirm screen: burns the pending request (status `expired`, so its nonce can never
 * be confirmed) and records `action.cancel`. Needs the same one-time nonce as confirm.
 */
export async function cancelIntent(deviceId: string, requestId: string, nonce: string): Promise<CancelResult> {
  const db = getDb()
  const r = schema.actionRequests
  const actor = `device:${deviceId}`
  const nonceHash = sha256Hex(nonce)
  const [won] = await db
    .update(r)
    .set({ status: 'expired' })
    .where(and(eq(r.id, requestId), eq(r.deviceId, deviceId), eq(r.nonceHash, nonceHash), eq(r.status, 'pending')))
    .returning({ alertId: r.alertId, action: r.action })
  if (won) {
    await audit({ event: 'action.cancel', actor, alertId: won.alertId, detail: { requestId, action: won.action } })
    return { ok: true }
  }
  const [row] = await db
    .select({ status: r.status, nonceHash: r.nonceHash })
    .from(r)
    .where(and(eq(r.id, requestId), eq(r.deviceId, deviceId)))
    .limit(1)
  if (!row) return { ok: false, status: 404, error: 'action request not found' }
  // Bad nonce: plain 403, not audited (cancel changes nothing, and an unbounded retry loop must not
  // flood the audit log). Bad nonces on confirm are still audited there.
  if (row.nonceHash !== nonceHash) return { ok: false, status: 403, error: 'invalid nonce' }
  return { ok: false, status: 409, error: `action request already ${row.status}` }
}

function toResult(
  requestId: string,
  alertId: string,
  action: ActionKind,
  outcome: ProviderOutcome | null,
  dryRun: boolean,
  alertStatus: AlertStatus,
): ActionConfirmResult {
  return {
    requestId,
    alertId,
    action,
    status: outcome?.ok ? 'succeeded' : 'failed',
    message: outcome?.message ?? 'internal error while running the action',
    providerStatus: outcome?.status ?? null,
    dryRun,
    alertStatus,
  }
}
