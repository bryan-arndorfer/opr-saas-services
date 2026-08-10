require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const puppeteer = require('puppeteer');
const Stripe = require('stripe');
const Redis = require('ioredis');
const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_MERGE_FILES = 20;
const FILE_TTL_MS = 24 * 60 * 60 * 1000;

fs.mkdirSync(FILES_DIR, { recursive: true });

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true
    })
  : null;

if (redis) {
  redis.connect().catch((error) => {
    console.error('Redis connection failed:', error.message);
  });
}

const plans = {
  free: {
    monthlyRenders: 100,
    watermark: true,
    templates: 3,
    priceId: null
  },
  starter: {
    monthlyRenders: 2000,
    watermark: false,
    templates: 50,
    priceId: process.env.STRIPE_PRICE_STARTER || null
  },
  pro: {
    monthlyRenders: 15000,
    watermark: false,
    templates: 500,
    priceId: process.env.STRIPE_PRICE_PRO || null
  }
};

let state = {
  accounts: {},
  apiKeys: {},
  templates: {}
};

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = {
      accounts: parsed.accounts || {},
      apiKeys: parsed.apiKeys || {},
      templates: parsed.templates || {}
    };
  } catch (error) {
    console.error('Unable to load state:', error.message);
  }
}

function saveState() {
  const temporaryFile = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2));
  fs.renameSync(temporaryFile, STATE_FILE);
}

loadState();

function newApiKey() {
  return `pdf_${crypto.randomBytes(24).toString('hex')}`;
}

function publicAccount(account) {
  return {
    id: account.id,
    email: account.email,
    plan: account.plan,
    createdAt: account.createdAt,
    stripeCustomerId: account.stripeCustomerId || null
  };
}

function accountForKey(apiKey) {
  const record = state.apiKeys[apiKey];
  if (!record || record.revoked) return null;
  return state.accounts[record.accountId] || null;
}

function authenticate(req, res, next) {
  const apiKey = req.get('X-API-Key');
  if (!apiKey) {
    return res.status(401).json({
      error: 'missing_api_key',
      message: 'Provide an API key in the X-API-Key header.'
    });
  }

  const account = accountForKey(apiKey);
  if (!account) {
    return res.status(401).json({
      error: 'invalid_api_key',
      message: 'The supplied API key is invalid or revoked.'
    });
  }

  req.apiKey = apiKey;
  req.account = account;
  next();
}

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

async function usageFor(accountId) {
  const key = `pdf-usage:${accountId}:${monthKey()}`;
  if (redis && redis.status === 'ready') {
    return Number(await redis.get(key)) || 0;
  }
  const account = state.accounts[accountId];
  return Number(account.localUsage && account.localUsage[monthKey()]) || 0;
}

async function consumeRender(account) {
  const plan = plans[account.plan] || plans.free;
  const key = `pdf-usage:${account.id}:${monthKey()}`;

  if (redis && redis.status === 'ready') {
    const value = await redis.incr(key);
    if (value === 1) await redis.expire(key, 35 * 24 * 60 * 60);
    if (value > plan.monthlyRenders) {
      await redis.decr(key);
      return { allowed: false, used: value - 1, limit: plan.monthlyRenders };
    }
    return { allowed: true, used: value, limit: plan.monthlyRenders };
  }

  account.localUsage = account.localUsage || {};
  const used = Number(account.localUsage[monthKey()]) || 0;
  if (used >= plan.monthlyRenders) {
    return { allowed: false, used, limit: plan.monthlyRenders };
  }

  account.localUsage[monthKey()] = used + 1;
  saveState();
  return {
    allowed: true,
    used: used + 1,
    limit: plan.monthlyRenders
  };
}

async function restoreRender(account) {
  const key = `pdf-usage:${account.id}:${monthKey()}`;
  if (redis && redis.status === 'ready') {
    const current = Number(await redis.get(key)) || 0;
    if (current > 0) await redis.decr(key);
    return;
  }

  account.localUsage = account.localUsage || {};
  const current = Number(account.localUsage[monthKey()]) || 0;
  account.localUsage[monthKey()] = Math.max(0, current - 1);
  saveState();
}

function replaceVariables(html, data) {
  return html.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key) => {
    const value = key.split('.').reduce((current, part) => {
      if (current === null || current === undefined) return undefined;
      return current[part];
    }, data);

    if (value === null || value === undefined) return '';
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  });
}

function normalizePdfOptions(options) {
  const allowedFormats = new Set([
    'Letter',
    'Legal',
    'Tabloid',
    'Ledger',
    'A0',
    'A1',
    'A2',
    'A3',
    'A4',
    'A5',
    'A6'
  ]);

  const format = allowedFormats.has(options.format) ? options.format : 'A4';
  const margin = options.margin && typeof options.margin === 'object'
    ? options.margin
    : { top: '16mm', right: '16mm', bottom: '16mm', left: '16mm' };

  return {
    format,
    landscape: Boolean(options.landscape),
    printBackground: options.printBackground !== false,
    margin,
    displayHeaderFooter: Boolean(
      options.headerTemplate ||
      options.footerTemplate ||
      options.pageNumbers
    ),
    headerTemplate: options.headerTemplate || '<div></div>',
    footerTemplate: options.footerTemplate || (
      options.pageNumbers
        ? '<div style="width:100%;font-size:9px;text-align:center;color:#666"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
        : '<div></div>'
    ),
    preferCSSPageSize: Boolean(options.preferCSSPageSize),
    scale: Math.min(2, Math.max(0.1, Number(options.scale) || 1))
  };
}

async function addWatermark(pdfBytes, text) {
  const document = await PDFDocument.load(pdfBytes);
  const font = await document.embedFont(StandardFonts.HelveticaBold);

  for (const page of document.getPages()) {
    const size = page.getSize();
    const fontSize = Math.max(28, Math.min(56, size.width / 10));
    const label = text || 'PDF Generator API';
    const textWidth = font.widthOfTextAtSize(label, fontSize);

    page.drawText(label, {
      x: (size.width - textWidth) / 2,
      y: size.height / 2,
      size: fontSize,
      font,
      color: rgb(0.55, 0.55, 0.55),
      opacity: 0.22,
      rotate: degrees(-35)
    });
  }

  return Buffer.from(await document.save());
}

async function generatePdf(html, options, watermarkRequired) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(options.allowJavaScript === true);
    await page.setContent(html, {
      waitUntil: options.waitUntil === 'load' ? 'load' : 'networkidle0',
      timeout: 30000
    });

    const bytes = await page.pdf(normalizePdfOptions(options));
    if (!watermarkRequired) return Buffer.from(bytes);
    return addWatermark(bytes, options.watermarkText);
  } finally {
    await browser.close();
  }
}

function safeFilePath(filename) {
  if (!/^[a-f0-9-]+\.pdf$/.test(filename)) return null;
  return path.join(FILES_DIR, filename);
}

function removeExpiredFiles() {
  const now = Date.now();
  for (const filename of fs.readdirSync(FILES_DIR)) {
    const file = safeFilePath(filename);
    if (!file) continue;
    try {
      const stats = fs.statSync(file);
      if (now - stats.mtimeMs > FILE_TTL_MS) fs.unlinkSync(file);
    } catch (error) {
      console.error('File cleanup failed:', error.message);
    }
  }
}

setInterval(removeExpiredFiles, 60 * 60 * 1000).unref();

async function planFromSubscription(subscriptionId) {
  if (!stripe || !subscriptionId) return 'free';
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price']
  });
  const priceId = subscription.items.data[0] &&
    subscription.items.data[0].price &&
    subscription.items.data[0].price.id;

  const matchingPlan = Object.entries(plans).find(
    ([name, plan]) => name !== 'free' && plan.priceId === priceId
  );

  return matchingPlan ? matchingPlan[0] : 'free';
}

app.post(
  '/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(503).json({ error: 'stripe_not_configured' });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.get('stripe-signature'),
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      return res.status(400).json({
        error: 'invalid_signature',
        message: error.message
      });
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const account = state.accounts[session.client_reference_id];

        if (account) {
          account.stripeCustomerId = session.customer;
          account.stripeSubscriptionId = session.subscription;
          account.plan = await planFromSubscription(session.subscription);
          saveState();
        }
      }

      if (
        event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted'
      ) {
        const subscription = event.data.object;
        const account = Object.values(state.accounts).find(
          (entry) => entry.stripeSubscriptionId === subscription.id
        );

        if (account) {
          account.plan = event.type === 'customer.subscription.deleted'
            ? 'free'
            : await planFromSubscription(subscription.id);
          if (event.type === 'customer.subscription.deleted') {
            account.stripeSubscriptionId = null;
          }
          saveState();
        }
      }

      return res.json({ received: true });
    } catch (error) {
      console.error('Stripe webhook processing failed:', error);
      return res.status(500).json({ error: 'webhook_processing_failed' });
    }
  }
);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '12mb' }));

app.get('/api/health', async (req, res) => {
  res.json({
    status: 'ok',
    service: 'pdf-generator-api',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    redis: redis ? redis.status : 'disabled',
    stripe: stripe ? 'configured' : 'disabled'
  });
});

app.post('/api/signup', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      error: 'invalid_email',
      message: 'A valid email address is required.'
    });
  }

  const existing = Object.values(state.accounts).find(
    (account) => account.email === email
  );
  if (existing) {
    return res.status(409).json({
      error: 'account_exists',
      message: 'An account with this email already exists.'
    });
  }

  const accountId = uuidv4();
  const apiKey = newApiKey();
  const account = {
    id: accountId,
    email,
    plan: 'free',
    createdAt: new Date().toISOString(),
    localUsage: {}
  };

  state.accounts[accountId] = account;
  state.apiKeys[apiKey] = {
    accountId,
    createdAt: new Date().toISOString(),
    revoked: false
  };
  saveState();

  return res.status(201).json({
    account: publicAccount(account),
    apiKey,
    warning: 'Store this API key securely. It is only returned in full when created.'
  });
});

app.get('/api/account', authenticate, (req, res) => {
  res.json({ account: publicAccount(req.account) });
});

app.post('/api/keys', authenticate, (req, res) => {
  const apiKey = newApiKey();
  state.apiKeys[apiKey] = {
    accountId: req.account.id,
    createdAt: new Date().toISOString(),
    revoked: false
  };
  saveState();

  res.status(201).json({ apiKey });
});

app.get('/api/keys', authenticate, (req, res) => {
  const keys = Object.entries(state.apiKeys)
    .filter(([, record]) => record.accountId === req.account.id)
    .map(([key, record]) => ({
      key: `${key.slice(0, 10)}...${key.slice(-4)}`,
      createdAt: record.createdAt,
      revoked: Boolean(record.revoked),
      current: key === req.apiKey
    }));

  res.json({ keys });
});

app.delete('/api/keys/:key', authenticate, (req, res) => {
  const key = req.params.key;
  const record = state.apiKeys[key];

  if (!record || record.accountId !== req.account.id) {
    return res.status(404).json({ error: 'key_not_found' });
  }
  if (key === req.apiKey) {
    return res.status(400).json({
      error: 'cannot_revoke_current_key',
      message: 'Use another account key to revoke this key.'
    });
  }

  record.revoked = true;
  saveState();
  res.json({ success: true });
});

app.post('/api/templates', authenticate, (req, res) => {
  const name = String(req.body.name || '').trim();
  const html = req.body.html;
  const accountTemplates = Object.values(state.templates).filter(
    (template) => template.accountId === req.account.id
  );
  const limit = (plans[req.account.plan] || plans.free).templates;

  if (!name || typeof html !== 'string' || !html.trim()) {
    return res.status(400).json({
      error: 'invalid_template',
      message: 'name and non-empty html are required.'
    });
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    return res.status(413).json({ error: 'template_too_large' });
  }
  if (accountTemplates.length >= limit) {
    return res.status(403).json({
      error: 'template_limit_reached',
      limit
    });
  }

  const id = uuidv4();
  state.templates[id] = {
    id,
    accountId: req.account.id,
    name,
    html,
    createdAt: new Date().toISOString()
  };
  saveState();

  res.status(201).json({
    template: {
      id,
      name,
      createdAt: state.templates[id].createdAt
    }
  });
});

app.get('/api/templates', authenticate, (req, res) => {
  const templates = Object.values(state.templates)
    .filter((template) => template.accountId === req.account.id)
    .map((template) => ({
      id: template.id,
      name: template.name,
      createdAt: template.createdAt
    }));

  res.json({ templates });
});

app.get('/api/templates/:id', authenticate, (req, res) => {
  const template = state.templates[req.params.id];
  if (!template || template.accountId !== req.account.id) {
    return res.status(404).json({ error: 'template_not_found' });
  }

  res.json({
    template: {
      id: template.id,
      name: template.name,
      html: template.html,
      createdAt: template.createdAt
    }
  });
});

app.delete('/api/templates/:id', authenticate, (req, res) => {
  const template = state.templates[req.params.id];
  if (!template || template.accountId !== req.account.id) {
    return res.status(404).json({ error: 'template_not_found' });
  }

  delete state.templates[req.params.id];
  saveState();
  res.json({ success: true });
});

app.post('/api/render', authenticate, async (req, res) => {
  const options = req.body.options && typeof req.body.options === 'object'
    ? req.body.options
    : {};
  const data = req.body.data && typeof req.body.data === 'object'
    ? req.body.data
    : {};

  let html = req.body.html;

  if (req.body.templateId) {
    const template = state.templates[req.body.templateId];
    if (!template || template.accountId !== req.account.id) {
      return res.status(404).json({ error: 'template_not_found' });
    }
    html = template.html;
  }

  if (typeof html !== 'string' || !html.trim()) {
    return res.status(400).json({
      error: 'invalid_html',
      message: 'Provide non-empty html or a valid templateId.'
    });
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    return res.status(413).json({ error: 'html_too_large' });
  }

  const quota = await consumeRender(req.account);
  res.set('X-RateLimit-Limit', String(quota.limit));
  res.set(
    'X-RateLimit-Remaining',
    String(Math.max(0, quota.limit - quota.used))
  );

  if (!quota.allowed) {
    return res.status(429).json({
      error: 'monthly_quota_exceeded',
      used: quota.used,
      limit: quota.limit
    });
  }

  try {
    const renderedHtml = replaceVariables(html, data);
    const plan = plans[req.account.plan] || plans.free;
    const pdf = await generatePdf(renderedHtml, options, plan.watermark);

    if (options.return === 'url') {
      const filename = `${uuidv4()}.pdf`;
      fs.writeFileSync(path.join(FILES_DIR, filename), pdf);
      return res.json({
        url: `${BASE_URL}/api/files/${filename}`,
        bytes: pdf.length,
        expiresAt: new Date(Date.now() + FILE_TTL_MS).toISOString()
      });
    }

    res.set('Content-Type', 'application/pdf');
    res.set(
      'Content-Disposition',
      `attachment; filename="document-${Date.now()}.pdf"`
    );
    return res.send(pdf);
  } catch (error) {
    await restoreRender(req.account);
    console.error('PDF rendering failed:', error);
    return res.status(500).json({
      error: 'render_failed',
      message: error.message
    });
  }
});

app.post('/api/merge', authenticate, async (req, res) => {
  const files = req.body.files;
  if (!Array.isArray(files) || files.length < 2) {
    return res.status(400).json({
      error: 'invalid_files',
      message: 'Provide at least two base64-encoded PDFs in files.'
    });
  }
  if (files.length > MAX_MERGE_FILES) {
    return res.status(400).json({
      error: 'too_many_files',
      limit: MAX_MERGE_FILES
    });
  }

  const quota = await consumeRender(req.account);
  if (!quota.allowed) {
    return res.status(429).json({
      error: 'monthly_quota_exceeded',
      used: quota.used,
      limit: quota.limit
    });
  }

  try {
    const destination = await PDFDocument.create();

    for (const encoded of files) {
      if (typeof encoded !== 'string') {
        throw new Error('Every file must be a base64 string.');
      }
      const source = await PDFDocument.load(Buffer.from(encoded, 'base64'));
      const copiedPages = await destination.copyPages(
        source,
        source.getPageIndices()
      );
      copiedPages.forEach((page) => destination.addPage(page));
    }

    let merged = Buffer.from(await destination.save());
    const plan = plans[req.account.plan] || plans.free;
    if (plan.watermark) merged = await addWatermark(merged);

    res.set('Content-Type', 'application/pdf');
    res.set(
      'Content-Disposition',
      `attachment; filename="merged-${Date.now()}.pdf"`
    );
    return res.send(merged);
  } catch (error) {
    await restoreRender(req.account);
    return res.status(400).json({
      error: 'merge_failed',
      message: error.message
    });
  }
});

app.get('/api/files/:filename', (req, res) => {
  const file = safeFilePath(req.params.filename);
  if (!file || !fs.existsSync(file)) {
    return res.status(404).json({ error: 'file_not_found' });
  }

  const stats = fs.statSync(file);
  if (Date.now() - stats.mtimeMs > FILE_TTL_MS) {
    fs.unlinkSync(file);
    return res.status(410).json({ error: 'file_expired' });
  }

  res.type('application/pdf');
  res.set('Content-Disposition', `attachment; filename="${req.params.filename}"`);
  return res.sendFile(file);
});

app.get('/api/usage', authenticate, async (req, res) => {
  const plan = plans[req.account.plan] || plans.free;
  const used = await usageFor(req.account.id);

  res.json({
    month: monthKey(),
    plan: req.account.plan,
    used,
    limit: plan.monthlyRenders,
    remaining: Math.max(0, plan.monthlyRenders - used)
  });
});

app.post('/api/billing/checkout', authenticate, async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'stripe_not_configured' });
  }

  const requestedPlan = String(req.body.plan || '');
  const plan = plans[requestedPlan];
  if (!plan || requestedPlan === 'free' || !plan.priceId) {
    return res.status(400).json({
      error: 'invalid_plan',
      availablePlans: Object.keys(plans).filter(
        (name) => name !== 'free' && plans[name].priceId
      )
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: req.account.stripeCustomerId || undefined,
      customer_email: req.account.stripeCustomerId
        ? undefined
        : req.account.email,
      client_reference_id: req.account.id,
      line_items: [{ price: plan.priceId, quantity: 1 }],
      success_url: `${BASE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/billing/cancel`,
      metadata: {
        accountId: req.account.id,
        requestedPlan
      }
    });

    res.json({
      checkoutUrl: session.url,
      sessionId: session.id
    });
  } catch (error) {
    res.status(500).json({
      error: 'checkout_failed',
      message: error.message
    });
  }
});

app.post('/api/billing/portal', authenticate, async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'stripe_not_configured' });
  }
  if (!req.account.stripeCustomerId) {
    return res.status(400).json({
      error: 'no_billing_account',
      message: 'Create a subscription before opening the billing portal.'
    });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: req.account.stripeCustomerId,
      return_url: `${BASE_URL}/billing`
    });
    res.json({ portalUrl: session.url });
  } catch (error) {
    res.status(500).json({
      error: 'portal_failed',
      message: error.message
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'internal_server_error' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`PDF Generator API listening on port ${PORT}`);
  console.log(`Health endpoint: ${BASE_URL}/api/health`);
});

async function shutdown() {
  server.close(async () => {
    if (redis) {
      try {
        await redis.quit();
      } catch (error) {
        console.error('Redis shutdown failed:', error.message);
      }
    }
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
