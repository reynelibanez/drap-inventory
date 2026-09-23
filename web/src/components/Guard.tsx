import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Empty } from './ui';

/** Muestra la pantalla solo si el usuario tiene alguna de las funciones indicadas. */
export function Guard({ perm, children }: { perm?: string | string[]; children: ReactNode }) {
  const { t } = useTranslation();
  const { canAny } = useAuth();
  const list = perm === undefined ? [] : Array.isArray(perm) ? perm : [perm];
  if (list.length && !canAny(...list)) return <Empty icon={<ShieldAlert size={32} />} title={t('errors.missing_permission')} />;
  return <>{children}</>;
}
