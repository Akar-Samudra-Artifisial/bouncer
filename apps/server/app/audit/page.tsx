import { AuditTable } from './audit-table'

export const metadata = { title: 'Bouncer · audit log' }

export default function AuditPage() {
  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Audit log</h1>
      <p>Webhooks, pairing and write actions, newest first.</p>
      <AuditTable />
    </main>
  )
}
