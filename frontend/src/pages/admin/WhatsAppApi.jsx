import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useApi, useDocumentTitle } from '../../hooks.js';
import { Alert, Badge, Button, Card, ErrorState, Field, PageHeader, Spinner, useToast } from '../../components/ui.jsx';

const PROVIDERS = [
  ['mock', 'Test mode (simulated)'],
  ['wa_http', 'Vendor HTTP API'],
  ['meta', 'Meta Cloud API'],
  ['qr', 'Admin linked phone (QR)'],
];

const warning = 'All users send from this phone. WhatsApp can restrict numbers that send bulk messages.';

function QRPanel({ refreshConfig }) {
  const toast = useToast();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setState(await api.get('/admin/wa-api/qr'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!state || !['starting', 'qr', 'disconnected'].includes(state.status)) return undefined;
    const timer = setInterval(refresh, 2500);
    return () => clearInterval(timer);
  }, [state, refresh]);

  const start = async (fresh = false) => {
    setBusy('start');
    setError('');
    setState((current) => ({ ...current, status: 'starting', qrImage: null, lastError: '' }));
    try {
      const response = await api.post('/admin/wa-api/qr/start', { fresh });
      setState((current) => ({ ...current, status: response.status || 'starting' }));
      await refresh();
    } catch (err) {
      setState((current) => ({ ...current, status: 'idle' }));
      setError(err.message);
      toast.error(err);
    } finally {
      setBusy('');
    }
  };

  const logout = async () => {
    setBusy('logout');
    try {
      await api.post('/admin/wa-api/qr/logout');
      await refresh();
      refreshConfig();
      toast.success('Platform phone unlinked');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy('');
    }
  };

  const status = state?.status || 'idle';
  const statusLabel = status === 'connected' ? 'Connected' : status === 'qr' ? 'Waiting for scan' : status === 'starting' ? 'Starting' : status === 'disconnected' ? 'Reconnecting' : 'Not connected';
  return (
    <Card title="Admin phone (QR)" actions={<Badge tone={status === 'connected' ? 'ok' : status === 'qr' ? 'warn' : 'neutral'}>{statusLabel}</Badge>}>
      <Alert tone="warn">{warning}</Alert>
      {error ? <div className="mt"><Alert tone="danger">{error}</Alert></div> : null}
      {state?.lastError ? <div className="mt"><Alert tone="danger">{state.lastError}</Alert></div> : null}
      {status === 'connected' ? (
        <div className="row gap-s wrap mt">
          <strong>{state.phone || 'Phone connected'}</strong>
          <Button variant="outline-danger" onClick={logout} loading={busy === 'logout'}>Unlink platform phone</Button>
        </div>
      ) : ['starting', 'qr', 'disconnected'].includes(status) ? (
        <div className="qr-box mt">
          {status === 'qr' && state.qrImage ? (
            <>
              <img src={state.qrImage} alt="Platform WhatsApp QR code" />
              <div className="small">WhatsApp → Settings → Linked devices → Link a device.</div>
              <Button size="sm" onClick={() => start(true)} loading={busy === 'start'}>Start over</Button>
            </>
          ) : (
            <p className="small" role="status" aria-live="polite">
              {status === 'disconnected' ? 'Reconnecting to WhatsApp…' : 'Generating QR code. Keep this screen open; it will appear here automatically.'}
            </p>
          )}
        </div>
      ) : (
        <div className="row gap-s wrap mt">
          <Button variant="primary" onClick={() => start(false)} loading={busy === 'start'}>{state?.hasSavedSession ? 'Reconnect saved phone' : 'Generate QR code'}</Button>
          {state?.hasSavedSession ? <Button onClick={() => start(true)} disabled={Boolean(busy)}>Link a different phone</Button> : null}
        </div>
      )}
    </Card>
  );
}

export default function WhatsAppApi() {
  useDocumentTitle('WhatsApp API');
  const toast = useToast();
  const res = useApi(() => api.get('/admin/wa-api'), []);
  const [vendor, setVendor] = useState(null);
  const [meta, setMeta] = useState(null);
  const [activeProvider, setActiveProvider] = useState('mock');
  const [testNumber, setTestNumber] = useState('');
  const [testText, setTestText] = useState('WhatsApp platform test message');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!res.data) return;
    const c = res.data.config;
    setActiveProvider(c.activeProvider);
    setVendor({
      providerName: c.providerName || '',
      baseUrl: c.baseUrl || '',
      method: c.method || 'GET',
      contentType: c.contentType || 'query',
      country: c.country || 'IN',
      mobileFormat: c.mobileFormat || 'national',
      successPath: c.successPath || '',
      successValue: c.successValue || '',
      messageIdPath: c.messageIdPath || '',
      paramNames: { ...c.paramNames },
      mediaMapping: { ...c.mediaMapping },
      defaultCaption: c.defaultCaption || '',
      apiKey: '',
    });
    setMeta({
      phoneNumberId: c.meta.phoneNumberId || '',
      wabaId: c.meta.wabaId || '',
      appId: c.meta.appId || '',
      graphVersion: c.meta.graphVersion || 'v21.0',
      accessToken: '',
      appSecret: '',
      verifyToken: '',
    });
  }, [res.data]);

  const reload = () => res.reload({ silent: true });
  const setVendorField = (key, value) => setVendor((current) => ({ ...current, [key]: value }));
  const setParam = (key, value) => setVendor((current) => ({ ...current, paramNames: { ...current.paramNames, [key]: value } }));

  const saveVendor = async (event) => {
    event.preventDefault();
    setBusy('vendor');
    try {
      const payload = { ...vendor, mode: 'http' };
      if (!payload.apiKey.trim()) delete payload.apiKey;
      const response = await api.put('/admin/wa-api', payload);
      setVendor((current) => ({ ...current, apiKey: '' }));
      if (response.config.activeProvider === 'wa_http' && !response.config.ready) toast.info(`Saved, but the active vendor connection is not ready: ${response.config.readyProblem}`);
      else toast.success(response.config.hasApiKey ? 'Vendor settings saved. API key remains encrypted and masked.' : 'Vendor settings saved.');
      reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy('');
    }
  };

  const saveMeta = async (event) => {
    event.preventDefault();
    setBusy('meta');
    try {
      const credentials = { ...meta };
      for (const key of ['accessToken', 'appSecret', 'verifyToken']) if (!credentials[key].trim()) delete credentials[key];
      const response = await api.put('/admin/wa-api', { meta: credentials });
      setMeta((current) => ({ ...current, accessToken: '', appSecret: '', verifyToken: '' }));
      if (response.config.activeProvider === 'meta' && (!response.config.metaReady || response.config.meta.status !== 'connected')) toast.info('Saved, but the active Meta connection is not ready. Test the connection to confirm it.');
      else toast.success('Meta settings saved. Secrets remain encrypted and masked.');
      reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy('');
    }
  };

  const saveActive = async (event) => {
    event.preventDefault();
    setBusy('active');
    try {
      const response = await api.put('/admin/wa-api', { activeProvider });
      const cfg = response.config;
      if (cfg.activeProvider === 'wa_http' && !cfg.ready) toast.info(`Saved; connection is not ready: ${cfg.readyProblem}`);
      else if (cfg.activeProvider === 'meta' && (!cfg.metaReady || cfg.meta.status !== 'connected')) toast.info('Saved; Meta connection is not ready yet.');
      else if (cfg.activeProvider === 'qr' && cfg.qrStatus.status !== 'connected') toast.info('Saved; the admin phone is not connected yet.');
      else toast.success('Active connection saved.');
      reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy('');
    }
  };

  const testConnection = async (provider) => {
    setBusy(`test-${provider}`);
    setResult(null);
    try {
      const response = await api.post('/admin/wa-api/test-connection', { provider });
      setResult(response);
      if (response.status === 'connected') toast.success(response.message);
      else toast.error(response.message);
      reload();
    } catch (err) {
      setResult({ status: 'error', message: err.message });
      toast.error(err);
    } finally {
      setBusy('');
    }
  };

  const sendTest = async (event) => {
    event.preventDefault();
    setBusy('send');
    setResult(null);
    try {
      const response = await api.post('/admin/wa-api/test', { provider: activeProvider, number: testNumber, text: testText });
      setResult(response);
      response.ok ? toast.success('Test message accepted.') : toast.error(response.body || 'Test message failed.');
    } catch (err) {
      setResult({ ok: false, error: err.message });
      toast.error(err);
    } finally {
      setBusy('');
    }
  };

  if (res.loading && !res.data) return <Spinner />;
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!vendor || !meta) return <Spinner />;
  const c = res.data.config;
  const ready = {
    mock: true,
    wa_http: c.ready,
    meta: c.metaReady && c.meta.status === 'connected',
    qr: c.qrStatus.status === 'connected',
  };

  return (
    <>
      <PageHeader title="WhatsApp API" subtitle="Manage the shared platform connection and the optional administrator phone." />
      <div className="col gap-m">
        <Card title="Active connection for everyone">
          <form onSubmit={saveActive}>
            <Field label="Platform connection">
              <select value={activeProvider} onChange={(e) => setActiveProvider(e.target.value)}>
                {PROVIDERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <div className="row gap-s wrap mt">
              <Button type="submit" variant="primary" loading={busy === 'active'}>Save active connection</Button>
              <Badge tone={ready[activeProvider] ? 'ok' : 'warn'}>{ready[activeProvider] ? 'Ready' : 'Not ready'}</Badge>
            </div>
            {!ready[activeProvider] ? <p className="muted small mt">The selected connection is not ready. Users cannot start campaigns until it is configured and connected.</p> : null}
          </form>
        </Card>

        {activeProvider === 'wa_http' ? <Card title="Vendor HTTP API" actions={<Badge tone={c.ready ? 'ok' : 'warn'}>{c.ready ? 'Ready' : 'Not ready'}</Badge>}>
          <p className="muted small">Vendor credentials are encrypted in the database. A saved key is never returned or shown again.</p>
          {c.readyProblem ? <Alert tone={c.ready ? 'info' : 'warn'}>{c.readyProblem}</Alert> : null}
          {c.baseUrl.toLowerCase().startsWith('http://') ? <Alert tone="warn">This vendor URL uses unencrypted HTTP; use HTTPS if the vendor supports it.</Alert> : null}
          <form onSubmit={saveVendor}>
            <div className="form-grid">
              <Field label="Provider label"><input value={vendor.providerName} onChange={(e) => setVendorField('providerName', e.target.value)} maxLength={80} /></Field>
              <Field label="API key" hint={c.hasApiKey ? 'A key is saved. Leave blank to keep it.' : 'Stored encrypted; never shown again.'}><input type="password" autoComplete="new-password" value={vendor.apiKey} onChange={(e) => setVendorField('apiKey', e.target.value)} /></Field>
              <Field label="Base URL" required><input value={vendor.baseUrl} onChange={(e) => setVendorField('baseUrl', e.target.value)} placeholder="https://api.vendor.com/send" maxLength={1000} /></Field>
              <Field label="Method"><select value={vendor.method} onChange={(e) => setVendorField('method', e.target.value)}><option>GET</option><option>POST</option></select></Field>
              <Field label="Content type"><select value={vendor.contentType} onChange={(e) => setVendorField('contentType', e.target.value)}><option value="query">Query parameters</option><option value="json">JSON</option><option value="form">Form URL-encoded</option></select></Field>
              <Field label="Country value"><input value={vendor.country} onChange={(e) => setVendorField('country', e.target.value)} maxLength={10} /></Field>
              <Field label="Mobile format"><select value={vendor.mobileFormat} onChange={(e) => setVendorField('mobileFormat', e.target.value)}><option value="national">National</option><option value="international">International</option></select></Field>
              {['apikey', 'mobile', 'msg', 'country', 'pdf', 'img1', 'img2'].map((key) => (
                <Field key={key} label={`${key} parameter`}><input value={vendor.paramNames[key] || ''} onChange={(e) => setParam(key, e.target.value)} maxLength={80} /></Field>
              ))}
              <Field label="Success response path"><input value={vendor.successPath} onChange={(e) => setVendorField('successPath', e.target.value)} placeholder="status" maxLength={100} /></Field>
              <Field label="Expected success value"><input value={vendor.successValue} onChange={(e) => setVendorField('successValue', e.target.value)} placeholder="success" maxLength={100} /></Field>
              <Field label="Message ID path"><input value={vendor.messageIdPath} onChange={(e) => setVendorField('messageIdPath', e.target.value)} placeholder="data.message_id" maxLength={100} /></Field>
            </div>
            <div className="row gap-s wrap mt">
              <Button type="submit" variant="primary" loading={busy === 'vendor'}>Save vendor settings</Button>
              <Button onClick={() => api.post('/admin/wa-api/preset/wtap').then(() => { toast.success('wtap preset loaded; add the API key and save.'); reload(); }).catch(toast.error)} disabled={Boolean(busy)}>Load sms4power/wtap preset</Button>
              <Button onClick={() => testConnection('wa_http')} loading={busy === 'test-wa_http'}>Test connection</Button>
            </div>
          </form>
        </Card> : null}

        {activeProvider === 'meta' ? <Card title="Meta Cloud API" actions={<Badge tone={c.meta.status === 'connected' ? 'ok' : 'warn'}>{c.meta.status === 'connected' ? 'Connected' : c.metaReady ? 'Configured' : 'Not ready'}</Badge>}>
          <p className="muted small">One phone number and WABA are shared by all tenants. Secrets are encrypted and never returned.</p>
          <form onSubmit={saveMeta}>
            <div className="form-grid">
              <Field label="Phone number ID"><input value={meta.phoneNumberId} onChange={(e) => setMeta({ ...meta, phoneNumberId: e.target.value })} maxLength={80} /></Field>
              <Field label="WABA ID"><input value={meta.wabaId} onChange={(e) => setMeta({ ...meta, wabaId: e.target.value })} maxLength={80} /></Field>
              <Field label="App ID"><input value={meta.appId} onChange={(e) => setMeta({ ...meta, appId: e.target.value })} maxLength={80} /></Field>
              <Field label="Graph API version"><input value={meta.graphVersion} onChange={(e) => setMeta({ ...meta, graphVersion: e.target.value })} maxLength={20} /></Field>
              <Field label="Access token" hint={c.meta.hasAccessToken ? 'Token saved; leave blank to keep it.' : 'Stored encrypted.'}><input type="password" autoComplete="new-password" value={meta.accessToken} onChange={(e) => setMeta({ ...meta, accessToken: e.target.value })} /></Field>
              <Field label="App secret" hint={c.meta.hasAppSecret ? 'Secret saved; leave blank to keep it.' : 'Stored encrypted.'}><input type="password" autoComplete="new-password" value={meta.appSecret} onChange={(e) => setMeta({ ...meta, appSecret: e.target.value })} /></Field>
              <Field label="Webhook verify token" hint={c.meta.hasVerifyToken ? 'Token saved; leave blank to keep it.' : 'Stored encrypted.'}><input type="password" autoComplete="new-password" value={meta.verifyToken} onChange={(e) => setMeta({ ...meta, verifyToken: e.target.value })} /></Field>
            </div>
            <p className="muted small">Webhook URL: <code>{res.data.webhookUrl}</code></p>
            <div className="row gap-s wrap">
              <Button type="submit" variant="primary" loading={busy === 'meta'}>Save Meta settings</Button>
              <Button onClick={() => testConnection('meta')} loading={busy === 'test-meta'}>Test connection</Button>
            </div>
          </form>
          {c.meta.lastError ? <div className="mt"><Alert tone="danger">{c.meta.lastError}</Alert></div> : null}
        </Card> : null}

        {activeProvider === 'qr' ? <QRPanel refreshConfig={reload} /> : null}
        {activeProvider === 'mock' ? (
          <Card title="Test mode">
            <Alert tone="info">Messages are simulated. No WhatsApp connection or additional settings are required.</Alert>
          </Card>
        ) : null}

        <Card title="Send test message">
          {!c.allowRealSend ? <Alert tone="warn">Real sending is disabled by <code>ALLOW_REAL_SEND</code> on this server.</Alert> : null}
          <form onSubmit={sendTest}>
            <div className="form-grid">
              <Field label="Destination number" hint="Include country code"><input value={testNumber} onChange={(e) => setTestNumber(e.target.value)} placeholder="919876543210" /></Field>
              <Field label="Message"><input value={testText} onChange={(e) => setTestText(e.target.value)} maxLength={4096} /></Field>
            </div>
            <Button type="submit" variant="primary" loading={busy === 'send'} disabled={(activeProvider !== 'mock' && (!c.allowRealSend || !ready[activeProvider])) || !testNumber.trim()}>Send test message</Button>
          </form>
          {result ? <pre className="mono small mt" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(result, null, 2)}</pre> : null}
        </Card>
      </div>
    </>
  );
}
