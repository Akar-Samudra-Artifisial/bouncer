# Bouncer

Heads-up **Telegram group moderation** HUD for **Even Realities G2** glasses. Reported or suspicious
messages in your Telegram groups land on your glasses; you read them and act (delete, mute 1 hour, ban,
dismiss) behind an explicit confirm step, without reaching for your phone.

> **Status: work in progress (H1 of the hackathon plan).** Webhook ingest and the glasses inbox work;
> Telegram moderation calls are dry-run only until H2. **Tested in the Even Hub simulator only**: the
> developer does not own G2 glasses, so real ring/touchpad input and the real G2 microphone are untested.

## What works now

- **Telegram webhook ingest** `POST /api/webhooks/telegram` (Bot API `setWebhook` with `secret_token`;
  verified against the `X-Telegram-Bot-Api-Secret-Token` header, constant-time compare, body limit 1 MB).
- **Flag rules** (only chats in `TELEGRAM_ALLOWED_CHATS`):
  - a reply with `/report` (or `/report@YourBot`) flags the replied-to message — severity *high*, reporter recorded;
  - a message containing a link (`url` / `text_link` entity) — *medium*;
  - a message matching `FLAG_KEYWORDS` (case-insensitive) — *high*.
  Anything else answers `200 {"ignored": true}` and is not stored.
- **Dedup**: same `update_id` (redelivery) or same message (`msg:<chatId>:<messageId>`) never creates a second alert.
- **Privacy**: message text is capped at 500 characters; the raw update is never stored or returned.
- **Glasses UI**: Inbox shows `@username: text`; Detail shows the flag reason, text and group name.
- **Actions**: `delete | mute | ban | dismiss` through intent → Confirm (Cancel focused, one-time nonce) → result.
  `dismiss` only closes the flag; the others succeed only with `ACTIONS_DRY_RUN=1` until H2.

Planned next (H2/H3): real Bot API calls (`deleteMessage`, `restrictChatMember`, `banChatMember`),
voice phrases for mute/ban, on-demand AI summary, deploy.

## Quick start (local)

Requirements: Node 22+, pnpm 11, Postgres 16+, `@evenrealities/evenhub-simulator`.

```sh
pnpm install
# Postgres on port 5433 with a database `bouncer` (podman or a Homebrew cluster), then:
cp apps/server/.env.example apps/server/.env.local   # fill in values (secrets: openssl rand -hex 32)
pnpm db:migrate                                      # applies apps/server/drizzle/*.sql
pnpm dev:server                                      # http://localhost:3300
pnpm seed                                            # fake Telegram updates (report, link, keyword)
pnpm seed --selftest                                 # also checks secret, allowlist, dedup, truncation, dry-run actions
```

The selftest needs `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_CHATS`, `FLAG_KEYWORDS` (including
`airdrop`), `ADMIN_SECRET` and `ACTIONS_DRY_RUN=1` in `apps/server/.env.local`.

Glasses: `cp apps/glasses/.env.example apps/glasses/.env.local`, `pnpm dev:glasses`, then
`pnpm --filter @bouncer/glasses simulate`. Leave `VITE_API_BASE` empty (or `VITE_MOCK=1`) to run offline on
fake Telegram flags. Pair the glasses at `http://localhost:3300/pair` with `ADMIN_SECRET`.

Connect a real bot (after deploy): create a bot with @BotFather, add it to the group, then call
`setWebhook` with `url=https://<server>/api/webhooks/telegram` and `secret_token=<TELEGRAM_WEBHOOK_SECRET>`.
The production URL `https://bouncer.vercel.app` in `apps/glasses/app.json` is an assumption until deploy.

## Shared foundation

Bouncer is built on a copy of **Pagerline** at commit `d1f0599` — my own project, written 24–25 Nov 2026
during this same hackathon and submitted separately. Reused modules (adapted where needed): device
pairing (`pairing.ts`, `auth.ts`), intent → nonce → confirm actions (`actions.ts`), audit log, rate
limits, webhook ingest/dedup (`ingest.ts`, `http.ts`, `crypto.ts`), voice and AI summary plumbing, and
the glasses screens/gesture handling. New in Bouncer: Telegram ingest and flag rules (`telegram.ts`,
`app/api/webhooks/telegram`), moderation action set, Telegram mock data and selftest. GitHub/Sentry
integrations and Pagerline branding were removed.

## Third-party libraries and services

Exact versions are pinned in the `package.json` files: `@evenrealities/even_hub_sdk` 0.0.16,
`@evenrealities/evenhub-cli` 0.2.0, evenhub-simulator 0.9.5 (global), Vite 6.4.6, TypeScript 5.9.3,
Next.js 16.4.6, React 19.3.1, Drizzle ORM 0.45.4 / drizzle-kit 0.31.11, postgres.js 3.4.9; services:
Telegram Bot API, PostgreSQL/Neon, Vercel, Cartesia STT, Anthropic (`claude-haiku-5-5`).

## License

[MIT](LICENSE)
