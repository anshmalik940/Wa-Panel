import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi, useDebounced, useDocumentTitle, useForm } from '../../hooks.js';
import { fmtDate, fmtNumber } from '../../format.js';
import CreditsModal, { CreditsHistoryBlock } from '../../components/Credits.jsx';
import { Alert, Button, Card, DataTable, EmptyState, ErrorState, Field, Modal, PageHeader, Pagination, SearchBox, Spinner, StatusBadge, useConfirm, useToast } from '../../components/ui.jsx';

const emptyForm = { name: '', email: '', password: '', companyName: '', phone: '', monthlyMessageLimit: '', contactLimit: '', resellerId: '', allowQr: false };

export function CustomerFormModal({ open, onClose, onSaved, role, customer, resellers }) {
  const toast = useToast();
  const defaults = useApi(() => (role === 'admin' ? api.get('/admin/settings') : Promise.resolve({ settings: { allowQrForNewUsers: false } })), [role]);
  const defaultAllowQr = defaults.data ? defaults.data.settings.allowQrForNewUsers : false;
  const base = role === 'admin' ? '/admin/customers' : '/reseller/customers';
  const editing = Boolean(customer);
  const form = useForm(emptyForm);
  const setFormValue = form.set;
  const [busy, setBusy] = useState(false);
  const [lastOpen, setLastOpen] = useState(false);

  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      form.setValues(
        customer
          ? {
              ...emptyForm,
              name: customer.name,
              email: customer.email,
              companyName: customer.companyName || '',
              phone: customer.phone || '',
              monthlyMessageLimit: String(customer.monthlyMessageLimit),
              contactLimit: String(customer.contactLimit),
              resellerId: customer.resellerId || '',
              allowQr: Boolean(customer.allowQr),
            }
          : { ...emptyForm, allowQr: defaultAllowQr },
      );
      form.setErrors({});
    }
  }

  useEffect(() => {
    if (open && !customer && role === 'admin' && defaults.data) {
      setFormValue('allowQr', Boolean(defaults.data.settings.allowQrForNewUsers));
    }
  }, [open, customer, role, defaults.data, setFormValue]);

  const submit = async (e) => {
    e.preventDefault();
    const v = form.values;
    const errs = {};
    if (!v.name.trim()) errs.name = 'Name is required';
    if (!/^\S+@\S+\.\S+$/.test(v.email.trim())) errs.email = 'Enter a valid email address';
    if (!editing && v.password.length < 8) errs.password = 'Use at least 8 characters, with a letter and a number';
    for (const k of ['monthlyMessageLimit', 'contactLimit']) if (v[k] !== '' && !/^\d+$/.test(String(v[k]))) errs[k] = 'Enter a whole number (0 or more)';
    form.setErrors(errs);
    if (Object.keys(errs).length) return;
    const body = { name: v.name.trim(), email: v.email.trim(), companyName: v.companyName.trim(), phone: v.phone.trim() };
    if (v.monthlyMessageLimit !== '') body.monthlyMessageLimit = Number(v.monthlyMessageLimit);
    if (v.contactLimit !== '') body.contactLimit = Number(v.contactLimit);
    if (role === 'admin') body.resellerId = v.resellerId || null;
    if (role === 'admin') body.allowQr = Boolean(v.allowQr);
    if (!editing) body.password = v.password;
    setBusy(true);
    try {
      const r = editing ? await api.patch(`${base}/${customer._id}`, body) : await api.post(base, body);
      toast.success(editing ? 'Customer updated' : 'Customer created');
      onSaved(r.customer);
    } catch (err) {
      form.setErrors(err.fields || {});
      toast.error(err);
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
      title={editing ? `Edit ${customer.name}` : 'New customer'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            {editing ? 'Save changes' : 'Create customer'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="form-grid">
        <Field label="Name" error={form.errors.name} required>
          <input {...form.bind('name')} maxLength={120} />
        </Field>
        <Field label="Email (sign-in)" error={form.errors.email} required>
          <input type="email" {...form.bind('email')} autoComplete="off" />
        </Field>
        {!editing ? (
          <Field label="Initial password" error={form.errors.password} hint="At least 8 characters, with a letter and a number" required>
            <input type="password" {...form.bind('password')} autoComplete="new-password" />
          </Field>
        ) : null}
        <Field label="Company" error={form.errors.companyName}>
          <input {...form.bind('companyName')} maxLength={160} />
        </Field>
        <Field label="Phone" error={form.errors.phone}>
          <input {...form.bind('phone')} maxLength={40} />
        </Field>
        <Field label="Monthly message limit" error={form.errors.monthlyMessageLimit} hint="Blank = platform default">
          <input inputMode="numeric" {...form.bind('monthlyMessageLimit')} />
        </Field>
        <Field label="Contact limit" error={form.errors.contactLimit} hint="Blank = platform default">
          <input inputMode="numeric" {...form.bind('contactLimit')} />
        </Field>
        {role === 'admin' ? (
          <Field label="Reseller" error={form.errors.resellerId}>
            <select {...form.bind('resellerId')}>
              <option value="">None (managed by admin)</option>
              {(resellers || []).map((r) => (
                <option key={r._id} value={r._id} disabled={r.status !== 'active' && r._id !== (customer && customer.resellerId)}>
                  {r.name} {r.companyName ? `(${r.companyName})` : ''} {r.status !== 'active' ? '— suspended' : ''}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {role === 'admin' ? (
          <label className="check">
            <input type="checkbox" checked={Boolean(form.values.allowQr)} onChange={(e) => form.set('allowQr', e.target.checked)} />
            Allow own phone (QR)
          </label>
        ) : null}
        <button type="submit" className="sr-only" tabIndex={-1}>
          Submit
        </button>
      </form>
    </Modal>
  );
}

export function ResetPasswordModal({ open, onClose, url, name }) {
  const toast = useToast();
  const { values, bind, errors, setErrors, setValues } = useForm({ password: '' });
  const [busy, setBusy] = useState(false);
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setValues({ password: '' });
      setErrors({});
    }
  }
  const submit = async (e) => {
    e.preventDefault();
    if (values.password.length < 8) {
      setErrors({ password: 'Use at least 8 characters, with a letter and a number' });
      return;
    }
    setBusy(true);
    try {
      await api.post(url, { password: values.password });
      toast.success(`Password reset for ${name}. They were signed out everywhere.`);
      onClose();
    } catch (err) {
      setErrors(err.fields || {});
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={`Reset password — ${name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Set new password
          </Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate>
        <p className="muted">All of their active sessions will be signed out and any login lock is cleared.</p>
        <Field label="New password" error={errors.password} hint="At least 8 characters, with a letter and a number">
          <input type="password" autoComplete="new-password" {...bind('password')} />
        </Field>
      </form>
    </Modal>
  );
}

export default function Customers({ role }) {
  useDocumentTitle('Customers');
  const prefix = role === 'admin' ? '/admin' : '/reseller';
  const base = `${prefix}/customers`;
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();

  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [resellerId, setResellerId] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  const [formFor, setFormFor] = useState(undefined); // undefined=closed, null=new, object=edit
  const [resetFor, setResetFor] = useState(null);
  const [creditsFor, setCreditsFor] = useState(null);

  const list = useApi(() => api.get(base, { q: dq, status, resellerId, page, limit: 15 }), [base, dq, status, resellerId, page]);
  const resellers = useApi(() => (role === 'admin' ? api.get('/admin/resellers', { limit: 100 }) : Promise.resolve({ data: [] })), [role]);

  const toggle = (c) =>
    confirm({
      title: c.status === 'active' ? `Suspend ${c.name}?` : `Reactivate ${c.name}?`,
      message:
        c.status === 'active'
          ? 'They will be signed out immediately and cannot sign in. Their running campaigns are paused. Their data is kept.'
          : 'They will be able to sign in again. Paused campaigns stay paused until they resume them.',
      confirmText: c.status === 'active' ? 'Suspend' : 'Reactivate',
      danger: c.status === 'active',
      onConfirm: async () => {
        try {
          await api.post(`${base}/${c._id}/${c.status === 'active' ? 'suspend' : 'activate'}`);
          toast.success(c.status === 'active' ? 'Customer suspended' : 'Customer reactivated');
          list.reload({ silent: true });
        } catch (err) {
          toast.error(err);
          throw err;
        }
      },
    });

  const columns = [
    {
      key: 'name',
      header: 'Customer',
      render: (c) => (
        <div>
          <Link to={`${base}/${c._id}`} style={{ fontWeight: 600 }}>
            {c.name}
          </Link>
          <div className="muted small">{c.email}</div>
        </div>
      ),
    },
    { key: 'company', header: 'Company', render: (c) => c.companyName || '—' },
    ...(role === 'admin' ? [{ key: 'reseller', header: 'Reseller', render: (c) => c.resellerName || <span className="muted">Direct</span> }] : []),
    { key: 'usage', header: 'This month', render: (c) => `${fmtNumber(c.messagesThisMonth)} / ${fmtNumber(c.monthlyMessageLimit)}` },
    { key: 'credits', header: 'Credits', className: 'nowrap', render: (c) => <strong>{fmtNumber(c.credits || 0)}</strong> },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
    { key: 'created', header: 'Created', render: (c) => fmtDate(c.createdAt, { time: false }) },
    {
      key: 'actions',
      header: '',
      className: 'right nowrap',
      render: (c) => (
        <div className="row gap-s" style={{ justifyContent: 'flex-end' }}>
          <Button size="sm" variant="primary" onClick={() => setCreditsFor(c)}>
            Credits
          </Button>
          <Button size="sm" onClick={() => setFormFor(c)}>
            Edit
          </Button>
          <Button size="sm" onClick={() => setResetFor(c)}>
            Reset password
          </Button>
          <Button size="sm" variant={c.status === 'active' ? 'outline-danger' : 'default'} onClick={() => toggle(c)}>
            {c.status === 'active' ? 'Suspend' : 'Activate'}
          </Button>
        </div>
      ),
    },
  ];

  const filtered = Boolean(dq || status || resellerId);

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle={role === 'admin' ? 'Every customer account on the platform.' : 'The customers you manage.'}
        actions={
          <Button variant="primary" onClick={() => setFormFor(null)}>
            + New customer
          </Button>
        }
      />
      <Card pad={false}>
        <div className="toolbar">
          <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search name, email, company…" />
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status filter">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
          {role === 'admin' ? (
            <select value={resellerId} onChange={(e) => { setResellerId(e.target.value); setPage(1); }} aria-label="Reseller filter">
              <option value="">All resellers</option>
              <option value="none">Direct (no reseller)</option>
              {(resellers.data ? resellers.data.data : []).map((r) => (
                <option key={r._id} value={r._id}>
                  {r.name}
                </option>
              ))}
            </select>
          ) : null}
          {filtered ? (
            <Button size="sm" variant="ghost" onClick={() => { setQ(''); setStatus(''); setResellerId(''); setPage(1); }}>
              Clear filters
            </Button>
          ) : null}
        </div>
        {list.loading && !list.data ? <Spinner /> : null}
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
        {list.data ? (
          <>
            <DataTable
              columns={columns}
              rows={list.data.data}
              loading={list.loading}
              empty={
                <EmptyState title={filtered ? 'No customers match your filters' : 'No customers yet'} action={!filtered ? <Button variant="primary" onClick={() => setFormFor(null)}>Create the first customer</Button> : null}>
                  {filtered ? 'Try a different search or clear the filters.' : 'Customers get their own contacts, templates and campaigns.'}
                </EmptyState>
              }
            />
            <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} limit={list.data.limit} onPage={setPage} noun="customers" />
          </>
        ) : null}
      </Card>

      <CustomerFormModal
        open={formFor !== undefined}
        customer={formFor || null}
        role={role}
        resellers={resellers.data ? resellers.data.data : []}
        onClose={() => setFormFor(undefined)}
        onSaved={(c) => {
          setFormFor(undefined);
          list.reload({ silent: true });
          if (!formFor && c) navigate(`${base}/${c._id}`);
        }}
      />
      <CreditsModal
        open={Boolean(creditsFor)}
        base={creditsFor ? `${base}/${creditsFor._id}` : ''}
        target={creditsFor}
        onClose={() => setCreditsFor(null)}
        onDone={() => list.reload({ silent: true })}
      />
      <ResetPasswordModal open={Boolean(resetFor)} name={resetFor ? resetFor.name : ''} url={resetFor ? `${base}/${resetFor._id}/reset-password` : ''} onClose={() => setResetFor(null)} />
    </>
  );
}

export function CustomerDetail({ role }) {
  const prefix = role === 'admin' ? '/admin' : '/reseller';
  const base = `${prefix}/customers`;
  const { id: idFromPath } = useParams();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [ledgerKey, setLedgerKey] = useState(0);
  const detail = useApi(() => api.get(`${base}/${idFromPath}`), [base, idFromPath]);
  const resellers = useApi(() => (role === 'admin' ? api.get('/admin/resellers', { limit: 100 }) : Promise.resolve({ data: [] })), [role]);
  useDocumentTitle(detail.data ? detail.data.customer.name : 'Customer');

  if (detail.loading && !detail.data) return <Spinner />;
  if (detail.error) {
    return (
      <>
        <PageHeader title="Customer" actions={<Link className="btn" to={base}>← All customers</Link>} />
        <ErrorState error={detail.error} onRetry={detail.reload} />
      </>
    );
  }
  const { customer: c, usage, counts, reseller } = detail.data;
  const limitPct = c.monthlyMessageLimit ? Math.round((usage.messages / c.monthlyMessageLimit) * 100) : 0;

  const toggle = () =>
    confirm({
      title: c.status === 'active' ? `Suspend ${c.name}?` : `Reactivate ${c.name}?`,
      message: c.status === 'active' ? 'They will be signed out immediately and their running campaigns are paused.' : 'They will be able to sign in again.',
      confirmText: c.status === 'active' ? 'Suspend' : 'Reactivate',
      danger: c.status === 'active',
      onConfirm: async () => {
        try {
          await api.post(`${base}/${c._id}/${c.status === 'active' ? 'suspend' : 'activate'}`);
          toast.success(c.status === 'active' ? 'Customer suspended' : 'Customer reactivated');
          detail.reload({ silent: true });
        } catch (err) {
          toast.error(err);
          throw err;
        }
      },
    });

  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={`${c.email}${c.companyName ? ` · ${c.companyName}` : ''}`}
        actions={
          <>
            <Link className="btn" to={base}>
              ← All customers
            </Link>
            <Button variant="primary" onClick={() => setCreditsOpen(true)}>Credits</Button>
            <Button onClick={() => setEditing(true)}>Edit</Button>
            <Button onClick={() => setResetOpen(true)}>Reset password</Button>
            <Button variant={c.status === 'active' ? 'outline-danger' : 'primary'} onClick={toggle}>
              {c.status === 'active' ? 'Suspend' : 'Reactivate'}
            </Button>
          </>
        }
      />
      {c.status === 'suspended' ? <Alert tone="danger">This account is suspended. The customer cannot sign in.</Alert> : null}
      <div className="grid grid-4 mb">
        <div className="stat"><div className="stat-label">Credits</div><div className="stat-value">{fmtNumber(c.credits || 0)}</div><div className="stat-sub">wallet balance</div></div>
        <div className="stat"><div className="stat-label">Messages this month</div><div className="stat-value">{fmtNumber(usage.messages)}</div><div className="stat-sub">of {fmtNumber(c.monthlyMessageLimit)} ({limitPct}%)</div></div>
        <div className="stat"><div className="stat-label">Simulated (mock)</div><div className="stat-value">{fmtNumber(usage.simulatedMessages)}</div><div className="stat-sub">included in the total</div></div>
        <div className="stat"><div className="stat-label">Contacts</div><div className="stat-value">{fmtNumber(counts.contacts)}</div><div className="stat-sub">limit {fmtNumber(c.contactLimit)}</div></div>
        <div className="stat"><div className="stat-label">Campaigns</div><div className="stat-value">{fmtNumber(counts.campaigns)}</div><div className="stat-sub">{usage.campaignsStarted} started this month</div></div>
      </div>
      <Card title="Account">
        <dl className="kv">
          <dt>Status</dt>
          <dd><StatusBadge status={c.status} /></dd>
          <dt>Reseller</dt>
          <dd>{reseller ? reseller.name : 'None (managed directly by an administrator)'}</dd>
          <dt>Phone</dt>
          <dd>{c.phone || '—'}</dd>
          <dt>Created</dt>
          <dd>{fmtDate(c.createdAt)}</dd>
          <dt>Last sign-in</dt>
          <dd>{fmtDate(c.lastLoginAt)}</dd>
        </dl>
      </Card>
      <Card title="Credit history" pad={false}>
        <CreditsHistoryBlock endpoint={`${base}/${c._id}/credits`} refreshKey={ledgerKey} />
      </Card>
      <CreditsModal
        open={creditsOpen}
        base={`${base}/${c._id}`}
        target={c}
        onClose={() => setCreditsOpen(false)}
        onDone={() => {
          setLedgerKey((k) => k + 1);
          detail.reload({ silent: true });
        }}
      />
      <CustomerFormModal
        open={editing}
        customer={c}
        role={role}
        resellers={resellers.data ? resellers.data.data : []}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          detail.reload({ silent: true });
        }}
      />
      <ResetPasswordModal open={resetOpen} name={c.name} url={`${base}/${c._id}/reset-password`} onClose={() => setResetOpen(false)} />
    </>
  );
}
