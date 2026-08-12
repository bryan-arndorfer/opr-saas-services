require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const validator = require('validator');

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const MAX_RETRIES = 5;

// ---------------------------------------------------------------------------
// Persistence layer. The service MUST boot even when DATABASE_URL is absent.
// With Postgres configured, webhook events and delivery attempts are stored in
// a `deliveries` table. Without it, state is kept in memory. Either way the
// delivery worker below delivers events with exponential backoff retries.
// ---------------------------------------------------------------------------
let client = null;

const dbInit = (async () => {
  if (!process.env.DATABASE_URL) {
    console.warn('[db] DATABASE_URL not set — running with in-memory storage (no persistence)');
    return;
  }
  try {
    const { Client } = require('pg');
    client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    await client.query(`CREATE TABLE IF NOT EXISTS deliveries (
      id BIGSERIAL PRIMARY KEY,
      event_url TEXT NOT NULL,
      payload JSONB NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    console.log('[db] Postgres connected');
  } catch (err) {
    client = null;
    console.error(`[db] Postgres unavailable — continuing in-memory: ${err.message}`);
  }
})();

const memoryDeliveries = new Map();
let memorySeq = 0;

async function enqueueDelivery(eventUrl, payload) {
  await dbInit;
  if (client) {
    const r = await client.query(
      'INSERT INTO deliveries (event_url, payload) VALUES ($1, $2) RETURNING id',
      [eventUrl, JSON.stringify(payload)],
    );
    return r.rows[0].id;
  }
  memorySeq += 1;
  memoryDeliveries.set(memorySeq, {
    id: memorySeq, eventUrl, payload, attempts: 0, status: 'pending', nextAttemptAt: 0, createdAt: new Date(),
  });
  return memorySeq;
}

async function pickPendingDelivery() {
  await dbInit;
  if (client) {
    const r = await client.query(
      `SELECT id, event_url, payload, attempts
       FROM deliveries
       WHERE status = 'pending' AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at ASC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    await client.query('UPDATE deliveries SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    return { id: row.id, eventUrl: row.event_url, payload: row.payload, attempts: row.attempts + 1 };
  }
  const now = Date.now();
  for (const d of memoryDeliveries.values()) {
    if (d.status === 'pending' && d.nextAttemptAt <= now) {
      d.attempts += 1;
      return { id: d.id, eventUrl: d.eventUrl, payload: d.payload, attempts: d.attempts };
    }
  }
  return null;
}

async function markDelivery(id, status) {
  if (client) {
    await client.query(
      "UPDATE deliveries SET status = $2, delivered_at = CASE WHEN $2 = 'delivered' THEN NOW() ELSE delivered_at END WHERE id = $1",
      [id, status],
    );
    return;
  }
  const d = memoryDeliveries.get(id);
  if (d) d.status = status;
}

async function scheduleRetry(id, attempts) {
  const backoffMs = 1000 * Math.pow(2, attempts - 1); // 2s, 4s, 8s, 16s, 32s
  if (client) {
    await client.query(
      "UPDATE deliveries SET next_attempt_at = NOW() + ($2 * INTERVAL '1 millisecond') WHERE id = $1",
      [id, backoffMs],
    );
    return;
  }
  const d = memoryDeliveries.get(id);
  if (d) d.nextAttemptAt = Date.now() + backoffMs;
}

async function deliverPending() {
  const delivery = await pickPendingDelivery();
  if (!delivery) return;
  const { id, eventUrl, payload, attempts } = delivery;
  try {
    const res = await fetch(eventUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'webhook-relay-api' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      await markDelivery(id, 'delivered');
      console.log(`[deliver] delivered #${id} -> ${eventUrl}`);
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    if (attempts >= MAX_RETRIES) {
      await markDelivery(id, 'failed');
      console.error(`[deliver] #${id} gave up after ${attempts} attempts: ${err.message}`);
    } else {
      await scheduleRetry(id, attempts);
      console.warn(`[deliver] #${id} attempt ${attempts} failed (${err.message}); retrying in ${1000 * Math.pow(2, attempts - 1)}ms`);
    }
  }
}

const limiter = rateLimit({ windowMs: 60 * 1000, max: 300 });
app.use(limiter);

const configuredKeys = new Set(
  (process.env.API_KEYS || process.env.API_KEY || 'test-key')
    .split(',').map(k => k.trim()).filter(Boolean),
);

function requireKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || !configuredKeys.has(key)) {
    return res.status(403).json({ error: 'Invalid or missing API key' });
  }
  next();
}

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'UP', storage: client ? 'postgres' : 'memory', uptime: process.uptime() });
});

// Enqueue an event for delivery to a callback URL.
app.post('/events', requireKey, async (req, res) => {
  const eventUrl = req.body && req.body.url;
  const payload = req.body && req.body.data;

  if (!eventUrl || !validator.isURL(String(eventUrl))) {
    return res.status(400).json({ error: 'Invalid url (must be a valid http(s) URL)' });
  }
  if (payload === undefined || payload === null) {
    return res.status(400).json({ error: 'No data provided' });
  }

  try {
    const id = await enqueueDelivery(String(eventUrl), payload);
    console.log(`[enqueue] #${id} -> ${eventUrl}`);
    return res.status(202).json({ id, message: 'Event received, will deliver shortly' });
  } catch (err) {
    return res.status(500).json({ error: `Failed to enqueue event: ${err.message}` });
  }
});

// Delivery log lookup for the status of a single event.
app.get('/api/deliveries/:id', requireKey, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid delivery id' });

  await dbInit;
  if (client) {
    const r = await client.query(
      'SELECT id, event_url, attempts, status, created_at, delivered_at FROM deliveries WHERE id = $1',
      [id],
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Delivery not found' });
    const row = r.rows[0];
    return res.json({
      id: row.id, url: row.event_url, attempts: row.attempts, status: row.status,
      createdAt: row.created_at, deliveredAt: row.delivered_at,
    });
  }
  const d = memoryDeliveries.get(id);
  if (!d) return res.status(404).json({ error: 'Delivery not found' });
  return res.json({
    id: d.id, url: d.eventUrl, attempts: d.attempts, status: d.status,
    createdAt: d.createdAt, deliveredAt: d.deliveredAt,
  });
});

// Handle stripe webhook for success/fail notifications.
app.post('/stripe/webhook', (req, res) => {
  res.sendStatus(200);
});

// Delivery worker: poll for pending events and deliver with retries.
setInterval(deliverPending, 2000);

process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('exit', () => {
  if (client) client.end().catch(() => {});
});

app.listen(PORT, () => {
  console.log(`Webhook Relay API listening on port ${PORT}`);
});
