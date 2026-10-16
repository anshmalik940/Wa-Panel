import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi, useDebounced, useDocumentTitle, usePolling } from '../../hooks.js';
import { excludedReasonText, fmtDate, fmtNumber } from '../../format.js';
import { Alert, Button, Card, DataTable, EmptyState, ErrorState, Funnel, IssueList, PageHeader, Pagination, SearchBox, Spinner, Stat, StatusBadge, Tabs, useConfirm, useToast } from '../../components/ui.jsx';
import { TemplatePreview } from './Templates.jsx';
import { MediaPreview } from '../../components/Media.jsx';

const TABS = [
  ['', 'All'], ['queued', 'Queued'], ['sending', 'Processing'], ['sent', 'Sent'], ['delivered', 'Delivered'], ['read', 'Read'], ['failed', 'Failed'], ['unknown', 'Outcome unknown'], ['cut', 'Cutting off'], ['excluded', 'Excluded'], ['cancelled', 'Cancelled'],
];

function Recipients({ id, live, refreshKey }) {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  const list = useApi(() => api.get(`/c/campaigns/${id}/messages`, { status, q: dq, page, limit: 20 }), [id, status, dq, page, refreshKey]);
  usePolling(() => list.reload({ silent: true }), 3000, live);

  const columns = [
    { key: 'to', header: 'Recipient', render: (m) => <div><strong>{m.contactName || '(no name)'}</strong><div className="mono muted">{m.phone}</div></div> },
    { key: 'status', header: 'Status', render: (m) => <StatusBadge status={m.status} /> },
    { key: 'original', header: 'Original charge', className: 'nowrap', render: (m) => (m.simulated || !m.billing ? '—' : fmtNumber(m.billing.originalCharge)) },
    { key: 'cut', header: 'Cutting', className: 'nowrap', render: (m) => (m.simulated ? '—' : m.isCut ? `Cutting off · ${m.cuttingPercentage || 0}%` : 'No') },
    { key: 'final', header: 'Final charge', className: 'nowrap', render: (m) => (m.simulated || !m.billing ? '—' : fmtNumber(m.billing.refunded ? 0 : m.billing.finalCharge)) },
    { key: 'billingTime', header: 'Cut at', className: 'nowrap', render: (m) => (m.isCut ? fmtDate(m.cutAt || m.updatedAt) : '—') },
    { key: 'detail', header: 'Detail', render: (m) => (m.status === 'excluded' ? excludedReasonText(m.excludedReason) : m.error ? <span style={{ color: 'var(--danger)' }}>{m.error}</span> : <span className="muted small pre">{m.text}</span>) },
    { key: 'time', header: 'Last update', className: 'nowrap', render: (m) => fmtDate(m.readAt || m.deliveredAt || m.unknownAt || m.failedAt || m.sentAt || m.updatedAt) },
  ];
  return (
    <Card title="Recipients" pad={false}>
      <div style={{ padding: '0 18px' }}>
        <Tabs tabs={TABS.map(([value, label]) => ({ value, label }))} value={status} onChange={(v) => { setStatus(v); setPage(1); }} />
      </div>
      <div className="toolbar">
        <SearchBox value={q} onChange={(x) => { setQ(x); setPage(1); }} placeholder="Search name or phone…" />
      </div>
      {list.loading && !list.data ? <Spinner /> : null}
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
      {list.data ? (
        <>
          <DataTable columns={columns} rows={list.data.data} loading={list.loading && !live} empty={<EmptyState title="No recipients in this view" />} />
          <div style={{ padding: '0 18px 12px' }}>
            <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} limit={list.data.limit} onPage={setPage} noun="recipients" />
          </div>
        </>
      ) : null}
    </Card>
  );
}

export default function CampaignDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState('');
  const [issues, setIssues] = useState([]);
  const [tick, setTick] = useState(0);
  const res = useApi(() => api.get(`/c/campaigns/${id}`), [id]);
  const c = res.data ? res.data.campaign : null;
  const live = c ? ['queued', 'running'].includes(c.status) : false;
  usePolling(
    () => {
      res.reload({ silent: true });
      setTick((t) => t + 1);
    },
    2000,
    live,
  );
  useDocumentTitle(c ? c.name : 'Campaign');

  if (res.loading && !res.data) return <Spinner />;
  if (res.error) {
    const removed = res.error.status === 404 && /removed/i.test(res.error.message || '');
    return (
      <>
        <PageHeader title={removed ? 'This campaign was removed' : 'Campaign'} actions={<Link className="btn" to="/app/campaigns">← Campaigns</Link>} />
        {removed ? <p className="muted">Only the latest finished campaign reports are kept. Download reports before they are removed.</p> : <ErrorState error={res.error} onRetry={res.reload} />}
      </>
    );
  }
  const { report } = res.data;
  const st = report.stats;

  const run = async (kind, fn, ok) => {
    setBusy(kind);
    setIssues([]);
    try {
      await fn();
      if (ok) toast.success(ok);
      res.reload({ silent: true });
      setTick((t) => t + 1);
    } catch (err) {
      setIssues(err.issues || []);
      toast.error(err);
    } finally {
      setBusy('');
    }
  };

  const cancel = () =>
    confirm({
      title: `Cancel “${c.name}”?`,
      message: 'All messages that are still waiting are cancelled. Messages already handed to the provider cannot be recalled. This cannot be undone.',
      confirmText: 'Cancel campaign',
      danger: true,
      onConfirm: async () => {
        try {
          const r = await api.post(`/c/campaigns/${c._id}/cancel`);
          toast.success(`Campaign cancelled — ${r.cancelledMessages} pending message(s) stopped`);
          res.reload({ silent: true });
          setTick((t) => t + 1);
        } catch (err) {
          toast.error(err);
          throw err;
        }
      },
    });

  const remove = () =>
    confirm({
      title: `Delete “${c.name}”?`,
      message: 'The campaign and its report are permanently deleted.',
      confirmText: 'Delete',
      danger: true,
      onConfirm: async () => {
        try {
          await api.del(`/c/campaigns/${c._id}`);
          toast.success('Campaign deleted');
          navigate('/app/campaigns', { replace: true });
        } catch (err) {
          toast.error(err);
          throw err;
        }
      },
    });

  const exportCsv = async () => {
    setBusy('export');
    try {
      await api.download(`/c/campaigns/${c._id}/export`, {}, 'campaign-report.csv');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy('');
    }
  };

  const clone = () =>
    run('clone', async () => {
      const r = await api.post(`/c/campaigns/${c._id}/clone`);
      navigate(r.campaign.channel === 'voice' ? `/app/voice/${r.campaign._id}/edit` : `/app/campaigns/${r.campaign._id}/edit`);
    }, 'Duplicated as a draft');

  const snap = c.templateSnapshot;
  const isVoice = c.channel === 'voice';
  const editTo = isVoice ? `/app/voice/${c._id}/edit` : `/app/campaigns/${c._id}/edit`;

  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={`${isVoice ? 'Voice call campaign · ' : c.templateName ? `Template ${c.templateName} · ` : ''}created ${fmtDate(c.createdAt)}`}
        actions={
          <>
            <Link className="btn" to={isVoice ? '/app/voice' : '/app/campaigns'}>{isVoice ? '← Voice calls' : '← Campaigns'}</Link>
            {['draft', 'scheduled'].includes(c.status) ? <Link className="btn" to={editTo}>Edit</Link> : null}
            {c.status === 'draft' || c.status === 'scheduled' ? <Button variant="primary" loading={busy === 'start'} onClick={() => run('start', () => api.post(`/c/campaigns/${c._id}/start`), 'Campaign started')}>Start now</Button> : null}
            {c.status === 'scheduled' ? <Button loading={busy === 'unschedule'} onClick={() => run('unschedule', () => api.post(`/c/campaigns/${c._id}/unschedule`), 'Schedule removed — back to draft')}>Unschedule</Button> : null}
            {c.status === 'running' ? <Button loading={busy === 'pause'} onClick={() => run('pause', () => api.post(`/c/campaigns/${c._id}/pause`), 'Campaign paused')}>Pause</Button> : null}
            {c.status === 'paused' ? <Button variant="primary" loading={busy === 'resume'} onClick={() => run('resume', () => api.post(`/c/campaigns/${c._id}/resume`), 'Campaign resumed')}>Resume</Button> : null}
            {['scheduled', 'queued', 'running', 'paused'].includes(c.status) ? <Button variant="outline-danger" onClick={cancel}>Cancel</Button> : null}
            <Button variant="primary" loading={busy === 'export'} onClick={exportCsv}>Download CSV report</Button>
            <Button loading={busy === 'clone'} onClick={clone}>Duplicate</Button>
            {!['queued', 'running', 'paused'].includes(c.status) ? <Button variant="outline-danger" onClick={remove}>Delete</Button> : null}
          </>
        }
      />
      <IssueList issues={issues} title="This action could not be completed" />
      {report.simulated ? (
        <Alert tone="info" title="Simulated campaign">
          {isVoice ? 'This campaign ran on the mock calling provider. “Dialled / Answered” are simulated statuses — no phone rang and no credits were used.' : 'This campaign ran on the Mock provider. “Sent / Delivered / Read” are simulated statuses — no message reached a real phone.'}
        </Alert>
      ) : null}
      {c.provider === 'wa_http' ? <Alert tone="info">Delivery receipts are not available for this provider.</Alert> : null}
      {c.lastError ? <Alert tone="warn">{c.lastError}</Alert> : null}
      {c.status === 'scheduled' ? <Alert tone="info">Scheduled to start at <strong>{fmtDate(c.scheduledAt)}</strong>.</Alert> : null}
      {live && c.nextBatchAt ? <Alert tone="info">Next worker batch is scheduled after {fmtDate(c.nextBatchAt)}. Provider-specific pacing may add additional delay.</Alert> : null}

      <div className="grid grid-4 mb">
        <div className="stat"><div className="stat-label">Status</div><div className="stat-value" style={{ fontSize: 20, marginTop: 6 }}><StatusBadge status={c.status} /></div><div className="stat-sub">{live ? 'Updating live…' : c.completedAt ? `Finished ${fmtDate(c.completedAt)}` : c.startedAt ? `Started ${fmtDate(c.startedAt)}` : 'Not started'}</div></div>
        <Stat label="Recipients" value={fmtNumber(st.recipients)} sub={`${fmtNumber(st.excluded)} excluded`} />
        <Stat label="Queued" value={fmtNumber(st.queued)} />
        <Stat label="Processing" value={fmtNumber(st.sending)} />
      </div>
      <div className="grid grid-4 mb">
        <Stat label="Sent / submitted" value={fmtNumber(st.sent)} />
        <Stat label="Delivered" value={fmtNumber(st.delivered)} />
        <Stat label="Failed" value={fmtNumber(st.failed)} tone={st.failed ? 'danger' : undefined} />
        <Stat label="Outcome unknown" value={fmtNumber(st.unknown)} tone={st.unknown ? 'warn' : undefined} />
        <Stat label="Cutting off" value={fmtNumber(st.cut || 0)} />
        <Stat label="Cancelled" value={fmtNumber(st.cancelled)} />
      </div>

      <div className="grid grid-2 mb">
        <Card title={report.simulated ? 'Delivery funnel (simulated)' : 'Delivery funnel'}>
          {st.recipients ? <Funnel stats={st} voice={isVoice} /> : <EmptyState title="Nothing to report yet">Recipients appear here once the campaign has been started.</EmptyState>}
        </Card>
        <Card title={isVoice ? 'Why some were not called' : 'Why some did not get the message'}>
          {report.excludedReasons.length || report.failureReasons.length || report.unknownReasons.length ? (
            <>
              {report.excludedReasons.length ? (
                <>
                  <div className="small muted" style={{ fontWeight: 600 }}>Excluded before sending</div>
                  <ul style={{ margin: '4px 0 12px', paddingLeft: 18 }}>
                    {report.excludedReasons.map((r) => <li key={r.reason}>{excludedReasonText(r.reason)} — {fmtNumber(r.count)}</li>)}
                  </ul>
                </>
              ) : null}
              {report.failureReasons.length ? (
                <>
                  <div className="small muted" style={{ fontWeight: 600 }}>Failed</div>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {report.failureReasons.map((r) => <li key={r.reason || 'unknown'}>{r.reason || 'Unknown error'} — {fmtNumber(r.count)}</li>)}
                  </ul>
                </>
              ) : null}
              {report.unknownReasons.length ? (
                <>
                  <div className="small muted" style={{ fontWeight: 600 }}>Provider outcome unknown (not retried)</div>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {report.unknownReasons.map((r) => <li key={r.reason || 'unknown'}>{r.reason || 'Provider did not confirm acceptance'} — {fmtNumber(r.count)}</li>)}
                  </ul>
                </>
              ) : null}
            </>
          ) : (
            <p className="muted">No exclusions or failures.</p>
          )}
        </Card>
      </div>
      {!report.simulated ? (
        <Card title="Billing breakdown" className="mb">
          <p className="muted small">All eligible recipients are charged at the configured full per-message/call rate, including cut recipients that are deliberately not sent. An ambiguous provider timeout/5xx is also kept charged and never retried to avoid duplicate sends; explicit provider rejections are refunded. Delivery status is reported independently.</p>
          <div className="grid grid-4">
            <Stat label="Charged recipients / calls" value={fmtNumber(report.billing.messages)} />
            <Stat label="Cutting off" value={fmtNumber(report.billing.cutMessages || 0)} />
            <Stat label="Cut percentage" value={`${fmtNumber(c.cuttingPercentage || 0)}%`} />
            <Stat label="Total charge (credits)" value={fmtNumber(report.billing.finalCharge)} />
          </div>
        </Card>
      ) : null}

      {st.recipients || st.excluded ? <Recipients id={c._id} live={live} refreshKey={tick} /> : null}

      {snap ? (
        <>
          <div className="mt" />
          {isVoice ? (
            <Card title="Call content that was used">
              <dl className="kv mb">
                <dt>Caller ID (CLI)</dt><dd className="mono">{(snap.voice && snap.voice.cliNumber) || '—'}</dd>
                <dt>Text to speak</dt><dd>{snap.body || <span className="muted">None</span>}</dd>
              </dl>
              {snap.media ? <MediaPreview media={snap.media} /> : <p className="muted small">No audio file was attached.</p>}
            </Card>
          ) : (
            <Card title="Message that was used (template snapshot)">
              <TemplatePreview header={snap.header} media={snap.media} body={snap.body} footer={snap.footer} />
            </Card>
          )}
        </>
      ) : null}
    </>
  );
}
