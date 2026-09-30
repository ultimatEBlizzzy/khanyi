export type Role = 'customer' | 'driver' | 'admin';

export interface User {
  id: number;
  name: string;
  email: string;
  phone: string;
  role: Role;
  loyaltyPoints: number;
  createdAt: string;
}

export interface Address {
  id: number;
  label: string;
  line1: string;
  suburb: string;
  city: string;
  notes: string;
  lat: number | null;
  lng: number | null;
  is_default: number;
}

export interface Option {
  id: number;
  group_id: number;
  name: string;
  price_delta: number;
  is_available: boolean;
}

export interface OptionGroup {
  id: number;
  item_id: number;
  name: string;
  kind: 'single' | 'multi';
  required: boolean;
  max_pick: number;
  options: Option[];
}

export interface MenuItem {
  id: number;
  category_id: number;
  slug: string;
  name: string;
  description: string;
  base_price: number;
  image: string;
  badge: string;
  track_stock: boolean;
  stock: number;
  is_available: boolean;
  prep_minutes: number;
  soldOut: boolean;
  soldOutReason: string;
  availableStock: number | null;
  optionGroups: OptionGroup[];
}

export interface Category {
  id: number;
  slug: string;
  name: string;
  blurb: string;
  icon: string;
  items: MenuItem[];
}

export interface Promo {
  code: string;
  kind: 'percent' | 'fixed' | 'free_delivery';
  value: number;
  min_subtotal: number;
  description: string;
  expires_at: string | null;
}

export interface DeliveryAvailability {
  available: boolean;
  ridersOnShift: number;
  ridersFree: number;
  ridersBusy: number;
  ridersOffline: number;
  activeDeliveries: number;
  bikeFriendly: boolean;
  reason: string;
  message: string;
  checkedAt: string;
}

export interface StoreBootstrap {
  store: {
    name: string;
    tagline: string;
    phone: string;
    altPhone: string;
    suburb: string;
    currency: string;
    open: boolean;
    acceptingOrders: boolean;
    hours: string;
    announcement: string;
  };
  delivery: DeliveryAvailability & {
    baseFee: number;
    perKmFee: number;
    freeOver: number;
    radiusKm: number;
    minOrder: number;
    storeLocation: { lat: number; lng: number };
  };
  minimumOrder: number;
  loyalty: { pointsPerRand: number; pointValue: number; minToRedeem: number };
  promos: Promo[];
  menu: Category[];
  lastUpdated: string;
}

export interface StoreStatus {
  open: boolean;
  acceptingOrders: boolean;
  busy: boolean;
  queueDepth: number;
  load: number;
  loadState: 'calm' | 'steady' | 'heavy';
  delivery: DeliveryAvailability;
  hours: string;
  serverTime: string;
}

export interface QuoteLine {
  itemId: number;
  slug?: string;
  name: string;
  qty: number;
  optionIds: number[];
  options: { group: string; name: string; priceDelta: number; optionId: number }[];
  unitPrice: number;
  lineTotal: number;
  blocked: boolean;
  issue: string | null;
}

export interface QuoteIssue {
  type: 'error' | 'warning';
  code: string;
  message: string;
  itemId?: number;
}

export interface Quote {
  lines: QuoteLine[];
  issues: QuoteIssue[];
  fulfilment: 'collection' | 'delivery';
  subtotal: number;
  deliveryFee: number;
  promo: { code: string; kind: string; value: number; description: string } | null;
  promoDiscount: number;
  promoMessage: string;
  pointsUsed: number;
  pointsDiscount: number;
  discount: number;
  total: number;
  distanceKm: number;
  etaMinutes: number;
  pointsEarned: number;
  blocked: boolean;
  addressIssue: string | null;
  canCheckout: boolean;
}

export interface OrderEvent {
  id: number;
  from_state: string | null;
  to_state: string;
  actor_name: string;
  actor_role: string;
  note: string;
  created_at: string;
}

export interface OrderItem {
  id: number;
  item_id: number;
  name: string;
  unit_price: number;
  qty: number;
  line_total: number;
  options: { group: string; name: string; priceDelta: number }[];
  notes: string;
}

export interface Order {
  id: number;
  code: string;
  user_id: number;
  fulfilment: 'collection' | 'delivery';
  status: string;
  statusLabel: string;
  subtotal: number;
  delivery_fee: number;
  discount: number;
  total: number;
  payment_method: string;
  promo_code: string;
  points_earned: number;
  points_redeemed: number;
  customer_name: string;
  customer_phone: string;
  address_line: string;
  address_suburb: string;
  address_notes: string;
  distance_km: number;
  eta_minutes: number;
  driver_id: number | null;
  cancel_reason: string;
  created_at: string;
  updated_at: string;
  ready_at: string | null;
  completed_at: string | null;
  has_rating: number;
  items: OrderItem[];
  events: OrderEvent[];
  timeline: { steps: string[]; currentIndex: number; cancelled: boolean };
  driver: { id: number; name: string; phone: string; vehicle: string; plate: string } | null;
}

export interface Rider {
  id: number;
  userId: number;
  name: string;
  email: string;
  phone: string;
  vehicle: 'bike' | 'scooter' | 'car';
  plate: string;
  status: 'offline' | 'online' | 'busy';
  zone: string;
  rating: number;
  deliveries: number;
  activeOrders: number;
  deliveredToday: number;
  isActive: boolean;
  capacity: number;
  busy: boolean;
  canTakeOrders: boolean;
}

export interface AdminStats {
  today: { orders: number; revenue: number; avgTicket: number; cancelled: number };
  live: { pending: number; inKitchen: number; ready: number; onTheRoad: number; active: number };
  allTime: { orders: number; revenue: number };
  byFulfilment: { fulfilment: string; n: number; revenue: number }[];
  topItems: { name: string; qty: number; revenue: number }[];
  last14: { day: string; orders: number; revenue: number }[];
  hourly: { hour: string; orders: number }[];
  ratings: { count: number; average: number };
  team: { customers: number; riders: number; ridersOnline: number };
  generatedAt: string;
}

export interface KitchenTicket {
  id: number;
  code: string;
  status: string;
  statusLabel: string;
  fulfilment: 'collection' | 'delivery';
  total: number;
  customer_name: string;
  customer_phone: string;
  address_line: string;
  address_suburb: string;
  eta_minutes: number;
  created_at: string;
  waitMinutes: number;
  late: boolean;
  items: OrderItem[];
}

export interface LiveEvent<T = Record<string, unknown>> {
  seq: number;
  id: string;
  type: string;
  topics: string[];
  payload: T;
  at: string;
}
