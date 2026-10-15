import { useState } from 'react';
import { api } from '../../api.js';
import { useApi, useDebounced, useDocumentTitle } from '../../hooks.js';
import { fmtDate, humanize } from '../../format.js';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, PageHeader, Pagination, SearchBox, Spinner } from '../../components/ui.jsx';

const GROUPS = [
  ['', 'All actions'],
  ['auth.', 'Sign-ins & security'],
  ['customer.', 'Customers'],
  ['reseller.', 'Resellers'],
  ['contact.', 'Contacts'],
  ['template.', 'Templates'],
  ['campaign.', 'Campaigns'],
  ['whatsapp.', 'WhatsApp settings'],
  ['settings.', 'Platform settings'],
];

const toneFor = (a) => (/delete|suspend|cancel|locked|disconnect/.test(a) ? 'danger' : /create|activate|start|import/.test(a) ? 'ok' : 'neutral');

function metaText(meta) {
  if (!meta || !Object.keys(meta).length) return '';
  return Object.entries(meta)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`)
    .join(' · ');
}

/** `endpoint` is the role specific audit URL: /admin/audit, /reseller/audit or /c/audit. */
export default function AuditLog({ endpoint, title = 'Audit log', subtitle, showActor = true }) {
  useDocumentTitle(title);
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const dActor = useDebounced(actor);
  const query = { action, actor: dActor, page, limit: 25, from: from ? new Date(`${from}T00:00:00`).toISOString() : '', to: to ? new Date(`${to}T23:59:59`).toISOString() : '' };
  const list = useApi(() => api.get(endpoint, query), [endpoint, action, dActor, from, to, page]);
  const filtered = Boolean(action || actor || from || to);

  const columns = [
    { key: 'when', header: 'When', className: 'nowrap', render: (e) => fmtDate(e.createdAt) },
    ...(showActor ? [{ key: 'who', header: 'Who', render: (e) => <div>{e.actorEmail}<div className="muted small">{e.actorRole}</div></div> }] : []),
    { key: 'action', header: 'Action', render: (e) => <Badge tone={toneFor(e.action)}>{humanize(e.action)}</Badge> },
    { key: 'meta', header: 'Details', render: (e) => <span className="small muted">{metaText(e.meta)}</span> },
    { key: 'ip', header: 'IP', className: 'nowrap', render: (e) => <span className="mono muted">{e.ip || '—'}</span> },
  ];

  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      <Card pad={false}>
        <div className="toolbar">
          <select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} aria-label="Action filter">
            {GROUPS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          {showActor ? <SearchBox value={actor} onChange={(v) => { setActor(v); setPage(1); }} placeholder="Filter by user email…" /> : null}
          <label className="row gap-s small muted">
            From
            <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} style={{ width: 150 }} />
          </label>
          <label className="row gap-s small muted">
            To
            <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} style={{ width: 150 }} />
          </label>
          {filtered ? (
            <Button size="sm" variant="ghost" onClick={() => { setAction(''); setActor(''); setFrom(''); setTo(''); setPage(1); }}>
              Clear filters
            </Button>
          ) : null}
        </div>
        {list.loading && !list.data ? <Spinner /> : null}
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
        {list.data ? (
          <>
            <DataTable columns={columns} rows={list.data.data} loading={list.loading} empty={<EmptyState title={filtered ? 'No entries match your filters' : 'Nothing recorded yet'} />} />
            <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} limit={list.data.limit} onPage={setPage} noun="entries" />
          </>
        ) : null}
      </Card>
    </>
  );
}
