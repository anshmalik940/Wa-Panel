const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
const { z } = require('zod');

const boolFalse = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');
const boolTrue = z.enum(['true', 'false']).default('true').transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  MONGODB_URI: z.string({ required_error: 'MONGODB_URI is required (e.g. mongodb://127.0.0.1:27017/wa_panel)' }).min(1, 'MONGODB_URI is required'),
  JWT_SECRET: z.string({ required_error: 'JWT_SECRET is required (at least 32 characters)' }).min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  ENCRYPTION_KEY: z.string({ required_error: 'ENCRYPTION_KEY is required (at least 32 characters, encrypts provider credentials)' }).min(32, 'ENCRYPTION_KEY must be at least 32 characters (used to encrypt provider credentials)'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(14).default(10),
  CLIENT_URL: z.string().optional(),
  PUBLIC_API_URL: z.string().optional(),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  ADMIN_NAME: z.string().default('Super Admin'),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  DEFAULT_COUNTRY_CODE: z.string().regex(/^\d{1,3}$/, 'digits only, e.g. 91').default('91'),
  USAGE_TIMEZONE: z.string().default('Asia/Kolkata').refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Must be a valid IANA timezone'),
  // Kill switch for REAL sending (Meta Cloud API / QR-linked phone / voice API). Mock provider is unaffected.
  ALLOW_REAL_SEND: boolTrue,
  // Where uploaded media and linked-phone (QR) sessions are stored. Use a persistent disk in production.
  DATA_DIR: z.string().default(path.join(__dirname, '..', 'data')),
  WHATSAPP_GRAPH_VERSION: z.string().default('v21.0'),
  WORKER_ENABLED: boolTrue,
  WORKER_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
  RESET_TOKEN_TTL_MIN: z.coerce.number().int().min(5).default(30),
  // When true the password-reset link is returned in the API response (development only).
  RESET_RETURN_LINK: z.enum(['true', 'false']).optional(),
  RATE_LIMIT_DISABLED: boolFalse,
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
});

function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`);
    const err = new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
    err.isConfigError = true;
    throw err;
  }
  const c = { ...parsed.data };
  c.CLIENT_URL = c.CLIENT_URL ?? (c.NODE_ENV === 'production' ? '' : 'http://localhost:5173');
  c.PUBLIC_API_URL = c.PUBLIC_API_URL ?? (c.NODE_ENV === 'production' ? '' : 'http://localhost:5000');
  c.RESET_RETURN_LINK = c.RESET_RETURN_LINK ? c.RESET_RETURN_LINK === 'true' : c.NODE_ENV !== 'production';
  if (c.NODE_ENV === 'production') {
    const problems = [];
    if (/change-me|example|secret-secret/i.test(c.JWT_SECRET)) problems.push('JWT_SECRET still looks like the example value');
    if (/change-me|example/i.test(c.ENCRYPTION_KEY)) problems.push('ENCRYPTION_KEY still looks like the example value');
    if (c.RESET_RETURN_LINK) problems.push('RESET_RETURN_LINK must be false in production');
    const clientOrigins = c.CLIENT_URL.split(',').map((origin) => origin.trim()).filter(Boolean);
    if (!clientOrigins.length) {
      problems.push('CLIENT_URL must contain at least one HTTPS frontend origin');
    } else if (clientOrigins[0] !== 'https://wa-panel-five.vercel.app') {
      problems.push('CLIENT_URL must start with the deployed frontend origin https://wa-panel-five.vercel.app');
    }
    for (const origin of clientOrigins) {
      try {
        const parsedOrigin = new URL(origin);
        if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin) {
          problems.push('CLIENT_URL entries must be exact HTTPS origins without paths or trailing slashes');
          break;
        }
        if (parsedOrigin.hostname === 'localhost' || parsedOrigin.hostname.endsWith('.localhost') || ['127.0.0.1', '[::1]'].includes(parsedOrigin.hostname)) {
          problems.push('CLIENT_URL must not contain localhost origins in production');
          break;
        }
      } catch {
        problems.push('CLIENT_URL entries must be valid HTTPS origins');
        break;
      }
    }
    try {
      const parsedPublicApiUrl = new URL(c.PUBLIC_API_URL);
      if (parsedPublicApiUrl.protocol !== 'https:' || parsedPublicApiUrl.origin !== c.PUBLIC_API_URL) {
        problems.push('PUBLIC_API_URL must be an HTTPS API origin without a path, query, or fragment');
      }
      if (parsedPublicApiUrl.hostname === 'localhost' || parsedPublicApiUrl.hostname.endsWith('.localhost') || ['127.0.0.1', '[::1]'].includes(parsedPublicApiUrl.hostname)) {
        problems.push('PUBLIC_API_URL must not be a localhost address in production');
      }
    } catch {
      problems.push('PUBLIC_API_URL must be a valid HTTPS API origin');
    }
    if (problems.length) {
      const err = new Error(`Invalid production configuration:\n  - ${problems.join('\n  - ')}`);
      err.isConfigError = true;
      throw err;
    }
  }
  // frozen everywhere except tests, which flip the real-send kill switch at runtime
  return c.NODE_ENV === 'test' ? c : Object.freeze(c);
}

const config = loadConfig();
module.exports = { config, loadConfig };
