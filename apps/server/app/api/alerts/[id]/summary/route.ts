import { RISK_LABELS, type RiskLabel, type SummaryResponse, type SummarySource } from '@bouncer/shared'
import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '@/db/client'
import { audit } from '@/lib/audit'
import { authenticateDevice } from '@/lib/auth'
import { corsHeaders, isUuid, json, preflight } from '@/lib/http'
import { reserveQuotaChecked } from '@/lib/quota'
import { aiConfigured, aiEnabled, fallbackRisk, generateRisk, mockAiOutput, riskFromModelText, SUMMARY_MODEL } from '@/lib/summary'

export const maxDuration = 30

/** AI generations (first time or `?refresh=1`) per device per 10 minutes. */
const SUMMARY_LIMIT = 20
const SUMMARY_WINDOW_MS = 10 * 60_000
/** AI generations across all devices per hour (the cache is global, so is the LLM spend). */
const SUMMARY_GLOBAL_LIMIT = 100
const SUMMARY_GLOBAL_WINDOW_MS = 60 * 60_000
/** `?refresh=1` on a label younger than this returns the cached one. */
const REFRESH_COOLDOWN_MS = 60_000

function storedLabel(value: string | null): RiskLabel | null {
  return value && (RISK_LABELS as readonly string[]).includes(value) ? (value as RiskLabel) : null
}

export function OPTIONS(request: Request) {
  return preflight(request)
}

/**
 * → 200 SummaryResponse: on-demand AI risk label (cached, fresh, or heuristic fallback).
 * The label is advisory text only; it never changes `Alert.actions` (server action matrix).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const cors = { ...corsHeaders(request), 'Cache-Control': 'no-store' }
  const device = await authenticateDevice(request)
  if (!device) return json({ error: 'unauthorized' }, 401, cors)

  const { id } = await ctx.params
  if (!isUuid(id)) return json({ error: 'alert id must be a uuid' }, 400, cors)
  const refresh = new URL(request.url).searchParams.get('refresh') === '1'

  const db = getDb()
  const a = schema.alerts
  const [alert] = await db
    .select({
      id: a.id,
      source: a.source,
      kind: a.kind,
      severity: a.severity,
      status: a.status,
      title: a.title,
      summary: a.summary,
      scope: a.scope,
      aiSummary: a.aiSummary,
      aiLabel: a.aiLabel,
      aiSummaryAt: a.aiSummaryAt,
    })
    .from(a)
    .where(eq(a.id, id))
    .limit(1)
  if (!alert) return json({ error: 'alert not found' }, 404, cors)

  const actor = `device:${device.deviceId}`
  const cachedLabel = storedLabel(alert.aiLabel)
  const cached: SummaryResponse | null =
    alert.aiSummary && alert.aiSummaryAt && cachedLabel
      ? { alertId: id, label: cachedLabel, summary: alert.aiSummary, source: 'cache', generatedAt: alert.aiSummaryAt.toISOString() }
      : null
  const respond = async (body: SummaryResponse, reason?: string) => {
    await audit({
      event: 'alert.summary',
      actor,
      alertId: id,
      detail: { source: body.source, label: body.label, refresh, ...(reason ? { reason } : {}) },
    })
    return json(body, 200, cors)
  }
  const fallback = (reason: string) => {
    const risk = fallbackRisk(alert)
    return respond(cached ?? { alertId: id, label: risk.label, summary: risk.reason, source: 'fallback', generatedAt: null }, reason)
  }

  if (cached && !refresh) return respond(cached)
  if (cached && alert.aiSummaryAt && Date.now() - alert.aiSummaryAt.getTime() < REFRESH_COOLDOWN_MS) {
    return respond(cached, 'refresh cooldown')
  }

  if (!aiEnabled()) return fallback('ai disabled')
  const mockText = mockAiOutput(request)
  if (mockText === null && !aiConfigured()) return fallback('ai not configured')

  const quota = await reserveQuotaChecked(
    device.deviceId,
    'summary.request',
    { limit: SUMMARY_LIMIT, windowMs: SUMMARY_WINDOW_MS },
    { limit: SUMMARY_GLOBAL_LIMIT, windowMs: SUMMARY_GLOBAL_WINDOW_MS },
    { refresh },
    id,
  )
  if (quota !== 'ok') {
    if (refresh) {
      const error =
        quota === 'device'
          ? `rate limit: ${SUMMARY_LIMIT} AI labels per 10 minutes per device`
          : `rate limit: ${SUMMARY_GLOBAL_LIMIT} AI labels per hour on this server`
      return json({ error }, 429, cors)
    }
    return fallback(`rate limited (${quota})`)
  }

  const result = mockText !== null ? riskFromModelText(mockText) : await generateRisk(alert)
  if (!result.ok) {
    console.error(`[bouncer] risk label ${id} failed: ${result.message}`)
    return fallback(result.message.slice(0, 80))
  }

  const now = new Date()
  // Only cache if the status is unchanged since we read it (a status change clears the cache).
  await db
    .update(a)
    .set({ aiSummary: result.risk.reason, aiLabel: result.risk.label, aiSummaryAt: now })
    .where(and(eq(a.id, id), eq(a.status, alert.status)))
  const source: SummarySource = 'ai'
  return respond(
    { alertId: id, label: result.risk.label, summary: result.risk.reason, source, generatedAt: now.toISOString() },
    mockText !== null ? 'mock' : `model ${SUMMARY_MODEL}`,
  )
}
