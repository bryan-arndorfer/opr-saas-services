const assert = require('assert');

const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:3000';

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    return {
      response,
      body: await response.json()
    };
  }

  return {
    response,
    body: Buffer.from(await response.arrayBuffer())
  };
}

async function run() {
  const health = await request('/api/health');
  assert.strictEqual(health.response.status, 200);
  assert.strictEqual(health.body.status, 'ok');

  const email = `test-${Date.now()}@example.com`;
  const registration = await request('/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email })
  });

  assert.strictEqual(registration.response.status, 201);
  assert.ok(registration.body.apiKey);

  const apiKey = registration.body.apiKey;
  const render = await request('/api/render', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      html: '<html><body><h1>PDF Generator API Test</h1></body></html>',
      filename: 'test.pdf'
    })
  });

  assert.strictEqual(render.response.status, 200);
  assert.ok(
    (render.response.headers.get('content-type') || '').includes(
      'application/pdf'
    )
  );
  assert.ok(render.body.length > 100);

  const usage = await request('/api/usage', {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  assert.strictEqual(usage.response.status, 200);
  assert.strictEqual(usage.body.used, 1);

  console.log('End-to-end tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
