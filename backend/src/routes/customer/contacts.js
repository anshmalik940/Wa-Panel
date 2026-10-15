const express = require('express');
const { z } = require('zod');
const { config } = require('../../config');
const { Contact } = require('../../models');
const { validate } = require('../../middleware/validate');
const { HttpError, asyncHandler: ah, idParam, OBJECT_ID_RE } = require('../../utils/httpError');
const { normalizePhone } = require('../../utils/phone');
const { parseCSV, toCSV } = require('../../utils/csv');
const { pageParams, pageResult, escapeRegex } = require('../../utils/pagination');
const { audit } = require('../../utils/audit');
const { limitsOf } = require('../../services/usage');

const router = express.Router();
router.param('id', idParam);

const MAX_IMPORT_ROWS = 20000;
const objectId = z.string().regex(OBJECT_ID_RE, 'Invalid id');
const group = z.string().trim().min(1, 'Group name is required').max(50);
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .max(200)
  .refine((v) => !v || z.string().email().safeParse(v).success, 'Enter a valid email address');

const contactSchema = z.object({
  name: z.string().trim().max(120).default(''),
  phone: z.string().trim().min(1, 'Phone number is required').max(40),
  email: emailField.default(''),
  groups: z.array(group).max(20).default([]),
  attributes: z.record(z.union([z.string(), z.number()]).transform(String)).default({}),
});
const patchSchema = contactSchema.partial().extend({ optedOut: z.boolean().optional() }).strict();

const uniq = (arr) => [...new Set(arr)];

function cleanAttributes(obj) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj || {})) {
    const key = String(k).toLowerCase().trim().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
    if (!key || v === undefined || v === null || String(v).trim() === '') continue;
    n += 1;
    if (n > 30) break;
    out[key] = String(v).trim().slice(0, 500);
  }
  return out;
}

async function assertCapacity(user, adding) {
  const count = await Contact.countDocuments({ ownerId: user._id });
  const cap = limitsOf(user).contacts;
  if (count + adding > cap) {
    throw new HttpError(422, `Contact limit reached (${count}/${cap}). Delete contacts or ask your administrator to raise the limit.`);
  }
}

function buildFilter(ownerId, q) {
  const f = { ownerId };
  if (q.q) {
    const r = new RegExp(escapeRegex(String(q.q).slice(0, 100)), 'i');
    f.$or = [{ name: r }, { phone: r }, { email: r }];
  }
  if (q.group) f.groups = String(q.group);
  switch (q.status) {
    case 'valid': Object.assign(f, { phoneValid: true, optedOut: false }); break;
    case 'invalid': f.phoneValid = false; break;
    case 'optedout': f.optedOut = true; break;
    case 'subscribed': f.optedOut = false; break;
    default: break;
  }
  return f;
}

const SORTS = { createdAt: 'createdAt', name: 'name', phone: 'phone' };

router.get(
  '/',
  ah(async (req, res) => {
    const filter = buildFilter(req.user._id, req.query);
    const pp = pageParams(req.query);
    const sortField = SORTS[req.query.sort] || 'createdAt';
    const dir = req.query.dir === 'asc' ? 1 : -1;
    const [rows, total] = await Promise.all([
      Contact.find(filter).sort({ [sortField]: dir, _id: -1 }).skip(pp.skip).limit(pp.limit),
      Contact.countDocuments(filter),
    ]);
    res.json(pageResult(rows, total, pp));
  }),
);

router.post(
  '/',
  validate(contactSchema),
  ah(async (req, res) => {
    const { phone, valid } = normalizePhone(req.body.phone, config.DEFAULT_COUNTRY_CODE);
    await assertCapacity(req.user, 1);
    const contact = await Contact.create({
      ownerId: req.user._id,
      name: req.body.name,
      phone,
      phoneValid: valid,
      email: req.body.email,
      groups: uniq(req.body.groups),
      attributes: cleanAttributes(req.body.attributes),
    });
    await audit(req, 'contact.create', { targetType: 'contact', targetId: contact._id, ownerId: req.user._id });
    res.status(201).json({ contact, warning: valid ? null : 'This phone number does not look valid. The contact is saved but will be excluded from campaigns until fixed.' });
  }),
);

/* ---- groups ---- */
router.get(
  '/groups',
  ah(async (req, res) => {
    const names = (await Contact.distinct('groups', { ownerId: req.user._id })).filter(Boolean).sort((a, b) => a.localeCompare(b));
    const counts = await Promise.all(names.map((name) => Contact.countDocuments({ ownerId: req.user._id, groups: name })));
    res.json({ groups: names.map((name, i) => ({ name, count: counts[i] })) });
  }),
);

router.patch(
  '/groups/:name',
  validate(z.object({ name: group })),
  ah(async (req, res) => {
    const oldName = req.params.name;
    const newName = req.body.name;
    if (oldName === newName) throw new HttpError(400, 'The new name is the same as the old one');
    const filter = { ownerId: req.user._id, groups: oldName };
    const matched = await Contact.countDocuments(filter);
    if (!matched) throw new HttpError(404, 'Group not found');
    await Contact.updateMany(filter, { $addToSet: { groups: newName } });
    await Contact.updateMany({ ownerId: req.user._id, groups: oldName }, { $pull: { groups: oldName } });
    await audit(req, 'contact.group_rename', { ownerId: req.user._id, meta: { from: oldName, to: newName, contacts: matched } });
    res.json({ renamed: matched });
  }),
);

router.delete(
  '/groups/:name',
  ah(async (req, res) => {
    const r = await Contact.updateMany({ ownerId: req.user._id, groups: req.params.name }, { $pull: { groups: req.params.name } });
    if (!r.matchedCount) throw new HttpError(404, 'Group not found');
    await audit(req, 'contact.group_delete', { ownerId: req.user._id, meta: { group: req.params.name, contacts: r.modifiedCount } });
    res.json({ removedFrom: r.modifiedCount });
  }),
);

/* ---- bulk ---- */
const bulkSchema = z
  .object({
    action: z.enum(['delete', 'addGroup', 'removeGroup', 'optOut', 'optIn']),
    ids: z.array(objectId).min(1).max(1000),
    group: group.optional(),
  })
  .refine((v) => !['addGroup', 'removeGroup'].includes(v.action) || v.group, { message: 'Group is required', path: ['group'] });

router.post(
  '/bulk',
  validate(bulkSchema),
  ah(async (req, res) => {
    const { action, ids, group: g } = req.body;
    const filter = { ownerId: req.user._id, _id: { $in: ids } };
    let r;
    if (action === 'delete') r = await Contact.deleteMany(filter);
    else if (action === 'addGroup') r = await Contact.updateMany(filter, { $addToSet: { groups: g } });
    else if (action === 'removeGroup') r = await Contact.updateMany(filter, { $pull: { groups: g } });
    else if (action === 'optOut') r = await Contact.updateMany(filter, { $set: { optedOut: true, optedOutAt: new Date(), optOutSource: 'manual' } });
    else r = await Contact.updateMany(filter, { $set: { optedOut: false, optedOutAt: null, optOutSource: '' } });
    await audit(req, `contact.bulk_${action}`, { ownerId: req.user._id, meta: { requested: ids.length, affected: r.deletedCount ?? r.modifiedCount } });
    res.json({ requested: ids.length, affected: r.deletedCount ?? r.modifiedCount });
  }),
);

/* ---- import / export ---- */
const SYNONYMS = {
  phone: ['phone', 'mobile', 'number', 'whatsapp', 'phone number', 'mobile number', 'whatsapp number', 'contact number', 'msisdn', 'cell'],
  name: ['name', 'full name', 'fullname', 'contact name', 'customer name'],
  email: ['email', 'e mail', 'email address', 'mail', 'email id', 'mail id'],
  groups: ['group', 'groups', 'tag', 'tags', 'list'],
};
const norm = (h) => String(h).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

function detectMapping(headers) {
  const out = {};
  for (const [field, names] of Object.entries(SYNONYMS)) {
    const found = headers.find((h) => names.includes(norm(h)));
    if (found) out[field] = found;
  }
  return out;
}

const mappingSchema = z.object({
  phone: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  groups: z.string().optional(),
});

router.post(
  '/import/preview',
  validate(z.object({ csv: z.string().min(1, 'CSV content is empty') })),
  ah(async (req, res) => {
    const rows = parseCSV(req.body.csv).filter((r) => r.some((c) => String(c).trim() !== ''));
    if (rows.length < 2) throw new HttpError(400, 'The file needs a header row and at least one data row');
    const headers = rows[0].map((h) => h.trim());
    res.json({ headers, sample: rows.slice(1, 6), totalRows: rows.length - 1, mapping: detectMapping(headers), maxRows: MAX_IMPORT_ROWS });
  }),
);

const importSchema = z.object({
  csv: z.string().min(1, 'CSV content is empty'),
  mapping: mappingSchema.optional(),
  duplicateMode: z.enum(['skip', 'update']).default('skip'),
  defaultGroup: group.optional(),
});

router.post(
  '/import',
  validate(importSchema),
  ah(async (req, res) => {
    const { csv, duplicateMode, defaultGroup } = req.body;
    const rows = parseCSV(csv);
    const headers = (rows[0] || []).map((h) => h.trim());
    const dataRowCount = rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== '')).length;
    if (dataRowCount < 1) throw new HttpError(400, 'The file needs a header row and at least one data row');
    if (dataRowCount > MAX_IMPORT_ROWS) throw new HttpError(400, `Too many rows (${dataRowCount}). Import at most ${MAX_IMPORT_ROWS} rows at a time.`);

    const mapping = { ...detectMapping(headers), ...(req.body.mapping || {}) };
    for (const k of Object.keys(mapping)) if (!mapping[k]) delete mapping[k];
    const idx = (field) => (mapping[field] ? headers.indexOf(mapping[field]) : -1);
    const phoneIdx = idx('phone');
    if (phoneIdx < 0) throw new HttpError(400, 'Could not find the phone column. Choose which column contains phone numbers.', [{ field: 'mapping.phone', message: 'Phone column is required' }]);
    const nameIdx = idx('name');
    const emailIdx = idx('email');
    const groupsIdx = idx('groups');
    const used = new Set([phoneIdx, nameIdx, emailIdx, groupsIdx].filter((i) => i >= 0));

    const errors = [];
    const records = [];
    const seen = new Set();
    let skippedInFile = 0;
    let flaggedInvalid = 0;
    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row.some((c) => String(c).trim() !== '')) continue;
      const rowNo = i + 1;
      const rawPhone = String(row[phoneIdx] ?? '').trim();
      if (!rawPhone) {
        errors.push({ row: rowNo, message: 'Phone number is empty' });
        continue;
      }
      const email = emailIdx >= 0 ? String(row[emailIdx] ?? '').trim().toLowerCase() : '';
      if (email && !z.string().email().max(200).safeParse(email).success) {
        errors.push({ row: rowNo, message: `Invalid email "${email.slice(0, 60)}"` });
        continue;
      }
      const { phone, valid } = normalizePhone(rawPhone, config.DEFAULT_COUNTRY_CODE);
      if (seen.has(phone)) {
        skippedInFile += 1;
        continue;
      }
      seen.add(phone);
      if (!valid) flaggedInvalid += 1;
      const groups = uniq([
        ...(groupsIdx >= 0 ? String(row[groupsIdx] ?? '').split(/[;|]/).map((g) => g.trim().slice(0, 50)).filter(Boolean) : []),
        ...(defaultGroup ? [defaultGroup] : []),
      ]).slice(0, 20);
      const attrs = {};
      headers.forEach((h, c) => {
        if (!used.has(c) && h) attrs[h] = row[c];
      });
      records.push({
        phone,
        valid,
        name: nameIdx >= 0 ? String(row[nameIdx] ?? '').trim().slice(0, 120) : '',
        email,
        groups,
        attributes: cleanAttributes(attrs),
      });
    }

    // existing contacts for duplicate detection (by normalised phone)
    const existing = new Map();
    for (let i = 0; i < records.length; i += 500) {
      const chunk = records.slice(i, i + 500).map((r) => r.phone);
      for (const c of await Contact.find({ ownerId: req.user._id, phone: { $in: chunk } }).select('phone').lean()) existing.set(c.phone, c._id);
    }

    const currentCount = await Contact.countDocuments({ ownerId: req.user._id });
    let room = Math.max(0, limitsOf(req.user).contacts - currentCount);
    let created = 0;
    let updated = 0;
    let skippedExisting = 0;
    let limitHit = 0;
    const ops = [];
    for (const r of records) {
      if (existing.has(r.phone)) {
        if (duplicateMode === 'skip') {
          skippedExisting += 1;
          continue;
        }
        const set = { phoneValid: r.valid };
        if (r.name) set.name = r.name;
        if (r.email) set.email = r.email;
        for (const [k, v] of Object.entries(r.attributes)) set[`attributes.${k}`] = v;
        const update = { $set: set };
        if (r.groups.length) update.$addToSet = { groups: { $each: r.groups } };
        ops.push({ updateOne: { filter: { ownerId: req.user._id, phone: r.phone }, update } });
        updated += 1;
      } else if (room > 0) {
        room -= 1;
        ops.push({
          updateOne: {
            filter: { ownerId: req.user._id, phone: r.phone },
            update: { $setOnInsert: { ownerId: req.user._id, phone: r.phone, phoneValid: r.valid, name: r.name, email: r.email, groups: r.groups, attributes: r.attributes } },
            upsert: true,
          },
        });
        created += 1;
      } else {
        limitHit += 1;
        errors.push({ row: null, message: `Contact limit reached (${limitsOf(req.user).contacts}); "${r.phone}" was not imported` });
      }
    }
    for (let i = 0; i < ops.length; i += 500) await Contact.bulkWrite(ops.slice(i, i + 500), { ordered: false });

    const report = {
      totalRows: dataRowCount,
      created,
      updated,
      skippedExisting,
      skippedDuplicateInFile: skippedInFile,
      flaggedInvalidPhone: flaggedInvalid,
      notImportedLimit: limitHit,
      errorCount: errors.length,
      errors: errors.slice(0, 100),
    };
    await audit(req, 'contact.import', { ownerId: req.user._id, meta: { created, updated, skippedExisting, errors: errors.length } });
    res.json(report);
  }),
);

router.get(
  '/export',
  ah(async (req, res) => {
    const filter = buildFilter(req.user._id, req.query);
    const contacts = await Contact.find(filter).sort({ createdAt: 1 }).limit(100000).lean();
    const attrKeys = uniq(contacts.flatMap((c) => Object.keys(c.attributes || {}))).sort();
    const rows = [['name', 'phone', 'email', 'groups', 'status', ...attrKeys]];
    for (const c of contacts) {
      const status = c.optedOut ? 'opted_out' : c.phoneValid ? 'valid' : 'invalid_phone';
      rows.push([c.name, c.phone, c.email, (c.groups || []).join(';'), status, ...attrKeys.map((k) => (c.attributes || {})[k] ?? '')]);
    }
    await audit(req, 'contact.export', { ownerId: req.user._id, meta: { rows: contacts.length } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`\uFEFF${toCSV(rows)}`);
  }),
);

/* ---- duplicates ---- */
const brief = (c) => ({ id: c._id, name: c.name, phone: c.phone, email: c.email, groups: c.groups, optedOut: c.optedOut, createdAt: c.createdAt });

router.get(
  '/duplicates',
  ah(async (req, res) => {
    const contacts = await Contact.find({ ownerId: req.user._id }).sort({ createdAt: 1 }).limit(20000).lean();
    const byEmail = new Map();
    const byName = new Map();
    for (const c of contacts) {
      if (c.email) byEmail.set(c.email, [...(byEmail.get(c.email) || []), c]);
      const n = String(c.name || '').trim().toLowerCase();
      if (n) byName.set(n, [...(byName.get(n) || []), c]);
    }
    const clusters = [];
    const inEmailCluster = new Set();
    for (const [key, list] of byEmail) {
      if (list.length > 1) {
        clusters.push({ type: 'email', key, contacts: list.map(brief) });
        list.forEach((c) => inEmailCluster.add(String(c._id)));
      }
    }
    for (const [key, list] of byName) {
      const rest = list.filter((c) => !inEmailCluster.has(String(c._id)));
      if (rest.length > 1) clusters.push({ type: 'name', key, contacts: rest.map(brief) });
    }
    res.json({ clusters, total: clusters.length, scanned: contacts.length });
  }),
);

router.post(
  '/merge',
  validate(z.object({ keepId: objectId, mergeIds: z.array(objectId).min(1).max(50) })),
  ah(async (req, res) => {
    const { keepId, mergeIds } = req.body;
    if (mergeIds.includes(keepId)) throw new HttpError(400, 'The contact to keep cannot also be merged away');
    const keep = await Contact.findOne({ _id: keepId, ownerId: req.user._id });
    const others = await Contact.find({ _id: { $in: mergeIds }, ownerId: req.user._id });
    if (!keep || others.length !== mergeIds.length) throw new HttpError(404, 'One or more contacts were not found');
    const groups = uniq([...keep.groups, ...others.flatMap((o) => o.groups)]).slice(0, 20);
    const attributes = Object.assign({}, ...others.map((o) => o.attributes || {}), keep.attributes || {});
    const set = { groups, attributes };
    if (!keep.name) set.name = (others.find((o) => o.name) || {}).name || '';
    if (!keep.email) set.email = (others.find((o) => o.email) || {}).email || '';
    // opt-out is sticky: if any copy opted out, the merged contact stays opted out
    if (!keep.optedOut && others.some((o) => o.optedOut)) Object.assign(set, { optedOut: true, optedOutAt: new Date(), optOutSource: 'merge' });
    const merged = await Contact.findOneAndUpdate({ _id: keep._id }, { $set: set }, { new: true });
    await Contact.deleteMany({ _id: { $in: mergeIds }, ownerId: req.user._id });
    await audit(req, 'contact.merge', { targetType: 'contact', targetId: keep._id, ownerId: req.user._id, meta: { merged: mergeIds.length } });
    res.json({ contact: merged, mergedAway: mergeIds.length });
  }),
);

/* ---- single contact ---- */
router.get(
  '/:id',
  ah(async (req, res) => {
    const contact = await Contact.findOne({ _id: req.params.id, ownerId: req.user._id });
    if (!contact) throw new HttpError(404, 'Contact not found');
    res.json({ contact });
  }),
);

router.patch(
  '/:id',
  validate(patchSchema),
  ah(async (req, res) => {
    const contact = await Contact.findOne({ _id: req.params.id, ownerId: req.user._id });
    if (!contact) throw new HttpError(404, 'Contact not found');
    const b = req.body;
    const set = {};
    if (b.name !== undefined) set.name = b.name;
    if (b.email !== undefined) set.email = b.email;
    if (b.groups !== undefined) set.groups = uniq(b.groups);
    if (b.attributes !== undefined) set.attributes = cleanAttributes(b.attributes);
    if (b.phone !== undefined) {
      const { phone, valid } = normalizePhone(b.phone, config.DEFAULT_COUNTRY_CODE);
      if (phone !== contact.phone && (await Contact.exists({ ownerId: req.user._id, phone, _id: { $ne: contact._id } }))) {
        throw new HttpError(409, 'Another contact already uses this phone number', [{ field: 'phone', message: 'Already used by another contact' }]);
      }
      set.phone = phone;
      set.phoneValid = valid;
    }
    if (b.optedOut !== undefined && b.optedOut !== contact.optedOut) {
      set.optedOut = b.optedOut;
      set.optedOutAt = b.optedOut ? new Date() : null;
      set.optOutSource = b.optedOut ? 'manual' : '';
    }
    if (!Object.keys(set).length) throw new HttpError(400, 'Nothing to update');
    const updated = await Contact.findOneAndUpdate({ _id: contact._id, ownerId: req.user._id }, { $set: set }, { new: true });
    await audit(req, 'contact.update', { targetType: 'contact', targetId: contact._id, ownerId: req.user._id, meta: { fields: Object.keys(set) } });
    res.json({ contact: updated, warning: set.phoneValid === false ? 'This phone number does not look valid and will be excluded from campaigns.' : null });
  }),
);

router.delete(
  '/:id',
  ah(async (req, res) => {
    const r = await Contact.deleteOne({ _id: req.params.id, ownerId: req.user._id });
    if (!r.deletedCount) throw new HttpError(404, 'Contact not found');
    await audit(req, 'contact.delete', { targetType: 'contact', targetId: req.params.id, ownerId: req.user._id });
    res.json({ ok: true });
  }),
);

module.exports = router;
