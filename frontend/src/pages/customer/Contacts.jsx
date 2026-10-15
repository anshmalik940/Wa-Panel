import { useRef, useState } from 'react';
import { api } from '../../api.js';
import { useApi, useDebounced, useDocumentTitle, useForm } from '../../hooks.js';
import { fmtDate, fmtNumber } from '../../format.js';
import { Alert, Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, Modal, PageHeader, Pagination, SearchBox, Spinner, useConfirm, useToast } from '../../components/ui.jsx';

const splitGroups = (s) => [...new Set(String(s || '').split(',').map((g) => g.trim()).filter(Boolean))];

function ContactStatus({ c }) {
  if (c.optedOut) return <Badge tone="warn" title={c.optOutSource ? `Source: ${c.optOutSource}` : undefined}>Opted out</Badge>;
  if (!c.phoneValid) return <Badge tone="danger">Invalid number</Badge>;
  return <Badge tone="ok">Can receive</Badge>;
}

/* ---------------- add / edit ---------------- */
function ContactModal({ open, contact, groups, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(contact);
  const form = useForm({ name: '', phone: '', email: '', groups: '', optedOut: false });
  const [attrs, setAttrs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      form.setValues({ name: contact ? contact.name : '', phone: contact ? contact.phone : '', email: contact ? contact.email : '', groups: contact ? contact.groups.join(', ') : '', optedOut: contact ? contact.optedOut : false });
      form.setErrors({});
      setAttrs(contact ? Object.entries(contact.attributes || {}).map(([k, v]) => ({ k, v })) : []);
    }
  }

  const submit = async (e) => {
    e.preventDefault();
    const v = form.values;
    const errs = {};
    if (!v.phone.trim()) errs.phone = 'Phone number is required';
    if (v.email.trim() && !/^\S+@\S+\.\S+$/.test(v.email.trim())) errs.email = 'Enter a valid email address';
    form.setErrors(errs);
    if (Object.keys(errs).length) return;
    const attributes = {};
    for (const a of attrs) if (a.k.trim() && String(a.v).trim()) attributes[a.k.trim()] = String(a.v).trim();
    const body = { name: v.name.trim(), phone: v.phone.trim(), email: v.email.trim(), groups: splitGroups(v.groups), attributes };
    if (editing) body.optedOut = v.optedOut;
    setBusy(true);
    try {
      const r = editing ? await api.patch(`/c/contacts/${contact._id}`, body) : await api.post('/c/contacts', body);
      if (r.warning) toast.info(r.warning);
      else toast.success(editing ? 'Contact updated' : 'Contact added');
      onSaved(r.contact);
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
      wide
      title={editing ? 'Edit contact' : 'Add contact'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={submit}>{editing ? 'Save changes' : 'Add contact'}</Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Name" error={form.errors.name}><input {...form.bind('name')} maxLength={120} /></Field>
          <Field label="Phone (WhatsApp)" error={form.errors.phone} hint="With country code, e.g. +919876543210. Without one, the default country code is added." required>
            <input inputMode="tel" {...form.bind('phone')} maxLength={40} />
          </Field>
          <Field label="Email" error={form.errors.email}><input type="email" {...form.bind('email')} /></Field>
          <Field label="Groups" error={form.errors.groups} hint="Comma separated, e.g. vip, delhi">
            <input list="group-suggestions" {...form.bind('groups')} />
            <datalist id="group-suggestions">{groups.map((g) => <option key={g.name} value={g.name} />)}</datalist>
          </Field>
        </div>
        <div className="small muted mb" style={{ fontWeight: 600 }}>Extra fields for personalisation (optional)</div>
        {attrs.map((a, i) => (
          <div className="row gap-s mb" key={i}>
            <input aria-label="Field name" placeholder="field name, e.g. city" value={a.k} onChange={(e) => setAttrs((l) => l.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
            <input aria-label="Field value" placeholder="value" value={a.v} onChange={(e) => setAttrs((l) => l.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
            <Button size="sm" variant="ghost" aria-label="Remove field" onClick={() => setAttrs((l) => l.filter((_, j) => j !== i))}>×</Button>
          </div>
        ))}
        <Button size="sm" onClick={() => setAttrs((l) => [...l, { k: '', v: '' }])} disabled={attrs.length >= 30}>+ Add field</Button>
        {editing ? (
          <label className="check mt">
            <input type="checkbox" checked={form.values.optedOut} onChange={(e) => form.set('optedOut', e.target.checked)} />
            Opted out (never receives campaigns)
          </label>
        ) : null}
        <button type="submit" className="sr-only" tabIndex={-1}>Save</button>
      </form>
    </Modal>
  );
}

/* ---------------- import ---------------- */
function ImportModal({ open, onClose, onDone }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [mode, setMode] = useState('skip');
  const [group, setGroup] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState(null);
  const [over, setOver] = useState(false);
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setCsv(''); setFileName(''); setPreview(null); setMapping({}); setMode('skip'); setGroup(''); setError(''); setReport(null);
    }
  }

  const load = async (file) => {
    if (!file) return;
    setError('');
    setReport(null);
    if (file.size > 5 * 1024 * 1024) {
      setError('This file is larger than 5 MB. Split it into smaller files.');
      return;
    }
    const text = (await file.text()).replace(/^\uFEFF/, '');
    setBusy(true);
    try {
      const p = await api.post('/c/contacts/import/preview', { csv: text });
      setCsv(text);
      setFileName(file.name);
      setPreview(p);
      setMapping(p.mapping || {});
    } catch (err) {
      setPreview(null);
      setCsv('');
      setFileName('');
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!mapping.phone) {
      setError('Choose which column contains the phone numbers.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body = { csv, mapping, duplicateMode: mode };
      if (group.trim()) body.defaultGroup = group.trim();
      const r = await api.post('/c/contacts/import', body);
      setReport(r);
      toast.success(`Import finished: ${r.created} added, ${r.updated} updated`);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const colSelect = (field, label, required) => (
    <Field label={label} required={required}>
      <select value={mapping[field] || ''} onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value }))}>
        <option value="">{required ? '— choose column —' : '— not in file —'}</option>
        {(preview ? preview.headers : []).map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </Field>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      wide
      title="Import contacts from CSV"
      footer={
        report ? (
          <Button variant="primary" onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!preview} onClick={run}>Import {preview ? fmtNumber(preview.totalRows) : ''} rows</Button>
          </>
        )
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {report ? (
        <>
          <Alert tone="ok" title="Import finished">
            {fmtNumber(report.created)} added · {fmtNumber(report.updated)} updated · {fmtNumber(report.skippedExisting)} already existed (skipped) · {fmtNumber(report.skippedDuplicateInFile)} duplicate rows inside the file
            {report.flaggedInvalidPhone ? ` · ${report.flaggedInvalidPhone} saved with an invalid-looking number (excluded from campaigns)` : ''}
          </Alert>
          {report.errorCount ? (
            <Card title={`${report.errorCount} row(s) not imported`}>
              <ul className="small" style={{ margin: 0, paddingLeft: 18, maxHeight: 220, overflow: 'auto' }}>
                {report.errors.map((e, i) => <li key={i}>{e.row ? `Row ${e.row}: ` : ''}{e.message}</li>)}
              </ul>
              {report.errorCount > report.errors.length ? <p className="muted small">Showing the first {report.errors.length}.</p> : null}
            </Card>
          ) : null}
        </>
      ) : (
        <>
          <div
            className={`dropzone ${over ? 'over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); load(e.dataTransfer.files[0]); }}
          >
            <p style={{ margin: '0 0 8px' }}>{fileName ? <strong>{fileName}</strong> : 'Drop a .csv file here'}</p>
            <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => { load(e.target.files[0]); e.target.value = ''; }} />
            <Button onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}>{fileName ? 'Choose another file' : 'Choose file'}</Button>
            <p className="small" style={{ margin: '10px 0 0' }}>First row = column headers. Needs a phone column; name, email and groups are optional. Other columns become personalisation fields.</p>
          </div>
          {preview ? (
            <>
              <div className="form-grid mt">
                {colSelect('phone', 'Phone column', true)}
                {colSelect('name', 'Name column')}
                {colSelect('email', 'Email column')}
                {colSelect('groups', 'Groups column (separate with ; or |)')}
                <Field label="If a phone number already exists">
                  <select value={mode} onChange={(e) => setMode(e.target.value)}>
                    <option value="skip">Skip the row (keep the existing contact)</option>
                    <option value="update">Update the existing contact with the new values</option>
                  </select>
                </Field>
                <Field label="Add everyone to group (optional)">
                  <input value={group} onChange={(e) => setGroup(e.target.value)} maxLength={50} placeholder="e.g. october_import" />
                </Field>
              </div>
              <div className="small muted mb" style={{ fontWeight: 600 }}>Preview of the first {preview.sample.length} of {fmtNumber(preview.totalRows)} rows</div>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr>{preview.headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>{preview.sample.map((r, i) => <tr key={i}>{preview.headers.map((h, j) => <td key={h + j}>{r[j]}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      )}
    </Modal>
  );
}

/* ---------------- groups ---------------- */
function GroupsModal({ open, onClose, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const list = useApi(() => (open ? api.get('/c/contacts/groups') : Promise.resolve({ groups: [] })), [open]);
  const [editing, setEditing] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const rename = async (g) => {
    if (!name.trim() || name.trim() === g.name) {
      setEditing('');
      return;
    }
    setBusy(true);
    try {
      const r = await api.patch(`/c/contacts/groups/${encodeURIComponent(g.name)}`, { name: name.trim() });
      toast.success(`Renamed on ${r.renamed} contact(s)`);
      setEditing('');
      list.reload({ silent: true });
      onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = (g) =>
    confirm({
      title: `Delete group “${g.name}”?`,
      message: `The group is removed from ${g.count} contact(s). The contacts themselves are kept. Draft campaigns that target this group will have no recipients.`,
      confirmText: 'Delete group',
      danger: true,
      onConfirm: async () => {
        try {
          await api.del(`/c/contacts/groups/${encodeURIComponent(g.name)}`);
          toast.success('Group deleted');
          list.reload({ silent: true });
          onChanged();
        } catch (err) {
          toast.error(err);
          throw err;
        }
      },
    });

  return (
    <Modal open={open} onClose={onClose} title="Contact groups" footer={<Button onClick={onClose}>Close</Button>}>
      {list.loading && !list.data ? <Spinner /> : null}
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
      {list.data && !list.data.groups.length ? <EmptyState title="No groups yet">Add contacts to a group from the contact form, an import, or the bulk actions.</EmptyState> : null}
      {list.data
        ? list.data.groups.map((g) => (
            <div className="pick-item" key={g.name}>
              {editing === g.name ? (
                <>
                  <input className="grow" value={name} onChange={(e) => setName(e.target.value)} maxLength={50} aria-label="New group name" onKeyDown={(e) => e.key === 'Enter' && rename(g)} />
                  <Button size="sm" variant="primary" loading={busy} onClick={() => rename(g)}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing('')}>Cancel</Button>
                </>
              ) : (
                <>
                  <span className="grow"><strong>{g.name}</strong> <span className="muted small">· {fmtNumber(g.count)} contacts</span></span>
                  <Button size="sm" onClick={() => { setEditing(g.name); setName(g.name); }}>Rename</Button>
                  <Button size="sm" variant="outline-danger" onClick={() => remove(g)}>Delete</Button>
                </>
              )}
            </div>
          ))
        : null}
    </Modal>
  );
}

/* ---------------- duplicates ---------------- */
function DuplicatesModal({ open, onClose, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const res = useApi(() => (open ? api.get('/c/contacts/duplicates') : Promise.resolve({ clusters: [], total: 0, scanned: 0 })), [open]);
  const [keep, setKeep] = useState({});

  const merge = (cl, idx) => {
    const keepId = keep[idx] || cl.contacts[0].id;
    const others = cl.contacts.filter((c) => c.id !== keepId).map((c) => c.id);
    return confirm({
      title: 'Merge these contacts?',
      message: `${others.length} contact(s) will be merged into the one you chose and then deleted. Groups and extra fields are combined; an opt-out is kept.`,
      confirmText: 'Merge',
      onConfirm: async () => {
        try {
          await api.post('/c/contacts/merge', { keepId, mergeIds: others });
          toast.success('Contacts merged');
          res.reload({ silent: true });
          onChanged();
        } catch (err) {
          toast.error(err);
          throw err;
        }
      },
    });
  };

  return (
    <Modal open={open} onClose={onClose} wide title="Possible duplicates" footer={<Button onClick={onClose}>Close</Button>}>
      <p className="muted small">Phone numbers are unique per account, so exact phone duplicates cannot exist. These are contacts that share an email address or the same name.</p>
      {res.loading && !res.data ? <Spinner label="Scanning…" /> : null}
      {res.error ? <ErrorState error={res.error} onRetry={res.reload} /> : null}
      {res.data && !res.data.clusters.length ? <EmptyState title="No duplicates found">{fmtNumber(res.data.scanned)} contacts were checked.</EmptyState> : null}
      {res.data
        ? res.data.clusters.map((cl, idx) => (
            <Card key={`${cl.type}-${cl.key}`} title={`Same ${cl.type}: ${cl.key}`} actions={<Button size="sm" variant="primary" onClick={() => merge(cl, idx)}>Merge into selected</Button>}>
              {cl.contacts.map((c) => (
                <label className="pick-item" key={c.id}>
                  <input type="radio" name={`keep-${idx}`} checked={(keep[idx] || cl.contacts[0].id) === c.id} onChange={() => setKeep((k) => ({ ...k, [idx]: c.id }))} />
                  <span className="grow">
                    <strong>{c.name || '(no name)'}</strong> · <span className="mono">{c.phone}</span>
                    <div className="muted small">{c.email || 'no email'} · {c.groups.join(', ') || 'no groups'}{c.optedOut ? ' · opted out' : ''} · added {fmtDate(c.createdAt, { time: false })}</div>
                  </span>
                </label>
              ))}
            </Card>
          ))
        : null}
    </Modal>
  );
}

/* ---------------- page ---------------- */
export default function Contacts() {
  useDocumentTitle('Contacts');
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [group, setGroup] = useState('');
  const [sort, setSort] = useState('createdAt');
  const [dir, setDir] = useState('desc');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(() => new Set());
  const dq = useDebounced(q);
  const [formFor, setFormFor] = useState(undefined);
  const [importOpen, setImportOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [bulkGroup, setBulkGroup] = useState('');
  const [exporting, setExporting] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const query = { q: dq, status, group, sort, dir };
  const list = useApi(() => api.get('/c/contacts', { ...query, page, limit: 20 }), [dq, status, group, sort, dir, page]);
  const groups = useApi(() => api.get('/c/contacts/groups'), []);
  const groupList = groups.data ? groups.data.groups : [];
  const refresh = () => {
    list.reload({ silent: true });
    groups.reload({ silent: true });
  };
  const resetPage = () => {
    setPage(1);
    setSelected(new Set());
  };

  const rows = list.data ? list.data.data : [];
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r._id));
  const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s);
      if (allOnPage) rows.forEach((r) => n.delete(r._id));
      else rows.forEach((r) => n.add(r._id));
      return n;
    });
  const toggleOne = (id) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const exportCsv = async () => {
    setExporting(true);
    try {
      const name = await api.download('/c/contacts/export', query, 'contacts.csv');
      toast.success(`Exported ${name} (uses the current search and filters)`);
    } catch (err) {
      toast.error(err);
    } finally {
      setExporting(false);
    }
  };

  const bulk = async (action) => {
    const ids = [...selected];
    if (!ids.length) return;
    if ((action === 'addGroup' || action === 'removeGroup') && !bulkGroup.trim()) {
      toast.error('Type a group name first');
      return;
    }
    const run = async () => {
      setBulkBusy(true);
      try {
        const r = await api.post('/c/contacts/bulk', { action, ids, group: bulkGroup.trim() || undefined });
        toast.success(`${r.affected} contact(s) updated`);
        setSelected(new Set());
        refresh();
      } catch (err) {
        toast.error(err);
        throw err;
      } finally {
        setBulkBusy(false);
      }
    };
    if (action === 'delete') {
      await confirm({ title: `Delete ${ids.length} contact(s)?`, message: 'This cannot be undone.', confirmText: 'Delete', danger: true, onConfirm: run });
    } else await run().catch(() => {});
  };

  const removeOne = (c) =>
    confirm({
      title: `Delete ${c.name || c.phone}?`,
      message: 'This cannot be undone.',
      confirmText: 'Delete',
      danger: true,
      onConfirm: async () => {
        try {
          await api.del(`/c/contacts/${c._id}`);
          toast.success('Contact deleted');
          setSelected((s) => { const n = new Set(s); n.delete(c._id); return n; });
          refresh();
        } catch (err) {
          toast.error(err);
          throw err;
        }
      },
    });

  const columns = [
    { key: 'sel', header: <input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={toggleAll} />, width: 36, render: (c) => <input type="checkbox" aria-label={`Select ${c.name || c.phone}`} checked={selected.has(c._id)} onChange={() => toggleOne(c._id)} /> },
    { key: 'name', header: 'Name', render: (c) => <div><strong>{c.name || <span className="muted">(no name)</span>}</strong>{c.email ? <div className="muted small">{c.email}</div> : null}</div> },
    { key: 'phone', header: 'Phone', render: (c) => <span className="mono">{c.phone}</span> },
    { key: 'groups', header: 'Groups', render: (c) => (c.groups.length ? <div className="chips">{c.groups.map((g) => <span className="chip" key={g}>{g}</span>)}</div> : <span className="muted">—</span>) },
    { key: 'status', header: 'Status', render: (c) => <ContactStatus c={c} /> },
    { key: 'added', header: 'Added', render: (c) => fmtDate(c.createdAt, { time: false }) },
    { key: 'actions', header: '', className: 'right nowrap', render: (c) => <div className="row gap-s" style={{ justifyContent: 'flex-end' }}><Button size="sm" onClick={() => setFormFor(c)}>Edit</Button><Button size="sm" variant="outline-danger" onClick={() => removeOne(c)}>Delete</Button></div> },
  ];
  const filtered = Boolean(dq || status || group);

  return (
    <>
      <PageHeader
        title="Contacts"
        subtitle="Your audience. Opted-out and invalid numbers are automatically excluded from campaigns."
        actions={
          <>
            <Button onClick={() => setDupOpen(true)}>Find duplicates</Button>
            <Button onClick={() => setGroupsOpen(true)}>Groups</Button>
            <Button onClick={exportCsv} loading={exporting}>Export CSV</Button>
            <Button onClick={() => setImportOpen(true)}>Import CSV</Button>
            <Button variant="primary" onClick={() => setFormFor(null)}>+ Add contact</Button>
          </>
        }
      />
      <Card pad={false}>
        <div className="toolbar">
          <SearchBox value={q} onChange={(x) => { setQ(x); resetPage(); }} placeholder="Search name, phone or email…" />
          <select value={status} onChange={(e) => { setStatus(e.target.value); resetPage(); }} aria-label="Status filter">
            <option value="">All contacts</option>
            <option value="valid">Can receive messages</option>
            <option value="invalid">Invalid number</option>
            <option value="optedout">Opted out</option>
            <option value="subscribed">Not opted out</option>
          </select>
          <select value={group} onChange={(e) => { setGroup(e.target.value); resetPage(); }} aria-label="Group filter">
            <option value="">All groups</option>
            {groupList.map((g) => <option key={g.name} value={g.name}>{g.name} ({g.count})</option>)}
          </select>
          <select value={`${sort}:${dir}`} onChange={(e) => { const [s, d] = e.target.value.split(':'); setSort(s); setDir(d); setPage(1); }} aria-label="Sort order">
            <option value="createdAt:desc">Newest first</option>
            <option value="createdAt:asc">Oldest first</option>
            <option value="name:asc">Name A–Z</option>
            <option value="name:desc">Name Z–A</option>
            <option value="phone:asc">Phone ↑</option>
          </select>
          {filtered ? <Button size="sm" variant="ghost" onClick={() => { setQ(''); setStatus(''); setGroup(''); resetPage(); }}>Clear filters</Button> : null}
        </div>
        {selected.size ? (
          <div className="toolbar" style={{ background: 'var(--primary-soft)' }}>
            <strong>{selected.size} selected</strong>
            <input style={{ width: 160 }} value={bulkGroup} onChange={(e) => setBulkGroup(e.target.value)} placeholder="Group name" aria-label="Group name for bulk action" list="bulk-groups" />
            <datalist id="bulk-groups">{groupList.map((g) => <option key={g.name} value={g.name} />)}</datalist>
            <Button size="sm" disabled={bulkBusy} onClick={() => bulk('addGroup')}>Add to group</Button>
            <Button size="sm" disabled={bulkBusy} onClick={() => bulk('removeGroup')}>Remove from group</Button>
            <Button size="sm" disabled={bulkBusy} onClick={() => bulk('optOut')}>Mark opted out</Button>
            <Button size="sm" disabled={bulkBusy} onClick={() => bulk('optIn')}>Mark subscribed</Button>
            <Button size="sm" variant="outline-danger" disabled={bulkBusy} onClick={() => bulk('delete')}>Delete</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
          </div>
        ) : null}
        {list.loading && !list.data ? <Spinner /> : null}
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
        {list.data ? (
          <>
            <DataTable
              columns={columns}
              rows={rows}
              loading={list.loading}
              empty={
                <EmptyState
                  title={filtered ? 'No contacts match your filters' : 'No contacts yet'}
                  action={!filtered ? <div className="row gap-s"><Button variant="primary" onClick={() => setImportOpen(true)}>Import a CSV</Button><Button onClick={() => setFormFor(null)}>Add one manually</Button></div> : null}
                >
                  {filtered ? 'Try a different search or clear the filters.' : 'Add contacts one by one or import a spreadsheet saved as CSV.'}
                </EmptyState>
              }
            />
            <div style={{ padding: '0 18px 12px' }}>
              <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} limit={list.data.limit} onPage={(p) => { setPage(p); setSelected(new Set()); }} noun="contacts" />
            </div>
          </>
        ) : null}
      </Card>

      <ContactModal open={formFor !== undefined} contact={formFor || null} groups={groupList} onClose={() => setFormFor(undefined)} onSaved={() => { setFormFor(undefined); refresh(); }} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onDone={refresh} />
      <GroupsModal open={groupsOpen} onClose={() => setGroupsOpen(false)} onChanged={refresh} />
      <DuplicatesModal open={dupOpen} onClose={() => setDupOpen(false)} onChanged={refresh} />
    </>
  );
}
