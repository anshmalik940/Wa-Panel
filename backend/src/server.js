const { config } = require('./config');
const { connectDb, disconnectDb } = require('./db');
const { createApp } = require('./app');
const { bootstrapAdmin } = require('./services/bootstrap');
const { startWorker, stopWorker, recoverStale } = require('./services/queue');
const wa = require('./services/waSession');

process.on('unhandledRejection', () => {
  console.error('[process] unhandled rejection; process kept running');
});

process.on('uncaughtException', () => {
  console.error('[process] uncaught exception; process kept running');
});

async function main() {
  await connectDb(config.MONGODB_URI);
  await bootstrapAdmin();
  const recovered = await recoverStale();
  if (recovered.requeued || recovered.failed || recovered.resumedCampaigns) console.log('[queue] startup recovery:', recovered);

  const app = createApp();
  const server = app.listen(config.PORT, () => {
    console.log(`API listening on http://localhost:${config.PORT}  (env=${config.NODE_ENV}, worker=${config.WORKER_ENABLED ? 'on' : 'off'}, realSending=${config.ALLOW_REAL_SEND})`);
  });
  if (config.WORKER_ENABLED) startWorker();
  wa.resumeAll().then((n) => n && console.log(`[wa] resuming ${n} linked phone session(s)`)).catch((e) => console.error('[wa] resume failed', e.message));

  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down...`);
    stopWorker();
    await wa.stopAll();
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  if (err.isConfigError) console.error(err.message);
  else console.error(`[startup] API failed to start (${err.name || 'Error'})`);
  process.exit(1);
});
