require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Validator } = require('jsonschema');
const { v4: uuidv4 } = require('uuid');
const puppeteer = require('puppeteer');
const { PDFDocument, rgb, degrees, StandardFonts } = require('pdf-lib');
const Stripe = require('stripe');
const { Queue } = require('bullmq');
const Redis = require('ioredis');

const app = express();
const port = Number(process.env.PORT || 3000);
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })
  : null;

const tierLimits = {
  free: {
    monthlyRenders: 100,
    async: false,
    watermark: true,
    customFonts: false
  },
  starter: {
    monthlyRenders: 1000,
    async: true,
    watermark: false,
    customFonts: true
  },
  pro: {
    monthlyRenders: 10000,
    async: true,
    watermark: false,
    customFonts: true
  },
  enterprise: {
    monthlyRenders: 100000,
    async: true,
    watermark: false,
    customFonts: true
  }
};

const apiKeys = new Map();
const usageTracker = new Map();
const templates = new Map();
let browser = null;
let redis = null;
let renderQueue = null;
let mergeQueue = null;

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
  });
  renderQueue = new Queue('pdf-render', { connection: redis });
  mergeQueue = new Queue('pdf-merge', { connection: redis });
}

templates.set('invoice', {
  html: '<main><header><h1>{{companyName}}</h1><p>Invoice #{{invoiceNumber}}</p></header><table><thead><tr><th>Item</th><th>Quantity</th><th>Price</th><th>Total</th></tr></thead><tbody>{{items}}</tbody></table><p class="total">Total: ${{total}}</p></main>',
  css: 'body{font-family:Arial,sans-serif;margin:40px;color:#172033}header{text-align:center;margin-bottom:30px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #d8deea;padding:9px;text-align:left}th{background:#f4f7fb}.total{text-align:right;font-size:20px;font-weight:700}'
});

const validator = new Validator();
const renderSchema = {
  type: 'object',
  properties: {
    html: { type: 'string', minLength: 1 },
    css: { type: 'string' },
    templateId: { type: 'string', minLength: 1 },
    data: { type: 'object' },
    options: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['A4', 'Letter', 'Legal', 'Tabloid']
        },
        margin: {
          type: 'object',
          properties: {
            top: { type: 'string' },
            right: { type: 'string' },
            bottom: { type: 'string' },
            left: { type: 'string' }
          },
          additionalProperties: false
        },
        headerTemplate: { type: 'string' },
        footerTemplate: { type: 'string' },
        displayHeaderFooter: { type: 'boolean' },
        printBackground: { type: 'boolean' },
        landscape: { type: 'boolean' },
        pageRanges: { type: 'string' },
        watermark: { type: 'string' },
        pdfa: { type: 'boolean' },
        customFonts: {
          type: 'array',
          maxItems: 10,
          items: { type: 'string', format: 'uri' }
        }
      },
      additionalProperties: false
    },
    async: { type: 'boolean' },
    webhookUrl: { type: 'string', format: 'uri' },
    mergePdfs: {
      type: 'array',
      minItems: 2,
      maxItems: 20,
      items: { type: 'string', format: 'uri' }
    }
  },
  additionalProperties: false,
  oneOf: [
    { required: ['html'] },
    { required: ['templateId', 'data'] },
    { required: ['mergePdfs'] }
  ]
};

function monthId() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
}

function generateApiKey(tier = 'free') {
  const key = `pdfgen_${tier}_${uuidv4().replace(/-/g, '')}`;
  apiKeys.set(key, {
    tier,
    createdAt: new Date().toISOString(),
    stripeCustomerId: null,
    stripeSubscriptionId: null
  });
  usageTracker.set(key, { month: monthId(), count: 0 });
  return key;
}

function getUsage(apiKey) {
  let usage = usageTracker.get(apiKey);
  if (!usage || usage.month !== monthId()) {
    usage = { month: monthId(), count: 0 };
    usageTracker.set(apiKey, usage);
  }
  return usage;
}

function authenticate(req, res, next) {
  const authorization = req.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Use the Authorization header with Bearer <api_key>'
    });
  }

  const apiKey = authorization.slice(7).trim();
  const keyRecord = apiKeys.get(apiKey);

  if (!keyRecord) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  req.apiKey = apiKey;
  req.keyRecord = keyRecord;
  req.tier = keyRecord.tier;
  req.limits = tierLimits[keyRecord.tier] || tierLimits.free;
  return next();
}

function enforceUsage(req, res, next) {
  const usage = getUsage(req.apiKey);
  if (usage.count >= req.limits.monthlyRenders) {
    return res.status(429).json({
      error: 'Monthly render limit exceeded',
      used: usage.count,
      limit: req.limits.monthlyRenders
    });
  }
  return next();
}

function incrementUsage(apiKey) {
  getUsage(apiKey).count += 1;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderTemplate(template, data) {
  const items = Array.isArray(data.items)
    ? data.items.map((item) => {
      return `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.qty)}</td><td>$${escapeHtml(item.price)}</td><td>$${escapeHtml(item.total)}</td></tr>`;
    }).join('')
    : '';

  const values = {
    companyName: data.companyName,
    invoiceNumber: data.invoiceNumber,
    total: data.total,
    items
  };

  return template.html.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
    return key === 'items' ? values.items : escapeHtml(values[key]);
  });
}

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote'
      ]
    });
  }
  return browser;
}

async function addWatermark(pdfBytes, text) {
  const pdf = await PDFDocument.load(pdfBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.min(48, Math.max(18, width / 12));
    const textWidth = font.widthOfTextAtSize(text, size);
    page.drawText(text, {
      x: (width - textWidth) / 2,
      y: height / 2,
      size,
      font,
      color: rgb(0.6, 0.6, 0.6),
      opacity: 0.3,
      rotate: degrees(-35)
    });
  }

  return Buffer.from(await pdf.save());
}

async function addArchiveMetadata(pdfBytes) {
  const pdf = await PDFDocument.load(pdfBytes);
  pdf.setTitle('Archived PDF document');
  pdf.setAuthor('PdfGenerator API');
  pdf.setCreator('PdfGenerator API');
  pdf.setProducer('PdfGenerator API');
  pdf.setCreationDate(new Date());
  pdf.setModificationDate(new Date());
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function renderPdf(html, css, options, limits) {
  const browserInstance = await getBrowser();
  const page = await browserInstance.newPage();

  try {
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('file:') || url.startsWith('ftp:')) {
        request.abort();
      } else {
        request.continue();
      }
    });

    const fontStyles = limits.customFonts && Array.isArray(options.customFonts)
      ? options.customFonts.map((fontUrl, index) => {
        return `@font-face{font-family:"CustomFont${index}";src:url("${fontUrl}") format("woff2");font-display:swap;}`;
      }).join('')
      : '';

    const documentHtml = `<!doctype html><html><head><meta charset="utf-8"><style>${fontStyles}${css || ''}</style></head><body>${html}</body></html>`;
    await page.setContent(documentHtml, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    let pdfBytes = Buffer.from(await page.pdf({
      format: options.format || 'A4',
      margin: options.margin || {
        top: '20mm',
        right: '20mm',
        bottom: '20mm',
        left: '20mm'
      },
      printBackground: options.printBackground !== false,
      landscape: Boolean(options.landscape),
      pageRanges: options.pageRanges || '',
      displayHeaderFooter: Boolean(options.displayHeaderFooter),
      headerTemplate: options.headerTemplate || '<span></span>',
      footerTemplate: options.footerTemplate || '<div style="font-size:9px;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      preferCSSPageSize: true
    }));

    if (limits.watermark) {
      pdfBytes = await addWatermark(
        pdfBytes,
        options.watermark || 'Generated by PdfGenerator API Free Tier'
      );
    } else if (options.watermark) {
      pdfBytes = await addWatermark(pdfBytes, options.watermark);
    }

    if (options.pdfa && !limits.watermark) {
      pdfBytes = await addArchiveMetadata(pdfBytes);
    }

    return pdfBytes;
  } finally {
    await page.close();
  }
}

async function mergeRemotePdfs(urls) {
  const merged = await PDFDocument.create();

  for (const url of urls) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only HTTP and HTTPS PDF URLs are supported');
    }

    const response = await fetch(parsed, {
      signal: AbortSignal.timeout(20000),
      redirect: 'follow'
    });

    if (!response.ok) {
      throw new Error(`Unable to download PDF: ${response.status}`);
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > 20 * 1024 * 1024) {
      throw new Error('A source PDF exceeds the 20 MB limit');
    }

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 20 * 1024 * 1024) {
      throw new Error('A source PDF exceeds the 20 MB limit');
    }

    const source = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(source, source.getPageIndices());
    pages.forEach((page) => merged.addPage(page));
  }

  return Buffer.from(await merged.save());
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false
}));

app.post(
  '/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(503).json({ error: 'Stripe webhook is not configured' });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.get('stripe-signature'),
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const apiKey = session.metadata && session.metadata.apiKey;
      const tier = session.metadata && session.metadata.tier;
      const keyRecord = apiKeys.get(apiKey);

      if (keyRecord && tierLimits[tier]) {
        keyRecord.tier = tier;
        keyRecord.stripeCustomerId = session.customer || null;
        keyRecord.stripeSubscriptionId = session.subscription || null;
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      for (const keyRecord of apiKeys.values()) {
        if (keyRecord.stripeSubscriptionId === subscription.id) {
          keyRecord.tier = 'free';
          keyRecord.stripeSubscriptionId = null;
        }
      }
    }

    return res.json({ received: true });
  }
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    browser: browser && browser.isConnected() ? 'connected' : 'idle',
    queue: redis ? 'configured' : 'disabled'
  });
});

app.post('/api/keys', (req, res) => {
  const apiKey = generateApiKey('free');
  res.status(201).json({
    message: 'Save this API key because it will not be shown again.',
    apiKey,
    tier: 'free',
    limits: tierLimits.free
  });
});

app.get('/api/templates', authenticate, (req, res) => {
  res.json({
    templates: Array.from(templates.keys()).map((id) => ({ id, name: id }))
  });
});

app.post('/api/templates', authenticate, (req, res) => {
  if (req.tier === 'free') {
    return res.status(403).json({ error: 'Custom templates require a paid tier' });
  }

  const { id, html, css = '' } = req.body;
  if (
    typeof id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(id) ||
    typeof html !== 'string' ||
    html.length === 0
  ) {
    return res.status(400).json({
      error: 'A valid id and non-empty html value are required'
    });
  }

  templates.set(id, { html, css });
  return res.status(201).json({ id, created: true });
});

app.get('/api/usage', authenticate, (req, res) => {
  const usage = getUsage(req.apiKey);
  const resetDate = new Date();
  resetDate.setUTCMonth(resetDate.getUTCMonth() + 1, 1);
  resetDate.setUTCHours(0, 0, 0, 0);

  res.json({
    tier: req.tier,
    used: usage.count,
    limit: req.limits.monthlyRenders,
    remaining: Math.max(0, req.limits.monthlyRenders - usage.count),
    resetDate: resetDate.toISOString()
  });
});

app.post('/api/render', authenticate, enforceUsage, async (req, res) => {
  const validation = validator.validate(req.body, renderSchema);
  if (!validation.valid) {
    return res.status(400).json({
      error: 'Invalid request body',
      details: validation.errors.map((entry) => entry.stack)
    });
  }

  const {
    html,
    css = '',
    templateId,
    data,
    options = {},
    async: asynchronous = false,
    webhookUrl,
    mergePdfs
  } = req.body;

  if (Array.isArray(mergePdfs)) {
    if (!req.limits.async) {
      return res.status(403).json({ error: 'PDF merging requires a paid tier' });
    }
    if (!webhookUrl) {
      return res.status(400).json({ error: 'webhookUrl is required for PDF merging' });
    }
    if (!mergeQueue) {
      return res.status(503).json({ error: 'Asynchronous queue is not configured' });
    }

    const jobId = uuidv4();
    await mergeQueue.add('merge', {
      jobId,
      pdfUrls: mergePdfs,
      webhookUrl,
      apiKey: req.apiKey
    });
    incrementUsage(req.apiKey);

    return res.status(202).json({ jobId, status: 'queued' });
  }

  let finalHtml = html;
  let finalCss = css;

  if (templateId) {
    const template = templates.get(templateId);
    if (!template) {
      return res.status(404).json({ error: `Template not found: ${templateId}` });
    }
    finalHtml = renderTemplate(template, data || {});
    finalCss = template.css;
  }

  if (asynchronous) {
    if (!req.limits.async) {
      return res.status(403).json({
        error: 'Asynchronous rendering requires a paid tier'
      });
    }
    if (!webhookUrl) {
      return res.status(400).json({
        error: 'webhookUrl is required for asynchronous rendering'
      });
    }
    if (!renderQueue) {
      return res.status(503).json({
        error: 'Asynchronous queue is not configured'
      });
    }

    const jobId = uuidv4();
    await renderQueue.add('render', {
      jobId,
      html: finalHtml,
      css: finalCss,
      options,
      webhookUrl,
      tier: req.tier,
      apiKey: req.apiKey
    });
    incrementUsage(req.apiKey);

    return res.status(202).json({ jobId, status: 'queued' });
  }

  try {
    const pdf = await renderPdf(finalHtml, finalCss, options, req.limits);
    incrementUsage(req.apiKey);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.length),
      'Content-Disposition': 'attachment; filename="document.pdf"',
      'Cache-Control': 'no-store'
    });
    return res.send(pdf);
  } catch (error) {
    console.error('PDF generation failed:', error);
    return res.status(500).json({
      error: 'PDF generation failed',
      message: error.message
    });
  }
});

app.post('/api/merge', authenticate, enforceUsage, async (req, res) => {
  if (req.tier === 'free') {
    return res.status(403).json({ error: 'PDF merging requires a paid tier' });
  }

  const urls = req.body.urls;
  if (!Array.isArray(urls) || urls.length < 2 || urls.length > 20) {
    return res.status(400).json({
      error: 'urls must contain between 2 and 20 PDF URLs'
    });
  }

  try {
    const pdf = await mergeRemotePdfs(urls);
    incrementUsage(req.apiKey);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.length),
      'Content-Disposition': 'attachment; filename="merged.pdf"',
      'Cache-Control': 'no-store'
    });
    return res.send(pdf);
  } catch (error) {
    return res.status(400).json({
      error: 'PDF merge failed',
      message: error.message
    });
  }
});

app.post('/api/billing/checkout', authenticate, async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe billing is not configured' });
  }

  const tier = req.body.tier;
  const prices = {
    starter: process.env.STRIPE_PRICE_STARTER,
    pro: process.env.STRIPE_PRICE_PRO,
    enterprise: process.env.STRIPE_PRICE_ENTERPRISE
  };

  if (!prices[tier]) {
    return res.status(400).json({
      error: 'Select a configured paid tier: starter, pro, or enterprise'
    });
  }

  const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: prices[tier], quantity: 1 }],
      success_url: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/billing/cancel`,
      client_reference_id: req.apiKey,
      metadata: {
        apiKey: req.apiKey,
        tier
      },
      subscription_data: {
        metadata: {
          apiKey: req.apiKey,
          tier
        }
      }
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe checkout failed:', error);
    return res.status(500).json({ error: 'Unable to create checkout session' });
  }
});

app.get('/billing/success', (req, res) => {
  res.type('html').send('<!doctype html><html><body><h1>Subscription activated</h1><p>Your API tier will update after Stripe confirms payment.</p></body></html>');
});

app.get('/billing/cancel', (req, res) => {
  res.type('html').send('<!doctype html><html><body><h1>Checkout canceled</h1><p>No changes were made to your subscription.</p></body></html>');
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((error, req, res, next) => {
  console.error('Unhandled server error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(port, () => {
  console.log(`PdfGenerator API listening on port ${port}`);
});

async function shutdown() {
  server.close(async () => {
    if (renderQueue) await renderQueue.close();
    if (mergeQueue) await mergeQueue.close();
    if (browser) await browser.close();
    if (redis) await redis.quit();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
