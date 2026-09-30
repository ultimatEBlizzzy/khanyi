import { db, all, get, tx } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { hub } from './events.js';

/**
 * The menu read-model. One query per table (categories, items, groups,
 * options) then stitched in memory — far cheaper than N+1 queries from the
 * client, and the whole thing is small enough to cache per request.
 */
export function listCategories() {
  return all('SELECT * FROM categories ORDER BY sort, id');
}

export function listItems({ categoryId, includeUnavailable = true } = {}) {
  const rows = categoryId
    ? all('SELECT * FROM menu_items WHERE category_id = ? ORDER BY sort, id', [categoryId])
    : all('SELECT * FROM menu_items ORDER BY category_id, sort, id');
  return includeUnavailable ? rows : rows.filter(isSellable);
}

export function listOptionGroups(itemIds = null) {
  const groups = itemIds
    ? all(
        `SELECT * FROM option_groups WHERE item_id IN (${itemIds.map(() => '?').join(',')})
         ORDER BY sort, id`,
        itemIds,
      )
    : all('SELECT * FROM option_groups ORDER BY sort, id');
  if (groups.length === 0) return [];

  const options = all(
    `SELECT * FROM options WHERE group_id IN (${groups.map(() => '?').join(',')})
     ORDER BY sort, id`,
    groups.map((g) => g.id),
  );
  const byGroup = new Map();
  for (const option of options) {
    if (!byGroup.has(option.group_id)) byGroup.set(option.group_id, []);
    byGroup.get(option.group_id).push(option);
  }
  return groups.map((group) => ({ ...group, options: byGroup.get(group.id) ?? [] }));
}

/**
 * Public menu: categories → items → option groups → options.
 * `soldOut` is computed, so the storefront never has to guess.
 */
export function fullMenu({ includeUnavailable = true } = {}) {
  const categories = listCategories();
  const items = listItems({ includeUnavailable });
  const groups = listOptionGroups(items.map((i) => i.id));

  const groupsByItem = new Map();
  for (const group of groups) {
    if (!groupsByItem.has(group.item_id)) groupsByItem.set(group.item_id, []);
    groupsByItem.get(group.item_id).push(group);
  }

  return categories
    .map((category) => {
      const categoryItems = items
        .filter((item) => item.category_id === category.id)
        .map((item) => decorate(item, groupsByItem.get(item.id) ?? []));
      return { ...category, items: categoryItems };
    })
    .filter((category) => includeUnavailable || category.items.length > 0);
}

function decorate(item, groups) {
  const sellable = isSellable(item);
  return {
    ...item,
    is_available: Boolean(item.is_available),
    track_stock: Boolean(item.track_stock),
    soldOut: !sellable,
    soldOutReason: sellable ? '' : unavailableReason(item),
    availableStock: item.track_stock ? Math.max(0, item.stock) : null,
    optionGroups: groups.map((group) => ({
      ...group,
      required: Boolean(group.required),
      options: group.options.map((option) => ({
        ...option,
        is_available: Boolean(option.is_available),
      })),
    })),
  };
}

export function getItem(idOrSlug) {
  const item = /^\d+$/.test(String(idOrSlug))
    ? get('SELECT * FROM menu_items WHERE id = ?', [idOrSlug])
    : get('SELECT * FROM menu_items WHERE slug = ?', [idOrSlug]);
  if (!item) throw ApiError.notFound('That dish is not on the menu');
  return item;
}

export function getItemDetail(idOrSlug) {
  const item = getItem(idOrSlug);
  return decorate(item, listOptionGroups([item.id]));
}

export function isSellable(item) {
  if (!item.is_available) return false;
  if (item.track_stock && item.stock <= 0) return false;
  return true;
}

export function unavailableReason(item) {
  if (!item.is_available) return 'Not available right now';
  if (item.track_stock && item.stock <= 0) return 'Sold out for today';
  return '';
}

/* ------------------------------- writes -------------------------------- */

export function setItemAvailability(id, isAvailable, actor) {
  const item = getItem(id);
  db.prepare(
    `UPDATE menu_items SET is_available = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(isAvailable ? 1 : 0, item.id);
  recordAudit(actor, isAvailable ? 'menu.available' : 'menu.unavailable', item);

  hub.publish(['store', 'staff'], 'menu.updated', {
    itemId: item.id,
    name: item.name,
    isAvailable: Boolean(isAvailable),
  });
  return getItemDetail(item.id);
}

export function setItemStock(id, { stock, trackStock }, actor) {
  const item = getItem(id);
  const nextTrack = trackStock === undefined ? item.track_stock : trackStock ? 1 : 0;
  const nextStock = stock === undefined ? item.stock : Math.max(0, Math.trunc(stock));

  db.prepare(
    `UPDATE menu_items SET stock = ?, track_stock = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(nextStock, nextTrack, item.id);

  const updated = getItemDetail(item.id);
  recordAudit(actor, 'menu.stock', item, { stock: nextStock, trackStock: Boolean(nextTrack) });
  hub.publish(['store', 'staff'], 'menu.updated', {
    itemId: item.id,
    name: item.name,
    stock: nextStock,
    trackStock: Boolean(nextTrack),
    soldOut: updated.soldOut,
  });
  return updated;
}

/** Bulk switch used by the "close the kitchen on a dish" admin shortcut. */
export function setCategoryAvailability(categoryId, isAvailable, actor) {
  const items = all('SELECT id, name FROM menu_items WHERE category_id = ?', [categoryId]);
  const apply = tx(() => {
    const stmt = db.prepare(
      `UPDATE menu_items SET is_available = ?, updated_at = datetime('now') WHERE id = ?`,
    );
    for (const item of items) stmt.run(isAvailable ? 1 : 0, item.id);
  });
  apply();

  recordAudit(actor, 'menu.category.availability', { id: categoryId }, {
    isAvailable: Boolean(isAvailable),
    items: items.length,
  });
  hub.publish(['store', 'staff'], 'menu.updated', {
    categoryId,
    isAvailable: Boolean(isAvailable),
    affected: items.length,
  });
  return fullMenu();
}

export function updateItem(id, patch, actor) {
  const item = getItem(id);
  const fields = [];
  const params = [];

  if (patch.name !== undefined) { fields.push('name = ?'); params.push(String(patch.name).slice(0, 80)); }
  if (patch.description !== undefined) { fields.push('description = ?'); params.push(String(patch.description).slice(0, 400)); }
  if (patch.base_price !== undefined) { fields.push('base_price = ?'); params.push(Math.max(0, Math.trunc(patch.base_price))); }
  if (patch.prep_minutes !== undefined) { fields.push('prep_minutes = ?'); params.push(Math.min(180, Math.max(1, Math.trunc(patch.prep_minutes)))); }
  if (patch.badge !== undefined) { fields.push('badge = ?'); params.push(String(patch.badge).slice(0, 24)); }

  if (fields.length === 0) return getItemDetail(item.id);

  fields.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE menu_items SET ${fields.join(', ')} WHERE id = ?`).run(...params, item.id);
  recordAudit(actor, 'menu.update', item, patch);

  const updated = getItemDetail(item.id);
  hub.publish(['store', 'staff'], 'menu.updated', { itemId: item.id, name: updated.name });
  return updated;
}

function recordAudit(actor, action, item, meta = {}) {
  db.prepare(
    `INSERT INTO audit_log (actor_id, actor_name, action, entity, entity_id, meta)
     VALUES (?, ?, ?, 'menu_item', ?, ?)`,
  ).run(actor?.id ?? null, actor?.name ?? 'system', action, String(item.id), JSON.stringify(meta));
}

/** Low-stock radar for the admin dashboard. */
export function stockRadar(threshold = 5) {
  return all(
    `SELECT id, name, stock, track_stock, is_available
     FROM menu_items
     WHERE track_stock = 1 AND stock <= ?
     ORDER BY stock ASC, name ASC`,
    [threshold],
  );
}

export default {
  fullMenu, listItems, getItem, getItemDetail, isSellable, unavailableReason,
  setItemAvailability, setItemStock, setCategoryAvailability, updateItem, stockRadar,
};
