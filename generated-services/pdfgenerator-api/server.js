require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const Stripe = require('stripe');
const {
  PDFDocument,
  StandardFonts,
  rgb
} = require('pdf-lib');
const { RateLimiterMemory } = require('rate-limiter-flexible');

const app = express();
const port = Number(process.env.PORT || 3000);
const requestBodyLimit = 512 * 1024;
const serviceName = 'pdfgenerator-api';
const serviceVersion = '1.0.1';

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const freeLimiter = new RateLimiterMemory({
  keyPrefix: 'pdf-free-render',
  points: 10,
  duration: 60 * 60
});

const paidLimiter = new RateLimiterMemory({
  keyPrefix: 'pdf-paid-render',
  points: 1000,
  duration: 60 * 60
});

const billingCache = new Map();

const templates = Object.freeze({
  invoice: [
    '<h1>Invoice {{invoiceNumber}}</h1>',
    '<p><strong>From:</strong> {{from}}</p>',
    '<p><strong>Bill to:</strong> {{customer}}</p>',
    '<p><strong>Date:</strong> {{date}}</p>',
    '<hr>',
    '<h2>{{item}}</h2>',
    '<p>Quantity: {{quantity}}</p>',
    '<p>Unit price: {{unitPrice}}</p>',
    '<p><strong>Total: {{total}}</strong></p>',
    '<hr>',
    '<p>{{notes}}</p>'
  ].join(''),
  report: [
    '<h1>{{title}}</h1>',
    '<p><strong>Prepared by:</strong> {{author}}</p>',
    '<p><strong>Date:</strong> {{date}}</p>',
    '<hr>',
    '<h2>Summary</h2>',
    '<p>{{summary}}</p>',
    '<h2>Details</h2>',
    '<p>{{details}}</p>'
  ].join(''),
  letter: [
    '<p>{{date}}</p>',
    '<p>{{recipient}}</p>',
    '<p>{{address}}</p>',
    '<br>',
    '<p>Dear {{salutation}},</p>',
    '<p>{{body}}</p>',
    '<p>Sincerely,</p>',
    '<p>{{sender}}</p>'
  ].join('')
});

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({
  limit: requestBodyLimit,
  type: ['application/json', 'application/*+json']
}));

function getNestedValue(value, path) {
  return path.split('.').reduce((current, key) => {
    if (
      current === null ||
      current === undefined ||
      typeof current !== 'object'
    ) {
      return undefined;
    }
    return current[key];
  }, value);
}

function interpolate(content, data) {
  return String(content).replace(
    /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
    (match, key) => {
      const value = getNestedValue(data, key);

      if (value === null || value === undefined) {
        return '';
      }

      if (typeof value === 'object') {
        return JSON.stringify(value);
      }

      return String(value);
    }
  );
}

function safeCodePoint(code, fallback) {
  if (
    !Number.isInteger(code) ||
    code < 0 ||
    code > 0x10ffff ||
    (code >= 0xd800 && code <= 0xdfff)
  ) {
    return fallback;
  }

  return String.fromCodePoint(code);
}

function decodeEntities(value) {
  const namedEntities = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    copy: '(c)',
    reg: '(R)',
    trade: '(TM)',
    ndash: '-',
    mdash: '--',
    hellip: '...',
    bull: '*'
  };

  return String(value)
    .replace(/&#x([0-9a-fA-F]+);/g, (match, code) => {
      return safeCodePoint(parseInt(code, 16), match);
    })
    .replace(/&#(\d+);/g, (match, code) => {
      return safeCodePoint(Number(code), match);
    })
    .replace(/&([a-zA-Z]+);/g, (match, name) => {
      return Object.prototype.hasOwnProperty.call(namedEntities, name)
        ? namedEntities[name]
        : match;
    });
}

function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*li\b[^>]*>/gi, '\n- ')
      .replace(
        /<\s*\/\s*(p|div|section|article|header|footer|h1|h2|h3|h4|h5|h6|li|tr|blockquote)\s*>/gi,
        '\n'
      )
      .replace(
        /<\s*(p|div|section|article|header|footer|h1|h2|h3|h4|h5|h6|tr|blockquote)\b[^>]*>/gi,
        '\n'
      )
      .replace(/<\s*hr\s*\/?>/gi, '\n------------------------\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizePdfText(value) {
  const replacements = new Map([
    ['\u2018', "'"],
    ['\u2019', "'"],
    ['\u201a', "'"],
    ['\u201c', '"'],
    ['\u201d', '"'],
    ['\u201e', '"'],
    ['\u2013', '-'],
    ['\u2014', '--'],
    ['\u2022', '*'],
    ['\u2026', '...'],
    ['\u00a0', ' '],
    ['\u20ac', 'EUR'],
    ['\u2122', '(TM)']
  ]);

  let output = '';

  for (const character of String(value).normalize('NFKD')) {
    if (replacements.has(character)) {
      output += replacements.get(character);
      continue;
    }

    const code = character.codePointAt(0);

    if (code === 10 || code === 9) {
      output += character;
    } else if (code >= 32 && code <= 126) {
      output += character;
    } else if (code >= 160 && code <= 255) {
      output += character;
    } else if (code >= 0x300 && code <= 0x36f) {
      continue;
    } else {
      output += '?';
    }
  }

  return output;
}

function parseFontSize(css) {
  const match = String(css).match(
    /font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/i
  );

  if (!match) {
    return 12;
  }

  return Math.min(24, Math.max(8, Number(match[1])));
}

function parseTextColor(css) {
  const sixDigitMatch = String(css).match(
    /(?:^|[;{\s])color\s*:\s*#([0-9a-fA-F]{6})(?:\s*[;} ]|$)/i
  );

  if (sixDigitMatch) {
    const hex = sixDigitMatch[1];
    return rgb(
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255
    );
  }

  const threeDigitMatch = String(css).match(
    /(?:^|[;{\s])color\s*:\s*#([0-9a-fA-F]{3})(?:\s*[;} ]|$)/i
  );

  if (threeDigitMatch) {
    const hex = threeDigitMatch[1];
    return rgb(
      parseInt(hex[0] + hex[0], 16) / 255,
      parseInt(hex[1] + hex[1], 16) / 255,
      parseInt(hex[2] + hex[2], 16) / 255
    );
  }

  return rgb(0.12, 0.12, 0.12);
}

function splitLongWord(word, font, fontSize, maxWidth) {
  const segments = [];
  let segment = '';

  for (const character of word) {
    const candidate = segment + character;

    if (
      segment &&
      font.widthOfTextAtSize(candidate, fontSize) > maxWidth
    ) {
      segments.push(segment);
      segment = character;
    } else {
      segment = candidate;
    }
  }

  if (segment) {
    segments.push(segment);
  }

  return segments;
}

function wrapText(text, font, fontSize, maxWidth) {
  const output = [];

  for (const paragraph of String(text).split('\n')) {
    if (!paragraph.trim()) {
      output.push('');
      continue;
    }

    const words = paragraph.trim().split(/\s+/);
    let line = '';

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;

      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
        line = candidate;
        continue;
      }

      if (line) {
        output.push(line);
        line = '';
      }

      if (font.widthOfTextAtSize(word, fontSize) <= maxWidth) {
        line = word;
        continue;
      }

      const segments = splitLongWord(word, font, fontSize, maxWidth);

      while (segments.length > 1) {
        output.push(segments.shift());
      }

      line = segments[0] || '';
    }

    if (line) {
      output.push(line);
    }
  }

  return output;
}

async function createPdf(text, css, metadata) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const normalizedText = normalizePdfText(text);
  const fontSize = parseFontSize(css);
  const color = parseTextColor(css);
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 54;
  const lineHeight = fontSize * 1.45;
  const printableWidth = pageWidth - margin * 2;
  const lines = wrapText(
    normalizedText,
    font,
    fontSize,
    printableWidth
  );

  document.setTitle(metadata.title);
  document.setAuthor('PdfGenerator API');
  document.setCreator('PdfGenerator API');
  document.setProducer('PdfGenerator API');
  document.setCreationDate(new Date());
  document.setModificationDate(new Date());

  let page = document.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  for (const line of lines.length ? lines : ['']) {
    if (y < margin + lineHeight) {
      page = document.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }

    if (line) {
      page.drawText(line, {
        x: margin,
        y,
        size: fontSize,
        font,
        color
      });
    }

    y -= lineHeight;
  }

  return Buffer.from(await document.save());
}

function apiKeySecret() {
  return process.env.API_KEY_SECRET || '';
}

function createApiKey(sessionId) {
  const secret = apiKeySecret();

  if (!secret) {
    throw new Error('API_KEY_SECRET is not configured');
  }

  const payload = Buffer.from(JSON.stringify({
    version: 1,
    product: serviceName,
    sessionId
  })).toString('base64url');

  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');

  return `pdf_live_${payload}.${signature}`;
}

function parseApiKey(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.startsWith('pdf_live_')) {
    return null;
  }

  const token = apiKey.slice('pdf_live_'.length);
  const separatorIndex = token.lastIndexOf('.');

  if (separatorIndex < 1) {
    return null;
  }

  const payload = token.slice(0, separatorIndex);
  const providedSignature = token.slice(separatorIndex + 1);
  const secret = apiKeySecret();

  if (!secret || !providedSignature) {
    return null;
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');

  const providedBuffer = Buffer.from(providedSignature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    );

    if (
      decoded.version !== 1 ||
      decoded.product !== serviceName ||
      typeof decoded.sessionId !== 'string' ||
      !decoded.sessionId.startsWith('cs_')
    ) {
      return null;
    }

    return decoded;
  } catch (error) {
    return null;
  }
}

async function verifyPaidSession(sessionId) {
  const cached = billingCache.get(sessionId);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.active;
  }

  if (!stripe) {
    return false;
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription']
    });

    const subscription = session.subscription;
    const subscriptionActive = Boolean(
      subscription &&
      typeof subscription === 'object' &&
      ['active', 'trialing'].includes(subscription.status)
    );

    const correctProduct = Boolean(
      session.metadata &&
      session.metadata.product === serviceName
    );

    const active = correctProduct && subscriptionActive;

    billingCache.set(sessionId, {
      active,
      expiresAt: Date.now() + 5 * 60 * 1000
    });

    return active;
  } catch (error) {
    return false;
  }
}

function extractApiKey(req) {
  const authorization = req.get('authorization') || '';

  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }

  return (req.get('x-api-key') || '').trim();
}

function limiterErrorResponse(error, res) {
  const retryAfter = Math.max(
    1,
    Math.ceil(Number(error.msBeforeNext || 60000) / 1000)
  );

  res.set('Retry-After', String(retryAfter));

  return res.status(429).json({
    error: 'Render limit exceeded.',
    retryAfterSeconds: retryAfter
  });
}

async function applyRenderLimit(req, res, next) {
  const apiKey = extractApiKey(req);

  if (apiKey) {
    const keyData = parseApiKey(apiKey);

    if (!keyData || !(await verifyPaidSession(keyData.sessionId))) {
      return res.status(401).json({
        error: 'Invalid or inactive API key.'
      });
    }

    try {
      const limiterKey = crypto
        .createHash('sha256')
        .update(apiKey)
        .digest('hex');

      await paidLimiter.consume(limiterKey);
      req.plan = 'paid';
      return next();
    } catch (error) {
      return limiterErrorResponse(error, res);
    }
  }

  try {
    await freeLimiter.consume(req.ip || 'unknown');
    req.plan = 'free';
    return next();
  } catch (error) {
    return limiterErrorResponse(error, res);
  }
}

function publicBaseUrl(req) {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/+$/, '');
  }

  return `${req.protocol}://${req.get('host')}`;
}

function sanitizeFilename(filename) {
  const baseName = String(filename || 'document')
    .replace(/[\r\n]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/\.pdf$/i, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);

  return `${baseName || 'document'}.pdf`;
}

app.get('/', (req, res) => {
  res.json({
    name: 'PdfGenerator API',
    version: serviceVersion,
    documentation: '/api/docs',
    health: '/api/health'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'UP',
    service: serviceName,
    version: serviceVersion,
    billingConfigured: Boolean(
      stripe &&
      process.env.STRIPE_PRICE_ID &&
      process.env.API_KEY_SECRET
    ),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/docs', (req, res) => {
  res.json({
    name: 'PdfGenerator API',
    version: serviceVersion,
    endpoints: {
      health: {
        method: 'GET',
        path: '/api/health'
      },
      templates: {
        method: 'GET',
        path: '/api/templates'
      },
      render: {
        method: 'POST',
        path: '/api/render',
        contentType: 'application/json',
        responseType: 'application/pdf'
      },
      checkout: {
        method: 'POST',
        path: '/api/billing/checkout'
      },
      activation: {
        method: 'POST',
        path: '/api/billing/activate'
      }
    },
    renderExample: {
      html: '<h1>Invoice</h1><p>Total: $25.00</p>',
      css: 'body { font-size: 12px; color: #222222; }',
      filename: 'document.pdf',
      title: 'Generated document'
    },
    templateExample: {
      templateId: 'invoice',
      jsonData: {
        invoiceNumber: 'INV-1001',
        total: '$25.00'
      }
    },
    authentication: {
      free: 'No API key required. Limited to 10 renders per hour per IP.',
      paid: 'Send the key as a Bearer token or through the x-api-key header.'
    }
  });
});

app.get('/api/templates', (req, res) => {
  res.json({
    templates: Object.keys(templates)
  });
});

app.post('/api/render', applyRenderLimit, async (req, res, next) => {
  try {
    const body = req.body || {};
    const html = body.html;
    const css = body.css === undefined ? '' : body.css;
    const templateId = body.templateId;
    const jsonData = body.jsonData === undefined ? {} : body.jsonData;
    const filename = body.filename === undefined
      ? 'document.pdf'
      : body.filename;
    const title = body.title === undefined
      ? 'Generated PDF'
      : body.title;

    if (
      (html === undefined || html === '') &&
      (templateId === undefined || templateId === '')
    ) {
      return res.status(400).json({
        error: 'Provide html or templateId.'
      });
    }

    if (html !== undefined && typeof html !== 'string') {
      return res.status(400).json({
        error: 'html must be a string.'
      });
    }

    if (
      templateId !== undefined &&
      (
        typeof templateId !== 'string' ||
        !Object.prototype.hasOwnProperty.call(templates, templateId)
      )
    ) {
      return res.status(400).json({
        error: `Unknown templateId. Available templates: ${Object.keys(templates).join(', ')}.`
      });
    }

    if (typeof css !== 'string') {
      return res.status(400).json({
        error: 'css must be a string.'
      });
    }

    if (
      jsonData === null ||
      Array.isArray(jsonData) ||
      typeof jsonData !== 'object'
    ) {
      return res.status(400).json({
        error: 'jsonData must be an object.'
      });
    }

    if (typeof filename !== 'string') {
      return res.status(400).json({
        error: 'filename must be a string.'
      });
    }

    if (typeof title !== 'string') {
      return res.status(400).json({
        error: 'title must be a string.'
      });
    }

    const source = html || templates[templateId];
    const renderedHtml = interpolate(source, jsonData);
    const text = htmlToText(renderedHtml);

    if (!text) {
      return res.status(400).json({
        error: 'The rendered document contains no printable text.'
      });
    }

    const pdf = await createPdf(text, css, {
      title: title.slice(0, 200)
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${sanitizeFilename(filename)}"`,
      'Content-Length': String(pdf.length),
      'X-Usage-Plan': req.plan,
      'Cache-Control': 'no-store'
    });

    return res.send(pdf);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/billing/checkout', async (req, res, next) => {
  try {
    if (
      !stripe ||
      !process.env.STRIPE_PRICE_ID ||
      !process.env.API_KEY_SECRET
    ) {
      return res.status(503).json({
        error: 'Paid billing is not configured.'
      });
    }

    const baseUrl = publicBaseUrl(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1
        }
      ],
      allow_promotion_codes: true,
      success_url: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/billing/cancelled`,
      metadata: {
        product: serviceName
      },
      subscription_data: {
        metadata: {
          product: serviceName
        }
      }
    });

    return res.status(201).json({
      checkoutUrl: session.url,
      sessionId: session.id
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/billing/activate', async (req, res, next) => {
  try {
    if (
      !stripe ||
      !process.env.STRIPE_PRICE_ID ||
      !process.env.API_KEY_SECRET
    ) {
      return res.status(503).json({
        error: 'Paid billing is not configured.'
      });
    }

    const sessionId = req.body && req.body.sessionId;

    if (
      typeof sessionId !== 'string' ||
      !sessionId.startsWith('cs_')
    ) {
      return res.status(400).json({
        error: 'A valid Stripe Checkout sessionId is required.'
      });
    }

    if (!(await verifyPaidSession(sessionId))) {
      return res.status(402).json({
        error: 'The Checkout session does not have an active paid subscription.'
      });
    }

    return res.json({
      apiKey: createApiKey(sessionId),
      plan: 'paid',
      hourlyRenderLimit: 1000,
      instructions: 'Store this key securely and send it as a Bearer token or x-api-key header.'
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/billing/success', (req, res) => {
  const sessionId = typeof req.query.session_id === 'string'
    ? req.query.session_id
    : '';

  res.type('html').send([
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>PdfGenerator API activation</title>',
    '<style>',
    'body{font-family:system-ui,sans-serif;max-width:760px;margin:60px auto;padding:0 20px;color:#171717}',
    'pre{white-space:pre-wrap;word-break:break-all;background:#f4f4f5;padding:16px;border-radius:8px}',
    '.error{color:#b91c1c}',
    '</style>',
    '</head>',
    '<body>',
    '<h1>Activate your API key</h1>',
    '<p id="status">Verifying your subscription...</p>',
    '<pre id="key"></pre>',
    '<script>',
    `const sessionId=${JSON.stringify(sessionId)};`,
    'async function activate(){',
    'const status=document.getElementById("status");',
    'const key=document.getElementById("key");',
    'if(!sessionId){status.textContent="Missing Checkout session.";status.className="error";return;}',
    'try{',
    'const response=await fetch("/api/billing/activate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId})});',
    'const result=await response.json();',
    'if(!response.ok){throw new Error(result.error||"Activation failed.");}',
    'status.textContent="Your paid API key is ready. Copy it now and store it securely.";',
    'key.textContent=result.apiKey;',
    '}catch(error){status.textContent=error.message;status.className="error";}',
    '}',
    'activate();',
    '</script>',
    '</body>',
    '</html>'
  ].join(''));
});

app.get('/billing/cancelled', (req, res) => {
  res.type('html').send([
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Checkout cancelled</title>',
    '</head>',
    '<body style="font-family:system-ui,sans-serif;max-width:720px;margin:60px auto;padding:0 20px">',
    '<h1>Checkout cancelled</h1>',
    '<p>No subscription was created. The free API tier remains available.</p>',
    '</body>',
    '</html>'
  ].join(''));
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found.'
  });
});

app.use((error, req, res, next) => {
  console.error(error);

  if (error && error.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Request body exceeds the 512 KB limit.'
    });
  }

  if (
    error instanceof SyntaxError &&
    error.status === 400 &&
    Object.prototype.hasOwnProperty.call(error, 'body')
  ) {
    return res.status(400).json({
      error: 'Request body contains invalid JSON.'
    });
  }

  return res.status(500).json({
    error: 'Internal server error.'
  });
});

if (require.main === module) {
  const server = app.listen(port, () => {
    console.log(`PdfGenerator API listening on port ${port}`);
  });

  function shutdown(signal) {
    console.log(`${signal} received, closing HTTP server`);

    server.close((error) => {
      if (error) {
        console.error(error);
        process.exit(1);
      }

      process.exit(0);
    });

    setTimeout(() => {
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
