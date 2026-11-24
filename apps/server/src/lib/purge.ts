import { lt } from 'drizzle-orm'
import { getDb, schema } from '@/db/client'
import { audit } from './audit'

/** Flagged message text (alert title/summary/AI reason) is kept at most this long. */
export const RETENTION_DAYS = 7

export interface PurgeResult {
  deletedAlerts: number
  deletedPairingCodes: number
  cutoff: string
}

/**
 * Delete alerts (with their message text, AI label and action requests, via cascade) older than
 * the retention window, plus stale pairing codes. Audit rows survive with `alert_id` set null;
 * they never held message text. The purge audit entry holds counts only.
 */
export async function purgeExpired(now = new Date()): Promise<PurgeResult> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60_000)
  return getDb().transaction(async (tx) => {
    const alerts = await tx.delete(schema.alerts).where(lt(schema.alerts.createdAt, cutoff)).returning({ id: schema.alerts.id })
    const codes = await tx
      .delete(schema.pairingCodes)
      .where(lt(schema.pairingCodes.expiresAt, cutoff))
      .returning({ code: schema.pairingCodes.code })
    const result = { deletedAlerts: alerts.length, deletedPairingCodes: codes.length, cutoff: cutoff.toISOString() }
    await audit({ event: 'retention.purge', actor: 'cron', detail: { ...result, retentionDays: RETENTION_DAYS } }, tx)
    return result
  })
}
