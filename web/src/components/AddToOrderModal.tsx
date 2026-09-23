import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Field, Modal, Select, useErr, useToast } from './ui';

/** Reserva los equipos elegidos en un pedido abierto (o crea uno nuevo para ellos). */
export function AddToOrderModal({ unitIds, onClose, onDone }: { unitIds: number[]; onClose: () => void; onDone?: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const err = useErr();
  const toast = useToast();
  const qc = useQueryClient();
  const orders = useQuery({ queryKey: ['orders', 'open'], queryFn: () => api.get<{ items: { id: number; code: string; customerName: string | null; itemCount: number; lineCount: number }[] }>('/orders?statusKey=open&pageSize=100'), staleTime: 0 });
  const customers = useQuery({ queryKey: ['customers', 'all'], queryFn: () => api.get<{ items: { id: number; name: string }[] }>('/customers?all=1'), enabled: can('sales.create') });
  const [orderId, setOrderId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [busy, setBusy] = useState(false);
  const creating = orderId === 'new';

  async function go() {
    setBusy(true);
    try {
      let id = Number(orderId);
      // Un pedido nuevo se crea con las líneas de los equipos elegidos (agrupados por tipo y características).
      if (creating) id = (await api.post<{ id: number }>('/orders', { customerId: Number(customerId), fromUnitIds: unitIds })).id;
      else await api.post(`/orders/${id}/items`, { unitIds });
      toast.success(t('addToOrder.done', { count: unitIds.length }));
      void qc.invalidateQueries({ queryKey: ['units'] }); void qc.invalidateQueries({ queryKey: ['orders'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] });
      onDone?.(); onClose();
      nav(`/orders/${id}`);
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} size="sm" title={t('addToOrder.title', { count: unitIds.length })}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" loading={busy} disabled={!orderId || (creating && !customerId)} onClick={go}>{t('addToOrder.reserve')}</Button></>}>
      <div className="stack">
        <Field label={t('addToOrder.order')}>
          <Select value={orderId} onChange={(e) => setOrderId(e.target.value)}>
            <option value="">{t('common.select')}</option>
            {can('sales.create') && <option value="new">{t('addToOrder.new_order')}</option>}
            {orders.data?.items.map((o) => <option key={o.id} value={o.id} disabled={o.lineCount === 0}>{o.code} — {o.customerName ?? '—'} ({o.itemCount}){o.lineCount === 0 ? ` · ${t('addToOrder.no_lines')}` : ''}</option>)}
          </Select>
        </Field>
        {orders.data?.items.some((o) => o.lineCount === 0) && <p className="muted" style={{ margin: 0, fontSize: 12 }}>{t('addToOrder.no_lines_hint')}</p>}
        {creating && (
          <Field label={t('orders.customer')} required>
            <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">{t('common.select')}</option>
              {customers.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}
