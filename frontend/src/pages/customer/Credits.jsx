import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi, useDocumentTitle } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtNumber } from '../../format.js';
import { Alert, Card, ErrorState, PageHeader, Spinner, Stat } from '../../components/ui.jsx';
import { LedgerTable, LOW_CREDITS, useLedger } from '../../components/Credits.jsx';

/** Wallet page for customers and resellers: balance, what one message / call costs, and the full ledger. */
export default function Credits() {
  useDocumentTitle('Credits');
  const { user } = useAuth();
  const info = useApi(() => api.get('/c/credits', { page: 1, limit: 1 }), []);
  const ledger = useLedger('/c/credits', 15);
  if (info.loading && !info.data) return <Spinner />;
  if (info.error) return <ErrorState error={info.error} onRetry={info.reload} />;
  const { balance, costs } = info.data;
  const giver = user.role === 'reseller' ? 'your administrator' : 'your reseller or administrator';

  return (
    <>
      <PageHeader title="Credits" subtitle="Credits pay for real WhatsApp messages and voice calls. Simulated (mock) messages are free." />
      {balance <= 0 ? (
        <Alert tone="danger" title="No credits left">
          Real campaigns cannot start (and running ones pause) until {giver} adds credits to your account.
        </Alert>
      ) : balance <= LOW_CREDITS ? (
        <Alert tone="warn" title="Low balance">
          Only {fmtNumber(balance)} credits left. Ask {giver} to add more before you start a big campaign.
        </Alert>
      ) : null}
      <div className="grid grid-3 mb">
        <Stat label="Balance" value={fmtNumber(balance)} sub="credits available" tone={balance <= 0 ? 'danger' : undefined} />
        <Stat label="Per message" value={fmtNumber(costs.message)} sub="credits for each real WhatsApp message" />
        <Stat label="Per call" value={fmtNumber(costs.call)} sub="credits for each voice call" />
      </div>
      {info.data.cutting ? (
        <Alert tone={info.data.cutting.eligible ? 'info' : 'warn'} title={info.data.cutting.eligible ? 'Campaign cutting is active' : 'Campaign cutting is not currently eligible'}>
          {info.data.cutting.percentage}% of eligible real-campaign recipients are marked “Cutting off”; the full configured campaign credits are still charged.
          {!info.data.cutting.eligible && new Date(info.data.cutting.startsAt) > new Date()
            ? ` Starts ${new Date(info.data.cutting.startsAt).toLocaleString()}.`
            : info.data.cutting.expiresAt ? ` Expires ${new Date(info.data.cutting.expiresAt).toLocaleString()}.` : ''}
        </Alert>
      ) : null}
      <Card title="Credit history" pad={false}>
        <LedgerTable ledger={ledger} campaignLinks />
      </Card>
      <p className="muted small mt">
        Failed messages are refunded automatically. Campaign usage is shown as one line per campaign. To test without spending credits, use the Mock provider on the{' '}
        <Link to="/app/whatsapp">WhatsApp</Link> page.
      </p>
    </>
  );
}
