import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import { money } from '../lib/format';

/* ------------------------------- primitives ------------------------------ */

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" style={{ gap: '0.5rem' }}>
      <span className="spinner" aria-hidden />
      {label ? <span className="muted small">{label}</span> : null}
    </span>
  );
}

export function Pill({
  children, tone = 'plain',
}: { children: ReactNode; tone?: 'plain' | 'gold' | 'ok' | 'warn' | 'bad' | 'info' }) {
  return <span className={`pill${tone === 'plain' ? '' : ` pill-${tone}`}`}>{children}</span>;
}

export function Empty({ icon = '🍽️', title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="big" aria-hidden>{icon}</div>
      <h3>{title}</h3>
      {hint ? <p className="small">{hint}</p> : null}
    </div>
  );
}

export function Stat({
  label, value, sub, tone,
}: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'gold' | 'ok' | 'bad' }) {
  return (
    <div className="kpi">
      <span className="label">{label}</span>
      <span className="value" style={tone === 'bad' ? { color: 'var(--bad)' } : tone === 'ok' ? { color: 'var(--ok)' } : undefined}>
        {value}
      </span>
      {sub ? <span className="delta muted">{sub}</span> : null}
    </div>
  );
}

export function Meter({ value, max, tone }: { value: number; max: number; tone?: 'low' | 'mid' }) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div className={`meter${tone ? ` ${tone}` : ''}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Modal({
  title, children, onClose, footer, wide,
}: { title: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" style={wide ? { width: 'min(900px, 100%)' } : undefined}>
        <header>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Drawer({
  title, children, footer, onClose,
}: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void }) {
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Basket'}>
        <header>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close basket">✕</button>
        </header>
        <div className="body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </aside>
    </>
  );
}

/* -------------------------------- toasts -------------------------------- */

export interface Toast {
  id: number;
  title: string;
  body?: string;
  tone?: 'gold' | 'ok' | 'bad' | 'info';
}

interface ToastApi {
  push: (toast: Omit<Toast, 'id'>) => void;
}

const ToastContext = createContext<ToastApi>({ push: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-3), { ...toast, id }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 6000);
  }, []);

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div className="toast" key={toast.id}>
            <span aria-hidden>{toast.tone === 'ok' ? '✅' : toast.tone === 'bad' ? '⚠️' : toast.tone === 'info' ? 'ℹ️' : '✨'}</span>
            <div>
              <strong style={{ display: 'block' }}>{toast.title}</strong>
              {toast.body ? <span className="muted small">{toast.body}</span> : null}
            </div>
            <button
              className="close"
              onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/* ------------------------------- charts ---------------------------------- */

export function RevenueBars({
  data, height = 120,
}: { data: { day: string; revenue: number; orders: number }[]; height?: number }) {
  const max = Math.max(1, ...data.map((point) => point.revenue));
  return (
    <div>
      <div className="bars" style={{ height }}>
        {data.map((point) => (
          <div
            className="bar"
            key={point.day}
            style={{ height: `${Math.max(3, (point.revenue / max) * 100)}%` }}
            title={`${point.day}: ${money(point.revenue)} across ${point.orders} orders`}
          >
            {point.revenue === max && point.revenue > 0 ? (
              <span>{money(point.revenue).replace('R', 'R')}</span>
            ) : null}
          </div>
        ))}
      </div>
      <div className="bars-x">
        {data.map((point) => (
          <span key={point.day}>{new Date(`${point.day}T12:00:00Z`).toLocaleDateString('en-ZA', { weekday: 'narrow' })}</span>
        ))}
      </div>
    </div>
  );
}

export function HourBars({ data }: { data: { hour: string; orders: number }[] }) {
  const max = Math.max(1, ...data.map((point) => point.orders));
  return (
    <div className="bars" style={{ height: 80 }}>
      {data.map((point) => (
        <div
          className="bar"
          key={point.hour}
          style={{ height: `${Math.max(4, (point.orders / max) * 100)}%`, opacity: 0.35 + 0.65 * (point.orders / max) }}
          title={`${point.hour}:00 — ${point.orders} orders`}
        />
      ))}
    </div>
  );
}

export function Stars({ value, size = '1rem' }: { value: number; size?: string }) {
  const rounded = Math.round(value);
  return (
    <span className="stars" style={{ fontSize: size }} aria-label={`${value} out of 5`}>
      {'★★★★★'.slice(0, rounded)}
      <span style={{ opacity: 0.25 }}>{'★★★★★'.slice(rounded)}</span>
    </span>
  );
}

/* --------------------------- status helpers ------------------------------ */

const TONES: Record<string, string> = {
  pending: 'pill-warn',
  confirmed: 'pill-info',
  preparing: 'pill-info',
  ready: 'pill-gold',
  assigned: 'pill-info',
  picked_up: 'pill-info',
  on_the_way: 'pill-info',
  delivered: 'pill-ok',
  completed: 'pill-ok',
  cancelled: 'pill-bad',
  rejected: 'pill-bad',
  offline: 'pill',
  online: 'pill-ok',
  busy: 'pill-warn',
};

export function StatusPill({ status, label }: { status: string; label?: string }) {
  return <span className={`pill ${TONES[status] ?? ''}`}>{label ?? status.replace(/_/g, ' ')}</span>;
}

export function LoadingCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card stack">
      <div className="skeleton" style={{ height: 18, width: '45%' }} />
      {Array.from({ length: lines }).map((_, index) => (
        <div className="skeleton" key={index} style={{ height: 12, width: `${90 - index * 12}%` }} />
      ))}
    </div>
  );
}
