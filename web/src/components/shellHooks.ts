import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../lib/auth';
import { syncPush } from '../lib/push';
import { pendingCount } from '../lib/offline';
import { useNotificationBridge } from './NotificationBell';
import { useConfirm } from './ui';

/** Lo que comparten el menú de escritorio y el del teléfono: avisos push, registro del dispositivo y "salir" (con aviso si hay pendientes). */
export function useShellCommon() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const confirm = useConfirm();
  useNotificationBridge();
  // Deja este dispositivo registrado para los avisos push de quien inició sesión (si ya los había activado).
  useEffect(() => { void syncPush().catch(() => undefined); }, [user?.id]);
  const doLogout = async () => {
    if (pendingCount() > 0 && !(await confirm({ title: t('nav.logout'), message: t('sync.logout_pending'), confirmLabel: t('nav.logout') }))) return;
    await logout();
  };
  return { doLogout };
}
