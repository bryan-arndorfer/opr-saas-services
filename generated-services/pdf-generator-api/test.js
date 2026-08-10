const assert = require('node:assert/strict');

const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:3000';

async function run() {
  const healthResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.status, 'healthy');

  const keyResponse = await fetch(`${baseUrl}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(keyResponse.status, 201);
  const keyResult = await keyResponse.json();
  assert.match(keyResult.apiKey, /^pdfgen_free_/);

  const usageResponse = await fetch(`${baseUrl}/api/usage`, {
    headers: {
      Authorization: `Bearer ${keyResult.apiKey}`
    }
  });
  assert.equal(usageResponse.status, 200);
  const usage = await usageResponse.json();
  assert.equal(usage.tier, 'free');
  assert.equal(usage.used, 0);

  const renderResponse = await fetch(`${baseUrl}/api/render`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${keyResult.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      html: '<h1>PdfGenerator API test</h1>',
      css: 'h1{color:#2457ff}',
      options: { format: 'A4' }
    })
  });
  assert.equal(renderResponse.status, 200);
  assert.equal(renderResponse.headers.get('content-type'), 'application/pdf');
  const pdf = Buffer.from(await renderResponse.arrayBuffer());
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');

  console.log('Health, authentication, usage, and PDF rendering tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
