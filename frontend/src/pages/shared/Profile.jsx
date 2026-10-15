import { useState } from 'react';
import { api, errorMessage } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useDocumentTitle, useForm } from '../../hooks.js';
import { Alert, Button, Card, Field, PageHeader, useToast } from '../../components/ui.jsx';
import { fmtDate } from '../../format.js';

export default function Profile() {
  useDocumentTitle('My account');
  const { user, setUser, replaceSession } = useAuth();
  const toast = useToast();

  const details = useForm({ name: user.name, companyName: user.companyName || '', phone: user.phone || '' });
  const [savingDetails, setSavingDetails] = useState(false);
  const pw = useForm({ currentPassword: '', newPassword: '', confirm: '' });
  const [savingPw, setSavingPw] = useState(false);
  const [pwError, setPwError] = useState('');

  const saveDetails = async (e) => {
    e.preventDefault();
    if (!details.values.name.trim()) {
      details.setErrors({ name: 'Name is required' });
      return;
    }
    setSavingDetails(true);
    try {
      const r = await api.patch('/c/account', { name: details.values.name, companyName: details.values.companyName, phone: details.values.phone });
      setUser(r.user);
      toast.success('Account details saved');
    } catch (err) {
      details.setErrors(err.fields || {});
      toast.error(err);
    } finally {
      setSavingDetails(false);
    }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    const next = {};
    if (!pw.values.currentPassword) next.currentPassword = 'Enter your current password';
    if (pw.values.newPassword.length < 8) next.newPassword = 'Use at least 8 characters, with a letter and a number';
    if (pw.values.newPassword !== pw.values.confirm) next.confirm = 'Passwords do not match';
    pw.setErrors(next);
    setPwError('');
    if (Object.keys(next).length) return;
    setSavingPw(true);
    try {
      const r = await api.post('/auth/change-password', { currentPassword: pw.values.currentPassword, newPassword: pw.values.newPassword });
      replaceSession(r.token, r.user); // the old token is now invalid; keep this tab signed in
      pw.setValues({ currentPassword: '', newPassword: '', confirm: '' });
      toast.success('Password changed. Other devices have been signed out.');
    } catch (err) {
      pw.setErrors(err.fields || {});
      setPwError(errorMessage(err));
    } finally {
      setSavingPw(false);
    }
  };

  return (
    <>
      <PageHeader title="My account" subtitle="Your sign-in details and security." />
      <div className="grid grid-2">
        <Card title="Profile">
          <dl className="kv mb">
            <dt>Email</dt>
            <dd>{user.email}</dd>
            <dt>Role</dt>
            <dd style={{ textTransform: 'capitalize' }}>{user.role}</dd>
            <dt>Last sign-in</dt>
            <dd>{fmtDate(user.lastLoginAt)}</dd>
          </dl>
          {user.role === 'customer' ? (
            <form onSubmit={saveDetails} noValidate>
              <Field label="Name" error={details.errors.name} required>
                <input {...details.bind('name')} maxLength={120} />
              </Field>
              <Field label="Company" error={details.errors.companyName}>
                <input {...details.bind('companyName')} maxLength={160} />
              </Field>
              <Field label="Phone" error={details.errors.phone}>
                <input {...details.bind('phone')} maxLength={40} />
              </Field>
              <Button type="submit" variant="primary" loading={savingDetails}>
                Save details
              </Button>
            </form>
          ) : (
            <p className="muted small">Your name and email are managed by an administrator.</p>
          )}
        </Card>
        <Card title="Change password">
          {pwError ? <Alert tone="danger">{pwError}</Alert> : null}
          <form onSubmit={changePassword} noValidate>
            <Field label="Current password" error={pw.errors.currentPassword}>
              <input type="password" autoComplete="current-password" {...pw.bind('currentPassword')} />
            </Field>
            <Field label="New password" error={pw.errors.newPassword} hint="At least 8 characters, with a letter and a number">
              <input type="password" autoComplete="new-password" {...pw.bind('newPassword')} />
            </Field>
            <Field label="Confirm new password" error={pw.errors.confirm}>
              <input type="password" autoComplete="new-password" {...pw.bind('confirm')} />
            </Field>
            <Button type="submit" variant="primary" loading={savingPw}>
              Change password
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}
