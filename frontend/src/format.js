export const fmtNumber = (n) => (typeof n === 'number' ? n.toLocaleString() : n ?? '0');

export function fmtDate(value, { time = true } = {}) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, time ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

export function fmtRelative(value) {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return fmtDate(value, { time: false });
}

export const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** <input type="datetime-local"> value for a Date / ISO string, in the browser's time zone. */
export function toLocalInput(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const initials = (name) =>
  String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

export const humanize = (s) => String(s || '').replace(/[_.]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Human text for a message exclusion reason code. */
export function excludedReasonText(code) {
  if (!code) return '';
  if (code === 'opted_out') return 'Opted out';
  if (code === 'invalid_phone') return 'Invalid phone number';
  if (code.startsWith('missing_variable')) return `Missing value for {{${code.split(':')[1] || ''}}}`;
  return humanize(code);
}

/** The API reports "no limit" as a huge number (>= 1,000,000,000). */
export const isUnlimited = (n) => typeof n === 'number' && n >= 1000000000;
export const fmtLimit = (n) => (isUnlimited(n) ? 'Unlimited' : fmtNumber(n));

export function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export const PROVIDER_LABEL = { mock: 'Mock (simulation)', meta: 'WhatsApp Cloud API', qr: 'Linked phone (QR)' };
export const providerLabel = (p) => PROVIDER_LABEL[p] || humanize(p);
