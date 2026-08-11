require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Client } = require('pg');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const validator = require('validator');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

client.connect();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100, // limit each IP to 100 requests per windowMs
});

app.use(limiter);

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'UP' });
});

app.post('/events', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(403).json({ error: 'API key required' });

  const eventUrl = req.body.url;
  const payload = req.body.data;

  // Basic input validation
  if (!validator.isURL(eventUrl)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!payload) {
    return res.status(400).json({ error: 'No data provided' });
  }

  // Here you would put logic to store the event and handle retrying failed deliveries
  res.status(202).json({ message: 'Event received, will deliver shortly' });
});

// Handle stripe webhook for success/fail notifications
app.post('/stripe/webhook', (req, res) => {
  // You will need to validate the Stripe webhook and handle accordingly.
  res.sendStatus(200);
});

// Cleanup on server exit
process.on('exit', () => {
  client.end();
});

app.listen(PORT, () => {
  console.log(`Webhook Relay API listening on port ${PORT}`);
});
