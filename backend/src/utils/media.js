const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');

const MB = 1024 * 1024;

/** What WhatsApp accepts (images 5 MB, video/audio/documents 16 MB here). The type is detected from the file BYTES, not the client's claim. */
const LIMITS = { image: 5 * MB, video: 16 * MB, document: 16 * MB, audio: 16 * MB };

function detect(buf, originalName = '') {
  const b = buf;
  const ext = path.extname(originalName).toLowerCase();
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mime: 'image/jpeg', ext: '.jpg' };
  if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', mime: 'image/png', ext: '.png' };
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WAVE') return { kind: 'audio', mime: 'audio/wav', ext: '.wav' };
  if (b.slice(0, 4).toString() === 'OggS') return { kind: 'audio', mime: 'audio/ogg', ext: '.ogg' };
  if (b.slice(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { kind: 'audio', mime: 'audio/mpeg', ext: '.mp3' };
  if (b.slice(4, 8).toString() === 'ftyp') {
    const brand = b.slice(8, 12).toString();
    if (brand === 'M4A ' || brand === 'M4B ') return { kind: 'audio', mime: 'audio/mp4', ext: '.m4a' };
    if (brand.startsWith('3gp')) return { kind: 'video', mime: 'video/3gpp', ext: '.3gp' };
    return { kind: 'video', mime: 'video/mp4', ext: '.mp4' };
  }
  if (b.slice(0, 4).toString() === '%PDF') return { kind: 'document', mime: 'application/pdf', ext: '.pdf' };
  const zip = b[0] === 0x50 && b[1] === 0x4b;
  const ole = b.slice(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  if (zip && ext === '.docx') return { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext };
  if (zip && ext === '.xlsx') return { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext };
  if (zip && ext === '.pptx') return { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext };
  if (ole && ext === '.doc') return { kind: 'document', mime: 'application/msword', ext };
  if (ole && ext === '.xls') return { kind: 'document', mime: 'application/vnd.ms-excel', ext };
  return null;
}

const uploadDir = () => path.join(config.DATA_DIR, 'uploads');

function saveFile(buf, ext) {
  fs.mkdirSync(uploadDir(), { recursive: true });
  const storedName = `${crypto.randomBytes(16).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(uploadDir(), storedName), buf);
  return storedName;
}

const filePath = (m) => path.join(uploadDir(), m.storedName);
const removeFile = (m) => fs.promises.rm(filePath(m), { force: true });

const safeName = (n) => String(n || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 80);

/** Public URL: WhatsApp (Meta) downloads the media from here, so PUBLIC_API_URL must be reachable from the internet in production. */
function publicUrl(m) {
  return `${config.PUBLIC_API_URL.replace(/\/$/, '')}/media/${m.token}/${encodeURIComponent(safeName(m.originalName || m.storedName))}`;
}

function serialize(m) {
  return { id: m._id, kind: m.kind, mime: m.mime, size: m.size, name: m.originalName, url: publicUrl(m), createdAt: m.createdAt };
}

module.exports = { LIMITS, detect, saveFile, filePath, removeFile, publicUrl, serialize, safeName };
