import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';

export function Alert({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'bad' | 'good'; children: ReactNode }) {
  const I = kind === 'warn' ? AlertTriangle : kind === 'bad' ? XCircle : kind === 'good' ? CheckCircle2 : Info;
  return <div className={`alert alert-${kind}`} style={{ marginBottom: 12 }}><I size={18} style={{ flex: 'none', marginTop: 2 }} /><div className="grow">{children}</div></div>;
}
