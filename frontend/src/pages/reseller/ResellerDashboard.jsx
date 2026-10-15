import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useApi, useDocumentTitle } from '../../hooks.js';
import { fmtNumber, pct } from '../../format.js';
import { Button, Card, EmptyState, ErrorState, PageHeader, Progress, Spinner, Stat, StatusBadge } from '../../components/ui.jsx';

export default function ResellerDashboard() {
  useDocumentTitle('Dashboard');
  const { user } = useAuth();
  const stats = useApi(() => api.get('/reseller/stats'), []);
  if (stats.loading && !stats.data) return <Spinner />;
  if (stats.error) return <ErrorState error={stats.error} onRetry={stats.reload} />;
  const s = stats.data;
  return (
    <>
      <PageHeader
        title={`Welcome, ${user.name}`}
        subtitle={`Your customers and their usage · period ${s.period}`}
        actions={
          <>
            <Button onClick={() => stats.reload({ silent: true })}>Refresh</Button>
            <Link className="btn btn-primary" to="/reseller/customers">
              Manage customers
            </Link>
          </>
        }
      />
      <div className="grid grid-4 mb">
        <Stat label="Customers" value={fmtNumber(s.customers.total)} sub={`capacity ${fmtNumber(s.customers.capacity)}`} />
        <Stat label="Active" value={fmtNumber(s.customers.active)} tone="ok" />
        <Stat label="Suspended" value={fmtNumber(s.customers.suspended)} tone={s.customers.suspended ? 'danger' : undefined} />
        <Stat label="Messages this month" value={fmtNumber(s.messagesThisMonth)} sub="all your customers" />
      </div>
      <Card title="Customer capacity">
        <Progress value={s.customers.total} max={s.customers.capacity} label="Customer capacity used" />
        <p className="muted small mt">
          {s.customers.total} of {s.customers.capacity} customer slots used ({pct(s.customers.total, s.customers.capacity)}%).
        </p>
      </Card>
      <div className="mt" />
      <Card title="Usage per customer (top 10)" pad={false}>
        {s.usagePerCustomer.length ? (
          <div className="table-wrap">
            <table className="table stack">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Messages / limit</th>
                  <th style={{ width: 200 }}>Used</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {s.usagePerCustomer.map((c) => (
                  <tr key={c.id}>
                    <td data-label="Customer">
                      <Link to={`/reseller/customers/${c.id}`} style={{ fontWeight: 600 }}>
                        {c.name}
                      </Link>
                      <div className="muted small">{c.email}</div>
                    </td>
                    <td data-label="Messages / limit">
                      {fmtNumber(c.messages)} / {fmtNumber(c.limit)}
                      {c.simulated ? <span className="muted small"> ({fmtNumber(c.simulated)} simulated)</span> : null}
                    </td>
                    <td data-label="Used">
                      <Progress value={c.messages} max={c.limit} label={`${c.name} usage`} />
                    </td>
                    <td data-label="Status">
                      <StatusBadge status={c.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No customers yet" action={<Link className="btn btn-primary" to="/reseller/customers">Create your first customer</Link>}>
            Customers you create get their own contacts, templates and campaigns.
          </EmptyState>
        )}
      </Card>
    </>
  );
}
