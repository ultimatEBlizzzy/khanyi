import { NavLink, Route, Routes } from 'react-router-dom';
import { useLiveFeed } from '../lib/live';
import { useToast, Pill } from '../components/ui';
import AdminDashboard from './admin/Dashboard';
import Kitchen from './admin/Kitchen';
import Dispatch from './admin/Dispatch';
import MenuAdmin from './admin/MenuAdmin';
import OrdersAdmin from './admin/OrdersAdmin';
import SettingsAdmin from './admin/SettingsAdmin';
import type { LiveEvent } from '../lib/types';

const TABS = [
  { to: '/admin', label: 'Dashboard', icon: '📊', end: true },
  { to: '/admin/kitchen', label: 'Kitchen', icon: '🍳' },
  { to: '/admin/dispatch', label: 'Dispatch', icon: '🛵' },
  { to: '/admin/orders', label: 'Orders', icon: '🧾' },
  { to: '/admin/menu', label: 'Menu', icon: '📋' },
  { to: '/admin/settings', label: 'Settings', icon: '⚙️' },
];

/** Store console shell: a live connection indicator plus the tab strip. */
export default function Admin() {
  const { push } = useToast();
  const { connected } = useLiveFeed(['admin', 'staff', 'orders', 'drivers'], (event: LiveEvent<any>) => {
    if (event.type === 'dispatch.no_rider') {
      push({ tone: 'bad', title: 'No rider available', body: `Order ${event.payload?.code} is ready and waiting.` });
    }
    if (event.type === 'rider.joined') {
      push({ tone: 'info', title: 'New rider onboarded', body: event.payload?.name });
    }
  });

  return (
    <div className="container section">
      <div className="row-between wrap" style={{ marginBottom: '0.9rem' }}>
        <div>
          <span className="eyebrow gold" style={{ letterSpacing: '0.22em', fontSize: '0.72rem' }}>Store console</span>
          <h1 style={{ margin: '0.2rem 0 0' }}>Khanyisile&rsquo;s Kitchen · operations</h1>
        </div>
        <Pill tone={connected ? 'ok' : 'warn'}>
          <span className={`dot ${connected ? 'dot-live' : 'dot-warn'}`} />
          {connected ? 'Live' : 'Reconnecting…'}
        </Pill>
      </div>

      <nav className="chip-row" aria-label="Console sections">
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => `chip${isActive ? ' active' : ''}`}>
            <span aria-hidden>{tab.icon}</span> {tab.label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        <Route index element={<AdminDashboard />} />
        <Route path="kitchen" element={<Kitchen />} />
        <Route path="dispatch" element={<Dispatch />} />
        <Route path="orders" element={<OrdersAdmin />} />
        <Route path="menu" element={<MenuAdmin />} />
        <Route path="settings" element={<SettingsAdmin />} />
      </Routes>
    </div>
  );
}
