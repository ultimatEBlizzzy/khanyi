/** Display helpers. Money is always cents in the API; rand in the UI. */

export const money = (cents: number | null | undefined): string => {
  const value = (cents ?? 0) / 100;
  return `R${value.toLocaleString('en-ZA', {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
};

export const moneyExact = (cents: number | null | undefined): string =>
  `R${((cents ?? 0) / 100).toFixed(2)}`;

/** SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC. */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalised = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalised);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const clockTime = (value: string | null | undefined): string => {
  const date = parseDate(value);
  if (!date) return '—';
  return date.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
};

export const shortDate = (value: string | null | undefined): string => {
  const date = parseDate(value);
  if (!date) return '—';
  return date.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
};

export const dateTime = (value: string | null | undefined): string => {
  const date = parseDate(value);
  if (!date) return '—';
  return `${shortDate(value)} · ${clockTime(value)}`;
};

export function timeAgo(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '—';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 90) return 'a minute ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export const etaClock = (minutes: number): string => {
  const at = new Date(Date.now() + minutes * 60_000);
  return at.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
};

export const initials = (name: string): string =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

export const dayLabel = (day: string): string => {
  const date = new Date(`${day}T12:00:00Z`);
  return date.toLocaleDateString('en-ZA', { weekday: 'narrow' });
};

export const vehicleIcon = (vehicle: string): string =>
  vehicle === 'bike' ? '🚲' : vehicle === 'car' ? '🚗' : '🛵';

export const statusTone = (status: string): 'gold' | 'ok' | 'warn' | 'bad' | 'info' => {
  switch (status) {
    case 'completed':
    case 'delivered':
      return 'ok';
    case 'ready':
      return 'gold';
    case 'cancelled':
    case 'rejected':
      return 'bad';
    case 'on_the_way':
    case 'picked_up':
    case 'assigned':
      return 'info';
    default:
      return 'warn';
  }
};

export const categoryIcon = (slug: string, fallback: string): string => {
  const icons: Record<string, string> = {
    wings: '🍗',
    sandwiches: '🥪',
    platters: '🍽️',
    desserts: '🍨',
    'sweet-treats': '🧁',
    popcorn: '🍿',
    drinks: '🥤',
  };
  return icons[slug] ?? fallback;
};

/** Deterministic emoji for a dish with no photo yet. */
export function dishEmoji(item: { slug: string; name: string; description?: string }): string {
  const bySlug: [RegExp, string][] = [
    [/wing/, '🍗'],
    [/sandwich|toast/, '🥪'],
    [/chips|fries/, '🍟'],
    [/platter|feast/, '🍽️'],
    [/cake|cupcake/, '🧁'],
    [/brownie/, '🍫'],
    [/koeksister/, '🍩'],
    [/biscuit|crunchie|cookie/, '🍪'],
    [/popcorn/, '🍿'],
    [/dessert|sundae|delight/, '🍨'],
    [/drink|mocktail|cooler|blast|water|cola/, '🥤'],
    [/russian/, '🌭'],
  ];
  for (const [pattern, emoji] of bySlug) if (pattern.test(item.slug)) return emoji;
  return '✨';
}
