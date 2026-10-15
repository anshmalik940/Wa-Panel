const express = require('express');
const { z } = require('zod');
const { Template, Campaign, Media } = require('../../models');
const { serialize: serializeMedia } = require('../../utils/media');
const { validate } = require('../../middleware/validate');
const { HttpError, asyncHandler: ah, idParam } = require('../../utils/httpError');
const { extractVars, validateTemplateFields } = require('../../utils/template');
const { pageParams, pageResult, escapeRegex } = require('../../utils/pagination');
const { audit } = require('../../utils/audit');
const { ProviderError } = require('../../providers/errors');
const { resolveWhatsApp, NOT_READY } = require('../../services/providerResolver');

const router = express.Router();
router.param('id', idParam);

const body = z.object({
  name: z.string().trim().toLowerCase().max(80).default(''),
  language: z.string().trim().max(10).default('en'),
  category: z.string().trim().toUpperCase().default('MARKETING'),
  header: z.string().max(200).default(''),
  headerType: z.enum(['none', 'text', 'image', 'video', 'document']).optional(),
  attachmentType: z.enum(['none', 'image', 'video', 'document']).optional(),
  mediaId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid media id').nullable().optional(),
  extraMediaIds: z.array(z.string().regex(/^[a-f\d]{24}$/i, 'Invalid media id')).max(3).optional(),
  body: z.string().max(5000).default(''),
  footer: z.string().max(200).default(''),
});

function check(input) {
  const errors = validateTemplateFields(input);
  if (errors.length) throw new HttpError(400, 'Template validation failed', errors);
}

const MEDIA_HEADERS = ['image', 'video', 'document'];

function attachmentTypeOf(template) {
  if (template.attachmentType !== undefined && template.attachmentType !== null) return template.attachmentType;
  return MEDIA_HEADERS.includes(template.headerType) ? template.headerType : 'none';
}

function textHeaderTypeOf(template) {
  return template.headerType === 'text' || (template.header && !MEDIA_HEADERS.includes(template.headerType)) ? 'text' : 'none';
}

/** Resolves legacy headerType media values and verifies the file belongs to this owner and has the right kind. */
async function normalizeHeader(input, ownerId) {
  const out = { ...input };
  const extraIds = [...new Set((input.extraMediaIds || []).map(String))];
  const extras = extraIds.length ? await Media.find({ _id: { $in: extraIds }, ownerId }) : [];
  if (extras.length !== extraIds.length) throw new HttpError(400, 'Template validation failed', [{ field: 'extraMediaIds', message: 'One or more additional files were not found in your uploads.' }]);
  if (extras.some((media) => !['image', 'document'].includes(media.kind) || (media.kind === 'document' && media.mime !== 'application/pdf'))) {
    throw new HttpError(400, 'Template validation failed', [{ field: 'extraMediaIds', message: 'Additional attachments can only be images or PDF files.' }]);
  }
  const primary = input.mediaId ? await Media.findOne({ _id: input.mediaId, ownerId }) : null;
  const allKinds = [...(primary ? [primary.kind] : []), ...extras.map((media) => media.kind)];
  if (allKinds.filter((kind) => kind === 'image').length > 2 || allKinds.filter((kind) => kind === 'document').length > 1 || allKinds.length > 3) {
    throw new HttpError(400, 'Template validation failed', [{ field: 'extraMediaIds', message: 'A message can include at most two images and one PDF.' }]);
  }
  out.extraMediaIds = extras.map((media) => media._id);
  const attachmentType = attachmentTypeOf(input);
  let headerType = textHeaderTypeOf(input);
  if (MEDIA_HEADERS.includes(attachmentType)) {
    if (!input.mediaId) throw new HttpError(400, 'Template validation failed', [{ field: 'mediaId', message: `Upload or choose a ${attachmentType} attachment.` }]);
    const m = await Media.findOne({ _id: input.mediaId, ownerId });
    if (!m) throw new HttpError(400, 'Template validation failed', [{ field: 'mediaId', message: 'That file was not found in your uploads.' }]);
    if (m.kind !== attachmentType) throw new HttpError(400, 'Template validation failed', [{ field: 'mediaId', message: `That file is a ${m.kind}, not a ${attachmentType}.` }]);
    out.mediaId = m._id;
    if (headerType === 'none') headerType = attachmentType;
  } else {
    out.mediaId = null;
  }
  out.headerType = headerType;
  out.header = headerType === 'text' ? input.header : '';
  out.attachmentType = attachmentType;
  return out;
}

async function withMedia(templates) {
  const list = Array.isArray(templates) ? templates : [templates];
  const ids = list.flatMap((t) => [t.mediaId, ...(t.extraMediaIds || [])]).filter(Boolean);
  const media = ids.length ? await Media.find({ _id: { $in: ids } }) : [];
  const by = Object.fromEntries(media.map((m) => [String(m._id), serializeMedia(m)]));
  const out = list.map((t) => ({
    ...t.toJSON(),
    media: t.mediaId ? by[String(t.mediaId)] || null : null,
    extraMedia: (t.extraMediaIds || []).map((id) => by[String(id)]).filter(Boolean),
  }));
  return Array.isArray(templates) ? out : out[0];
}

const IN_FLIGHT = ['queued', 'running', 'paused'];
const REFERENCING = ['draft', 'scheduled', 'queued', 'running', 'paused'];

async function connectedAccount(owner) {
  const resolved = await resolveWhatsApp(owner);
  if (!resolved.ready) throw new HttpError(422, NOT_READY);
  return resolved;
}

function providerFailure(err) {
  if (err instanceof ProviderError) return new HttpError(502, err.message, [{ field: 'provider', message: err.message }]);
  return err;
}

router.get(
  '/',
  ah(async (req, res) => {
    const filter = { ownerId: req.user._id };
    if (['draft', 'pending', 'approved', 'rejected'].includes(req.query.status)) filter.status = req.query.status;
    if (req.query.q) filter.name = new RegExp(escapeRegex(String(req.query.q).slice(0, 80)), 'i');
    const pp = pageParams(req.query);
    const [rows, total] = await Promise.all([
      Template.find(filter).sort({ createdAt: -1 }).skip(pp.skip).limit(pp.limit),
      Template.countDocuments(filter),
    ]);
    res.json(pageResult(await withMedia(rows), total, pp));
  }),
);

router.post(
  '/validate',
  validate(body),
  ah(async (req, res) => {
    const errors = validateTemplateFields(req.body);
    try {
      await normalizeHeader(req.body, req.user._id);
    } catch (err) {
      if (err instanceof HttpError && Array.isArray(err.details)) errors.push(...err.details);
      else throw err;
    }
    res.json({ valid: errors.length === 0, errors, variables: extractVars(req.body.body) });
  }),
);

router.post(
  '/sync',
  ah(async (req, res) => {
    const resolved = await connectedAccount(req.user);
    const ownerId = req.user._id;
    const now = new Date();
    if (resolved.providerName === 'mock') {
      // Simulated review: every pending template is approved. Clearly flagged as syncSource "mock".
      const r = await Template.updateMany({ ownerId, status: 'pending' }, { $set: { status: 'approved', syncSource: 'mock', lastSyncedAt: now, rejectionReason: '' } });
      await audit(req, 'template.sync', { ownerId, meta: { provider: 'mock', updated: r.modifiedCount } });
      return res.json({ provider: 'mock', updated: r.modifiedCount, imported: 0, skipped: [] });
    }
    if (resolved.providerName !== 'meta') {
      return res.json({ provider: resolved.providerName, updated: 0, imported: 0, skipped: [] });
    }
    const provider = resolved.provider;
    let remote;
    try {
      remote = await provider.listTemplates(resolved.account);
    } catch (err) {
      throw providerFailure(err);
    }
    const map = { APPROVED: 'approved', REJECTED: 'rejected', PENDING: 'pending', IN_APPEAL: 'pending', DISABLED: 'rejected', PAUSED: 'pending' };
    let updated = 0;
    let imported = 0;
    const skipped = [];
    const prefix = `o${String(ownerId).slice(0, 6)}_`;
    for (const rt of remote) {
      if (resolved.source === 'platform' && !String(rt.name || '').startsWith(prefix)) continue;
      const status = map[rt.status] || 'pending';
      const localName = resolved.source === 'platform' ? String(rt.name).slice(prefix.length) : rt.name;
      const local = await Template.findOne({ ownerId, $or: [{ providerTemplateId: String(rt.id) }, { providerTemplateName: String(rt.name) }, { name: localName, language: rt.language }] });
      if (local) {
        const r = await Template.updateOne(
          { _id: local._id },
          { $set: { status, providerTemplateId: String(rt.id), providerTemplateName: String(rt.name), rejectionReason: rt.rejected_reason && rt.rejected_reason !== 'NONE' ? rt.rejected_reason : '', syncSource: resolved.source === 'platform' ? 'platform_meta' : 'meta', lastSyncedAt: now } },
        );
        if (r.modifiedCount) updated += 1;
      } else if (status === 'approved') {
        const parts = provider.parseRemoteTemplate(rt);
        const vars = extractVars(parts.body);
        if (parts.hasMediaHeader) {
          skipped.push({ name: rt.name, reason: 'Has an image/video/document header: create it here and attach your file instead' });
          continue;
        }
        delete parts.hasMediaHeader;
        const candidate = { name: rt.name, language: rt.language, category: rt.category, ...parts };
        if (validateTemplateFields(candidate).length || /\{\{\s*\d+\s*\}\}/.test(parts.body)) {
          skipped.push({ name: rt.name, reason: 'Uses positional placeholders or unsupported content' });
          continue;
        }
        await Template.create({ ownerId, ...candidate, name: localName, variables: vars, status: 'approved', providerTemplateId: String(rt.id), providerTemplateName: String(rt.name), syncSource: resolved.source === 'platform' ? 'platform_meta' : 'meta', lastSyncedAt: now });
        imported += 1;
      }
    }
    await audit(req, 'template.sync', { ownerId, meta: { provider: 'meta', updated, imported } });
    return res.json({ provider: 'meta', updated, imported, skipped });
  }),
);

router.post(
  '/',
  validate(body),
  ah(async (req, res) => {
    check(req.body);
    const data = await normalizeHeader(req.body, req.user._id);
    const t = await Template.create({ ownerId: req.user._id, ...data, variables: extractVars(data.body), status: 'draft' });
    await audit(req, 'template.create', { targetType: 'template', targetId: t._id, ownerId: req.user._id, meta: { name: t.name, headerType: t.headerType } });
    res.status(201).json({ template: await withMedia(t) });
  }),
);

router.get(
  '/:id',
  ah(async (req, res) => {
    const t = await Template.findOne({ _id: req.params.id, ownerId: req.user._id });
    if (!t) throw new HttpError(404, 'Template not found');
    res.json({ template: await withMedia(t) });
  }),
);

router.put(
  '/:id',
  validate(body),
  ah(async (req, res) => {
    const t = await Template.findOne({ _id: req.params.id, ownerId: req.user._id });
    if (!t) throw new HttpError(404, 'Template not found');
    check(req.body);
    const data = await normalizeHeader(req.body, req.user._id);
    if (await Campaign.exists({ ownerId: req.user._id, templateId: t._id, status: { $in: IN_FLIGHT } })) {
      throw new HttpError(409, 'This template is used by a running, queued or paused campaign and cannot be edited.');
    }
    const changed = ['name', 'language', 'category', 'body', 'footer'].some((k) => t[k] !== data[k])
      || textHeaderTypeOf(t) !== textHeaderTypeOf(data)
      || String(t.header || '') !== String(data.header || '')
      || attachmentTypeOf(t) !== data.attachmentType
      || String(t.mediaId || '') !== String(data.mediaId || '')
      || (t.extraMediaIds || []).map(String).join(',') !== (data.extraMediaIds || []).map(String).join(',');
    const set = { ...data, variables: extractVars(data.body) };
    // content changes require a fresh review
    if (changed && t.status !== 'draft') Object.assign(set, { status: 'draft', rejectionReason: '', providerTemplateId: '', syncSource: 'none' });
    const updated = await Template.findOneAndUpdate({ _id: t._id, ownerId: req.user._id }, { $set: set }, { new: true });
    await audit(req, 'template.update', { targetType: 'template', targetId: t._id, ownerId: req.user._id, meta: { resetToDraft: changed && t.status !== 'draft' } });
    res.json({ template: await withMedia(updated), resetToDraft: changed && t.status !== 'draft' });
  }),
);

router.post(
  '/:id/submit',
  ah(async (req, res) => {
    const t = await Template.findOne({ _id: req.params.id, ownerId: req.user._id });
    if (!t) throw new HttpError(404, 'Template not found');
    if (!['draft', 'rejected'].includes(t.status)) throw new HttpError(409, `A ${t.status} template cannot be submitted.`);
    check(t);
    const resolved = await connectedAccount(req.user);
    const remoteName = resolved.source === 'platform' && resolved.providerName === 'meta'
      ? `o${String(req.user._id).slice(0, 6)}_${t.name}`
      : t.name;
    let result;
    try {
      const media = t.mediaId ? await Media.findOne({ _id: t.mediaId, ownerId: req.user._id }) : null;
      if (resolved.providerName === 'meta' && t.extraMediaIds && t.extraMediaIds.length) {
        throw new HttpError(422, 'Meta templates support one media header. Remove the additional attachments before submitting this template.');
      }
      const attachmentType = attachmentTypeOf(t);
      if (MEDIA_HEADERS.includes(attachmentType) && !media) throw new HttpError(422, 'The attachment of this template no longer exists. Choose a file again and save.');
      if (resolved.providerName === 'meta' && !String(t.body || '').trim()) {
        throw new HttpError(422, 'Official WhatsApp API needs a body text. Add text or use the QR/mock provider.');
      }
      if (resolved.providerName === 'meta' && textHeaderTypeOf(t) === 'text' && MEDIA_HEADERS.includes(attachmentType)) {
        throw new HttpError(422, 'Official WhatsApp templates support only one header. Remove the header text or the media attachment before submitting.');
      }
      result = await resolved.provider.submitTemplate(resolved.account, { ...t.toObject(), name: remoteName }, media);
    } catch (err) {
      throw providerFailure(err);
    }
    const updated = await Template.findOneAndUpdate(
      { _id: t._id, status: { $in: ['draft', 'rejected'] } },
      { $set: {
        status: result.status === 'APPROVED' ? 'approved' : 'pending',
        providerTemplateId: result.providerTemplateId || '',
        providerTemplateName: remoteName,
        syncSource: resolved.source === 'platform' && resolved.providerName === 'meta' ? 'platform_meta' : resolved.providerName,
        rejectionReason: '',
      } },
      { new: true },
    );
    if (!updated) throw new HttpError(409, 'Template state changed; refresh and try again.');
    await audit(req, 'template.submit', { targetType: 'template', targetId: t._id, ownerId: req.user._id, meta: { provider: resolved.providerName } });
    res.json({ template: await withMedia(updated) });
  }),
);

router.delete(
  '/:id',
  ah(async (req, res) => {
    const t = await Template.findOne({ _id: req.params.id, ownerId: req.user._id });
    if (!t) throw new HttpError(404, 'Template not found');
    const used = await Campaign.countDocuments({ ownerId: req.user._id, templateId: t._id, status: { $in: REFERENCING } });
    if (used) throw new HttpError(409, `This template is used by ${used} active or draft campaign(s). Remove or finish them first.`);
    await Template.deleteOne({ _id: t._id, ownerId: req.user._id });
    await audit(req, 'template.delete', { targetType: 'template', targetId: t._id, ownerId: req.user._id, meta: { name: t.name } });
    res.json({ ok: true });
  }),
);

module.exports = router;
