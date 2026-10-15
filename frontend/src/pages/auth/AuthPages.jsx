import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../../api.js';
import { homeFor, useAuth } from '../../auth.jsx';
import { useDocumentTitle, useForm } from '../../hooks.js';
import { Alert, Button, Field } from '../../components/ui.jsx';

function AuthFrame({ title, subtitle, children }) {
  const { brandName } = useAuth();
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="muted small" style={{ fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase' }}>
          {brandName}
        </div>
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
        <div className="mt">{children}</div>
      </div>
    </div>
  );
}

export function LoginPage() {
  useDocumentTitle('Sign in');
  const { user, login, notice } = useAuth();
  const navigate = useNavigate();
  const { values, bind, errors, setErrors } = useForm({ email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (user) return <Navigate to={homeFor(user.role)} replace />;

  const submit = async (e) => {
    e.preventDefault();
    const next = {};
    if (!values.email.trim()) next.email = 'Enter your email address';
    if (!values.password) next.password = 'Enter your password';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError('');
    try {
      const u = await login(values.email.trim(), values.password);
      navigate(homeFor(u.role), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setErrors(err.fields || {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Sign in" subtitle="Admins, resellers and customers all sign in here.">
      {notice ? <Alert tone="warn">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <form onSubmit={submit} noValidate>
        <Field label="Email" error={errors.email}>
          <input type="email" autoComplete="username" {...bind('email')} placeholder="you@company.com" />
        </Field>
        <Field label="Password" error={errors.password}>
          <input type="password" autoComplete="current-password" {...bind('password')} />
        </Field>
        <Button type="submit" variant="primary" loading={busy} className="w-full" style={{ width: '100%' }}>
          Sign in
        </Button>
      </form>
      <p className="mt small">
        <Link to="/forgot-password">Forgot your password?</Link>
      </p>
    </AuthFrame>
  );
}

export function ForgotPasswordPage() {
  useDocumentTitle('Reset password');
  const { values, bind, errors, setErrors } = useForm({ email: '' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!values.email.trim()) {
      setErrors({ email: 'Enter your email address' });
      return;
    }
    setBusy(true);
    setError('');
    try {
      setResult(await api.post('/auth/forgot-password', { email: values.email.trim() }, { auth: false }));
    } catch (err) {
      setError(errorMessage(err));
      setErrors(err.fields || {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Forgot password" subtitle="We will email you a link to choose a new password.">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {result ? (
        <>
          <Alert tone="ok">{result.message}</Alert>
          {result.devResetLink ? (
            <Alert tone="info" title="Development mode: no email server is configured">
              Open the reset link directly: <a href={result.devResetLink.replace(/^https?:\/\/[^/]+/, '')}>Choose a new password</a>
            </Alert>
          ) : null}
        </>
      ) : (
        <form onSubmit={submit} noValidate>
          <Field label="Email" error={errors.email}>
            <input type="email" {...bind('email')} autoComplete="username" />
          </Field>
          <Button type="submit" variant="primary" loading={busy} style={{ width: '100%' }}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="mt small">
        <Link to="/login">← Back to sign in</Link>
      </p>
    </AuthFrame>
  );
}

export function ResetPasswordPage() {
  useDocumentTitle('Choose a new password');
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const { values, bind, errors, setErrors } = useForm({ password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    const next = {};
    if (values.password.length < 8) next.password = 'Use at least 8 characters, with a letter and a number';
    if (values.password !== values.confirm) next.confirm = 'Passwords do not match';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/reset-password', { token, password: values.password }, { auth: false });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
      setErrors(err.fields || {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Choose a new password">
      {!token ? <Alert tone="danger">This reset link is incomplete. Request a new one.</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {done ? (
        <Alert tone="ok" title="Password updated">
          You can now <Link to="/login">sign in</Link> with your new password.
        </Alert>
      ) : (
        <form onSubmit={submit} noValidate>
          <Field label="New password" error={errors.password} hint="At least 8 characters, with a letter and a number">
            <input type="password" autoComplete="new-password" {...bind('password')} />
          </Field>
          <Field label="Confirm new password" error={errors.confirm}>
            <input type="password" autoComplete="new-password" {...bind('confirm')} />
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={!token} style={{ width: '100%' }}>
            Update password
          </Button>
        </form>
      )}
      <p className="mt small">
        <Link to="/forgot-password">Request a new link</Link> · <Link to="/login">Sign in</Link>
      </p>
    </AuthFrame>
  );
}
