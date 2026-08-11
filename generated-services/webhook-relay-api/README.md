# Webhook Relay API

A self-serve HTTP API for reliable webhook delivery with exponential backoff retries and delivery logs.

## Getting Started

### Prerequisites

- Node.js
- PostgreSQL
- Stripe account (for monetization)

### Installation

1. Clone the repository
2. Run `npm install`
3. Create a `.env` file and add your `DATABASE_URL` and Stripe credentials
4. Start the server with `npm start`

### API Endpoints

- `GET /api/health`: Check the health status of the API.
- `POST /events`: Send an event to be delivered to a specified URL.
- `POST /stripe/webhook`: Receive notifications from Stripe.

### License

This project is licensed under the MIT License.
