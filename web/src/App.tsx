
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import { useSession } from './lib/session';
import { useCart } from './lib/cart';
import { useLiveFeed } from './lib/live';
import { useToast, Spinner, StatusPill } from './components/ui';
import BasketDrawer from './components/BasketDrawer';
import { useStoreStatus } from './lib/store';
import type { LiveEvent } from './lib/types';

import Storefront from './pages/Storefront';
import Checkout from './pages/Checkout';
import Track from './pages/Track';
import Orders from './pages/Orders';
import Account from './pages/Account';
import Auth from './pages/Auth';
import Rider from './pages/Rider';
import Admin from './pages/Admin';
import NotFound from './pages/NotFound';

/* --------------------------------- layout -------------------------------- */

function Header() {
  const { user, logout } = useSession();
  const { count, setOpen } = useCart();
  const navigate = useNavigate();
  const { status } = useStoreStatus(30_000);
  const delivery = status?.delivery;

  return (
    <header className="site-header">
      <div className="container bar">
        <Link to="/" className="brand" style={{ textDecoration: 'none' }}>
          <span className="brand-mark" aria-hidden>👨‍🍳</span>
          <span className="brand-text">
            <span className="brand-name">Khanyisile&rsquo;s Kitchen</span>
            <span className="brand-sub">Sweet Treats · Malamulele</span>
          </span>
        </Link>

        <nav className="main-nav" aria-label="Main">
          <NavLink to="/" end>Menu</NavLink>
          <NavLink to="/orders">My orders</NavLink>
          {user?.role === 'customer' || !user ? <NavLink to="/account">Account</NavLink> : null}
          {user?.role === 'admin' ? <NavLink to="/admin">Store console</NavLink> : null}
          {user?.role === 'driver' ? <NavLink to="/rider">Rider app</NavLink> : null}
          {user ? (
            <>
              <span className="pill" title={user.email}>{user.name.split(' ')[0]}</span>
              <button
                className="navlink"
                onClick={() => {
                  logout();
                  navigate('/');
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <NavLink to="/login">Sign in</NavLink>
          )}
          <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
            🛒 Basket {count > 0 ? <span className="pill pill-gold" style={{ padding: '0 0.4rem' }}>{count}</span> : null}
          </button>
        </nav>
      </div>

      <div className="status-ribbon">
        <div className="container inner">
          <span className="row" style={{ gap: '0.4rem' }}>
            <span className={`dot ${status?.open && status?.acceptingOrders ? 'dot-live' : 'dot-bad'}`} />
            {status
              ? status.acceptingOrders
                ? status.busy ? 'Kitchen is busy but taking orders' : 'Open and taking orders'
                : 'Orders paused — back shortly'
              : 'Checking the kitchen…'}
          </span>
          <span className="hidden-sm">🕕 {status?.hours ?? '06:00 – 22:00'}</span>
          <span className="row" style={{ gap: '0.4rem' }}>
            {delivery?.available ? '🛵' : '🏪'}
            {delivery?.available
              ? `Delivery available · ${delivery.ridersFree} rider${delivery.ridersFree === 1 ? '' : 's'} free`
              : 'Collection only right now'}
          </span>
          <span className="hidden-sm">📍 Malamulele</span>
          <span className="hidden-sm">☎ 082 837 3077</span>
        </div>
      </div>
    </header>
  );
}

function MobileTabs() {
  const { user } = useSession();
  return (
    <nav className="tabbar" aria-label="Quick navigation">
      <div className="inner">
        <NavLink to="/" end><span className="ico">🍽️</span>Menu</NavLink>
        <NavLink to="/orders"><span className="ico">🧾</span>Orders</NavLink>
        {user?.role === 'driver' ? <NavLink to="/rider"><span className="ico">🛵</span>Rides</NavLink> : null}
        {user?.role === 'admin' ? <NavLink to="/admin"><span className="ico">📊</span>Console</NavLink> : null}
        <NavLink to="/account"><span className="ico">👤</span>Account</NavLink>
      </div>
    </nav>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="container cols">
        <div>
          <div className="brand-name" style={{ fontSize: '1.7rem' }}>Khanyisile&rsquo;s Kitchen</div>
          <p className="small">
            Baked with passion, made with love. Wings, platters, popcorn and sweet treats —
            collection in Malamulele or delivered by bike.
          </p>
        </div>
        <div>
          <h4 className="eyebrow">Find us</h4>
          <p className="small">
            Malamulele, Limpopo<br />
            082 837 3077 · 073 811 2207<br />
            Open 06:00 – 22:00 daily
          </p>
        </div>
        <div>
          <h4 className="eyebrow">Order</h4>
          <p className="small">
            Delivery within 12 km, free over R200.<br />
            Collection ready in about 25 minutes.<br />
            Loyalty points on every order.
          </p>
        </div>
      </div>
      <div className="container" style={{ marginTop: '1rem' }}>
        <span className="tiny muted">
          © {new Date().getFullYear()} Khanyisile&rsquo;s Kitchen · Thank you for supporting a small business 💛
        </span>
      </div>
    </footer>
  );
}

function RequireRole({ role, children }: { role: string[]; children: JSX.Element }) {
  const { user, ready } = useSession();
  const location = useLocation();

  if (!ready) {
    return (
      <div className="container section">
        <Spinner label="Checking your account…" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (!role.includes(user.role)) {
    return (
      <div className="container section">
        <div className="card center">
          <h2>That area is for {role.join(' / ')} accounts</h2>
          <p className="muted">You are signed in as {user.name} ({user.role}).</p>
          <Link className="btn btn-primary" to="/">Back to the menu</Link>
        </div>
      </div>
    );
  }
  return children;
}

/* --------------------------- global live notifier ------------------------ */

function LiveNotifier() {
  const { user } = useSession();
  const { push } = useToast();

  useLiveFeed(['orders'], (event: LiveEvent<any>) => {
    if (event.type === 'order.updated' && event.payload?.status === 'ready' && user?.role === 'customer') {
      push({
        tone: 'ok',
        title: `Order ${event.payload.code} is ready`,
        body: event.payload.fulfilment === 'collection'
          ? 'Your food is packed and waiting at the counter.'
          : 'A rider is collecting it now.',
      });
    }
    if (event.type === 'order.assigned' && user?.role === 'driver') {
      push({ tone: 'info', title: `New run: ${event.payload.code}`, body: event.payload.addressLine });
    }
    if (event.type === 'dispatch.no_rider' && user?.role === 'admin') {
      push({ tone: 'bad', title: 'A delivery is ready but no rider is free', body: event.payload?.code });
    }
  }, { enabled: Boolean(user) });

  return null;
}

/* ---------------------------------- app ---------------------------------- */

export default function App() {
  return (
    <div className="app-shell">
      <Header />
      <LiveNotifier />
      <main>
        <Routes>
          <Route path="/" element={<Storefront />} />
          <Route path="/login" element={<Auth mode="login" />} />
          <Route path="/register" element={<Auth mode="register" />} />
          <Route
            path="/checkout"
            element={<RequireRole role={['customer', 'admin']}><Checkout /></RequireRole>}
          />
          <Route
            path="/orders"
            element={<RequireRole role={['customer', 'admin', 'driver']}><Orders /></RequireRole>}
          />
          <Route
            path="/orders/:code"
            element={<RequireRole role={['customer', 'admin', 'driver']}><Track /></RequireRole>}
          />
          <Route
            path="/account"
            element={<RequireRole role={['customer', 'admin', 'driver']}><Account /></RequireRole>}
          />
          <Route path="/rider" element={<RequireRole role={['driver', 'admin']}><Rider /></RequireRole>} />
          <Route path="/admin/*" element={<RequireRole role={['admin']}><Admin /></RequireRole>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
      <MobileTabs />
      {/* The basket drawer lives at the shell level so any page can open it. */}
      <BasketDrawer />
    </div>
  );
}

export { StatusPill };
