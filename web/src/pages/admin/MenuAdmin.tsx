import { useCallback, useEffect, useState } from 'react';

import api from '../../lib/api';
import { useLiveFeed } from '../../lib/live';
import { useToast, Pill, Spinner, Meter } from '../../components/ui';
import { money, dishEmoji } from '../../lib/format';
import type { Category, MenuItem, Promo } from '../../lib/types';

export default function MenuAdmin() {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [promos, setPromos] = useState<Promo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<MenuItem | null>(null);
  const [draft, setDraft] = useState({ base_price: 0, prep_minutes: 10, stock: 0, track_stock: false });
  const [newPromo, setNewPromo] = useState({ code: '', kind: 'percent', value: 10, minSubtotal: 15000, description: '' });
  const { push } = useToast();

  const load = useCallback(async () => {
    try {
      const [menu, promoList] = await Promise.all([
        api.get<{ categories: Category[] }>('/api/admin/menu'),
        api.get<{ promos: Promo[] }>('/api/admin/promos'),
      ]);
      setCategories(menu.categories);
      setPromos(promoList.promos);
    } catch (error) {
      push({ tone: 'bad', title: 'Could not load the menu', body: (error as Error).message });
    }
  }, [push]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveFeed(['staff'], (event) => {
    if (event.type === 'menu.updated') void load();
  });

  const toggleAvailability = async (item: MenuItem) => {
    setBusy(`item-${item.id}`);
    try {
      await api.patch(`/api/admin/menu/items/${item.id}`, { is_available: !item.is_available });
      push({ tone: 'info', title: `${item.name} is now ${item.is_available ? 'sold out' : 'available'}` });
      await load();
    } catch (error) {
      push({ tone: 'bad', title: 'Could not update the dish', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const toggleCategory = async (category: Category, isAvailable: boolean) => {
    setBusy(`cat-${category.id}`);
    try {
      await api.patch(`/api/admin/menu/categories/${category.id}/availability`, { is_available: isAvailable });
      push({ tone: 'info', title: `${category.name} ${isAvailable ? 'back on the menu' : 'removed from the menu'}` });
      await load();
    } catch (error) {
      push({ tone: 'bad', title: 'Could not update that section', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const startEdit = (item: MenuItem) => {
    setEditing(item);
    setDraft({
      base_price: item.base_price,
      prep_minutes: item.prep_minutes,
      stock: item.stock,
      track_stock: item.track_stock,
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    setBusy(`edit-${editing.id}`);
    try {
      await api.patch(`/api/admin/menu/items/${editing.id}`, {
        base_price: Math.round(draft.base_price),
        prep_minutes: draft.prep_minutes,
        stock: draft.stock,
        track_stock: draft.track_stock,
      });
      push({ tone: 'ok', title: `${editing.name} updated` });
      setEditing(null);
      await load();
    } catch (error) {
      push({ tone: 'bad', title: 'Could not save', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const createPromo = async () => {
    setBusy('promo');
    try {
      await api.post('/api/admin/promos', {
        code: newPromo.code.toUpperCase(),
        kind: newPromo.kind,
        value: newPromo.kind === 'free_delivery' ? 0 : Math.round(Number(newPromo.value)),
        minSubtotal: Math.round(Number(newPromo.minSubtotal)),
        description: newPromo.description || `${newPromo.code} discount`,
      });
      push({ tone: 'ok', title: `Promo ${newPromo.code.toUpperCase()} is live` });
      setNewPromo({ code: '', kind: 'percent', value: 10, minSubtotal: 15000, description: '' });
      await load();
    } catch (error) {
      push({ tone: 'bad', title: 'Could not create that promo', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const togglePromo = async (promo: Promo & { is_active?: number; id?: number }) => {
    setBusy(`promo-${promo.code}`);
    try {
      await api.patch(`/api/admin/promos/${promo.id}`, { is_active: !promo.is_active });
      await load();
    } catch (error) {
      push({ tone: 'bad', title: 'Could not update the promo', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  if (!categories) return <Spinner label="Loading the menu…" />;

  return (
    <div className="stack" style={{ marginTop: '0.6rem' }}>
      <div className="notice notice-info">
        <span aria-hidden>📋</span>
        <span>
          Switch a dish off the moment you run out — customers see “sold out” instantly, and nothing
          that is off the menu can be ordered.
        </span>
      </div>

      {categories.map((category) => {
        const available = category.items.filter((item) => !item.soldOut).length;
        return (
          <section className="card" key={category.id}>
            <div className="card-head wrap">
              <div className="row" style={{ gap: '0.6rem' }}>
                <span aria-hidden style={{ fontSize: '1.4rem' }}>{category.icon}</span>
                <div>
                  <h3 style={{ margin: 0 }}>{category.name}</h3>
                  <span className="tiny muted">
                    {available}/{category.items.length} available · {category.blurb}
                  </span>
                </div>
              </div>
              <div className="row" style={{ gap: '0.4rem' }}>
                <button className="btn btn-xs" disabled={busy === `cat-${category.id}`} onClick={() => toggleCategory(category, true)}>
                  All on
                </button>
                <button className="btn btn-xs btn-ghost" disabled={busy === `cat-${category.id}`} onClick={() => toggleCategory(category, false)}>
                  All off
                </button>
              </div>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Dish</th><th>Price</th><th>Prep</th><th>Stock</th><th>State</th><th />
                  </tr>
                </thead>
                <tbody>
                  {category.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <div className="row" style={{ gap: '0.5rem' }}>
                          <span aria-hidden>{dishEmoji(item)}</span>
                          <div>
                            <strong>{item.name}</strong>
                            {item.badge ? <div className="tiny muted">{item.badge}</div> : null}
                          </div>
                        </div>
                      </td>
                      <td className="mono">{money(item.base_price)}</td>
                      <td className="muted">{item.prep_minutes} min</td>
                      <td style={{ minWidth: 120 }}>
                        {item.track_stock ? (
                          <>
                            <div className="row-between tiny"><span>{item.stock} left</span></div>
                            <Meter value={item.stock} max={Math.max(10, item.stock)} tone={item.stock === 0 ? 'low' : item.stock < 6 ? 'mid' : undefined} />
                          </>
                        ) : (
                          <span className="muted tiny">not tracked</span>
                        )}
                      </td>
                      <td>
                        {item.soldOut ? <Pill tone="bad">{item.soldOutReason}</Pill> : <Pill tone="ok">available</Pill>}
                      </td>
                      <td>
                        <div className="row" style={{ gap: '0.3rem' }}>
                          <button
                            className={`btn btn-xs ${item.is_available ? 'btn-ghost' : 'btn-ok'}`}
                            disabled={busy === `item-${item.id}`}
                            onClick={() => toggleAvailability(item)}
                          >
                            {item.is_available ? 'Turn off' : 'Turn on'}
                          </button>
                          <button className="btn btn-xs btn-ghost" onClick={() => startEdit(item)}>Edit</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <section className="card">
          <h3>Promo codes</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Code</th><th>Deal</th><th>Used</th><th>Active</th><th /></tr></thead>
              <tbody>
                {promos.map((promo) => {
                  const meta = promo as Promo & { id: number; is_active: number; uses: number; max_uses: number; min_subtotal: number };
                  const deal =
                    promo.kind === 'percent' ? `${promo.value}% off`
                      : promo.kind === 'fixed' ? `${money(promo.value)} off`
                        : 'Free delivery';
                  return (
                    <tr key={promo.code}>
                      <td className="mono gold">{promo.code}</td>
                      <td>
                        {deal}
                        <div className="tiny muted">min {money(meta.min_subtotal ?? promo.min_subtotal ?? 0)}</div>
                      </td>
                      <td className="muted">{meta.uses ?? 0}{meta.max_uses ? `/${meta.max_uses}` : ''}</td>
                      <td>{meta.is_active ? <Pill tone="ok">live</Pill> : <Pill tone="bad">paused</Pill>}</td>
                      <td>
                        <button className="btn btn-xs btn-ghost" disabled={busy === `promo-${promo.code}`} onClick={() => togglePromo(meta)}>
                          {meta.is_active ? 'Pause' : 'Resume'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <h3>Create a promo</h3>
          <label className="field">
            <span>Code</span>
            <input
              className="input mono"
              placeholder="WINTER20"
              value={newPromo.code}
              onChange={(event) => setNewPromo({ ...newPromo, code: event.target.value.toUpperCase() })}
            />
          </label>
          <label className="field">
            <span>Type</span>
            <select className="input" value={newPromo.kind} onChange={(event) => setNewPromo({ ...newPromo, kind: event.target.value })}>
              <option value="percent">Percentage off</option>
              <option value="fixed">Fixed rand off</option>
              <option value="free_delivery">Free delivery</option>
            </select>
          </label>
          {newPromo.kind !== 'free_delivery' ? (
            <label className="field">
              <span>{newPromo.kind === 'percent' ? 'Percent (1–90)' : 'Cents off (e.g. 5000 = R50)'}</span>
              <input
                className="input"
                type="number"
                value={newPromo.value}
                onChange={(event) => setNewPromo({ ...newPromo, value: Number(event.target.value) })}
              />
            </label>
          ) : null}
          <label className="field">
            <span>Minimum spend (cents)</span>
            <input
              className="input"
              type="number"
              value={newPromo.minSubtotal}
              onChange={(event) => setNewPromo({ ...newPromo, minSubtotal: Number(event.target.value) })}
            />
          </label>
          <label className="field">
            <span>Description</span>
            <input
              className="input"
              placeholder="Winter warmer deal"
              value={newPromo.description}
              onChange={(event) => setNewPromo({ ...newPromo, description: event.target.value })}
            />
          </label>
          <button className="btn btn-primary" onClick={createPromo} disabled={busy === 'promo' || newPromo.code.length < 3}>
            {busy === 'promo' ? <Spinner /> : 'Create promo'}
          </button>
        </section>
      </div>

      {editing ? (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setEditing(null)}>
          <div className="modal">
            <header>
              <h3 style={{ margin: 0 }}>Edit {editing.name}</h3>
              <button className="icon-btn" onClick={() => setEditing(null)}>✕</button>
            </header>
            <div className="body stack">
              <label className="field">
                <span>Price (cents — R45.00 is 4500)</span>
                <input className="input" type="number" value={draft.base_price} onChange={(e) => setDraft({ ...draft, base_price: Number(e.target.value) })} />
                <span className="field-hint">Currently {money(editing.base_price)} → {money(draft.base_price)}</span>
              </label>
              <label className="field">
                <span>Prep minutes</span>
                <input className="input" type="number" value={draft.prep_minutes} onChange={(e) => setDraft({ ...draft, prep_minutes: Number(e.target.value) })} />
              </label>
              <label className="switch">
                <input type="checkbox" checked={draft.track_stock} onChange={(e) => setDraft({ ...draft, track_stock: e.target.checked })} />
                <span className="switch-track" />
                <span className="small">Count stock down as orders come in</span>
              </label>
              {draft.track_stock ? (
                <label className="field">
                  <span>Stock on hand</span>
                  <input className="input" type="number" value={draft.stock} onChange={(e) => setDraft({ ...draft, stock: Number(e.target.value) })} />
                </label>
              ) : null}
            </div>
            <footer>
              <button className="btn btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveEdit} disabled={busy === `edit-${editing.id}`}>
                {busy === `edit-${editing.id}` ? <Spinner /> : 'Save changes'}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}
