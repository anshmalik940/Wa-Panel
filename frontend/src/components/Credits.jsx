import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi } from '../hooks.js';
import { fmtDate, fmtNumber } from '../format.js';
import { Alert, Badge, Button, DataTable, EmptyState, ErrorState, Field, Modal, Pagination, Spinner, Tabs, useToast } from './ui.jsx';

/** Balances at or below this many credits get a low-balance warning. */
export const LOW_CREDITS = 50;

const REASON = {
  topup: ['Top-up', 'ok'],
  adjustment: ['Adjustment', 'warn'],
  transfer_in: ['Transfer in', 'ok'],
  transfer_out: ['Transfer out', 'warn'],
  campaign: ['Campaign usage', 'info'],
  refund: ['Refund', 'ok'],
};

/** Loads one page of a credit ledger. `endpoint` is e.g. /c/credits or /admin/customers/:id/credits. */
export function useLedger(endpoint, limit = 10) {
  const [page, setPage] = useState(1);
  const res = useApi(() => api.get(endpoint, { page, limit }), [endpoint, page, limit]);
  return { ...res, page, setPage };
}

export function LedgerTable({ ledger, campaignLinks = false }) {
  const { data, loading, error, reload, setPage } = ledger;
  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  const columns = [
    { key: 'when', header: 'Date', className: 'nowrap', render: (t) => fmtDate(t.updatedAt || t.createdAt) },
    {
      key: 'reason',
      header: 'Type',
      render: (t) => {
        const [label, tone] = REASON[t.reason] || [t.reason || (t.type === 'credit' ? 'Credit' : 'Debit'), 'neutral'];
        return <Badge tone={tone}>{label}</Badge>;
      },
    },
    {
      key: 'amount',
      header: 'Amount',
      className: 'nowrap',
      render: (t) => <strong style={{ color: t.type === 'credit' ? 'var(--ok)' : 'var(--danger)' }}>{t.type === 'credit' ? '+' : '−'}{fmtNumber(t.amount)}</strong>,
    },
    { key: 'bal', header: 'Balance after', render: (t) => fmtNumber(t.balanceAfter) },
    {
      key: 'note',
      header: 'Details',
      render: (t) => (
        <div>
          <span className="small">{t.note || '—'}</span>
          {t.actorName ? <div className="muted small">by {t.actorName}</div> : null}
          {campaignLinks && t.campaignId ? (
            <div className="small">
              <Link to={`/app/campaigns/${t.campaignId}`}>Open campaign</Link>
            </div>
          ) : null}
        </div>
      ),
    },
  ];
  return (
    <>
      {error ? <Alert tone="danger">{error.message}</Alert> : null}
      <DataTable
        columns={columns}
        rows={data.data}
        loading={loading}
        rowKey={(t) => t._id}
        empty={<EmptyState title="No credit activity yet">Top-ups, transfers and message charges will be listed here.</EmptyState>}
      />
      <div style={{ padding: '0 18px 12px' }}>
        <Pagination page={data.page} pages={data.pages} total={data.total} limit={data.limit} onPage={setPage} noun="entries" />
      </div>
    </>
  );
}

/**
 * Add / remove credits for one account.
 * `base` is the API path of the target (e.g. /admin/customers/ID); `target` = { name, credits }.
 * Admin: add creates credits, remove deletes them. Reseller: add transfers from their wallet, remove reclaims into it.
 */
export default function CreditsModal({ open, onClose, base, target, onDone }) {
  const toast = useToast();
  const { user, refreshUser } = useAuth();
  const isReseller = user.role === 'reseller';
  const [tab, setTab] = useState('adjust');
  const [action, setAction] = useState('add');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [busy, setBusy] = useState(false);
  const [balance, setBalance] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [done, setDone] = useState('');
  const [lastOpen, setLastOpen] = useState(false);
  const [ledgerKey, setLedgerKey] = useState(0);

  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setTab('adjust');
      setAction('add');
      setAmount('');
      setNote('');
      setError('');
      setFieldError('');
      setBalance(null);
      setWallet(null);
      setDone('');
    }
  }

  const shownBalance = balance ?? (target ? target.credits || 0 : 0);
  const shownWallet = wallet ?? user.credits ?? 0;

  const submit = async (e) => {
    if (e) e.preventDefault();
    setError('');
    setDone('');
    if (!/^\d+$/.test(amount.trim()) || Number(amount) < 1) {
      setFieldError('Enter a whole number of at least 1');
      return;
    }
    setFieldError('');
    setBusy(true);
    try {
      const r = await api.post(`${base}/credits`, { action, amount: Number(amount), note: note.trim() });
      setBalance(r.balance);
      if (typeof r.yourBalance === 'number') setWallet(r.yourBalance);
      setDone(`${action === 'add' ? 'Added' : 'Removed'} ${fmtNumber(Number(amount))} credits. New balance: ${fmtNumber(r.balance)}.`);
      setAmount('');
      setNote('');
      setLedgerKey((k) => k + 1);
      toast.success(action === 'add' ? 'Credits added' : 'Credits removed');
      if (isReseller) refreshUser();
      if (onDone) onDone(r);
    } catch (err) {
      setError(err.message);
      if (err.fields && err.fields.amount) setFieldError(err.fields.amount);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      wide
      title={target ? `Credits — ${target.name}` : 'Credits'}
      footer={
        tab === 'adjust' ? (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Close
            </Button>
            <Button variant="primary" loading={busy} onClick={submit}>
              {action === 'add' ? (isReseller ? 'Transfer credits' : 'Add credits') : isReseller ? 'Reclaim credits' : 'Remove credits'}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      <div className="grid grid-2 mb">
        <div className="stat">
          <div className="stat-label">Current balance</div>
          <div className="stat-value">{fmtNumber(shownBalance)}</div>
          <div className="stat-sub">{target ? target.name : ''}</div>
        </div>
        {isReseller ? (
          <div className="stat">
            <div className="stat-label">Your wallet</div>
            <div className="stat-value">{fmtNumber(shownWallet)}</div>
            <div className="stat-sub">transfers come from here</div>
          </div>
        ) : null}
      </div>
      <Tabs
        tabs={[
          { value: 'adjust', label: 'Add / remove' },
          { value: 'history', label: 'History' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="mt" />
      {tab === 'adjust' ? (
        <form onSubmit={submit} noValidate>
          <div className="seg mb" role="radiogroup" aria-label="Action">
            <button type="button" role="radio" aria-checked={action === 'add'} className={`seg-btn ${action === 'add' ? 'active' : ''}`} onClick={() => setAction('add')}>
              {isReseller ? 'Transfer to customer' : 'Add credits'}
            </button>
            <button type="button" role="radio" aria-checked={action === 'deduct'} className={`seg-btn ${action === 'deduct' ? 'active' : ''}`} onClick={() => setAction('deduct')}>
              {isReseller ? 'Reclaim from customer' : 'Remove credits'}
            </button>
          </div>
          <p className="muted small">
            {isReseller
              ? action === 'add'
                ? 'The credits are taken from your own wallet and given to this customer.'
                : 'The credits are taken back from this customer and returned to your wallet.'
              : action === 'add'
                ? 'New credits are created and added to the balance.'
                : 'The credits are removed from the balance and cannot be recovered.'}
          </p>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {done ? <Alert tone="ok">{done}</Alert> : null}
          <Field label="Amount (credits)" error={fieldError} required>
            <input inputMode="numeric" value={amount} onChange={(e) => { setAmount(e.target.value); setFieldError(''); }} placeholder="e.g. 500" />
          </Field>
          <Field label="Note (optional)" hint="Shown in the ledger, e.g. an invoice number">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          </Field>
          <button type="submit" className="sr-only" tabIndex={-1}>
            Submit
          </button>
        </form>
      ) : (
        <CreditsHistory key={ledgerKey} endpoint={`${base}/credits`} />
      )}
    </Modal>
  );
}

function CreditsHistory({ endpoint }) {
  const ledger = useLedger(endpoint, 8);
  return (
    <div style={{ margin: '0 -4px' }}>
      <LedgerTable ledger={ledger} />
    </div>
  );
}

/** Ledger card body used on the detail pages. */
export function CreditsHistoryBlock({ endpoint, refreshKey = 0 }) {
  return <CreditsHistory key={refreshKey} endpoint={endpoint} />;
}
