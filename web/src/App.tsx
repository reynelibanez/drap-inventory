import { Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WifiOff } from 'lucide-react';
import { useAuth } from './lib/auth';
import { MetaProvider } from './lib/meta';
import { Shell } from './components/Shell';
import { Guard } from './components/Guard';
import { Button, Empty, Spinner } from './components/ui';
import { CompanyPickerPage, ForcePasswordPage, LoginPage } from './pages/Login';
import DashboardPage from './pages/Dashboard';
import LotsPage from './pages/lots/LotsPage';
import LotNewPage from './pages/lots/LotNewPage';
import LotImportPage from './pages/lots/LotImportPage';
import LotImportTechPage from './pages/lots/LotImportTechPage';
import LotDetailPage from './pages/lots/LotDetailPage';
import TestingPage from './pages/units/TestingPage';
import UnitsPage from './pages/units/UnitsPage';
import UnitDetailPage from './pages/units/UnitDetailPage';
import AssetsPage from './pages/assets/AssetsPage';
import AssetDetailPage from './pages/assets/AssetDetailPage';
import LocationsPage from './pages/locations/LocationsPage';
import OrdersPage from './pages/sales/OrdersPage';
import OrderDetailPage from './pages/sales/OrderDetailPage';
import QuickSalePage from './pages/sales/QuickSalePage';
import { CustomersPage, SellersPage, SuppliersPage } from './pages/partners/PartnerPages';
import CatalogsPage from './pages/settings/CatalogsPage';
import EquipmentPage from './pages/settings/EquipmentPage';
import LabelsPage from './pages/settings/LabelsPage';
import UsersPage from './pages/settings/UsersPage';
import RolesPage from './pages/settings/RolesPage';
import CompanySettingsPage from './pages/settings/CompanySettingsPage';
import AuditPage from './pages/settings/AuditPage';
import BillingPage from './pages/settings/BillingPage';
import BillingBlockedPage from './pages/BillingBlockedPage';
import PlatformPage from './pages/settings/PlatformPage';
import NotificationsPage from './pages/NotificationsPage';
import ProfilePage from './pages/ProfilePage';
import AppearancePage from './pages/AppearancePage';
import SyncPage from './pages/sync/SyncPage';
import PricingPage from './pages/pricing/PricingPage';
import ReportsPage from './pages/reports/ReportsPage';
import ReportRunPage from './pages/reports/ReportRunPage';
import ReportDesignerPage from './pages/reports/ReportDesignerPage';

const g = (perm: string | string[] | undefined, el: React.ReactNode) => <Guard perm={perm}>{el}</Guard>;

function NotFound() {
  const { t } = useTranslation();
  return <Empty title={t('common.not_found')} />;
}

/** Primera pantalla útil según los permisos del usuario. */
function Home() {
  const { can } = useAuth();
  if (can('dashboard.view')) return <DashboardPage />;
  if (can('lots.view')) return <Navigate to="/lots" replace />;
  if (can('units.view')) return <Navigate to="/units" replace />;
  if (can('assets.view')) return <Navigate to="/assets" replace />;
  return <Navigate to="/profile" replace />;
}

export default function App() {
  const { status, user, company, access, retryConnection } = useAuth();
  const { t } = useTranslation();
  if (status === 'unreachable') {
    return (
      <div className="center-screen">
        <Empty icon={<WifiOff size={32} />} title={t('pwa.unreachable_title')} hint={t('pwa.unreachable_hint')} action={<Button variant="primary" onClick={retryConnection}>{t('pwa.retry')}</Button>} />
      </div>
    );
  }
  if (status === 'loading') return <div className="center-screen"><Spinner /></div>;
  if (status === 'anon') return <LoginPage />;
  if (user?.mustChangePassword) return <ForcePasswordPage />;
  if (!company) return <CompanyPickerPage />;
  // Prueba vencida o suscripción cancelada: el admin de plataforma nunca queda bloqueado (para poder dar soporte).
  if (access?.billing?.blocked && !user?.isPlatformAdmin) return <BillingBlockedPage />;
  return (
    <MetaProvider>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Home />} />
          <Route path="login" element={<Navigate to="/" replace />} />
          <Route path="lots" element={g('lots.view', <LotsPage />)} />
          <Route path="lots/new" element={g('lots.create', <LotNewPage />)} />
          <Route path="lots/import" element={g('lots.import', <LotImportPage />)} />
          <Route path="lots/import-tech" element={g('lots.import', <LotImportTechPage />)} />
          <Route path="lots/:id" element={g('lots.view', <LotDetailPage />)} />
          <Route path="testing" element={g('units.test', <TestingPage />)} />
          <Route path="units" element={g('units.view', <UnitsPage />)} />
          <Route path="units/:id" element={g('units.view', <UnitDetailPage />)} />
          <Route path="assets" element={g('assets.view', <AssetsPage />)} />
          <Route path="assets/:id" element={g('assets.view', <AssetDetailPage />)} />
          <Route path="locations" element={g('locations.view', <LocationsPage />)} />
          <Route path="orders" element={g('sales.view', <OrdersPage />)} />
          <Route path="orders/quick" element={g('sales.create', <QuickSalePage />)} />
          <Route path="orders/:id" element={g('sales.view', <OrderDetailPage />)} />
          <Route path="pricing" element={g('prices.manage', <PricingPage />)} />
          <Route path="reports" element={g('reports.view', <ReportsPage />)} />
          <Route path="reports/new" element={g('reports.create', <ReportDesignerPage />)} />
          <Route path="reports/:id" element={g('reports.view', <ReportRunPage />)} />
          <Route path="reports/:id/edit" element={g('reports.view', <ReportDesignerPage />)} />
          <Route path="customers" element={g('customers.view', <CustomersPage />)} />
          <Route path="sellers" element={g('sellers.view', <SellersPage />)} />
          <Route path="suppliers" element={g('suppliers.view', <SuppliersPage />)} />
          <Route path="settings/catalogs" element={g('catalogs.view', <CatalogsPage />)} />
          <Route path="settings/equipment" element={g('equipment.view', <EquipmentPage />)} />
          <Route path="settings/labels" element={g('labels.manage', <LabelsPage />)} />
          <Route path="settings/users" element={g('users.view', <UsersPage />)} />
          <Route path="settings/roles" element={g('roles.view', <RolesPage />)} />
          <Route path="settings/company" element={g('settings.manage', <CompanySettingsPage />)} />
          <Route path="settings/billing" element={g('billing.manage', <BillingPage />)} />
          <Route path="settings/audit" element={g('audit.view', <AuditPage />)} />
          <Route path="platform" element={user?.isPlatformAdmin ? <PlatformPage /> : <NotFound />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="appearance" element={<AppearancePage />} />
          <Route path="sync" element={<SyncPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </MetaProvider>
  );
}
