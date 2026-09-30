import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import api from '../lib/api';
import { useCart } from '../lib/cart';
import { useSession } from '../lib/session';
import { useStoreStatus } from '../lib/store';
import { useToast, Modal, Pill, Empty, LoadingCard } from '../components/ui';
import { money, dishEmoji, categoryIcon } from '../lib/format';
import type { Category, MenuItem, OptionGroup, StoreBootstrap } from '../lib/types';

/* ------------------------------ option picker ----------------------------- */

function OptionPicker({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  const { add, setOpen } = useCart();
  const { push } = useToast();
  const [qty, setQty] = useState(1);
  const [chosen, setChosen] = useState<Record<number, number[]>>(() => {
    const initial: Record<number, number[]> = {};
    for (const group of item.optionGroups) {
      if (group.required && group.kind === 'single' && group.options[0]) {
        initial[group.id] = [group.options[0].id];
      } else {
        initial[group.id] = [];
      }
    }
    return initial;
  });
  const [error, setError] = useState<string | null>(null);

  const toggle = (group: OptionGroup, optionId: number) => {
    setError(null);
    setChosen((current) => {
      const selected = current[group.id] ?? [];
      if (group.kind === 'single') return { ...current, [group.id]: [optionId] };
      if (selected.includes(optionId)) {
        return { ...current, [group.id]: selected.filter((id) => id !== optionId) };
      }
      if (selected.length >= group.max_pick) {
        return { ...current, [group.id]: [...selected.slice(1), optionId] };
      }
      return { ...current, [group.id]: [...selected, optionId] };
    });
  };

  const optionIds = useMemo(() => Object.values(chosen).flat(), [chosen]);

  const unitPrice = useMemo(() => {
    let price = item.base_price;
    for (const group of item.optionGroups) {
      for (const option of group.options) {
        if (optionIds.includes(option.id)) price += option.price_delta;
      }
    }
    return price;
  }, [item, optionIds]);

  const addToBasket = () => {
    for (const group of item.optionGroups) {
      if (group.required && (chosen[group.id] ?? []).length === 0) {
        setError(`Please choose ${group.name}`);
        return;
      }
    }
    add(item, optionIds, qty);
    push({ tone: 'gold', title: `${qty} × ${item.name} added`, body: money(unitPrice * qty) });
    onClose();
    setOpen(true);
  };

  return (
    <Modal
      title={
        <span className="row" style={{ gap: '0.6rem' }}>
          <span aria-hidden style={{ fontSize: '1.4rem' }}>{dishEmoji(item)}</span>
          {item.name}
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <span className="qty">
            <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Fewer">−</button>
            <span>{qty}</span>
            <button type="button" onClick={() => setQty((q) => Math.min(50, q + 1))} aria-label="More">+</button>
          </span>
          <button className="btn btn-primary" onClick={addToBasket}>
            Add · {money(unitPrice * qty)}
          </button>
        </>
      }
    >
      <p className="muted small">{item.description}</p>
      <div className="row wrap" style={{ gap: '0.4rem', marginBottom: '0.8rem' }}>
        <Pill tone="gold">{money(item.base_price)} base</Pill>
        <Pill>⏱ {item.prep_minutes} min in the kitchen</Pill>
        {item.availableStock !== null ? <Pill tone={item.availableStock > 5 ? 'ok' : 'warn'}>{item.availableStock} left today</Pill> : null}
        {item.badge ? <Pill tone="info">{item.badge}</Pill> : null}
      </div>

      {item.optionGroups.map((group) => (
        <fieldset className="option-group" key={group.id}>
          <legend>
            {group.name}
            {group.required ? <span className="bad"> *</span> : <span className="muted"> (optional)</span>}
            {group.kind === 'multi' ? <span className="muted"> · choose up to {group.max_pick}</span> : null}
          </legend>
          {group.options.map((option) => {
            const checked = (chosen[group.id] ?? []).includes(option.id);
            const disabled = !option.is_available;
            return (
              <label className="option-row" key={option.id} style={disabled ? { opacity: 0.45 } : undefined}>
                <span className="row" style={{ gap: '0.55rem' }}>
                  <input
                    type={group.kind === 'single' ? 'radio' : 'checkbox'}
                    name={`group-${group.id}`}
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggle(group, option.id)}
                  />
                  <span>{option.name}</span>
                </span>
                <span className="price">
                  {option.price_delta === 0 ? 'included' : `+ ${money(option.price_delta)}`}
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}

      {error ? <div className="notice notice-error"><span aria-hidden>⚠️</span><span>{error}</span></div> : null}
    </Modal>
  );
}

/* -------------------------------- dish card ------------------------------- */

function DishCard({ item, onOpen }: { item: MenuItem; onOpen: () => void }) {
  return (
    <article className={`card dish${item.soldOut ? ' sold-out' : ''}`}>
      <div className="dish-thumb" aria-hidden>{dishEmoji(item)}</div>
      <div className="dish-title">
        <span className="dish-name">{item.name}</span>
        <span className="dish-price">{money(item.base_price)}</span>
      </div>
      <p className="dish-desc">{item.description}</p>
      <div className="row wrap" style={{ gap: '0.35rem' }}>
        {item.badge && !item.soldOut ? <Pill tone="gold">{item.badge}</Pill> : null}
        {item.soldOut ? (
          <Pill tone="bad">{item.soldOutReason}</Pill>
        ) : (
          <Pill>{item.availableStock !== null ? `${item.availableStock} left` : `${item.prep_minutes} min`}</Pill>
        )}
      </div>
      <button className="btn btn-block" onClick={onOpen} disabled={item.soldOut}>
        {item.soldOut ? 'Currently unavailable' : item.optionGroups.some((g) => g.required) ? 'Choose options' : 'Add to basket'}
      </button>
    </article>
  );
}

/* ------------------------------- storefront ------------------------------- */

export default function Storefront() {
  const [data, setData] = useState<StoreBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [picking, setPicking] = useState<MenuItem | null>(null);
  const [query, setQuery] = useState('');
  const { status } = useStoreStatus(45_000);
  const { user } = useSession();
  const { count, setOpen } = useCart();

  const load = async () => {
    try {
      setData(await api.get<StoreBootstrap>('/api/store'));
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const categories: Category[] = data?.menu ?? [];

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return categories
      .filter((category) => activeCategory === 'all' || category.slug === activeCategory)
      .map((category) => ({
        ...category,
        items: needle
          ? category.items.filter(
              (item) =>
                item.name.toLowerCase().includes(needle) ||
                item.description.toLowerCase().includes(needle),
            )
          : category.items,
      }))
      .filter((category) => category.items.length > 0);
  }, [categories, activeCategory, query]);

  const totalDishes = categories.reduce((sum, category) => sum + category.items.length, 0);
  const soldOut = categories.flatMap((category) => category.items).filter((item) => item.soldOut);

  if (error) {
    return (
      <div className="container section">
        <div className="card center">
          <h2>We could not load the menu</h2>
          <p className="muted">{error}</p>
          <button className="btn btn-primary" onClick={load}>Try again</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <section className="hero">
        <div className="hero-media">
          <img src="/hero-spread.jpg" alt="" />
        </div>
        <div className="container">
          <div className="hero-content rise">
            <div className="hero-script">Khanyisile&rsquo;s Kitchen</div>
            <div className="hero-tag">Sweet Treats · Malamulele</div>
            <div className="gold-rule" />
            <p className="hero-copy">
              Good food, good mood — always. Wings dunked in bold sauce, toasted sandwiches,
              sharing platters, popcorn and the treats that made our name.
              <strong className="gold"> Collection or delivery by bike.</strong>
            </p>
            <div className="hero-chips">
              <Pill tone={status?.open && status?.acceptingOrders ? 'ok' : 'bad'}>
                <span className={`dot ${status?.open && status?.acceptingOrders ? 'dot-live' : 'dot-bad'}`} />
                {status?.acceptingOrders ? 'Open · 06:00–22:00' : 'Orders paused'}
              </Pill>
              <Pill tone={status?.delivery.available ? 'ok' : 'warn'}>
                {status?.delivery.available
                  ? `🛵 ${status.delivery.ridersFree} rider${status.delivery.ridersFree === 1 ? '' : 's'} free`
                  : '🏪 Collection only right now'}
              </Pill>
              <Pill tone="gold">Free delivery over {money(data?.delivery.freeOver ?? 20000)}</Pill>
              <Pill>📍 Within {data?.delivery.radiusKm ?? 12} km of Malamulele</Pill>
            </div>
            {data?.store.announcement ? (
              <p className="small gold" style={{ marginTop: '0.9rem' }}>
                <strong>Today:</strong> {data.store.announcement}
              </p>
            ) : null}
            <div className="row wrap" style={{ marginTop: '1.1rem', gap: '0.6rem' }}>
              <a className="btn btn-primary btn-lg" href="#menu">Browse the menu</a>
              {user ? (
                <Link className="btn btn-ghost btn-lg" to="/orders">Track my orders</Link>
              ) : (
                <Link className="btn btn-ghost btn-lg" to="/register">Create an account</Link>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="container">
        <section className="section" id="menu">
          <div className="section-head">
            <div>
              <span className="eyebrow">The menu</span>
              <h2 style={{ margin: 0 }}>Made with passion, served with love</h2>
              <p className="muted small" style={{ margin: '0.3rem 0 0' }}>
                {totalDishes} dishes across {categories.length} sections
                {soldOut.length ? ` · ${soldOut.length} sold out today` : ''}
              </p>
            </div>
            <input
              className="input hidden-sm"
              style={{ maxWidth: 240 }}
              placeholder="Search the menu…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className="chip-row">
            <button className={`chip${activeCategory === 'all' ? ' active' : ''}`} onClick={() => setActiveCategory('all')}>
              ✨ Everything
            </button>
            {categories.map((category) => (
              <button
                key={category.slug}
                className={`chip${activeCategory === category.slug ? ' active' : ''}`}
                onClick={() => setActiveCategory(category.slug)}
              >
                {categoryIcon(category.slug, category.icon)} {category.name}
                <span className="muted">{category.items.length}</span>
              </button>
            ))}
          </div>

          {!data ? (
            <div className="grid grid-3">
              {Array.from({ length: 6 }).map((_, index) => <LoadingCard key={index} />)}
            </div>
          ) : filtered.length === 0 ? (
            <Empty icon="🔍" title="Nothing matched that" hint="Try another word or browse a category." />
          ) : (
            filtered.map((category) => (
              <div key={category.slug} style={{ marginTop: '1.6rem' }}>
                <div className="row-between" style={{ marginBottom: '0.7rem' }}>
                  <h3 style={{ margin: 0 }}>
                    <span aria-hidden style={{ marginRight: '0.4rem' }}>{categoryIcon(category.slug, category.icon)}</span>
                    {category.name}
                  </h3>
                  <span className="muted small hidden-sm">{category.blurb}</span>
                </div>
                <div className="grid grid-menu">
                  {category.items.map((item) => (
                    <DishCard key={item.id} item={item} onOpen={() => setPicking(item)} />
                  ))}
                </div>
              </div>
            ))
          )}

          {data?.promos.length ? (
            <div className="card card-gold" style={{ marginTop: '2rem' }}>
              <div className="row-between wrap">
                <div>
                  <span className="eyebrow">Deals on right now</span>
                  <h3 style={{ margin: '0.2rem 0 0' }}>Save on your favourites</h3>
                </div>
                <div className="row wrap" style={{ gap: '0.5rem' }}>
                  {data.promos.map((promo) => (
                    <Pill key={promo.code} tone="gold">
                      <span className="mono">{promo.code}</span> · {promo.description}
                    </Pill>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </section>
      </div>

      {count > 0 ? (
        <button className="cart-fab" onClick={() => setOpen(true)}>
          🛒 <span className="count">{count}</span> View basket
        </button>
      ) : null}

      {picking ? <OptionPicker item={picking} onClose={() => setPicking(null)} /> : null}
    </>
  );
}
