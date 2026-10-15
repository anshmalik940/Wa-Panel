import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi, useDebounced, useDocumentTitle, useForm } from '../../hooks.js';
import { fmtDate, fmtNumber } from '../../format.js';
import CreditsModal, { CreditsHistoryBlock } from '../../components/Credits.jsx';
import { Alert, Button, Card, DataTable, EmptyState, ErrorState, Field, Modal, PageHeader, Pagination, SearchBox, Spinner, Stat, StatusBadge, useConfirm, useToast } from '../../components/ui.jsx';
import { ResetPasswordModal } from '../shared/Customers.jsx';

const emptyForm = { name: '', email: '', password: '', companyName: '', phone: '', maxCustomers: '50', allowQr: false };

function ResellerFormModal({ open, onClose, onSaved, reseller }) {
  const toast = useToast();
  const defaults = useApi(() => api.get('/admin/settings'), []);
  const editing = Boolean(reseller);
  const form = useForm(emptyForm);
  const setFormValue = form.set;
  const [busy, setBusy] = useState(false);
  const [lastOpen, setLastOpen] = useState(false);
  useEffect(() => {
    if (open && !reseller && defaults.data) setFormValue('allowQr', Boolean(defaults.data.settings.allowQrForNewUsers));
  }, [open, reseller, defaults.data, setFormValue]);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      form.setValues(reseller ? { ...emptyForm, name: reseller.name, email: reseller.email, companyName: reseller.companyName || '', phone: reseller.phone || '', maxCustomers: String(reseller.maxCustomers), allowQr: Boolean(reseller.allowQr) } : { ...emptyForm, allowQr: Boolean(defaults.data?.settings.allowQrForNewUsers) });
      form.setErrors({});
    }
  }
  const submit = async (e) => {
    e.preventDefault();
    const v = form.values;
    const errs = {};
    if (!v.name.trim()) errs.name = 'Name is required';
    if (!/^\S+@\S+\.\S+$/.test(v.email.trim())) errs.email = 'Enter a valid email address';
    if (!editing && v.password.length < 8) errs.password = 'Use at least 8 characters, with a letter and a number';
    if (!/^\d+$/.test(String(v.maxCustomers))) errs.maxCustomers = 'Enter a whole number (0 or more)';
    form.setErrors(errs);
    if (Object.keys(errs).length) return;
    const body = { name: v.name.trim(), email: v.email.trim(), companyName: v.companyName.trim(), phone: v.phone.trim(), maxCustomers: Number(v.maxCustomers), allowQr: Boolean(v.allowQr) };
    if (!editing) body.password = v.password;
    setBusy(true);
    try {
      const r = editing ? await api.patch(`/admin/resellers/${reseller._id}`, body) : await api.post('/admin/resellers', body);
      toast.success(editing ? 'Reseller updated' : 'Reseller created');
      onSaved(r.reseller);
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
      title={editing ? `Edit ${reseller.name}` : 'New reseller'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            {editing ? 'Save changes' : 'Create reseller'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="form-grid">
        <Field label="Name" error={form.errors.name} required>
          <input {...form.bind('name')} maxLength={120} />
        </Field>
        <Field label="Email (sign-in)" error={form.errors.email} required>
          <input type="email" autoComplete="off" {...form.bind('email')} />
        </Field>
        {!editing ? (
          <Field label="Initial password" error={form.errors.password} hint="At least 8 characters, with a letter and a number" required>
            <input type="password" autoComplete="new-password" {...form.bind('password')} />
          </Field>
        ) : null}
        <Field label="Company" error={form.errors.companyName}>
          <input {...form.bind('companyName')} maxLength={160} />
        </Field>
        <Field label="Phone" error={form.errors.phone}>
          <input {...form.bind('phone')} maxLength={40} />
        </Field>
        <Field label="Maximum customers" error={form.errors.maxCustomers} hint="The reseller cannot create more customers than this">
          <input inputMode="numeric" {...form.bind('maxCustomers')} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={Boolean(form.values.allowQr)} onChange={(e) => form.set('allowQr', e.target.checked)} />
          Allow own phone (QR)
        </label>
        <button type="submit" className="sr-only" tabIndex={-1}>
          Submit
        </button>
      </form>
    </Modal>
  );
}

export default function Resellers() {
  useDocumentTitle('Resellers');
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  const [formFor, setFormFor] = useState(undefined); // undefined = closed, null = new, object = edit
  const [resetFor, setResetFor] = useState(null);
  const [creditsFor, setCreditsFor] = useState(null);
  const list = useApi(() => api.get('/admin/resellers', { q: dq, status, page, limit: 15 }), [dq, status, page]);

  const toggle = (r) =>
    confirm({
      title: r.status === 'active' ? `Suspend ${r.name}?` : `Reactivate ${r.name}?`,
      message:
        r.status === 'active'
          ? 'They will be signed out immediately and cannot sign in. Their customers are not affected.'
          : 'They will be able to sign in and manage their customers again.',
      confirmText: r.status === 'active' ? 'Suspend' : 'Reactivate',
      danger: r.status === 'active',
      onConfirm: async () => {
        try {
          await api.post(`/admin/resellers/${r._id}/${r.status === 'active' ? 'suspend' : 'activate'}`);
          toast.success(r.status === 'active' ? 'Reseller suspended' : 'Reseller reactivated');
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
      header: 'Reseller',
      render: (r) => (
        <div>
          <Link to={`/admin/resellers/${r._id}`} style={{ fontWeight: 600 }}>
            {r.name}
          </Link>
          <div className="muted small">{r.email}</div>
        </div>
      ),
    },
    { key: 'company', header: 'Company', render: (r) => r.companyName || '—' },
    { key: 'customers', header: 'Customers', render: (r) => `${fmtNumber(r.customerCount)} / ${fmtNumber(r.maxCustomers)}` },
    { key: 'credits', header: 'Credits', className: 'nowrap', render: (r) => <strong>{fmtNumber(r.credits || 0)}</strong> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'created', header: 'Created', render: (r) => fmtDate(r.createdAt, { time: false }) },
    {
      key: 'actions',
      header: '',
      className: 'right nowrap',
      render: (r) => (
        <div className="row gap-s" style={{ justifyContent: 'flex-end' }}>
          <Button size="sm" variant="primary" onClick={() => setCreditsFor(r)}>
            Credits
          </Button>
          <Button size="sm" onClick={() => setFormFor(r)}>
            Edit
          </Button>
          <Button size="sm" onClick={() => setResetFor(r)}>
            Reset password
          </Button>
          <Button size="sm" variant={r.status === 'active' ? 'outline-danger' : 'default'} onClick={() => toggle(r)}>
            {r.status === 'active' ? 'Suspend' : 'Activate'}
          </Button>
        </div>
      ),
    },
  ];
  const filtered = Boolean(dq || status);

  return (
    <>
      <PageHeader
        title="Resellers"
        subtitle="Resellers create and manage their own customers."
        actions={
          <Button variant="primary" onClick={() => setFormFor(null)}>
            + New reseller
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
          {filtered ? (
            <Button size="sm" variant="ghost" onClick={() => { setQ(''); setStatus(''); setPage(1); }}>
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
                <EmptyState title={filtered ? 'No resellers match your filters' : 'No resellers yet'} action={!filtered ? <Button variant="primary" onClick={() => setFormFor(null)}>Create the first reseller</Button> : null}>
                  {filtered ? 'Try a different search or clear the filters.' : 'Resellers can sign in and create customers.'}
                </EmptyState>
              }
            />
            <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} limit={list.data.limit} onPage={setPage} noun="resellers" />
          </>
        ) : null}
      </Card>
      <ResellerFormModal
        open={formFor !== undefined}
        reseller={formFor || null}
        onClose={() => setFormFor(undefined)}
        onSaved={() => {
          setFormFor(undefined);
          list.reload({ silent: true });
        }}
      />
      <CreditsModal
        open={Boolean(creditsFor)}
        base={creditsFor ? `/admin/resellers/${creditsFor._id}` : ''}
        target={creditsFor}
        onClose={() => setCreditsFor(null)}
        onDone={() => list.reload({ silent: true })}
      />
      <ResetPasswordModal open={Boolean(resetFor)} name={resetFor ? resetFor.name : ''} url={resetFor ? `/admin/resellers/${resetFor._id}/reset-password` : ''} onClose={() => setResetFor(null)} />
    </>
  );
}

export function ResellerDetail() {
  const { id } = useParams();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [ledgerKey, setLedgerKey] = useState(0);
  const detail = useApi(() => api.get(`/admin/resellers/${id}`), [id]);
  const customers = useApi(() => api.get('/admin/customers', { resellerId: id, limit: 50 }), [id]);
  useDocumentTitle(detail.data ? detail.data.reseller.name : 'Reseller');

  if (detail.loading && !detail.data) return <Spinner />;
  if (detail.error) {
    return (
      <>
        <PageHeader title="Reseller" actions={<Link className="btn" to="/admin/resellers">← All resellers</Link>} />
        <ErrorState error={detail.error} onRetry={detail.reload} />
      </>
    );
  }
  const { reseller: r, customerCount, activeCustomers, messagesThisMonth } = detail.data;
  const toggle = () =>
    confirm({
      title: r.status === 'active' ? `Suspend ${r.name}?` : `Reactivate ${r.name}?`,
      message: r.status === 'active' ? 'They will be signed out immediately.' : 'They will be able to sign in again.',
      confirmText: r.status === 'active' ? 'Suspend' : 'Reactivate',
      danger: r.status === 'active',
      onConfirm: async () => {
        try {
          await api.post(`/admin/resellers/${r._id}/${r.status === 'active' ? 'suspend' : 'activate'}`);
          toast.success(r.status === 'active' ? 'Reseller suspended' : 'Reseller reactivated');
          detail.reload({ silent: true });
        } catch (err) {
          toast.error(err);
          throw err;
        }
      },
    });

  const columns = [
    { key: 'name', header: 'Customer', render: (c) => <div><Link to={`/admin/customers/${c._id}`} style={{ fontWeight: 600 }}>{c.name}</Link><div className="muted small">{c.email}</div></div> },
    { key: 'usage', header: 'This month', render: (c) => `${fmtNumber(c.messagesThisMonth)} / ${fmtNumber(c.monthlyMessageLimit)}` },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
  ];

  return (
    <>
      <PageHeader
        title={r.name}
        subtitle={`${r.email}${r.companyName ? ` · ${r.companyName}` : ''}`}
        actions={
          <>
            <Link className="btn" to="/admin/resellers">← All resellers</Link>
            <Button variant="primary" onClick={() => setCreditsOpen(true)}>Credits</Button>
            <Button onClick={() => setEditing(true)}>Edit</Button>
            <Button onClick={() => setResetOpen(true)}>Reset password</Button>
            <Button variant={r.status === 'active' ? 'outline-danger' : 'primary'} onClick={toggle}>
              {r.status === 'active' ? 'Suspend' : 'Reactivate'}
            </Button>
          </>
        }
      />
      {r.status === 'suspended' ? <Alert tone="danger">This reseller is suspended and cannot sign in.</Alert> : null}
      <div className="grid grid-4 mb">
        <Stat label="Credits" value={fmtNumber(r.credits || 0)} sub="wallet balance (they give these to customers)" />
        <Stat label="Customers" value={fmtNumber(customerCount)} sub={`limit ${fmtNumber(r.maxCustomers)} · ${activeCustomers} active`} />
        <Stat label="Messages this month" value={fmtNumber(messagesThisMonth)} sub="across all their customers" />
        <Stat label="Last sign-in" value={r.lastLoginAt ? fmtDate(r.lastLoginAt, { time: false }) : '—'} sub={r.lastLoginAt ? fmtDate(r.lastLoginAt) : 'never signed in'} />
      </div>
      <Card title="Customers of this reseller" pad={false}>
        {customers.loading && !customers.data ? <Spinner /> : null}
        {customers.error ? <ErrorState error={customers.error} onRetry={customers.reload} /> : null}
        {customers.data ? <DataTable columns={columns} rows={customers.data.data} empty={<EmptyState title="No customers yet" />} /> : null}
      </Card>
      <Card title="Credit history" pad={false}>
        <CreditsHistoryBlock endpoint={`/admin/resellers/${r._id}/credits`} refreshKey={ledgerKey} />
      </Card>
      <CreditsModal
        open={creditsOpen}
        base={`/admin/resellers/${r._id}`}
        target={r}
        onClose={() => setCreditsOpen(false)}
        onDone={() => {
          setLedgerKey((k) => k + 1);
          detail.reload({ silent: true });
        }}
      />
      <ResellerFormModal
        open={editing}
        reseller={r}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          detail.reload({ silent: true });
        }}
      />
      <ResetPasswordModal open={resetOpen} name={r.name} url={`/admin/resellers/${r._id}/reset-password`} onClose={() => setResetOpen(false)} />
    </>
  );
}
