import { useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useApi, useDebounced, useDocumentTitle, useForm } from '../../hooks.js';
import { fmtBytes, fmtDate } from '../../format.js';
import { Alert, Button, Card, DataTable, EmptyState, ErrorState, Field, Modal, PageHeader, Pagination, SearchBox, Spinner, StatusBadge, Badge, useConfirm, useToast } from '../../components/ui.jsx';
import { MediaPickerModal, MediaPreview, MediaThumb, UploadBox } from '../../components/Media.jsx';

const LANGS = [
  ['en', 'English'], ['en_US', 'English (US)'], ['en_GB', 'English (UK)'], ['hi', 'Hindi'], ['bn', 'Bengali'], ['mr', 'Marathi'], ['gu', 'Gujarati'],
  ['ta', 'Tamil'], ['te', 'Telugu'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['pa', 'Punjabi'], ['ur', 'Urdu'], ['es', 'Spanish'], ['pt_BR', 'Portuguese (Brazil)'], ['ar', 'Arabic'], ['fr', 'French'], ['de', 'German'], ['id', 'Indonesian'],
];
const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const varsOf = (text) => [...new Set([...String(text || '').matchAll(VAR_RE)].map((m) => m[1].toLowerCase()))];
const blank = { name: '', language: 'en', category: 'MARKETING', header: '', attachmentType: 'none', mediaId: '', extraMediaIds: [], body: '', footer: '' };
const MEDIA_TYPES = ['image', 'video', 'document'];
const attachmentTypeOf = (template) => {
  if (template.attachmentType !== undefined && template.attachmentType !== null) return template.attachmentType;
  return MEDIA_TYPES.includes(template.headerType) ? template.headerType : 'none';
};

/** WhatsApp style preview with placeholders highlighted. */
export function TemplatePreview({ header, media, body, footer, values }) {
  const renderBody = (text) =>
    String(text || '')
      .split(VAR_RE)
      .map((part, i) => (i % 2 === 1 ? (values && values[part.toLowerCase()] ? <span key={i}>{values[part.toLowerCase()]}</span> : <span key={i} className="var-chip">{`{{${part}}}`}</span>) : <span key={i}>{part}</span>));
  return (
    <div className="phone-preview">
      <div className="bubble">
        {media ? <div className="b-media"><MediaPreview media={media} /></div> : null}
        {header ? <div className="b-head">{header}</div> : null}
        {body ? <div>{renderBody(body)}</div> : media ? null : <div><span className="muted">Your message will appear here…</span></div>}
        {footer ? <div className="b-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

function TemplateModal({ open, template, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(template);
  const form = useForm(blank);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [problems, setProblems] = useState([]);
  const [okNote, setOkNote] = useState('');
  const [lastOpen, setLastOpen] = useState(false);
  const [media, setMedia] = useState(null);
  const [extraMedia, setExtraMedia] = useState([]);
  const [picking, setPicking] = useState(false);
  const [addingKind, setAddingKind] = useState('');
  const [lastOpen2, setLastOpen2] = useState(false);
  if (open !== lastOpen2) {
    setLastOpen2(open);
    if (open) {
      setMedia(template && template.media ? template.media : null);
      setExtraMedia(template && template.extraMedia ? template.extraMedia : []);
    }
  }
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      form.setValues(template ? { name: template.name, language: template.language, category: template.category, header: template.header || '', attachmentType: attachmentTypeOf(template), mediaId: template.mediaId ? String(template.mediaId) : '', extraMediaIds: (template.extraMedia || []).map((item) => item.id), body: template.body || '', footer: template.footer || '' } : blank);
      form.setErrors({});
      setProblems([]);
      setOkNote('');
    }
  }
  const v = form.values;
  const vars = useMemo(() => varsOf(v.body), [v.body]);

  const isMedia = MEDIA_TYPES.includes(v.attachmentType);
  const hasAttachment = (isMedia && Boolean(v.mediaId)) || extraMedia.length > 0;
  const payload = () => ({
    name: v.name.trim().toLowerCase(),
    language: v.language,
    category: v.category,
    headerType: v.header.trim() ? 'text' : 'none',
    header: v.header.trim(),
    attachmentType: v.attachmentType,
    mediaId: isMedia && v.mediaId ? v.mediaId : null,
    extraMediaIds: extraMedia.map((item) => item.id),
    body: v.body,
    footer: v.footer.trim(),
  });
  const chooseMedia = (m) => {
    setMedia(m);
    form.set('mediaId', m.id);
  };
  const chooseExtraMedia = (item) => {
    if (item.kind === 'document' && item.mime !== 'application/pdf') {
      toast.error('Additional documents must be PDF files.');
      return;
    }
    const next = [...extraMedia, item];
    const allKinds = [...(media ? [media.kind] : []), ...next.map((entry) => entry.kind)];
    if (extraMedia.some((entry) => entry.id === item.id)) {
      toast.error('That file is already attached.');
      return;
    }
    if (allKinds.filter((kind) => kind === 'image').length > 2 || allKinds.filter((kind) => kind === 'document').length > 1 || allKinds.length > 3) {
      toast.error('A message can include at most two images and one PDF.');
      return;
    }
    setExtraMedia(next);
    form.set('extraMediaIds', next.map((entry) => entry.id));
  };
  const removeExtraMedia = (id) => {
    const next = extraMedia.filter((entry) => entry.id !== id);
    setExtraMedia(next);
    form.set('extraMediaIds', next.map((entry) => entry.id));
  };
  const changeAttachmentType = (t) => {
    form.set('attachmentType', t);
    if (MEDIA_TYPES.includes(t) && media && media.kind !== t) {
      setMedia(null);
      form.set('mediaId', '');
    }
    if (t === 'none') {
      setMedia(null);
      form.set('mediaId', '');
    }
  };
  const showErrors = (err) => {
    form.setErrors(err.fields || {});
    setProblems(Array.isArray(err.details) ? err.details.map((d) => d.message) : []);
  };

  const check = async () => {
    setChecking(true);
    setOkNote('');
    setProblems([]);
    try {
      const r = await api.post('/c/templates/validate', payload());
      if (r.valid) setOkNote(`Looks good. ${r.variables.length ? `Placeholders: ${r.variables.map((x) => `{{${x}}}`).join(', ')}` : 'No placeholders.'}`);
      else {
        setProblems(r.errors.map((e) => e.message));
        const f = {};
        for (const e of r.errors) if (!f[e.field]) f[e.field] = e.message;
        form.setErrors(f);
      }
    } catch (err) {
      showErrors(err);
      toast.error(err);
    } finally {
      setChecking(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setProblems([]);
    setOkNote('');
    try {
      const r = editing ? await api.put(`/c/templates/${template._id}`, payload()) : await api.post('/c/templates', payload());
      toast.success(editing ? (r.resetToDraft ? 'Template saved and moved back to draft — submit it for review again' : 'Template saved') : 'Template created as a draft');
      onSaved(r.template);
    } catch (err) {
      showErrors(err);
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const addVar = () => {
    let n = 1;
    while (vars.includes(`variable_${n}`)) n += 1;
    form.set('body', `${v.body}${v.body && !/\s$/.test(v.body) ? ' ' : ''}{{variable_${n}}}`);
  };

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      busy={busy || picking || Boolean(addingKind)}
      wide
      title={editing ? `Edit template “${template.name}”` : 'New template'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={check} loading={checking} disabled={busy}>
            Validate
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {editing ? 'Save changes' : 'Save as draft'}
          </Button>
        </>
      }
    >
      {editing && template.status !== 'draft' ? <Alert tone="warn">Changing the content of a {template.status} template moves it back to <strong>draft</strong>; it must be submitted for review again.</Alert> : null}
      {problems.length ? (
        <Alert tone="danger" title="Fix these before saving">
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </Alert>
      ) : null}
      {okNote ? <Alert tone="ok">{okNote}</Alert> : null}
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <form onSubmit={save} noValidate>
          <Field label="Template name" error={form.errors.name} hint="Lowercase letters, numbers and underscores, e.g. diwali_offer" required>
            <input {...form.bind('name')} maxLength={60} placeholder="diwali_offer" />
          </Field>
          <div className="form-grid">
            <Field label="Language" error={form.errors.language}>
              <select {...form.bind('language')}>
                {LANGS.map(([c, l]) => <option key={c} value={c}>{l} ({c})</option>)}
              </select>
            </Field>
            <Field label="Category" error={form.errors.category}>
              <select {...form.bind('category')}>
                <option value="MARKETING">Marketing</option>
                <option value="UTILITY">Utility</option>
                <option value="AUTHENTICATION">Authentication</option>
              </select>
            </Field>
          </div>
          <Field label="Header text (optional)" error={form.errors.header} hint={`${v.header.length}/60 · text only, no placeholders`}>
            <input {...form.bind('header')} maxLength={60} />
          </Field>
          <Field label="Body" error={form.errors.body} hint={`${v.body.length}/1024 · use {{first_name}}-style placeholders`} required={!hasAttachment}>
            <textarea rows={6} {...form.bind('body')} maxLength={1024} placeholder="Hi {{first_name}}, your order {{order_id}} has shipped." />
          </Field>
          <div className="row gap-s mb">
            <Button size="sm" onClick={addVar}>+ Add placeholder</Button>
            <span className="muted small">{vars.length ? `${vars.length} placeholder(s)` : 'No placeholders yet'}</span>
          </div>
          <fieldset className="field media-field" style={{ border: 0, padding: 0, minWidth: 0 }}>
            <legend style={{ fontWeight: 600, marginBottom: 5, fontSize: 13 }}>Attachment (optional)</legend>
            <div className="seg" role="group" aria-label="Attachment type">
              {['none', ...MEDIA_TYPES].map((type) => (
                <button key={type} type="button" className={`seg-btn ${v.attachmentType === type ? 'active' : ''}`} aria-pressed={v.attachmentType === type} onClick={() => changeAttachmentType(type)}>
                  {type === 'none' ? 'None' : type[0].toUpperCase() + type.slice(1)}
                </button>
              ))}
            </div>
            {isMedia ? (
              <div className="mt">
                {form.errors.mediaId ? <div className="error-text" role="alert">{form.errors.mediaId}</div> : null}
                {media ? (
                  <div className="media-selected">
                    <MediaPreview media={media} />
                    <div className="row gap-s wrap mt">
                      <span className="small truncate" style={{ maxWidth: 220 }}>{media.name} · {fmtBytes(media.size)}</span>
                      <Button size="sm" onClick={() => { setMedia(null); form.set('mediaId', ''); }}>Remove</Button>
                    </div>
                  </div>
                ) : null}
                <div className="mt">
                  <div className="small muted mb">Additional vendor attachments (images/PDF)</div>
                  {extraMedia.map((item) => (
                    <div className="row gap-s wrap mb" key={item.id}>
                      <span className="small">{item.name} · {item.kind}</span>
                      <Button size="sm" onClick={() => removeExtraMedia(item.id)} disabled={busy}>Remove</Button>
                    </div>
                  ))}
                  <div className="row gap-s wrap">
                    <Button size="sm" onClick={() => setAddingKind('image')} disabled={busy}>+ Add image</Button>
                    <Button size="sm" onClick={() => setAddingKind('document')} disabled={busy}>+ Add PDF</Button>
                  </div>
                  <p className="muted small">The vendor HTTP connection supports up to two images and one PDF per message. Other connections support one attachment.</p>
                  {form.errors.extraMediaIds ? <div className="error-text" role="alert">{form.errors.extraMediaIds}</div> : null}
                </div>
                <div className={media ? 'mt' : ''}>
                  <UploadBox kind={v.attachmentType} compact onUploaded={chooseMedia} disabled={busy} />
                </div>
                <div className="mt">
                  <Button size="sm" onClick={() => setPicking(true)} disabled={busy}>Choose from Media library</Button>
                </div>
              </div>
            ) : null}
          </fieldset>
          <Field label="Footer (optional)" error={form.errors.footer} hint={`${v.footer.length}/60 · text only, no placeholders`}>
            <input {...form.bind('footer')} maxLength={60} />
          </Field>
          <button type="submit" className="sr-only" tabIndex={-1}>Save</button>
        </form>
        <div>
          <div className="small muted mb" style={{ fontWeight: 600 }}>Preview</div>
          <TemplatePreview header={v.header} media={isMedia ? media : null} body={v.body} footer={v.footer} />
          {vars.length ? <div className="chips mt">{vars.map((x) => <span className="chip" key={x}>{`{{${x}}}`}</span>)}</div> : null}
        </div>
      </div>
    </Modal>
    <MediaPickerModal open={picking} kind={isMedia ? v.attachmentType : undefined} onClose={() => setPicking(false)} onPick={(m) => { chooseMedia(m); setPicking(false); }} />
    <MediaPickerModal open={Boolean(addingKind)} kind={addingKind || undefined} onClose={() => setAddingKind('')} onPick={(item) => { chooseExtraMedia(item); setAddingKind(''); }} />
    </>
  );
}

export default function Templates() {
  useDocumentTitle('Templates');
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  const [formFor, setFormFor] = useState(undefined); // undefined closed, null new, object edit
  const [preview, setPreview] = useState(null);
  const [busyId, setBusyId] = useState('');
  const [syncing, setSyncing] = useState(false);
  const list = useApi(() => api.get('/c/templates', { q: dq, status, page, limit: 12 }), [dq, status, page]);

  const submit = async (t) => {
    setBusyId(t._id);
    try {
      await api.post(`/c/templates/${t._id}/submit`);
      toast.success('Submitted for review. Use “Sync status” to refresh the result.');
      list.reload({ silent: true });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusyId('');
    }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api.post('/c/templates/sync');
      toast.success(`${r.provider === 'mock' ? 'Simulated review finished' : 'Synchronised with Meta'}: ${r.updated} updated${r.imported ? `, ${r.imported} imported` : ''}${r.skipped && r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`);
      list.reload({ silent: true });
    } catch (err) {
      toast.error(err);
    } finally {
      setSyncing(false);
    }
  };

  const remove = (t) =>
    confirm({
      title: `Delete “${t.name}”?`,
      message: 'This cannot be undone. Templates used by draft or active campaigns cannot be deleted.',
      confirmText: 'Delete',
      danger: true,
      onConfirm: async () => {
        try {
          await api.del(`/c/templates/${t._id}`);
          toast.success('Template deleted');
          list.reload({ silent: true });
        } catch (err) {
          toast.error(err);
          throw err;
        }
      },
    });

  const columns = [
    {
      key: 'name',
      header: 'Template',
      render: (t) => (
        <div>
          <div className="row gap-s" style={{ flexWrap: 'nowrap' }}>
            <MediaThumb media={t.media} />
            <div style={{ minWidth: 0 }}>
              <div className="row gap-s wrap">
                <button className="btn btn-ghost btn-sm" style={{ padding: 0, fontWeight: 600 }} onClick={() => setPreview(t)}>{t.name}</button>
                {MEDIA_TYPES.includes(attachmentTypeOf(t)) ? <Badge tone="info">{attachmentTypeOf(t)[0].toUpperCase() + attachmentTypeOf(t).slice(1)}</Badge> : null}
              </div>
              <div className="muted small truncate" style={{ maxWidth: 360 }}>{t.body}</div>
            </div>
          </div>
        </div>
      ),
    },
    { key: 'cat', header: 'Category', render: (t) => `${t.category[0]}${t.category.slice(1).toLowerCase()} · ${t.language}` },
    { key: 'vars', header: 'Placeholders', render: (t) => (t.variables.length ? <div className="chips">{t.variables.map((x) => <span className="chip" key={x}>{x}</span>)}</div> : <span className="muted">None</span>) },
    {
      key: 'status',
      header: 'Status',
      render: (t) => (
        <div>
          <StatusBadge status={t.status} />
          {t.syncSource === 'mock' ? <div className="muted small">simulated review</div> : null}
          {t.status === 'rejected' && t.rejectionReason ? <div className="small" style={{ color: 'var(--danger)' }}>{t.rejectionReason}</div> : null}
        </div>
      ),
    },
    { key: 'updated', header: 'Updated', render: (t) => fmtDate(t.updatedAt, { time: false }) },
    {
      key: 'actions',
      header: '',
      className: 'right nowrap',
      render: (t) => (
        <div className="row gap-s" style={{ justifyContent: 'flex-end' }}>
          {['draft', 'rejected'].includes(t.status) ? <Button size="sm" variant="primary" loading={busyId === t._id} onClick={() => submit(t)}>Submit for review</Button> : null}
          <Button size="sm" onClick={() => setFormFor(t)}>Edit</Button>
          <Button size="sm" variant="outline-danger" onClick={() => remove(t)}>Delete</Button>
        </div>
      ),
    },
  ];
  const filtered = Boolean(dq || status);

  return (
    <>
      <PageHeader
        title="Templates"
        subtitle="Only approved templates can be used in campaigns."
        actions={
          <>
            <Button onClick={sync} loading={syncing}>Sync status</Button>
            <Button variant="primary" onClick={() => setFormFor(null)}>+ New template</Button>
          </>
        }
      />
      <Card pad={false}>
        <div className="toolbar">
          <SearchBox value={q} onChange={(x) => { setQ(x); setPage(1); }} placeholder="Search by template name…" />
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status filter">
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="pending">Pending review</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
          {filtered ? <Button size="sm" variant="ghost" onClick={() => { setQ(''); setStatus(''); setPage(1); }}>Clear filters</Button> : null}
        </div>
        {list.loading && !list.data ? <Spinner /> : null}
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
        {list.data ? (
          <>
            <DataTable
              columns={columns}
              rows={list.data.data}
              loading={list.loading}
              empty={
                <EmptyState title={filtered ? 'No templates match your filters' : 'No templates yet'} action={!filtered ? <Button variant="primary" onClick={() => setFormFor(null)}>Create your first template</Button> : null}>
                  {filtered ? 'Try a different search or clear the filters.' : 'A template is the message you send. Create it, submit it for review, then use it in a campaign.'}
                </EmptyState>
              }
            />
            <div style={{ padding: '0 18px 12px' }}>
              <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} limit={list.data.limit} onPage={setPage} noun="templates" />
            </div>
          </>
        ) : null}
      </Card>
      <TemplateModal
        open={formFor !== undefined}
        template={formFor || null}
        onClose={() => setFormFor(undefined)}
        onSaved={() => {
          setFormFor(undefined);
          list.reload({ silent: true });
        }}
      />
      <Modal open={Boolean(preview)} onClose={() => setPreview(null)} title={preview ? preview.name : ''} footer={<Button onClick={() => setPreview(null)}>Close</Button>}>
        {preview ? (
          <>
            <TemplatePreview header={preview.header} media={preview.media} body={preview.body} footer={preview.footer} />
            <dl className="kv mt">
              <dt>Status</dt><dd><StatusBadge status={preview.status} /></dd>
              <dt>Category</dt><dd>{preview.category}</dd>
              <dt>Language</dt><dd>{preview.language}</dd>
              <dt>Last synced</dt><dd>{fmtDate(preview.lastSyncedAt)}</dd>
            </dl>
            {preview.rejectionReason ? <Badge tone="danger">{preview.rejectionReason}</Badge> : null}
          </>
        ) : null}
      </Modal>
    </>
  );
}
