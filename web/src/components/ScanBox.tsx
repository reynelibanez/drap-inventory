import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ScanLine } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useErr, useToast } from './ui';

/** Caja de escaneo: un código de equipo, activo o lote lleva directo a su ficha. */
export function ScanBox({ autoFocus, onDone, className = 'scan' }: { autoFocus?: boolean; onDone?: () => void; className?: string }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { can } = useAuth();
  const err = useErr();
  const toast = useToast();
  const [v, setV] = useState('');

  const open = (to: string) => { nav(to); setV(''); onDone?.(); };

  async function go(e: FormEvent) {
    e.preventDefault();
    const code = v.trim();
    if (!code) return;
    try {
      if (can('units.view')) {
        try {
          const r = await api.get<{ id: number }>(`/units/lookup?code=${encodeURIComponent(code)}`);
          return open(`/units/${r.id}`);
        } catch (x: any) { if (x?.status !== 404 || !(can('lots.view') || can('assets.view'))) throw x; }
      }
      if (can('assets.view')) {
        try {
          const r = await api.get<{ id: number }>(`/assets/lookup?code=${encodeURIComponent(code)}`);
          return open(`/assets/${r.id}`);
        } catch (x: any) { if (x?.status !== 404 || !can('lots.view')) throw x; }
      }
      if (can('lots.view')) {
        const r = await api.get<{ items: { id: number; code: string }[] }>(`/lots?q=${encodeURIComponent(code)}&pageSize=5`);
        const exact = r.items.find((l) => l.code.toLowerCase() === code.toLowerCase()) ?? (r.items.length === 1 ? r.items[0] : null);
        if (exact) return open(`/lots/${exact.id}`);
      }
      toast.info(t('shell.scan_not_found', { code }));
    } catch (x) { toast.error(err(x)); }
  }
  if (!can('units.view') && !can('lots.view') && !can('assets.view')) return <div className={className} />;
  return (
    <form className={className} onSubmit={go}>
      <div className="search">
        <ScanLine size={16} />
        <input className="input" value={v} onChange={(e) => setV(e.target.value)} placeholder={t('shell.scan_placeholder')} aria-label={t('shell.scan_placeholder')}
          autoFocus={autoFocus} inputMode="search" enterKeyHint="search" autoCapitalize="off" autoCorrect="off" />
      </div>
    </form>
  );
}
