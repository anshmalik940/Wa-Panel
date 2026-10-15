/**
 * Normalise a phone number to E.164 ("+<digits>").
 * Returns { phone, valid }. Invalid numbers keep a best-effort cleaned value so the
 * user can see and fix them; they are excluded from campaigns.
 */
function normalizePhone(raw, defaultCountryCode = '91') {
  const input = String(raw ?? '').trim();
  if (!input) return { phone: '', valid: false };
  if (/[a-z]/i.test(input)) return { phone: input.slice(0, 40), valid: false };

  let digits = input.replace(/\D/g, '');
  if (!digits) return { phone: input.slice(0, 40), valid: false };
  let international = input.startsWith('+');

  if (!international && digits.startsWith('00')) {
    digits = digits.slice(2);
    international = true;
  }
  if (!international && defaultCountryCode) {
    if (digits.length === 10) digits = defaultCountryCode + digits; // local number
    else if (digits.length === 11 && digits.startsWith('0')) digits = defaultCountryCode + digits.slice(1);
  }
  const phone = `+${digits}`;
  return { phone, valid: /^\+[1-9]\d{7,14}$/.test(phone) };
}

module.exports = { normalizePhone };
