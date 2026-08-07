# PdfGenerator API

PdfGenerator API converts HTML into PDF documents through a self-service HTTP API. It supports template variables, custom page settings, free-tier watermarks, PDF merging, asynchronous batch rendering, API-key authentication, and monthly usage limits.

## Features

- HTML-to-PDF rendering with Chromium
- Template variables using double-brace syntax
- A4 and other standard page formats
- Custom dimensions, margins, scale, and landscape mode
- Free-plan watermarking
- Optional custom watermarks for paid keys
- Base64 PDF merging
- Asynchronous batch jobs
- API-key authentication
- Monthly free-tier quota
- Railway health checks
- Docker-based Chromium deployment

## Plans

Free API keys receive 100 renders per calendar month by default. Free renders and merged PDFs include a watermark.

Paid API keys are listed in the UNLIMITED_KEYS environment variable. They have unlimited rendering and do not receive a default watermark. Paid keys can be issued automatically by a Stripe fulfillment service after a successful subscription or one-time payment.

## Environment variables

PORT

The HTTP port. Railway sets this automatically. The local default is 3000.

API_KEYS

Comma-separated list of accepted API keys. The default is dev-key.

UNLIMITED_KEYS

Comma-separated list of paid API keys. Keys in this list are accepted automatically and receive the paid plan.

FREE_MONTHLY_LIMIT

Monthly render allowance for each free key. The default is 100.

MAX_HTML_BYTES

Maximum HTML input size per document. The default is 2000000 bytes.

MAX_BATCH_SIZE

Maximum documents in one batch and maximum PDFs in one merge request. The default is 20.

JOB_TTL_MS

Time completed batch jobs remain available in memory. The default is 3600000 milliseconds.

PUPPETEER_EXECUTABLE_PATH

Chromium executable path. The Docker image sets this to /usr/bin/google-chrome-stable.

## Local Docker startup

Build the image:

    docker build -t pdfgenerator-api .

Run the service with one free key and one paid key:

    docker run --rm -p 3000:3000 -e API_KEYS=dev-key,paid-demo-key -e UNLIMITED_KEYS=paid-demo-key pdfgenerator-api

Check service health:

    curl http://localhost:3000/api/health

## Authentication

Protected endpoints require an x-api-key header.

Example:

    curl http://localhost:3000/api/usage -H "x-api-key: dev-key"

## Render a PDF

Endpoint:

    POST /api/render

Request fields:

- html: Required HTML string.
- data: Optional object used to replace template variables.
- options: Optional PDF rendering settings.
- watermark: Optional custom watermark text.
- timeout: Optional rendering timeout from 1000 to 120000 milliseconds.

Template variables support nested object paths. The expression with customer.name resolves from data.customer.name.

Example request:

    curl -X POST http://localhost:3000/api/render -H "x-api-key: dev-key" -H "Content-Type: application/json" --data '{"html":"<html><body><h1>Invoice {{invoice.number}}</h1><p>Customer: {{customer.name}}</p><p>Total: {{invoice.total}}</p></body></html>","data":{"invoice":{"number":"INV-1001","total":"$49.00"},"customer":{"name":"Ada Lovelace"}},"options":{"format":"A4","printBackground":true,"margin":{"top":"15mm","right":"15mm","bottom":"15mm","left":"15mm"}}}' --output invoice.pdf

Supported standard formats are Letter, Legal, Tabloid, Ledger, A0, A1, A2, A3, A4, A5, and A6.

The options object also accepts:

- landscape: Boolean
- printBackground: Boolean
- preferCSSPageSize: Boolean
- scale: Number from 0.1 through 2
- width: CSS page width such as 210mm
- height: CSS page height such as 297mm
- margin.top
- margin.right
- margin.bottom
- margin.left

When width or height is supplied, the standard format setting is not used.

## Batch rendering

Create an asynchronous batch:

    curl -X POST http://localhost:3000/api/batch -H "x-api-key: dev-key" -H "Content-Type: application/json" --data '{"documents":[{"html":"<h1>First document</h1>"},{"html":"<h1>Second document</h1>"}]}'

The response contains a job ID and status URL.

Retrieve a job using its returned ID:

    curl http://localhost:3000/api/jobs/550e8400-e29b-41d4-a716-446655440000 -H "x-api-key: dev-key"

Completed job results contain base64-encoded PDFs. Jobs are private to the API key that created them and expire after JOB_TTL_MS.

## Merge PDFs

Endpoint:

    POST /api/merge

The request body must contain a pdfs array with at least two base64-encoded PDF strings. The response is a merged PDF. Free-plan merge responses receive the standard watermark.

## Usage

Retrieve current monthly usage:

    curl http://localhost:3000/api/usage -H "x-api-key: dev-key"

The response reports the plan, month, renders used, limit, and remaining allowance.

## Health check

Endpoint:

    GET /api/health

Successful response:

    {"status":"ok","service":"pdfgenerator-api","timestamp":"2026-08-07T12:00:00.000Z","uptimeSeconds":60}

## Railway deployment

1. Create a GitHub repository named pdfgenerator-api.
2. Add all files from this build to the repository.
3. Create a Railway project from the GitHub repository.
4. Set API_KEYS to the comma-separated free and paid keys accepted by the service.
5. Set UNLIMITED_KEYS to the comma-separated paid keys.
6. Deploy the service.
7. Railway builds the Dockerfile and checks /api/health before marking the deployment healthy.

The Railway-generated public domain becomes the API base URL.

## Stripe fulfillment

Create Stripe products and prices for paid plans. After Stripe confirms payment, the fulfillment workflow generates a cryptographically random API key, appends it to API_KEYS and UNLIMITED_KEYS, and updates the Railway service variables through Railway's API. The next deployment recognizes the key as an unlimited paid key.

A secure API key can be generated with:

    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

## Operational notes

Usage counters and batch jobs are stored in memory. They reset when the process restarts or a new deployment begins. A production installation requiring durable quotas can run a single Railway replica or connect the quota functions to a persistent Redis or PostgreSQL service.

Batch results are returned as base64 and retained only for the configured job lifetime. The JSON request limit is 25 MB. External fonts, images, and styles referenced by HTML must be reachable by Chromium during rendering.
