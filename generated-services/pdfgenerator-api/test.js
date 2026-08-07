const assert = require('assert');
const app = require('./server');

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

async function run() {
  const server = app.listen(0, '127.0.0.1');

  await new Promise((resolve) => {
    if (server.listening) {
      resolve();
    } else {
      server.once('listening', resolve);
    }
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const healthResult = await requestJson(`${baseUrl}/api/health`);
    assert.strictEqual(healthResult.response.status, 200);
    assert.strictEqual(healthResult.body.status, 'UP');
    assert.strictEqual(healthResult.body.service, 'pdfgenerator-api');
    assert.strictEqual(typeof healthResult.body.timestamp, 'string');

    const rootResult = await requestJson(`${baseUrl}/`);
    assert.strictEqual(rootResult.response.status, 200);
    assert.strictEqual(rootResult.body.name, 'PdfGenerator API');

    const docsResult = await requestJson(`${baseUrl}/api/docs`);
    assert.strictEqual(docsResult.response.status, 200);
    assert.strictEqual(
      docsResult.body.endpoints.render.path,
      '/api/render'
    );

    const templatesResult = await requestJson(
      `${baseUrl}/api/templates`
    );
    assert.strictEqual(templatesResult.response.status, 200);
    assert.ok(templatesResult.body.templates.includes('invoice'));
    assert.ok(templatesResult.body.templates.includes('report'));
    assert.ok(templatesResult.body.templates.includes('letter'));

    const renderResponse = await fetch(`${baseUrl}/api/render`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        html: '<h1>Test document</h1><p>The PDF endpoint works.</p>',
        css: 'body { font-size: 14px; color: #223344; }',
        filename: 'test-output.pdf',
        title: 'API Test'
      })
    });

    assert.strictEqual(renderResponse.status, 200);
    assert.ok(
      renderResponse.headers
        .get('content-type')
        .startsWith('application/pdf')
    );
    assert.strictEqual(
      renderResponse.headers.get('x-usage-plan'),
      'free'
    );
    assert.ok(
      renderResponse.headers
        .get('content-disposition')
        .includes('test-output.pdf')
    );

    const pdf = Buffer.from(await renderResponse.arrayBuffer());
    assert.ok(pdf.length > 100);
    assert.strictEqual(pdf.subarray(0, 4).toString(), '%PDF');

    const templateResponse = await fetch(`${baseUrl}/api/render`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        templateId: 'invoice',
        jsonData: {
          invoiceNumber: 'INV-1001',
          from: 'Example Company',
          customer: 'Customer Company',
          date: '2026-08-06',
          item: 'API subscription',
          quantity: 1,
          unitPrice: '$19.00',
          total: '$19.00',
          notes: 'Payment received.'
        }
      })
    });

    assert.strictEqual(templateResponse.status, 200);
    const templatePdf = Buffer.from(
      await templateResponse.arrayBuffer()
    );
    assert.strictEqual(
      templatePdf.subarray(0, 4).toString(),
      '%PDF'
    );

    const invalidBodyResult = await requestJson(
      `${baseUrl}/api/render`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({})
      }
    );

    assert.strictEqual(invalidBodyResult.response.status, 400);
    assert.strictEqual(
      invalidBodyResult.body.error,
      'Provide html or templateId.'
    );

    const invalidTemplateResult = await requestJson(
      `${baseUrl}/api/render`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          templateId: 'missing'
        })
      }
    );

    assert.strictEqual(
      invalidTemplateResult.response.status,
      400
    );

    const emptyDocumentResult = await requestJson(
      `${baseUrl}/api/render`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          html: '<script>alert("removed")</script>'
        })
      }
    );

    assert.strictEqual(
      emptyDocumentResult.response.status,
      400
    );

    const checkoutResult = await requestJson(
      `${baseUrl}/api/billing/checkout`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: '{}'
      }
    );

    assert.strictEqual(checkoutResult.response.status, 503);

    const notFoundResult = await requestJson(
      `${baseUrl}/api/not-found`
    );

    assert.strictEqual(notFoundResult.response.status, 404);
    assert.strictEqual(
      notFoundResult.body.error,
      'Endpoint not found.'
    );

    console.log('All tests passed.');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
