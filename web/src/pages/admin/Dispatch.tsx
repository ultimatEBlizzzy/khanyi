import { useCallback, useEffect, useState } from 'react';

import api from '../../lib/api';
import { useLiveFeed } from '../../lib/live';
import { useToast, Pill, Spinner, StatusPill, Stat, Empty } from '../../components/ui';
import { money, timeAgo, vehicleIcon, initials } from '../../lib/format';
import type { KitchenTicket, Rider } from '../../lib/types';

interface ActiveDelivery {
  id: number;
  code: string;
  status: string;
  fulfilment: 'collection' | 'delivery';
  driver_id: number | null;
  driver_name?: string;
  address_line: string;
  address_suburb: string;
  total: number;
  delivery_fee: number;
  eta_minutes: number;
  created_at: string;
  customer_name: string;
  customer_phone: string;
  durationMinutes: number;
  items: { id: number; name: string; qty: number }[];
}

interface Fleet {
  riders: Rider[];
  availability: {
    available: boolean; ridersOnShift: number; ridersFree: number;
    ridersBusy: number; ridersOffline: number; reason: string; message: string;
  };
}

export default function Dispatch() {
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [deliveries, setDeliveries] = useState<ActiveDelivery[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const { push } = useToast();

  const load = useCallback(async () => {
    try {
      const [fleetData, overview] = await Promise.all([
        api.get<Fleet>('/api/admin/riders'),
        api.get<{ deliveries: ActiveDelivery[]; queue: KitchenTicket[] }>('/api/admin/overview'),
      ]);
      setFleet(fleetData);
      setDeliveries(overview.deliveries);
    } catch (error) {
      push({ tone: 'bad', title: 'Could not load dispatch', body: (error as Error).message });
    }
  }, [push]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveFeed(['admin', 'drivers', 'orders'], () => void load());

  const setStatus = async (rider: Rider, status: 'online' | 'offline') => {
    setBusy(`rider-${rider.id}`);
    try {
      await api.patch(`/api/admin/riders/${rider.id}`, { status });
      push({ tone: 'info', title: `${rider.name} is now ${status}` });
      await load();
    } catch (error) {
      push({ tone: 'bad', title: 'Could not change the shift', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const assign = async (order: ActiveDelivery | KitchenTicket, driverId: number | 'auto') => {
    setBusy(`order-${order.id}`);
    try {
      const result = await api.post<{ order: { driver?: { name: string } | null }; mode: string }>(
        `/api/admin/orders/${order.id}/assign`,
        driverId === 'auto' ? { auto: true } : { driverId },
      );
      push({
        tone: 'ok',
        title: `${order.code} assigned`,
        body: result.mode === 'auto' ? 'Nearest free rider picked automatically' : result.order.driver?.name,
      });
      await load();
    } catch (error) {
      push({ tone: 'bad', title: 'Could not assign that run', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const bump = async (order: ActiveDelivery) => {
    setBusy(`bump-${order.id}`);
    try {
      await api.post(`/api/admin/orders/${order.id}/bump`);
      push({ tone: 'ok', title: `${order.code} moved on` });
      await load();
    } catch (error) {
      push({ tone: 'bad', title: 'Could not move that order', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  if (!fleet) return <Spinner label="Loading the fleet…" />;

  const unassigned = deliveries.filter((delivery) => !delivery.driver_id);
  const assigned = deliveries.filter((delivery) => delivery.driver_id);

  return (
    <div className="stack" style={{ marginTop: '0.6rem' }}>
      <div className="grid grid-4">
        <div className="card"><Stat label="Riders on shift" value={fleet.availability.ridersOnShift} /></div>
        <div className="card"><Stat label="Free now" value={fleet.availability.ridersFree} tone="ok" /></div>
        <div className="card"><Stat label="Out on runs" value={fleet.availability.ridersBusy} /></div>
        <div className="card"><Stat label="Off shift" value={fleet.availability.ridersOffline} /></div>
      </div>

      {!fleet.availability.available ? (
        <div className="notice notice-warn">
          <span aria-hidden>🛵</span>
          <span>{fleet.availability.reason} Put a rider on shift below to re-open delivery.</span>
        </div>
      ) : (
        <div className="notice notice-ok">
          <span aria-hidden>✅</span>
          <span>{fleet.availability.message}. Delivery orders are being offered to customers.</span>
        </div>
      )}

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <section className="card">
          <div className="card-head">
            <h3 style={{ margin: 0 }}>Rider roster</h3>
            <Pill tone="gold">{fleet.riders.length} riders</Pill>
          </div>
          <div className="stack" style={{ gap: '0.7rem' }}>
            {fleet.riders.map((rider) => (
              <div className="card card-tight" key={rider.id}>
                <div className="row-between wrap">
                  <div className="rider-card">
                    <span className="avatar">{initials(rider.name)}</span>
                    <div>
                      <div className="row" style={{ gap: '0.4rem' }}>
                        <strong>{rider.name}</strong>
                        <StatusPill status={rider.status} />
                      </div>
                      <div className="tiny muted">
                        {vehicleIcon(rider.vehicle)} {rider.vehicle} {rider.plate ? `· ${rider.plate}` : ''} · ★ {rider.rating.toFixed(1)} · {rider.deliveries} deliveries
                      </div>
                      <div className="tiny muted">{rider.phone} · {rider.zone}</div>
                    </div>
                  </div>
                  <div className="right">
                    <div className="small">
                      <strong>{rider.activeOrders}</strong>/{rider.capacity} runs
                    </div>
                    <div className="tiny muted">{rider.deliveredToday} today</div>
                    <div className="row" style={{ gap: '0.35rem', marginTop: '0.35rem' }}>
                      {rider.status === 'offline' ? (
                        <button className="btn btn-xs" disabled={busy === `rider-${rider.id}`} onClick={() => setStatus(rider, 'online')}>
                          Put on shift
                        </button>
                      ) : (
                        <button className="btn btn-xs btn-ghost" disabled={busy === `rider-${rider.id}` || rider.activeOrders > 0} onClick={() => setStatus(rider, 'offline')}>
                          End shift
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="stack">
          <section className="card">
            <div className="card-head">
              <h3 style={{ margin: 0 }}>Waiting for a rider</h3>
              <div className="row" style={{ gap: '0.4rem' }}>
                <Pill tone={unassigned.length ? 'warn' : 'ok'}>{unassigned.length}</Pill>
                <button className="btn btn-xs" onClick={() => assign(unassigned[0], 'auto')} disabled={!unassigned.length || busy !== null}>
                  Auto-assign next
                </button>
              </div>
            </div>

            {unassigned.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>Every delivery has a rider. Nice.</p>
            ) : (
              <div className="stack" style={{ gap: '0.6rem' }}>
                {unassigned.map((order) => (
                  <div className="card card-tight" key={order.id}>
                    <div className="row-between">
                      <strong className="mono">{order.code}</strong>
                      <Pill tone="warn">{order.durationMinutes} min old</Pill>
                    </div>
                    <div className="small muted">📍 {order.address_line}{order.address_suburb ? `, ${order.address_suburb}` : ''}</div>
                    <div className="tiny muted">{order.items.length} items · {money(order.total)} · fee {money(order.delivery_fee)}</div>
                    <div className="row wrap" style={{ gap: '0.35rem', marginTop: '0.5rem' }}>
                      <button className="btn btn-xs" disabled={busy === `order-${order.id}`} onClick={() => assign(order, 'auto')}>
                        ⚡ Auto
                      </button>
                      {fleet.riders.filter((rider) => rider.status !== 'offline').map((rider) => (
                        <button
                          key={rider.id}
                          className="btn btn-xs btn-ghost"
                          disabled={busy === `order-${order.id}`}
                          onClick={() => assign(order, rider.id)}
                          title={`${rider.activeOrders}/${rider.capacity} runs`}
                        >
                          {vehicleIcon(rider.vehicle)} {rider.name.split(' ')[0]}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h3 style={{ margin: 0 }}>On the road</h3>
              <Pill>{assigned.length}</Pill>
            </div>
            {assigned.length === 0 ? (
              <Empty icon="🛵" title="No active deliveries" hint="Assigned runs will appear here with rider and ETA." />
            ) : (
              <div className="stack" style={{ gap: '0.6rem' }}>
                {assigned.map((order) => (
                  <div className="card card-tight" key={order.id}>
                    <div className="row-between wrap">
                      <div>
                        <div className="row" style={{ gap: '0.4rem' }}>
                          <strong className="mono">{order.code}</strong>
                          <StatusPill status={order.status} />
                        </div>
                        <div className="tiny muted">
                          {order.driver_name} · out {order.durationMinutes} min · {order.address_line || 'collecting'}
                        </div>
                        <div className="tiny muted">placed {timeAgo(order.created_at)} · {money(order.total)}</div>
                      </div>
                      <div className="row" style={{ gap: '0.35rem' }}>
                        <select
                          className="input"
                          style={{ width: 'auto', padding: '0.2rem 0.4rem', fontSize: '0.8rem' }}
                          value={order.driver_id ?? ''}
                          onChange={(event) => assign(order, Number(event.target.value))}
                        >
                          {fleet.riders.map((rider) => (
                            <option key={rider.id} value={rider.id}>
                              {rider.name} ({rider.activeOrders}/{rider.capacity})
                            </option>
                          ))}
                        </select>
                        {order.status === 'ready' ? (
                          <button className="btn btn-xs btn-ghost" disabled={busy === `bump-${order.id}`} onClick={() => bump(order)}>
                            Dispatch
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
