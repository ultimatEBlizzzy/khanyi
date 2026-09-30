import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Drawer, Pill, Spinner } from './ui';
import { useCart } from '../lib/cart';
import { useSession } from '../lib/session';
import { useStoreStatus } from '../lib/store';
import { money, dishEmoji, etaClock } from '../lib/format';
import api from '../lib/api';

/**
 * The basket. Every total shown here comes from the server quote, so the
 * number the customer agrees to is the number the kitchen receives.
 */
export default function BasketDrawer() {
  const {
    open, setOpen, lines, quote, quoting, fulfilment, setFulfilment, setQty, remove,
    promoCode, setPromoCode, redeemPoints, setRedeemPoints, clear, address,
  } = useCart();
  const { user } = useSession();
  const { status } = useStoreStatus(45_000);
  const navigate = useNavigate();
  const [promoDraft, setPromoDraft] = useState('');
  const [applying, setApplying] = useState(false);
  const [promoFeedback, setPromoFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (promoCode) setPromoDraft(promoCode);
  }, [promoCode]);

  if (!open) return null;

  const delivery = status?.delivery;
  const ridersAvailable = delivery ? delivery.available : true;
  const errors = quote?.issues.filter((issue) => issue.type === 'error') ?? [];
  const warnings = quote?.issues.filter((issue) => issue.type === 'warning') ?? [];
  const canCheckout = Boolean(quote?.canCheckout && lines.length > 0);

  const applyPromo = async () => {
    setApplying(true);
    setPromoFeedback(null);
    try {
      const code = promoDraft.trim().toUpperCase();
      if (!code) {
        setPromoCode('');
        return;
      }
      // Send the basket value so the server can check the minimum spend.
      const subtotal = quote?.subtotal ?? lines.reduce((sum, line) => sum + line.previewUnitPrice * line.qty, 0);
      await api.get<{ promo: { code: string } }>(
        `/api/orders/promo/${encodeURIComponent(code)}?subtotal=${subtotal}`,
      );
      setPromoCode(code);
      setPromoFeedback(`Code ${code} applied`);
    } catch (error) {
      setPromoCode('');
      setPromoFeedback((error as Error).message);
    } finally {
      setApplying(false);
    }
  };

  return (
    <Drawer
      title={`Your basket${lines.length ? ` · ${lines.length} line${lines.length === 1 ? '' : 's'}` : ''}`}
      onClose={() => setOpen(false)}
      footer={
        <div className="stack" style={{ gap: '0.55rem' }}>
          {errors.map((issue) => (
            <div className="notice notice-error" key={issue.code + issue.message}>
              <span aria-hidden>⚠️</span><span>{issue.message}</span>
            </div>
          ))}
          <div className="price-row">
            <span className="label">Subtotal</span>
            <span>{money(quote?.subtotal ?? lines.reduce((sum, line) => sum + line.previewUnitPrice * line.qty, 0))}</span>
          </div>
          <div className="price-row">
            <span className="label">{fulfilment === 'delivery' ? 'Delivery' : 'Collection'}</span>
            <span>{fulfilment === 'delivery' ? money(quote?.deliveryFee ?? 0) : 'Free'}</span>
          </div>
          {quote && quote.discount > 0 ? (
            <div className="price-row">
              <span className="label">Discounts</span>
              <span className="ok">−{money(quote.discount)}</span>
            </div>
          ) : null}
          <div className="price-row total">
            <span>Total</span>
            <span>{money(quote?.total ?? 0)}</span>
          </div>
          <button
            className="btn btn-primary btn-lg btn-block"
            disabled={!canCheckout || quoting}
            onClick={() => {
              setOpen(false);
              navigate('/checkout');
            }}
          >
            {quoting ? 'Pricing…' : `Checkout · ${money(quote?.total ?? 0)}`}
          </button>
          {quote ? (
            <span className="tiny muted center">
              {fulfilment === 'delivery'
                ? `Arrives about ${etaClock(quote.etaMinutes)} · ${quote.etaMinutes} min`
                : `Ready for collection about ${etaClock(quote.etaMinutes)}`}
            </span>
          ) : null}
          {!user ? (
            <p className="tiny muted center" style={{ margin: 0 }}>
              You will be asked to sign in — it takes 20 seconds and keeps your order safe.
            </p>
          ) : null}
        </div>
      }
    >
      {lines.length === 0 ? (
        <div className="empty">
          <div className="big" aria-hidden>🧺</div>
          <h3>Your basket is empty</h3>
          <p className="small">Add wings, a platter or something sweet to get started.</p>
        </div>
      ) : (
        <div className="stack">
          <div className="seg" style={{ width: '100%' }}>
            <button
              type="button"
              style={{ flex: 1 }}
              className={fulfilment === 'collection' ? 'active' : ''}
              onClick={() => setFulfilment('collection')}
            >
              🏪 Collection
            </button>
            <button
              type="button"
              style={{ flex: 1 }}
              className={fulfilment === 'delivery' ? 'active' : ''}
              onClick={() => ridersAvailable && setFulfilment('delivery')}
              disabled={!ridersAvailable}
              title={ridersAvailable ? 'Delivered by bike' : delivery?.reason}
            >
              🛵 Delivery
            </button>
          </div>

          {fulfilment === 'delivery' ? (
            <div className={`notice ${delivery?.available ? 'notice-info' : 'notice-warn'}`}>
              <span aria-hidden>🛵</span>
              <span>
                {delivery?.available
                  ? delivery.message
                  : delivery?.reason ?? 'Delivery is paused — choose collection or try again shortly.'}
                {address ? <span className="muted"> · {address.line1}</span> : null}
              </span>
            </div>
          ) : (
            <div className="notice notice-info">
              <span aria-hidden>🏪</span>
              <span>Collect from the kitchen in Malamulele — we will ping you when it is packed.</span>
            </div>
          )}

          {lines.map((line, index) => {
            const live = quote?.lines[index];
            return (
              <div className="line-item" key={`${line.itemId}-${line.optionIds.join('-')}`}>
                <span className="line-thumb" aria-hidden>{dishEmoji(line)}</span>
                <div className="grow">
                  <div className="row-between">
                    <strong>{line.name}</strong>
                    <span className="mono">{money(live?.lineTotal ?? line.previewUnitPrice * line.qty)}</span>
                  </div>
                  {line.options.length ? (
                    <div className="tiny muted">{line.options.map((option) => option.name).join(' · ')}</div>
                  ) : null}
                  {live?.issue ? <div className="tiny bad">{live.issue}</div> : null}
                  <div className="row-between" style={{ marginTop: '0.35rem' }}>
                    <span className="qty">
                      <button type="button" onClick={() => setQty(index, line.qty - 1)} aria-label={`Fewer ${line.name}`}>−</button>
                      <span>{line.qty}</span>
                      <button type="button" onClick={() => setQty(index, line.qty + 1)} aria-label={`More ${line.name}`}>+</button>
                    </span>
                    <button type="button" className="btn btn-xs btn-ghost" onClick={() => remove(index)}>Remove</button>
                  </div>
                </div>
              </div>
            );
          })}

          <hr className="divider" />

          <div>
            <label className="field">
              <span>Promo code</span>
              <div className="row" style={{ gap: '0.4rem' }}>
                <input
                  className="input"
                  placeholder="WINGS10"
                  value={promoDraft}
                  onChange={(event) => setPromoDraft(event.target.value.toUpperCase())}
                />
                <button type="button" className="btn btn-sm" onClick={applyPromo} disabled={applying}>
                  {applying ? '…' : 'Apply'}
                </button>
              </div>
            </label>
            {promoFeedback && !quote?.promo ? <div className="tiny muted">{promoFeedback}</div> : null}
            {quote?.promo ? (
              <div className="tiny ok">
                {quote.promo.code} — {quote.promo.description}
                {quote.promoDiscount > 0 ? ` (−${money(quote.promoDiscount)})` : ''}
              </div>
            ) : null}
          </div>

          {user && user.loyaltyPoints > 0 ? (
            <label className="switch">
              <input
                type="checkbox"
                checked={redeemPoints > 0}
                onChange={(event) => setRedeemPoints(event.target.checked ? user.loyaltyPoints : 0)}
              />
              <span className="switch-track" />
              <span className="small">
                Use my {user.loyaltyPoints} points
                {quote && quote.pointsDiscount > 0 ? ` (−${money(quote.pointsDiscount)})` : ''}
              </span>
            </label>
          ) : null}

          {warnings.map((issue) => (
            <div className="notice notice-warn" key={issue.code + issue.message}>
              <span aria-hidden>💡</span><span>{issue.message}</span>
            </div>
          ))}

          <div className="row-between tiny muted">
            <span>{quoting ? <Spinner label="Updating total" /> : ''}</span>
            <button type="button" className="btn btn-xs btn-ghost" onClick={clear}>Empty basket</button>
          </div>
          {quote && quote.pointsEarned > 0 ? (
            <Pill tone="gold">You will earn {quote.pointsEarned} points</Pill>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}
