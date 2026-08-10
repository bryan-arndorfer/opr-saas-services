# PdfGenerator API

Production-ready HTML-to-PDF conversion API with template support, async batch processing, PDF merging, and Stripe-powered monetization.

## Features

- **HTML/CSS to PDF**: Submit raw HTML or use saved templates with JSON data
- **Templates**: Store reusable templates with `{{variable}}` placeholders
- **Header/Footer**: Custom header/footer templates with page numbering
- **Watermarks**: Automatic watermarking on free tier
- **PDF Merging**: Combine multiple PDFs into one
- **Async Batch Processing**: Process up to 100 PDFs with webhook callbacks
- **Custom Fonts**: Upload and use custom web fonts (paid tiers)
- **PDF/A Compliance**: Generate archival-quality PDF/A documents
- **API Key Auth**: Simple Bearer token authentication
- **Rate Limiting**: Per-tier monthly render limits
- **Stripe Billing**: Subscription management via Stripe Checkout & Portal

## Quick Start

### Local Development

```bash
npm install
cp .env.example .env  # Configure your keys
npm start
```

### Deploy to Railway

1. Push this repo to GitHub
2. Connect to Railway
3. Add environment variables (see below)
4. Deploy

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `API_KEY` | Yes | Master API key for admin access |
| `STRIPE_SECRET_KEY` | No | Stripe secret key for paid tiers |
| `STRIPE_WEBHOOK_SECRET` | No | Stripe webhook signing secret |
| `STRIPE_PRICE_STARTER` | No | Stripe Price ID for Starter tier |
| `STRIPE_PRICE_PRO` | No | Stripe Price ID for Pro tier |
| `STRIPE_PRICE_ENTERPRISE` | No | Stripe Price ID for Enterprise tier |
| `NODE_ENV` | No | `production` or `development` |

## API Endpoints

### Health
```
GET /api/health
```

### Authentication
All endpoints (except `/api/health` and `/api/webhooks/stripe`) require:
```
Authorization: Bearer <your_api_key>
```

### API Keys
```
POST /api/keys           # Create new API key (tier: free|starter|pro|enterprise)
GET  /api/usage          # Check current usage and limits
```

### PDF Rendering
```
POST /api/render
```
**Body:**
```json
{
  "html": "<h1>Hello {{name}}</h1>",
  "templateId": "optional-template-id",
  "data": { "name": "World" },
  "options": {
    "format": "A4",
    "margin": { "top": "20mm", "bottom": "20mm" },
    "headerTemplate": "<div>My Header</div>",
    "footerTemplate": "<div>Page <span class='pageNumber'></span></div>",
    "pageNumbers": true,
    "watermarkText": "Custom watermark",
    "customFonts": [{ "family": "MyFont", "url": "https://...", "format": "woff2" }],
    "pdfA": false
  }
}
```
**Response:** Binary PDF (`application/pdf`)

### Templates
```
POST   /api/templates          # Create template { name, html, description }
GET    /api/templates          # List your templates
GET    /api/templates/:id      # Get template
DELETE /api/templates/:id      # Delete template
```

### Batch Processing (Paid Tiers)
```
POST /api/batch
```
**Body:**
```json
{
  "items": [
    { "html": "<h1>Doc 1</h1>" },
    { "templateId": "tpl_123", "data": { "name": "Doc 2" } }
  ],
  "webhookUrl": "https://your-app.com/webhook",
  "options": { "format": "A4" }
}
```
**Response:** `{ "jobId": "...", "status": "pending", "statusUrl": "/api/batch/..." }`

```
GET /api/batch/:jobId  # Check job status and results
```

### PDF Merging
```
POST /api/merge
Content-Type: multipart/form-data
```
Upload 2+ PDF files as `pdfs` field. Returns merged PDF.

### Billing (Stripe)
```
POST /api/billing/checkout   # Create checkout session { priceId, customerId? }
POST /api/billing/portal     # Create billing portal session
POST /api/webhooks/stripe    # Stripe webhook endpoint
```

## Tier Limits

| Feature | Free | Starter | Pro | Enterprise |
|---------|------|---------|-----|------------|
| Monthly Renders | 100 | 1,000 | 10,000 | 100,000 |
| Async Batch | ❌ | ✅ | ✅ | ✅ |
| Watermark | ✅ | ❌ | ❌ | ❌ |
| Custom Fonts | ❌ | ❌ | ✅ | ✅ |
| Priority Rendering | ❌ | ❌ | ✅ | ✅ |
| Dedicated Workers | ❌ | ❌ | ❌ | ✅ |

## Example Usage

### cURL - Simple Render
```bash
curl -X POST http://localhost:3000/api/render \
  -H "Authorization: Bearer pdfgen_abc123" \
  -H "Content-Type: application/json" \
  -d '{"html": "<h1>Hello PDF</h1><p>Generated at {{time}}</p>", "data": {"time": "2024-01-15"}}' \
  --output output.pdf
```

### cURL - With Template
```bash
# Create template
curl -X POST http://localhost:3000/api/templates \
  -H "Authorization: Bearer pdfgen_abc123" \
  -H "Content-Type: application/json" \
  -d '{"name": "invoice", "html": "<h1>Invoice {{number}}</h1><p>Amount: {{amount}}</p>"}'

# Use template
curl -X POST http://localhost:3000/api/render \
  -H "Authorization: Bearer pdfgen_abc123" \
  -H "Content-Type: application/json" \
  -d '{"templateId": "returned-template-id", "data": {"number": "INV-001", "amount": "$1,234.56"}}' \
  --output invoice.pdf
```

### JavaScript/Node.js
```javascript
const axios = require('axios');
const fs = require('fs');

const API_KEY = 'pdfgen_abc123';
const BASE_URL = 'https://your-api.railway.app';

async function generatePdf(html, options = {}) {
  const response = await axios.post(`${BASE_URL}/api/render`, { html, options }, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    responseType: 'arraybuffer'
  });
  fs.writeFileSync('output.pdf', response.data);
}

generatePdf('<h1>Hello from Node!</h1>');
```

## Webhook Payload (Batch Completion)
```json
{
  "jobId": "batch_abc123",
  "status": "completed",
  "results": [
    { "index": 0, "pdfBase64": "JVBERi0xLjQK...", "size": 45231 },
    { "index": 1, "error": "Template not found" }
  ],
  "completedAt": "2024-01-15T10:30:00.000Z"
}
```

## Architecture

- **Express.js** - HTTP server
- **Puppeteer** - Headless Chrome for PDF generation
- **pdf-lib** - PDF merging/manipulation
- **Stripe** - Subscriptions & billing portal
- **In-memory storage** - API keys, templates, usage, jobs (swap for Redis/Postgres in production)

## Scaling Notes

For production workloads:
1. Replace in-memory stores with Redis (rate limits, jobs) + PostgreSQL (templates, keys, usage)
2. Run multiple Puppeteer workers via browser pool
3. Use object storage (S3) for async batch results
4. Add request queuing (BullMQ) for batch jobs
5. Enable horizontal scaling on Railway

## License

MIT
