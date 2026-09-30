import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import api from '../../lib/api';
import { useLiveFeed } from '../../lib/live';
import { useToast, Pill, Spinner, StatusPill, Empty } from '../../components/ui';
import { money, dateTime, timeAgo } from '../../lib/format';
import type { Order } from '../../lib/types';

const STATUSES = ['', 'pending', 'confirmed', 'preparing', 'ready', 'assigned', 'picked_up', 'on_the_way', 'delivered', 'completed', 'cancelled'];

export default function OrdersAdmin() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');
  const [fulfilment, setFulfilment] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Order | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { push } = useToast();

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: '100' });
    if (status) params.set('status', status);
    if (fulfilment) params.set('fulfilment', fulfilment);
    if (search.trim()) params.set('search', search.trim());
    try {
      const data = await api.get<{ orders: Order[]; total: number }>(`/api/admin/orders?${params}`);
      setOrders(data.orders);
      setTotal(data.total);
    } catch (error) {
      push({ tone: 'bad', title: 'Could not load orders', body: (error as Error).message });
    }
  }, [status, fulfilment, search, push]);

  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  useLiveFeed(['orders', 'admin'], (event) => {
    if (event.type.startsWith('order.')) void load();
  });

  const openOrder = async (id: number) => {
    try {
      const data = await api.get<{ order: Order }>(`/api/admin/orders/${id}`);
      setSelected(data.order);
    } catch (error) {
      push({ tone: 'bad', title: 'Could not open that order', body: (error as Error).message });
    }
  };

  const act = async (order: Order, to: string) => {
    setBusy(`${order.id}-${to}`);
    try {
      await api.post(`/api/orders/${order.id}/transition`, { to });
      push({ tone: 'ok', title: `${order.code} → ${to.replace(/_/g, ' ')}` });
      await load();
      if (selected?.id === order.id) await openOrder(order.id);
    } catch (error) {
      push({ tone: 'bad', title: 'That move was refused', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (order: Order) => {
    setBusy(`${order.id}-cancel`);
    try {
      await api.post(`/api/orders/${order.id}/transition`, { to: 'cancelled', reason: 'Cancelled by store' });
      push({ tone: 'info', title: `${order.code} cancelled`, body: 'Stock has been returned.' });
      await load();
      if (selected?.id === order.id) await openOrder(order.id);
    } catch (error) {
      push({ tone: 'bad', title: 'Could not cancel', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack" style={{ marginTop: '0.6rem' }}>
      <div className="card">
        <div className="row wrap" style={{ gap: '0.6rem' }}>
          <input
            className="input"
            style={{ maxWidth: 220 }}
            placeholder="Search code, name, phone…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select className="input" style={{ maxWidth: 190 }} value={status} onChange={(event) => setStatus(event.target.value)}>
            {STATUSES.map((value) => (
              <option key={value} value={value}>{value ? value.replace(/_/g, ' ') : 'All statuses'}</option>
            ))}
          </select>
          <select className="input" style={{ maxWidth: 170 }} value={fulfilment} onChange={(event) => setFulfilment(event.target.value)}>
            <option value="">All types</option>
            <option value="collection">Collection</option>
            <option value="delivery">Delivery</option>
          </select>
          <span className="muted small grow right">{total} orders</span>
        </div>
      </div>

      {!orders ? (
        <Spinner label="Loading orders…" />
      ) : orders.length === 0 ? (
        <Empty icon="🧾" title="No orders match" hint="Try clearing the filters." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th><th>Placed</th><th>Customer</th><th>Type</th><th>Status</th><th>Rider</th><th>Total</th><th />
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} className={selected?.id === order.id ? 'sel' : ''}>
                  <td className="mono">{order.code}</td>
                  <td className="muted nowrap">{dateTime(order.created_at)}</td>
                  <td>
                    {order.customer_name}
                    <div className="tiny muted">{order.customer_phone}</div>
                  </td>
                  <td>{order.fulfilment === 'delivery' ? '🛵 Delivery' : '🏪 Collection'}</td>
                  <td><StatusPill status={order.status} label={order.statusLabel} /></td>
                  <td className="muted">{order.driver?.name ?? '—'}</td>
                  <td className="mono">{money(order.total)}</td>
                  <td>
                    <div className="row" style={{ gap: '0.3rem' }}>
                      <button className="btn btn-xs btn-ghost" onClick={() => openOrder(order.id)}>Open</button>
                      {['pending', 'confirmed', 'preparing', 'ready'].includes(order.status) ? (
                        <button className="btn btn-xs btn-danger" disabled={busy === `${order.id}-cancel`} onClick={() => cancel(order)}>
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected ? (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSelected(null)}>
          <div className="modal" style={{ width: 'min(760px, 100%)' }}>
            <header>
              <h3 style={{ margin: 0 }}>
                <span className="mono">{selected.code}</span> <StatusPill status={selected.status} label={selected.statusLabel} />
              </h3>
              <button className="icon-btn" onClick={() => setSelected(null)}>✕</button>
            </header>
            <div className="body">
              <div className="grid grid-2">
                <div>
                  <h4 className="eyebrow">Customer</h4>
                  <p className="small" style={{ margin: 0 }}>
                    {selected.customer_name}<br />
                    {selected.customer_phone}<br />
                    <span className="muted">{selected.fulfilment === 'delivery' ? `${selected.address_line}, ${selected.address_suburb}` : 'Collection in store'}</span>
                  </p>
                  {selected.address_notes ? <p className="tiny muted">“{selected.address_notes}”</p> : null}
                </div>
                <div>
                  <h4 className="eyebrow">Timing</h4>
                  <p className="small" style={{ margin: 0 }}>
                    Placed {timeAgo(selected.created_at)}<br />
                    ETA {selected.eta_minutes} min
                    {selected.driver ? <><br />Rider {selected.driver.name}</> : null}
                  </p>
                </div>
              </div>

              <hr className="divider" />

              {selected.items.map((item) => (
                <div className="row-between small" key={item.id} style={{ marginBottom: '0.3rem' }}>
                  <span>{item.qty} × {item.name}
                    {item.options.length ? <span className="tiny muted"> ({item.options.map((option) => option.name).join(', ')})</span> : null}
                  </span>
                  <span className="mono">{money(item.line_total)}</span>
                </div>
              ))}

              <hr className="divider" />
              <div className="price-row"><span className="label">Subtotal</span><span>{money(selected.subtotal)}</span></div>
              <div className="price-row"><span className="label">Delivery</span><span>{money(selected.delivery_fee)}</span></div>
              <div className="price-row"><span className="label">Discount</span><span>−{money(selected.discount)}</span></div>
              <div className="price-row total"><span>Total</span><span>{money(selected.total)}</span></div>

              <hr className="divider" />
              <h4 className="eyebrow">History</h4>
              <ul className="timeline">
                {selected.events.map((event) => (
                  <li key={event.id} className="done">
                    <div className="step">{event.to_state.replace(/_/g, ' ')}</div>
                    <div className="when">{dateTime(event.created_at)} · {event.actor_name}{event.note ? ` · ${event.note}` : ''}</div>
                  </li>
                ))}
              </ul>
            </div>
            <footer className="wrap">
              <Link className="btn btn-ghost btn-sm" to={`/orders/${selected.code}`}>Customer view</Link>
              <div className="row" style={{ gap: '0.4rem' }}>
                {['confirmed', 'preparing', 'ready'].includes(selected.status) ? (
                  <button className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => act(selected, selected.status === 'pending' ? 'confirmed' : selected.status === 'confirmed' ? 'preparing' : 'ready')}>
                    Move forward
                  </button>
                ) : null}
                {selected.status === 'ready' && selected.fulfilment === 'collection' ? (
                  <button className="btn btn-sm btn-ok" disabled={busy !== null} onClick={() => act(selected, 'completed')}>Mark collected</button>
                ) : null}
                {['pending', 'confirmed', 'preparing', 'ready'].includes(selected.status) ? (
                  <button className="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => cancel(selected)}>Cancel order</button>
                ) : null}
              </div>
            </footer>
          </div>
        </div>
      ) : null}

      <p className="tiny muted">
        Tip: tap <Pill>Open</Pill> for the full ticket, or use the kitchen screen for a one-tap flow.
      </p>
    </div>
  );
}
