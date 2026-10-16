import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useApi, useDebounced, useDocumentTitle } from '../../hooks.js';
import { fmtDate } from '../../format.js';
import { Alert, Button, Card, DataTable, EmptyState, ErrorState, Field, PageHeader, Pagination, SearchBox, Spinner, StatusBadge, useConfirm, useToast } from '../../components/ui.jsx';

function localDateTime(value) {
  const date = value ? new Date(value) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getMinutes())}`;
}

const blankForm = () => ({ percentage: '10', startsAt: localDateTime(), expiresAt: '', active: true, internalReason: '' });

export default function Cutting() {
  useDocumentTitle('Campaign delivery cutting');
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState(blankForm);
  const [busy, setBusy] = useState(false);
  const dq = useDebounced(search);
  const toast = useToast();
  const confirm = useConfirm();
  const users = useApi(() => api.get('/admin/cutting', { q: dq, role, page, limit: 20 }), [dq, role, page]);
  const selected = users.data?.data.find((user) => user._id === selectedId) || null;
  const history = useApi(() => (selectedId ? api.get(`/admin/cutting/${selectedId}/history`, { limit: 20 }) : Promise.resolve({ data: [], total: 0, page: 1, pages: 1, limit: 20 })), [selectedId]);

  useEffect(() => {
    const cutting = selected?.cutting;
    setForm(cutting ? {
      percentage: String(cutting.percentage),
      startsAt: localDateTime(cutting.startsAt),
      expiresAt: cutting.expiresAt ? localDateTime(cutting.expiresAt) : '',
      active: cutting.active,
      internalReason: cutting.internalReason || '',
    } : blankForm());
  }, [selectedId, selected]);

  const change = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const refresh = () => {
    users.reload({ silent: true });
    history.reload({ silent: true });
  };

  const save = async (event) => {
    event.preventDefault();
    if (!selected) return;
    const percentage = Number(form.percentage);
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100 || Math.abs(percentage * 100 - Math.round(percentage * 100)) > 1e-8) {
      toast.error('Cut percentage must be greater than 0 and at most 100, up to two decimal places.');
      return;
    }
    const startsAt = new Date(form.startsAt);
    const expiresAt = form.expiresAt ? new Date(form.expiresAt) : null;
    if (Number.isNaN(startsAt.getTime()) || (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt <= startsAt))) {
      toast.error('Expiry must be later than the start date.');
      return;
    }
    setBusy(true);
    try {
      await api.put(`/admin/cutting/${selected._id}`, {
        percentage,
        startsAt: startsAt.toISOString(),
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        active: form.active,
        internalReason: form.internalReason.trim(),
      });
      toast.success('Delivery cutting rule saved');
      refresh();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  const revoke = () => confirm({
    title: 'Revoke this cutting rule?',
    message: `${selected?.name} will no longer have recipients cut from new campaigns.`,
    confirmText: 'Revoke cutting',
    danger: true,
    onConfirm: async () => {
      try {
        await api.post(`/admin/cutting/${selected._id}/revoke`);
        toast.success('Cutting rule revoked');
        refresh();
      } catch (error) {
        toast.error(error);
        throw error;
      }
    },
  });

  const columns = [
    { key: 'user', header: 'User', render: (user) => <div><strong>{user.name}</strong><div className="muted small">{user.email}</div></div> },
    { key: 'role', header: 'Role', render: (user) => user.role },
    { key: 'cutting', header: 'Campaign cutting', render: (user) => user.cutting ? `${user.cutting.percentage}%` : <span className="muted">None</span> },
    { key: 'status', header: 'Status', render: (user) => user.cutting ? <StatusBadge status={user.cutting.active ? 'active' : 'inactive'} /> : '—' },
    { key: 'action', header: '', className: 'right', render: (user) => <Button size="sm" onClick={() => setSelectedId(user._id)}>{selectedId === user._id ? 'Selected' : 'Manage'}</Button> },
  ];

  return (
    <>
      <PageHeader title="Campaign delivery cutting" subtitle="Admin-only rule: randomly withhold the configured share of eligible campaign recipients. Reports label them “Cutting off”, separate from provider-confirmed delivery status." />
      <Alert tone="warn" title="Transparent reporting and full billing">
        Cutting reduces the number of real provider sends, not the campaign charge. The selected percentage is charged at the configured full per-message/call rate; reports show the cut group separately from actual sent and delivered statuses.
      </Alert>
      <Card title="Find a user" pad={false}>
        <div className="toolbar">
          <SearchBox value={search} onChange={(value) => { setSearch(value); setPage(1); }} placeholder="Search name, email or company…" />
          <select value={role} onChange={(event) => { setRole(event.target.value); setPage(1); }} aria-label="Filter by role">
            <option value="">All users</option>
            <option value="customer">Customers</option>
            <option value="reseller">Resellers</option>
          </select>
        </div>
        {users.loading && !users.data ? <Spinner /> : null}
        {users.error ? <ErrorState error={users.error} onRetry={users.reload} /> : null}
        {users.data ? (
          <>
            <DataTable columns={columns} rows={users.data.data} rowKey={(user) => user._id} empty={<EmptyState title="No users found" />} />
            <div style={{ padding: '0 18px 12px' }}>
              <Pagination page={users.data.page} pages={users.data.pages} total={users.data.total} limit={users.data.limit} onPage={setPage} noun="users" />
            </div>
          </>
        ) : null}
      </Card>

      {selected ? (
        <div className="grid grid-2 mt">
          <Card title={`Cutting rule for ${selected.name}`}>
            <p className="muted small">{selected.email} · {selected.role}. An active rule is snapshotted when a real campaign starts; the percentage of eligible recipients is selected randomly and consistently for that campaign.</p>
            <form onSubmit={save} noValidate>
              <Field label="Cut percentage" hint="0–100%, up to two decimal places; rounded to the nearest eligible recipient">
                <input type="number" min="0.01" max="100" step="0.01" value={form.percentage} onChange={(event) => change('percentage', event.target.value)} required />
              </Field>
              <div className="grid grid-2">
                <Field label="Starts at">
                  <input type="datetime-local" value={form.startsAt} onChange={(event) => change('startsAt', event.target.value)} required />
                </Field>
                <Field label="Expires at" hint="Leave blank for no expiry">
                  <input type="datetime-local" value={form.expiresAt} onChange={(event) => change('expiresAt', event.target.value)} />
                </Field>
              </div>
              <label className="check">
                <input type="checkbox" checked={form.active} onChange={(event) => change('active', event.target.checked)} />
                Active
              </label>
              <Field label="Internal reason" hint="Visible only to administrators">
                <textarea maxLength={500} value={form.internalReason} onChange={(event) => change('internalReason', event.target.value)} />
              </Field>
              <div className="row gap-s mt">
                <Button type="submit" variant="primary" loading={busy}>Save cutting rule</Button>
                {selected.cutting?.active ? <Button variant="outline-danger" onClick={revoke}>Revoke</Button> : null}
              </div>
            </form>
            {selected.cutting ? (
              <Alert tone={selected.cutting.active ? 'info' : 'warn'} title={selected.cutting.active ? 'Rule assignment' : 'Rule inactive'}>
                Last changed by {selected.cutting.changedByName || 'administrator'} on {fmtDate(selected.cutting.updatedAt)}.
              </Alert>
            ) : null}
          </Card>
          <Card title="Change history" pad={false}>
            {history.loading && !history.data ? <Spinner /> : null}
            {history.error ? <ErrorState error={history.error} onRetry={history.reload} /> : null}
            {history.data?.data.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>When</th><th>Action</th><th>Administrator</th><th>Change</th></tr></thead>
                  <tbody>{history.data.data.map((entry) => (
                    <tr key={entry._id}>
                      <td className="nowrap">{fmtDate(entry.createdAt)}</td>
                      <td>{entry.action.replace('cutting.', '')}</td>
                      <td>{entry.actorEmail}</td>
                      <td className="small">{entry.meta.after ? `${entry.meta.after.percentage}%` : entry.action === 'cutting.applied' ? `${entry.meta.percentage}% applied to recipient (not sent)` : '—'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : !history.loading ? <p className="muted" style={{ padding: 18 }}>No changes recorded yet.</p> : null}
          </Card>
        </div>
      ) : null}
    </>
  );
}
