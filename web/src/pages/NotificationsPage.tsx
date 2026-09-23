import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BellOff, BellRing, Check, Download, Laptop, Send, Smartphone, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { currentSubscription, disablePush, enablePush, pushPermission, pushSupported } from '../lib/push';
import { installApp, usePwa } from '../lib/pwa';
import { useFmt } from '../lib/useFmt';
import { NOTIF_KEYS, type Inbox, type Notif } from '../components/NotificationBell';
import { Badge, Button, Card, Checkbox, Empty, PageHeader, Spinner, Tabs, useConfirm, useErr, useToast } from '../components/ui';

type Tab = 'inbox' | 'settings';

interface Device { id: number; endpoint: string; userAgent: string | null; createdAt: string; lastUsedAt: string | null }
interface Pref { key: string; inApp: boolean; push: boolean }

/** "Chrome · Windows" a partir del texto que manda el navegador. */
function deviceName(ua: string | null): string {
  if (!ua) return '—';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}
const isMobileUa = (ua: string | null) => !!ua && /Android|iPhone|iPad|iPod/.test(ua);

export default function NotificationsPage() {
  const { t } = useTranslation();
  const [sp, setSp] = useSearchParams();
  const tab: Tab = sp.get('tab') === 'settings' ? 'settings' : 'inbox';
  return (
    <>
      <PageHeader title={t('notif.title')} subtitle={t('notif.subtitle')} />
      <Tabs<Tab> tabs={[{ id: 'inbox', label: t('notif.tab_inbox') }, { id: 'settings', label: t('notif.tab_settings') }]} value={tab}
        onChange={(v) => setSp(v === 'settings' ? { tab: 'settings' } : {}, { replace: true })} />
      {tab === 'inbox' ? <InboxTab /> : <SettingsTab />}
    </>
  );
}

// ---------------------------------------------------------------- Bandeja
function InboxTab() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const fmt = useFmt();
  const confirm = useConfirm();
  const err = useErr();
  const toast = useToast();
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [limit, setLimit] = useState(30);
  const q = useQuery({
    queryKey: [...NOTIF_KEYS.inbox, onlyUnread, limit],
    queryFn: () => api.get<Inbox>(`/notifications?limit=${limit}${onlyUnread ? '&unread=true' : ''}`),
    placeholderData: (prev) => prev,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['notif'] });
  const readOne = useMutation({ mutationFn: (id: number) => api.post('/notifications/read', { ids: [id] }), onSuccess: refresh, onError: (e) => toast.error(err(e)) });
  const readAll = useMutation({ mutationFn: () => api.post('/notifications/read', { all: true }), onSuccess: refresh, onError: (e) => toast.error(err(e)) });
  const del = useMutation({ mutationFn: (id: number) => api.del(`/notifications/${id}`), onSuccess: refresh, onError: (e) => toast.error(err(e)) });

  async function clearRead() {
    if (!(await confirm({ title: t('notif.clear_read'), message: t('notif.clear_read_confirm'), danger: true, confirmLabel: t('common.delete') }))) return;
    try { const r = await api.del<{ deleted: number }>('/notifications'); toast.success(t('notif.cleared', { count: r.deleted })); void refresh(); } catch (e) { toast.error(err(e)); }
  }
  function open(n: Notif) {
    if (!n.readAt) readOne.mutate(n.id);
    if (n.url) nav(n.url);
  }

  const items = q.data?.items ?? [];
  return (
    <>
      <div className="row wrap" style={{ marginBottom: 12, justifyContent: 'space-between' }}>
        <div className="seg">
          <button className={!onlyUnread ? 'on' : ''} onClick={() => setOnlyUnread(false)}>{t('notif.filter_all')}</button>
          <button className={onlyUnread ? 'on' : ''} onClick={() => setOnlyUnread(true)}>{t('notif.filter_unread')}{q.data?.unreadCount ? ` (${q.data.unreadCount})` : ''}</button>
        </div>
        <div className="row gap-sm">
          <Button size="sm" icon={<Check size={15} />} disabled={!q.data?.unreadCount} onClick={() => readAll.mutate()}>{t('notif.mark_all')}</Button>
          <Button size="sm" variant="ghost" icon={<Trash2 size={15} />} onClick={() => void clearRead()}>{t('notif.clear_read')}</Button>
        </div>
      </div>
      {q.isLoading ? <Spinner /> : items.length === 0 ? (
        <Empty icon={<BellOff size={28} />} title={t('notif.empty')} hint={t('notif.empty_hint')} />
      ) : (
        <Card padded={false}>
          <ul className="notif-list">
            {items.map((n) => (
              <li key={n.id} className={n.readAt ? '' : 'unread'}>
                <button className="notif-main" onClick={() => open(n)}>
                  <span className="bell-dot" aria-hidden />
                  <span className="bell-text"><strong>{n.title}</strong>{n.body && <span className="muted">{n.body}</span>}</span>
                  <small className="muted notif-when" title={fmt.dateTime(n.createdAt)}>{timeAgo(n.createdAt, fmt.lang)}</small>
                </button>
                <button className="icon-btn" title={t('common.delete')} aria-label={t('common.delete')} onClick={() => del.mutate(n.id)}><Trash2 size={15} /></button>
              </li>
            ))}
          </ul>
          {q.data?.hasMore && <div className="center" style={{ padding: 12 }}><Button size="sm" onClick={() => setLimit((l) => l + 30)}>{t('notif.load_more')}</Button></div>}
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Ajustes
function SettingsTab() {
  return (
    <div className="stack" style={{ gap: 16 }}>
      <DeviceCard />
      <InstallCard />
      <PrefsCard />
    </div>
  );
}

function DeviceCard() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const qc = useQueryClient();
  const pwa = usePwa();
  const err = useErr();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [perm, setPerm] = useState(pushPermission());
  const [endpoint, setEndpoint] = useState<string | null>(null);   // este navegador está suscrito con este endpoint
  const devices = useQuery({ queryKey: ['push', 'devices'], queryFn: () => api.get<{ items: Device[] }>('/push/subscriptions') });

  const reload = async () => {
    setPerm(pushPermission());
    setEndpoint((await currentSubscription())?.endpoint ?? null);
    void qc.invalidateQueries({ queryKey: ['push', 'devices'] });
  };
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Solo cuenta como "activo" si este navegador está suscrito Y el servidor lo tiene registrado a nombre de esta persona.
  const active = !!endpoint && !!devices.data?.items.some((d) => d.endpoint === endpoint);
  const supported = pushSupported();

  async function turnOn() {
    setBusy(true);
    try {
      const r = await enablePush();
      if (r === 'ok') toast.success(t('notif.enabled_ok'));
      else if (r === 'denied') toast.error(t('notif.denied_toast'));
      await reload();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  async function turnOff() {
    setBusy(true);
    try { await disablePush(); toast.success(t('notif.disabled_ok')); await reload(); } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true);
    try {
      const r = await api.post<{ devices: number; sent: number; failed: number }>('/push/test');
      if (r.devices === 0) toast.info(t('notif.test_none'));
      else if (r.sent > 0) toast.success(t('notif.test_sent', { count: r.sent }));
      else toast.error(t('notif.test_failed', { failed: r.failed, devices: r.devices }));
      void qc.invalidateQueries({ queryKey: ['push', 'devices'] });
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/push/subscriptions/${id}`),
    onSuccess: async (_r, id) => {
      // Si era este navegador, también se da de baja aquí para que no quede a medias.
      const mine = devices.data?.items.find((d) => d.id === id);
      if (mine && mine.endpoint === endpoint) { try { (await currentSubscription())?.unsubscribe(); } catch { /* nada */ } }
      toast.success(t('notif.device_removed')); await reload();
    },
    onError: (e) => toast.error(err(e)),
  });

  let note: string | null = null;
  if (!window.isSecureContext) note = t('notif.state_insecure');
  else if (!supported) note = !import.meta.env.PROD ? t('notif.state_dev') : pwa.ios && !pwa.installed ? t('notif.state_ios') : t('notif.state_unsupported');
  else if (perm === 'denied') note = t('notif.state_denied');

  return (
    <Card title={<span className="row gap-sm"><BellRing size={17} />{t('notif.device_title')}</span>}
      actions={supported && perm !== 'denied' && (active
        ? <><Button size="sm" icon={<Send size={14} />} loading={busy} onClick={() => void test()}>{t('notif.test')}</Button><Button size="sm" variant="ghost" loading={busy} onClick={() => void turnOff()}>{t('notif.disable')}</Button></>
        : <Button size="sm" variant="primary" icon={<BellRing size={14} />} loading={busy} onClick={() => void turnOn()}>{t('notif.enable')}</Button>)}>
      <p className="muted" style={{ marginTop: 0 }}>{t('notif.device_hint')}</p>
      <div className="row gap-sm" style={{ marginBottom: 10 }}>
        <Badge tone={active ? 'good' : note ? 'warn' : 'neutral'}>{active ? t('notif.state_active') : t('notif.state_off')}</Badge>
      </div>
      {note && <p className="notif-note">{note}</p>}

      <div className="section-title" style={{ marginTop: 14 }}>{t('notif.devices_title')}</div>
      <p className="muted" style={{ marginTop: 0 }}>{t('notif.devices_hint')}</p>
      {devices.isLoading ? <Spinner /> : !devices.data?.items.length ? <p className="muted">{t('notif.devices_none')}</p> : (
        <ul className="device-list">
          {devices.data.items.map((d) => (
            <li key={d.id}>
              {isMobileUa(d.userAgent) ? <Smartphone size={18} /> : <Laptop size={18} />}
              <span className="grow">
                <strong>{deviceName(d.userAgent)}</strong>{d.endpoint === endpoint && <> <Badge tone="info">{t('notif.this_device')}</Badge></>}
                <small className="muted" style={{ display: 'block' }}>
                  {t('notif.added', { date: fmt.date(d.createdAt) })}{d.lastUsedAt ? ` · ${t('notif.last_used', { date: timeAgo(d.lastUsedAt, fmt.lang) })}` : ''}
                </small>
              </span>
              <button className="icon-btn" title={t('notif.remove_device')} aria-label={t('notif.remove_device')} onClick={() => remove.mutate(d.id)}><Trash2 size={16} /></button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function InstallCard() {
  const { t } = useTranslation();
  const pwa = usePwa();
  const toast = useToast();
  return (
    <Card title={<span className="row gap-sm"><Download size={17} />{t('pwa.install_title')}</span>}
      actions={pwa.canInstall && !pwa.installed && <Button size="sm" variant="primary" icon={<Download size={14} />} onClick={() => void installApp().then((ok) => { if (ok) toast.success(t('pwa.install_done')); })}>{t('pwa.install')}</Button>}>
      <p className="muted" style={{ margin: 0 }}>{t('pwa.install_hint')}</p>
      <p style={{ margin: '8px 0 0' }}>{pwa.installed ? t('pwa.installed') : pwa.canInstall ? '' : pwa.ios ? t('pwa.install_ios') : t('pwa.install_manual')}</p>
    </Card>
  );
}

function PrefsCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useErr();
  const toast = useToast();
  const q = useQuery({ queryKey: ['notif', 'prefs'], queryFn: () => api.get<{ events: Pref[] }>('/notifications/prefs') });
  const save = useMutation({
    mutationFn: (p: { event: string; inApp: boolean; push: boolean }) => api.put('/notifications/prefs', { prefs: [p] }),
    onMutate: async (p) => {   // se ve el cambio al instante
      await qc.cancelQueries({ queryKey: ['notif', 'prefs'] });
      const prev = qc.getQueryData<{ events: Pref[] }>(['notif', 'prefs']);
      qc.setQueryData<{ events: Pref[] }>(['notif', 'prefs'], (d) => d && { events: d.events.map((e) => (e.key === p.event ? { ...e, inApp: p.inApp, push: p.push } : e)) });
      return { prev };
    },
    onError: (e, _p, ctx) => { qc.setQueryData(['notif', 'prefs'], ctx?.prev); toast.error(err(e)); },
  });
  return (
    <Card title={t('notif.prefs_title')}>
      <p className="muted" style={{ marginTop: 0 }}>{t('notif.prefs_hint')}</p>
      {q.isLoading ? <Spinner /> : (
        <table className="prefs-table">
          <thead><tr><th>{t('notif.col_event')}</th><th>{t('notif.col_inbox')}</th><th>{t('notif.col_push')}</th></tr></thead>
          <tbody>
            {q.data?.events.map((e) => (
              <tr key={e.key}>
                <td><strong>{t(`notif.ev.${e.key}`)}</strong><small className="muted" style={{ display: 'block' }}>{t(`notif.ev.${e.key}_desc`)}</small></td>
                <td><Checkbox checked={e.inApp} label="" onChange={(v) => save.mutate({ event: e.key, inApp: v, push: e.push })} /></td>
                <td><Checkbox checked={e.push} label="" onChange={(v) => save.mutate({ event: e.key, inApp: e.inApp, push: v })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
