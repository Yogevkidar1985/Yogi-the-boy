# Deployment

## Local (recommended start)

```bash
npm install && cp .env.example .env
npm run dev      # API + dashboard :3010
npm run worker   # monitor loop
```

Both processes share the SQLite file (`DATABASE_PATH`). Keep the worker
running for continuous monitoring; it survives API restarts.

## Docker

```bash
docker compose up -d --build     # api + worker, shared volume
```

## VPS / production checklist

1. Set a real `DEFAULT_CURRENCY`, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` or `ALERT_WEBHOOK_URL`.
2. Put the API behind a reverse proxy (nginx/caddy) with TLS.
3. `MOCK_PROVIDER=0` (default) — mock never serves production searches.
4. Optional scale-out: enable postgres+redis services in docker-compose and
   follow docs/architecture.md "Scaling path".
5. Back up the SQLite file (it contains all price history).

## Running "non-stop"

- **On your own machine/VPS**: `npm run worker` (or the docker worker) is the
  always-on engine; the adaptive scheduler (30m-24h) keeps request volume low.
- **In Claude Code cloud sessions**: the sandbox is ephemeral and its network
  policy may block Google Flights — use a Routine/scheduled session that runs
  `npm run search -- "<query>"` periodically, or self-host for true 24/7.

## Troubleshooting

| Symptom | Fix |
|---|---|
| all providers fail | check outbound network to google.com; registry falls back automatically |
| `fast-flights not installed` | `pip install fast-flights typing_extensions` |
| `fli` not found | `pipx install 'flights[mcp]'` + `pipx ensurepath` |
| empty dashboard | run `npm run seed` for demo data, or run a real search |
| alerts not arriving | check channel env vars; see `alert_deliveries` table for status |
