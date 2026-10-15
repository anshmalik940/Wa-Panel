/** Minimal RFC-4180 CSV parser/serialiser (quotes, escaped quotes, CRLF, BOM, ; or tab delimiters). */

function detectDelimiter(headerLine) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of headerLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ',';
}

function parseCSV(text) {
  let src = String(text ?? '');
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const delimiter = detectDelimiter(src.split(/\r?\n/, 1)[0] || '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === '') inQuotes = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Neutralise spreadsheet formula injection while keeping normal phone numbers ("+9198...") intact. */
function safeCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=@\t\r]/.test(s) || /^[+-][^0-9\s().-]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(rows) {
  return `${rows.map((r) => r.map(safeCell).join(',')).join('\r\n')}\r\n`;
}

module.exports = { parseCSV, toCSV };
