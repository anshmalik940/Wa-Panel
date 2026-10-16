import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../api.js';
import { humanize } from '../format.js';

/* ---------------- toasts ---------------- */
const ToastContext = createContext(null);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const idRef = useRef(0);
  const dismiss = useCallback((id) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (tone, message) => {
      const id = ++idRef.current;
      setItems((list) => [...list.slice(-3), { id, tone, message }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4000);
    },
    [dismiss],
  );
  const api = useMemo(
    () => ({
      success: (m) => push('success', m),
      error: (m) => push('error', typeof m === 'string' ? m : errorMessage(m)),
      info: (m) => push('info', m),
    }),
    [push],
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <span>{t.message}</span>
            <button className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ---------------- modal + confirm ---------------- */
export function Modal({ open, title, onClose, children, footer, wide = false, busy = false }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = ref.current && ref.current.querySelector('input:not([type=hidden]), select, textarea');
    if (first) first.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose, busy]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

const ConfirmContext = createContext(null);
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const confirm = useCallback(
    (opts) =>
      new Promise((resolve) => {
        setState({ ...opts, resolve });
      }),
    [],
  );
  const close = (result) => {
    if (state) state.resolve(result);
    setState(null);
    setBusy(false);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={Boolean(state)}
        title={state ? state.title || 'Are you sure?' : ''}
        onClose={() => close(false)}
        busy={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              variant={state && state.danger ? 'danger' : 'primary'}
              loading={busy}
              onClick={async () => {
                if (state && state.onConfirm) {
                  setBusy(true);
                  try {
                    await state.onConfirm();
                    close(true);
                  } catch {
                    close(false); // the caller reports the error through its own toast
                  }
                } else close(true);
              }}
            >
              {state && state.confirmText ? state.confirmText : 'Confirm'}
            </Button>
          </>
        }
      >
        <p className="confirm-text">{state ? state.message : ''}</p>
      </Modal>
    </ConfirmContext.Provider>
  );
}

/* ---------------- basics ---------------- */
export function Button({ variant = 'default', size, loading = false, disabled, children, className = '', type = 'button', ...rest }) {
  return (
    <button type={type} className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${className}`} disabled={disabled || loading} {...rest}>
      {loading ? <span className="spinner spinner-inline" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Field({ label, error, hint, children, required, className = '' }) {
  const id = useId();
  const child =
    isValidElement(children) && typeof children.type === 'string' && ['input', 'select', 'textarea'].includes(children.type) && !children.props.id
      ? cloneElement(children, { id, 'aria-invalid': error ? true : undefined })
      : children;
  return (
    <div className={`field ${error ? 'has-error' : ''} ${className}`}>
      {label ? (
        <label htmlFor={id}>
          {label}
          {required ? <span className="req"> *</span> : null}
        </label>
      ) : null}
      {child}
      {hint && !error ? <div className="hint">{hint}</div> : null}
      {error ? <div className="error-text">{error}</div> : null}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="center-block" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="muted">{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="state state-error" role="alert">
      <strong>Could not load this page</strong>
      <p>{errorMessage(error)}</p>
      {onRetry ? (
        <Button onClick={() => onRetry()} size="sm">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, children, action }) {
  return (
    <div className="state">
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
      {action || null}
    </div>
  );
}

export function Card({ title, actions, children, className = '', pad = true }) {
  return (
    <section className={`card ${className}`}>
      {title || actions ? (
        <header className="card-head">
          <h3>{title}</h3>
          <div className="row gap-s">{actions}</div>
        </header>
      ) : null}
      <div className={pad ? 'card-body' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      <div className="row gap-s wrap">{actions}</div>
    </div>
  );
}

export function Stat({ label, value, sub, tone }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

export function Progress({ value, max, tone, label }) {
  const p = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const auto = tone || (p >= 90 ? 'danger' : p >= 70 ? 'warn' : 'ok');
  return (
    <div className="progress" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className={`progress-bar progress-${auto}`} style={{ width: `${p}%` }} />
    </div>
  );
}

export function Badge({ tone = 'neutral', children, title }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

const STATUS_TONE = {
  active: 'ok', connected: 'ok', approved: 'ok', completed: 'ok', valid: 'ok', applied: 'ok',
  suspended: 'danger', failed: 'danger', error: 'danger', rejected: 'danger', invalid: 'danger',
  cut: 'warn',
  unknown: 'warn',
  simulated_failed: 'danger', cancelled: 'neutral', excluded: 'neutral',
  paused: 'warn', pending: 'warn', scheduled: 'info', queued: 'info', sending: 'info', running: 'info',
  draft: 'neutral', not_configured: 'neutral', optedout: 'warn', opted_out: 'warn', ignored: 'neutral',
  sent: 'info', delivered: 'ok', read: 'ok', simulated_sent: 'info', simulated_delivered: 'ok', simulated_read: 'ok',
};
const STATUS_LABEL = {
  simulated_sent: 'Sent (simulated)',
  simulated_delivered: 'Delivered (simulated)',
  simulated_read: 'Read (simulated)',
  simulated_failed: 'Failed (simulated)',
  unknown: 'Outcome unknown',
  cut: 'Cutting off',
  not_configured: 'Not configured',
};

export function StatusBadge({ status }) {
  return <Badge tone={STATUS_TONE[status] || 'neutral'}>{STATUS_LABEL[status] || humanize(status)}</Badge>;
}

export function Pagination({ page, pages, total, limit, onPage, noun = 'items' }) {
  if (!total) return null;
  const from = (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  return (
    <div className="pagination">
      <span className="muted">
        {from}–{to} of {total.toLocaleString()} {noun}
      </span>
      <div className="row gap-s">
        <Button size="sm" onClick={() => onPage(page - 1)} disabled={page <= 1}>
          ← Prev
        </Button>
        <span className="muted">
          Page {page} of {pages}
        </span>
        <Button size="sm" onClick={() => onPage(page + 1)} disabled={page >= pages}>
          Next →
        </Button>
      </div>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={`tab ${value === t.value ? 'active' : ''}`} onClick={() => onChange(t.value)}>
          {t.label}
          {t.count !== undefined ? <span className="tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder = 'Search…' }) {
  return <input className="search" type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />;
}

/** Horizontal funnel bars used by campaign reports and dashboards. */
export function Funnel({ stats, voice = false }) {
  const base = stats.recipients || 0;
  // calls have no "read" step: dialled -> answered
  const rows = voice
    ? [
        ['Recipients', base, 'neutral'],
        ['Dialled', stats.sent, 'info'],
        ['Answered', stats.delivered, 'ok'],
        ['Failed', stats.failed, 'danger'],
      ]
    : [
        ['Recipients', base, 'neutral'],
        ['Sent', stats.sent, 'info'],
        ['Delivered', stats.delivered, 'ok'],
        ['Read', stats.read, 'ok'],
        ['Failed', stats.failed, 'danger'],
      ];
  return (
    <div className="funnel">
      {rows.map(([label, n, tone]) => (
        <div className="funnel-row" key={label}>
          <span className="funnel-label">{label}</span>
          <div className="funnel-track">
            <div className={`funnel-fill progress-${tone === 'neutral' ? 'ok' : tone}`} style={{ width: `${base ? Math.min(100, (n / base) * 100) : 0}%` }} />
          </div>
          <span className="funnel-num">
            {(n || 0).toLocaleString()} <span className="muted">({base ? Math.round(((n || 0) / base) * 100) : 0}%)</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Shows the API's per-field/validation issue list inside a form or dialog. */
export function IssueList({ issues, title = 'Fix these before continuing' }) {
  if (!issues || !issues.length) return null;
  return (
    <div className="alert alert-danger" role="alert">
      <strong>{title}</strong>
      <ul>
        {issues.map((i, idx) => (
          <li key={`${i.code || idx}-${idx}`}>{i.message}</li>
        ))}
      </ul>
    </div>
  );
}

export function Alert({ tone = 'info', title, children }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'danger' ? 'alert' : 'note'}>
      {title ? <strong>{title}</strong> : null}
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }) {
  const toast = useToast();
  return (
    <Button
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success('Copied to clipboard');
        } catch {
          toast.error('Copy is not available in this browser — select the text and copy it manually.');
        }
      }}
    >
      {label}
    </Button>
  );
}

export function DataTable({ columns, rows, rowKey = (r) => r._id || r.id, empty, onRowClick, loading }) {
  if (!loading && !rows.length) return empty || null;
  return (
    <div className="table-wrap">
      <table className="table stack">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.className} style={c.width ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={loading ? 'is-loading' : ''}>
          {rows.map((r) => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={onRowClick ? 'clickable' : ''}>
              {columns.map((c) => (
                <td key={c.key} className={c.className} data-label={typeof c.header === 'string' ? c.header : ''}>
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
