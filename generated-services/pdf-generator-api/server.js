const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');
const Stripe = require('stripe');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = Number(process.env.PORT || 3000);
const appUrl = process.env.APP_URL || `http://localhost:${port}`;
const apiKeySalt = process.env.API_KEY_SALT || 'local-development-salt';
const dataDirectory = process.env.DATA_DIR || path.join(__dirname, 'data');
const storePath = path.join(dataDirectory, 'store.json');
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const plans = {
  free: {
    id: 'free',
    name: 'Free',
    monthlyOperations: 100,
    watermark: true,
    priceId: null
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    monthlyOperations: 5000,
    watermark: false,
    priceId: process.env.STRIPE_PRICE_STARTER || null
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    monthlyOperations: 25000,
    watermark: false,
    priceId: process.env.STRIPE_PRICE_PRO || null
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    monthlyOperations: 100000,
    watermark: false,
    priceId: process.env.STRIPE_PRICE_ENTERPRISE || null
  }
};

fs.mkdirSync(dataDirectory, { recursive: true });

function emptyStore() {
  return {
    users: {},
    templates: {},
    usage: {}
  };
}

function loadStore() {
  if (!fs.existsSync(storePath)) {
    return emptyStore();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return {
      users: parsed.users || {},
      templates: parsed.templates || {},
      usage: parsed.usage || {}
    };
  } catch (error) {
    console.error('Unable to read persistent store:', error.message);
    return emptyStore();
  }
}

let store = loadStore();

function saveStore() {
  const temporaryPath = `${storePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(store, null, 2));
  fs.renameSync(temporaryPath, storePath);
}

function hashApiKey(apiKey) {
  return crypto
    .createHmac('sha256', apiKeySalt)
    .update(apiKey)
    .digest('hex');
}

function generateApiKey() {
  return `pdfgen_${crypto.randomBytes(24).toString('hex')}`;
}

function currentMonth() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function nextMonthStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function getUsage(userId) {
  const key = `${userId}:${currentMonth()}`;
  return {
    key,
    count: Number(store.usage[key] || 0)
  };
}

function consumeOperations(user, amount) {
  const plan = plans[user.plan] || plans.free;
  const usage = getUsage(user.id);

  if (usage.count + amount > plan.monthlyOperations) {
    return {
      allowed: false,
      used: usage.count,
      limit: plan.monthlyOperations,
      remaining: Math.max(0, plan.monthlyOperations - usage.count),
      resetAt: nextMonthStart().toISOString()
    };
  }

  store.usage[usage.key] = usage.count + amount;
  saveStore();

  return {
    allowed: true,
    used: usage.count + amount,
    limit: plan.monthlyOperations,
    remaining: plan.monthlyOperations - usage.count - amount,
    resetAt: nextMonthStart().toISOString()
  };
}

function findUserById(userId) {
  return Object.values(store.users).find((user) => user.id === userId) || null;
}

function findUserByEmail(email) {
  const normalizedEmail = email.trim().toLowerCase();
  return Object.values(store.users).find(
    (user) => user.email === normalizedEmail
  ) || null;
}

function findUserByCustomerId(customerId) {
  return Object.values(store.users).find(
    (user) => user.stripeCustomerId === customerId
  ) || null;
}

function findUserBySubscriptionId(subscriptionId) {
  return Object.values(store.users).find(
    (user) => user.stripeSubscriptionId === subscriptionId
  ) || null;
}

function publicPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    monthlyOperations: plan.monthlyOperations,
    watermark: plan.watermark,
    checkoutAvailable: Boolean(stripe && plan.priceId)
  };
}

function authenticate(req, res, next) {
  const authorization = req.get('authorization') || '';

  if (!authorization.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Authorization must use Bearer <api_key>'
    });
  }

  const suppliedKey = authorization.slice(7).trim();
  if (!suppliedKey) {
    return res.status(401).json({ error: 'API key is required' });
  }

  const user = store.users[hashApiKey(suppliedKey)];
  if (!user) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  req.user = user;
  next();
}

function requireString(value, fieldName, maximumLength) {
  if (typeof value !== 'string' || value.trim() === '') {
    const error = new Error(`${fieldName} must be a non-empty string`);
    error.status = 400;
    throw error;
  }

  if (value.length > maximumLength) {
    const error = new Error(
      `${fieldName} exceeds the maximum length of ${maximumLength}`
    );
    error.status = 400;
    throw error;
  }

  return value;
}

function interpolate(input, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return input;
  }

  return input.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, key) => {
    const value = key.split('.').reduce((current, part) => {
      if (
        current !== null &&
        typeof current === 'object' &&
        Object.prototype.hasOwnProperty.call(current, part)
      ) {
        return current[part];
      }
      return undefined;
    }, values);

    if (value === undefined || value === null) {
      return '';
    }

    return String(value);
  });
}

function escapeHtml(input) {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function composeTemplate(template, data) {
  const html = interpolate(template.html, data);
  const css = interpolate(template.css || '', data);

  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<style>${css}</style>`,
    '</head>',
    `<body>${html}</body>`,
    '</html>'
  ].join('');
}

function addWatermark(html, text) {
  const watermark = [
    '<div style="',
    'position:fixed;',
    'top:48%;',
    'left:12%;',
    'right:12%;',
    'transform:rotate(-35deg);',
    'font:700 52px Arial,sans-serif;',
    'text-align:center;',
    'color:rgba(0,0,0,0.10);',
    'z-index:2147483647;',
    'pointer-events:none;',
    '">',
    escapeHtml(text),
    '</div>'
  ].join('');

  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body([^>]*)>/i, `<body$1>${watermark}`);
  }

  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${watermark}${html}</body></html>`;
}

function normalizeMargins(value) {
  const defaultMargins = {
    top: '20mm',
    right: '15mm',
    bottom: '20mm',
    left: '15mm'
  };

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultMargins;
  }

  return {
    top: String(value.top || defaultMargins.top),
    right: String(value.right || defaultMargins.right),
    bottom: String(value.bottom || defaultMargins.bottom),
    left: String(value.left || defaultMargins.left)
  };
}

function safePdfOptions(options = {}) {
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
  const headerTemplate =
    typeof options.headerTemplate === 'string'
      ? options.headerTemplate.slice(0, 50000)
      : '';
  const footerTemplate =
    typeof options.footerTemplate === 'string'
      ? options.footerTemplate.slice(0, 50000)
      : '';
  const displayHeaderFooter = Boolean(
    options.displayHeaderFooter || headerTemplate || footerTemplate
  );

  return {
    format,
    landscape: Boolean(options.landscape),
    margin: normalizeMargins(options.margin),
    printBackground: options.printBackground !== false,
    preferCSSPageSize: Boolean(options.preferCSSPageSize),
    displayHeaderFooter,
    headerTemplate:
      headerTemplate ||
      '<div style="font-size:8px;width:100%;text-align:center"></div>',
    footerTemplate:
      footerTemplate ||
      '<div style="font-size:9px;width:100%;text-align:center;color:#666"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
  };
}

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    }).catch((error) => {
      browserPromise = null;
      throw error;
    });
  }

  return browserPromise;
}

async function renderPdf(html, options) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceUrl = request.url();
      if (
        resourceUrl.startsWith('data:') ||
        resourceUrl.startsWith('about:') ||
        resourceUrl.startsWith('blob:')
      ) {
        request.continue();
      } else {
        request.abort();
      }
    });

    await page.setContent(html, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    const result = await page.pdf(safePdfOptions(options));
    return Buffer.from(result);
  } finally {
    await page.close();
  }
}

function setUsageHeaders(res, usage) {
  res.set({
    'X-RateLimit-Limit': String(usage.limit),
    'X-RateLimit-Remaining': String(usage.remaining),
    'X-RateLimit-Reset': usage.resetAt
  });
}

app.post(
  '/api/webhooks/stripe',
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(503).json({
        error: 'Stripe webhook configuration is unavailable'
      });
    }

    const signature = req.get('stripe-signature');
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      return res.status(400).json({
        error: `Invalid Stripe webhook: ${error.message}`
      });
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const user = findUserById(session.metadata?.userId);
        const requestedPlan = session.metadata?.plan;

        if (
          user &&
          plans[requestedPlan] &&
          requestedPlan !== 'free' &&
          session.payment_status !== 'unpaid'
        ) {
          user.plan = requestedPlan;
          user.stripeCustomerId =
            typeof session.customer === 'string'
              ? session.customer
              : session.customer?.id || user.stripeCustomerId;
          user.stripeSubscriptionId =
            typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription?.id || null;
          user.updatedAt = new Date().toISOString();
          saveStore();
        }
      }

      if (
        event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted'
      ) {
        const subscription = event.data.object;
        const customerId =
          typeof subscription.customer === 'string'
            ? subscription.customer
            : subscription.customer?.id;
        const user =
          findUserBySubscriptionId(subscription.id) ||
          findUserByCustomerId(customerId);

        if (user) {
          const activeStatuses = new Set(['active', 'trialing']);
          const priceId = subscription.items?.data?.[0]?.price?.id;
          const matchingPlan = Object.values(plans).find(
            (plan) => plan.priceId && plan.priceId === priceId
          );

          if (
            event.type === 'customer.subscription.deleted' ||
            !activeStatuses.has(subscription.status)
          ) {
            user.plan = 'free';
            user.stripeSubscriptionId = null;
          } else if (matchingPlan) {
            user.plan = matchingPlan.id;
            user.stripeSubscriptionId = subscription.id;
          }

          user.updatedAt = new Date().toISOString();
          saveStore();
        }
      }

      return res.json({ received: true });
    } catch (error) {
      console.error('Stripe webhook processing error:', error);
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  }
);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' }
  })
);

app.get('/', (req, res) => {
  res.json({
    service: 'PDF Generator API',
    version: '1.0.0',
    health: '/api/health',
    plans: '/api/plans'
  });
});

app.get('/api/health', async (req, res) => {
  let browserStatus = 'not_started';

  if (browserPromise) {
    try {
      const browser = await browserPromise;
      browserStatus = browser.connected ? 'connected' : 'disconnected';
    } catch (error) {
      browserStatus = 'unavailable';
    }
  }

  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    browser: browserStatus,
    stripeConfigured: Boolean(stripe)
  });
});

app.get('/api/plans', (req, res) => {
  res.json({
    plans: Object.values(plans).map(publicPlan)
  });
});

app.post('/api/auth/register', (req, res) => {
  const email =
    typeof req.body.email === 'string'
      ? req.body.email.trim().toLowerCase()
      : '';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }

  if (findUserByEmail(email)) {
    return res.status(409).json({
      error: 'This email address is already registered'
    });
  }

  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  const now = new Date().toISOString();

  const user = {
    id: uuidv4(),
    email,
    plan: 'free',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    createdAt: now,
    updatedAt: now
  };

  store.users[keyHash] = user;
  saveStore();

  return res.status(201).json({
    apiKey,
    userId: user.id,
    plan: user.plan,
    message: 'Store the API key securely because it cannot be retrieved later'
  });
});

app.get('/api/account', authenticate, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    plan: req.user.plan,
    createdAt: req.user.createdAt
  });
});

app.get('/api/usage', authenticate, (req, res) => {
  const plan = plans[req.user.plan] || plans.free;
  const usage = getUsage(req.user.id);

  res.json({
    plan: publicPlan(plan),
    used: usage.count,
    limit: plan.monthlyOperations,
    remaining: Math.max(0, plan.monthlyOperations - usage.count),
    resetAt: nextMonthStart().toISOString()
  });
});

app.post('/api/billing/checkout', authenticate, async (req, res, next) => {
  try {
    const requestedPlan = req.body.plan;

    if (!plans[requestedPlan] || requestedPlan === 'free') {
      return res.status(400).json({
        error: 'A valid paid plan is required'
      });
    }

    if (!stripe) {
      return res.status(503).json({
        error: 'Stripe checkout is not configured'
      });
    }

    const plan = plans[requestedPlan];
    if (!plan.priceId) {
      return res.status(503).json({
        error: `${plan.name} checkout is not configured`
      });
    }

    let customerId = req.user.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: {
          userId: req.user.id
        }
      });

      customerId = customer.id;
      req.user.stripeCustomerId = customerId;
      req.user.updatedAt = new Date().toISOString();
      saveStore();
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [
        {
          price: plan.priceId,
          quantity: 1
        }
      ],
      allow_promotion_codes: true,
      success_url: `${appUrl}/api/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/api/billing/cancel`,
      metadata: {
        userId: req.user.id,
        plan: requestedPlan
      },
      subscription_data: {
        metadata: {
          userId: req.user.id,
          plan: requestedPlan
        }
      }
    });

    return res.json({
      checkoutUrl: session.url,
      sessionId: session.id
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/billing/success', (req, res) => {
  res.json({
    status: 'checkout_completed',
    message: 'The subscription will be activated after Stripe confirms payment'
  });
});

app.get('/api/billing/cancel', (req, res) => {
  res.json({
    status: 'checkout_cancelled'
  });
});

app.post('/api/templates', authenticate, (req, res, next) => {
  try {
    const name = requireString(req.body.name, 'name', 200);
    const html = requireString(req.body.html, 'html', 1000000);
    const css =
      typeof req.body.css === 'string'
        ? req.body.css.slice(0, 250000)
        : '';

    const id = uuidv4();
    const template = {
      id,
      userId: req.user.id,
      name,
      html,
      css,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    store.templates[id] = template;
    saveStore();

    return res.status(201).json({
      id: template.id,
      name: template.name,
      createdAt: template.createdAt
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/templates', authenticate, (req, res) => {
  const templates = Object.values(store.templates)
    .filter((template) => template.userId === req.user.id)
    .map((template) => ({
      id: template.id,
      name: template.name,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt
    }));

  res.json({ templates });
});

app.get('/api/templates/:templateId', authenticate, (req, res) => {
  const template = store.templates[req.params.templateId];

  if (!template || template.userId !== req.user.id) {
    return res.status(404).json({ error: 'Template not found' });
  }

  return res.json(template);
});

app.put('/api/templates/:templateId', authenticate, (req, res, next) => {
  try {
    const template = store.templates[req.params.templateId];

    if (!template || template.userId !== req.user.id) {
      return res.status(404).json({ error: 'Template not found' });
    }

    if (req.body.name !== undefined) {
      template.name = requireString(req.body.name, 'name', 200);
    }

    if (req.body.html !== undefined) {
      template.html = requireString(req.body.html, 'html', 1000000);
    }

    if (req.body.css !== undefined) {
      if (typeof req.body.css !== 'string') {
        return res.status(400).json({ error: 'css must be a string' });
      }
      template.css = req.body.css.slice(0, 250000);
    }

    template.updatedAt = new Date().toISOString();
    saveStore();

    return res.json({
      id: template.id,
      name: template.name,
      updatedAt: template.updatedAt
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/templates/:templateId', authenticate, (req, res) => {
  const template = store.templates[req.params.templateId];

  if (!template || template.userId !== req.user.id) {
    return res.status(404).json({ error: 'Template not found' });
  }

  delete store.templates[req.params.templateId];
  saveStore();

  return res.status(204).send();
});

app.post('/api/render', authenticate, async (req, res, next) => {
  try {
    const hasHtml = typeof req.body.html === 'string' && req.body.html.trim();
    const hasTemplateId =
      typeof req.body.templateId === 'string' && req.body.templateId.trim();

    if (!hasHtml && !hasTemplateId) {
      return res.status(400).json({
        error: 'html or templateId is required'
      });
    }

    if (hasHtml && req.body.html.length > 1000000) {
      return res.status(413).json({
        error: 'html exceeds the maximum length of 1000000'
      });
    }

    let html;

    if (hasTemplateId) {
      const template = store.templates[req.body.templateId];

      if (!template || template.userId !== req.user.id) {
        return res.status(404).json({ error: 'Template not found' });
      }

      html = composeTemplate(template, req.body.data);
    } else {
      html = interpolate(req.body.html, req.body.data);
    }

    const plan = plans[req.user.plan] || plans.free;
    if (plan.watermark) {
      html = addWatermark(html, 'PDF Generator Free Tier');
    }

    const usage = consumeOperations(req.user, 1);
    if (!usage.allowed) {
      return res.status(429).json({
        error: 'Monthly operation limit exceeded',
        used: usage.used,
        limit: usage.limit,
        remaining: usage.remaining,
        resetAt: usage.resetAt
      });
    }

    const pdf = await renderPdf(html, req.body.options || {});
    setUsageHeaders(res, usage);

    const requestedFilename =
      typeof req.body.filename === 'string'
        ? req.body.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
        : 'document.pdf';
    const filename = requestedFilename.toLowerCase().endsWith('.pdf')
      ? requestedFilename
      : `${requestedFilename}.pdf`;

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.length),
      'Content-Disposition': `attachment; filename="${filename}"`
    });

    return res.send(pdf);
  } catch (error) {
    next(error);
  }
});

app.post('/api/merge', authenticate, async (req, res, next) => {
  try {
    const pdfs = req.body.pdfs;

    if (!Array.isArray(pdfs) || pdfs.length < 2 || pdfs.length > 20) {
      return res.status(400).json({
        error: 'pdfs must contain between 2 and 20 base64-encoded PDFs'
      });
    }

    const decodedPdfs = pdfs.map((encoded, index) => {
      if (typeof encoded !== 'string' || encoded.length > 15000000) {
        const error = new Error(`PDF at index ${index} is invalid or too large`);
        error.status = 400;
        throw error;
      }

      const normalized = encoded.includes(',')
        ? encoded.slice(encoded.indexOf(',') + 1)
        : encoded;
      return Buffer.from(normalized, 'base64');
    });

    const usage = consumeOperations(req.user, decodedPdfs.length);
    if (!usage.allowed) {
      return res.status(429).json({
        error: 'Monthly operation limit exceeded',
        used: usage.used,
        limit: usage.limit,
        remaining: usage.remaining,
        resetAt: usage.resetAt
      });
    }

    const mergedDocument = await PDFDocument.create();

    for (const input of decodedPdfs) {
      const sourceDocument = await PDFDocument.load(input);
      const copiedPages = await mergedDocument.copyPages(
        sourceDocument,
        sourceDocument.getPageIndices()
      );
      copiedPages.forEach((page) => mergedDocument.addPage(page));
    }

    const mergedBytes = await mergedDocument.save();
    const merged = Buffer.from(mergedBytes);
    setUsageHeaders(res, usage);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(merged.length),
      'Content-Disposition': 'attachment; filename="merged.pdf"'
    });

    return res.send(merged);
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((error, req, res, next) => {
  console.error(error);
  const status = Number(error.status || 500);

  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : error.message
  });
});

const server = app.listen(port, () => {
  console.log(`PDF Generator API listening on port ${port}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down`);

  server.close(async () => {
    try {
      if (browserPromise) {
        const browser = await browserPromise;
        await browser.close();
      }
    } catch (error) {
      console.error('Browser shutdown error:', error.message);
    }

    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
