# PDF Generation API

This is a self-serve REST API for generating PDFs from HTML and CSS using Puppeteer.

## Endpoints

- `GET /api/health`: Check the service health.
- `POST /api/pdf`: Generate a PDF from provided HTML/CSS.
- `POST /api/generate-key`: Generate a new API key (for test purposes).
- `POST /api/subscribe`: Subscribe to a pricing plan.

## Setup

1. Clone the repository.
2. Install dependencies: `npm install`
3. Set up environment variables in a `.env` file.
4. Start the server: `npm start`

## Usage

Use the generated API key to authenticate requests.
