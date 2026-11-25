<img src="assets/brand/bouncer-icon.svg" width="96" alt="Bouncer logo">

# Bouncer

Heads-up **Telegram group moderation** HUD for **Even Realities G2** glasses. Reported or suspicious
messages in your Telegram groups land on your glasses; you read them and act (delete, mute 1 hour, ban,
dismiss) behind an explicit confirm step, without reaching for your phone.

> **Status: hackathon MVP.** Webhook ingest, the glasses inbox, Bot API moderation, AI risk labels,
> voice commands, Telegram DM pairing and the retention purge are implemented. delete/mute/ban were
> exercised end to end against the production deployment on a real test supergroup with a second
> Telegram account (the admin guard rejected actions on the owner; the banned account was restored
> afterwards). **Tested in the Even Hub simulator only**: the developer does not
> own G2 glasses, so real ring/touchpad input and the real G2 microphone are untested.

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
  `delete` → `deleteMessage` (already-deleted counts as done), `mute` → `restrictChatMember` with every
  permission off for 1 hour (supergroups only), `ban` → `banChatMember`, `dismiss` closes the flag without
  calling Telegram. At intent time `getChatMember` refuses group owners/admins (`422 cannot moderate admins`);
  the chat allowlist is checked again at confirm. The bot token never reaches logs, audit or responses.
  `ACTIONS_DRY_RUN=1` uses a fake provider (admins from `DRY_RUN_ADMIN_IDS`).
- **AI risk label** (Detail screen): `spam | scam | toxic | ok | unclear` + a reason ≤ 200 characters from
  `claude-haiku-5-5`, requested only when the moderator opens the alert, cached until the status changes.
  The message is passed as untrusted data, no tools; invalid output → `unclear` + heuristic reason.
  The label is advice only: the action list always comes from the server-side matrix. `AI_LABELS=0` disables it.
- **Voice**: "delete this", "mute him", "ban this user", "dismiss", "next", "summary"… A voice command only
  opens the Confirm screen with Cancel focused; negations ("don't ban") and two verbs at once are rejected.
- **Pairing**: the glasses show a 6-character code. A group admin DMs the bot `/pair CODE`; the server checks
  with `getChatMember` that the sender administers an allowlisted group and replies in the chat (as the
  webhook response, no extra API call). Fallback: `/pair` page with `ADMIN_SECRET`.

## Privacy

- Only flagged messages are stored (text ≤ 500 characters, never the raw update); unflagged chat is dropped.
- Flagged text goes to Anthropic **only on demand**, when a moderator opens that alert; `AI_LABELS=0` turns this off.
- **Retention: 7 days.** A daily Vercel Cron (`GET /api/cron/purge`, `CRON_SECRET`) deletes older alerts with
  their text and AI label. The audit log never stores message text.

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
`airdrop`), `ADMIN_SECRET`, `ACTIONS_DRY_RUN=1`, `DRY_RUN_ADMIN_IDS=70099`, `ACTION_NONCE_TTL_SECONDS`
(≤ 15, e.g. 8), a dummy `TELEGRAM_BOT_TOKEN` (checked for leaks), `SUMMARY_AI_MOCK=1`, `VOICE_STT_MOCK=1`,
`CRON_SECRET` and the local `DATABASE_URL` in `apps/server/.env.local`.

Glasses: `cp apps/glasses/.env.example apps/glasses/.env.local`, `pnpm dev:glasses`, then
`pnpm --filter @bouncer/glasses simulate`. Leave `VITE_API_BASE` empty (or `VITE_MOCK=1`) to run offline on
fake Telegram flags. Pair the glasses by DM `/pair CODE` to the bot, or at `http://localhost:3300/pair`
with `ADMIN_SECRET`.

Connect a real bot (after deploy): create a bot with @BotFather, add it to the group, then call
`setWebhook` with `url=https://<server>/api/webhooks/telegram` and `secret_token=<TELEGRAM_WEBHOOK_SECRET>`.
Production server: `https://bouncer-nine.vercel.app` (whitelisted in `apps/glasses/app.json`, used by
`pnpm --filter @bouncer/glasses pack`). The webhook is registered with
`allowed_updates=["message","edited_message"]` and `drop_pending_updates=true`.

## Shared foundation

Bouncer is built on a copy of **Pagerline** at commit `d1f0599` — my own project, written 24–25 Nov 2026
during this same hackathon and submitted separately. Reused modules (adapted where needed): device
pairing (`pairing.ts`, `auth.ts`), intent → nonce → confirm actions (`actions.ts`), audit log, rate
limits, webhook ingest/dedup (`ingest.ts`, `http.ts`, `crypto.ts`), voice and AI summary plumbing, and
the glasses screens/gesture handling. New in Bouncer: Telegram ingest and flag rules (`telegram.ts`,
`app/api/webhooks/telegram`), moderation action set, AI risk labels, moderation voice intents,
Telegram DM pairing (`tgpair.ts`), retention purge, Telegram mock data and selftest. GitHub/Sentry
integrations and Pagerline branding were removed.

## Third-party libraries and services

Exact versions are pinned in the `package.json` files: `@evenrealities/even_hub_sdk` 0.0.16,
`@evenrealities/evenhub-cli` 0.2.0, evenhub-simulator 0.9.5 (global), Vite 6.4.6, TypeScript 5.9.3,
Next.js 16.4.6, React 19.3.1, Drizzle ORM 0.45.4 / drizzle-kit 0.31.11, postgres.js 3.4.9; services:
Telegram Bot API, PostgreSQL/Neon, Vercel, Cartesia STT, Anthropic (`claude-haiku-5-5`).

## License

[MIT](LICENSE)
