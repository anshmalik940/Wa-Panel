import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useApi, useDocumentTitle } from '../../hooks.js';
import { fmtDate, fmtNumber } from '../../format.js';
import { Alert, Button, Card, EmptyState, ErrorState, Funnel, PageHeader, Progress, Spinner, Stat, StatusBadge } from '../../components/ui.jsx';

export default function Dashboard() {
  useDocumentTitle('Dashboard');
  const { user } = useAuth();
  const res = useApi(() => api.get('/c/dashboard'), []);
  if (res.loading && !res.data) return <Spinner />;
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  const d = res.data;
  const wa = d.whatsapp;
  const running = d.campaigns.running || 0;

  return (
    <>
      <PageHeader
        title={`Hello, ${user.name}`}
        subtitle="Everything below is calculated from your own data."
        actions={
          <>
            <Button onClick={() => res.reload({ silent: true })}>Refresh</Button>
            <Link className="btn btn-primary" to="/app/campaigns/new">
              + New campaign
            </Link>
          </>
        }
      />
      {wa.status !== 'connected' ? (
        <Alert tone="warn" title="WhatsApp is not connected">
          Campaigns can only be started after you connect a provider. <Link to="/app/whatsapp">Open WhatsApp settings</Link> and run “Test connection” (the Mock provider needs no credentials).
        </Alert>
      ) : (
        <Alert tone="info">
          Connected through the <strong>{{
            mock: 'Mock (simulation)',
            qr: 'admin linked phone (QR)',
            meta: 'WhatsApp Cloud API',
            wa_http: 'vendor HTTP API',
          }[wa.provider] || 'platform'}</strong> provider.
          {wa.provider === 'mock' ? ' No real messages are sent; results are simulated.' : ''}
        </Alert>
      )}
      <div className="grid grid-4 mb">
        <Stat label="Contacts" value={fmtNumber(d.contacts.total)} sub={`${fmtNumber(d.contacts.valid)} can receive messages`} />
        <Stat label="Opted out" value={fmtNumber(d.contacts.optedOut)} sub={`${fmtNumber(d.contacts.invalid)} invalid numbers`} />
        <Stat label="Approved templates" value={fmtNumber(d.templates.approved || 0)} sub={`${(d.templates.draft || 0) + (d.templates.pending || 0)} draft / pending`} />
        <Stat label="Campaigns" value={fmtNumber(Object.values(d.campaigns).reduce((a, b) => a + b, 0))} sub={`${running} running · ${d.campaigns.scheduled || 0} scheduled`} />
      </div>
      <div className="grid grid-2 mb">
        <Card title="Messages (last 30 days)">
          {d.messagesLast30Days.recipients ? (
            <>
              <Funnel stats={d.messagesLast30Days} />
              <p className="muted small mt">
                {fmtNumber(d.messagesLast30Days.excluded)} recipients were excluded (opted out, invalid number or missing data). Simulated results are labelled as such in each campaign report.
              </p>
            </>
          ) : (
            <EmptyState title="No messages in the last 30 days">Start a campaign to see delivery results here.</EmptyState>
          )}
        </Card>
        <Card title={`Monthly usage · ${d.usage.period}`} actions={<Link to="/app/usage">Details</Link>}>
          <div className="row between">
            <strong>
              {fmtNumber(d.usage.messages)} / {fmtNumber(d.usage.limit)}
            </strong>
            <span className="muted">{fmtNumber(d.usage.remaining)} remaining</span>
          </div>
          <div className="mt">
            <Progress value={d.usage.messages} max={d.usage.limit} label="Monthly message usage" />
          </div>
          <p className="muted small mt">
            {fmtNumber(d.usage.simulatedMessages)} of these are simulated (mock). {d.usage.campaignsStarted} campaign(s) started this month.
          </p>
        </Card>
      </div>
      <Card title="Recent campaigns" actions={<Link to="/app/campaigns">All campaigns</Link>} pad={false}>
        {d.recentCampaigns.length ? (
          <div className="table-wrap">
            <table className="table stack">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>Sent / recipients</th>
                  <th>Failed</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {d.recentCampaigns.map((c) => (
                  <tr key={c.id}>
                    <td data-label="Campaign">
                      <Link to={`/app/campaigns/${c.id}`} style={{ fontWeight: 600 }}>
                        {c.name}
                      </Link>
                    </td>
                    <td data-label="Status">
                      <StatusBadge status={c.status} />
                    </td>
                    <td data-label="Sent / recipients">
                      {fmtNumber(c.sent)} / {fmtNumber(c.recipients)}
                    </td>
                    <td data-label="Failed">{fmtNumber(c.failed)}</td>
                    <td data-label="Created">{fmtDate(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No campaigns yet" action={<Link className="btn btn-primary" to="/app/campaigns/new">Create your first campaign</Link>}>
            A campaign sends an approved template to a group of contacts.
          </EmptyState>
        )}
      </Card>
    </>
  );
}
