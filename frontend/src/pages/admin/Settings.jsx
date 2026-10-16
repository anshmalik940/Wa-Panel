import { useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useApi, useDocumentTitle, useForm } from '../../hooks.js';
import { Alert, Button, Card, ErrorState, Field, PageHeader, Spinner, useToast } from '../../components/ui.jsx';

const NUM_KEYS = ['defaultMonthlyMessageLimit', 'defaultContactLimit', 'mockFailureRate', 'mockDeliveryDelayMs', 'mockReadDelayMs', 'creditsPerMessage', 'creditsPerCall', 'qrDelayMinMs', 'qrDelayMaxMs', 'waHttpDelayMs', 'campaignBatchSize', 'campaignBatchDelayMs', 'campaignFailurePauseThreshold', 'finishedCampaignRetentionLimit'];

function SettingsForm({ settings, env, onSaved }) {
  const toast = useToast();
  const { setBrandName } = useAuth();
  const form = useForm(Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, String(v)])));
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const v = form.values;
    const errs = {};
    if (!v.brandName.trim()) errs.brandName = 'Brand name is required';
    if (v.supportEmail.trim() && !/^\S+@\S+\.\S+$/.test(v.supportEmail.trim())) errs.supportEmail = 'Enter a valid email address';
    for (const k of NUM_KEYS) if (!/^\d+(\.\d+)?$/.test(String(v[k]).trim())) errs[k] = 'Enter a number (0 or more)';
    if (!errs.mockFailureRate && Number(v.mockFailureRate) > 100) errs.mockFailureRate = 'Must be between 0 and 100';
    for (const k of ['creditsPerMessage', 'creditsPerCall']) if (!errs[k] && !Number.isInteger(Number(v[k]))) errs[k] = 'Enter a whole number';
    for (const k of ['campaignBatchSize', 'campaignBatchDelayMs', 'campaignFailurePauseThreshold']) if (!errs[k] && !Number.isInteger(Number(v[k]))) errs[k] = 'Enter a whole number';
    for (const k of ['qrDelayMinMs', 'qrDelayMaxMs']) if (!errs[k] && Number(v[k]) < 500) errs[k] = 'At least 500 ms';
    if (!errs.qrDelayMinMs && !errs.qrDelayMaxMs && Number(v.qrDelayMaxMs) < Number(v.qrDelayMinMs)) errs.qrDelayMaxMs = 'Must be at least the minimum delay';
    if (!errs.waHttpDelayMs && Number(v.waHttpDelayMs) < 500) errs.waHttpDelayMs = 'At least 500 ms';
    if (!errs.campaignBatchSize && (Number(v.campaignBatchSize) < 1 || Number(v.campaignBatchSize) > 50)) errs.campaignBatchSize = 'Must be between 1 and 50';
    if (!errs.campaignFailurePauseThreshold && (Number(v.campaignFailurePauseThreshold) < 1 || Number(v.campaignFailurePauseThreshold) > 50)) errs.campaignFailurePauseThreshold = 'Must be between 1 and 50';
    if (!errs.finishedCampaignRetentionLimit && Number(v.finishedCampaignRetentionLimit) < 1) errs.finishedCampaignRetentionLimit = 'Keep at least one finished campaign';
    form.setErrors(errs);
    if (Object.keys(errs).length) return;
    const body = { brandName: v.brandName.trim(), supportEmail: v.supportEmail.trim() };
    for (const k of NUM_KEYS) body[k] = Number(v[k]);
    body.allowQrForNewUsers = v.allowQrForNewUsers === 'true';
    setBusy(true);
    try {
      const r = await api.put('/admin/settings', body);
      setBrandName(r.settings.brandName);
      toast.success('Settings saved');
      onSaved(r.settings);
    } catch (err) {
      form.setErrors(err.fields || {});
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <div className="grid grid-2">
        <Card title="Branding">
          <Field label="Brand name" error={form.errors.brandName} hint="Shown in the sidebar, sign-in page and password-reset emails" required>
            <input {...form.bind('brandName')} maxLength={60} />
          </Field>
          <Field label="Support email" error={form.errors.supportEmail}>
            <input type="email" {...form.bind('supportEmail')} />
          </Field>
        </Card>
        <Card title="Defaults for new customers">
          <Field label="Monthly message limit" error={form.errors.defaultMonthlyMessageLimit} hint="Applied when a customer is created without an explicit limit">
            <input inputMode="numeric" {...form.bind('defaultMonthlyMessageLimit')} />
          </Field>
          <Field label="Contact limit" error={form.errors.defaultContactLimit}>
            <input inputMode="numeric" {...form.bind('defaultContactLimit')} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={form.values.allowQrForNewUsers === 'true'} onChange={(e) => form.set('allowQrForNewUsers', String(e.target.checked))} />
            Allow QR for new users
          </label>
        </Card>
        <Card title="Mock provider (simulation)">
          <p className="muted small">The mock provider never contacts WhatsApp. These values only shape the simulated results so you can test reports and failure handling.</p>
          <Field label="Random failure rate (%)" error={form.errors.mockFailureRate} hint="Share of simulated messages that fail. Numbers ending in 0000 always fail.">
            <input inputMode="decimal" {...form.bind('mockFailureRate')} />
          </Field>
          <Field label="Delay before “delivered” (ms)" error={form.errors.mockDeliveryDelayMs}>
            <input inputMode="numeric" {...form.bind('mockDeliveryDelayMs')} />
          </Field>
          <Field label="Delay before “read” (ms)" error={form.errors.mockReadDelayMs}>
            <input inputMode="numeric" {...form.bind('mockReadDelayMs')} />
          </Field>
        </Card>
        <Card title="Credits (price list)">
          <p className="muted small">What each real message or call costs from a customer’s or reseller’s credit balance. Simulated (mock) messages and calls are always free.</p>
          <Field label="Credits per WhatsApp message" error={form.errors.creditsPerMessage}>
            <input inputMode="numeric" {...form.bind('creditsPerMessage')} />
          </Field>
          <Field label="Credits per voice call" error={form.errors.creditsPerCall}>
            <input inputMode="numeric" {...form.bind('creditsPerCall')} />
          </Field>
        </Card>
        <Card title="Linked phone (QR) sending speed">
          <p className="muted small">Messages sent from a phone linked by QR code are spaced out by a random pause between these two values, so traffic does not look like a burst. Longer pauses are safer for the number.</p>
          <Field label="Shortest pause between messages (ms)" error={form.errors.qrDelayMinMs}>
            <input inputMode="numeric" {...form.bind('qrDelayMinMs')} />
          </Field>
          <Field label="Longest pause between messages (ms)" error={form.errors.qrDelayMaxMs}>
            <input inputMode="numeric" {...form.bind('qrDelayMaxMs')} />
          </Field>
        </Card>
        <Card title="Company WhatsApp API sending speed">
          <p className="muted small">Minimum pause between vendor API messages. The default is one second; the queue never sends these messages in a burst.</p>
          <Field label="Pause between messages (ms)" error={form.errors.waHttpDelayMs}>
            <input inputMode="numeric" {...form.bind('waHttpDelayMs')} />
          </Field>
        </Card>
        <Card title="Campaign queue safety">
          <p className="muted small">Controls the number of messages a worker may process before yielding and the pause between batches. QR-linked phones and vendor APIs continue to use their own per-message pacing. These limits are operational safeguards, not a guarantee against provider restrictions.</p>
          <Field label="Maximum messages per worker batch" error={form.errors.campaignBatchSize}>
            <input inputMode="numeric" {...form.bind('campaignBatchSize')} min="1" max="50" />
          </Field>
          <Field label="Pause between worker batches (ms)" error={form.errors.campaignBatchDelayMs}>
            <input inputMode="numeric" {...form.bind('campaignBatchDelayMs')} min="0" max="600000" />
          </Field>
          <Field label="Consecutive failures before automatic pause" error={form.errors.campaignFailurePauseThreshold}>
            <input inputMode="numeric" {...form.bind('campaignFailurePauseThreshold')} min="1" max="50" />
          </Field>
        </Card>
        <Card title="Campaign history">
          <p className="muted small">Finished campaigns beyond this per-account limit, including their recipient rows, are automatically removed. Draft and in-progress campaigns are never removed.</p>
          <Field label="Latest finished campaigns kept" error={form.errors.finishedCampaignRetentionLimit}>
            <input inputMode="numeric" {...form.bind('finishedCampaignRetentionLimit')} min="1" max="1000" />
          </Field>
        </Card>
        <Card title="Server environment (read-only)">
          <dl className="kv">
            <dt>Real sending (WhatsApp and calls)</dt>
            <dd>{env.allowRealSend ? 'Enabled (ALLOW_REAL_SEND=true)' : 'Disabled — only the mock providers run'}</dd>
            <dt>Mock campaign reports</dt>
            <dd>{env.allowMockCampaigns ? 'Enabled for this non-production/demo environment' : 'Disabled (production default)'}</dd>
            <dt>Default country code</dt>
            <dd>+{env.defaultCountryCode}</dd>
            <dt>Usage timezone</dt>
            <dd>{env.usageTimezone}</dd>
          </dl>
          <p className="muted small mt">These come from the server’s <code>.env</code> file and are changed there, then the API is restarted.</p>
        </Card>
      </div>
      <div className="row gap-s mt">
        <Button type="submit" variant="primary" loading={busy}>
          Save settings
        </Button>
        <Button onClick={() => form.setValues(Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, String(v)])))} disabled={busy}>
          Discard changes
        </Button>
      </div>
    </form>
  );
}

export default function Settings() {
  useDocumentTitle('Settings');
  const res = useApi(() => api.get('/admin/settings'), []);
  return (
    <>
      <PageHeader title="Platform settings" subtitle="Branding, new-account permissions, retention and platform defaults." />
      {res.loading && !res.data ? <Spinner /> : null}
      {res.error ? <ErrorState error={res.error} onRetry={res.reload} /> : null}
      {res.data ? (
        <>
          {!res.data.env.allowRealSend ? <Alert tone="info">Real sending is switched off on this server (ALLOW_REAL_SEND=false in .env). Campaigns and calls run through the mock providers only.</Alert> : null}
          <SettingsForm key={JSON.stringify(res.data.settings)} settings={res.data.settings} env={res.data.env} onSaved={() => res.reload({ silent: true })} />
        </>
      ) : null}
    </>
  );
}
