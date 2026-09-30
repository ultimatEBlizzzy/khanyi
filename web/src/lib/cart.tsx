import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import api from './api';
import { useSession } from './session';
import type { MenuItem, Quote } from './types';

export interface CartLine {
  itemId: number;
  slug: string;
  name: string;
  emoji: string;
  qty: number;
  optionIds: number[];
  options: { group: string; name: string; priceDelta: number }[];
  /** Display-only price; the server always re-prices on quote and checkout. */
  previewUnitPrice: number;
  notes?: string;
}

export interface AddressInput {
  label?: string;
  line1: string;
  suburb?: string;
  notes?: string;
  lat?: number | null;
  lng?: number | null;
}

interface CartValue {
  lines: CartLine[];
  count: number;
  quote: Quote | null;
  quoting: boolean;
  fulfilment: 'collection' | 'delivery';
  setFulfilment: (mode: 'collection' | 'delivery') => void;
  promoCode: string;
  setPromoCode: (code: string) => void;
  redeemPoints: number;
  setRedeemPoints: (points: number) => void;
  address: AddressInput | null;
  setAddress: (address: AddressInput | null) => void;
  add: (item: MenuItem, optionIds: number[], qty?: number) => void;
  setQty: (index: number, qty: number) => void;
  remove: (index: number) => void;
  clear: () => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}

const CartContext = createContext<CartValue | null>(null);
const STORAGE_KEY = 'kk.cart.v1';

interface Persisted {
  lines: CartLine[];
  fulfilment: 'collection' | 'delivery';
  address: AddressInput | null;
}

function load(): Persisted {
  if (typeof localStorage === 'undefined') return { lines: [], fulfilment: 'collection', address: null };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { lines: [], fulfilment: 'collection', address: null };
    const parsed = JSON.parse(raw) as Persisted;
    return {
      lines: Array.isArray(parsed.lines) ? parsed.lines : [],
      fulfilment: parsed.fulfilment === 'delivery' ? 'delivery' : 'collection',
      address: parsed.address ?? null,
    };
  } catch {
    return { lines: [], fulfilment: 'collection', address: null };
  }
}

/**
 * Cart state + the server quote that keeps it honest.
 *
 * The basket lives in localStorage so a dropped connection never loses an
 * order, and every change re-prices through `/api/orders/quote` — the client
 * never invents a delivery fee or a discount.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const { user, addresses } = useSession();
  const initial = useMemo(load, []);
  const [lines, setLines] = useState<CartLine[]>(initial.lines);
  const [fulfilment, setFulfilmentState] = useState<'collection' | 'delivery'>(initial.fulfilment);
  const [address, setAddress] = useState<AddressInput | null>(initial.address);
  const [promoCode, setPromoCode] = useState('');
  const [redeemPoints, setRedeemPoints] = useState(0);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Adopt the customer's default saved address the first time we have one.
  useEffect(() => {
    if (address || addresses.length === 0) return;
    const preferred = addresses.find((a) => a.is_default) ?? addresses[0];
    setAddress({
      label: preferred.label,
      line1: preferred.line1,
      suburb: preferred.suburb,
      notes: preferred.notes,
      lat: preferred.lat,
      lng: preferred.lng,
    });
  }, [addresses, address]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ lines, fulfilment, address }));
  }, [lines, fulfilment, address]);

  const count = lines.reduce((sum, line) => sum + line.qty, 0);

  /* ------------------------------ quoting ------------------------------ */
  useEffect(() => {
    if (lines.length === 0) {
      setQuote(null);
      return;
    }
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setQuoting(true);
      try {
        const next = await api.post<Quote>(
          '/api/orders/quote',
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
          },
          { signal: controller.signal },
        );
        setQuote(next);
      } catch (error) {
        if ((error as Error).name !== 'AbortError') setQuote(null);
      } finally {
        setQuoting(false);
      }
    }, 260);

    return () => clearTimeout(timer);
  }, [lines, fulfilment, address, promoCode, redeemPoints, user?.loyaltyPoints]);

  const add = useCallback((item: MenuItem, optionIds: number[], qty = 1) => {
    const options = item.optionGroups
      .flatMap((group) => group.options.map((option) => ({ group: group.name, option })))
      .filter((entry) => optionIds.includes(entry.option.id))
      .map((entry) => ({
        group: entry.group,
        name: entry.option.name,
        priceDelta: entry.option.price_delta,
      }));
    const previewUnitPrice = item.base_price + options.reduce((sum, o) => sum + o.priceDelta, 0);

    setLines((current) => {
      const key = `${item.id}:${[...optionIds].sort((a, b) => a - b).join(',')}`;
      const index = current.findIndex(
        (line) => `${line.itemId}:${[...line.optionIds].sort((a, b) => a - b).join(',')}` === key,
      );
      if (index >= 0) {
        const next = [...current];
        next[index] = { ...next[index], qty: Math.min(50, next[index].qty + qty) };
        return next;
      }
      return [
        ...current,
        {
          itemId: item.id,
          slug: item.slug,
          name: item.name,
          emoji: item.image || '',
          qty,
          optionIds: [...optionIds].sort((a, b) => a - b),
          options,
          previewUnitPrice,
        },
      ];
    });
  }, []);

  const setQty = useCallback((index: number, qty: number) => {
    setLines((current) => {
      if (qty <= 0) return current.filter((_, i) => i !== index);
      const next = [...current];
      next[index] = { ...next[index], qty: Math.min(50, qty) };
      return next;
    });
  }, []);

  const remove = useCallback((index: number) => {
    setLines((current) => current.filter((_, i) => i !== index));
  }, []);

  const clear = useCallback(() => {
    setLines([]);
    setPromoCode('');
    setRedeemPoints(0);
    setQuote(null);
  }, []);

  const setFulfilment = useCallback((mode: 'collection' | 'delivery') => {
    setFulfilmentState(mode);
  }, []);

  const value = useMemo<CartValue>(
    () => ({
      lines, count, quote, quoting, fulfilment, setFulfilment, promoCode, setPromoCode,
      redeemPoints, setRedeemPoints, address, setAddress, add, setQty, remove, clear, open, setOpen,
    }),
    [
      lines, count, quote, quoting, fulfilment, setFulfilment, promoCode, redeemPoints,
      address, add, setQty, remove, clear, open,
    ],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const context = useContext(CartContext);
  if (!context) throw new Error('useCart must be used inside <CartProvider>');
  return context;
}
