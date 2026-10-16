require('./helpers');
const { after, before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { encrypt } = require('../src/utils/crypto');
const waApi = require('../src/services/waApiService');
const provider = require('../src/providers/wa_http');
const { config } = require('../src/config');
const { evaluateRecipient } = require('../src/services/campaignService');
const { WhatsappApiConfig } = require('../src/models');

const secret = crypto.randomBytes(32).toString('hex');
let server;
let baseUrl;
let lastRequest;
let reply = { status: 200, body: '{"ok":"yes","id":"test-message-id"}' };

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    lastRequest = {
      method: req.method,
      url: new URL(req.url, baseUrl),
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(reply.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/send`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function record(overrides = {}) {
  return {
    mode: 'http',
    providerName: 'fake vendor',
    baseUrl,
    method: 'GET',
    contentType: 'query',
    apiKeyEnc: encrypt(secret),
    paramNames: { apikey: 'apikey', mobile: 'mobile', msg: 'msg', pdf: 'pdf', img1: 'img1', img2: 'img2', country: 'country' },
    country: 'IN',
    mobileFormat: 'national',
    defaultCaption: '',
    successPath: 'ok',
    successValue: 'yes',
    messageIdPath: 'id',
    mediaMapping: { image: 'img1', document: 'pdf' },
    ...overrides,
  };
}

describe('Company WhatsApp HTTP provider request handling', () => {
  test('GET query safely encodes text and formats a national mobile number', async () => {
    reply = { status: 200, body: '{"ok":"yes","id":"accepted-1"}' };
    const text = 'Deal & offer 🎉\nnext line';
    const result = await provider.testSend(record(), { phone: '+919876543210', text, media: null });
    assert.equal(result.providerMessageId, 'accepted-1');
    assert.equal(lastRequest.method, 'GET');
    assert.equal(lastRequest.url.searchParams.get('apikey'), secret);
    assert.equal(lastRequest.url.searchParams.get('mobile'), '9876543210');
    assert.equal(lastRequest.url.searchParams.get('msg'), text);
    assert.equal(lastRequest.url.searchParams.get('country'), 'IN');
  });

  test('international format keeps the country digits and removes only the plus sign', async () => {
    reply = { status: 200, body: '{"ok":"yes"}' };
    await provider.testSend(record({ mobileFormat: 'international' }), { phone: '+14155552671', text: '', media: null });
    assert.equal(lastRequest.url.searchParams.get('mobile'), '14155552671');
    assert.equal(lastRequest.url.searchParams.get('msg'), '');
  });

  test('configured fallback caption is used only for media-only requests', async () => {
    reply = { status: 200, body: '{"ok":"yes"}' };
    const image = { kind: 'image', url: 'https://public.example/image.jpg' };
    await provider.testSend(record({ defaultCaption: 'Image attached' }), { phone: '+919876543210', text: '', media: image });
    assert.equal(lastRequest.url.searchParams.get('msg'), 'Image attached');
    await provider.testSend(record({ defaultCaption: 'Image attached' }), { phone: '+919876543210', text: 'Actual caption', media: image });
    assert.equal(lastRequest.url.searchParams.get('msg'), 'Actual caption');
    await provider.testSend(record({ defaultCaption: 'Fallback should not replace text-only' }), { phone: '+919876543210', text: 'Text only', media: null });
    assert.equal(lastRequest.url.searchParams.get('msg'), 'Text only');
  });

  test('recipient personalisation reaches the vendor as the media caption', async () => {
    reply = { status: 200, body: '{"ok":"yes"}' };
    const evaluated = evaluateRecipient(
      { name: 'Asha Rao', phone: '+919876543210', phoneValid: true },
      { header: '', body: 'Hello {{first_name}}', footer: '', variables: ['first_name'] },
      { first_name: { source: 'field', field: 'first_name' } },
    );
    assert.equal(evaluated.text, 'Hello Asha');
    await provider.testSend(record(), {
      phone: '+919876543210',
      text: evaluated.text,
      media: { kind: 'image', url: 'https://public.example/image.jpg' },
    });
    assert.equal(lastRequest.url.searchParams.get('msg'), 'Hello Asha');
  });

  test('POST JSON and form requests use their configured content types', async () => {
    reply = { status: 200, body: '{"ok":"yes"}' };
    await provider.testSend(record({ method: 'POST', contentType: 'json' }), { phone: '+919876543210', text: 'a & b', media: null });
    assert.equal(lastRequest.headers['content-type'], 'application/json');
    assert.equal(JSON.parse(lastRequest.body).msg, 'a & b');
    await provider.testSend(record({ method: 'POST', contentType: 'form' }), { phone: '+919876543210', text: 'a & b', media: null });
    assert.equal(lastRequest.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(new URLSearchParams(lastRequest.body).get('msg'), 'a & b');
  });

  test('up to two images and one PDF map to separate parameters; video and excess media are rejected', async () => {
    reply = { status: 200, body: '{"ok":"yes"}' };
    await provider.testSend(record(), { phone: '+919876543210', text: 'caption', media: { kind: 'image', url: 'https://public.example/image?a=1&b=2' } });
    assert.equal(lastRequest.url.searchParams.get('img1'), 'https://public.example/image?a=1&b=2');
    await provider.testSend(record(), { phone: '+919876543210', text: '', media: { kind: 'document', url: 'https://public.example/file.pdf' } });
    assert.equal(lastRequest.url.searchParams.get('pdf'), 'https://public.example/file.pdf');
    await provider.testSend(record(), {
      phone: '+919876543210',
      text: 'caption',
      media: [
        { kind: 'image', url: 'https://public.example/1.jpg' },
        { kind: 'image', url: 'https://public.example/2.jpg' },
        { kind: 'document', url: 'https://public.example/3.pdf' },
      ],
    });
    assert.equal(lastRequest.url.searchParams.get('img1'), 'https://public.example/1.jpg');
    assert.equal(lastRequest.url.searchParams.get('img2'), 'https://public.example/2.jpg');
    assert.equal(lastRequest.url.searchParams.get('pdf'), 'https://public.example/3.pdf');
    const before = lastRequest.url.href;
    await assert.rejects(provider.testSend(record(), { phone: '+919876543210', text: '', media: { kind: 'video', url: 'https://public.example/video.mp4' } }), /does not support video or audio/);
    await assert.rejects(provider.testSend(record(), {
      phone: '+919876543210',
      text: '',
      media: [
        { kind: 'image', url: 'https://public.example/1.jpg' },
        { kind: 'image', url: 'https://public.example/2.jpg' },
        { kind: 'image', url: 'https://public.example/3.jpg' },
      ],
    }), /at most two images and one PDF/);
    assert.equal(lastRequest.url.href, before);
    assert.equal(provider.costUnits({ media: null }), 1);
    assert.equal(provider.costUnits({ media: { kind: 'image' } }), 1);
    assert.equal(provider.costUnits({ media: [{ kind: 'image' }, { kind: 'image' }, { kind: 'document' }] }), 3);
  });

  test('HTTP errors and response success detection retain status but never expose the API key', async () => {
    reply = { status: 400, body: JSON.stringify({ error: `rejected key ${secret}` }) };
    await assert.rejects(
      provider.testSend(record(), { phone: '+919876543210', text: 'test', media: null }),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.retryable, false);
        assert.ok(!err.message.includes(secret));
        assert.ok(!JSON.stringify(err.response).includes(secret));
        return true;
      },
    );

    reply = { status: 503, body: 'temporary outage' };
    await assert.rejects(
      provider.testSend(record(), { phone: '+919876543210', text: 'test', media: null }),
      (err) => err.status === 503 && !err.retryable && /outcome is unknown/i.test(err.message),
    );

    reply = { status: 200, body: '{"ok":"no"}' };
    await assert.rejects(
      provider.testSend(record(), { phone: '+919876543210', text: 'test', media: null }),
      (err) => err.code === 'WA_HTTP_REJECTED' && !err.retryable,
    );
  });

  test('network timeouts are not retried and have the API key masked', async () => {
    const originalFetch = global.fetch;
    try {
      global.fetch = async () => {
        throw Object.assign(new Error(`timeout ${secret}`), { name: 'TimeoutError' });
      };
      await assert.rejects(
        provider.testSend(record(), { phone: '+919876543210', text: 'test', media: null }),
        (err) => !err.retryable && err.code === 'WA_HTTP_TIMEOUT' && /outcome is unknown/i.test(err.message) && !err.message.includes(secret),
      );
      global.fetch = async () => { throw new Error('connection refused'); };
      await assert.rejects(
        provider.testSend(record(), { phone: '+919876543210', text: 'test', media: null }),
        (err) => !err.retryable && err.code === 'WA_HTTP_NETWORK',
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('ALLOW_REAL_SEND=false blocks the campaign provider before it makes a request', async () => {
    const previous = config.ALLOW_REAL_SEND;
    config.ALLOW_REAL_SEND = false;
    try {
      await assert.rejects(
        provider.send({ account: { ownerId: 'test-owner' }, message: { phone: '+919876543210', text: 'test' }, settings: {} }),
        (err) => err.code === 'REAL_SEND_DISABLED',
      );
    } finally {
      config.ALLOW_REAL_SEND = previous;
    }
  });

  test('serialized admin config never includes encrypted or clear API key material', () => {
    const serialized = waApi.serializeConfig(record());
    assert.equal(serialized.hasApiKey, true);
    assert.equal(Object.hasOwn(serialized, 'apiKeyEnc'), false);
    assert.equal(Object.hasOwn(serialized, 'apiKey'), false);
    const withUrlKey = waApi.serializeConfig(record({ baseUrl: `${baseUrl}?token=${secret}` }));
    assert.ok(!withUrlKey.baseUrl.includes(secret));
    assert.ok(withUrlKey.baseUrl.includes('REDACTED'));
    assert.match(withUrlKey.readyProblem, /Do not put the API key in the base URL/);
  });

  test('model defaults and nested mappings serialize as expected', () => {
    const defaults = new WhatsappApiConfig();
    const serialized = waApi.serializeConfig(defaults);
    assert.equal(serialized.mode, 'off');
    assert.equal(serialized.paramNames.apikey, 'apikey');
    assert.equal(serialized.mediaMapping.image, 'img1');
    assert.equal(({ ...defaults.paramNames }).mobile, 'mobile');
  });

  test('local, loopback, private and link-local media URLs are identified', () => {
    for (const url of ['http://localhost:5000/media/id', 'http://127.0.0.1/media/id', 'http://10.0.0.1/media/id', 'http://192.168.1.4/media/id', 'http://[::1]/media/id', 'http://[::ffff:192.168.1.2]/media/id']) {
      assert.equal(waApi.isLocalOrPrivateUrl(url), true);
    }
    assert.equal(waApi.isLocalOrPrivateUrl('https://media.example.com/file.jpg'), false);
  });
});
