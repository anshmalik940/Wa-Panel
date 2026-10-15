import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useApi, useDocumentTitle } from '../../hooks.js';
import { excludedReasonText, fmtNumber, toLocalInput } from '../../format.js';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, IssueList, PageHeader, Spinner, useToast } from '../../components/ui.jsx';
import { MediaPreview, UploadBox } from '../../components/Media.jsx';
import { ContactPicker } from './CampaignForm.jsx';

const newKey = () => (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** Create / edit a call (voice) campaign: caller ID, what is played or spoken, who is called, and when. */
export default function VoiceCampaignForm() {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const editingExisting = Boolean(routeId);
  useDocumentTitle(editingExisting ? 'Edit call campaign' : 'New call campaign');

  const submissionKey = useRef(newKey());
  const [campaignId, setCampaignId] = useState(routeId || '');
  const [name, setName] = useState('');
  const [cliNumberId, setCliNumberId] = useState('');
  const [audioId, setAudioId] = useState('');
  const [text, setText] = useState('');
  const [mode, setMode] = useState('groups');
  const [groupSel, setGroupSel] = useState([]);
  const [contactSel, setContactSel] = useState({});
  const [scheduledAt, setScheduledAt] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [issues, setIssues] = useState([]);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState('');
  const [loadedOnce, setLoadedOnce] = useState(!editingExisting);
  const [loadError, setLoadError] = useState(null);

  const info = useApi(() => api.get('/c/voice'), []);
  const groups = useApi(() => api.get('/c/contacts/groups'), []);
  const audios = useApi(() => api.get('/c/media', { kind: 'audio', limit: 100 }), []);
  const audioList = audios.data ? audios.data.data : [];
  const audio = audioList.find((m) => m.id === audioId) || null;
  const clis = info.data ? info.data.clis : [];

  useEffect(() => {
    if (!routeId) return undefined;
    let alive = true;
    (async () => {
      try {
        const { campaign: c } = await api.get(`/c/campaigns/${routeId}`);
        if (!alive) return;
        if (c.channel !== 'voice') {
          navigate(`/app/campaigns/${routeId}/edit`, { replace: true });
          return;
        }
        if (!['draft', 'scheduled'].includes(c.status)) {
          toast.info('Only draft or scheduled campaigns can be edited.');
          navigate(`/app/campaigns/${routeId}`, { replace: true });
          return;
        }
        setName(c.name);
        setCliNumberId((c.voice && c.voice.cliNumberId) || '');
        setAudioId((c.voice && c.voice.audioMediaId) || '');
        setText((c.voice && c.voice.text) || '');
        setMode(c.audience.mode);
        setGroupSel(c.audience.groups || []);
        setScheduledAt(c.scheduledAt ? toLocalInput(c.scheduledAt) : '');
        const ids = c.audience.contactIds || [];
        const labels = {};
        ids.forEach((cid) => { labels[cid] = 'Contact'; });
        await Promise.all(ids.slice(0, 40).map((cid) => api.get(`/c/contacts/${cid}`).then((r) => { labels[cid] = r.contact.name || r.contact.phone; }).catch(() => {})));
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

  const buildBody = () => ({
    name: name.trim(),
    cliNumberId: cliNumberId || null,
    audioMediaId: audioId || null,
    text: text.trim(),
    audience: { mode, groups: mode === 'groups' ? groupSel : [], contactIds: mode === 'contacts' ? Object.keys(contactSel) : [] },
    scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
  });

  const localProblems = () => {
    const errs = {};
    if (!name.trim()) errs.name = 'Give the campaign a name';
    if (mode === 'groups' && !groupSel.length) errs.audience = 'Select at least one group';
    if (mode === 'contacts' && !Object.keys(contactSel).length) errs.audience = 'Select at least one contact';
    return errs;
  };

  const persist = async () => {
    const body = buildBody();
    if (campaignId) {
      const r = await api.patch(`/c/voice/campaigns/${campaignId}`, body);
      return r.campaign;
    }
    const r = await api.post('/c/voice/campaigns', { ...body, submissionKey: submissionKey.current });
    setCampaignId(r.campaign._id);
    return r.campaign;
  };

  const handleError = (err) => {
    setFieldErrors(err.fields || {});
    setIssues(err.issues || []);
    toast.error(err);
  };

  const guarded = async (kind, fn) => {
    const errs = localProblems();
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(kind);
    setIssues([]);
    try {
      await fn();
    } catch (err) {
      handleError(err);
    } finally {
      setBusy('');
    }
  };

  const saveDraft = () => guarded('save', async () => { await persist(); toast.success('Draft saved'); });

  const check = () =>
    guarded('validate', async () => {
      const c = await persist();
      const r = await api.post(`/c/campaigns/${c._id}/validate`);
      setReport(r);
      setIssues(r.issues);
      if (r.ok) toast.success('Campaign is ready to start');
    });

  const start = () =>
    guarded('start', async () => {
      const c = await persist();
      await api.post(`/c/campaigns/${c._id}/start`);
      toast.success('Calling started');
      navigate(`/app/campaigns/${c._id}`);
    });

  const schedule = async () => {
    if (!scheduledAt) {
      setFieldErrors({ scheduledAt: 'Pick a date and time' });
      return;
    }
    if (new Date(scheduledAt).getTime() <= Date.now() + 5000) {
      setFieldErrors({ scheduledAt: 'Choose a time in the future' });
      return;
    }
    await guarded('schedule', async () => {
      const c = await persist();
      await api.post(`/c/campaigns/${c._id}/schedule`, { scheduledAt: new Date(scheduledAt).toISOString() });
      toast.success('Calling scheduled');
      navigate(`/app/campaigns/${c._id}`);
    });
  };

  if (loadError) {
    return (
      <>
        <PageHeader title="Edit call campaign" actions={<Link className="btn" to="/app/voice">← Call campaigns</Link>} />
        <ErrorState error={loadError} />
      </>
    );
  }
  if (!loadedOnce || (info.loading && !info.data)) return <Spinner />;
  if (info.error) return <ErrorState error={info.error} onRetry={info.reload} />;

  const provider = info.data.provider;
  const cost = info.data.creditsPerCall;
  const busyAny = Boolean(busy);

  return (
    <>
      <PageHeader
        title={editingExisting ? 'Edit call campaign' : 'New call campaign'}
        subtitle="Choose the caller ID and what the person hears, pick who to call, then start now or schedule it."
        actions={<Link className="btn" to="/app/voice">← Call campaigns</Link>}
      />

      {provider.mode === 'mock' ? (
        <Alert tone="info" title="Simulated calls">Calling runs in mock mode: no phone rings and no credits are used. Your administrator switches to the real API.</Alert>
      ) : !provider.ready ? (
        <Alert tone="warn" title="Calling is not ready">{provider.problem || 'The calling API is not configured yet.'} Ask your administrator.</Alert>
      ) : (
        <Alert tone="info" title="Real calls">Each call uses {fmtNumber(cost)} credit{cost === 1 ? '' : 's'}. Your balance: <strong>{fmtNumber(user.credits || 0)}</strong> credits.</Alert>
      )}

      <Card title="1. Basics">
        <Field label="Campaign name" error={fieldErrors.name} required>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Payment reminder — October" />
        </Field>
        <Field label="Caller ID (CLI)" error={fieldErrors.cliNumberId} hint="The number shown to the person you call" required>
          <select value={cliNumberId} onChange={(e) => { setCliNumberId(e.target.value); setReport(null); }}>
            <option value="">— choose a caller ID —</option>
            {clis.map((c) => <option key={c.id} value={c.id}>{c.number}{c.label ? ` — ${c.label}` : ''}</option>)}
          </select>
        </Field>
        {!clis.length ? <Alert tone="warn" title="No caller ID available to you">Ask your administrator or reseller to add a CLI number and assign it to you.</Alert> : null}
      </Card>

      <div className="mt" />
      <Card title="2. What the person hears">
        <p className="muted small">Play a recorded audio file, speak text, or both (what your calling vendor supports decides how each is used).</p>
        <Field label="Audio file" error={fieldErrors.audioMediaId} hint="Choose one you uploaded before, or upload a new one below">
          <select value={audioId} onChange={(e) => { setAudioId(e.target.value); setReport(null); }}>
            <option value="">No audio file</option>
            {audioList.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        {audio ? <div className="mb"><MediaPreview media={audio} /></div> : null}
        <UploadBox kind="audio" compact onUploaded={(m) => { audios.reload({ silent: true }); setAudioId(m.id); setReport(null); toast.success('Audio uploaded'); }} />
        <div className="mt" />
        <Field label="Text to speak (optional)" error={fieldErrors.text} hint="Up to 1000 characters. Use {{name}} style personalisation only if your vendor template does.">
          <textarea rows={3} value={text} onChange={(e) => { setText(e.target.value); setReport(null); }} maxLength={1000} />
        </Field>
      </Card>

      <div className="mt" />
      <Card title="3. Who should be called?">
        <div className="row gap-m wrap mb">
          {[['groups', 'Contact groups'], ['all', 'All contacts'], ['contacts', 'Pick contacts']].map(([v, l]) => (
            <label className="check" key={v}>
              <input type="radio" name="vmode" checked={mode === v} onChange={() => { setMode(v); setFieldErrors({}); setReport(null); }} /> {l}
            </label>
          ))}
        </div>
        {mode === 'all' ? <Alert tone="info">Every contact is considered. Opted-out contacts and invalid numbers are excluded automatically.</Alert> : null}
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

      <div className="mt" />
      <Card title="4. Check and start">
        <IssueList issues={issues} />
        {report && report.ok ? <Alert tone="ok" title="Ready to start">All checks passed.</Alert> : null}
        {report && report.summary ? (
          <>
            <div className="grid grid-3 mb">
              <div className="stat"><div className="stat-label">In audience</div><div className="stat-value">{fmtNumber(report.summary.audienceSize)}</div></div>
              <div className="stat stat-ok"><div className="stat-label">Will be called</div><div className="stat-value">{fmtNumber(report.summary.eligible)}</div></div>
              <div className="stat"><div className="stat-label">Excluded</div><div className="stat-value">{fmtNumber(report.summary.audienceSize - report.summary.eligible)}</div></div>
            </div>
            {Object.keys(report.summary.excluded).length ? (
              <p className="small muted">Excluded because: {Object.entries(report.summary.excluded).map(([k, n]) => `${excludedReasonText(k)} (${n})`).join(' · ')}</p>
            ) : null}
          </>
        ) : (
          <p className="muted">Press “Check campaign” to see how many people will be called before you start.</p>
        )}
        <div className="form-grid">
          <Field label="Schedule for (optional)" error={fieldErrors.scheduledAt} hint="Your local time. Leave empty to start immediately.">
            <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          </Field>
        </div>
        <div className="row gap-s wrap">
          <Button onClick={saveDraft} loading={busy === 'save'} disabled={busyAny && busy !== 'save'}>Save draft</Button>
          <Button onClick={check} loading={busy === 'validate'} disabled={busyAny && busy !== 'validate'}>Check campaign</Button>
          <Button variant="primary" onClick={start} loading={busy === 'start'} disabled={busyAny && busy !== 'start'}>Start now</Button>
          <Button onClick={schedule} loading={busy === 'schedule'} disabled={busyAny && busy !== 'schedule'}>Schedule</Button>
        </div>
      </Card>
    </>
  );
}
