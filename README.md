# Khanyisile's Kitchen — Sweet Treats 🍗🧁

A full-stack online ordering platform for **Khanyisile's Kitchen**, a home-style kitchen in
Malamulele, Limpopo. Customers create an account, order for **collection or delivery by bike**,
and follow their food live — while the store admin runs the kitchen, the menu, the riders and
the money from a real operations console.

Built from the shop's printed menu and poster art: black + gold, wings, platters, popcorn,
sweet treats and a paper cone of chips.

---

## What it does

### For customers
- **Create an account** with a name, email, phone and password (scrypt-hashed, rate-limited login).
- **Browse the poster menu** — 7 sections, 27 dishes, all prices and options transcribed from the artwork.
- **Choose options** with real validation: required choices cannot be skipped, multi-picks are capped,
  sold-out dishes cannot be ordered, and the quantity is clamped to what is actually in stock.
- **Collection or delivery, decided by reality** — the delivery option is only offered when a rider is
  actually on shift, with a plain-language reason when it is not.
- **Live server-side pricing**: subtotal, distance-based delivery fee, free-delivery threshold,
  promo codes, loyalty-point redemption and ETA all come from one pricing engine on the server.
- **Track the order live** — a status timeline that updates over Server-Sent Events the moment the
  kitchen or the rider touches the order, with the rider's name and a tap-to-call button.
- **Loyalty points** earned on completion, redeemable at checkout, with an activity history.
- **Saved addresses**, order history and one-tap “order again”.
- Rate a finished order — the rating rolls into the rider's score.

### For riders (drivers)
- Go on/off shift (and cannot clock off mid-run).
- See the runs assigned to them, with the packing list, address and rider notes.
- One-tap progress: **collected → on the way → delivered**.
- Claim a ready order from the open pool — first come, first served, with capacity rules
  (bicycle 1 run, scooter 2, car 3).
- Earnings view: runs per day, fees collected, and the store's payout model (R10 per run + 50 % of the fee).

### For the store admin
- **Dashboard**: revenue today, live order counts, 14-day revenue chart, busiest hours, top sellers,
  low-stock radar, fleet view and a live event feed.
- **Kitchen screen**: a ticker board (New → Confirmed → Cooking → Ready) with one big button per ticket,
  “late” flags and automatic updates.
- **Dispatch board**: every rider with capacity and shift controls, unassigned deliveries with
  **auto-assign** (nearest free rider) or pick a rider by hand, and reassignment that frees the old rider.
- **Menu console**: switch dishes or whole categories off the menu, edit prices and prep times,
  count stock down automatically, and create/pause promo codes.
- **Orders**: filter and search every order, open the full ticket, move it forward or cancel it
  (cancelling puts reserved stock back).
- **Settings**: open/close the kitchen, pause orders, toggle auto-dispatch, delivery fees and radius,
  minimum order, prep capacity, loyalty rates, and a one-click **reconcile** that re-derives every
  order total from its line items.
- **Audit trail**: every state change, price change and settings tweak is journalled with the actor.

---

## Try it in 60 seconds

```bash
npm run install:all      # installs server + web dependencies
npm run seed             # 7 categories · 27 dishes · 14 accounts · 2 weeks of trading history
npm run build            # builds the React app
npm start                # http://localhost:4000  (API + app on one port)
```

Then open <http://localhost:4000> — the app, API and live feed all run from that single port.

### Demo accounts (password for all: `demo1234`)

| Role | Email | What to look at |
| --- | --- | --- |
| Customer | `customer@demo.kk` | Menu, basket, checkout, live tracking, loyalty |
| Rider | `driver@demo.kk` | Rider app: shift toggle, runs, claims, earnings |
| Rider (bicycle) | `thabo.rider@demo.kk` | The 1-run bicycle capacity limit |
| Store admin | `admin@demo.kk` | Kitchen, dispatch, menu, orders, settings, audit |

The sign-in page has one-tap buttons that fill these in. The seeded database also contains 9 other
customers and two weeks of completed orders so the charts and reports are not empty.

### Resetting the demo

```bash
# stop the server first, then:
npm run seed -- --force   # wipes and rebuilds the demo data (deterministic)
npm start
```

---

## Architecture

```
khanyi/
├── server/                    Node 20+ · Express · better-sqlite3 (no ORM, no build step)
│   ├── src/
│   │   ├── db/                migrations, seed data, deterministic seed script
│   │   ├── lib/               crypto (scrypt + HMAC tokens), validator, geo, rate limiter, errors
│   │   ├── middleware/        auth, optional auth (for SSE), error handling
│   │   ├── services/          menu · pricing · orders (state machine) · dispatch · events · settings
│   │   ├── routes/            auth · store · menu · orders · rider · admin · events
│   │   ├── app.js             app factory (migrations + seed on boot, route mounting, SPA serving)
│   │   └── index.js           server entry
│   └── test/                  71 tests: pricing, order lifecycle, permissions, dispatch, HTTP + SSE
└── web/                       React 18 · TypeScript · Vite · react-router
    └── src/
        ├── lib/               api client, session, cart + live quote, SSE hook, formatting
        ├── components/        UI kit (pills, modals, drawers, charts, toasts) + basket drawer
        └── pages/             storefront, checkout, tracking, orders, account, auth, rider, admin/*
```

### Design decisions worth knowing

- **Money is integer cents, everywhere.** No floating-point rounding errors on a customer's total.
- **One pricing engine.** `services/pricing.js` is the only place a price, fee, discount or ETA is
  calculated, and the database has a trigger that refuses negative money columns.
- **An explicit order state machine.** `pending → confirmed → preparing → ready → assigned →
  picked_up → on_the_way → delivered → completed`, with per-role permissions. Anything not listed is
  refused with a readable message — that is what stops a raced “cancel” from resurrecting a delivered order.
- **Server-Sent Events, not WebSockets.** Order updates only travel server → client; SSE survives every
  proxy, reconnects natively, and needs no extra dependencies. Events carry sequence ids and the server
  keeps a ring buffer, so a rider who drove through a dead spot still receives what they missed.
- **Idempotent checkout.** A double-tapped “Place order” on a flaky connection returns the original
  order instead of charging twice (client key + basket fingerprint inside a 3-minute window).
- **SQLite with WAL.** A single-file database that needs no service to run — perfect for a kitchen
  tablet — while still supporting real transactions for stock, loyalty and dispatch.
- **Security**: scrypt password hashing, HMAC-signed tokens, constant-time comparisons, per-IP and
  per-account rate limits, role-gated routes, SSE topics that can only be narrowed (never widened) by
  the caller, and an audit log of everything the team changes.

---

## API sketch

| Method | Route | Who | What |
| --- | --- | --- | --- |
| `POST` | `/api/auth/register` · `/api/auth/login` | anyone | create account / sign in |
| `GET` | `/api/store` | anyone | brand, hours, delivery rules, rider availability, promos, full menu |
| `GET` | `/api/store/status` | anyone | open/paused/busy + live rider availability |
| `POST` | `/api/orders/quote` | anyone | price a basket (fees, promos, points, ETA, problems) |
| `POST` | `/api/orders` | customer | place an order (idempotency key supported) |
| `GET` | `/api/orders/:idOrCode` | owner / rider / admin | one order with items, events and timeline |
| `POST` | `/api/orders/:id/cancel` · `/api/orders/:id/rate` | customer | cancel / rate |
| `POST` | `/api/orders/:id/transition` | admin, rider | move the state machine |
| `GET` | `/api/rider/board` | rider | my runs, the open pool, today's takings |
| `POST` | `/api/rider/orders/:id/progress` · `/claim` · `/release` | rider | ride the order |
| `GET` | `/api/admin/overview` | admin | dashboard, kitchen queue, fleet, low stock |
| `POST` | `/api/admin/orders/:id/bump` · `/assign` | admin | kitchen shortcut / dispatch |
| `PATCH` | `/api/admin/menu/items/:id` | admin | price, prep time, availability, stock |
| `POST` | `/api/admin/settings/toggle` | admin | close the shop, pause orders, auto-dispatch |
| `GET` | `/api/events` | anyone signed in | live SSE feed (role-scoped topics) |

---

## Tests

```bash
npm test          # 71 tests, no network needed (each suite uses its own temp SQLite file)
```

Coverage highlights: option validation, promo/loyalty maths, delivery radius and free-delivery
thresholds, the full order lifecycle, illegal transitions, role permissions, idempotent replay,
stock reservation and restore, auto-dispatch selection, rider capacity, the rider board, SSE delivery
and replay, and topic isolation between roles.

---

*Made with passion, served with love. 💛*
