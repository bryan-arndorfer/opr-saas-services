# PdfGenerator API

PdfGenerator API is a stateless Node.js service that converts HTML-like content and built-in templates into downloadable PDF files.

## Features

- Direct PDF responses
- JSON template interpolation
- Invoice, report, and letter templates
- Free usage limited by client IP
- Stripe Checkout subscriptions
- Signed paid API keys
- Railway deployment configuration
- Health checks and automated API tests

## Rendering behavior

The renderer converts printable HTML content into paginated PDF text. It recognizes headings, paragraphs, divisions, line breaks, list items, horizontal rules, and common HTML entities.

Script elements, style elements, comments, and unsupported tags are removed. The optional css field supports a font-size value in pixels and a three-digit or six-digit hexadecimal text color.

Example:

body { font-size: 14px; color: #222222; }

The renderer uses the built-in PDF Helvetica font. Characters outside its supported range are normalized to safe printable equivalents.

## Plans

Free plan:

- No API key required
- 10 renders per hour per client IP

Paid plan:

- Active Stripe subscription required
- 1000 renders per hour per API key
- API key accepted through Authorization: Bearer or x-api-key
- Subscription status revalidated through Stripe and cached for five minutes

Rate limits are held in application memory and apply independently to each running service instance.

## Requirements

- Node.js 18 or newer
- npm
- A Stripe account and recurring Stripe Price for paid subscriptions

The free rendering tier works without Stripe configuration.

## Installation

Install dependencies:

npm install

Start the service:

npm start

Run the API tests:

npm test

The local service listens on http://localhost:3000 unless PORT is configured.

## Environment variables

PORT

HTTP port. Railway supplies this automatically.

APP_URL

Public base URL used for Stripe redirect URLs. In production, set this to the Railway HTTPS domain.

STRIPE_SECRET_KEY

Stripe secret API key used to create and verify subscription Checkout Sessions.

STRIPE_PRICE_ID

Identifier of an active recurring Stripe Price.

API_KEY_SECRET

Private random secret used to sign paid API keys. Keep this value unchanged after issuing keys.

Generate a secure value:

node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

## Health check

Request:

curl http://localhost:3000/api/health

Response structure:

{"status":"UP","service":"pdfgenerator-api","version":"1.0.1","billingConfigured":false,"timestamp":"2026-08-06T00:00:00.000Z"}

billingConfigured becomes true when all paid billing variables are configured.

## Render HTML

curl --request POST http://localhost:3000/api/render --header "Content-Type: application/json" --data "{\"html\":\"<h1>Monthly Report</h1><p>Revenue increased by 18 percent.</p>\",\"css\":\"body { font-size: 14px; color: #222222; }\",\"filename\":\"monthly-report.pdf\",\"title\":\"Monthly Report\"}" --output monthly-report.pdf

The response is an application/pdf download.

## Render a template

Available template identifiers:

- invoice
- report
- letter

Invoice example:

curl --request POST http://localhost:3000/api/render --header "Content-Type: application/json" --data "{\"templateId\":\"invoice\",\"jsonData\":{\"invoiceNumber\":\"INV-1001\",\"from\":\"Example Company\",\"customer\":\"Customer Company\",\"date\":\"2026-08-06\",\"item\":\"API subscription\",\"quantity\":\"1\",\"unitPrice\":\"$19.00\",\"total\":\"$19.00\",\"notes\":\"Thank you for your business.\"},\"filename\":\"invoice-1001.pdf\"}" --output invoice-1001.pdf

Nested values can be interpolated with dotted keys. For example, {{customer.name}} reads jsonData.customer.name.

## Endpoints

GET /

Returns service metadata.

GET /api/health

Returns service and billing configuration health.

GET /api/docs

Returns machine-readable API documentation.

GET /api/templates

Lists the built-in template identifiers.

POST /api/render

Creates and returns a PDF.

Accepted JSON fields:

- html: HTML content
- css: Basic font size and text color declarations
- templateId: Built-in template used when html is absent
- jsonData: Object interpolated into double-brace variables
- filename: Download filename
- title: PDF metadata title

POST /api/billing/checkout

Creates a Stripe subscription Checkout Session and returns checkoutUrl and sessionId.

POST /api/billing/activate

Verifies a paid Checkout Session and returns a signed API key.

Request body:

{"sessionId":"cs_test_or_live_identifier"}

## Stripe configuration

Create a Stripe product with a recurring Price and configure these variables:

- STRIPE_SECRET_KEY
- STRIPE_PRICE_ID
- API_KEY_SECRET
- APP_URL

The Checkout success page verifies the subscription and displays the customer's API key. The API accepts subscriptions with an active or trialing status.

Subscription state is checked directly through Stripe, so a webhook endpoint is not required.

## Create a Checkout Session

curl --request POST http://localhost:3000/api/billing/checkout --header "Content-Type: application/json" --data "{}"

Open checkoutUrl from the response in a browser. Stripe redirects to the activation page after successful Checkout.

## Use a paid API key

Bearer authentication:

curl --request POST http://localhost:3000/api/render --header "Authorization: Bearer $PDFGENERATOR_API_KEY" --header "Content-Type: application/json" --data "{\"html\":\"<h1>Paid render</h1><p>This request uses the paid plan.</p>\"}" --output paid-render.pdf

Header authentication:

curl --request POST http://localhost:3000/api/render --header "x-api-key: $PDFGENERATOR_API_KEY" --header "Content-Type: application/json" --data "{\"html\":\"<h1>Paid render</h1><p>This request uses the paid plan.</p>\"}" --output paid-render.pdf

## Railway deployment

Create a Railway service from the repository. Railway uses railway.json to install dependencies, run tests, start the server, and check /api/health.

The free tier requires no service variables.

For paid operation, configure APP_URL, STRIPE_SECRET_KEY, STRIPE_PRICE_ID, and API_KEY_SECRET. Generate a Railway public domain and use its HTTPS origin for APP_URL.

## Error responses

Errors are JSON objects containing an error field.

Common status codes:

- 400 for invalid request data
- 401 for an invalid or inactive paid API key
- 402 for a Checkout Session without an active subscription
- 404 for unknown endpoints
- 413 for a request body larger than 512 KB
- 429 for exceeded render limits
- 500 for unexpected server errors
- 503 when paid billing is not configured

Rate-limited responses include Retry-After and retryAfterSeconds.

## Security

- Express identification headers are disabled
- JSON request bodies are limited to 512 KB
- API keys use HMAC-SHA256 signatures
- Signatures are compared in constant time
- Paid subscription status is verified through Stripe
- Generated PDF responses use no-store caching
- Script and style content is removed
- Download filenames are sanitized
- Graceful shutdown handles Railway termination signals

## License

Proprietary micro-SaaS service.
