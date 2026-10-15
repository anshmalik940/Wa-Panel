const fs = require('fs');
const { config } = require('../config');
const { filePath, safeName } = require('../utils/media');
const { decrypt } = require('../utils/crypto');
const { ProviderError } = require('./errors');

/**
 * WhatsApp Cloud API (Meta) provider.
 *
 * Implemented per Meta's public documentation. It has NOT been exercised against live Meta credentials
 * from the development environment: test with one authorised number first.
 * ALLOW_REAL_SEND=false acts as a kill switch that makes send() refuse to call the API.
 */
const graphBase = (account) => `https://graph.facebook.com/${account.graphVersion || config.WHATSAPP_GRAPH_VERSION}`;

function credentials(account) {
  if (!account.phoneNumberId || !account.wabaId || !account.accessTokenEnc) {
    throw new ProviderError('WhatsApp Cloud API credentials are incomplete (phone number ID, WABA ID and access token are required).', {
      code: 'CONFIG_INCOMPLETE',
    });
  }
  let token;
  try {
    token = decrypt(account.accessTokenEnc);
  } catch {
    throw new ProviderError('Stored access token cannot be decrypted. Re-enter the access token.', { code: 'TOKEN_DECRYPT' });
  }
  return { token, phoneNumberId: account.phoneNumberId, wabaId: account.wabaId };
}

async function graph(url, token, { method = 'GET', body } = {}) {
  let res;
  try {
    // global.fetch is looked up at call time so tests can stub it
    res = await global.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new ProviderError(`Could not reach the WhatsApp Cloud API: ${err.message}`, { retryable: true, code: 'NETWORK' });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json && json.error ? json.error : {};
    throw new ProviderError(e.message || `WhatsApp Cloud API returned HTTP ${res.status}`, {
      retryable: res.status >= 500 || res.status === 429,
      code: e.code || res.status,
      status: res.status,
    });
  }
  return json;
}

/** Meta needs a sample of the media to review a template with an image/video/document header (resumable upload API). */
async function uploadExampleHandle(account, token, media) {
  if (!account.appId) {
    throw new ProviderError('The Meta App ID is required to submit a template with an image, video or document header. Add it in WhatsApp settings.', { code: 'APP_ID_REQUIRED' });
  }
  const buf = await fs.promises.readFile(filePath(media));
  const session = await graph(
    `${graphBase(account)}/${encodeURIComponent(account.appId)}/uploads?file_length=${buf.length}&file_type=${encodeURIComponent(media.mime)}&file_name=${encodeURIComponent(safeName(media.originalName))}`,
    token,
    { method: 'POST' },
  );
  let res;
  try {
    res = await global.fetch(`${graphBase(account)}/${session.id}`, {
      method: 'POST',
      headers: { Authorization: `OAuth ${token}`, file_offset: '0' },
      body: buf,
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    throw new ProviderError(`Could not upload the sample file to Meta: ${err.message}`, { retryable: true, code: 'NETWORK' });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.h) throw new ProviderError((json.error && json.error.message) || 'Meta rejected the sample file upload', { code: res.status });
  return json.h;
}

const MEDIA_TYPES = ['image', 'video', 'document'];

function attachmentTypeOf(template) {
  if (template.attachmentType !== undefined && template.attachmentType !== null) return template.attachmentType;
  return MEDIA_TYPES.includes(template.headerType) ? template.headerType : 'none';
}

function templateComponents(t, handle) {
  const components = [];
  const attachmentType = attachmentTypeOf(t);
  if (MEDIA_TYPES.includes(attachmentType) && handle) {
    components.push({ type: 'HEADER', format: attachmentType.toUpperCase(), example: { header_handle: [handle] } });
  } else if (t.header) components.push({ type: 'HEADER', format: 'TEXT', text: t.header });
  const body = { type: 'BODY', text: t.body };
  if (t.variables && t.variables.length) {
    body.example = { body_text_named_params: t.variables.map((v) => ({ param_name: v, example: 'Sample' })) };
  }
  components.push(body);
  if (t.footer) components.push({ type: 'FOOTER', text: t.footer });
  return components;
}

module.exports = {
  name: 'meta',
  simulated: false,

  async checkConnection(account) {
    const { token, phoneNumberId } = credentials(account);
    const r = await graph(`${graphBase(account)}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`, token);
    return { displayPhone: r.display_phone_number || '', verifiedName: r.verified_name || '' };
  },

  async listTemplates(account) {
    const { token, wabaId } = credentials(account);
    let url = `${graphBase(account)}/${encodeURIComponent(wabaId)}/message_templates?limit=100&fields=id,name,language,status,category,components,rejected_reason`;
    const out = [];
    for (let page = 0; page < 5 && url; page += 1) {
      const r = await graph(url, token);
      out.push(...(r.data || []));
      url = r.paging && r.paging.next ? r.paging.next : null;
    }
    return out;
  },

  async submitTemplate(account, template, media) {
    const { token, wabaId } = credentials(account);
    const handle = media && MEDIA_TYPES.includes(attachmentTypeOf(template)) ? await uploadExampleHandle(account, token, media) : null;
    const payload = {
      name: template.name,
      language: template.language,
      category: template.category,
      components: templateComponents(template, handle),
    };
    if (template.variables && template.variables.length) payload.parameter_format = 'NAMED';
    const r = await graph(`${graphBase(account)}/${encodeURIComponent(wabaId)}/message_templates`, token, { method: 'POST', body: payload });
    return { providerTemplateId: r.id || '', status: r.status };
  },

  async send({ account, message, campaign }) {
    if (!config.ALLOW_REAL_SEND) {
      throw new ProviderError('Real WhatsApp sending is disabled on this server (ALLOW_REAL_SEND=false).', { code: 'REAL_SEND_DISABLED' });
    }
    const { token, phoneNumberId } = credentials(account);
    const snap = campaign.templateSnapshot || {};
    const params = message.params || {};
    const names = snap.variables || [];
    const components = [];
    if (snap.media && ['image', 'video', 'document'].includes(snap.media.kind)) {
      const kind = snap.media.kind;
      const mediaParam = { link: snap.media.url };
      if (kind === 'document') mediaParam.filename = snap.media.name || 'document';
      components.push({ type: 'header', parameters: [{ type: kind, [kind]: mediaParam }] });
    }
    if (names.length) components.push({ type: 'body', parameters: names.map((n) => ({ type: 'text', parameter_name: n, text: String(params[n] ?? '') })) });
    const payload = {
      messaging_product: 'whatsapp',
      to: message.phone.replace(/^\+/, ''),
      type: 'template',
      template: { name: campaign.templateName, language: { code: snap.language || 'en' }, components },
    };
    const r = await graph(`${graphBase(account)}/${encodeURIComponent(phoneNumberId)}/messages`, token, { method: 'POST', body: payload });
    const id = r.messages && r.messages[0] && r.messages[0].id;
    if (!id) throw new ProviderError('WhatsApp Cloud API accepted the request but returned no message id.', { code: 'NO_MESSAGE_ID' });
    return { providerMessageId: id };
  },

  async testSend(account, { phone, text }) {
    if (!config.ALLOW_REAL_SEND) {
      throw new ProviderError('Real WhatsApp sending is disabled on this server (ALLOW_REAL_SEND=false).', { code: 'REAL_SEND_DISABLED' });
    }
    const { token, phoneNumberId } = credentials(account);
    const result = await graph(`${graphBase(account)}/${encodeURIComponent(phoneNumberId)}/messages`, token, {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: String(phone).replace(/\D/g, ''),
        type: 'text',
        text: { preview_url: false, body: String(text || '') },
      },
    });
    const providerMessageId = result.messages && result.messages[0] && result.messages[0].id;
    if (!providerMessageId) throw new ProviderError('WhatsApp Cloud API accepted the test request but returned no message id.', { code: 'NO_MESSAGE_ID' });
    return { providerMessageId };
  },

  parseRemoteTemplate(remote) {
    const bodyC = (remote.components || []).find((c) => c.type === 'BODY');
    const headerC = (remote.components || []).find((c) => c.type === 'HEADER' && c.format === 'TEXT');
    const mediaHeader = (remote.components || []).find((c) => c.type === 'HEADER' && c.format && c.format !== 'TEXT');
    const footerC = (remote.components || []).find((c) => c.type === 'FOOTER');
    return {
      body: bodyC ? bodyC.text : '',
      header: headerC ? headerC.text : '',
      footer: footerC ? footerC.text : '',
      hasMediaHeader: Boolean(mediaHeader), // imported templates with a media header cannot be sent without the file: skipped by sync
    };
  },
};
