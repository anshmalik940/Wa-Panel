const crypto = require('crypto');
const { config } = require('../config');

const key = () => crypto.createHash('sha256').update(config.ENCRYPTION_KEY).digest();

/** AES-256-GCM. Output: iv.tag.ciphertext (base64 parts). */
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(payload) {
  const [iv, tag, enc] = String(payload).split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
const hmacSha256Hex = (secret, buf) => crypto.createHmac('sha256', secret).update(buf).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

module.exports = { encrypt, decrypt, sha256, randomToken, hmacSha256Hex, safeEqual };
