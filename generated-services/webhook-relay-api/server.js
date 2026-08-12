const express = require('express');
const bodyParser = require('body-parser');
const { Client } = require('pg');
const dotenv = require('dotenv');
const bcrypt = require('bcrypt');
const app = express();

dotenv.config();

const PORT = process.env.PORT || 3000;
const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

client.connect();

app.use(bodyParser.json());

const API_KEYS = new Map(); // Simulated API keys storage
const RATE_LIMIT = 100; // Free tier limit
const API_KEY_HEADER = 'x-api-key';

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'UP', timestamp: new Date() });
});

app.post('/events', async (req, res) => {
  const apiKey = req.headers[API_KEY_HEADER];
  const currentUsage = (API_KEYS.get(apiKey) || 0);

  if (currentUsage >= RATE_LIMIT) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  
  const { event, targetUrl } = req.body;

  if (!event || !targetUrl) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  // Logic for storing the event and setting up delivery with exponential backoff goes here.

  API_KEYS.set(apiKey, currentUsage + 1); // Increment usage
  res.status(202).json({ message: 'Event received and processing started.' });
});

app.post('/register', (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) {
    return res.status(400).json({ error: 'API key is required' });
  }

  const hashedKey = bcrypt.hashSync(apiKey, 10);
  API_KEYS.set(hashedKey, 0); // Register new API key
  res.status(201).json({ message: 'API key registered successfully' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
