import { useState } from 'react';
import { api } from '../../api.js';
import { useApi, useDocumentTitle } from '../../hooks.js';
import { fmtBytes, fmtDate } from '../../format.js';
import { Badge, Button, Card, CopyButton, EmptyState, ErrorState, PageHeader, Pagination, Spinner, Tabs, useConfirm, useToast } from '../../components/ui.jsx';
import { KIND_LABEL, MediaPreview, UploadBox } from '../../components/Media.jsx';

const TABS = [
  { value: '', label: 'All' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
  { value: 'document', label: 'Documents' },
  { value: 'audio', label: 'Audio' },
];

export default function MediaLibrary() {
  useDocumentTitle('Media library');
  const toast = useToast();
  const confirm = useConfirm();
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const list = useApi(() => api.get('/c/media', { kind, page, limit: 12 }), [kind, page]);

  const remove = (m) =>
    confirm({
      title: `Delete “${m.name}”?`,
      message: 'The file is removed permanently and its public link stops working. Files used by a template or an active campaign cannot be deleted.',
      confirmText: 'Delete',
      danger: true,
      onConfirm: async () => {
        try {
          await api.del(`/c/media/${m.id}`);
          toast.success('File deleted');
          if (list.data && list.data.data.length === 1 && page > 1) setPage(page - 1);
          else list.reload({ silent: true });
        } catch (err) {
          toast.error(err);
          throw err;
        }
      },
    });

  return (
    <>
      <PageHeader title="Media library" subtitle="Images, videos and documents you can attach to templates (ads) and campaigns." />
      <div className="mb">
        <Card title="Upload a file">
          <UploadBox
            onUploaded={(m) => {
              toast.success(`“${m.name}” uploaded`);
              setKind('');
              setPage(1);
              list.reload({ silent: true });
            }}
          />
        </Card>
      </div>
      <Card pad={false}>
        <div style={{ padding: '10px 18px 0' }}>
          <Tabs tabs={TABS} value={kind} onChange={(v) => { setKind(v); setPage(1); }} />
        </div>
        {list.loading && !list.data ? <Spinner /> : null}
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
        {list.data ? (
          <div style={{ padding: 18 }}>
            {list.data.data.length ? (
              <div className={`media-grid ${list.loading ? 'is-loading' : ''}`}>
                {list.data.data.map((m) => (
                  <div className="media-card" key={m.id}>
                    <div className="media-box">
                      <MediaPreview media={m} />
                    </div>
                    <div className="media-meta">
                      <span className="truncate" title={m.name} style={{ fontWeight: 600 }}>{m.name}</span>
                      <div className="row gap-s wrap">
                        <Badge>{KIND_LABEL[m.kind] || m.kind}</Badge>
                        <span className="muted small">{fmtBytes(m.size)} · {fmtDate(m.createdAt, { time: false })}</span>
                      </div>
                      <div className="row gap-s">
                        <CopyButton text={m.url} label="Copy link" />
                        <Button size="sm" variant="outline-danger" onClick={() => remove(m)}>Delete</Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState title={kind ? `No ${kind} files yet` : 'Your library is empty'}>Upload a file above. You can then attach it as the header of a template.</EmptyState>
            )}
            <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} limit={list.data.limit} onPage={setPage} noun="files" />
          </div>
        ) : null}
      </Card>
    </>
  );
}
