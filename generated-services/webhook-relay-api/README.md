# Webhook Relay API

## Overview

A self-serve HTTP API for reliable webhook delivery. This API allows developers to send events to registered endpoint URLs with retries, logging, and error handling.

## Getting Started

1. Clone the repository
2. Set up your environment variables in a `.env` file
3. Run `npm install`
4. Start the server with `npm start`

## API Endpoints

- `GET /api/health` - Health check endpoint
- `POST /api/events` - Accepts webhook events for delivery

## License

MIT License
