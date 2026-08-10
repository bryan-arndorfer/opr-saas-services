# PdfGenerator API

PdfGenerator API converts HTML and CSS into PDFs through a self-service HTTP API. It supports synchronous rendering, queued rendering, reusable templates, watermarks, custom fonts, PDF merging, usage limits, and Stripe subscriptions.

## Requirements

- Node.js 20 or newer
- Redis for asynchronous jobs
- Stripe for paid subscriptions

## Local installation

1. Run `npm install`.
2. Copy `.env.example` to `.env`.
3. Start the API with `npm start`.
4. Start the worker in another process with `npm run worker`.
5. Run integration tests with `npm test`.

Redis and Stripe are optional for synchronous free-tier rendering. Redis is required for asynchronous rendering and merging. Stripe is required for checkout.

## Create an API key

Send a POST request to `/api/keys`.

Example:

`curl -X POST http://localhost:3000/api/keys -H "Content-Type: application/json" -d '{}'`

The response contains a free API key. Save it and send it as a bearer token on authenticated requests.

## Render a PDF

Example:

`curl -X POST http://localhost:3000/api/render -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" -d '{"html":"<h1>Hello World</h1>","css":"h1{color:blue}","options":{"format":"A4"}}' --output document.pdf`

## Render an invoice template

Example request body:

`{"templateId":"invoice","data":{"companyName":"Acme Corp","invoiceNumber":"INV-001","items":[{"name":"Widget","qty":2,"price":25,"total":50}],"total":50}}`

Send the body to `POST /api/render` with the bearer authorization header.

## Asynchronous rendering

Paid accounts can set `async` to `true` and provide a `webhookUrl`. The API returns HTTP 202 with a job identifier. The worker sends a JSON webhook containing the generated PDF as base64.

Example request body:

`{"html":"<h1>Asynchronous document</h1>","async":true,"webhookUrl":"https://example.com/webhooks/pdf"}`

## Merge PDFs

Paid accounts can merge two to twenty remote PDFs synchronously through `POST /api/merge`.

Example request body:

`{"urls":["https://example.com/one.pdf","https://example.com/two.pdf"]}`

Asynchronous merging is also supported by sending `mergePdfs` and `webhookUrl` to `POST /api/render`.

## API endpoints

- `GET /api/health` returns service health.
- `POST /api/keys` creates a free API key.
- `POST /api/render` renders or queues a PDF.
- `POST /api/merge` merges remote PDFs for paid accounts.
- `GET /api/templates` lists templates.
- `POST /api/templates` creates a paid-account template.
- `GET /api/usage` returns monthly usage.
- `POST /api/billing/checkout` creates a Stripe Checkout session.
- `POST /api/webhooks/stripe` processes Stripe events.

## Plans

| Plan | Monthly renders | Async jobs | Branded watermark | Custom fonts |
| --- | ---: | --- | --- | --- |
| Free | 100 | No | Yes | No |
| Starter | 1,000 | Yes | No | Yes |
| Pro | 10,000 | Yes | No | Yes |
| Enterprise | 100,000 | Yes | No | Yes |

Stripe prices are configured with `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, and `STRIPE_PRICE_ENTERPRISE`.

## Stripe webhook

Configure Stripe to send `checkout.session.completed` and `customer.subscription.deleted` events to:

`https://YOUR_DOMAIN/api/webhooks/stripe`

Set the signing secret as `STRIPE_WEBHOOK_SECRET`.

## Railway deployment

1. Push this repository to GitHub.
2. Create a Railway project from the repository.
3. Add a Redis service.
4. Configure the environment variables from `.env.example`.
5. Deploy the API using `npm start`.
6. Create a second Railway service from the same repository and set its start command to `npm run worker`.
7. Set the same `REDIS_URL` for both services.
8. Configure the public API domain as `PUBLIC_URL`.
9. Run `TEST_BASE_URL=https://YOUR_DOMAIN npm test` from a trusted environment.

## Notes

API keys, templates, subscription state, and usage counters are stored in memory in this compact deployment. They reset when the API process restarts. A production scale-out should move those records to Redis or a database.

The `pdfa` option adds archive-oriented metadata and disables object streams. It does not claim full ISO PDF/A conformance, which requires embedded color profiles and additional validation.

## License

MIT
