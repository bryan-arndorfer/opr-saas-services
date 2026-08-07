'use strict';

const express = require('express');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb
} = require('pdf-lib');

const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const FREE_MONTHLY_LIMIT = Number.parseInt(
  process.env.FREE_MONTHLY_LIMIT || '100',
  10
);
const MAX_HTML_BYTES = Number.parseInt(
  process.env.MAX_HTML_BYTES || '2000000',
  10
);
const MAX_BATCH_SIZE = Number.parseInt(
  process.env.MAX_BATCH_SIZE || '20',
  10
);
const JOB_TTL_MS = Number.parseInt(
  process.env.JOB_TTL_MS || '3600000',
  10
);

function parseKeyList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const configuredKeys = parseKeyList(process.env.API_KEYS || 'dev-key');
const unlimitedKeys = new Set(parseKeyList(process.env.UNLIMITED_KEYS));
const validKeys = new Set([...configuredKeys, ...unlimitedKeys]);

const usage = new Map();
const jobs = new Map();
let browserPromise = null;

app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function usageId(apiKey) {
  return `${currentMonth()}:${apiKey}`;
}

function getUsage(apiKey) {
  return usage.get(usageId(apiKey)) || 0;
}

function isUnlimited(apiKey) {
  return unlimitedKeys.has(apiKey);
}

function claimRender(apiKey) {
  if (isUnlimited(apiKey)) {
    return {
      allowed: true,
      count: getUsage(apiKey),
      limit: null
    };
  }

  const id = usageId(apiKey);
  const count = usage.get(id) || 0;

  if (count >= FREE_MONTHLY_LIMIT) {
    return {
      allowed: false,
      count,
      limit: FREE_MONTHLY_LIMIT
    };
  }

  usage.set(id, count + 1);

  return {
    allowed: true,
    count: count + 1,
    limit: FREE_MONTHLY_LIMIT
  };
}

function releaseRender(apiKey) {
  if (isUnlimited(apiKey)) {
    return;
  }

  const id = usageId(apiKey);
  const count = usage.get(id) || 0;

  if (count <= 1) {
    usage.delete(id);
  } else {
    usage.set(id, count - 1);
  }
}

function safeKeyEquals(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function authenticate(req, res, next) {
  const suppliedKey = req.get('x-api-key') || '';

  const matchedKey = [...validKeys].find((key) =>
    safeKeyEquals(key, suppliedKey)
  );

  if (!matchedKey) {
    return res.status(401).json({
      error: 'invalid_api_key',
      message: 'Provide a valid API key in the x-api-key header.'
    });
  }

  req.apiKey = matchedKey;
  req.plan = isUnlimited(matchedKey) ? 'paid' : 'free';
  return next();
}

async function getBrowser() {
  if (!browserPromise) {
    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    };

    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    browserPromise = puppeteer.launch(launchOptions);

    browserPromise
      .then((browser) => {
        browser.once('disconnected', () => {
          browserPromise = null;
        });
      })
      .catch(() => {
        browserPromise = null;
      });
  }

  return browserPromise;
}

function readPath(source, path) {
  return path.split('.').reduce((value, part) => {
    if (
      value !== null &&
      typeof value === 'object' &&
      Object.prototype.hasOwnProperty.call(value, part)
    ) {
      return value[part];
    }

    return '';
  }, source);
}

function renderTemplate(html, data) {
  return html.replace(
    /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
    (match, key) => {
      const value = readPath(data, key);

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

function normalizeMargin(margin) {
  const defaultMargin = {
    top: '10mm',
    right: '10mm',
    bottom: '10mm',
    left: '10mm'
  };

  if (!margin || typeof margin !== 'object' || Array.isArray(margin)) {
    return defaultMargin;
  }

  return {
    top: String(margin.top || defaultMargin.top),
    right: String(margin.right || defaultMargin.right),
    bottom: String(margin.bottom || defaultMargin.bottom),
    left: String(margin.left || defaultMargin.left)
  };
}

function normalizePdfOptions(options) {
  const supplied = options && typeof options === 'object' ? options : {};
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

  const normalized = {
    printBackground: supplied.printBackground !== false,
    landscape: supplied.landscape === true,
    preferCSSPageSize: supplied.preferCSSPageSize === true,
    margin: normalizeMargin(supplied.margin)
  };

  if (supplied.width || supplied.height) {
    if (supplied.width) {
      normalized.width = String(supplied.width);
    }

    if (supplied.height) {
      normalized.height = String(supplied.height);
    }
  } else {
    normalized.format = allowedFormats.has(supplied.format)
      ? supplied.format
      : 'A4';
  }

  if (supplied.scale !== undefined) {
    const scale = Number(supplied.scale);
    normalized.scale = Number.isFinite(scale)
      ? Math.min(2, Math.max(0.1, scale))
      : 1;
  }

  return normalized;
}

async function applyWatermark(pdfBytes, watermarkText) {
  const document = await PDFDocument.load(pdfBytes);
  const font = await document.embedFont(StandardFonts.HelveticaBold);
  const text = String(watermarkText).slice(0, 200);

  for (const page of document.getPages()) {
    const { width, height } = page.getSize();
    const fontSize = Math.max(18, Math.min(42, width / 14));
    const textWidth = font.widthOfTextAtSize(text, fontSize);

    page.drawText(text, {
      x: Math.max(12, (width - textWidth) / 2),
      y: height / 2,
      size: fontSize,
      font,
      color: rgb(0.55, 0.55, 0.55),
      opacity: 0.24,
      rotate: degrees(35)
    });
  }

  return Buffer.from(await document.save());
}

async function createPdf(payload, plan) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('The request body must be a JSON object.');
  }

  if (typeof payload.html !== 'string' || payload.html.trim() === '') {
    throw new Error('The html field must be a non-empty string.');
  }

  if (Buffer.byteLength(payload.html, 'utf8') > MAX_HTML_BYTES) {
    throw new Error(`HTML exceeds the ${MAX_HTML_BYTES}-byte limit.`);
  }

  const data =
    payload.data &&
    typeof payload.data === 'object' &&
    !Array.isArray(payload.data)
      ? payload.data
      : {};

  const html = renderTemplate(payload.html, data);
  const timeoutValue = Number(payload.timeout);
  const timeout = Number.isFinite(timeoutValue)
    ? Math.min(120000, Math.max(1000, timeoutValue))
    : 30000;

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setContent(html, {
      waitUntil: 'networkidle0',
      timeout
    });

    const pdfBytes = Buffer.from(
      await page.pdf(normalizePdfOptions(payload.options))
    );

    const requestedWatermark =
      typeof payload.watermark === 'string'
        ? payload.watermark.trim()
        : '';

    if (plan === 'free') {
      return applyWatermark(
        pdfBytes,
        requestedWatermark || 'Generated by PdfGenerator API'
      );
    }

    if (requestedWatermark) {
      return applyWatermark(pdfBytes, requestedWatermark);
    }

    return pdfBytes;
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function renderWithQuota(apiKey, plan, payload) {
  const quota = claimRender(apiKey);

  if (!quota.allowed) {
    const error = new Error(
      `The free monthly limit of ${FREE_MONTHLY_LIMIT} renders has been reached.`
    );
    error.statusCode = 429;
    error.code = 'monthly_limit_reached';
    throw error;
  }

  try {
    return await createPdf(payload, plan);
  } catch (error) {
    releaseRender(apiKey);
    throw error;
  }
}

function publicJob(job) {
  const response = {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    total: job.total
  };

  if (job.status === 'completed') {
    response.results = job.results;
  }

  if (job.status === 'failed') {
    response.error = job.error;
  }

  return response;
}

async function processBatch(job, apiKey, plan, documents) {
  job.status = 'processing';

  try {
    const results = [];

    for (let index = 0; index < documents.length; index += 1) {
      const pdf = await renderWithQuota(apiKey, plan, documents[index]);

      results.push({
        index,
        contentType: 'application/pdf',
        pdfBase64: pdf.toString('base64')
      });
    }

    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.results = results;
  } catch (error) {
    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = {
      code: error.code || 'batch_render_failed',
      message: error.message
    };
  }
}

app.get('/', (req, res) => {
  res.json({
    name: 'PdfGenerator API',
    version: '1.0.0',
    health: '/api/health',
    render: '/api/render',
    batch: '/api/batch',
    merge: '/api/merge'
  });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'pdfgenerator-api',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.get('/api/usage', authenticate, (req, res) => {
  const unlimited = req.plan === 'paid';

  res.json({
    plan: req.plan,
    month: currentMonth(),
    rendersUsed: getUsage(req.apiKey),
    rendersLimit: unlimited ? null : FREE_MONTHLY_LIMIT,
    rendersRemaining: unlimited
      ? null
      : Math.max(0, FREE_MONTHLY_LIMIT - getUsage(req.apiKey))
  });
});

app.post('/api/render', authenticate, async (req, res, next) => {
  try {
    const pdf = await renderWithQuota(req.apiKey, req.plan, req.body);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="document.pdf"',
      'Content-Length': String(pdf.length),
      'X-Plan': req.plan,
      'X-Renders-Used': String(getUsage(req.apiKey)),
      'X-Renders-Limit':
        req.plan === 'paid' ? 'unlimited' : String(FREE_MONTHLY_LIMIT)
    });

    return res.status(200).send(pdf);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/batch', authenticate, (req, res, next) => {
  try {
    const documents = req.body && req.body.documents;

    if (!Array.isArray(documents) || documents.length === 0) {
      const error = new Error(
        'The documents field must be a non-empty array.'
      );
      error.statusCode = 400;
      throw error;
    }

    if (documents.length > MAX_BATCH_SIZE) {
      const error = new Error(
        `A batch may contain at most ${MAX_BATCH_SIZE} documents.`
      );
      error.statusCode = 400;
      throw error;
    }

    const job = {
      id: crypto.randomUUID(),
      ownerKeyHash: crypto
        .createHash('sha256')
        .update(req.apiKey)
        .digest('hex'),
      status: 'queued',
      createdAt: new Date().toISOString(),
      completedAt: null,
      total: documents.length,
      results: null,
      error: null
    };

    jobs.set(job.id, job);

    const cleanupTimer = setTimeout(() => {
      jobs.delete(job.id);
    }, JOB_TTL_MS);
    cleanupTimer.unref();

    setImmediate(() => {
      processBatch(job, req.apiKey, req.plan, documents);
    });

    return res.status(202).json({
      id: job.id,
      status: job.status,
      statusUrl: `/api/jobs/${job.id}`,
      expiresInSeconds: Math.floor(JOB_TTL_MS / 1000)
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/jobs/:id', authenticate, (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      error: 'job_not_found',
      message: 'The job does not exist or has expired.'
    });
  }

  const requesterHash = crypto
    .createHash('sha256')
    .update(req.apiKey)
    .digest('hex');

  if (!safeKeyEquals(job.ownerKeyHash, requesterHash)) {
    return res.status(404).json({
      error: 'job_not_found',
      message: 'The job does not exist or has expired.'
    });
  }

  return res.json(publicJob(job));
});

app.post('/api/merge', authenticate, async (req, res, next) => {
  try {
    const pdfs = req.body && req.body.pdfs;

    if (!Array.isArray(pdfs) || pdfs.length < 2) {
      const error = new Error(
        'The pdfs field must contain at least two base64-encoded PDFs.'
      );
      error.statusCode = 400;
      throw error;
    }

    if (pdfs.length > MAX_BATCH_SIZE) {
      const error = new Error(
        `At most ${MAX_BATCH_SIZE} PDFs may be merged at once.`
      );
      error.statusCode = 400;
      throw error;
    }

    const merged = await PDFDocument.create();

    for (const encodedPdf of pdfs) {
      if (typeof encodedPdf !== 'string' || encodedPdf.trim() === '') {
        const error = new Error(
          'Every item in pdfs must be a base64-encoded PDF string.'
        );
        error.statusCode = 400;
        throw error;
      }

      const sourceBytes = Buffer.from(encodedPdf, 'base64');
      const source = await PDFDocument.load(sourceBytes);
      const pages = await merged.copyPages(
        source,
        source.getPageIndices()
      );

      for (const page of pages) {
        merged.addPage(page);
      }
    }

    let result = Buffer.from(await merged.save());

    if (req.plan === 'free') {
      result = await applyWatermark(
        result,
        'Generated by PdfGenerator API'
      );
    }

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="merged.pdf"',
      'Content-Length': String(result.length),
      'X-Plan': req.plan
    });

    return res.status(200).send(result);
  } catch (error) {
    return next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    message: 'The requested endpoint does not exist.'
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const statusCode =
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode < 600
      ? error.statusCode
      : error instanceof SyntaxError
        ? 400
        : 500;

  const code =
    error.code ||
    (statusCode === 400 ? 'invalid_request' : 'internal_error');

  return res.status(statusCode).json({
    error: code,
    message:
      statusCode === 500
        ? 'The request could not be completed.'
        : error.message
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(
    `PdfGenerator API listening on port ${PORT}\n`
  );
});

async function shutdown(signal) {
  process.stdout.write(`Received ${signal}; shutting down\n`);

  server.close(async () => {
    if (browserPromise) {
      try {
        const browser = await browserPromise;
        await browser.close();
      } catch (error) {
        process.stderr.write(
          `Browser shutdown error: ${error.message}\n`
        );
      }
    }

    process.exit(0);
  });

  const forceTimer = setTimeout(() => {
    process.exit(1);
  }, 10000);
  forceTimer.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
