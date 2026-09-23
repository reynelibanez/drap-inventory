/**
 * Gráficas sencillas en SVG/CSS (sin librerías): dona, barras verticales, barras horizontales y barras apiladas.
 * Al cargar se animan (la dona se dibuja, las barras crecen y los números suben); quien tiene activada la opción del sistema
 * "reducir movimiento" las ve directamente completas. Las animaciones son de CSS (ver styles.css, "Gráficas").
 */
import { Link } from 'react-router-dom';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Número que sube de 0 (o del valor anterior) hasta el valor final. */
export function useCountUp(target: number, ms = 900): number {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));
  const shown = useRef(value);
  useEffect(() => {
    if (prefersReducedMotion() || ms <= 0) { shown.current = target; setValue(target); return; }
    const from = shown.current;
    if (from === target) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = Math.round(from + (target - from) * eased);
      shown.current = v; setValue(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/** Cantidad que sube animada. `format` da formato al número (por defecto, tal cual). */
export function CountUp({ value, format }: { value: number; format?: (n: number) => string }) {
  const v = useCountUp(value);
  return <>{format ? format(v) : v}</>;
}

const stagger = (i: number, step = 60): CSSProperties => ({ '--i': i, '--delay': `${i * step}ms` }) as CSSProperties;

export const PALETTE = ['#1277B0', '#2AB6E6', '#f59e0b', '#8b5cf6', '#16a34a', '#dc2626', '#db2777', '#64748b', '#0ea5a4', '#ca8a04'];
export const colorAt = (i: number, given?: string | null) => given || PALETTE[i % PALETTE.length]!;

export interface Slice { label: string; value: number; color?: string | null; to?: string }

/** Dona con leyenda. */
export function Donut({ data, center, size = 150 }: { data: Slice[]; center?: ReactNode; size?: number }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  const r = 15.9155; // circunferencia = 100
  let acc = 0;
  return (
    <div className="chart-donut">
      <div className="chart-donut-fig" style={{ width: size, height: size }}>
        <svg viewBox="0 0 42 42" width={size} height={size} role="img">
          <circle cx="21" cy="21" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="6" />
          {total > 0 && data.map((d, i) => {
            if (d.value <= 0) return null;
            const len = (d.value / total) * 100;
            const el = <circle key={i} className="chart-arc" cx="21" cy="21" r={r} fill="none" stroke={colorAt(i, d.color)} strokeWidth="6" strokeDasharray={`${len} ${100 - len}`} strokeDashoffset={25 - acc}
              style={{ ...stagger(i, 110), '--len': len, '--gap': 100 - len } as CSSProperties}><title>{`${d.label}: ${d.value}`}</title></circle>;
            acc += len;
            return el;
          })}
        </svg>
        <div className="chart-donut-center">{center ?? <strong><CountUp value={total} /></strong>}</div>
      </div>
      <ul className="chart-legend">
        {data.map((d, i) => {
          const row = <><span className="chart-dot" style={{ background: colorAt(i, d.color) }} /><span className="grow truncate">{d.label}</span><strong>{d.value}</strong></>;
          return <li key={i}>{d.to ? <Link to={d.to} className="chart-legend-row">{row}</Link> : <span className="chart-legend-row">{row}</span>}</li>;
        })}
      </ul>
    </div>
  );
}

/**
 * Barras verticales (por día, por mes…). El dibujo se hace al tamaño real de la pantalla (1 unidad = 1 píxel): así los números
 * de abajo nunca se ven estirados, sea cual sea el ancho de la tarjeta.
 */
export function Bars({ data, height = 150, color = 'var(--primary)', fmt = (n: number) => String(n) }: { data: { label: string; value: number; title?: string }[]; height?: number; color?: string; fmt?: (n: number) => string }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const max = Math.max(1, ...data.map((d) => d.value));
  const W = Math.max(width, 120), padTop = 16, padBottom = 20, H = height;
  const n = Math.max(data.length, 1);
  const step = W / n;
  const bw = Math.max(3, Math.min(28, step * 0.65));
  // Etiquetas del eje: solo las que caben sin pisarse (unos 6 px por carácter).
  const labelPx = Math.max(24, ...data.map((d) => d.label.length * 6 + 8));
  const every = Math.max(1, Math.ceil(labelPx / step));
  const valuePx = Math.max(...data.map((d) => fmt(d.value).length), 1) * 6 + 4;
  const showValues = step >= valuePx;
  return (
    <div ref={box} className="chart-bars-box">
      <svg className="chart-bars" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img">
        <line x1="0" x2={W} y1={H - padBottom} y2={H - padBottom} stroke="var(--border-strong)" strokeWidth="1" />
        {data.map((d, i) => {
          const h = ((H - padTop - padBottom) * d.value) / max;
          const x = i * step + (step - bw) / 2;
          return (
            <g key={i}>
              <rect className="chart-bar" x={x} y={H - padBottom - h} width={bw} height={Math.max(h, d.value > 0 ? 1 : 0)} rx="2" fill={color} style={stagger(i, Math.min(45, 700 / n))}><title>{d.title ?? `${d.label}: ${fmt(d.value)}`}</title></rect>
              {d.value > 0 && showValues && <text x={x + bw / 2} y={H - padBottom - h - 3} textAnchor="middle" className="chart-val" style={stagger(i, Math.min(45, 700 / n))}>{fmt(d.value)}</text>}
              {i % every === 0 && <text x={x + bw / 2} y={H - 6} textAnchor="middle" className="chart-lbl">{d.label}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Barras horizontales con etiqueta y valor. */
export function HBars({ data, fmt = (n: number) => String(n) }: { data: Slice[]; fmt?: (n: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul className="chart-hbars">
      {data.map((d, i) => {
        const label = d.to ? <Link to={d.to} className="truncate">{d.label}</Link> : <span className="truncate">{d.label}</span>;
        return (
          <li key={i}>
            <div className="row spread">{label}<strong>{fmt(d.value)}</strong></div>
            <div className="chart-track"><div className="chart-fill" style={{ ...stagger(i, 70), '--w': `${(d.value / max) * 100}%`, width: `${(d.value / max) * 100}%`, background: colorAt(i, d.color) } as CSSProperties} /></div>
          </li>
        );
      })}
    </ul>
  );
}

/** Una barra apilada por fila (ej. tipo de equipo → estados). */
export function StackedBars({ rows, legend }: { rows: { label: ReactNode; segments: { value: number; color: string; title: string }[]; to?: string }[]; legend: { label: string; color: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.segments.reduce((a, s) => a + s.value, 0)));
  return (
    <div className="chart-stacked">
      <ul className="chart-legend chart-legend-inline">{legend.map((l, i) => <li key={i}><span className="chart-legend-row"><span className="chart-dot" style={{ background: l.color }} />{l.label}</span></li>)}</ul>
      {rows.map((r, i) => {
        const total = r.segments.reduce((a, s) => a + s.value, 0);
        return (
          <div key={i} className="chart-srow">
            <div className="row spread"><span>{r.label}</span><strong>{total}</strong></div>
            <div className="chart-track" style={{ width: '100%' }}>
              <div className="chart-stack-fill" style={{ ...stagger(i, 80), '--w': `${(total / max) * 100}%`, display: 'flex', width: `${(total / max) * 100}%`, height: '100%' } as CSSProperties}>
                {r.segments.filter((s) => s.value > 0).map((s, k) => <div key={k} title={s.title} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} />)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
