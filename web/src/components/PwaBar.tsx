import { useTranslation } from 'react-i18next';
import { CloudOff, Download, RefreshCw } from 'lucide-react';
import { applyUpdate, installApp, usePwa } from '../lib/pwa';
import { useOnline } from '../lib/offline';
import { useToast } from './ui';

/** Botón "Instalar app" de la barra superior (solo cuando el navegador permite instalar). */
export function InstallButton() {
  const { t } = useTranslation();
  const pwa = usePwa();
  const toast = useToast();
  if (!pwa.canInstall || pwa.installed) return null;
  return (
    <button className="btn btn-ghost btn-sm install-btn" onClick={() => void installApp().then((ok) => { if (ok) toast.success(t('pwa.install_done')); })} title={t('pwa.install_hint')}>
      <Download size={15} /><span className="hidden-sm">{t('pwa.install_short')}</span>
    </button>
  );
}

/** Franja superior: sin conexión y versión nueva disponible. */
export function PwaBar() {
  const { t } = useTranslation();
  const pwa = usePwa();
  const online = useOnline();
  if (online && !pwa.updateReady) return null;
  return (
    <div className="pwa-bar no-print" role="status">
      {!online && <span className="pwa-msg offline"><CloudOff size={15} /> {t('pwa.offline')}</span>}
      {pwa.updateReady && (
        <span className="pwa-msg">
          <RefreshCw size={15} /> {t('pwa.update_ready')}
          <button className="btn btn-primary btn-sm" onClick={applyUpdate}>{t('pwa.update')}</button>
        </span>
      )}
    </div>
  );
}
