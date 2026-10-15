import { useState } from 'react';
import { api } from '../../api.js';
import { useApi, useDocumentTitle, useForm } from '../../hooks.js';
import { Alert, Badge, Button, Card, CopyButton, DataTable, EmptyState, ErrorState, Field, Modal, PageHeader, Spinner, StatusBadge, useConfirm, useToast } from '../../components/ui.jsx';

const PLACEHOLDERS = [
  ['{{to}}', 'number being called, digits only (919876543210)'],
  ['{{to_plus}}', 'number being called with +'],
  ['{{cli}}', 'caller ID (CLI) shown to the person called'],
  ['{{audio_url}}', 'public link of the audio file to play'],
  ['{{text}}', 'text to speak (if the campaign has text)'],
  ['{{name}}', 'contact name'],
  ['{{message_id}}', 'our unique id for this call (use as your reference)'],
  ['{{campaign_id}}', 'campaign id'],
  ['{{apiKey}}', 'the API key above (headers only)'],
];

function ProviderCard({ config, onSaved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const form = useForm({
    mode: config.mode,
    providerName: config.providerName,
    apiUrl: config.apiUrl,
    method: config.method,
    contentType: config.contentType,
    headersTemplate: config.headersTemplate,
    bodyTemplate: config.bodyTemplate,
    callIdPath: config.callIdPath,
    successPath: config.successPath,
    successValue: config.successValue,
    apiKey: '',
    clearApiKey: false,
    regenerateWebhookToken: false,
  });
  const v = form.values;
  const real = v.mode === 'http';

  const submit = async (e) => {
    e.preventDefault();
    const errs = {};
    if (real && !/^https?:\/\/\S+$/i.test(v.apiUrl.trim())) errs.apiUrl = 'Enter the vendor API URL, starting with http:// or https://';
    for (const k of ['headersTemplate', 'bodyTemplate']) {
      try {
        const o = JSON.parse(v[k].replace(/\{\{\s*[a-zA-Z_]+\s*\}\}/g, 'x'));
        if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('not an object');
      } catch {
        errs[k] = 'Must be a JSON object, e.g. {"to": "{{to}}"}';
      }
    }
    form.setErrors(errs);
    if (Object.keys(errs).length) return;
    const body = {
      mode: v.mode,
      providerName: v.providerName.trim(),
      apiUrl: v.apiUrl.trim(),
      method: v.method,
      contentType: v.contentType,
      headersTemplate: v.headersTemplate,
      bodyTemplate: v.bodyTemplate,
      callIdPath: v.callIdPath.trim(),
      successPath: v.successPath.trim(),
      successValue: v.successValue.trim(),
    };
    if (v.apiKey.trim()) body.apiKey = v.apiKey.trim();
    if (v.clearApiKey) body.clearApiKey = true;
    if (v.regenerateWebhookToken) body.regenerateWebhookToken = true;
    setBusy(true);
    try {
      const r = await api.put('/admin/voice', body);
      toast.success(r.config.mode === 'http' ? 'Saved. Real calling is now selected.' : 'Saved. Calls are simulated (mock mode).');
      form.set('apiKey', '');
      form.set('clearApiKey', false);
      form.set('regenerateWebhookToken', false);
      onSaved();
    } catch (err) {
      form.setErrors(err.fields || {});
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Calling API (voice provider)">
      <form onSubmit={submit} noValidate>
        {real ? (
          <Alert tone={config.ready ? 'ok' : 'warn'} title={config.ready ? 'Real calling is selected' : 'Real calling is selected but not ready'}>
            {config.ready ? (config.allowRealSend ? 'Customers\' voice campaigns will place real calls through your vendor and use credits.' : 'The server has ALLOW_REAL_SEND=false in .env, so no real call will be placed until you set it to true and restart.') : config.readyProblem}
          </Alert>
        ) : (
          <Alert tone="info" title="Mock mode">Calls are simulated and free; nothing is dialled. Fill in your vendor’s details below, press Save, then choose “Real API”.</Alert>
        )}
        <div className="form-grid mt">
          <Field label="Mode">
            <select {...form.bind('mode')}>
              <option value="mock">Mock — simulate calls (no vendor needed)</option>
              <option value="http">Real API — call through my vendor</option>
            </select>
          </Field>
          <Field label="Vendor name (for your reference)">
            <input {...form.bind('providerName')} maxLength={80} placeholder="e.g. My telecom vendor" />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="API URL" error={form.errors.apiUrl} hint="The vendor’s “make a call” endpoint" required={real}>
            <input {...form.bind('apiUrl')} maxLength={500} placeholder="https://api.vendor.com/v1/calls" />
          </Field>
          <Field label="API key / token" hint={config.hasApiKey ? 'A key is saved (hidden). Type a new one only to replace it.' : 'Stored encrypted; never shown again'}>
            <input type="password" autoComplete="new-password" {...form.bind('apiKey')} placeholder={config.hasApiKey ? '•••••••• saved' : 'Paste the key'} />
          </Field>
        </div>
        {config.hasApiKey ? (
          <label className="check mb">
            <input type="checkbox" checked={v.clearApiKey} onChange={(e) => form.set('clearApiKey', e.target.checked)} /> Remove the saved key when saving
          </label>
        ) : null}
        <div className="form-grid">
          <Field label="HTTP method">
            <select {...form.bind('method')}>
              <option value="POST">POST</option>
              <option value="GET">GET (values go in the URL)</option>
            </select>
          </Field>
          <Field label="Send body as">
            <select {...form.bind('contentType')}>
              <option value="json">JSON</option>
              <option value="form">Form (x-www-form-urlencoded)</option>
            </select>
          </Field>
        </div>
        <Field label="Headers (JSON)" error={form.errors.headersTemplate} hint="Most vendors want an Authorization header. {{apiKey}} is replaced by the key above.">
          <textarea className="mono" rows={3} {...form.bind('headersTemplate')} spellCheck={false} />
        </Field>
        <Field label="Request body (JSON)" error={form.errors.bodyTemplate} hint="Rename the left-hand names to whatever your vendor expects. Placeholders are filled for every call.">
          <textarea className="mono" rows={6} {...form.bind('bodyTemplate')} spellCheck={false} />
        </Field>
        <div className="form-grid">
          <Field label="Call id in the response" hint="Where the vendor puts the call id, e.g. call_id or data.id. Used to match status callbacks.">
            <input {...form.bind('callIdPath')} maxLength={100} />
          </Field>
          <div />
        </div>
        <div className="form-grid">
          <Field label="Success field (optional)" hint="If the vendor always answers HTTP 200, name the field that says success, e.g. status">
            <input {...form.bind('successPath')} maxLength={100} />
          </Field>
          <Field label="Success value" hint="e.g. success">
            <input {...form.bind('successValue')} maxLength={100} />
          </Field>
        </div>
        <details className="mb">
          <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>Placeholders you can use in headers and body</summary>
          <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {PLACEHOLDERS.map(([k, d]) => (
              <li key={k}>
                <code>{k}</code> — {d}
              </li>
            ))}
          </ul>
        </details>
        <Button type="submit" variant="primary" loading={busy}>
          Save calling settings
        </Button>
      </form>
    </Card>
  );
}

function WebhookCard({ config, onSaved }) {
  const toast = useToast();
  const confirm = useConfirm();
  const regen = () =>
    confirm({
      title: 'Create a new callback URL?',
      message: 'The old URL stops working immediately. Update it at your vendor afterwards.',
      confirmText: 'Create new URL',
      onConfirm: async () => {
        try {
          await api.put('/admin/voice', { regenerateWebhookToken: true });
          toast.success('New callback URL created');
          onSaved();
        } catch (err) {
          toast.error(err);
          throw err;
        }
      },
    });
  return (
    <Card title="Call status callback (optional)">
      <p className="muted small">Give this URL to your vendor so it can report how each call ended. It should POST JSON such as <code>{'{"call_id": "...", "status": "answered"}'}</code> (statuses like answered, completed, busy, no_answer, failed are understood). Each update is applied once.</p>
      <div className="row gap-s">
        <input readOnly value={config.webhookUrl} className="mono grow" onFocus={(e) => e.target.select()} aria-label="Voice callback URL" />
        <CopyButton text={config.webhookUrl} />
      </div>
      <div className="mt">
        <Button size="sm" onClick={regen}>Create a new URL</Button>
      </div>
    </Card>
  );
}

function TestCallCard({ config, clis }) {
  const toast = useToast();
  const form = useForm({ to: '', cliNumberId: '', text: 'This is a test call from the campaign panel.', audioUrl: '' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const active = clis.filter((c) => c.status === 'active');

  const submit = async (e) => {
    e.preventDefault();
    const v = form.values;
    const to = v.to.replace(/[\s()+-]/g, '');
    if (!/^\d{8,15}$/.test(to)) {
      form.setErrors({ to: 'Enter the number with country code, digits only, e.g. 919876543210' });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const body = { to, text: v.text.trim() || undefined, audioUrl: v.audioUrl.trim() || undefined };
      if (v.cliNumberId) body.cliNumberId = v.cliNumberId;
      const r = await api.post('/admin/voice/test', body);
      setResult({ ok: true, ...r });
      toast.success(r.simulated ? 'Simulated (mock) — no real call placed' : 'Vendor accepted the test call');
    } catch (err) {
      form.setErrors(err.fields || {});
      setResult({ ok: false, message: err.message });
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Place a test call">
      <p className="muted small">{config.mode === 'http' ? 'Calls ONE number you are allowed to call through your real vendor, using the settings saved above.' : 'Mock mode: this only simulates the call. Switch to Real API to test your vendor.'}</p>
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Number to call" error={form.errors.to} required>
            <input inputMode="numeric" {...form.bind('to')} placeholder="919876543210" />
          </Field>
          <Field label="Caller ID (CLI)" error={form.errors.cliNumberId} hint={active.length ? 'Leave as is to use the first active CLI' : 'Add a CLI number first'}>
            <select {...form.bind('cliNumberId')}>
              <option value="">First active CLI</option>
              {active.map((c) => <option key={c._id} value={c._id}>{c.number}{c.label ? ` — ${c.label}` : ''}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Text to speak">
          <input {...form.bind('text')} maxLength={300} />
        </Field>
        <Field label="Audio URL (optional)" hint="A public link to an mp3/wav, if your vendor plays audio">
          <input {...form.bind('audioUrl')} maxLength={500} placeholder="https://…" />
        </Field>
        <Button type="submit" variant="primary" loading={busy}>
          {config.mode === 'http' ? 'Place test call' : 'Run mock test'}
        </Button>
      </form>
      {result ? (
        <div className="mt">
          {result.ok ? (
            <Alert tone="ok" title={result.simulated ? 'Simulated' : 'Accepted by the vendor'}>
              {result.message || (result.providerMessageId ? `Call id: ${result.providerMessageId}` : 'No call id was returned (check the “Call id in the response” setting).')}
            </Alert>
          ) : (
            <Alert tone="danger" title="Test call failed">{result.message}</Alert>
          )}
          {result.ok && result.response ? <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>{JSON.stringify(result.response, null, 2)}</pre> : null}
        </div>
      ) : null}
    </Card>
  );
}

function CliModal({ open, onClose, onSaved, cli, users }) {
  const toast = useToast();
  const editing = Boolean(cli);
  const form = useForm({ number: '', label: '', status: 'active', assignedToId: '' });
  const [busy, setBusy] = useState(false);
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      form.setValues(cli ? { number: cli.number, label: cli.label || '', status: cli.status, assignedToId: cli.assignedToId || '' } : { number: '', label: '', status: 'active', assignedToId: '' });
      form.setErrors({});
    }
  }
  const submit = async (e) => {
    if (e) e.preventDefault();
    const v = form.values;
    const digits = v.number.replace(/[\s()+-]/g, '');
    if (!/^\d{5,15}$/.test(digits)) {
      form.setErrors({ number: 'Enter 5–15 digits, e.g. 919876543210' });
      return;
    }
    const body = { number: digits, label: v.label.trim(), status: v.status, assignedToId: v.assignedToId || null };
    setBusy(true);
    try {
      if (editing) await api.patch(`/admin/voice/cli/${cli._id}`, body);
      else await api.post('/admin/voice/cli', body);
      toast.success(editing ? 'CLI number updated' : 'CLI number added');
      onSaved();
      onClose();
    } catch (err) {
      form.setErrors(err.fields || {});
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={editing ? `Edit ${cli.number}` : 'Add CLI number'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={submit}>{editing ? 'Save changes' : 'Add CLI number'}</Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate>
        <Field label="CLI (caller ID) number" error={form.errors.number} hint="The number the person being called will see, with country code" required>
          <input inputMode="numeric" {...form.bind('number')} placeholder="919876543210" />
        </Field>
        <Field label="Label (optional)" hint="e.g. Sales line">
          <input {...form.bind('label')} maxLength={80} />
        </Field>
        <Field label="Who can use it">
          <select {...form.bind('assignedToId')}>
            <option value="">Everyone (shared)</option>
            {users.resellers.length ? <optgroup label="Resellers (and all their customers)">{users.resellers.map((u) => <option key={u._id} value={u._id}>{u.name} — {u.email}</option>)}</optgroup> : null}
            {users.customers.length ? <optgroup label="Customers">{users.customers.map((u) => <option key={u._id} value={u._id}>{u.name} — {u.email}</option>)}</optgroup> : null}
          </select>
        </Field>
        <Field label="Status">
          <select {...form.bind('status')}>
            <option value="active">Active</option>
            <option value="inactive">Inactive (cannot be chosen for new campaigns)</option>
          </select>
        </Field>
        <button type="submit" className="sr-only" tabIndex={-1}>Save</button>
      </form>
    </Modal>
  );
}

function CliCard({ clis, users, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(undefined); // undefined = closed, null = new, object = edit

  const toggle = async (c) => {
    try {
      await api.patch(`/admin/voice/cli/${c._id}`, { status: c.status === 'active' ? 'inactive' : 'active' });
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };
  const remove = (c) =>
    confirm({
      title: `Delete ${c.number}?`,
      message: 'The CLI number is removed. Finished campaigns keep their report.',
      confirmText: 'Delete',
      danger: true,
      onConfirm: async () => {
        try {
          await api.del(`/admin/voice/cli/${c._id}`);
          toast.success('CLI number deleted');
          onChanged();
        } catch (err) {
          toast.error(err);
          throw err;
        }
      },
    });

  const columns = [
    { key: 'number', header: 'CLI number', render: (c) => <div><strong className="mono">{c.number}</strong>{c.label ? <div className="muted small">{c.label}</div> : null}</div> },
    { key: 'who', header: 'Available to', render: (c) => (c.assignedTo ? <span>{c.assignedTo.name} <Badge>{c.assignedTo.role}</Badge></span> : <span className="muted">Everyone</span>) },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
    {
      key: 'actions',
      header: '',
      className: 'right nowrap',
      render: (c) => (
        <div className="row gap-s" style={{ justifyContent: 'flex-end' }}>
          <Button size="sm" onClick={() => setEditing(c)}>Edit</Button>
          <Button size="sm" onClick={() => toggle(c)}>{c.status === 'active' ? 'Deactivate' : 'Activate'}</Button>
          <Button size="sm" variant="outline-danger" onClick={() => remove(c)}>Delete</Button>
        </div>
      ),
    },
  ];
  return (
    <Card title="CLI (caller ID) numbers" actions={<Button variant="primary" size="sm" onClick={() => setEditing(null)}>+ Add CLI number</Button>} pad={false}>
      <DataTable
        columns={columns}
        rows={clis}
        empty={<EmptyState title="No CLI numbers yet" action={<Button variant="primary" onClick={() => setEditing(null)}>Add the first CLI number</Button>}>A voice campaign needs a caller ID. Add the numbers your vendor has approved for you, and choose who may use each one.</EmptyState>}
      />
      <CliModal open={editing !== undefined} cli={editing || null} users={users} onClose={() => setEditing(undefined)} onSaved={onChanged} />
    </Card>
  );
}

export default function Voice() {
  useDocumentTitle('Calling & CLI');
  const cfg = useApi(() => api.get('/admin/voice'), []);
  const cli = useApi(() => api.get('/admin/voice/cli'), []);
  const users = useApi(
    async () => {
      const [r, c] = await Promise.all([api.get('/admin/resellers', { limit: 100 }), api.get('/admin/customers', { limit: 100 })]);
      return { resellers: r.data, customers: c.data };
    },
    [],
  );
  const reloadAll = () => {
    cfg.reload({ silent: true });
    cli.reload({ silent: true });
  };
  const loading = (cfg.loading && !cfg.data) || (cli.loading && !cli.data);
  const error = cfg.error || cli.error;
  return (
    <>
      <PageHeader title="Calling & CLI" subtitle="Plug in your voice API once; customers and resellers then run call campaigns with the caller ID you give them." />
      {loading ? <Spinner /> : null}
      {error ? <ErrorState error={error} onRetry={reloadAll} /> : null}
      {cfg.data && cli.data ? (
        <div className="col gap-m">
          <ProviderCard key={JSON.stringify(cfg.data.config)} config={cfg.data.config} onSaved={reloadAll} />
          <div className="grid grid-2">
            <TestCallCard config={cfg.data.config} clis={cli.data.data} />
            <WebhookCard config={cfg.data.config} onSaved={reloadAll} />
          </div>
          <CliCard clis={cli.data.data} users={users.data || { resellers: [], customers: [] }} onChanged={reloadAll} />
        </div>
      ) : null}
    </>
  );
}
