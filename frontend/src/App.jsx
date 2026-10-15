import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { homeFor, useAuth } from './auth.jsx';
import Shell from './components/Shell.jsx';
import { Button, Spinner } from './components/ui.jsx';
import { Link } from 'react-router-dom';
import { ForgotPasswordPage, LoginPage, ResetPasswordPage } from './pages/auth/AuthPages.jsx';
import AuditLog from './pages/shared/AuditLog.jsx';
import Customers, { CustomerDetail } from './pages/shared/Customers.jsx';
import Profile from './pages/shared/Profile.jsx';
import AdminDashboard from './pages/admin/AdminDashboard.jsx';
import Resellers, { ResellerDetail } from './pages/admin/Resellers.jsx';
import Settings from './pages/admin/Settings.jsx';
import Voice from './pages/admin/Voice.jsx';
import WhatsAppApi from './pages/admin/WhatsAppApi.jsx';
import ResellerDashboard from './pages/reseller/ResellerDashboard.jsx';
import Dashboard from './pages/customer/Dashboard.jsx';
import Contacts from './pages/customer/Contacts.jsx';
import Templates from './pages/customer/Templates.jsx';
import Campaigns from './pages/customer/Campaigns.jsx';
import CampaignForm from './pages/customer/CampaignForm.jsx';
import CampaignDetail from './pages/customer/CampaignDetail.jsx';
import VoiceCampaignForm from './pages/customer/VoiceCampaignForm.jsx';
import WhatsApp from './pages/customer/WhatsApp.jsx';
import Usage from './pages/customer/Usage.jsx';
import MediaLibrary from './pages/customer/MediaLibrary.jsx';
import Credits from './pages/customer/Credits.jsx';

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
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      <Route path="/admin" element={<RequireRole roles={['admin']} />}>
        <Route index element={<AdminDashboard />} />
        <Route path="resellers" element={<Resellers />} />
        <Route path="resellers/:id" element={<ResellerDetail />} />
        <Route path="customers" element={<Customers role="admin" />} />
        <Route path="customers/:id" element={<CustomerDetail role="admin" />} />
        <Route path="audit" element={<AuditLog endpoint="/admin/audit" title="Audit log" subtitle="Every sensitive action on the platform." />} />
        <Route path="voice" element={<Voice />} />
        <Route path="whatsapp-api" element={<WhatsAppApi />} />
        <Route path="settings" element={<Settings />} />
        <Route path="profile" element={<Profile />} />
      </Route>

      <Route path="/reseller" element={<RequireRole roles={['reseller']} />}>
        <Route index element={<ResellerDashboard />} />
        <Route path="customers" element={<Customers role="reseller" />} />
        <Route path="customers/:id" element={<CustomerDetail role="reseller" />} />
        <Route path="audit" element={<AuditLog endpoint="/reseller/audit" title="Activity" subtitle="Your actions and your customers' account activity." />} />
        <Route path="profile" element={<Profile />} />
      </Route>

      <Route path="/app" element={<RequireRole roles={['customer', 'reseller']} />}>
        <Route index element={<Dashboard />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="templates" element={<Templates />} />
        <Route path="campaigns" element={<Campaigns />} />
        <Route path="campaigns/new" element={<CampaignForm />} />
        <Route path="campaigns/:id/edit" element={<CampaignForm />} />
        <Route path="campaigns/:id" element={<CampaignDetail />} />
        <Route path="voice" element={<Campaigns channel="voice" />} />
        <Route path="voice/new" element={<VoiceCampaignForm />} />
        <Route path="voice/:id/edit" element={<VoiceCampaignForm />} />
        <Route path="whatsapp" element={<WhatsApp />} />
        <Route path="media" element={<MediaLibrary />} />
        <Route path="credits" element={<Credits />} />
        <Route path="usage" element={<Usage />} />
        <Route path="activity" element={<AuditLog endpoint="/c/audit" title="Activity log" subtitle="What happened in your account." showActor={false} />} />
        <Route path="profile" element={<Profile />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
