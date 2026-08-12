const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const Stripe = require('stripe');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const API_KEYS = new Set(); // Simulate a basic storage for valid API keys
const FREE_TIER_LIMIT = 10; // Number of free PDFs/month
const PAID_TIER_LIMIT = 500; // Number of PDFs for paid tier

app.use(bodyParser.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'UP' });
});

app.post('/api/pdf', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!API_KEYS.has(apiKey)) return res.status(403).json({ error: 'Invalid API key' });
    
    const { htmlContent, cssContent } = req.body;

    if (!htmlContent) {
        return res.status(400).json({ error: 'HTML content is required' });
    }
    
    let pdfBuffer;

    try {
        const browser = await puppeteer.launch();
        const page = await browser.newPage();
        await page.setContent(htmlContent + `<style>${cssContent}</style>`);
        pdfBuffer = await page.pdf();
        await browser.close();
    } catch (error) {
        return res.status(500).json({ error: 'Failed to generate PDF' });
    }
    
    res.type('application/pdf');
    res.send(pdfBuffer);
});

// Middleware to check for API key and limit usage (simplified)
app.use((req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (API_KEYS.has(apiKey)) {
        // Logic for tracking usage would go here
        next();
    } else {
        res.status(403).json({ error: 'Unauthorized' });
    }
});

// Mock endpoint for subscribing to Stripe (simplified, real implementation would be more complex)
app.post('/api/subscribe', async (req, res) => {
    const { token, plan } = req.body;
    try {
        const customer = await stripe.customers.create({
            source: token,
        });
        const subscription = await stripe.subscriptions.create({
            customer: customer.id,
            items: [{ plan: plan }],
        });
        res.status(200).json(subscription);
    } catch (error) {
        res.status(500).json({ error: 'Subscription failed' });
    }
});

// Simulated API key generation
app.post('/api/generate-key', (req, res) => {
    const newKey = `key-${Date.now()}`; // In reality, use a more secure method
    API_KEYS.add(newKey);
    res.json({ apiKey: newKey });
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
