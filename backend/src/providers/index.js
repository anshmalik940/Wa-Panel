const mock = require('./mock');
const meta = require('./meta');
const qr = require('./qr');
const voice = require('./voice');
const waHttp = require('./wa_http');
const { HttpError } = require('../utils/httpError');

const providers = { mock, meta, qr, wa_http: waHttp, voice_mock: voice.mock, voice_http: voice.http };

function getProvider(name) {
  const p = providers[name];
  if (!p) throw new HttpError(400, `Unknown WhatsApp provider "${name}"`);
  return p;
}

module.exports = { getProvider };
