# Webhook Relay API

A self-serve HTTP API for reliable webhook delivery with exponential backoff retries and delivery logs.

## Quick Start

```bash
npm install
API_KEYS=your-api-key node server.js
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Port to listen on (Railway sets this automatically) |
| `API_KEYS` | No | Comma-separated API keys for `X-API-Key` auth (default: `test-key`) |
| `DATABASE_URL` | No | Postgres connection string. When present, events and delivery logs are persisted to a `deliveries` table. When absent the service runs with in-memory storage and still boots. |

The service must always boot — an optional Postgres/Stripe variable must never crash the process.

## API Endpoints

- `GET /api/health` — Health check. Returns `{"status":"UP","storage":"postgres"|"memory"}`.
- `POST /events` — Enqueue an event for delivery. Requires `X-API-Key`.
  ```bash
  curl -X POST https://<host>/events \
    -H "X-API-Key: your-api-key" -H "Content-Type: application/json" \
    --data '{"url":"https://example.com/callback","data":{"hello":"world"}}'
  ```
  Returns `202 {"id":1,"message":"Event received, will deliver shortly"}`. Delivery retries with exponential backoff (2s, 4s, 8s, ...) up to 5 attempts.
- `GET /api/deliveries/:id` — Delivery log lookup for a single event. Requires `X-API-Key`.
- `POST /stripe/webhook` — Stripe success/failure notification webhook.

## License

MIT
