const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const VAR_NAME_RE = /^[a-z][a-z0-9_]{0,29}$/;
const MEDIA_TYPES = ['image', 'video', 'document'];

/** Unique, lower-cased placeholder names in order of appearance. */
function extractVars(text) {
  const out = [];
  for (const m of String(text || '').matchAll(VAR_RE)) {
    const v = m[1].toLowerCase();
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function render(text, values) {
  return String(text || '').replace(VAR_RE, (_, name) => {
    const v = values[name.toLowerCase()];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Returns an array of { field, message }. Empty array = valid. */
function validateTemplateFields({ name, language, category, header, headerType, attachmentType, mediaId, body, footer }) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const bodyText = typeof body === 'string' ? body : '';
  const mediaType = attachmentType === undefined
    ? (MEDIA_TYPES.includes(headerType) ? headerType : 'none')
    : attachmentType;
  const hasAttachment = MEDIA_TYPES.includes(mediaType) && Boolean(mediaId);

  if (!name || !/^[a-z][a-z0-9_]{0,59}$/.test(name)) {
    add('name', 'Name must be lowercase letters, numbers and underscores, starting with a letter (max 60).');
  }
  if (!language || !/^[a-z]{2}(_[A-Z]{2})?$/.test(language)) add('language', 'Language must look like "en", "en_US" or "hi".');
  if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category)) add('category', 'Category must be MARKETING, UTILITY or AUTHENTICATION.');
  if (!bodyText.trim() && !hasAttachment) add('body', 'Body is required unless an image, video or document is attached.');
  else if (bodyText.length > 1024) add('body', 'Body can be at most 1024 characters.');
  if (header && header.length > 60) add('header', 'Header can be at most 60 characters.');
  if (footer && footer.length > 60) add('footer', 'Footer can be at most 60 characters.');
  if (header && /\{\{|\}\}/.test(header)) add('header', 'Header cannot contain placeholders.');
  if (footer && /\{\{|\}\}/.test(footer)) add('footer', 'Footer cannot contain placeholders.');

  if (bodyText) {
    const leftover = bodyText.replace(VAR_RE, '');
    if (/\{\{|\}\}/.test(leftover)) add('body', 'Malformed placeholder. Use {{name}} with letters, numbers or underscores only.');
    const vars = extractVars(bodyText);
    if (vars.length > 20) add('body', 'At most 20 distinct placeholders are allowed.');
    for (const v of vars) {
      if (!VAR_NAME_RE.test(v)) add('body', `Placeholder "{{${v}}}" must start with a letter and be at most 30 characters.`);
    }
    if (/^\s*\{\{[^}]+\}\}\s*$/.test(bodyText)) add('body', 'Body cannot consist of a placeholder only.');
  }
  return errors;
}

module.exports = { extractVars, render, validateTemplateFields, VAR_RE };
