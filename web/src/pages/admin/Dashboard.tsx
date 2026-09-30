import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import api from '../../lib/api';
import { useLiveFeed } from '../../lib/live';
import { useToast, Pill, Stat, Spinner, StatusPill, RevenueBars, HourBars, Meter } from '../../components/ui';
import { money, timeAgo, vehicleIcon, initials, clockTime } from '../../lib/format';
import type { AdminStats, KitchenTicket, Rider } from '../../lib/types';

interface OnTheRoad {
  id: number;
  code: string;
  status: string;
  driver_id: number | null;
  driver_name?: string;
  address_line: string;
  address_suburb: string;
  total: number;
  delivery_fee: number;
  created_at: string;
  durationMinutes: number;
}

interface Overview {
  stats: AdminStats;
  queue: KitchenTicket[];
  deliveries: OnTheRoad[];
  riders: Rider[];
  lowStock: { id: number; name: string; stock: number; track_stock: number; is_available: number }[];
  live: { clients: number; sequence: number; byTopic: Record<string, number> };
  serverTime: string;
}

export default function Dashboard() {
  const [data, setData] = useState<Overview | null>(null);
  const [feed, setFeed] = useState<{ id: number; text: string; at: string; tone: string }[]>([]);
  const { push } = useToast();

  const load = useCallback(async () => {
    try {
      setData(await api.get<Overview>('/api/admin/overview'));
    } catch (error) {
      push({ tone: 'bad', title: 'Could not load the dashboard', body: (error as Error).message });
    }
  }, [push]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useLiveFeed(['admin', 'staff', 'orders', 'drivers'], (event) => {
    const label: Record<string, string> = {
      'order.created': `🧾 New order ${event.payload?.code} · ${money(Number(event.payload?.total ?? 0))}`,
      'order.updated': `↻ ${event.payload?.code} → ${String(event.payload?.statusLabel ?? event.payload?.status)}`,
      'order.assigned': `🛵 ${event.payload?.code} assigned to ${event.payload?.driverName ?? 'a rider'}`,
      'order.ready_for_pickup': `🍽️ ${event.payload?.code} is ready for pickup`,
      'dispatch.no_rider': `⚠️ No rider free for ${event.payload?.code}`,
      'menu.updated': `📋 Menu updated: ${event.payload?.name ?? event.payload?.categoryId ?? ''}`,
      'store.updated': '⚙️ Store settings changed',
      'rider.status': `🛵 ${event.payload?.name ?? 'A rider'} is now ${event.payload?.status}`,
      'rider.joined': `🎉 ${event.payload?.name} joined the fleet`,
      'order.rated': `⭐ An order was rated ${event.payload?.stars}/5`,
    };
    const text = label[event.type];
    if (text) {
      setFeed((current) => [{ id: event.seq, text, at: event.at, tone: event.type }, ...current].slice(0, 12));
    }
    void load();
  });

  if (!data) return <Spinner label="Loading the console…" />;

  const { stats } = data;

  return (
    <div className="stack" style={{ marginTop: '0.6rem' }}>
      <div className="grid grid-4">
        <div className="card">
          <Stat label="Revenue today" value={money(stats.today.revenue)} sub={`${stats.today.orders} orders · avg ${money(stats.today.avgTicket)}`} />
        </div>
        <div className="card">
          <Stat label="Live orders" value={stats.live.active} sub={`${stats.live.inKitchen} in kitchen · ${stats.live.onTheRoad} on the road`} />
        </div>
        <div className="card">
          <Stat label="All-time revenue" value={money(stats.allTime.revenue)} sub={`${stats.allTime.orders} orders served`} />
        </div>
        <div className="card">
          <Stat
            label="Ratings"
            value={`${stats.ratings.average || '—'} ★`}
            sub={`${stats.ratings.count} reviews`}
            tone="ok"
          />
        </div>
      </div>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h3 style={{ margin: 0 }}>Last 14 days</h3>
            <Pill tone="gold">{money(stats.last14.reduce((sum, day) => sum + day.revenue, 0))}</Pill>
          </div>
          {stats.last14.length ? <RevenueBars data={stats.last14} /> : <p className="small muted">No trading history yet.</p>}
        </section>

        <section className="card">
          <div className="card-head">
            <h3 style={{ margin: 0 }}>Busiest hours (7 days)</h3>
            <Pill>lunch & supper peaks</Pill>
          </div>
          {stats.hourly.length ? <HourBars data={stats.hourly} /> : <p className="small muted">No data yet.</p>}
          <div className="row-between tiny muted" style={{ marginTop: '0.4rem' }}>
            <span>06:00</span><span>12:00</span><span>18:00</span><span>22:00</span>
          </div>
        </section>
      </div>

      <div className="grid grid-3">
        <section className="card">
          <h3>Top sellers</h3>
          <div className="stack" style={{ gap: '0.55rem' }}>
            {stats.topItems.map((item) => (
              <div key={item.name}>
                <div className="row-between small">
                  <span>{item.name}</span>
                  <span className="muted">{item.qty} sold</span>
                </div>
                <Meter value={item.qty} max={stats.topItems[0]?.qty ?? 1} />
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h3 style={{ margin: 0 }}>Fleet</h3>
            <Link className="btn btn-xs btn-ghost" to="/admin/dispatch">Manage</Link>
          </div>
          <div className="stack" style={{ gap: '0.6rem' }}>
            {data.riders.map((rider) => (
              <div className="rider-card" key={rider.id}>
                <span className="avatar">{initials(rider.name)}</span>
                <div className="grow">
                  <div className="row-between">
                    <strong>{rider.name}</strong>
                    <StatusPill status={rider.status} />
                  </div>
                  <div className="tiny muted">
                    {vehicleIcon(rider.vehicle)} {rider.vehicle} · {rider.activeOrders}/{rider.capacity} runs · ★ {rider.rating}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h3 style={{ margin: 0 }}>Live feed</h3>
            <Pill tone="ok"><span className="dot dot-live" /> {data.live.clients} clients</Pill>
          </div>
          {feed.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>Listening for events…</p>
          ) : (
            <div className="stack" style={{ gap: '0.35rem' }}>
              {feed.map((entry) => (
                <div className="row-between small" key={entry.id}>
                  <span>{entry.text}</span>
                  <span className="tiny muted nowrap">{clockTime(entry.at)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h3 style={{ margin: 0 }}>Kitchen queue</h3>
            <Link className="btn btn-xs btn-ghost" to="/admin/kitchen">Open kitchen screen</Link>
          </div>
          {data.queue.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>Nothing waiting — clean pass.</p>
          ) : (
            <div className="stack" style={{ gap: '0.5rem' }}>
              {data.queue.slice(0, 6).map((ticket) => (
                <div className="row-between" key={ticket.id}>
                  <span className="row" style={{ gap: '0.5rem' }}>
                    <span className="mono">{ticket.code}</span>
                    <StatusPill status={ticket.status} />
                    {ticket.late ? <Pill tone="bad">late</Pill> : null}
                  </span>
                  <span className="tiny muted">{ticket.items.length} items · {ticket.waitMinutes} min</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h3 style={{ margin: 0 }}>Low stock & sold out</h3>
            <Link className="btn btn-xs btn-ghost" to="/admin/menu">Manage menu</Link>
          </div>
          {data.lowStock.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>Everything is well stocked.</p>
          ) : (
            <div className="stack" style={{ gap: '0.5rem' }}>
              {data.lowStock.map((item) => (
                <div className="row-between" key={item.id}>
                  <span>{item.name}</span>
                  <Pill tone={item.stock === 0 ? 'bad' : 'warn'}>{item.stock} left</Pill>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <DeliveryStrip deliveries={data.deliveries} />
    </div>
  );
}

function DeliveryStrip({ deliveries }: { deliveries: OnTheRoad[] }) {
  if (deliveries.length === 0) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h3 style={{ margin: 0 }}>On the road right now</h3>
        <Link className="btn btn-xs btn-ghost" to="/admin/dispatch">Dispatch board</Link>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Order</th><th>Status</th><th>Rider</th><th>Address</th><th>Age</th><th>Total</th></tr>
          </thead>
          <tbody>
            {deliveries.map((order) => (
              <tr key={order.id}>
                <td className="mono">{order.code}</td>
                <td><StatusPill status={order.status} /></td>
                <td>{order.driver_name ?? <span className="muted">unassigned</span>}</td>
                <td className="muted">{order.address_line}{order.address_suburb ? `, ${order.address_suburb}` : ''}</td>
                <td>{timeAgo(order.created_at)}</td>
                <td>{money(order.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
