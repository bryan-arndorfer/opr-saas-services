require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Rate limiting for free tier
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: 'Rate limit exceeded. Try again later.',
});

app.use('/api/events', limiter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'UP' });
});

// Core endpoint for handling webhook events
app.post('/api/events', async (req, res) => {
  const { url, payload } = req.body;

  // Input validation
  if (!url || !payload) {
    return res.status(400).json({ error: 'Missing url or payload' });
  }

  // Here you would normally add the logic to send the payload to the URL with retries

  res.status(202).json({ message: 'Event accepted' });
});

// Start server
app.listen(port, () => {
  console.log(`Webhook Relay API listening at http://localhost:${port}`);
});
