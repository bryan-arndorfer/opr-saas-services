const assert = require('assert');
const { spawn } = require('child_process');

const port = 3107;
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env,
    PORT: String(port),
    BASE_URL: baseUrl,
    DATA_DIR: `${process.cwd()}/test-data`
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
child.stdout.on('data', (data) => {
  output += data.toString();
});
child.stderr.on('data', (data) => {
  output += data.toString();
});

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch (error) {
      await wait(500);
    }
  }
  throw new Error(`Server did not become healthy. Output: ${output}`);
}

async function run() {
  const health = await waitForHealth();
  assert.strictEqual(health.status, 'ok');

  const signupResponse = await fetch(`${baseUrl}/api/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `test-${Date.now()}@example.com`
    })
  });
  assert.strictEqual(signupResponse.status, 201);
  const signup = await signupResponse.json();
  assert.ok(signup.apiKey.startsWith('pdf_'));

  const usageResponse = await fetch(`${baseUrl}/api/usage`, {
    headers: { 'X-API-Key': signup.apiKey }
  });
  assert.strictEqual(usageResponse.status, 200);
  const usage = await usageResponse.json();
  assert.strictEqual(usage.plan, 'free');
  assert.strictEqual(usage.used, 0);

  const renderResponse = await fetch(`${baseUrl}/api/render`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': signup.apiKey
    },
    body: JSON.stringify({
      html: '<html><body><h1>Hello {{name}}</h1></body></html>',
      data: { name: 'API Test' }
    })
  });
  assert.strictEqual(renderResponse.status, 200);
  assert.ok(
    String(renderResponse.headers.get('content-type')).includes('application/pdf')
  );
  const pdf = Buffer.from(await renderResponse.arrayBuffer());
  assert.ok(pdf.subarray(0, 4).toString() === '%PDF');
  assert.ok(pdf.length > 500);

  console.log('Health, signup, usage, authentication, and PDF rendering tests passed.');
}

run()
  .then(() => {
    child.kill('SIGTERM');
  })
  .catch((error) => {
    console.error(error);
    console.error(output);
    child.kill('SIGTERM');
    process.exitCode = 1;
  });
