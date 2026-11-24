import { safeEqual } from '@/lib/crypto'
import { json, notConfigured } from '@/lib/http'
import { purgeExpired } from '@/lib/purge'

/**
 * Daily retention purge, scheduled in `vercel.json` (`crons`). Vercel Cron sends a GET with
 * `Authorization: Bearer <CRON_SECRET>` when the project has a `CRON_SECRET` env var.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return notConfigured('CRON_SECRET')

  const header = request.headers.get('authorization') ?? ''
  if (!safeEqual(header, `Bearer ${secret}`)) return json({ error: 'unauthorized' }, 401)

  return json(await purgeExpired(), 200)
}
