const nodemailer = require('nodemailer');
const { config } = require('../config');

let transport = null;
function getTransport() {
  if (!config.SMTP_HOST) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT || 587,
      secure: config.SMTP_PORT === 465,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

/** Sends through SMTP when configured, otherwise prints to the server console (development). */
async function sendMail({ to, subject, text }) {
  const t = getTransport();
  if (!t) {
    console.log(`[mail:console] to=${to} subject="${subject}"\n${text}`);
    return { delivered: false, via: 'console' };
  }
  await t.sendMail({ from: config.SMTP_FROM || config.SMTP_USER, to, subject, text });
  return { delivered: true, via: 'smtp' };
}

module.exports = { sendMail };
