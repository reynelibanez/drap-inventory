import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bell, CheckCheck, Settings2 } from 'lucide-react';
import { api } from '../lib/api';
import { onServiceWorkerMessage } from '../lib/pwa';
import { timeAgo } from '../lib/format';
import { useFmt } from '../lib/useFmt';

export interface Notif { id: number; event: string; title: string; body: string | null; url: string | null; readAt: string | null; createdAt: string }
export interface Inbox { items: Notif[]; hasMore: boolean; unreadCount: number }

export const NOTIF_KEYS = { count: ['notif', 'count'], recent: ['notif', 'recent'], inbox: ['notif', 'inbox'] } as const;

/**
 * Puente con el service worker: al llegar un aviso push refresca la campana, y al tocar una notificación
 * con la app abierta navega a su pantalla sin recargar. Se usa una vez, en el Shell.
 */
export function useNotificationBridge() {
  const qc = useQueryClient();
  const nav = useNavigate();
  useEffect(() => onServiceWorkerMessage((msg) => {
    if (msg.type === 'push') void qc.invalidateQueries({ queryKey: ['notif'] });
    if (msg.type === 'navigate' && msg.url) nav(msg.url);
  }), [qc, nav]);
}

/** Campana de la barra superior: contador de avisos sin leer y lista de los últimos. */
export function NotificationBell() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const fmt = useFmt();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const count = useQuery({
    queryKey: NOTIF_KEYS.count, queryFn: () => api.get<{ count: number }>('/notifications/unread-count'),
    refetchInterval: 60_000, refetchOnWindowFocus: true, staleTime: 10_000,
  });
  const recent = useQuery({ queryKey: NOTIF_KEYS.recent, queryFn: () => api.get<Inbox>('/notifications?limit=8'), enabled: open, staleTime: 0 });
  const unread = count.data?.count ?? 0;

  // Globo del icono de la app instalada (donde el navegador lo permite).
  useEffect(() => {
    const nv = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    try { void (unread > 0 ? nv.setAppBadge?.(unread) : nv.clearAppBadge?.()); } catch { /* no compatible */ }
  }, [unread]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['notif'] });
  const readOne = useMutation({ mutationFn: (id: number) => api.post('/notifications/read', { ids: [id] }), onSuccess: refresh });
  const readAll = useMutation({ mutationFn: () => api.post('/notifications/read', { all: true }), onSuccess: refresh });

  function openItem(n: Notif) {
    if (!n.readAt) readOne.mutate(n.id);
    setOpen(false);
    if (n.url) nav(n.url);
  }

  return (
    <div className="bell" ref={box}>
      <button className="icon-btn bell-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open}
        title={unread ? t('notif.bell_unread', { count: unread }) : t('notif.bell')} aria-label={unread ? t('notif.bell_unread', { count: unread }) : t('notif.bell')}>
        <Bell size={19} />
        {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-pop" role="dialog" aria-label={t('notif.title')}>
          <div className="bell-head">
            <strong>{t('notif.recent')}</strong>
            <span className="row gap-sm">
              {unread > 0 && <button className="icon-btn" onClick={() => readAll.mutate()} title={t('notif.mark_all')} aria-label={t('notif.mark_all')}><CheckCheck size={16} /></button>}
              <button className="icon-btn" onClick={() => { setOpen(false); nav('/notifications?tab=settings'); }} title={t('notif.settings')} aria-label={t('notif.settings')}><Settings2 size={16} /></button>
            </span>
          </div>
          <div className="bell-list">
            {recent.isLoading ? <div className="bell-empty muted">…</div>
              : !recent.data?.items.length ? <div className="bell-empty muted">{t('notif.empty')}</div>
              : recent.data.items.map((n) => (
                <button key={n.id} className={`bell-item ${n.readAt ? '' : 'unread'}`} onClick={() => openItem(n)}>
                  <span className="bell-dot" aria-hidden />
                  <span className="bell-text"><strong>{n.title}</strong>{n.body && <span className="muted">{n.body}</span>}<small className="muted" title={fmt.dateTime(n.createdAt)}>{timeAgo(n.createdAt, fmt.lang)}</small></span>
                </button>
              ))}
          </div>
          <button className="bell-foot" onClick={() => { setOpen(false); nav('/notifications'); }}>{t('notif.view_all')}</button>
        </div>
      )}
    </div>
  );
}
