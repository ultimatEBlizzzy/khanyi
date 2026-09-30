import { useCallback, useEffect, useState } from 'react';

import api from '../../lib/api';
import { useLiveFeed } from '../../lib/live';
import { useToast, Pill, Spinner, StatusPill, Empty } from '../../components/ui';
import { money, timeAgo } from '../../lib/format';
import type { KitchenTicket } from '../../lib/types';

const COLUMNS: { status: string; title: string; hint: string }[] = [
  { status: 'pending', title: 'New', hint: 'Confirm to start the clock' },
  { status: 'confirmed', title: 'Confirmed', hint: 'Send to the fryer' },
  { status: 'preparing', title: 'Cooking', hint: 'Mark ready when packed' },
  { status: 'ready', title: 'Ready', hint: 'Hand over or dispatch' },
];

const NEXT_LABEL: Record<string, string> = {
  pending: '✓ Confirm order',
  confirmed: '🔥 Start cooking',
  preparing: '📦 Mark ready',
  ready: '✅ Hand over',
};

export default function Kitchen() {
  const [tickets, setTickets] = useState<KitchenTicket[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const { push } = useToast();

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ queue: KitchenTicket[] }>('/api/admin/overview');
      setTickets(data.queue);
    } catch (error) {
      push({ tone: 'bad', title: 'Could not load the queue', body: (error as Error).message });
    }
  }, [push]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 45_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useLiveFeed(['staff', 'orders'], (event) => {
    if (event.type === 'order.created') {
      push({ tone: 'gold', title: `New ticket ${event.payload?.code}`, body: `${event.payload?.items?.length ?? 0} lines` });
    }
    void load();
  });

  const bump = async (ticket: KitchenTicket) => {
    setBusy(ticket.id);
    try {
      const result = await api.post<{ order: KitchenTicket; movedTo: string }>(`/api/admin/orders/${ticket.id}/bump`);
      push({ tone: 'ok', title: `${ticket.code} → ${result.movedTo}` });
      await load();
    } catch (error) {
      push({ tone: 'bad', title: 'The kitchen screen refused that', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  if (!tickets) return <Spinner label="Loading tickets…" />;

  return (
    <div className="stack" style={{ marginTop: '0.6rem' }}>
      <div className="row-between wrap">
        <p className="small muted" style={{ margin: 0 }}>
          Tickets update themselves — no refresh needed. Tap the big button to move an order on.
        </p>
        <div className="row" style={{ gap: '0.5rem' }}>
          <Pill tone="warn">{tickets.filter((t) => t.late).length} running late</Pill>
          <Pill tone="gold">{tickets.length} open tickets</Pill>
        </div>
      </div>

      {tickets.length === 0 ? (
        <Empty icon="🍳" title="The pass is clear" hint="New orders will appear here the moment they are placed." />
      ) : (
        <div className="grid grid-4">
          {COLUMNS.map((column) => {
            const columnTickets = tickets.filter((ticket) => ticket.status === column.status);
            return (
              <div key={column.status} className="stack" style={{ gap: '0.6rem' }}>
                <div className="card card-tight" style={{ background: 'rgba(217,180,91,0.08)' }}>
                  <div className="row-between">
                    <strong>{column.title}</strong>
                    <Pill>{columnTickets.length}</Pill>
                  </div>
                  <span className="tiny muted">{column.hint}</span>
                </div>

                {columnTickets.map((ticket) => (
                  <article
                    className="card"
                    key={ticket.id}
                    style={ticket.late ? { borderColor: 'rgba(248,117,111,0.5)' } : undefined}
                  >
                    <div className="row-between">
                      <strong className="mono">{ticket.code}</strong>
                      {ticket.late ? <Pill tone="bad">{ticket.waitMinutes} min</Pill> : <Pill>{timeAgo(ticket.created_at)}</Pill>}
                    </div>
                    <div className="row" style={{ gap: '0.4rem', margin: '0.4rem 0' }}>
                      <Pill tone={ticket.fulfilment === 'delivery' ? 'info' : 'gold'}>
                        {ticket.fulfilment === 'delivery' ? '🛵 Delivery' : '🏪 Collection'}
                      </Pill>
                      <StatusPill status={ticket.status} />
                    </div>

                    {ticket.fulfilment === 'delivery' && ticket.address_line ? (
                      <div className="tiny muted">📍 {ticket.address_line}{ticket.address_suburb ? `, ${ticket.address_suburb}` : ''}</div>
                    ) : null}
                    <div className="tiny muted">👤 {ticket.customer_name} · {ticket.customer_phone}</div>

                    <hr className="divider" />
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                      {ticket.items.map((item) => (
                        <li key={item.id} style={{ marginBottom: '0.35rem' }}>
                          <div className="row-between small">
                            <span><strong>{item.qty} ×</strong> {item.name}</span>
                          </div>
                          {item.options.length ? (
                            <div className="tiny muted">{item.options.map((option) => option.name).join(' · ')}</div>
                          ) : null}
                        </li>
                      ))}
                    </ul>

                    <div className="row-between" style={{ marginTop: '0.5rem' }}>
                      <span className="gold mono">{money(ticket.total)}</span>
                      <span className="tiny muted">{ticket.eta_minutes} min ETA</span>
                    </div>

                    <button
                      className="btn btn-primary btn-block"
                      style={{ marginTop: '0.6rem' }}
                      onClick={() => bump(ticket)}
                      disabled={busy === ticket.id}
                    >
                      {busy === ticket.id ? <Spinner /> : NEXT_LABEL[ticket.status]}
                    </button>
                  </article>
                ))}

                {columnTickets.length === 0 ? (
                  <div className="card card-tight center muted tiny">empty</div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
