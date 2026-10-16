import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { homeFor, useAuth } from './auth.jsx';
import Shell from './components/Shell.jsx';
import { Button, Spinner } from './components/ui.jsx';
import { Link } from 'react-router-dom';

const ForgotPasswordPage = lazy(() => import('./pages/auth/AuthPages.jsx').then((m) => ({ default: m.ForgotPasswordPage })));
const LoginPage = lazy(() => import('./pages/auth/AuthPages.jsx').then((m) => ({ default: m.LoginPage })));
const ResetPasswordPage = lazy(() => import('./pages/auth/AuthPages.jsx').then((m) => ({ default: m.ResetPasswordPage })));
const AuditLog = lazy(() => import('./pages/shared/AuditLog.jsx'));
const Customers = lazy(() => import('./pages/shared/Customers.jsx'));
const CustomerDetail = lazy(() => import('./pages/shared/Customers.jsx').then((m) => ({ default: m.CustomerDetail })));
const Profile = lazy(() => import('./pages/shared/Profile.jsx'));
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard.jsx'));
const Resellers = lazy(() => import('./pages/admin/Resellers.jsx'));
const ResellerDetail = lazy(() => import('./pages/admin/Resellers.jsx').then((m) => ({ default: m.ResellerDetail })));
const Settings = lazy(() => import('./pages/admin/Settings.jsx'));
const Voice = lazy(() => import('./pages/admin/Voice.jsx'));
const WhatsAppApi = lazy(() => import('./pages/admin/WhatsAppApi.jsx'));
const ResellerDashboard = lazy(() => import('./pages/reseller/ResellerDashboard.jsx'));
const Dashboard = lazy(() => import('./pages/customer/Dashboard.jsx'));
const Contacts = lazy(() => import('./pages/customer/Contacts.jsx'));
const Templates = lazy(() => import('./pages/customer/Templates.jsx'));
const Campaigns = lazy(() => import('./pages/customer/Campaigns.jsx'));
const CampaignForm = lazy(() => import('./pages/customer/CampaignForm.jsx'));
const CampaignDetail = lazy(() => import('./pages/customer/CampaignDetail.jsx'));
const VoiceCampaignForm = lazy(() => import('./pages/customer/VoiceCampaignForm.jsx'));
const WhatsApp = lazy(() => import('./pages/customer/WhatsApp.jsx'));
const Usage = lazy(() => import('./pages/customer/Usage.jsx'));
const MediaLibrary = lazy(() => import('./pages/customer/MediaLibrary.jsx'));
const Credits = lazy(() => import('./pages/customer/Credits.jsx'));

function Page({ component: Component, ...props }) {
  return (
    <Suspense fallback={<Spinner />}>
      <Component {...props} />
    </Suspense>
  );
}

/** Only lets the listed roles through; anyone else is sent to their own panel (or to the sign-in page). */
function RequireRole({ roles }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner label="Checking your session…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return <Shell />;
}

function Home() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner label="Loading…" />;
  return <Navigate to={user ? homeFor(user.role) : '/login'} replace />;
}

function NotFound() {
  const { user } = useAuth();
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>Page not found</h1>
        <p className="muted">The page you opened does not exist.</p>
        <div className="mt">
          <Link to={user ? homeFor(user.role) : '/login'}>
            <Button variant="primary">Go to {user ? 'your dashboard' : 'sign in'}</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Page component={LoginPage} />} />
      <Route path="/forgot-password" element={<Page component={ForgotPasswordPage} />} />
      <Route path="/reset-password" element={<Page component={ResetPasswordPage} />} />

      <Route path="/admin" element={<RequireRole roles={['admin']} />}>
        <Route index element={<Page component={AdminDashboard} />} />
        <Route path="resellers" element={<Page component={Resellers} />} />
        <Route path="resellers/:id" element={<Page component={ResellerDetail} />} />
        <Route path="customers" element={<Page component={Customers} role="admin" />} />
        <Route path="customers/:id" element={<Page component={CustomerDetail} role="admin" />} />
        <Route path="audit" element={<Page component={AuditLog} endpoint="/admin/audit" title="Audit log" subtitle="Every sensitive action on the platform." />} />
        <Route path="voice" element={<Page component={Voice} />} />
        <Route path="whatsapp-api" element={<Page component={WhatsAppApi} />} />
        <Route path="settings" element={<Page component={Settings} />} />
        <Route path="profile" element={<Page component={Profile} />} />
      </Route>

      <Route path="/reseller" element={<RequireRole roles={['reseller']} />}>
        <Route index element={<Page component={ResellerDashboard} />} />
        <Route path="customers" element={<Page component={Customers} role="reseller" />} />
        <Route path="customers/:id" element={<Page component={CustomerDetail} role="reseller" />} />
        <Route path="audit" element={<Page component={AuditLog} endpoint="/reseller/audit" title="Activity" subtitle="Your actions and your customers' account activity." />} />
        <Route path="profile" element={<Page component={Profile} />} />
      </Route>

      <Route path="/app" element={<RequireRole roles={['customer', 'reseller']} />}>
        <Route index element={<Page component={Dashboard} />} />
        <Route path="contacts" element={<Page component={Contacts} />} />
        <Route path="templates" element={<Page component={Templates} />} />
        <Route path="campaigns" element={<Page component={Campaigns} />} />
        <Route path="campaigns/new" element={<Page component={CampaignForm} />} />
        <Route path="campaigns/:id/edit" element={<Page component={CampaignForm} />} />
        <Route path="campaigns/:id" element={<Page component={CampaignDetail} />} />
        <Route path="voice" element={<Page component={Campaigns} channel="voice" />} />
        <Route path="voice/new" element={<Page component={VoiceCampaignForm} />} />
        <Route path="voice/:id/edit" element={<Page component={VoiceCampaignForm} />} />
        <Route path="whatsapp" element={<Page component={WhatsApp} />} />
        <Route path="media" element={<Page component={MediaLibrary} />} />
        <Route path="credits" element={<Page component={Credits} />} />
        <Route path="usage" element={<Page component={Usage} />} />
        <Route path="activity" element={<Page component={AuditLog} endpoint="/c/audit" title="Activity log" subtitle="What happened in your account." showActor={false} />} />
        <Route path="profile" element={<Page component={Profile} />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
