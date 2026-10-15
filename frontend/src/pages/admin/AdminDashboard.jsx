import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi, useDocumentTitle } from '../../hooks.js';
import { fmtNumber, fmtRelative, humanize } from '../../format.js';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner, Stat } from '../../components/ui.jsx';

export default function AdminDashboard() {
  useDocumentTitle('Dashboard');
  const stats = useApi(() => api.get('/admin/stats'), []);
  if (stats.loading && !stats.data) return <Spinner />;
  if (stats.error) return <ErrorState error={stats.error} onRetry={stats.reload} />;
  const s = stats.data;
  const by = s.campaigns.byStatus || {};

  return (
    <>
      <PageHeader
        title="Platform dashboard"
        subtitle={`Live numbers from the database · usage period ${s.period}`}
        actions={<Button onClick={() => stats.reload({ silent: true })}>Refresh</Button>}
      />
      <div className="grid grid-4 mb">
        <Stat label="Resellers" value={fmtNumber(s.resellers.active)} sub={`${s.resellers.suspended} suspended`} />
        <Stat label="Customers" value={fmtNumber(s.customers.active)} sub={`${s.customers.suspended} suspended`} />
        <Stat label="Contacts (all tenants)" value={fmtNumber(s.contacts)} />
        <Stat label="Campaigns" value={fmtNumber(s.campaigns.total)} sub={`${by.running || 0} running · ${by.scheduled || 0} scheduled`} />
      </div>
      <div className="grid grid-3 mb">
        <Stat label="Messages this month" value={fmtNumber(s.messages.thisMonth)} sub="real + simulated" />
        <Stat label="…of which simulated (mock)" value={fmtNumber(s.messages.simulatedThisMonth)} sub="never delivered to a real phone" />
        <Stat label="Failed messages (all time)" value={fmtNumber(s.messages.failedAllTime)} tone={s.messages.failedAllTime ? 'danger' : undefined} />
      </div>
      <div className="grid grid-2">
        <Card title="Top customers by messages this month" actions={<Link to="/admin/customers">All customers</Link>}>
          {s.topCustomers.length ? (
            <table className="table">
              <tbody>
                {s.topCustomers.map((c) => (
                  <tr key={String(c.ownerId)}>
                    <td>
                      <Link to={`/admin/customers/${c.ownerId}`}>{c.name}</Link>
                    </td>
                    <td className="right">{fmtNumber(c.messages)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title="No messages sent this month" />
          )}
        </Card>
        <Card title="Recent activity" actions={<Link to="/admin/audit">Full audit log</Link>}>
          {s.recentActivity.length ? (
            <table className="table">
              <tbody>
                {s.recentActivity.map((e) => (
                  <tr key={e._id}>
                    <td>
                      <Badge>{humanize(e.action)}</Badge>
                      <div className="muted small">{e.actorEmail}</div>
                    </td>
                    <td className="right muted nowrap">{fmtRelative(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title="Nothing recorded yet" />
          )}
        </Card>
      </div>
    </>
  );
}
