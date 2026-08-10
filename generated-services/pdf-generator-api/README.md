# PDF Generator API

PDF Generator API is a self-service HTML-to-PDF micro-SaaS built with Node.js, Express, Puppeteer, PDF-Lib, Redis, and Stripe.

## Features

- HTML-to-PDF rendering
- Reusable account-scoped templates
- Safe variable interpolation with nested values
- A4, Letter, Legal, A-series, landscape, margins, headers, and footers
- Automatic free-tier watermarks
- Base64 PDF merging
- API key creation and revocation
- Monthly usage quotas
- Optional Redis-backed usage counters
- Stripe subscription checkout and billing portal
- Signed Stripe webhook processing
- Temporary download URLs
- Railway health checks
- End-to-end API and PDF tests

## Plans

Free includes 100 monthly renders, 3 templates, and watermarked output.

Starter includes 2,000 monthly renders, 50 templates, and unwatermarked output.

Pro includes 15,000 monthly renders, 500 templates, and unwatermarked output.

Stripe prices are configured through STRIPE_PRICE_STARTER and STRIPE_PRICE_PRO.

## Local setup

Requirements:

- Node.js 20 or newer
- A platform supported by Puppeteer

Install dependencies:

    npm install

Copy environment configuration:

    cp .env.example .env

Start the API:

    npm start

Run the end-to-end test:

    npm test

The health endpoint is available at:

    http://localhost:3000/api/health

## Create an account

Request:

    curl -X POST http://localhost:3000/api/signup -H "Content-Type: application/json" -d '{"email":"owner@example.com"}'

The response contains the account and its first API key. The full key is only returned when it is created.

## Render a PDF

    curl -X POST http://localhost:3000/api/render -H "Content-Type: application/json" -H "X-API-Key: pdf_your_key" -d '{"html":"<html><body><h1>Hello {{customer.name}}</h1></body></html>","data":{"customer":{"name":"Acme"}},"options":{"format":"A4","pageNumbers":true}}' --output document.pdf

Set options.return to url to receive a temporary download URL instead of binary PDF data.

## Templates

Create a template:

    curl -X POST http://localhost:3000/api/templates -H "Content-Type: application/json" -H "X-API-Key: pdf_your_key" -d '{"name":"Invoice","html":"<html><body><h1>Invoice {{number}}</h1><p>Total: {{total}}</p></body></html>"}'

Render it by passing templateId and data to POST /api/render.

## Merge PDFs

POST /api/merge with a JSON body containing files, an array of at least two base64-encoded PDF strings. A merge consumes one monthly render.

## API endpoints

- GET /api/health
- POST /api/signup
- GET /api/account
- POST /api/keys
- GET /api/keys
- DELETE /api/keys/:key
- POST /api/templates
- GET /api/templates
- GET /api/templates/:id
- DELETE /api/templates/:id
- POST /api/render
- POST /api/merge
- GET /api/files/:filename
- GET /api/usage
- POST /api/billing/checkout
- POST /api/billing/portal
- POST /api/webhooks/stripe

Authenticated endpoints require the X-API-Key header.

## Stripe setup

Create recurring Starter and Pro prices in Stripe and assign their IDs to STRIPE_PRICE_STARTER and STRIPE_PRICE_PRO.

Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.

Configure the Stripe webhook endpoint as:

    https://your-domain.example/api/webhooks/stripe

Subscribe it to:

- checkout.session.completed
- customer.subscription.updated
- customer.subscription.deleted

Create a checkout session:

    curl -X POST https://your-domain.example/api/billing/checkout -H "Content-Type: application/json" -H "X-API-Key: pdf_your_key" -d '{"plan":"starter"}'

The API determines the active plan from the subscription's Stripe price rather than trusting client metadata.

## Railway deployment

1. Push the repository to GitHub.
2. Create a Railway project from the GitHub repository.
3. Add a persistent volume mounted at /data.
4. Set DATA_DIR to /data.
5. Set BASE_URL to the public Railway domain.
6. Add a Railway Redis service and set REDIS_URL.
7. Add the Stripe environment variables.
8. Deploy the service.
9. Confirm that GET /api/health returns status ok.
10. Run npm test locally before promoting changes.

The railway.json file installs production dependencies, starts the server, and configures the health check.

## Storage

Account, key, template, and Stripe customer state is stored in DATA_DIR/state.json. Mount DATA_DIR on a Railway persistent volume in production.

Generated URL-returned PDFs are stored under DATA_DIR/files and expire after 24 hours.

Redis is optional. When configured, it stores monthly usage counters. Without Redis, counters are persisted in state.json.

## Security behavior

- API keys use 192 bits of cryptographically secure random data.
- Stripe webhook signatures are verified against the raw request body.
- Template variables are HTML escaped.
- JavaScript is disabled during rendering unless options.allowJavaScript is explicitly true.
- Request bodies are limited to 12 MB.
- HTML and templates are limited to 5 MB.
- Download filenames are strictly validated.
- Chromium runs with Railway-compatible sandbox flags.
- Account data is isolated by API key ownership.
