import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import api from '../lib/api';
import { useLiveFeed } from '../lib/live';
import { useSession } from '../lib/session';
import { useCart } from '../lib/cart';
import { useToast, Empty, StatusPill, Pill, LoadingCard } from '../components/ui';
import { money, timeAgo, dishEmoji } from '../lib/format';
import type { Order } from '../lib/types';

export default function Orders() {
  const { user } = useSession();
  const { add, setOpen } = useCart();
  const { push } = useToast();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [tab, setTab] = useState<'active' | 'past'>('active');

  const load = useCallback(async () => {
    const data = await api.get<{ orders: Order[] }>('/api/orders?limit=60');
    setOrders(data.orders);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveFeed(['orders'], () => void load(), { enabled: Boolean(user) });

  const reorder = (order: Order) => {
    for (const item of order.items) {
      if (!item.item_id) continue;
      add(
        {
          id: item.item_id,
          slug: item.name.toLowerCase().replace(/\s+/g, '-'),
          name: item.name,
          description: '',
          base_price: item.unit_price,
          image: '',
          badge: '',
          track_stock: false,
          stock: 0,
          is_available: true,
          prep_minutes: 10,
          soldOut: false,
          soldOutReason: '',
          availableStock: null,
          optionGroups: [],
          category_id: 0,
        } as never,
        item.options.map((option) => (option as { optionId?: number }).optionId).filter(Boolean) as number[],
        item.qty,
      );
    }
    push({ tone: 'gold', title: 'Added to your basket', body: 'We will re-price it with today\u2019s menu.' });
    setOpen(true);
  };

  if (!orders) {
    return (
      <div className="container section">
        <div className="grid grid-2">
          <LoadingCard /><LoadingCard />
        </div>
      </div>
    );
  }

  const active = orders.filter((order) => !['completed', 'cancelled', 'rejected', 'delivered'].includes(order.status));
  const past = orders.filter((order) => !active.includes(order));
  const shown = tab === 'active' ? active : past;

  return (
    <div className="container section">
      <div className="row-between wrap" style={{ marginBottom: '1rem' }}>
        <div>
          <span className="eyebrow gold" style={{ letterSpacing: '0.2em', fontSize: '0.72rem' }}>Your orders</span>
          <h1 style={{ margin: '0.2rem 0 0' }}>Order history</h1>
        </div>
        <div className="seg">
          <button className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>
            In progress {active.length ? `(${active.length})` : ''}
          </button>
          <button className={tab === 'past' ? 'active' : ''} onClick={() => setTab('past')}>
            Past orders {past.length ? `(${past.length})` : ''}
          </button>
        </div>
      </div>

      {shown.length === 0 ? (
        <Empty
          icon={tab === 'active' ? '🕐' : '📜'}
          title={tab === 'active' ? 'Nothing on the go' : 'No past orders yet'}
          hint={tab === 'active' ? 'When you place an order you can follow it here, live.' : 'Your completed orders will appear here.'}
        />
      ) : (
        <div className="stack">
          {shown.map((order) => (
            <article className="card" key={order.id}>
              <div className="row-between wrap">
                <div className="row" style={{ gap: '0.7rem' }}>
                  <span className="line-thumb" aria-hidden>{dishEmoji({ slug: 'treat', name: order.items[0]?.name ?? 'order' })}</span>
                  <div>
                    <div className="row" style={{ gap: '0.5rem' }}>
                      <Link to={`/orders/${order.code}`} className="mono gold"><strong>{order.code}</strong></Link>
                      <StatusPill status={order.status} label={order.statusLabel} />
                    </div>
                    <div className="small muted">
                      {order.fulfilment === 'delivery' ? '🛵 Delivery' : '🏪 Collection'} · {timeAgo(order.created_at)}
                      {order.driver?.name ? ` · rider ${order.driver.name}` : ''}
                    </div>
                  </div>
                </div>
                <div className="right">
                  <div className="gold" style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem' }}>{money(order.total)}</div>
                  <div className="tiny muted">{order.items.reduce((sum, item) => sum + item.qty, 0)} items</div>
                </div>
              </div>

              <div className="row wrap" style={{ gap: '0.4rem', marginTop: '0.7rem' }}>
                {order.items.slice(0, 3).map((item) => (
                  <Pill key={item.id}>{item.qty} × {item.name}</Pill>
                ))}
                {order.items.length > 3 ? <Pill>+{order.items.length - 3} more</Pill> : null}
              </div>

              <div className="row wrap" style={{ gap: '0.5rem', marginTop: '0.8rem' }}>
                <Link className="btn btn-sm btn-primary" to={`/orders/${order.code}`}>
                  {['completed', 'delivered', 'cancelled', 'rejected'].includes(order.status) ? 'View receipt' : 'Track live'}
                </Link>
                <button className="btn btn-sm btn-ghost" onClick={() => reorder(order)}>Order again</button>
                {order.fulfilment === 'collection' && order.status === 'ready' ? (
                  <Pill tone="gold">Show {order.code} at the counter</Pill>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
