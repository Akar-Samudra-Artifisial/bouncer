import { safeEqual } from '@/lib/crypto'
import { json, notConfigured, readBodyLimited } from '@/lib/http'
import { ingestAlert, ingestHttpStatus } from '@/lib/ingest'
import { parseJson } from '@/lib/payload'
import { normalizeTelegram } from '@/lib/telegram'
import { handlePairCommand, parsePairCommand } from '@/lib/tgpair'

/**
 * Telegram Bot API webhook (`setWebhook` with `secret_token`). Telegram sends the token in
 * `X-Telegram-Bot-Api-Secret-Token`. Ignored updates answer 200 so Telegram does not retry;
 * they are not audited (every group message would otherwise land in the audit log).
 */
export async function POST(request: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!secret) return notConfigured('TELEGRAM_WEBHOOK_SECRET')

  const header = request.headers.get('x-telegram-bot-api-secret-token')
  if (!header || !safeEqual(header, secret)) return json({ error: 'invalid secret token' }, 401)

  const body = await readBodyLimited(request)
  if (body === null) return json({ error: 'payload too large' }, 413)
  const update = parseJson(body)
  if (!update) return json({ error: 'body is not a JSON object' }, 400)

  // Private `/pair CODE` from a group admin: approve the glasses, reply via the webhook response.
  const pair = parsePairCommand(update)
  if (pair) return json(await handlePairCommand(pair), 200)

  const normalized = normalizeTelegram(update)
  if (!normalized.ok) {
    if (normalized.reason === 'missing update_id') return json({ error: normalized.reason }, 400)
    return json({ ignored: true, reason: normalized.reason }, 200)
  }

  const result = await ingestAlert('telegram', normalized.deliveryId, normalized.alert, normalized.payload)
  return json(result, ingestHttpStatus(result))
}
