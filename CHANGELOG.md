# Changelog

All notable changes are recorded here. Format follows Keep a Changelog; versions follow SemVer.

Bouncer starts from a copy of Pagerline `d1f0599` (same hackathon, 24–25 Nov 2026); Pagerline's own
history is not repeated here.

## [Unreleased]

### Added
- Telegram webhook ingest (`POST /api/webhooks/telegram`), verified with the `X-Telegram-Bot-Api-Secret-Token` header.
- Flag rules: `/report` (or `/report@<bot>`) as a reply flags the replied-to message (high, reporter recorded);
  messages with a link (`url`/`text_link` entity) are flagged medium; `FLAG_KEYWORDS` matches are flagged high.
- Only chats in `TELEGRAM_ALLOWED_CHATS` are processed; other updates answer `200 {ignored: true}`.
- Dedup per `update_id` (redelivery) and per message (`msg:<chatId>:<messageId>`); message text is capped at 500 characters
  and the raw update is never stored.
- Moderation actions `delete`, `mute`, `ban` (dry run only until the Bot API calls are wired) and `dismiss` (closes the flag).
- Glasses inbox/detail show Telegram flags (`@username: text`, group name); offline mock data uses fake Telegram messages.
- Demo seed / selftest sends fake Telegram updates.

### Removed
- GitHub and Sentry webhooks, providers and actions (`rerun`, `resolve`) inherited from the Pagerline base.
- Pagerline logo and brand assets (neutral placeholder favicon).
