require('dotenv').config();

const express = require('express');
const { randomBytes, randomUUID } = require('crypto');
const puppeteer = require('puppeteer');

const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const MAX_FREE_RENDERS = Number.parseInt(
  process.env.MAX_FREE_RENDERS_PER_MONTH || '100',
  10
);
const MAX_BATCH_SIZE = Number.parseInt(process.env.MAX_BATCH_SIZE || '20', 10);
const MAX_HTML_LENGTH = Number.parseInt(
  process.env.MAX_HTML_LENGTH || '2000000',
  10
);

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

const configuredKeys = String(process.env.API_KEYS || 'demo-key')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const configuredPremiumKeys = String(process.env.PREMIUM_API_KEYS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const validKeys = new Set(configuredKeys);
const premiumKeys = new Set(configuredPremiumKeys);
const templates = new Map();
const usage = new Map();
const jobs = new Map();

let browserPromise = null;
let server = null;

function createApiKey() {
  return `pdf_live_${randomBytes(24).toString('hex')}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return entities[character];
  });
}

function resolvePath(object, path) {
  return path.split('.').reduce((current, key) => {
    if (current === null || current === undefined) {
      return undefined;
    }
    return current[key];
  }, object);
}

function renderTemplate(template, data = {}) {
  return String(template).replace(
    /\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([\w.]+)\s*\}\}/g,
    (match, rawPath, escapedPath) => {
      const path = rawPath || escapedPath;
      const value = resolvePath(data, path);

      if (value === null || value === undefined) {
        return '';
      }

      return rawPath ? String(value) : escapeHtml(value);
    }
  );
}

function injectWatermark(html, watermark) {
  if (!watermark) {
    return html;
  }

  const watermarkMarkup = [
    '<div style="position:fixed;',
    'top:50%;left:50%;',
    'transform:translate(-50%,-50%) rotate(-35deg);',
    'font-family:Arial,sans-serif;',
    'font-size:84px;',
    'font-weight:700;',
    'color:rgba(80,80,80,0.12);',
    'z-index:2147483647;',
    'pointer-events:none;',
    'white-space:nowrap;">',
    escapeHtml(watermark),
    '</div>'
  ].join('');

  if (/<body[\s>]/i.test(html)) {
    return html.replace(/<body([^>]*)>/i, `<body$1>${watermarkMarkup}`);
  }

  return `${watermarkMarkup}${html}`;
}

function monthKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function getUsage(apiKey) {
  const currentMonth = monthKey();
  let entry = usage.get(apiKey);

  if (!entry || entry.month !== currentMonth) {
    entry = {
      month: currentMonth,
      count: 0
    };
    usage.set(apiKey, entry);
  }

  return entry;
}

function isPremium(apiKey) {
  return premiumKeys.has(apiKey);
}

function assertAllowance(apiKey, amount = 1) {
  if (isPremium(apiKey)) {
    return;
  }

  const entry = getUsage(apiKey);

  if (entry.count + amount > MAX_FREE_RENDERS) {
    const error = new Error(
      `Free tier limit of ${MAX_FREE_RENDERS} PDF renders per month would be exceeded.`
    );
    error.status = 429;
    throw error;
  }
}

function incrementUsage(apiKey, amount = 1) {
  const entry = getUsage(apiKey);
  entry.count += amount;
}

function extractApiKey(req) {
  const directKey = req.get('x-api-key');

  if (directKey) {
    return directKey.trim();
  }

  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requireApiKey(req, res, next) {
  const apiKey = extractApiKey(req);

  if (!apiKey || (!validKeys.has(apiKey) && !premiumKeys.has(apiKey))) {
    return res.status(401).json({
      error: 'A valid API key is required in x-api-key or Authorization: Bearer.'
    });
  }

  req.apiKey = apiKey;
  return next();
}

function validateHtml(html) {
  if (typeof html !== 'string' || html.trim().length === 0) {
    const error = new Error('HTML must be a non-empty string.');
    error.status = 400;
    throw error;
  }

  if (html.length > MAX_HTML_LENGTH) {
    const error = new Error(
      `HTML exceeds the maximum length of ${MAX_HTML_LENGTH} characters.`
    );
    error.status = 413;
    throw error;
  }
}

function prepareDocument(body) {
  const input = body || {};
  let html;

  if (input.templateId) {
    const template = templates.get(String(input.templateId));

    if (!template) {
      const error = new Error(`Template "${input.templateId}" was not found.`);
      error.status = 404;
      throw error;
    }

    html = renderTemplate(template.html, input.data || {});
  } else {
    html = input.html;
  }

  validateHtml(html);

  const options =
    input.options && typeof input.options === 'object' ? input.options : {};

  return {
    html: injectWatermark(html, options.watermark),
    options
  };
}

function normalizeMargin(margin) {
  if (!margin || typeof margin !== 'object') {
    return {
      top: '20mm',
      right: '15mm',
      bottom: '20mm',
      left: '15mm'
    };
  }

  return {
    top: String(margin.top || '20mm'),
    right: String(margin.right || '15mm'),
    bottom: String(margin.bottom || '20mm'),
    left: String(margin.left || '15mm')
  };
}

function buildPdfOptions(options) {
  const pageNumbers = Boolean(options.pageNumbers);
  const hasHeader = typeof options.headerTemplate === 'string';
  const hasFooter = typeof options.footerTemplate === 'string';
  const displayHeaderFooter = pageNumbers || hasHeader || hasFooter;

  const defaultHeader =
    '<div style="width:100%;font-size:8px;color:#777;padding:0 15mm;"></div>';
  const defaultFooter = pageNumbers
    ? '<div style="width:100%;font-size:9px;color:#666;text-align:center;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
    : '<div style="width:100%;font-size:8px;color:#777;padding:0 15mm;"></div>';

  const pdfOptions = {
    printBackground: options.printBackground !== false,
    landscape: Boolean(options.landscape),
    preferCSSPageSize: Boolean(options.preferCSSPageSize),
    displayHeaderFooter,
    headerTemplate: hasHeader ? options.headerTemplate : defaultHeader,
    footerTemplate: hasFooter ? options.footerTemplate : defaultFooter,
    margin: normalizeMargin(options.margin)
  };

  if (typeof options.format === 'string' && options.format.trim()) {
    pdfOptions.format = options.format.trim();
  } else {
    pdfOptions.format = 'A4';
  }

  if (typeof options.scale === 'number') {
    pdfOptions.scale = Math.min(2, Math.max(0.1, options.scale));
  }

  return pdfOptions;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      })
      .catch((error) => {
        browserPromise = null;
        throw error;
      });
  }

  return browserPromise;
}

async function generatePdf(document) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setContent(document.html, {
      waitUntil: ['domcontentloaded', 'networkidle0'],
      timeout: 30000
    });

    if (
      document.options &&
      Number.isFinite(Number(document.options.waitForMilliseconds))
    ) {
      const delay = Math.min(
        5000,
        Math.max(0, Number(document.options.waitForMilliseconds))
      );

      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    const pdf = await page.pdf(buildPdfOptions(document.options || {}));
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    completedAt: job.completedAt || null,
    documents: job.documents.map((document) => ({
      id: document.id,
      status: document.status,
      error: document.error || null,
      downloadUrl:
        document.status === 'completed'
          ? `/api/jobs/${job.id}/documents/${document.id}/pdf`
          : null
    }))
  };
}

async function processBatch(job, requests) {
  job.status = 'processing';

  for (let index = 0; index < requests.length; index += 1) {
    const jobDocument = job.documents[index];

    try {
      jobDocument.status = 'processing';
      const document = prepareDocument(requests[index]);
      jobDocument.pdf = await generatePdf(document);
      jobDocument.status = 'completed';
    } catch (error) {
      jobDocument.status = 'failed';
      jobDocument.error = error.message;
    }
  }

  job.status = job.documents.some((document) => document.status === 'failed')
    ? 'completed_with_errors'
    : 'completed';
  job.completedAt = new Date().toISOString();
}

function priceIdForPlan(plan) {
  const prices = {
    starter: process.env.STRIPE_STARTER_PRICE_ID,
    pro: process.env.STRIPE_PRO_PRICE_ID,
    business: process.env.STRIPE_BUSINESS_PRICE_ID
  };

  return prices[plan] || null;
}

async function activateCheckoutSession(sessionId) {
  if (!stripe) {
    const error = new Error('Stripe billing is not configured.');
    error.status = 503;
    throw error;
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId);

  if (
    session.payment_status !== 'paid' &&
    session.payment_status !== 'no_payment_required'
  ) {
    const error = new Error('The checkout session has not been paid.');
    error.status = 402;
    throw error;
  }

  const apiKey = session.metadata && session.metadata.apiKey;

  if (!apiKey) {
    const error = new Error('The checkout session does not contain an API key.');
    error.status = 500;
    throw error;
  }

  premiumKeys.add(apiKey);
  return {
    apiKey,
    plan: session.metadata.plan || 'paid',
    customerId: session.customer || null,
    subscriptionId: session.subscription || null
  };
}

app.disable('x-powered-by');

app.post(
  '/api/billing/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(503).json({
        error: 'Stripe webhook processing is not configured.'
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
        const apiKey = session.metadata && session.metadata.apiKey;

        if (apiKey) {
          premiumKeys.add(apiKey);
        }
      }

      if (
        event.type === 'customer.subscription.deleted' ||
        event.type === 'customer.subscription.paused'
      ) {
        const subscription = event.data.object;
        const apiKey = subscription.metadata && subscription.metadata.apiKey;

        if (apiKey) {
          premiumKeys.delete(apiKey);
        }
      }

      return res.json({ received: true });
    } catch (error) {
      return res.status(500).json({
        error: error.message
      });
    }
  }
);

app.use(express.json({ limit: '3mb' }));

app.get('/', (req, res) => {
  res.json({
    service: 'PdfGenerator API',
    status: 'online',
    documentation: '/api',
    health: '/api/health'
  });
});

app.get('/api', (req, res) => {
  res.json({
    name: 'PdfGenerator API',
    version: '1.0.0',
    authentication: [
      'x-api-key: demo-key',
      'Authorization: Bearer demo-key'
    ],
    endpoints: {
      health: 'GET /api/health',
      pricing: 'GET /api/pricing',
      usage: 'GET /api/usage',
      createTemplate: 'POST /api/templates',
      listTemplates: 'GET /api/templates',
      deleteTemplate: 'DELETE /api/templates/:id',
      renderPdf: 'POST /api/render',
      createBatch: 'POST /api/batches',
      getJob: 'GET /api/jobs/:id',
      downloadBatchPdf: 'GET /api/jobs/:jobId/documents/:documentId/pdf',
      checkout: 'POST /api/billing/checkout',
      activateCheckout: 'POST /api/billing/activate'
    }
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'pdf-generator-api',
    timestamp: new Date().toISOString(),
    stripeConfigured: Boolean(stripe),
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.get('/api/pricing', (req, res) => {
  res.json({
    currency: 'usd',
    plans: [
      {
        id: 'free',
        priceMonthly: 0,
        rendersPerMonth: MAX_FREE_RENDERS,
        batchSize: MAX_BATCH_SIZE
      },
      {
        id: 'starter',
        priceMonthly: 9,
        rendersPerMonth: 1000,
        batchSize: MAX_BATCH_SIZE
      },
      {
        id: 'pro',
        priceMonthly: 29,
        rendersPerMonth: 10000,
        batchSize: MAX_BATCH_SIZE
      },
      {
        id: 'business',
        priceMonthly: 79,
        rendersPerMonth: 'unlimited',
        batchSize: MAX_BATCH_SIZE
      }
    ]
  });
});

app.post('/api/billing/checkout', async (req, res, next) => {
  try {
    if (!stripe) {
      const error = new Error('Stripe billing is not configured.');
      error.status = 503;
      throw error;
    }

    const plan = String(req.body.plan || '').toLowerCase();
    const priceId = priceIdForPlan(plan);

    if (!priceId) {
      const error = new Error(
        'Plan must be starter, pro, or business, and its Stripe price ID must be configured.'
      );
      error.status = 400;
      throw error;
    }

    const apiKey = createApiKey();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],
      allow_promotion_codes: true,
      success_url: `${PUBLIC_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/billing/cancelled`,
      metadata: {
        apiKey,
        plan
      },
      subscription_data: {
        metadata: {
          apiKey,
          plan
        }
      }
    });

    return res.status(201).json({
      checkoutUrl: session.url,
      sessionId: session.id,
      plan
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/billing/activate', async (req, res, next) => {
  try {
    const sessionId = String(req.body.sessionId || '').trim();

    if (!sessionId) {
      const error = new Error('sessionId is required.');
      error.status = 400;
      throw error;
    }

    const activation = await activateCheckoutSession(sessionId);
    return res.json(activation);
  } catch (error) {
    return next(error);
  }
});

app.get('/billing/success', async (req, res) => {
  try {
    const sessionId = String(req.query.session_id || '').trim();

    if (!sessionId) {
      return res.status(400).type('html').send(
        '<!doctype html><html><body><h1>Missing checkout session</h1></body></html>'
      );
    }

    const activation = await activateCheckoutSession(sessionId);

    return res.type('html').send(
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PdfGenerator API subscription active</title>
<style>
body{font-family:Arial,sans-serif;background:#f5f7fb;color:#172033;margin:0;padding:40px}
main{max-width:720px;margin:40px auto;background:#fff;border-radius:14px;padding:32px;box-shadow:0 12px 40px rgba(20,35,70,.12)}
code{display:block;overflow-wrap:anywhere;background:#101827;color:#d8f3dc;padding:16px;border-radius:8px}
</style>
</head>
<body>
<main>
<h1>Subscription active</h1>
<p>Your ${escapeHtml(activation.plan)} API key is ready. Store it securely because it grants access to paid PDF rendering.</p>
<code>${escapeHtml(activation.apiKey)}</code>
<p>Send the key using the x-api-key header or Authorization: Bearer.</p>
</main>
</body>
</html>`
    );
  } catch (error) {
    return res.status(error.status || 500).type('html').send(
      `<!doctype html><html><body><h1>Activation failed</h1><p>${escapeHtml(
        error.message
      )}</p></body></html>`
    );
  }
});

app.get('/billing/cancelled', (req, res) => {
  res.type('html').send(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Checkout cancelled</title></head><body><h1>Checkout cancelled</h1><p>No subscription was created.</p></body></html>'
  );
});

app.use('/api', requireApiKey);

app.get('/api/usage', (req, res) => {
  const entry = getUsage(req.apiKey);
  const premium = isPremium(req.apiKey);

  res.json({
    month: entry.month,
    renders: entry.count,
    plan: premium ? 'paid' : 'free',
    limit: premium ? null : MAX_FREE_RENDERS,
    remaining: premium
      ? null
      : Math.max(0, MAX_FREE_RENDERS - entry.count)
  });
});

app.post('/api/templates', (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const html = req.body.html;

    if (!name) {
      const error = new Error('Template name is required.');
      error.status = 400;
      throw error;
    }

    validateHtml(html);

    const id = randomUUID();
    const template = {
      id,
      name,
      html,
      createdAt: new Date().toISOString()
    };

    templates.set(id, template);

    return res.status(201).json({
      id: template.id,
      name: template.name,
      createdAt: template.createdAt
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/templates', (req, res) => {
  const result = Array.from(templates.values()).map((template) => ({
    id: template.id,
    name: template.name,
    createdAt: template.createdAt
  }));

  res.json({
    templates: result
  });
});

app.delete('/api/templates/:id', (req, res) => {
  if (!templates.delete(req.params.id)) {
    return res.status(404).json({
      error: 'Template not found.'
    });
  }

  return res.status(204).end();
});

app.post('/api/render', async (req, res, next) => {
  try {
    assertAllowance(req.apiKey, 1);
    const document = prepareDocument(req.body);
    const pdf = await generatePdf(document);
    incrementUsage(req.apiKey, 1);

    const filename = String(req.body.filename || 'document.pdf')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/\.pdf$/i, '');

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}.pdf"`,
      'Content-Length': String(pdf.length),
      'Cache-Control': 'no-store'
    });

    return res.send(pdf);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/batches', (req, res, next) => {
  try {
    const documents = req.body.documents;

    if (!Array.isArray(documents) || documents.length === 0) {
      const error = new Error('documents must be a non-empty array.');
      error.status = 400;
      throw error;
    }

    if (documents.length > MAX_BATCH_SIZE) {
      const error = new Error(
        `A batch may contain at most ${MAX_BATCH_SIZE} documents.`
      );
      error.status = 400;
      throw error;
    }

    assertAllowance(req.apiKey, documents.length);

    for (const document of documents) {
      prepareDocument(document);
    }

    incrementUsage(req.apiKey, documents.length);

    const job = {
      id: randomUUID(),
      ownerApiKey: req.apiKey,
      status: 'queued',
      createdAt: new Date().toISOString(),
      completedAt: null,
      documents: documents.map(() => ({
        id: randomUUID(),
        status: 'queued',
        pdf: null,
        error: null
      }))
    };

    jobs.set(job.id, job);

    setImmediate(() => {
      processBatch(job, documents).catch((error) => {
        job.status = 'failed';
        job.completedAt = new Date().toISOString();

        for (const document of job.documents) {
          if (document.status !== 'completed') {
            document.status = 'failed';
            document.error = error.message;
          }
        }
      });
    });

    return res.status(202).json(publicJob(job));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job || job.ownerApiKey !== req.apiKey) {
    return res.status(404).json({
      error: 'Job not found.'
    });
  }

  return res.json(publicJob(job));
});

app.get(
  '/api/jobs/:jobId/documents/:documentId/pdf',
  (req, res) => {
    const job = jobs.get(req.params.jobId);

    if (!job || job.ownerApiKey !== req.apiKey) {
      return res.status(404).json({
        error: 'Job not found.'
      });
    }

    const document = job.documents.find(
      (item) => item.id === req.params.documentId
    );

    if (!document) {
      return res.status(404).json({
        error: 'Batch document not found.'
      });
    }

    if (document.status !== 'completed' || !document.pdf) {
      return res.status(409).json({
        error: 'The PDF is not ready.',
        status: document.status
      });
    }

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${document.id}.pdf"`,
      'Content-Length': String(document.pdf.length),
      'Cache-Control': 'no-store'
    });

    return res.send(document.pdf);
  }
);

app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found.'
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const status = Number.isInteger(error.status) ? error.status : 500;

  return res.status(status).json({
    error: status >= 500 ? 'Internal server error.' : error.message,
    details:
      status >= 500 && process.env.NODE_ENV !== 'production'
        ? error.message
        : undefined
  });
});

async function shutdown(signal) {
  if (server) {
    server.close();
  }

  if (browserPromise) {
    try {
      const browser = await browserPromise;
      await browser.close();
    } catch (error) {
      console.error('Browser shutdown error:', error.message);
    }
  }

  console.log(`${signal} received. Shutdown complete.`);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`PdfGenerator API listening on port ${PORT}`);
});
