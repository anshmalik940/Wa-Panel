process.env.NODE_ENV = 'test';
process.env.CLIENT_URL = 'https://wa-panel-five.vercel.app,http://localhost:5173';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/wa_panel_cors_test';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough';
process.env.ENCRYPTION_KEY = 'test-encryption-key-that-is-long-enough';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');

test('CORS permits the production frontend preflight and rejects unlisted origins', async () => {
  const app = createApp();
  const allowed = await request(app)
    .options('/api/auth/login')
    .set('Origin', 'https://wa-panel-five.vercel.app')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type,authorization');

  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://wa-panel-five.vercel.app');
  assert.deepEqual(
    allowed.headers['access-control-allow-methods'].split(',').map((method) => method.trim()),
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  );
  assert.equal(allowed.headers['access-control-allow-headers'], 'Content-Type,Authorization');

  const rejected = await request(app)
    .options('/api/auth/login')
    .set('Origin', 'https://unlisted.example')
    .set('Access-Control-Request-Method', 'POST');

  assert.equal(rejected.headers['access-control-allow-origin'], undefined);
});
