import { useTranslation } from 'react-i18next';
import { LogOut, ShieldAlert } from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
import { BillingPanel } from '../components/BillingPanel';
import { useAuth } from '../lib/auth';
import { Button } from '../components/ui';

/**
 * Pantalla de bloqueo: se muestra en vez de todo el sistema cuando la suscripción de la empresa
 * está vencida/cancelada. Quien administra la facturación ve los planes ahí mismo para suscribirse;
 * el resto del equipo ve un aviso simple para que hable con su administrador.
 */
export default function BillingBlockedPage() {
  const { t } = useTranslation();
  const { user, company, access, can, logout } = useAuth();
  const canManage = !!user && (access?.isCompanyAdmin || can('billing.manage'));
  const status = access?.billing?.status;

  return (
    <div className="billing-blocked">
      <div className="billing-blocked-card" style={{ maxWidth: canManage ? 900 : 480 }}>
        <BrandMark size={64} />
        <h1 style={{ margin: '14px 0 4px', fontSize: 22 }}>
          <ShieldAlert size={20} style={{ verticalAlign: -3, color: 'var(--warn)' }} /> {t('billing.blocked_title')}
        </h1>
        <p className="muted" style={{ marginBottom: 22 }}>
          {status === 'canceled' ? t('billing.blocked_canceled', { company: company?.name }) : t('billing.blocked_trial', { company: company?.name })}
        </p>
        {canManage ? (
          <div style={{ textAlign: 'left' }}><BillingPanel /></div>
        ) : (
          <p className="muted">{t('billing.blocked_contact_admin')}</p>
        )}
        <div className="row" style={{ justifyContent: 'center', marginTop: 22 }}>
          <Button variant="ghost" onClick={() => void logout()} icon={<LogOut size={16} />}>{t('nav.logout')}</Button>
        </div>
      </div>
    </div>
  );
}
