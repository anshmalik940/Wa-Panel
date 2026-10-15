// Thin fetch wrapper. Every call returns parsed JSON or throws ApiError with a readable message.
const BASE = (import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '');
const KEY = 'wa_panel_token';

let memoryToken = null; // fallback when localStorage is blocked
export const tokenStore = {
  get() {
    try {
      return localStorage.getItem(KEY) || memoryToken;
    } catch {
      return memoryToken;
    }
  },
  set(token) {
    memoryToken = token;
    try {
      localStorage.setItem(KEY, token);
    } catch {
      /* storage unavailable: the in-memory copy keeps this tab signed in */
    }
  },
  clear() {
    memoryToken = null;
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  },
};

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }

  /** { fieldName: message } for the field-level errors the API returns. */
  get fields() {
    const out = {};
    if (Array.isArray(this.details)) for (const d of this.details) if (d && d.field && !out[d.field]) out[d.field] = d.message;
    return out;
  }

  /** Campaign validation problems: [{ code, message }] */
  get issues() {
    return this.details && !Array.isArray(this.details) && Array.isArray(this.details.issues) ? this.details.issues : [];
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

function buildUrl(path, query) {
  const url = `${BASE}/api${path}`;
  if (!query) return url;
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const qs = p.toString();
  return qs ? `${url}?${qs}` : url;
}

async function send(method, path, { body, query, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = tokenStore.get();
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(buildUrl(path, query), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection and that the API is running.');
  }
  return res;
}

async function parse(res, { auth = true } = {}) {
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const message = (data && data.error) || `Request failed (HTTP ${res.status})`;
    if (res.status === 401 && auth && tokenStore.get()) onUnauthorized(message);
    throw new ApiError(res.status, message, data && data.details);
  }
  return data;
}

async function request(method, path, opts = {}) {
  const res = await send(method, path, opts);
  return parse(res, opts);
}

export const api = {
  get: (path, query, opts) => request('GET', path, { query, ...opts }),
  post: (path, body, opts) => request('POST', path, { body: body === undefined ? {} : body, ...opts }),
  put: (path, body, opts) => request('PUT', path, { body, ...opts }),
  patch: (path, body, opts) => request('PATCH', path, { body, ...opts }),
  del: (path, opts) => request('DELETE', path, opts),

  /** Uploads one file as multipart form data (field "file") with progress callbacks. */
  upload(path, file, { query, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', buildUrl(path, query));
      const token = tokenStore.get();
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onerror = () => reject(new ApiError(0, 'Cannot reach the server. Check your connection and that the API is running.'));
      xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled'));
      xhr.onload = () => {
        let data = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
          return;
        }
        const message = (data && data.error) || (xhr.status === 413 ? 'The file is too large.' : `Upload failed (HTTP ${xhr.status})`);
        if (xhr.status === 401 && token) onUnauthorized(message);
        reject(new ApiError(xhr.status, message, data && data.details));
      };
      const fd = new FormData();
      fd.append('file', file);
      xhr.send(fd);
    });
  },

  /** Downloads a file response (CSV exports) through the browser. */
  async download(path, query, fallbackName = 'download.csv') {
    const res = await send('GET', path, { query });
    if (!res.ok) await parse(res);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="?([^";]+)"?/i.exec(cd);
    const name = m ? m[1] : fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return name;
  },
};

export const errorMessage = (err) => (err && err.message ? err.message : 'Something went wrong');
