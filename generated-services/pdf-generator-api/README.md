# PDF Generator API

PDF Generator API is a self-service HTML-to-PDF micro-SaaS built with Express, Puppeteer, PDF-Lib, Stripe, and Railway.

## Features

- HTML and CSS to PDF conversion
- Reusable user-owned templates
- Template variable interpolation
- Page formats, margins, landscape mode, headers, and footers
- Free-tier PDF watermarking
- PDF merging
- API-key authentication
- Monthly usage quotas
- Stripe subscription checkout
- Stripe webhook-based plan activation and cancellation
- JSON-file persistence
- Railway health checks
- Docker deployment
- End-to-end health, registration, rendering, and usage test

Remote HTTP and HTTPS resources referenced by submitted HTML are blocked during rendering. Inline CSS, data URLs, and embedded assets remain available.

## Requirements

- Node.js 20 or newer
- Chromium when running outside the provided Docker image
- Stripe credentials for paid subscriptions

## Local installation

Install dependencies:

    npm install

Start the API:

    API_KEY_SALT=development-secret npm start

The service listens on port 3000 by default.

Check health:

    curl http://localhost:3000/api/health

## Environment variables

Required for production:

- API_KEY_SALT: Secret used to hash API keys
- APP_URL: Public origin of the deployed service

Required for Stripe subscriptions:

- STRIPE_SECRET_KEY: Stripe secret API key
- STRIPE_WEBHOOK_SECRET: Signing secret for the Stripe webhook
- STRIPE_PRICE_STARTER: Recurring Stripe Price ID for Starter
- STRIPE_PRICE_PRO: Recurring Stripe Price ID for Pro
- STRIPE_PRICE_ENTERPRISE: Recurring Stripe Price ID for Enterprise

Optional:

- PORT: HTTP port, defaults to 3000
- DATA_DIR: Persistent store directory, defaults to ./data
- PUPPETEER_EXECUTABLE_PATH: Chromium executable path
- TEST_BASE_URL: API origin used by test.js

## Railway deployment

1. Create a GitHub repository named pdf-generator-api.
2. Add every file from this build response.
3. Push the repository to GitHub.
4. Create a Railway project from the GitHub repository.
5. Add a Railway volume mounted at /app/data.
6. Set API_KEY_SALT to a securely generated random value.
7. Set APP_URL to the public Railway service origin.
8. Add the Stripe environment variables to enable subscriptions.
9. Deploy the service.
10. Configure a Stripe webhook for the public /api/webhooks/stripe endpoint.

The Docker image installs Chromium and runs the application as the unprivileged node user.

## Register an account

Request:

    curl -X POST http://localhost:3000/api/auth/register -H "Content-Type: application/json" -d '{"email":"customer@example.com"}'

The response contains an API key once. Store it securely.

## Render a PDF from HTML

    curl -X POST http://localhost:3000/api/render -H "Authorization: Bearer pdfgen_key_returned_at_registration" -H "Content-Type: application/json" -d '{"html":"<html><body><h1>Invoice</h1><p>Amount: $25.00</p></body></html>","filename":"invoice.pdf","options":{"format":"A4","printBackground":true}}' --output invoice.pdf

## Create a template

    curl -X POST http://localhost:3000/api/templates -H "Authorization: Bearer pdfgen_key_returned_at_registration" -H "Content-Type: application/json" -d '{"name":"Invoice","html":"<h1>Invoice {{number}}</h1><p>Customer: {{customer.name}}</p>","css":"body { font-family: Arial, sans-serif; }"}'

The response includes the generated template ID.

## Render a template

    curl -X POST http://localhost:3000/api/render -H "Authorization: Bearer pdfgen_key_returned_at_registration" -H "Content-Type: application/json" -d '{"templateId":"template_id_returned_by_create","data":{"number":"INV-1001","customer":{"name":"Acme Corporation"}},"filename":"invoice.pdf"}' --output invoice.pdf

## Merge PDFs

The merge endpoint accepts between 2 and 20 base64-encoded PDFs.

    curl -X POST http://localhost:3000/api/merge -H "Authorization: Bearer pdfgen_key_returned_at_registration" -H "Content-Type: application/json" -d '{"pdfs":["base64_encoded_first_pdf","base64_encoded_second_pdf"]}' --output merged.pdf

Each input PDF consumes one monthly operation.

## Check usage

    curl http://localhost:3000/api/usage -H "Authorization: Bearer pdfgen_key_returned_at_registration"

## List plans

    curl http://localhost:3000/api/plans

Default monthly operation limits:

| Plan | Operations | Watermark |
| --- | ---: | --- |
| Free | 100 | Yes |
| Starter | 5,000 | No |
| Pro | 25,000 | No |
| Enterprise | 100,000 | No |

## Start Stripe Checkout

    curl -X POST http://localhost:3000/api/billing/checkout -H "Authorization: Bearer pdfgen_key_returned_at_registration" -H "Content-Type: application/json" -d '{"plan":"starter"}'

The response contains checkoutUrl. The account plan changes only after a verified Stripe webhook confirms the subscription.

Supported webhook events:

- checkout.session.completed
- customer.subscription.updated
- customer.subscription.deleted

## End-to-end test

Start the API in one terminal:

    API_KEY_SALT=development-secret npm start

Run the test in another terminal:

    npm test

The test checks the health endpoint, registers an account, renders a PDF, and confirms usage accounting.

## API endpoints

- GET /
- GET /api/health
- GET /api/plans
- POST /api/auth/register
- GET /api/account
- GET /api/usage
- POST /api/billing/checkout
- GET /api/billing/success
- GET /api/billing/cancel
- POST /api/webhooks/stripe
- POST /api/templates
- GET /api/templates
- GET /api/templates/:templateId
- PUT /api/templates/:templateId
- DELETE /api/templates/:templateId
- POST /api/render
- POST /api/merge

## Storage

Users, API-key hashes, templates, Stripe identifiers, plans, and usage counters are stored in DATA_DIR/store.json. Mount a persistent Railway volume at /app/data to retain data across deployments.

Raw API keys are never persisted. Only HMAC-SHA256 hashes are stored.

## License

MIT
