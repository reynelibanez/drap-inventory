import type { ComponentProps } from 'react';
import {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type ButtonHTMLAttributes, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, HardDrive, Info, Laptop, Loader2, MemoryStick, Monitor, Package, PcCase, Search, X,
  type LucideIcon,
} from 'lucide-react';
import { ApiError } from '../lib/api';
import { useMeta } from '../lib/meta';
import { useIsMobile } from '../lib/useIsMobile';
import { BottomSheet } from './mobile/BottomSheet';

// ---------- Botones ----------
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode };
export function Button({ variant = 'secondary', size = 'md', loading, icon, children, className = '', disabled, ...rest }: BtnProps) {
  return (
    <button type="button" className={`btn btn-${variant} btn-${size} ${className}`} disabled={disabled || loading} {...rest}>
      {loading ? <Loader2 size={16} className="spin" /> : icon}
      {children}
    </button>
  );
}

// ---------- Campos de formulario ----------
export function Field({ label, hint, error, required, children, className = '' }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${error ? 'has-error' : ''} ${className}`}>
      {label && <span className="field-label">{label}{required && <span className="req"> *</span>}</span>}
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}
export const Input = (p: ComponentProps<'input'>) => <input {...p} className={`input ${p.className ?? ''}`} />;
export const Textarea = (p: ComponentProps<'textarea'>) => <textarea {...p} className={`input ${p.className ?? ''}`} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`input ${p.className ?? ''}`} />;

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className={`checkbox ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

// ---------- Contenedores ----------
export const Card = ({ children, className = '', title, actions, padded = true }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; padded?: boolean }) => (
  <section className={`card ${className}`}>
    {(title || actions) && <header className="card-head"><h3>{title}</h3><div className="row gap-sm">{actions}</div></header>}
    <div className={padded ? 'card-body' : ''}>{children}</div>
  </section>
);

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-titles">
        {back && <div className="page-back">{back}</div>}
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions row gap-sm wrap">{actions}</div>}
    </div>
  );
}

/** Cantidad con botones − / + grandes (para el dedo). Se puede escribir el número directamente. */
export function Stepper({ value, onChange, min = 0, max, label, disabled, id, start = 0, placeholder }: {
  value: number | ''; onChange: (v: number | '') => void; min?: number; max?: number; label?: string; disabled?: boolean; id?: string;
  /** Valor de partida al tocar − o + cuando el campo está vacío. */
  start?: number; placeholder?: string;
}) {
  const { t } = useTranslation();
  const n = value === '' ? start : value;
  const clamp = (x: number) => Math.min(max ?? Infinity, Math.max(min, x));
  return (
    <div className={`stepper ${disabled ? 'disabled' : ''}`}>
      <button type="button" className="stepper-btn" disabled={disabled || n <= min} onClick={() => onChange(clamp(n - 1))} aria-label={t('mobile.step_minus')}>−</button>
      <input id={id} className="stepper-input" type="number" inputMode="numeric" min={min} max={max} value={value} disabled={disabled} aria-label={label} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === '' ? '' : clamp(Math.floor(Number(e.target.value))))} onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="stepper-btn" disabled={disabled || (max !== undefined && n >= max)} onClick={() => onChange(clamp(n + 1))} aria-label={t('mobile.step_plus')}>+</button>
    </div>
  );
}

export const Spinner = () => <div className="center"><div className="spinner" /></div>;

export function Empty({ icon, title, hint, action }: { icon?: ReactNode; title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon ?? <Package size={32} />}</div>
      <strong>{title}</strong>
      {hint && <p className="muted">{hint}</p>}
      {action}
    </div>
  );
}

export function Badge({ children, color, tone = 'neutral', title }: { children: ReactNode; color?: string | null; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info'; title?: string }) {
  const style = color ? { background: `${color}22`, color, borderColor: `${color}55` } : undefined;
  return <span className={`badge ${color ? '' : `badge-${tone}`}`} style={style} title={title}>{children}</span>;
}

/** Valor de catálogo con su color (estados, grados...). */
export function ItemBadge({ id, code }: { id: number | null | undefined; code?: boolean }) {
  const meta = useMeta();
  const it = meta.item(id);
  if (!it) return <span className="muted">—</span>;
  return <Badge color={it.color} tone="neutral">{code && it.code ? it.code : meta.label(it.name)}</Badge>;
}

export function Progress({ value, max, tone }: { value: number; max: number; tone?: 'good' | 'warn' | 'bad' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return <div className="progress"><div className={`progress-bar ${tone ?? ''}`} style={{ width: `${pct}%` }} /></div>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void }) {
  const box = useRef<HTMLDivElement>(null);
  // Cuando las pestañas no caben (teléfono), la elegida se desplaza hasta quedar a la vista.
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el && box.current && box.current.scrollWidth > box.current.clientWidth) box.current.scrollTo({ left: el.offsetLeft - (box.current.clientWidth - el.offsetWidth) / 2, behavior: 'smooth' });
  }, [value]);
  return (
    <div className="tabs" role="tablist" ref={box}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}{t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------- Búsqueda y paginación ----------
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function SearchInput({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  return (
    <div className="search">
      <Search size={16} />
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} />
      {value && <button className="icon-btn" onClick={() => onChange('')} aria-label="clear"><X size={14} /></button>}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return total ? <div className="pagination muted">{t('common.total', { count: total })}</div> : null;
  return (
    <div className="pagination">
      <span className="muted">{t('common.total', { count: total })}</span>
      <div className="row gap-sm">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} icon={<ChevronLeft size={16} />} aria-label="prev" />
        <span>{page} / {pages}</span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)} icon={<ChevronRight size={16} />} aria-label="next" />
      </div>
    </div>
  );
}

// ---------- Modal ----------
export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const id = useId();
  const mobile = useIsMobile();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [open, onClose]);
  if (!open) return null;
  // En el teléfono los cuadros de diálogo son hojas que suben desde abajo.
  if (mobile) return <BottomSheet open onClose={onClose} title={title} footer={footer} full={size === 'lg' || size === 'xl'}>{children}</BottomSheet>;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-labelledby={id}>
        <header className="modal-head">
          <h3 id={id}>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="close"><X size={18} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

// ---------- Avisos ----------
interface ToastItem { id: number; kind: 'success' | 'error' | 'info'; text: string }
const ToastCtx = createContext<{ success(t: string): void; error(t: string): void; info(t: string): void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((kind: ToastItem['kind'], text: string) => {
    const id = ++seq.current;
    setItems((l) => [...l, { id, kind, text }]);
    setTimeout(() => setItems((l) => l.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  const api = useMemo(() => ({ success: (t: string) => push('success', t), error: (t: string) => push('error', t), info: (t: string) => push('info', t) }), [push]);
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((i) => (
          <div key={i.id} className={`toast toast-${i.kind}`} onClick={() => setItems((l) => l.filter((x) => x.id !== i.id))}>
            {i.kind === 'success' ? <CheckCircle2 size={18} /> : i.kind === 'error' ? <AlertTriangle size={18} /> : <Info size={18} />}
            <span>{i.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => { const v = useContext(ToastCtx); if (!v) throw new Error('ToastProvider'); return v; };

/** Convierte un error de la API en un mensaje en el idioma actual. */
export function useErr() {
  const { t } = useTranslation();
  let meta: ReturnType<typeof useMeta> | null = null;
  try { meta = useMeta(); } catch { /* fuera de empresa (login) */ }
  return useCallback((e: unknown): string => {
    if (e instanceof ApiError) {
      const p: Record<string, any> = { ...e.params };
      if (typeof p.attribute === 'string' && meta) { const a = meta.attrByKey(p.attribute); if (a) p.attribute = meta.label(a.label); }
      if (e.code === 'validation') {
        const first = p.issues?.[0];
        return t('errors.validation', { field: first?.path ? ` (${first.path})` : '', message: first?.message ?? '' });
      }
      if (e.code === 'missing_permission') return t('errors.missing_permission');
      const key = `errors.${e.code}`;
      return t(key, { ...p, defaultValue: t('errors.generic') });
    }
    return t('errors.network');
  }, [t, meta]);
}

// ---------- Confirmación ----------
interface ConfirmOpts { title: ReactNode; message?: ReactNode; confirmLabel?: string; danger?: boolean }
const ConfirmCtx = createContext<((o: ConfirmOpts) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal open={!!state} onClose={() => close(false)} title={state?.title} size="sm"
        footer={<>
          <Button variant="ghost" onClick={() => close(false)}>{t('common.cancel')}</Button>
          <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>{state?.confirmLabel ?? t('common.confirm')}</Button>
        </>}>
        {state?.message}
      </Modal>
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => { const v = useContext(ConfirmCtx); if (!v) throw new Error('ConfirmProvider'); return v; };

// ---------- Iconos por tipo de equipo ----------
const ICONS: Record<string, LucideIcon> = { laptop: Laptop, 'pc-case': PcCase, monitor: Monitor, 'hard-drive': HardDrive, 'memory-stick': MemoryStick, package: Package };
export const TypeIcon = ({ icon, size = 18 }: { icon: string | null | undefined; size?: number }) => {
  const I = ICONS[icon ?? ''] ?? Package;
  return <I size={size} />;
};
export const iconNames = Object.keys(ICONS);
