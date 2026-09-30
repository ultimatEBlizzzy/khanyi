import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import api from '../lib/api';
import { useLiveFeed } from '../lib/live';
import { useSession } from '../lib/session';
import { useToast, StatusPill, Pill, Spinner, Stars, Meter } from '../components/ui';
import { money, clockTime, dateTime, timeAgo, vehicleIcon, etaClock } from '../lib/format';
import type { Order } from '../lib/types';

const STEP_COPY: Record<string, string> = {
  pending: 'Order placed',
  confirmed: 'Confirmed by the store',
  preparing: 'In the kitchen',
  ready: 'Ready for collection',
  assigned: 'Rider assigned',
  picked_up: 'Collected by the rider',
  on_the_way: 'On the way to you',
  delivered: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
  rejected: 'Declined',
};

export default function Track() {
  const { code = '' } = useParams();
  const { user } = useSession();
  const { push } = useToast();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stars, setStars] = useState(5);
  const [comment, setComment] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ order: Order }>(`/api/orders/${code}`);
      setOrder(data.order);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [code]);

  useEffect(() => {
    void load();
  }, [load]);

  // Any event touching this order refreshes the view.
  useLiveFeed(['orders'], (event) => {
    if (event.type.startsWith('order.') || event.type === 'driver.status') void load();
  }, { enabled: Boolean(user) });

  const cancel = async () => {
    if (!order) return;
    setBusy(true);
    try {
      await api.post(`/api/orders/${order.id}/cancel`, { reason: 'Cancelled from the tracking page' });
      push({ tone: 'info', title: 'Order cancelled', body: 'We have released your items.' });
      await load();
    } catch (cause) {
      push({ tone: 'bad', title: 'Could not cancel', body: (cause as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const rate = async () => {
    if (!order) return;
    setBusy(true);
    try {
      await api.post(`/api/orders/${order.id}/rate`, { stars, comment });
      push({ tone: 'ok', title: 'Thanks for the feedback!', body: 'It helps the whole team.' });
      await load();
    } catch (cause) {
      push({ tone: 'bad', title: 'Could not save your rating', body: (cause as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="container-narrow section">
        <div className="card center">
          <h2>We could not find {code}</h2>
          <p className="muted">{error}</p>
          <Link className="btn btn-primary" to="/orders">See my orders</Link>
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="container-narrow section">
        <Spinner label="Fetching your order…" />
      </div>
    );
  }

  const finished = ['completed', 'delivered'].includes(order.status);
  const cancelled = ['cancelled', 'rejected'].includes(order.status);
  const canCancel = !finished && !cancelled && ['pending', 'confirmed'].includes(order.status);
  const steps = order.timeline.steps;
  const currentIndex = order.timeline.currentIndex;

  return (
    <div className="container section">
      <div className="row-between wrap" style={{ marginBottom: '1rem' }}>
        <div>
          <span className="eyebrow gold" style={{ letterSpacing: '0.2em', fontSize: '0.72rem' }}>
            {order.fulfilment === 'delivery' ? 'Delivery' : 'Collection'} · placed {timeAgo(order.created_at)}
          </span>
          <h1 style={{ margin: '0.2rem 0 0' }}>
            {order.code} <StatusPill status={order.status} label={order.statusLabel} />
          </h1>
        </div>
        <div className="row" style={{ gap: '0.5rem' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => { void navigator.clipboard?.writeText(order.code); push({ tone: 'info', title: 'Code copied' }); }}>
            Copy code
          </button>
          <Link className="btn btn-ghost btn-sm" to="/orders">All orders</Link>
        </div>
      </div>

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          {/* progress */}
          <section className="card card-gold">
            <div className="row-between">
              <h3 style={{ margin: 0 }}>
                {cancelled ? 'This order was cancelled' : finished ? 'All done — enjoy!' : STEP_COPY[order.status] ?? order.status}
              </h3>
              {!finished && !cancelled ? <Pill tone="gold">⏱ about {order.eta_minutes} min</Pill> : null}
            </div>

            {!cancelled ? (
              <div style={{ margin: '0.9rem 0 0.4rem' }}>
                <Meter value={currentIndex} max={steps.length - 1} />
                <div className="row-between tiny muted" style={{ marginTop: '0.3rem' }}>
                  <span>Placed {clockTime(order.created_at)}</span>
                  {!finished ? <span>Estimated {etaClock(order.eta_minutes)}</span> : order.completed_at ? <span>Finished {clockTime(order.completed_at)}</span> : null}
                </div>
              </div>
            ) : null}

            <ul className="timeline" style={{ marginTop: '1rem' }}>
              {steps.map((step, index) => {
                const done = index < currentIndex || (finished && index <= currentIndex);
                const isCurrent = index === currentIndex && !finished && !cancelled;
                const event = [...order.events].reverse().find((e) => e.to_state === step);
                return (
                  <li key={step} className={cancelled && index >= currentIndex ? 'cancelled' : done ? 'done' : isCurrent ? 'current' : ''}>
                    <div className="step">{STEP_COPY[step] ?? step}</div>
                    <div className="when">
                      {event ? `${clockTime(event.created_at)} · ${event.actor_name}` : isCurrent ? 'working on it…' : 'waiting'}
                      {event?.note ? ` · ${event.note}` : ''}
                    </div>
                  </li>
                );
              })}
              {cancelled ? (
                <li className="cancelled">
                  <div className="step">Cancelled</div>
                  <div className="when">{order.cancel_reason || 'No reason given'}</div>
                </li>
              ) : null}
            </ul>
          </section>

          {/* rider */}
          {order.driver ? (
            <section className="card">
              <h3>Your rider</h3>
              <div className="row-between wrap">
                <div className="rider-card">
                  <span className="avatar">{vehicleIcon(order.driver.vehicle)}</span>
                  <div>
                    <strong>{order.driver.name}</strong>
                    <div className="small muted">
                      {order.driver.vehicle} {order.driver.plate ? `· ${order.driver.plate}` : ''}
                    </div>
                  </div>
                </div>
                <a className="btn btn-sm" href={`tel:${order.driver.phone}`}>☎ Call rider</a>
              </div>
              <p className="tiny muted" style={{ marginTop: '0.6rem' }}>
                On the road for {timeAgo(order.events.find((e) => e.to_state === 'picked_up')?.created_at ?? order.ready_at)}.
              </p>
            </section>
          ) : order.fulfilment === 'delivery' && !cancelled ? (
            <section className="card">
              <h3>Rider assignment</h3>
              <p className="small muted" style={{ margin: 0 }}>
                {order.status === 'ready'
                  ? 'Your food is packed and waiting for the next free rider — this usually takes a few minutes.'
                  : 'A rider will be assigned as soon as the kitchen marks your order ready.'}
              </p>
            </section>
          ) : null}

          {/* receipt */}
          <section className="card">
            <h3>Your order</h3>
            {order.items.map((item) => (
              <div className="line-item" key={item.id}>
                <div className="grow">
                  <div className="row-between">
                    <span><strong>{item.qty} ×</strong> {item.name}</span>
                    <span className="mono">{money(item.line_total)}</span>
                  </div>
                  {item.options.length ? (
                    <div className="tiny muted">{item.options.map((option) => option.name).join(' · ')}</div>
                  ) : null}
                </div>
              </div>
            ))}
            <hr className="divider" />
            <div className="price-row"><span className="label">Subtotal</span><span>{money(order.subtotal)}</span></div>
            {order.delivery_fee > 0 ? <div className="price-row"><span className="label">Delivery</span><span>{money(order.delivery_fee)}</span></div> : null}
            {order.discount > 0 ? <div className="price-row"><span className="label">Discounts {order.promo_code ? `(${order.promo_code})` : ''}</span><span className="ok">−{money(order.discount)}</span></div> : null}
            <div className="price-row total"><span>Total</span><span>{money(order.total)}</span></div>
            <p className="tiny muted" style={{ marginTop: '0.5rem' }}>
              Payment: {order.payment_method.toUpperCase()} · placed {dateTime(order.created_at)}
              {order.points_earned ? ` · earned ${order.points_earned} points` : ''}
            </p>
          </section>
        </div>

        <aside className="stack">
          {order.fulfilment === 'delivery' ? (
            <section className="card">
              <h3>Delivery address</h3>
              <p className="small" style={{ margin: 0 }}>
                {order.address_line}
                {order.address_suburb ? <>, {order.address_suburb}</> : null}
              </p>
              {order.address_notes ? <p className="tiny muted">“{order.address_notes}”</p> : null}
              {order.distance_km ? <Pill tone="gold">{order.distance_km} km from the kitchen</Pill> : null}
            </section>
          ) : (
            <section className="card">
              <h3>Collection point</h3>
              <p className="small" style={{ margin: 0 }}>
                Khanyisile&rsquo;s Kitchen, Malamulele
                <br />
                <span className="muted">Open 06:00 – 22:00</span>
              </p>
              <a className="btn btn-sm" style={{ marginTop: '0.6rem' }} href="tel:0828373077">☎ 082 837 3077</a>
            </section>
          )}

          {(canCancel || busy) && !finished && !cancelled ? (
            <section className="card">
              <h3>Changed your mind?</h3>
              <p className="small muted">You can cancel free of charge until the kitchen starts cooking.</p>
              <button className="btn btn-danger btn-block" onClick={cancel} disabled={busy}>
                {busy ? <Spinner /> : 'Cancel this order'}
              </button>
            </section>
          ) : null}

          {finished && !order.has_rating ? (
            <section className="card card-gold">
              <h3>How was it?</h3>
              <div className="row" style={{ gap: '0.3rem', marginBottom: '0.5rem' }}>
                {[1, 2, 3, 4, 5].map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="icon-btn"
                    style={value <= stars ? { borderColor: 'var(--gold)', color: 'var(--gold-bright)' } : undefined}
                    onClick={() => setStars(value)}
                    aria-label={`${value} star${value === 1 ? '' : 's'}`}
                  >
                    ★
                  </button>
                ))}
              </div>
              <textarea
                className="input"
                rows={2}
                placeholder="Tell us about the food or the ride…"
                value={comment}
                onChange={(event) => setComment(event.target.value.slice(0, 400))}
              />
              <button className="btn btn-primary btn-block" style={{ marginTop: '0.6rem' }} onClick={rate} disabled={busy}>
                {busy ? <Spinner /> : 'Send rating'}
              </button>
            </section>
          ) : null}

          {order.has_rating ? (
            <section className="card">
              <h3>Thanks for rating</h3>
              <p className="small muted" style={{ margin: 0 }}>Your feedback was shared with the team.</p>
              <Stars value={5} />
            </section>
          ) : null}

          <section className="card">
            <h3>Need a hand?</h3>
            <p className="small muted">
              Phone the kitchen on 082 837 3077 and quote <code className="inline">{order.code}</code>.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
