import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import api, { ApiError } from '../lib/api';
import { useCart } from '../lib/cart';
import { useSession } from '../lib/session';
import { useStoreStatus } from '../lib/store';
import { useToast, Pill, Empty, Spinner } from '../components/ui';
import { money, etaClock, dishEmoji } from '../lib/format';
import type { Order } from '../lib/types';

const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash on collection / delivery', icon: '💵' },
  { value: 'card', label: 'Card machine on arrival', icon: '💳' },
  { value: 'eft', label: 'EFT before pickup', icon: '🏦' },
  { value: 'snapscan', label: 'SnapScan', icon: '📱' },
];

export default function Checkout() {
  const {
    lines, quote, quoting, fulfilment, setFulfilment, promoCode, redeemPoints,
    address, setAddress, clear,
  } = useCart();
  const { user, addresses, saveAddress } = useSession();
  const { status } = useStoreStatus(20_000);
  const navigate = useNavigate();
  const { push } = useToast();

  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [notes, setNotes] = useState('');
  const [customerPhone, setCustomerPhone] = useState(user?.phone ?? '');
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewAddress, setShowNewAddress] = useState(false);
  const [newAddress, setNewAddress] = useState({ label: 'Home', line1: '', suburb: 'Malamulele', notes: '' });
  const [locating, setLocating] = useState(false);

  // One idempotency key per basket attempt: a double tap cannot double-charge.
  const [idempotencyKey, setIdempotencyKey] = useState(
    () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );

  useEffect(() => {
    if (!customerPhone && user?.phone) setCustomerPhone(user.phone);
  }, [user?.phone, customerPhone]);

  const delivery = status?.delivery;
  const ridersAvailable = delivery?.available ?? true;
  const canDeliver = fulfilment === 'delivery' && ridersAvailable;

  const errors = quote?.issues.filter((issue) => issue.type === 'error') ?? [];
  const total = quote?.total ?? 0;

  const usingSaved = useMemo(
    () => addresses.find(
      (saved) => saved.line1 === address?.line1 && (saved.suburb ?? '') === (address?.suburb ?? ''),
    ),
    [addresses, address],
  );

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      push({ tone: 'bad', title: 'Your browser will not share a location', body: 'Type the address instead.' });
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setAddress({
          ...(address ?? { line1: '' }),
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        } as never);
        push({ tone: 'ok', title: 'Location pinned', body: 'We will use it for the delivery distance.' });
        setLocating(false);
      },
      () => {
        push({ tone: 'bad', title: 'Could not read your location', body: 'Type the address instead.' });
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  const addAddress = async () => {
    if (newAddress.line1.trim().length < 4) {
      push({ tone: 'bad', title: 'That address is too short' });
      return;
    }
    try {
      const saved = await saveAddress({
        label: newAddress.label,
        line1: newAddress.line1.trim(),
        suburb: newAddress.suburb.trim(),
        notes: newAddress.notes.trim(),
        lat: address?.lat ?? null,
        lng: address?.lng ?? null,
      });
      setAddress({
        label: saved.label, line1: saved.line1, suburb: saved.suburb,
        notes: saved.notes, lat: saved.lat, lng: saved.lng,
      });
      setShowNewAddress(false);
      push({ tone: 'ok', title: 'Address saved' });
    } catch (cause) {
      push({ tone: 'bad', title: 'Could not save that address', body: (cause as Error).message });
    }
  };

  const placeOrder = async () => {
    setError(null);
    setPlacing(true);
    try {
      const { order } = await api.post<{ order: Order; replayed: boolean }>(
        '/api/orders',
        {
          items: lines.map((line) => ({
            itemId: line.itemId,
            qty: line.qty,
            optionIds: line.optionIds,
            notes: line.notes,
          })),
          fulfilment,
          address: fulfilment === 'delivery' ? address : undefined,
          promoCode: promoCode || undefined,
          redeemPoints: redeemPoints || undefined,
          paymentMethod,
          customerPhone,
          notes,
        },
        { headers: { 'idempotency-key': idempotencyKey } },
      );

      push({
        tone: 'ok',
        title: `Order ${order.code} placed`,
        body: fulfilment === 'delivery' ? 'A rider will be assigned shortly.' : 'We will ping you when it is packed.',
      });
      clear();
      setIdempotencyKey(`web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
      navigate(`/orders/${order.code}`);
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : 'We could not place that order';
      setError(message);
      push({ tone: 'bad', title: 'Order not placed', body: message });
      // A fresh key means a retry after a real failure creates a new order,
      // while a network retry of the same tap still dedupes.
      setIdempotencyKey(`web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    } finally {
      setPlacing(false);
    }
  };

  if (lines.length === 0) {
    return (
      <div className="container section">
        <Empty icon="🧺" title="Your basket is empty" hint="Add something delicious before checking out." />
        <div className="center"><Link className="btn btn-primary" to="/">Browse the menu</Link></div>
      </div>
    );
  }

  const storeClosed = status && (!status.open || !status.acceptingOrders);

  return (
    <div className="container section">
      <div className="row-between wrap" style={{ marginBottom: '1rem' }}>
        <div>
          <span className="eyebrow gold" style={{ letterSpacing: '0.2em', fontSize: '0.72rem' }}>Checkout</span>
          <h1 style={{ margin: '0.2rem 0 0' }}>Almost eating</h1>
        </div>
        <Link className="btn btn-ghost btn-sm" to="/">← Keep shopping</Link>
      </div>

      {storeClosed ? (
        <div className="notice notice-warn" style={{ marginBottom: '1rem' }}>
          <span aria-hidden>🚪</span>
          <span>
            {status?.open
              ? 'The kitchen has paused new orders for a moment — you can still build your basket and try again shortly.'
              : `We are closed right now (${status?.hours}). Your basket will be waiting when we open.`}
          </span>
        </div>
      ) : null}

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          {/* fulfilment */}
          <section className="card">
            <h3>How would you like it?</h3>
            <div className="grid grid-2" style={{ gap: '0.7rem' }}>
              <button
                type="button"
                className={`card ${fulfilment === 'collection' ? 'card-gold' : ''}`}
                style={{ textAlign: 'left', cursor: 'pointer' }}
                onClick={() => setFulfilment('collection')}
              >
                <div className="row-between">
                  <strong>🏪 Collection</strong>
                  {fulfilment === 'collection' ? <Pill tone="gold">Selected</Pill> : null}
                </div>
                <p className="small muted" style={{ margin: '0.4rem 0 0' }}>
                  Pick up in Malamulele. {quote ? `Ready about ${etaClock(quote.etaMinutes)}.` : ''}
                </p>
              </button>
              <button
                type="button"
                className={`card ${fulfilment === 'delivery' ? 'card-gold' : ''}`}
                style={{ textAlign: 'left', cursor: ridersAvailable ? 'pointer' : 'not-allowed', opacity: ridersAvailable ? 1 : 0.6 }}
                onClick={() => ridersAvailable && setFulfilment('delivery')}
                disabled={!ridersAvailable}
              >
                <div className="row-between">
                  <strong>🛵 Delivery</strong>
                  {fulfilment === 'delivery' ? <Pill tone="gold">Selected</Pill> : null}
                </div>
                <p className="small muted" style={{ margin: '0.4rem 0 0' }}>
                  {ridersAvailable
                    ? quote ? `Arrives about ${etaClock(quote.etaMinutes)} · ${money(quote.deliveryFee)}.` : 'Priced by distance.'
                    : delivery?.reason ?? 'No riders on shift right now.'}
                </p>
              </button>
            </div>
          </section>

          {/* address */}
          {fulfilment === 'delivery' ? (
            <section className="card">
              <div className="row-between">
                <h3 style={{ margin: 0 }}>Where should the rider go?</h3>
                <button className="btn btn-xs btn-ghost" onClick={useMyLocation} disabled={locating}>
                  {locating ? '…' : '📍 Pin my location'}
                </button>
              </div>

              <div className="stack" style={{ marginTop: '0.8rem' }}>
                {addresses.map((saved) => {
                  const active = usingSaved?.id === saved.id;
                  return (
                    <button
                      key={saved.id}
                      type="button"
                      className={`card card-tight ${active ? 'card-gold' : ''}`}
                      style={{ textAlign: 'left', cursor: 'pointer' }}
                      onClick={() =>
                        setAddress({
                          label: saved.label, line1: saved.line1, suburb: saved.suburb,
                          notes: saved.notes, lat: saved.lat, lng: saved.lng,
                        })
                      }
                    >
                      <div className="row-between">
                        <strong>{saved.label}</strong>
                        {saved.is_default ? <Pill>default</Pill> : null}
                      </div>
                      <div className="small muted">{saved.line1}{saved.suburb ? `, ${saved.suburb}` : ''}</div>
                    </button>
                  );
                })}

                {!usingSaved && address ? (
                  <div className="card card-tight card-gold">
                    <strong className="small">Using: {address.line1}</strong>
                    {address.suburb ? <div className="small muted">{address.suburb}</div> : null}
                    {address.lat ? <div className="tiny muted">📍 pinned</div> : <div className="tiny warn">Not pinned — the store may confirm the fee</div>}
                  </div>
                ) : null}

                {showNewAddress ? (
                  <div className="stack">
                    <label className="field">
                      <span>Label</span>
                      <input className="input" value={newAddress.label} onChange={(e) => setNewAddress({ ...newAddress, label: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>Street address</span>
                      <input className="input" placeholder="1123 Malamulele Main Road" value={newAddress.line1} onChange={(e) => setNewAddress({ ...newAddress, line1: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>Suburb</span>
                      <input className="input" value={newAddress.suburb} onChange={(e) => setNewAddress({ ...newAddress, suburb: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>Notes for the rider</span>
                      <input className="input" placeholder="Green gate, hoot twice" value={newAddress.notes} onChange={(e) => setNewAddress({ ...newAddress, notes: e.target.value })} />
                    </label>
                    <div className="row" style={{ gap: '0.5rem' }}>
                      <button className="btn btn-primary btn-sm" onClick={addAddress} type="button">Save address</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setShowNewAddress(false)} type="button">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button className="btn btn-ghost btn-sm" onClick={() => setShowNewAddress(true)} type="button">
                    + Add a new address
                  </button>
                )}
              </div>
            </section>
          ) : null}

          {/* contact + payment */}
          <section className="card">
            <h3>Payment &amp; contact</h3>
            <label className="field">
              <span>Contact number for this order</span>
              <input className="input" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="073 811 2207" />
            </label>
            <div className="grid grid-2" style={{ gap: '0.5rem' }}>
              {PAYMENT_METHODS.map((method) => (
                <button
                  key={method.value}
                  type="button"
                  className={`card card-tight ${paymentMethod === method.value ? 'card-gold' : ''}`}
                  style={{ textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => setPaymentMethod(method.value)}
                >
                  <span aria-hidden style={{ marginRight: '0.4rem' }}>{method.icon}</span>
                  <span className="small">{method.label}</span>
                </button>
              ))}
            </div>
            <label className="field" style={{ marginTop: '0.8rem' }}>
              <span>Notes for the kitchen</span>
              <textarea
                className="input"
                rows={2}
                placeholder="Extra peri-peri on the side, no cutlery thanks"
                value={notes}
                onChange={(event) => setNotes(event.target.value.slice(0, 300))}
              />
            </label>
          </section>
        </div>

        {/* summary */}
        <aside className="stack" style={{ position: 'sticky', top: '5.5rem' }}>
          <section className="card card-gold">
            <div className="row-between">
              <h3 style={{ margin: 0 }}>Order summary</h3>
              {quoting ? <Spinner /> : null}
            </div>

            <div style={{ marginTop: '0.6rem' }}>
              {lines.map((line, index) => {
                const live = quote?.lines[index];
                return (
                  <div className="line-item" key={`${line.itemId}-${line.optionIds.join('-')}`}>
                    <span className="line-thumb" aria-hidden>{dishEmoji(line)}</span>
                    <div className="grow">
                      <div className="row-between">
                        <span>
                          <strong>{line.qty} ×</strong> {line.name}
                        </span>
                        <span className="mono">{money(live?.lineTotal ?? line.previewUnitPrice * line.qty)}</span>
                      </div>
                      {line.options.length ? (
                        <div className="tiny muted">{line.options.map((option) => option.name).join(' · ')}</div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>

            <hr className="divider" />

            <div className="price-row"><span className="label">Subtotal</span><span>{money(quote?.subtotal ?? 0)}</span></div>
            {fulfilment === 'delivery' ? (
              <div className="price-row">
                <span className="label">Delivery{quote && quote.distanceKm ? ` · ${quote.distanceKm} km` : ''}</span>
                <span>{money(quote?.deliveryFee ?? 0)}</span>
              </div>
            ) : (
              <div className="price-row"><span className="label">Collection</span><span className="ok">Free</span></div>
            )}
            {quote && quote.promoDiscount > 0 ? (
              <div className="price-row"><span className="label">Promo {quote.promo?.code}</span><span className="ok">−{money(quote.promoDiscount)}</span></div>
            ) : null}
            {quote && quote.pointsDiscount > 0 ? (
              <div className="price-row"><span className="label">Loyalty points</span><span className="ok">−{money(quote.pointsDiscount)}</span></div>
            ) : null}
            <div className="price-row total"><span>Total</span><span>{money(total)}</span></div>

            {quote?.pointsEarned ? (
              <p className="tiny muted" style={{ marginTop: '0.4rem' }}>
                You will earn <strong className="gold">{quote.pointsEarned} points</strong> on this order.
              </p>
            ) : null}

            {errors.map((issue) => (
              <div className="notice notice-error" key={issue.code + issue.message} style={{ marginTop: '0.6rem' }}>
                <span aria-hidden>⚠️</span><span>{issue.message}</span>
              </div>
            ))}
            {error ? (
              <div className="notice notice-error" style={{ marginTop: '0.6rem' }}>
                <span aria-hidden>⚠️</span><span>{error}</span>
              </div>
            ) : null}

            <button
              className="btn btn-primary btn-lg btn-block"
              style={{ marginTop: '0.8rem' }}
              disabled={placing || !quote?.canCheckout || Boolean(storeClosed)}
              onClick={placeOrder}
            >
              {placing ? <Spinner label="Sending to the kitchen" /> : `Place order · ${money(total)}`}
            </button>

            <p className="tiny muted center" style={{ marginTop: '0.5rem' }}>
              {canDeliver
                ? `Delivery ${delivery?.message?.toLowerCase() ?? 'by bike'} · we will assign a rider when it is packed`
                : 'You will get a code to show at the counter'}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
