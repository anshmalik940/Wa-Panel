const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const mongoose = require('mongoose');
const { config } = require('./config');
const { authenticate, requireRole } = require('./middleware/auth');
const { notFound, errorHandler } = require('./middleware/error');

function createApp() {
  const app = express();
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(helmet());
  const origins = [...new Set([
    ...config.CLIENT_URL.split(',').map((s) => s.trim()).filter(Boolean),
    'https://wa-panel-five.vercel.app',
  ])];
  app.use(cors({
    origin: (origin, callback) => callback(null, !origin || origins.includes(origin)),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Disposition'],
  }));
  // keep the exact bytes: webhook signatures are computed over the raw body
  app.use(express.json({ limit: '6mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

  app.get('/api/health', (req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({ status: dbUp ? 'ok' : 'degraded', db: dbUp ? 'up' : 'down', time: new Date().toISOString(), realSending: config.ALLOW_REAL_SEND });
  });

  const docsPath = path.join(__dirname, '..', '..', 'docs', 'API.md');
  app.get('/api/docs', (req, res) => {
    if (!fs.existsSync(docsPath)) return res.status(404).json({ error: 'API documentation not found' });
    return res.type('text/markdown; charset=utf-8').send(fs.readFileSync(docsPath, 'utf8'));
  });

  app.use('/media', require('./routes/mediaPublic'));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/webhooks', require('./routes/webhooks'));
  app.use('/api/admin', authenticate, requireRole('admin'), require('./routes/admin'));
  app.use('/api/reseller', authenticate, requireRole('reseller'), require('./routes/reseller'));
  app.use('/api/c', require('./routes/customer'));
  app.use('/api', notFound);

  // Optional single-process deployment: serve the built frontend when it exists
  const dist = path.join(__dirname, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
