import { useState } from 'react';
import { api } from '../../api.js';
import { useApi, useDocumentTitle } from '../../hooks.js';
import { fmtNumber } from '../../format.js';
import { Alert, Card, DataTable, ErrorState, Field, PageHeader, Progress, Spinner, Stat } from '../../components/ui.jsx';

function monthName(period) {
  const [year, month] = period.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export default function Usage() {
  useDocumentTitle('Usage & limits');
  const [period, setPeriod] = useState('');
  const res = useApi(() => api.get('/c/usage', period ? { period } : {}), [period]);
  if (res.loading && !res.data) return <Spinner />;
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  const u = res.data;
  const isCurrent = u.period === u.currentPeriod;
  const nearMsg = isCurrent && u.messages.limit > 0 && u.messages.used / u.messages.limit >= 0.9;
  const nearContacts = u.contacts.limit > 0 && u.contacts.count / u.contacts.limit >= 0.9;
  const columns = [
    { key: 'period', header: 'Month', render: (r) => monthName(r.period) },
    { key: 'messages', header: 'Messages counted', render: (r) => fmtNumber(r.messages) },
    { key: 'simulated', header: 'Of which simulated', render: (r) => fmtNumber(r.simulatedMessages) },
    { key: 'failed', header: 'Failed', render: (r) => fmtNumber(r.messagesFailed) },
    { key: 'unknown', header: 'Outcome unknown', render: (r) => fmtNumber(r.messagesUnknown || 0) },
    { key: 'cut', header: 'Cutting off', render: (r) => fmtNumber(r.messagesCut || 0) },
    { key: 'credits', header: 'Credits used', render: (r) => fmtNumber(r.creditsSpent) },
    { key: 'calls', header: 'Calls', render: (r) => fmtNumber(r.voiceCalls) },
    { key: 'campaigns', header: 'Campaigns started', render: (r) => fmtNumber(r.campaignsStarted) },
  ];

  return (
    <>
      <PageHeader title="Usage & limits" subtitle={`Monthly usage is grouped in ${u.timezone}. Limits are set by your administrator or reseller.`} />
      {u.lastMonthSummary ? (
        <Card title={`Last month summary (${monthName(u.lastMonthSummary.period)})`}>
          {u.lastMonthSummary.approximate ? <Alert tone="warn">This legacy month is approximate because detailed counters were not recorded at the time.</Alert> : null}
          <div className="grid grid-4">
            <Stat label="Messages sent" value={fmtNumber(u.lastMonthSummary.messagesSent)} sub={`${fmtNumber(u.lastMonthSummary.messagesFailed)} failed · ${fmtNumber(u.lastMonthSummary.messagesUnknown || 0)} unknown · ${fmtNumber(u.lastMonthSummary.messagesCut || 0)} cutting off · ${fmtNumber(u.lastMonthSummary.simulatedMessages)} simulated`} />
            <Stat label="Credits used" value={fmtNumber(u.lastMonthSummary.creditsSpent)} />
            <Stat label="Voice calls" value={fmtNumber(u.lastMonthSummary.voiceCalls)} />
            <Stat label="Campaigns started" value={fmtNumber(u.lastMonthSummary.campaignsStarted)} />
          </div>
        </Card>
      ) : null}
      <div className="toolbar">
        <Field label="Usage month">
          <select value={u.period} onChange={(event) => setPeriod(event.target.value)} aria-label="Usage month">
            {u.periods.map((value) => <option key={value} value={value}>{monthName(value)}</option>)}
          </select>
        </Field>
      </div>
      {u.approximate ? <Alert tone="warn">This historical month is approximate. Detailed message/call counters were not available, so the display falls back to legacy usage and the credit ledger where possible.</Alert> : null}
      {nearMsg ? <Alert tone="warn">You have used {Math.round((u.messages.used / u.messages.limit) * 100)}% of this month’s message limit. Campaigns that need more messages than remain cannot be started.</Alert> : null}
      {nearContacts ? <Alert tone="warn">You are close to your contact limit. Imports stop adding contacts once it is reached.</Alert> : null}
      <div className="grid grid-3 mb">
        <Card title={isCurrent ? 'Messages this month' : `Messages in ${monthName(u.period)}`}>
          <div className="stat-value">
            {fmtNumber(u.messages.used)} {isCurrent ? <span className="muted" style={{ fontSize: 16 }}>/ {fmtNumber(u.messages.limit)}</span> : null}
          </div>
          {isCurrent ? <div className="mt"><Progress value={u.messages.used} max={u.messages.limit} label="Messages used" /></div> : null}
          <p className="muted small mt">{isCurrent ? `${fmtNumber(u.messages.remaining)} remaining · ` : ''}{fmtNumber(u.messages.simulated)} simulated · {fmtNumber(u.messages.unknown || 0)} outcome unknown · {fmtNumber(u.messages.cut || 0)} cutting off</p>
        </Card>
        <Card title="Contacts">
          <div className="stat-value">
            {fmtNumber(u.contacts.count)} <span className="muted" style={{ fontSize: 16 }}>/ {fmtNumber(u.contacts.limit)}</span>
          </div>
          <div className="mt"><Progress value={u.contacts.count} max={u.contacts.limit} label="Contacts used" /></div>
        </Card>
        <Stat label={`Campaigns started in ${monthName(u.period)}`} value={fmtNumber(u.campaignsStarted)} />
      </div>
      <Card title="Monthly detail" pad={false}>
        <DataTable columns={columns} rows={[...u.history].reverse()} rowKey={(row) => row.period} />
      </Card>
    </>
  );
}
