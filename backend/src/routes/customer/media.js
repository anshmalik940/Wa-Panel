const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { Media, Template, Campaign } = require('../../models');
const { HttpError, asyncHandler: ah, idParam } = require('../../utils/httpError');
const { audit } = require('../../utils/audit');
const { detect, LIMITS, saveFile, removeFile, serialize } = require('../../utils/media');
const { pageParams, pageResult } = require('../../utils/pagination');

const router = express.Router();
router.param('id', idParam);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024, files: 1 } });
const MAX_FILES_PER_OWNER = 300;

router.get(
  '/',
  ah(async (req, res) => {
    const filter = { ownerId: req.user._id };
    if (['image', 'video', 'document', 'audio'].includes(req.query.kind)) filter.kind = req.query.kind;
    const pp = pageParams(req.query, { defLimit: 30 });
    const [rows, total] = await Promise.all([Media.find(filter).sort({ createdAt: -1 }).skip(pp.skip).limit(pp.limit), Media.countDocuments(filter)]);
    res.json(pageResult(rows.map(serialize), total, pp));
  }),
);

router.post(
  '/',
  (req, res, next) =>
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'File is too large. Images up to 5 MB; video, audio and documents up to 16 MB.'));
      return next(new HttpError(400, `Upload failed: ${err.message}`));
    }),
  ah(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Choose a file to upload (form field "file").');
    const info = detect(req.file.buffer, req.file.originalname);
    if (!info) throw new HttpError(415, 'Unsupported file. Use JPG/PNG images, MP4/3GP video, PDF/Word/Excel documents, or MP3/WAV/OGG/M4A audio.');
    const wanted = req.query.kind;
    if (wanted && wanted !== info.kind) throw new HttpError(415, `This is a ${info.kind} file, but a ${wanted} is required here.`);
    if (req.file.size > LIMITS[info.kind]) throw new HttpError(413, `${info.kind[0].toUpperCase()}${info.kind.slice(1)} files can be at most ${LIMITS[info.kind] / 1048576} MB.`);
    if ((await Media.countDocuments({ ownerId: req.user._id })) >= MAX_FILES_PER_OWNER) throw new HttpError(422, `You have reached the limit of ${MAX_FILES_PER_OWNER} uploaded files. Delete some first.`);
    const storedName = saveFile(req.file.buffer, info.ext);
    const m = await Media.create({
      ownerId: req.user._id,
      kind: info.kind,
      mime: info.mime,
      size: req.file.size,
      originalName: req.file.originalname.slice(0, 120),
      storedName,
      token: crypto.randomBytes(24).toString('hex'),
    });
    await audit(req, 'media.upload', { targetType: 'media', targetId: m._id, ownerId: req.user._id, meta: { kind: m.kind, size: m.size } });
    res.status(201).json({ media: serialize(m) });
  }),
);

router.delete(
  '/:id',
  ah(async (req, res) => {
    const m = await Media.findOne({ _id: req.params.id, ownerId: req.user._id });
    if (!m) throw new HttpError(404, 'File not found');
    const usedByTemplate = await Template.countDocuments({ ownerId: req.user._id, $or: [{ mediaId: m._id }, { extraMediaIds: m._id }] });
    const usedByCampaign = await Campaign.countDocuments({ ownerId: req.user._id, status: { $in: ['draft', 'scheduled', 'queued', 'running', 'paused'] }, $or: [{ 'voice.audioMediaId': m._id }, { 'templateSnapshot.media.id': String(m._id) }, { 'templateSnapshot.media': { $elemMatch: { id: String(m._id) } } }] });
    if (usedByTemplate || usedByCampaign) throw new HttpError(409, 'This file is used by a template or an active campaign. Remove it there first.');
    await Media.deleteOne({ _id: m._id });
    await removeFile(m);
    await audit(req, 'media.delete', { targetType: 'media', targetId: m._id, ownerId: req.user._id });
    res.json({ ok: true });
  }),
);

module.exports = router;
