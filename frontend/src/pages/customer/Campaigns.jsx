import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi, useDebounced, useDocumentTitle, usePolling } from '../../hooks.js';
import { fmtDate, fmtNumber } from '../../format.js';
import { Button, Card, DataTable, EmptyState, ErrorState, PageHeader, Pagination, SearchBox, Spinner, StatusBadge, useConfirm, useToast } from '../../components/ui.jsx';

export const IN_FLIGHT = ['queued', 'running', 'paused'];

/** channel: undefined = every campaign, 'voice' = only call campaigns (the "Voice calls" page). */
export default function Campaigns({ channel }) {
  const voiceOnly = channel === 'voice';
  const newPath = voiceOnly ? '/app/voice/new' : '/app/campaigns/new';
  const editPath = (c) => (c.channel === 'voice' ? `/app/voice/${c._id}/edit` : `/app/campaigns/${c._id}/edit`);
  useDocumentTitle(voiceOnly ? 'Voice calls' : 'Campaigns');
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  const list = useApi(() => api.get('/c/campaigns', { q: dq, status, page, limit: 12, channel: voiceOnly ? 'voice' : undefined }), [dq, status, page, voiceOnly]);
  const live = list.data ? list.data.data.some((c) => ['queued', 'running'].includes(c.status)) : false;
  usePolling(() => list.reload({ silent: true }), 2500, live);

  const act = (c, kind) => {
    const text = {
      cancel: { title: `Cancel “${c.name}”?`, message: 'All messages that are still waiting are cancelled. Messages already handed to the provider cannot be recalled. This cannot be undone.', confirmText: 'Cancel campaign', danger: true, ok: 'Campaign cancelled' },
      delete: { title: `Delete “${c.name}”?`, message: 'The campaign and its report are permanently deleted.', confirmText: 'Delete', danger: true, ok: 'Campaign deleted' },
    }[kind];
    return confirm({
      ...text,
      onConfirm: async () => {
        try {
          if (kind === 'delete') await api.del(`/c/campaigns/${c._id}`);
          else await api.post(`/c/campaigns/${c._id}/cancel`);
          toast.success(text.ok);
          list.reload({ silent: true });
        } catch (err) {
          toast.error(err);
          throw err;
        }
      },
    });
  };

  const simple = async (c, path, ok) => {
    try {
      await api.post(`/c/campaigns/${c._id}/${path}`);
      toast.success(ok);
      list.reload({ silent: true });
    } catch (err) {
      toast.error(err);
    }
  };

  const clone = async (c) => {
    try {
      const r = await api.post(`/c/campaigns/${c._id}/clone`);
      toast.success('Campaign duplicated as a draft');
      navigate(editPath(r.campaign));
    } catch (err) {
      toast.error(err);
    }
  };

  const columns = [
    {
      key: 'name',
      header: 'Campaign',
      render: (c) => (
        <div>
          <Link to={`/app/campaigns/${c._id}`} style={{ fontWeight: 600 }}>{c.name}</Link>
          <div className="muted small">{c.channel === 'voice' ? 'Voice call' : c.templateName || 'Template chosen at start'}{['mock', 'voice_mock'].includes(c.provider) ? ' · simulated' : ''}</div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (c) => <div><StatusBadge status={c.status} />{c.status === 'scheduled' && c.scheduledAt ? <div className="muted small">{fmtDate(c.scheduledAt)}</div> : null}</div> },
    { key: 'progress', header: voiceOnly ? 'Dialled / recipients' : 'Sent / recipients', render: (c) => (c.stats.recipients ? `${fmtNumber(c.stats.sent)} / ${fmtNumber(c.stats.recipients)}` : <span className="muted">—</span>) },
    { key: 'failed', header: 'Failed', render: (c) => (c.stats.recipients ? fmtNumber(c.stats.failed) : '—') },
    { key: 'excluded', header: 'Excluded', render: (c) => (c.stats.recipients || c.stats.excluded ? fmtNumber(c.stats.excluded) : '—') },
    { key: 'created', header: 'Created', render: (c) => fmtDate(c.createdAt, { time: false }) },
    {
      key: 'actions',
      header: '',
      className: 'right nowrap',
      render: (c) => (
        <div className="row gap-s" style={{ justifyContent: 'flex-end' }}>
          <Link className="btn btn-sm" to={`/app/campaigns/${c._id}`}>Report</Link>
          {['draft', 'scheduled'].includes(c.status) ? <Link className="btn btn-sm" to={editPath(c)}>Edit</Link> : null}
          {c.status === 'running' ? <Button size="sm" onClick={() => simple(c, 'pause', 'Campaign paused')}>Pause</Button> : null}
          {c.status === 'paused' ? <Button size="sm" onClick={() => simple(c, 'resume', 'Campaign resumed')}>Resume</Button> : null}
          {['scheduled', 'queued', 'running', 'paused'].includes(c.status) ? <Button size="sm" variant="outline-danger" onClick={() => act(c, 'cancel')}>Cancel</Button> : null}
          <Button size="sm" onClick={() => clone(c)}>Duplicate</Button>
          {!IN_FLIGHT.includes(c.status) ? <Button size="sm" variant="outline-danger" onClick={() => act(c, 'delete')}>Delete</Button> : null}
        </div>
      ),
    },
  ];
  const filtered = Boolean(dq || status);

  return (
    <>
      <PageHeader
        title={voiceOnly ? 'Voice calls' : 'Campaigns'}
        subtitle={voiceOnly ? 'Call a group of contacts with a recorded or spoken message, showing your caller ID (CLI).' : 'Send an approved template to a group of contacts, now or later.'}
        actions={
          voiceOnly ? (
            <Link className="btn btn-primary" to={newPath}>+ New call campaign</Link>
          ) : (
            <>
              <Link className="btn" to="/app/voice/new">+ New call campaign</Link>
              <Link className="btn btn-primary" to={newPath}>+ New campaign</Link>
            </>
          )
        }
      />
      {!voiceOnly ? <div className="notice muted small mb">Only your latest 10 finished campaigns are kept. Download the report (CSV) before it is removed.</div> : null}
      <Card pad={false}>
        <div className="toolbar">
          <SearchBox value={q} onChange={(x) => { setQ(x); setPage(1); }} placeholder="Search by campaign name…" />
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status filter">
            <option value="">All statuses</option>
            {['draft', 'scheduled', 'queued', 'running', 'paused', 'completed', 'cancelled', 'failed'].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
          </select>
          {filtered ? <Button size="sm" variant="ghost" onClick={() => { setQ(''); setStatus(''); setPage(1); }}>Clear filters</Button> : null}
          {live ? <span className="muted small">Live: updating every few seconds…</span> : null}
        </div>
        {list.loading && !list.data ? <Spinner /> : null}
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
        {list.data ? (
          <>
            <DataTable
              columns={columns}
              rows={list.data.data}
              loading={list.loading && !live}
              empty={
                <EmptyState title={filtered ? 'No campaigns match your filters' : voiceOnly ? 'No call campaigns yet' : 'No campaigns yet'} action={!filtered ? <Link className="btn btn-primary" to={newPath}>{voiceOnly ? 'Create your first call campaign' : 'Create your first campaign'}</Link> : null}>
                  {filtered ? 'Try a different search or clear the filters.' : voiceOnly ? 'You need contacts and a caller ID (CLI) assigned to you.' : 'You need contacts, an approved template and a connected WhatsApp provider.'}
                </EmptyState>
              }
            />
            <div style={{ padding: '0 18px 12px' }}>
              <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} limit={list.data.limit} onPage={setPage} noun={voiceOnly ? 'call campaigns' : 'campaigns'} />
            </div>
          </>
        ) : null}
      </Card>
    </>
  );
}
