import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CloudOff, Loader2, RefreshCw } from 'lucide-react';
import { onServerChange } from '../lib/api';
import { useAuth } from '../lib/auth';
import { kick, onQueued, setSyncListener, useOnline, useOps, useSyncState, warmCache } from '../lib/offline';
import { useToast } from './ui';

/** Efectos de fondo del trabajo sin conexión: recargar pantallas al sincronizar, avisar cambios de conexión y preparar la copia local. */
export function OfflineEffects() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const { can, company } = useAuth();
  const online = useOnline();
  const was = useRef(online);
  const canRef = useRef(can);
  canRef.current = can;

  useEffect(() => {
    setSyncListener(({ synced, remaining }) => {
      void qc.invalidateQueries();
      if (synced) toast.success(remaining ? t('sync.partial', { count: synced }) : t('sync.done', { count: synced }));
    });
    // Un equipo o lote guardado puede haber agregado modelos nuevos al catálogo: se recargan las sugerencias.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onServerChange(() => { if (timer) clearTimeout(timer); timer = setTimeout(() => void qc.invalidateQueries({ queryKey: ['meta'] }), 1500); });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [qc, toast, t]);

  // "Guardado sin conexión": un solo aviso aunque se guarden varias cosas seguidas.
  useEffect(() => {
    let last = 0;
    return onQueued((offline) => {
      if (!offline || Date.now() - last < 5000) return;
      last = Date.now();
      toast.info(t('sync.saved_offline'));
    });
  }, [toast, t]);

  useEffect(() => {
    if (was.current && !online) toast.info(t('sync.went_offline'));
    if (!was.current && online) { toast.info(t('sync.back_online')); void qc.invalidateQueries(); void kick(); void warmCache((p) => canRef.current(p), true); }
    was.current = online;
  }, [online, toast, t, qc]);

  // Copia local para trabajar sin conexión: al abrir la app y cada vez que se vuelve a ella.
  useEffect(() => {
    if (!company) return;
    const go = () => { if (document.visibilityState === 'visible') void warmCache((p) => canRef.current(p)); };
    const timer = setTimeout(go, 2500);
    document.addEventListener('visibilitychange', go);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', go); };
  }, [company?.id]);
  return null;
}

/** Estado de conexión y de lo pendiente por enviar (toca para ver el detalle). Solo se muestra cuando hay algo que decir. */
export function SyncChip() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const online = useOnline();
  const ops = useOps();
  const sync = useSyncState();
  const pending = ops.filter((o) => o.state === 'pending').length;
  const failed = ops.filter((o) => o.state === 'failed').length;
  if (online && !pending && !failed && !sync.needsLogin) return null;

  let tone = 'warn', icon = <CloudOff size={15} />, text = t('sync.chip_offline');
  if (failed) { tone = 'bad'; icon = <AlertTriangle size={15} />; text = t('sync.chip_failed', { count: failed }); }
  else if (sync.needsLogin) { tone = 'bad'; icon = <AlertTriangle size={15} />; text = t('sync.chip_login'); }
  else if (!online) text = pending ? t('sync.chip_offline_pending', { count: pending }) : t('sync.chip_offline');
  else if (sync.syncing) { tone = 'info'; icon = <Loader2 size={15} className="spin" />; text = t('sync.chip_syncing'); }
  else { tone = 'info'; icon = <RefreshCw size={15} />; text = t('sync.chip_pending', { count: pending }); }

  return (
    <button className={`sync-chip sync-${tone}`} onClick={() => nav('/sync')} title={t('sync.open')}>
      {icon}<span>{text}</span>
    </button>
  );
}
