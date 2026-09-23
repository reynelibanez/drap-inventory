import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Clock, CloudOff, Loader2, RefreshCw } from 'lucide-react';
import { ApiError } from '../../lib/api';
import { useMeta } from '../../lib/meta';
import { checkNow, discardOp, durable, editOpSerial, kick, retryAll, retryOp, useOnline, useOps, useSyncState, waitingFor, dependentsOf, type Op } from '../../lib/offline';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, useConfirm, useErr, useToast } from '../../components/ui';

/** Resumen corto de lo que hace una acción guardada (tipo, serie, cantidad…). */
function useOpSummary() {
  const { t } = useTranslation();
  const meta = useMeta();
  return (op: Op): { title: string; detail: string } => {
    const b = (op.body ?? {}) as any;
    const title = t(`sync.op.${op.kind.replace('.', '_')}`);
    const parts: string[] = [];
    if (op.kind === 'lot.create') {
      if (b.reference) parts.push(b.reference);
      parts.push(t('sync.lines_count', { count: (b.lines ?? []).length }));
    } else if (op.kind === 'unit.create' || op.kind === 'unit.finish') {
      const type = b.equipmentTypeId ? meta.typeName(b.equipmentTypeId) : '';
      if (type) parts.push(type);
      if (b.serialNumber) parts.push(`S/N ${b.serialNumber}`);
      if (op.kind === 'unit.finish') {
        const g = [meta.item(b.cosmeticGradeId)?.code, meta.item(b.functionalGradeId)?.code].filter(Boolean).join('/');
        if (g) parts.push(g);
      }
      if (op.temp?.code) parts.push(op.temp.code);
    } else if (op.kind === 'catalog.item') {
      if (b.name) parts.push(b.name);
      if (b.parentItemId) parts.push(meta.name(b.parentItemId));
    } else if (op.kind === 'unit.update' && b.serialNumber) parts.push(`S/N ${b.serialNumber}`);
    else if (op.kind === 'lot.counts') parts.push(t('sync.lines_count', { count: (b.counts ?? []).length }));
    else if (op.kind === 'line.add' || op.kind === 'line.update' || op.kind === 'line.unexpected') {
      if (b.equipmentTypeId) parts.push(meta.typeName(b.equipmentTypeId));
      const qty = b.expectedQty ?? b.countedQty;
      if (qty !== undefined) parts.push(`× ${qty}`);
    } else if (op.kind === 'partner.create' || op.kind === 'partner.update') {
      if (b.name) parts.push(b.name);
    } else if (op.kind === 'asset.create' || op.kind === 'asset.update') {
      if (b.equipmentTypeId) parts.push(meta.typeName(b.equipmentTypeId));
      if (b.serialNumber) parts.push(`S/N ${b.serialNumber}`);
      if (op.kind === 'asset.create' && (b.quantity ?? 1) > 1) parts.push(`× ${b.quantity}`);
    } else if (op.kind === 'order.create' || op.kind === 'quick.sale') {
      if (op.temp?.code) parts.push(op.temp.code);
      const n = (b.fromUnitIds ?? b.unitIds ?? b.codes ?? []).length;
      if (n) parts.push(t('sync.units_count', { count: n }));
    } else if (op.kind === 'order.items' || op.kind === 'order.items_remove' || op.kind === 'loc.assign' || op.kind === 'loc.unassign' || op.kind === 'unit.costs' || op.kind === 'unit.prices') {
      const n = (b.unitIds ?? b.assignments ?? b.itemIds ?? []).length;
      if (n) parts.push(t('sync.units_count', { count: n }));
    } else if (op.kind === 'lot.transition' && b.action) parts.push(t(`lots.action.${b.action}`, { defaultValue: b.action }));
    return { title, detail: parts.join(' · ') };
  };
}

export default function SyncPage() {
  const { t, i18n } = useTranslation();
  const ops = useOps();
  const online = useOnline();
  const sync = useSyncState();
  const err = useErr();
  const toast = useToast();
  const confirm = useConfirm();
  const summary = useOpSummary();
  const [fixing, setFixing] = useState<Op | null>(null);
  const [serial, setSerial] = useState('');
  const [checking, setChecking] = useState(false);

  const pending = ops.filter((o) => o.state === 'pending').length;
  const failed = ops.filter((o) => o.state === 'failed').length;
  const fmt = useMemo(() => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' }), [i18n.language]);

  const errText = (o: Op) => (o.error ? err(new ApiError(o.error.status, o.error.code, o.error.params)) : '');

  async function discard(o: Op) {
    const more = dependentsOf(o).length;
    if (!(await confirm({
      title: t('sync.discard_title'), danger: true, confirmLabel: t('sync.discard'),
      message: <><p>{t('sync.discard_msg')}</p>{more > 0 && <p><strong>{t('sync.discard_more', { count: more })}</strong></p>}</>,
    }))) return;
    await discardOp(o.seq);
  }

  async function syncNow() {
    setChecking(true);
    try { if (await checkNow()) { await retryAll(); await kick(); } else toast.error(t('sync.offline')); } finally { setChecking(false); }
  }

  return (
    <>
      <PageHeader title={t('sync.title')} subtitle={t('sync.subtitle')}
        actions={<Button variant="primary" icon={<RefreshCw size={16} />} loading={checking || sync.syncing} onClick={() => void syncNow()}>{t('sync.sync_now')}</Button>} />

      <div className="grid grid-3 sync-kpis">
        <div className="card kpi">
          <span className="kpi-value" style={{ color: online ? 'var(--good)' : 'var(--warn)' }}>{online ? t('sync.online') : t('sync.offline')}</span>
          <span className="kpi-label">{t('sync.connection')}</span>
        </div>
        <div className="card kpi"><span className="kpi-value">{pending}</span><span className="kpi-label">{t('sync.pending')}</span></div>
        <div className="card kpi"><span className="kpi-value" style={{ color: failed ? 'var(--danger)' : undefined }}>{failed}</span><span className="kpi-label">{t('sync.failed')}</span></div>
      </div>

      {sync.needsLogin && <div className="alert alert-bad" style={{ marginTop: 12 }}>{t('sync.login_needed')}</div>}
      {!durable() && <div className="alert alert-warn" style={{ marginTop: 12 }}>{t('sync.not_durable')}</div>}
      <div className="alert alert-info" style={{ marginTop: 12 }}>{t('sync.can_do')}</div>

      <Card className="sync-list" padded={false} title={<span className="row">{t('sync.title')}<span className="muted">{sync.lastSyncAt ? `· ${t('sync.last_sync')}: ${fmt.format(sync.lastSyncAt)}` : ''}</span></span>}
        actions={failed > 0 ? <Button size="sm" onClick={() => void retryAll()}>{t('sync.retry_all')}</Button> : undefined}>
        {ops.length === 0 ? <Empty icon={<CheckCircle2 size={32} />} title={t('sync.empty')} hint={t('sync.empty_hint')} /> : (
          <ul className="sync-ops">
            {ops.map((o) => {
              const s = summary(o);
              const waiting = o.state === 'pending' ? waitingFor(o) : undefined;
              const sending = sync.syncing && o.state === 'pending' && !waiting && ops.find((x) => x.state === 'pending' && !waitingFor(x))?.seq === o.seq;
              return (
                <li key={o.seq} className={`sync-op ${o.state}`}>
                  <div className="sync-op-icon">{o.state === 'failed' ? <AlertTriangle size={18} /> : sending ? <Loader2 size={18} className="spin" /> : waiting ? <Clock size={18} /> : !online ? <CloudOff size={18} /> : <Clock size={18} />}</div>
                  <div className="sync-op-main">
                    <div className="row spread">
                      <strong>{s.title}</strong>
                      {o.state === 'failed' ? <Badge tone="bad">{t('sync.state_failed')}</Badge> : sending ? <Badge tone="info">{t('sync.state_sending')}</Badge> : waiting ? <Badge tone="neutral">{t('sync.state_waiting')}</Badge> : <Badge tone="warn">{t('sync.state_pending')}</Badge>}
                    </div>
                    {s.detail && <div className="sub">{s.detail}</div>}
                    <div className="sub">{fmt.format(o.created)}{o.attempts > 0 && ` · ${t('sync.attempts', { count: o.attempts })}`}</div>
                    {waiting && <div className="sub">{t('sync.waiting_for', { what: summary(waiting).title })}</div>}
                    {o.state === 'failed' && <div className="alert alert-bad sync-err">{errText(o)}</div>}
                    {o.state === 'failed' && (
                      <div className="row wrap gap-sm sync-actions">
                        <Button size="sm" icon={<RefreshCw size={14} />} onClick={() => void retryOp(o.seq)}>{t('sync.retry')}</Button>
                        {o.error?.code === 'serial_duplicate' && o.body && 'serialNumber' in (o.body as object) && (
                          <Button size="sm" onClick={() => { setFixing(o); setSerial(String((o.body as any).serialNumber ?? '')); }}>{t('sync.edit_serial')}</Button>
                        )}
                        <Button size="sm" variant="danger" onClick={() => void discard(o)}>{t('sync.discard')}</Button>
                      </div>
                    )}
                    {o.state === 'pending' && waiting?.state === 'failed' && (
                      <div className="row wrap gap-sm sync-actions"><Button size="sm" variant="danger" onClick={() => void discard(o)}>{t('sync.discard')}</Button></div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Modal open={!!fixing} onClose={() => setFixing(null)} title={t('sync.serial_title')} size="sm"
        footer={<><Button variant="ghost" onClick={() => setFixing(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!serial.trim()} onClick={() => { if (fixing) void editOpSerial(fixing.seq, serial); setFixing(null); }}>{t('sync.save_retry')}</Button></>}>
        <Field label={t('sync.serial_label')}><Input value={serial} autoFocus autoComplete="off" spellCheck={false} onChange={(e) => setSerial(e.target.value)} /></Field>
      </Modal>
    </>
  );
}
