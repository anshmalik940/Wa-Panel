import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi, useDebounced, useDocumentTitle } from '../../hooks.js';
import { fmtNumber, excludedReasonText, toLocalInput } from '../../format.js';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, IssueList, PageHeader, Pagination, SearchBox, Spinner, useToast } from '../../components/ui.jsx';
import { MediaPreview } from '../../components/Media.jsx';
import { TemplatePreview } from './Templates.jsx';

const STEPS = ['Basics', 'Audience', 'Personalise', 'Review & send'];
const BASE_FIELDS = [
  ['first_name', 'First name'],
  ['name', 'Full name'],
  ['phone', 'Phone number'],
  ['email', 'Email'],
];
const newKey = () => (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** variableMap entry <-> editor state */
function entryToEditor(e) {
  if (!e) return { source: 'field', field: 'first_name', custom: '', fallback: '', value: '' };
  if (e.source === 'fixed') return { source: 'fixed', field: 'first_name', custom: '', fallback: '', value: e.value || '' };
  const isBase = BASE_FIELDS.some(([k]) => k === e.field);
  return { source: 'field', field: isBase ? e.field : 'custom', custom: isBase ? '' : String(e.field || '').replace(/^attr:/, ''), fallback: e.fallback || '', value: '' };
}
function editorToEntry(ed) {
  if (ed.source === 'fixed') return { source: 'fixed', value: ed.value.trim() };
  const field = ed.field === 'custom' ? `attr:${ed.custom.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')}` : ed.field;
  const out = { source: 'field', field };
  if (ed.fallback.trim()) out.fallback = ed.fallback.trim();
  return out;
}

export function ContactPicker({ selected, setSelected }) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  const list = useApi(() => api.get('/c/contacts', { q: dq, status: 'valid', page, limit: 10 }), [dq, page]);
  const rows = list.data ? list.data.data : [];
  const toggle = (c) =>
    setSelected((m) => {
      const n = { ...m };
      if (n[c._id]) delete n[c._id];
      else n[c._id] = c.name || c.phone;
      return n;
    });
  const ids = Object.keys(selected);
  return (
    <div>
      <div className="toolbar" style={{ padding: '0 0 10px', border: 0 }}>
        <SearchBox value={q} onChange={(x) => { setQ(x); setPage(1); }} placeholder="Search contacts to add…" />
        <Button size="sm" onClick={() => setSelected((m) => { const n = { ...m }; rows.forEach((c) => { n[c._id] = c.name || c.phone; }); return n; })} disabled={!rows.length}>Select this page</Button>
        <Button size="sm" variant="ghost" onClick={() => setSelected({})} disabled={!ids.length}>Clear selection</Button>
      </div>
      <div className="pick-list">
        {list.loading && !list.data ? <Spinner /> : null}
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
        {list.data && !rows.length ? <EmptyState title="No sendable contacts found" /> : null}
        {rows.map((c) => (
          <label className="pick-item" key={c._id}>
            <input type="checkbox" checked={Boolean(selected[c._id])} onChange={() => toggle(c)} />
            <span className="grow"><strong>{c.name || '(no name)'}</strong> <span className="mono muted">{c.phone}</span></span>
          </label>
        ))}
      </div>
      {list.data ? <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} limit={list.data.limit} onPage={setPage} noun="contacts" /> : null}
      <p className="muted small mt">{ids.length} contact(s) selected. Only contacts that can receive messages are listed here.</p>
    </div>
  );
}

export default function CampaignForm() {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const editingExisting = Boolean(routeId);
  useDocumentTitle(editingExisting ? 'Edit campaign' : 'New campaign');

  const submissionKey = useRef(newKey());
  const [campaignId, setCampaignId] = useState(routeId || '');
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [mode, setMode] = useState('groups');
  const [groupSel, setGroupSel] = useState([]);
  const [contactSel, setContactSel] = useState({});
  const [editors, setEditors] = useState({});
  const [scheduledAt, setScheduledAt] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [issues, setIssues] = useState([]);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState('');
  const [loadedOnce, setLoadedOnce] = useState(!editingExisting);
  const [loadError, setLoadError] = useState(null);

  const templates = useApi(() => api.get('/c/templates', { status: 'approved', limit: 100 }), []);
  const whatsapp = useApi(() => api.get('/c/whatsapp'), []);
  const groups = useApi(() => api.get('/c/contacts/groups'), []);
  const approved = templates.data ? templates.data.data : [];
  const template = approved.find((t) => t._id === templateId) || null;
  const companyApiSelected = whatsapp.data?.connection?.provider === 'wa_http';
  const vars = template ? template.variables : [];

  // load an existing campaign for editing
  useEffect(() => {
    if (!routeId) return undefined;
    let alive = true;
    (async () => {
      try {
        const { campaign: c } = await api.get(`/c/campaigns/${routeId}`);
        if (!alive) return;
        if (!['draft', 'scheduled'].includes(c.status)) {
          toast.info('Only draft or scheduled campaigns can be edited.');
          navigate(`/app/campaigns/${routeId}`, { replace: true });
          return;
        }
        setName(c.name);
        setTemplateId(String(c.templateId));
        setMode(c.audience.mode);
        setGroupSel(c.audience.groups || []);
        setScheduledAt(c.scheduledAt ? toLocalInput(c.scheduledAt) : '');
        const ed = {};
        for (const [k, v] of Object.entries(c.variableMap || {})) ed[k] = entryToEditor(v);
        setEditors(ed);
        const ids = c.audience.contactIds || [];
        const labels = {};
        ids.forEach((cid) => { labels[cid] = 'Contact'; });
        setContactSel(labels);
        // resolve names for (up to) the first 40 selected contacts
        await Promise.all(
          ids.slice(0, 40).map((cid) =>
            api.get(`/c/contacts/${cid}`).then((r) => { labels[cid] = r.contact.name || r.contact.phone; }).catch(() => {}),
          ),
        );
        if (alive) {
          setContactSel({ ...labels });
          setLoadedOnce(true);
        }
      } catch (err) {
        if (alive) setLoadError(err);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  const editorFor = (v) => editors[v] || entryToEditor(null);
  const setEditor = (v, patch) => setEditors((e) => ({ ...e, [v]: { ...editorFor(v), ...patch } }));

  const buildBody = () => {
    const variableMap = {};
    for (const v of vars) variableMap[v] = editorToEntry(editorFor(v));
    const audience = { mode, groups: mode === 'groups' ? groupSel : [], contactIds: mode === 'contacts' ? Object.keys(contactSel) : [] };
    return { name: name.trim(), templateId, audience, variableMap, scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null };
  };

  const localProblems = (upTo) => {
    const errs = {};
    if (upTo >= 0) {
      if (!name.trim()) errs.name = 'Give the campaign a name';
      if (!templateId) errs.templateId = 'Choose an approved template';
    }
    if (upTo >= 1) {
      if (mode === 'groups' && !groupSel.length) errs.audience = 'Select at least one group';
      if (mode === 'contacts' && !Object.keys(contactSel).length) errs.audience = 'Select at least one contact';
    }
    if (upTo >= 2) {
      for (const v of vars) {
        const ed = editorFor(v);
        if (ed.source === 'fixed' && !ed.value.trim()) errs[`var_${v}`] = 'Enter the value to send';
        if (ed.source === 'field' && ed.field === 'custom' && !ed.custom.trim()) errs[`var_${v}`] = 'Enter the name of the contact field';
      }
    }
    return errs;
  };

  /** Creates the campaign on first save (idempotent through submissionKey), updates it afterwards. */
  const persist = async () => {
    const body = buildBody();
    if (campaignId) {
      const r = await api.patch(`/c/campaigns/${campaignId}`, body);
      return r.campaign;
    }
    const r = await api.post('/c/campaigns', { ...body, submissionKey: submissionKey.current });
    setCampaignId(r.campaign._id);
    return r.campaign;
  };

  const handleError = (err) => {
    setFieldErrors(err.fields || {});
    setIssues(err.issues || []);
    toast.error(err);
  };

  const next = () => {
    const errs = localProblems(step);
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    setIssues([]);
    setReport(null);
    setStep((s) => s + 1);
  };

  const saveDraft = async () => {
    const errs = localProblems(1);
    setFieldErrors(errs);
    if (Object.keys(errs).some((k) => k === 'name' || k === 'templateId')) {
      setStep(0);
      return null;
    }
    setBusy('save');
    try {
      const c = await persist();
      toast.success('Draft saved');
      return c;
    } catch (err) {
      handleError(err);
      return null;
    } finally {
      setBusy('');
    }
  };

  const validate = async () => {
    setBusy('validate');
    setIssues([]);
    try {
      const c = await persist();
      const r = await api.post(`/c/campaigns/${c._id}/validate`);
      setReport(r);
      setIssues(r.issues);
      if (r.ok) toast.success('Campaign is ready to send');
    } catch (err) {
      handleError(err);
    } finally {
      setBusy('');
    }
  };

  const start = async () => {
    const errs = localProblems(2);
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy('start');
    setIssues([]);
    try {
      const c = await persist();
      await api.post(`/c/campaigns/${c._id}/start`);
      toast.success('Campaign started');
      navigate(`/app/campaigns/${c._id}`);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy('');
    }
  };

  const schedule = async () => {
    if (!scheduledAt) {
      setFieldErrors({ scheduledAt: 'Pick a date and time' });
      return;
    }
    if (new Date(scheduledAt).getTime() <= Date.now() + 5000) {
      setFieldErrors({ scheduledAt: 'Choose a time in the future' });
      return;
    }
    setBusy('schedule');
    setIssues([]);
    try {
      const c = await persist();
      await api.post(`/c/campaigns/${c._id}/schedule`, { scheduledAt: new Date(scheduledAt).toISOString() });
      toast.success('Campaign scheduled');
      navigate(`/app/campaigns/${c._id}`);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy('');
    }
  };

  // only "same text for everyone" values are known before sending; the rest stay highlighted as placeholders
  const sampleValues = {};
  for (const v of vars) {
    const ed = editorFor(v);
    if (ed.source === 'fixed' && ed.value.trim()) sampleValues[v] = ed.value.trim();
  }

  if (loadError) {
    return (
      <>
        <PageHeader title="Edit campaign" actions={<Link className="btn" to="/app/campaigns">← Campaigns</Link>} />
        <ErrorState error={loadError} />
      </>
    );
  }
  if (!loadedOnce || (templates.loading && !templates.data)) return <Spinner />;
  if (templates.error) return <ErrorState error={templates.error} onRetry={templates.reload} />;

  const busyAny = Boolean(busy);

  return (
    <>
      <PageHeader
        title={editingExisting ? 'Edit campaign' : 'New campaign'}
        subtitle="Four short steps. Nothing is sent until you press “Start now” or schedule it."
        actions={<Link className="btn" to="/app/campaigns">← Campaigns</Link>}
      />
      <div className="steps">
        {STEPS.map((s, i) => (
          <button key={s} className={`step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`} onClick={() => { if (i <= step) setStep(i); }} disabled={i > step} type="button">
            {i < step ? '✓ ' : `${i + 1}. `}{s}
          </button>
        ))}
      </div>

      {step === 0 ? (
        <Card title="Basics">
          <Field label="Campaign name" error={fieldErrors.name} required>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Diwali offer — VIP customers" />
          </Field>
          <Field label="Template" error={fieldErrors.templateId} hint="Only approved templates are listed. Create and submit templates on the Templates page." required>
            <select value={templateId} onChange={(e) => { setTemplateId(e.target.value); setReport(null); }}>
              <option value="">— choose a template —</option>
              {approved.map((t) => <option key={t._id} value={t._id}>{t.name} ({t.language})</option>)}
            </select>
          </Field>
          {!approved.length ? (
            <Alert tone="warn" title="You have no approved templates">
              <Link to="/app/templates">Create a template</Link>, submit it for review and use “Sync status” until it shows as approved.
            </Alert>
          ) : null}
          {template ? <TemplatePreview header={template.header} media={template.media} body={template.body} footer={template.footer} /> : null}
        </Card>
      ) : null}

      {step === 1 ? (
        <Card title="Who should receive it?">
          <div className="row gap-m wrap mb">
            {[['groups', 'Contact groups'], ['all', 'All contacts'], ['contacts', 'Pick contacts']].map(([v, l]) => (
              <label className="check" key={v}>
                <input type="radio" name="mode" checked={mode === v} onChange={() => { setMode(v); setFieldErrors({}); }} /> {l}
              </label>
            ))}
          </div>
          {mode === 'all' ? <Alert tone="info">Every contact in your account is considered. Opted-out contacts, invalid numbers and contacts missing personalisation data are excluded automatically.</Alert> : null}
          {mode === 'groups' ? (
            <>
              {groups.data && !groups.data.groups.length ? <EmptyState title="You have no groups yet">Add contacts to a group on the <Link to="/app/contacts">Contacts</Link> page, or choose “All contacts”.</EmptyState> : null}
              <div className="pick-list">
                {(groups.data ? groups.data.groups : []).map((g) => (
                  <label className="pick-item" key={g.name}>
                    <input type="checkbox" checked={groupSel.includes(g.name)} onChange={(e) => setGroupSel((l) => (e.target.checked ? [...l, g.name] : l.filter((x) => x !== g.name)))} />
                    <span className="grow"><strong>{g.name}</strong></span>
                    <Badge>{fmtNumber(g.count)} contacts</Badge>
                  </label>
                ))}
              </div>
            </>
          ) : null}
          {mode === 'contacts' ? <ContactPicker selected={contactSel} setSelected={setContactSel} /> : null}
          {fieldErrors.audience ? <div className="error-text mt">{fieldErrors.audience}</div> : null}
        </Card>
      ) : null}

      {step === 2 ? (
        <Card title="Personalise the message">
          {!vars.length ? (
            <Alert tone="info">This template has no placeholders, so every recipient gets exactly the same message.</Alert>
          ) : (
            <p className="muted">Choose what goes into each placeholder. A contact with no value (and no fallback) is excluded from the campaign instead of receiving a broken message.</p>
          )}
          {vars.map((v) => {
            const ed = editorFor(v);
            return (
              <div className="card mb" key={v} style={{ padding: 14 }}>
                <div className="row gap-s mb"><span className="var-chip">{`{{${v}}}`}</span></div>
                <div className="form-grid">
                  <Field label="Value comes from">
                    <select value={ed.source} onChange={(e) => setEditor(v, { source: e.target.value })}>
                      <option value="field">A contact field</option>
                      <option value="fixed">The same text for everyone</option>
                    </select>
                  </Field>
                  {ed.source === 'fixed' ? (
                    <Field label="Text" error={fieldErrors[`var_${v}`]}>
                      <input value={ed.value} onChange={(e) => setEditor(v, { value: e.target.value })} maxLength={200} />
                    </Field>
                  ) : (
                    <>
                      <Field label="Contact field" error={fieldErrors[`var_${v}`]}>
                        <select value={ed.field} onChange={(e) => setEditor(v, { field: e.target.value })}>
                          {BASE_FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                          <option value="custom">Custom field (from import / contact form)…</option>
                        </select>
                      </Field>
                      {ed.field === 'custom' ? (
                        <Field label="Custom field name" hint="Exactly as it appears on the contact, e.g. city or order_id">
                          <input value={ed.custom} onChange={(e) => setEditor(v, { custom: e.target.value })} maxLength={30} />
                        </Field>
                      ) : null}
                      <Field label="Fallback if empty (optional)" hint="e.g. “Customer”">
                        <input value={ed.fallback} onChange={(e) => setEditor(v, { fallback: e.target.value })} maxLength={100} />
                      </Field>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {template ? (
            <>
              <div className="small muted mb" style={{ fontWeight: 600 }}>Message layout</div>
              <TemplatePreview header={template.header} media={template.media} body={template.body} footer={template.footer} values={sampleValues} />
            </>
          ) : null}
        </Card>
      ) : null}

      {step === 3 ? (
        <>
          <Card title="Review">
            {companyApiSelected ? <Alert tone="warn">Add your own opt-out instruction in the message. This provider does not receive STOP replies; contacts must be opted out manually.</Alert> : null}
            <dl className="kv mb">
              <dt>Name</dt><dd>{name}</dd>
              <dt>Template</dt><dd>{template ? template.name : '—'}</dd>
              <dt>Audience</dt>
              <dd>{mode === 'all' ? 'All contacts' : mode === 'groups' ? `Groups: ${groupSel.join(', ')}` : `${Object.keys(contactSel).length} selected contact(s)`}</dd>
            </dl>
            <IssueList issues={issues} />
            {report && report.ok ? <Alert tone="ok" title="Ready to send">All checks passed.</Alert> : null}
            {report && report.summary ? (
              <>
                <div className="grid grid-3 mb">
                  <div className="stat"><div className="stat-label">In audience</div><div className="stat-value">{fmtNumber(report.summary.audienceSize)}</div></div>
                  <div className="stat stat-ok"><div className="stat-label">Will be sent</div><div className="stat-value">{fmtNumber(report.summary.eligible)}</div></div>
                  <div className="stat"><div className="stat-label">Excluded</div><div className="stat-value">{fmtNumber(report.summary.audienceSize - report.summary.eligible)}</div></div>
                </div>
                {Object.keys(report.summary.excluded).length ? (
                  <p className="small muted">Excluded because: {Object.entries(report.summary.excluded).map(([k, n]) => `${excludedReasonText(k)} (${n})`).join(' · ')}</p>
                ) : null}
                {report.summary.samples.length ? (
                  <>
                    <div className="small muted mb" style={{ fontWeight: 600 }}>Sample messages</div>
                    <div className="col gap-s">
                      {report.summary.samples.map((s, i) => (
                        <div key={i}>
                          <div className="small muted">To {s.name || 'contact'} · <span className="mono">{s.phone}</span></div>
                          <div className="phone-preview"><div className="bubble">{template && template.media ? <div className="b-media"><MediaPreview media={template.media} /></div> : null}{s.text}</div></div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
              </>
            ) : (
              <p className="muted">Press “Check campaign” to see how many people will receive it and a preview of the personalised messages.</p>
            )}
          </Card>
          <div className="mt" />
          <Card title="When to send">
            <div className="form-grid">
              <Field label="Schedule for (optional)" error={fieldErrors.scheduledAt} hint="Your local time. Leave empty to send immediately.">
                <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
              </Field>
            </div>
            <div className="row gap-s wrap">
              <Button onClick={validate} loading={busy === 'validate'} disabled={busyAny && busy !== 'validate'}>Check campaign</Button>
              <Button variant="primary" onClick={start} loading={busy === 'start'} disabled={busyAny && busy !== 'start'}>Start now</Button>
              <Button onClick={schedule} loading={busy === 'schedule'} disabled={busyAny && busy !== 'schedule'}>Schedule</Button>
            </div>
          </Card>
        </>
      ) : null}

      {step !== 3 && issues.length ? <div className="mt"><IssueList issues={issues} /></div> : null}
      {Object.keys(fieldErrors).length && step === 3 && !fieldErrors.scheduledAt ? <Alert tone="danger">{Object.values(fieldErrors).filter(Boolean).join(' · ')}</Alert> : null}

      <div className="row between mt">
        <div className="row gap-s">
          {step > 0 ? <Button onClick={() => { setStep((s) => s - 1); setFieldErrors({}); }} disabled={busyAny}>← Back</Button> : null}
        </div>
        <div className="row gap-s">
          <Button onClick={saveDraft} loading={busy === 'save'} disabled={busyAny && busy !== 'save'}>Save draft</Button>
          {step < 3 ? <Button variant="primary" onClick={next}>Next →</Button> : null}
        </div>
      </div>
    </>
  );
}
