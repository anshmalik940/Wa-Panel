import { useRef, useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { fmtBytes } from '../format.js';
import { Alert, Button, EmptyState, ErrorState, Modal, Pagination, Spinner } from './ui.jsx';

const MB = 1048576;
export const KIND_LIMIT = { image: 5 * MB, video: 16 * MB, document: 16 * MB, audio: 16 * MB };
const EXT = {
  image: ['.jpg', '.jpeg', '.png'],
  video: ['.mp4', '.3gp'],
  document: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.pptx'],
  audio: ['.mp3', '.wav', '.ogg', '.m4a'],
};
export const KIND_LABEL = { image: 'Image', video: 'Video', document: 'Document', audio: 'Audio' };
const KIND_HELP = {
  image: 'JPG or PNG, up to 5 MB',
  video: 'MP4 or 3GP, up to 16 MB',
  document: 'PDF, Word, Excel or PowerPoint, up to 16 MB',
  audio: 'MP3, WAV, OGG or M4A, up to 16 MB',
};
export const ALL_HELP = 'Images (JPG/PNG, 5 MB), video (MP4/3GP), documents (PDF/Word/Excel/PowerPoint) and audio (MP3/WAV/OGG/M4A) up to 16 MB';

const extOf = (name) => {
  const i = String(name).lastIndexOf('.');
  return i < 0 ? '' : String(name).slice(i).toLowerCase();
};
export const kindOfFile = (file) => Object.keys(EXT).find((k) => EXT[k].includes(extOf(file.name))) || null;

/** Client-side pre-check so people get a clear message before a big upload starts. Returns an error string or ''. */
export function checkFile(file, kind) {
  if (!file) return 'Choose a file first.';
  const detected = kindOfFile(file);
  if (!detected) return `“${file.name}” is not a supported file type. ${kind ? `Use ${KIND_HELP[kind]}.` : ALL_HELP}.`;
  if (kind && detected !== kind) return `“${file.name}” is ${detected === 'image' ? 'an' : 'a'} ${detected} file, but a ${kind} is needed here (${KIND_HELP[kind]}).`;
  if (file.size > KIND_LIMIT[detected]) return `“${file.name}” is ${fmtBytes(file.size)}. ${KIND_LABEL[detected]} files can be at most ${KIND_LIMIT[detected] / MB} MB.`;
  if (file.size === 0) return `“${file.name}” is empty.`;
  return '';
}

/** Image / video player / document chip for a media object { kind, url, name, size }. */
export function MediaPreview({ media, small = false }) {
  if (!media) return null;
  if (media.kind === 'image') return <img className={small ? 'media-img media-small' : 'media-img'} src={media.url} alt={media.name || 'Uploaded image'} loading="lazy" />;
  if (media.kind === 'video') return <video className={small ? 'media-img media-small' : 'media-img'} src={media.url} controls={!small} preload="metadata" muted={small} />;
  if (media.kind === 'audio') return <audio className="media-audio" src={media.url} controls preload="none" />;
  const inner = (
    <>
      <span aria-hidden="true">📄</span>
      <span className="truncate">{media.name || 'Document'}</span>
      {media.size && !small ? <span className="muted small">{fmtBytes(media.size)}</span> : null}
    </>
  );
  return small ? (
    <span className="doc-chip">{inner}</span>
  ) : (
    <a className="doc-chip" href={media.url} target="_blank" rel="noreferrer">
      {inner}
    </a>
  );
}

/** Tiny square for lists. */
export function MediaThumb({ media }) {
  if (!media) return null;
  const icon = { image: '🖼', video: '🎬', document: '📄', audio: '🎵' }[media.kind] || '📎';
  return (
    <span className="thumb" title={`${KIND_LABEL[media.kind] || 'File'}: ${media.name || ''}`}>
      {media.kind === 'image' ? <img src={media.url} alt="" loading="lazy" /> : <span aria-hidden="true">{icon}</span>}
    </span>
  );
}

/**
 * Button + drag & drop uploader. Uploads to POST /c/media (optionally constrained to `kind`) and calls onUploaded(media).
 */
export function UploadBox({ kind, onUploaded, disabled = false, compact = false }) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');

  const accept = (kind ? EXT[kind] : Object.values(EXT).flat()).join(',');

  const handle = async (file) => {
    setError('');
    const problem = checkFile(file, kind);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const r = await api.upload('/c/media', file, { query: { kind }, onProgress: setProgress });
      if (onUploaded) onUploaded(r.media);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const off = disabled || busy;
  return (
    <div>
      <div
        className={`dropzone ${over ? 'over' : ''} ${compact ? 'dropzone-compact' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!off) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (off) return;
          const f = e.dataTransfer.files && e.dataTransfer.files[0];
          if (f) handle(f);
        }}
      >
        <input ref={inputRef} type="file" className="sr-only" accept={accept} tabIndex={-1} aria-label="Choose a file to upload" data-testid="file-input" onChange={(e) => e.target.files[0] && handle(e.target.files[0])} />
        {busy ? (
          <div role="status">
            <span className="spinner spinner-inline" aria-hidden="true" /> Uploading… {progress}%
            <div className="progress mt" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
              <div className="progress-bar progress-info" style={{ width: `${progress}%` }} />
            </div>
          </div>
        ) : (
          <>
            <Button variant="primary" size={compact ? 'sm' : undefined} disabled={disabled} onClick={() => inputRef.current && inputRef.current.click()}>
              {kind ? `Upload ${kind}` : 'Upload a file'}
            </Button>
            <div className="small mt">or drag and drop a file here</div>
            <div className="muted small">{kind ? KIND_HELP[kind] : ALL_HELP}</div>
          </>
        )}
      </div>
      {error ? (
        <div className="mt">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </div>
  );
}

/** Modal grid to choose an existing upload. */
export function MediaPickerModal({ open, kind, onClose, onPick }) {
  const [page, setPage] = useState(1);
  const list = useApi(() => (open ? api.get('/c/media', { kind, page, limit: 12 }) : Promise.resolve(null)), [open, kind, page]);
  return (
    <Modal open={open} onClose={onClose} wide title={`Choose ${kind ? `a ${kind}` : 'a file'} from your media library`} footer={<Button onClick={onClose}>Cancel</Button>}>
      {list.loading && !list.data ? <Spinner /> : null}
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
      {list.data ? (
        <>
          {list.data.data.length ? (
            <div className="media-grid">
              {list.data.data.map((m) => (
                <button key={m.id} type="button" className="media-card media-pick" onClick={() => onPick(m)} aria-label={`Use ${m.name}`}>
                  <div className="media-box">
                    <MediaPreview media={m} small />
                  </div>
                  <div className="media-meta">
                    <span className="truncate" title={m.name}>{m.name}</span>
                    <span className="muted small">{fmtBytes(m.size)}</span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState title={`No ${kind || 'files'} uploaded yet`}>Close this window and upload a file first.</EmptyState>
          )}
          <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} limit={list.data.limit} onPage={setPage} noun="files" />
        </>
      ) : null}
    </Modal>
  );
}
