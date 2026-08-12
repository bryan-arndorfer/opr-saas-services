# Webhook Relay API

A self-serve HTTP API for reliable webhook delivery with retries and logging.

## Features

- Reliable callback delivery with exponential backoff retries.
- HMAC signing and delivery logs.
- API-driven registration and key generation.
- Free tier with 100 events per month.

## Getting started

1. Clone the repository.
2. Run `npm install` to install the dependencies.
3. Set up your environment variables in a `.env` file.
4. Start the server with `npm start`.

## Endpoints

- `GET /api/health`: Check the health of the service.
- `POST /events`: Send events to be delivered.
- `POST /register`: Register a new API key for usage.

## License

This project is licensed under the MIT License.
