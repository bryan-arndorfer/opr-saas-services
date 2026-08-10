# PdfGenerator API

PdfGenerator API converts HTML into downloadable PDF files using Puppeteer. It supports reusable templates, escaped template variables, raw HTML variables, watermarks, custom headers and footers, page numbers, synchronous rendering, asynchronous batch jobs, monthly usage limits, and Stripe subscription checkout.

## Requirements

- Node.js 18 or newer
- npm
- A Stripe account for paid subscriptions
- A Railway account for hosted deployment

## Installation

Clone the repository and install dependencies:

    git clone https://github.com/your-account/pdf-generator-api.git
    cd pdf-generator-api
    npm install

Start the API:

    npm start

The service listens on port 3000 by default.

Check its health:

    curl http://localhost:3000/api/health

## Environment variables

The API runs locally without Stripe using the built-in development key `demo-key`.

Supported environment variables:

- `PORT`: HTTP server port. Railway supplies this automatically.
- `PUBLIC_URL`: Public HTTPS origin used for Stripe success and cancellation URLs.
- `API_KEYS`: Comma-separated free-tier API keys. Defaults to `demo-key`.
- `PREMIUM_API_KEYS`: Comma-separated paid API keys that bypass the free render limit.
- `MAX_FREE_RENDERS_PER_MONTH`: Monthly render limit for free keys. Defaults to `100`.
- `MAX_BATCH_SIZE`: Maximum documents per batch. Defaults to `20`.
- `MAX_HTML_LENGTH`: Maximum HTML characters per document. Defaults to `2000000`.
- `STRIPE_SECRET_KEY`: Stripe secret API key.
- `STRIPE_WEBHOOK_SECRET`: Signing secret for the Stripe webhook endpoint.
- `STRIPE_STARTER_PRICE_ID`: Recurring Stripe Price ID for the starter plan.
- `STRIPE_PRO_PRICE_ID`: Recurring Stripe Price ID for the pro plan.
- `STRIPE_BUSINESS_PRICE_ID`: Recurring Stripe Price ID for the business plan.
- `NODE_ENV`: Set to `production` in production.

A local configuration can be supplied through a `.env` file:

    PORT=3000
    PUBLIC_URL=http://localhost:3000
    API_KEYS=demo-key
    PREMIUM_API_KEYS=
    MAX_FREE_RENDERS_PER_MONTH=100
    MAX_BATCH_SIZE=20
    MAX_HTML_LENGTH=2000000
    NODE_ENV=development

Stripe variables can remain unset when testing PDF generation locally.

## Authentication

All rendering, template, usage, batch, and job endpoints require an API key.

Use the `x-api-key` header:

    x-api-key: demo-key

Or use a bearer token:

    Authorization: Bearer demo-key

The health, pricing, documentation, checkout, checkout activation, and Stripe webhook endpoints do not require an API key.

## Render a PDF

Send HTML in a JSON request and save the binary response:

    curl -X POST http://localhost:3000/api/render \
      -H "Content-Type: application/json" \
      -H "x-api-key: demo-key" \
      -d '{"html":"<!doctype html><html><body><h1>Invoice</h1><p>Paid in full.</p></body></html>","filename":"invoice"}' \
      --output invoice.pdf

## PDF options

The `options` object supports:

- `format`: Paper format such as `A4`, `Letter`, or `Legal`.
- `landscape`: Enables landscape orientation.
- `printBackground`: Prints CSS backgrounds. Enabled by default.
- `preferCSSPageSize`: Uses CSS `@page` dimensions when available.
- `scale`: PDF rendering scale between `0.1` and `2`.
- `margin`: Object containing `top`, `right`, `bottom`, and `left`.
- `watermark`: Text displayed diagonally over every page.
- `headerTemplate`: Puppeteer-compatible HTML header template.
- `footerTemplate`: Puppeteer-compatible HTML footer template.
- `pageNumbers`: Adds current and total page numbers.
- `waitForMilliseconds`: Waits up to 5000 milliseconds before PDF capture.

Example:

    curl -X POST http://localhost:3000/api/render \
      -H "Content-Type: application/json" \
      -H "x-api-key: demo-key" \
      -d '{"html":"<html><body><h1>Quarterly Report</h1><p>Confidential financial results.</p></body></html>","filename":"report","options":{"format":"A4","watermark":"CONFIDENTIAL","pageNumbers":true,"margin":{"top":"20mm","right":"15mm","bottom":"25mm","left":"15mm"}}}' \
      --output report.pdf

## Templates

Create a reusable template:

    curl -X POST http://localhost:3000/api/templates \
      -H "Content-Type: application/json" \
      -H "x-api-key: demo-key" \
      -d '{"name":"Invoice","html":"<html><body><h1>Invoice {{invoice.number}}</h1><p>Customer: {{customer.name}}</p><div>{{{lineItemsHtml}}}</div></body></html>"}'

Double braces escape HTML. Triple braces insert trusted raw HTML.

Render a saved template by using the returned template ID:

    curl -X POST http://localhost:3000/api/render \
      -H "Content-Type: application/json" \
      -H "x-api-key: demo-key" \
      -d '{"templateId":"9f32b018-9539-4a44-b3ad-c771c48ac325","data":{"invoice":{"number":"INV-1001"},"customer":{"name":"Acme Company"},"lineItemsHtml":"<ul><li>API subscription</li></ul>"},"filename":"invoice-1001"}' \
      --output invoice-1001.pdf

List templates:

    curl http://localhost:3000/api/templates \
      -H "x-api-key: demo-key"

Delete a template:

    curl -X DELETE http://localhost:3000/api/templates/9f32b018-9539-4a44-b3ad-c771c48ac325 \
      -H "x-api-key: demo-key"

## Asynchronous batches

Create a batch:

    curl -X POST http://localhost:3000/api/batches \
      -H "Content-Type: application/json" \
      -H "x-api-key: demo-key" \
      -d '{"documents":[{"html":"<html><body><h1>Document One</h1></body></html>"},{"html":"<html><body><h1>Document Two</h1></body></html>","options":{"pageNumbers":true}}]}'

The response contains a job ID and document IDs.

Check job status:

    curl http://localhost:3000/api/jobs/9b14db1f-e4c4-420c-a675-f67721179737 \
      -H "x-api-key: demo-key"

Download a completed batch document:

    curl http://localhost:3000/api/jobs/9b14db1f-e4c4-420c-a675-f67721179737/documents/a6aec078-f760-4a24-97d7-596aab215230/pdf \
      -H "x-api-key: demo-key" \
      --output batch-document.pdf

## Usage

View current monthly usage:

    curl http://localhost:3000/api/usage \
      -H "x-api-key: demo-key"

Free keys receive the configured monthly allowance. Premium keys bypass the application-level free-tier limit.

## Stripe subscriptions

Create three recurring Stripe products and prices for the starter, pro, and business plans. Assign their Price IDs to the corresponding Railway environment variables.

Create a subscription checkout session:

    curl -X POST http://localhost:3000/api/billing/checkout \
      -H "Content-Type: application/json" \
      -d '{"plan":"starter"}'

The response includes a Stripe Checkout URL. After successful payment, Stripe redirects the customer to `/billing/success`, where the paid API key is displayed.

A checkout session can also be activated programmatically:

    curl -X POST http://localhost:3000/api/billing/activate \
      -H "Content-Type: application/json" \
      -d '{"sessionId":"cs_test_a1M8wZjZVbdQhHpGfQjDjfGH6mKJxZ3W8pQ9nR2sT4uV5wX6yZ7"}'

Configure the Stripe webhook destination as:

    https://pdf-generator-api-production.up.railway.app/api/billing/webhook

Subscribe it to these events:

- `checkout.session.completed`
- `customer.subscription.deleted`
- `customer.subscription.paused`

The Stripe signing secret must be stored in `STRIPE_WEBHOOK_SECRET`.

## Railway deployment

Create a GitHub repository named `pdf-generator-api` and commit these files.

Create a Railway project from the GitHub repository. Railway detects `package.json`, installs Node.js dependencies with Nixpacks, starts the service with `npm start`, and checks `/api/health`.

Set these Railway variables:

    NODE_ENV=production
    PUBLIC_URL=https://pdf-generator-api-production.up.railway.app
    API_KEYS=demo-key
    MAX_FREE_RENDERS_PER_MONTH=100
    MAX_BATCH_SIZE=20
    MAX_HTML_LENGTH=2000000

Add the Stripe variables when billing is enabled.

Generate a Railway public domain and update `PUBLIC_URL` to that exact HTTPS origin. Redeploy after changing environment variables.

## Health check

The health endpoint does not launch Chromium, so Railway can verify the web process quickly:

    GET /api/health

Example response:

    {
      "status": "ok",
      "service": "pdf-generator-api",
      "timestamp": "2026-08-10T12:00:00.000Z",
      "stripeConfigured": false,
      "uptimeSeconds": 42
    }

## Testing

Validate the server syntax:

    npm test

Run the service and test the complete free-tier flow:

    npm start

In a second terminal:

    curl http://localhost:3000/api/health

    curl http://localhost:3000/api/usage \
      -H "x-api-key: demo-key"

    curl -X POST http://localhost:3000/api/render \
      -H "Content-Type: application/json" \
      -H "x-api-key: demo-key" \
      -d '{"html":"<html><body><h1>End-to-end test</h1><p>The PDF service is working.</p></body></html>","options":{"pageNumbers":true}}' \
      --output end-to-end-test.pdf

A successful render returns HTTP 200 with `Content-Type: application/pdf`.

## Operational behavior

Templates, usage counters, dynamically activated premium keys, batch jobs, and generated batch PDFs are stored in process memory. Configured API keys and premium API keys are loaded from environment variables at startup. A paid key can be restored after a restart by calling the checkout activation endpoint again with its paid Stripe Checkout session ID.

Chromium is launched lazily on the first render. The process reuses one browser instance and opens a separate page for each PDF. SIGTERM and SIGINT close Chromium before process exit.
