import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useApi, useDocumentTitle } from '../../hooks.js';
import { Alert, Badge, Button, Card, ErrorState, PageHeader, Spinner, useConfirm, useToast } from '../../components/ui.jsx';

const QR_STATUS = {
  idle: ['neutral', 'Not linked'],
  starting: ['info', 'Starting…'],
  qr: ['warn', 'Waiting for scan'],
  connected: ['ok', 'Linked'],
  disconnected: ['warn', 'Reconnecting…'],
  logged_out: ['danger', 'Logged out on the phone'],
};

function QrPanel({ onChange }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lastStatus = useRef('');

  const poll = useCallback(async () => {
    try {
      const next = await api.get('/c/whatsapp/qr');
      setState(next);
      setError('');
      if (lastStatus.current !== next.status) {
        lastStatus.current = next.status;
        if (next.status === 'connected' || next.status === 'logged_out') onChange();
        if (next.status === 'connected') toast.success(`Phone linked${next.phone ? `: ${next.phone}` : ''}`);
      }
    } catch (err) {
      setError(err.message);
    }
  }, [onChange, toast]);

  useEffect(() => {
    poll();
  }, [poll]);
  useEffect(() => {
    if (!state || !['starting', 'qr', 'disconnected'].includes(state.status)) return undefined;
    const timer = setInterval(poll, 2500);
    return () => clearInterval(timer);
  }, [state, poll]);

  const start = async (fresh) => {
    setBusy(true);
    try {
      await api.post('/c/whatsapp/qr/start', { fresh });
      await poll();
    } catch (err) {
      setError(err.message);
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const unlink = () => confirm({
    title: 'Unlink this phone?',
    message: 'The saved linked-phone session will be removed. You can scan again later.',
    confirmText: 'Unlink',
    danger: true,
    onConfirm: async () => {
      try {
        await api.post('/c/whatsapp/qr/logout');
        await poll();
        onChange();
        toast.success('Phone unlinked');
      } catch (err) {
        toast.error(err);
        throw err;
      }
    },
  });

  const status = state ? state.status : 'idle';
  const [tone, label] = QR_STATUS[status] || ['neutral', status];
  const watching = ['starting', 'qr', 'disconnected'].includes(status);

  return (
    <Card title="Use my own phone (QR)" actions={<Badge tone={tone}>{label}</Badge>}>
      <Alert tone="warn" title="Use modest volumes">
        This uses the WhatsApp Web protocol. WhatsApp can restrict or ban numbers that send bulk or unsolicited messages. Messages are intentionally spaced out, and a STOP reply opts out that contact.
      </Alert>
      {error ? <div className="mt"><Alert tone="danger">{error}</Alert></div> : null}
      {state?.lastError && status !== 'connected' ? <div className="mt"><Alert tone="danger">{state.lastError}</Alert></div> : null}
      <div className="mt">
        {status === 'connected' ? (
          <div className="row gap-s wrap">
            <strong>{state.phone || 'Linked phone'}</strong>
            <Button variant="outline-danger" onClick={unlink}>Unlink phone</Button>
          </div>
        ) : status === 'qr' && state.qrImage ? (
          <div className="qr-box">
            <img src={state.qrImage} alt="WhatsApp QR code to scan" />
            <div className="small">WhatsApp → Settings → Linked devices → Link a device, then scan this code.</div>
            <Button size="sm" onClick={() => start(true)} loading={busy}>Start over</Button>
          </div>
        ) : (
          <div className="row gap-s wrap">
            <Button variant="primary" onClick={() => start(false)} loading={busy || status === 'starting'}>
              {state?.hasSavedSession ? 'Reconnect saved phone' : 'Generate QR code'}
            </Button>
            {state?.hasSavedSession ? <Button onClick={() => start(true)} disabled={busy}>Link a different phone</Button> : null}
          </div>
        )}
      </div>
      <p className="muted small mt">Real sends require <code>ALLOW_REAL_SEND=true</code> and use credits.</p>
      {watching ? <span className="sr-only" aria-live="polite">QR connection status is updating</span> : null}
    </Card>
  );
}

export default function WhatsApp() {
  useDocumentTitle('WhatsApp');
  const toast = useToast();
  const res = useApi(() => api.get('/c/whatsapp'), []);
  const [busy, setBusy] = useState(false);
  if (res.loading && !res.data) return <Spinner />;
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;

  const { connection, allowQr, useOwnQr, simulated } = res.data;
  const sourceLabel = connection.source === 'own_qr' ? 'My phone' : 'Platform';

  const chooseSource = async (next) => {
    setBusy(true);
    try {
      await api.put('/c/whatsapp', { useOwnQr: next });
      await res.reload({ silent: true });
      toast.success(next ? 'Campaigns will use your linked phone when connected' : 'Campaigns will use the platform connection');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="WhatsApp" subtitle="Campaigns use the platform connection automatically." />
      <Card title="Connection status" actions={<Badge tone={connection.ready ? 'ok' : 'warn'}>{connection.ready ? 'Ready' : 'Not ready'}</Badge>}>
        <p><strong>Sending through: {sourceLabel} — {connection.ready ? 'Ready' : 'Not ready'}</strong></p>
        {!connection.ready ? <Alert tone="warn">Sending is not set up yet. Please contact your administrator.</Alert> : null}
        {connection.displayPhone ? <p className="muted small">Connected number: {connection.displayPhone}</p> : null}
        {simulated ? <Alert tone="info">Test mode: messages are simulated.</Alert> : null}
      </Card>
      {allowQr ? (
        <>
          <Card title="Campaign sending source">
            <p className="muted small">Choose whether your own linked phone should send your campaigns. If it is disconnected, campaigns use the platform connection.</p>
            <div className="row gap-s wrap" role="group" aria-label="Send my campaigns from">
              <label className="check">
                <input type="radio" name="campaign-source" checked={!useOwnQr} onChange={() => chooseSource(false)} disabled={busy} />
                Platform
              </label>
              <label className="check">
                <input type="radio" name="campaign-source" checked={useOwnQr} onChange={() => chooseSource(true)} disabled={busy} />
                My phone
              </label>
            </div>
          </Card>
          <QrPanel onChange={() => res.reload({ silent: true })} />
        </>
      ) : null}
    </>
  );
}
