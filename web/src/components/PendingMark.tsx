import { useTranslation } from 'react-i18next';
import { CloudUpload } from 'lucide-react';

/** Marca "sin sincronizar": el dato está guardado en este dispositivo y se enviará al servidor al volver internet. */
export function PendingMark({ label = false }: { label?: boolean }) {
  const { t } = useTranslation();
  return <span className="pending-mark" title={t('sync.pending_hint')}><CloudUpload size={13} />{label && <span>{t('sync.pending_badge')}</span>}</span>;
}
