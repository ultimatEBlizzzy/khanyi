import { useCallback, useEffect, useMemo, useState } from 'react';

import api from '../lib/api';
import { useLiveFeed } from '../lib/live';
import { useToast, Pill, Spinner, Stat, StatusPill, Empty } from '../components/ui';
import { money, timeAgo, vehicleIcon, initials } from '../lib/format';
import type { StoreStatus } from '../lib/types';

interface RunOrder {
  id: number;
  code: string;
  status: string;
  customer_name: string;
  address_line: string;
  address_suburb: string;
  address_notes: string;
  distance_km: number;
  total: number;
  delivery_fee: number;
  eta_minutes: number;
  created_at: string;
  items: { name: string; qty: number; options: { name: string }[] }[];
}

interface Board {
  driver: {
    id: number; name: string; phone: string; vehicle: string; plate: string;
    status: 'offline' | 'online' | 'busy'; zone: string; rating: number;
    deliveries: number; capacity: number;
  };
  active: RunOrder[];
  pool: RunOrder[];
  today: { deliveries: number; fees: number; value: number };
  recent: { id: number; code: string; address_line: string; total: number; delivery_fee: number; completed_at: string; status: string }[];
  availability: StoreStatus['delivery'];
}

interface Earnings {
  days: { day: string; deliveries: number; fees: number; order_value: number }[];
  totals: { deliveries: number; fees: number };
  payoutModel: { perDelivery: number; feeShare: number };
}

const NEXT_STEP: Record<string, { to: string; label: string; icon: string } | undefined> = {
  assigned: { to: 'picked_up', label: 'Collected from the kitchen', icon: '🥡' },
  picked_up: { to: 'on_the_way', label: 'Leaving the store', icon: '🛵' },
  on_the_way: { to: 'delivered', label: 'Handed to the customer', icon: '✅' },
};

export default function Rider() {
  const { push } = useToast();
  const [board, setBoard] = useState<Board | null>(null);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [boardData, earningsData] = await Promise.all([
        api.get<Board>('/api/rider/board'),
        api.get<Earnings>('/api/rider/earnings'),
      ]);
      setBoard(boardData);
      setEarnings(earningsData);
    } catch (error) {
      push({ tone: 'bad', title: 'Could not load your board', body: (error as Error).message });
    }
  }, [push]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveFeed(['drivers', 'orders'], (event) => {
    if (event.type === 'order.assigned' && event.payload?.addressLine) {
      push({ tone: 'info', title: `New run: ${event.payload.code}`, body: String(event.payload.addressLine) });
    }
    void load();
  }, { enabled: true });

  const toggleShift = async () => {
    if (!board) return;
    const next = board.driver.status === 'offline' ? 'online' : 'offline';
    setBusy('shift');
    try {
      await api.post('/api/rider/status', { status: next });
      push({ tone: next === 'online' ? 'ok' : 'info', title: next === 'online' ? 'You are on shift' : 'You are offline' });
      await load();
    } catch (error) {
      push({ tone: 'bad', title: 'Could not change your shift', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const advance = async (order: RunOrder, to: string) => {
    setBusy(`${order.id}:${to}`);
    try {
      await api.post(`/api/rider/orders/${order.id}/progress`, { to });
      push({ tone: 'ok', title: `${order.code} → ${to.replace(/_/g, ' ')}` });
      await load();
    } catch (error) {
      push({ tone: 'bad', title: 'That step was refused', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const claim = async (order: RunOrder) => {
    setBusy(`${order.id}:claim`);
    try {
      await api.post(`/api/rider/orders/${order.id}/claim`, {});
      push({ tone: 'gold', title: `You claimed ${order.code}` });
      await load();
    } catch (error) {
      push({ tone: 'bad', title: 'Could not claim that run', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const maxDay = useMemo(
    () => Math.max(1, ...(earnings?.days ?? []).map((day) => day.fees)),
    [earnings],
  );

  if (!board) {
    return <div className="container section"><Spinner label="Loading your runs…" /></div>;
  }

  const onShift = board.driver.status !== 'offline';
  const payoutToday = board.today.deliveries * (earnings?.payoutModel.perDelivery ?? 1000)
    + Math.round(board.today.fees * (earnings?.payoutModel.feeShare ?? 0.5));

  return (
    <div className="container section">
      <div className="row-between wrap" style={{ marginBottom: '1.1rem' }}>
        <div className="row" style={{ gap: '0.9rem' }}>
          <span className="avatar" style={{ width: 52, height: 52 }}>{initials(board.driver.name)}</span>
          <div>
            <span className="eyebrow gold" style={{ letterSpacing: '0.2em', fontSize: '0.72rem' }}>
              {vehicleIcon(board.driver.vehicle)} {board.driver.vehicle} · {board.driver.zone}
            </span>
            <h1 style={{ margin: 0 }}>{board.driver.name}</h1>
            <div className="small muted">
              ★ {board.driver.rating.toFixed(1)} · {board.driver.deliveries} lifetime runs · {board.driver.capacity} runs at a time
            </div>
          </div>
        </div>
        <div className="row" style={{ gap: '0.6rem' }}>
          <Pill tone={onShift ? 'ok' : 'bad'}>
            <span className={`dot ${onShift ? 'dot-live' : 'dot-bad'}`} />
            {onShift ? (board.driver.status === 'busy' ? 'On a run' : 'On shift') : 'Off shift'}
          </Pill>
          <button className={`btn ${onShift ? 'btn-ghost' : 'btn-primary'}`} onClick={toggleShift} disabled={busy === 'shift'}>
            {busy === 'shift' ? <Spinner /> : onShift ? 'Go offline' : 'Go on shift'}
          </button>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: '1.2rem' }}>
        <div className="card"><Stat label="Delivered today" value={board.today.deliveries} tone="ok" /></div>
        <div className="card"><Stat label="Delivery fees today" value={money(board.today.fees)} /></div>
        <div className="card"><Stat label="Estimated payout" value={money(payoutToday)} sub="R10 per run + 50% of fees" tone="gold" /></div>
        <div className="card"><Stat label="Open pool" value={board.pool.length} sub="ready and unassigned" /></div>
      </div>

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          <section>
            <div className="section-head">
              <div>
                <span className="eyebrow gold" style={{ letterSpacing: '0.18em', fontSize: '0.7rem' }}>On my bike</span>
                <h2 style={{ margin: 0 }}>Active runs ({board.active.length})</h2>
              </div>
            </div>

            {board.active.length === 0 ? (
              <Empty icon="🛵" title="No runs yet" hint="Claim one from the pool below or wait for an assignment." />
            ) : (
              <div className="stack">
                {board.active.map((order) => {
                  const next = NEXT_STEP[order.status];
                  return (
                    <article className="card card-gold" key={order.id}>
                      <div className="row-between wrap">
                        <div>
                          <div className="row" style={{ gap: '0.5rem' }}>
                            <strong className="mono">{order.code}</strong>
                            <StatusPill status={order.status} />
                          </div>
                          <div className="small muted">
                            {order.customer_name} · {order.eta_minutes} min ETA · {order.distance_km} km
                          </div>
                        </div>
                        <div className="right">
                          <div className="gold">{money(order.total)}</div>
                          <div className="tiny muted">fee {money(order.delivery_fee)}</div>
                        </div>
                      </div>

                      <div className="card card-tight" style={{ marginTop: '0.7rem', background: 'rgba(0,0,0,0.25)' }}>
                        <div className="row" style={{ gap: '0.4rem' }}>
                          <span aria-hidden>📍</span>
                          <span className="small">
                            {order.address_line}
                            {order.address_suburb ? `, ${order.address_suburb}` : ''}
                          </span>
                        </div>
                        {order.address_notes ? <div className="tiny muted">“{order.address_notes}”</div> : null}
                        <div className="row" style={{ marginTop: '0.4rem', gap: '0.5rem' }}>
                          <span className="tiny muted">placed {timeAgo(order.created_at)}</span>
                        </div>
                      </div>

                      <div className="row wrap" style={{ gap: '0.35rem', marginTop: '0.6rem' }}>
                        {order.items.map((item, index) => (
                          <Pill key={index}>{item.qty} × {item.name}{item.options.length ? ` (${item.options.map((o) => o.name).join(', ')})` : ''}</Pill>
                        ))}
                      </div>

                      {next ? (
                        <button
                          className="btn btn-primary btn-block btn-lg"
                          style={{ marginTop: '0.8rem' }}
                          onClick={() => advance(order, next.to)}
                          disabled={busy === `${order.id}:${next.to}`}
                        >
                          {busy === `${order.id}:${next.to}` ? <Spinner /> : `${next.icon} ${next.label}`}
                        </button>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <div className="section-head">
              <div>
                <span className="eyebrow gold" style={{ letterSpacing: '0.18em', fontSize: '0.7rem' }}>Up for grabs</span>
                <h2 style={{ margin: 0 }}>Ready for pickup ({board.pool.length})</h2>
              </div>
            </div>
            {board.pool.length === 0 ? (
              <p className="small muted">Nothing waiting — the kitchen has it under control.</p>
            ) : (
              <div className="stack">
                {board.pool.map((order) => (
                  <article className="card" key={order.id}>
                    <div className="row-between wrap">
                      <div>
                        <div className="row" style={{ gap: '0.5rem' }}>
                          <strong className="mono">{order.code}</strong>
                          <Pill tone="gold">ready</Pill>
                        </div>
                        <div className="small muted">
                          {order.address_line}{order.address_suburb ? `, ${order.address_suburb}` : ''}
                        </div>
                        <div className="tiny muted">{order.distance_km} km · {money(order.total)} · fee {money(order.delivery_fee)}</div>
                      </div>
                      <button className="btn btn-sm" onClick={() => claim(order)} disabled={busy === `${order.id}:claim` || !onShift}>
                        {busy === `${order.id}:claim` ? <Spinner /> : onShift ? 'Claim run' : 'Go on shift first'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="stack">
          <section className="card">
            <h3>My week</h3>
            {earnings && earnings.days.length > 0 ? (
              <>
                <div className="bars" style={{ height: 100 }}>
                  {[...earnings.days].reverse().map((day) => (
                    <div
                      className="bar"
                      key={day.day}
                      style={{ height: `${Math.max(6, (day.fees / maxDay) * 100)}%` }}
                      title={`${day.day}: ${day.deliveries} runs · ${money(day.fees)}`}
                    />
                  ))}
                </div>
                <div className="bars-x">
                  {[...earnings.days].reverse().map((day) => (
                    <span key={day.day}>{new Date(`${day.day}T12:00:00Z`).toLocaleDateString('en-ZA', { weekday: 'narrow' })}</span>
                  ))}
                </div>
                <hr className="divider" />
                <div className="price-row"><span className="label">Runs (all time)</span><span>{earnings.totals.deliveries}</span></div>
                <div className="price-row"><span className="label">Fees collected</span><span>{money(earnings.totals.fees)}</span></div>
              </>
            ) : (
              <p className="small muted" style={{ margin: 0 }}>No completed runs yet — your first one will show up here.</p>
            )}
          </section>

          <section className="card">
            <h3>Recent runs</h3>
            {board.recent.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>Nothing yet today.</p>
            ) : (
              <div className="stack" style={{ gap: '0.5rem' }}>
                {board.recent.map((order) => (
                  <div className="row-between" key={order.id}>
                    <div>
                      <span className="mono small">{order.code}</span>
                      <div className="tiny muted">{order.address_line || 'Collected at the kitchen'} · {timeAgo(order.completed_at)}</div>
                    </div>
                    <span className="small gold">{money(order.delivery_fee)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <h3>Fleet status</h3>
            <div className="price-row"><span className="label">Riders on shift</span><span>{board.availability.ridersOnShift}</span></div>
            <div className="price-row"><span className="label">Free right now</span><span>{board.availability.ridersFree}</span></div>
            <div className="price-row"><span className="label">Out on deliveries</span><span>{board.availability.ridersBusy}</span></div>
            <p className="tiny muted" style={{ marginTop: '0.5rem' }}>
              {board.availability.available ? board.availability.message : board.availability.reason}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
