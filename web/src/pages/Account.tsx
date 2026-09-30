import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import api from '../lib/api';
import { useSession } from '../lib/session';
import { useToast, Pill, Spinner, Stat } from '../components/ui';
import { money, dateTime, initials, vehicleIcon } from '../lib/format';
import type { Address, Order } from '../lib/types';

export default function Account() {
  const { user, addresses, saveAddress, removeAddress, refresh, logout } = useSession();
  const { push } = useToast();
  const navigate = useNavigate();

  const [profile, setProfile] = useState({ name: user?.name ?? '', phone: user?.phone ?? '' });
  const [passwords, setPasswords] = useState({ current: '', next: '' });
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [newAddress, setNewAddress] = useState({ label: 'Home', line1: '', suburb: 'Malamulele', notes: '' });
  const [loyalty, setLoyalty] = useState<{ points: number; history: Order[] } | null>(null);
  const [stats, setStats] = useState<{ orders: number; spent: number } | null>(null);

  useEffect(() => {
    void (async () => {
      const [me, points] = await Promise.all([
        api.get<{ stats: { orders: number; spent: number } }>('/api/auth/me'),
        api.get<{ points: number; history: Order[] }>('/api/auth/me/loyalty'),
      ]);
      setStats(me.stats);
      setLoyalty(points);
    })();
  }, [user?.id]);

  if (!user) return null;

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingProfile(true);
    try {
      await api.patch('/api/auth/me', { name: profile.name, phone: profile.phone });
      await refresh();
      push({ tone: 'ok', title: 'Profile updated' });
    } catch (cause) {
      push({ tone: 'bad', title: 'Could not save', body: (cause as Error).message });
    } finally {
      setSavingProfile(false);
    }
  };

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingPassword(true);
    try {
      await api.patch('/api/auth/me', { currentPassword: passwords.current, newPassword: passwords.next });
      setPasswords({ current: '', next: '' });
      push({ tone: 'ok', title: 'Password changed' });
    } catch (cause) {
      push({ tone: 'bad', title: 'Could not change the password', body: (cause as Error).message });
    } finally {
      setSavingPassword(false);
    }
  };

  const addNewAddress = async () => {
    if (newAddress.line1.trim().length < 4) {
      push({ tone: 'bad', title: 'That address looks too short' });
      return;
    }
    try {
      await saveAddress({
        label: newAddress.label,
        line1: newAddress.line1.trim(),
        suburb: newAddress.suburb.trim(),
        notes: newAddress.notes.trim(),
      });
      setNewAddress({ label: 'Home', line1: '', suburb: 'Malamulele', notes: '' });
      push({ tone: 'ok', title: 'Address saved' });
    } catch (cause) {
      push({ tone: 'bad', title: 'Could not save that address', body: (cause as Error).message });
    }
  };

  return (
    <div className="container section">
      <div className="row-between wrap" style={{ marginBottom: '1.2rem' }}>
        <div className="row" style={{ gap: '0.9rem' }}>
          <span className="avatar" style={{ width: 56, height: 56, fontSize: '1.2rem' }}>{initials(user.name)}</span>
          <div>
            <span className="eyebrow gold" style={{ letterSpacing: '0.2em', fontSize: '0.72rem' }}>
              {user.role === 'admin' ? 'Store admin' : user.role === 'driver' ? 'Rider' : 'Customer'}
            </span>
            <h1 style={{ margin: 0 }}>{user.name}</h1>
            <div className="small muted">{user.email} · joined {dateTime(user.createdAt)}</div>
          </div>
        </div>
        <div className="row" style={{ gap: '0.5rem' }}>
          {user.role === 'admin' ? <Link className="btn btn-primary" to="/admin">Open the store console</Link> : null}
          {user.role === 'driver' ? <Link className="btn btn-primary" to="/rider">Open the rider app</Link> : null}
          <button className="btn btn-ghost" onClick={() => { logout(); navigate('/'); }}>Sign out</button>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: '1.2rem' }}>
        <div className="card"><Stat label="Orders placed" value={stats?.orders ?? '—'} /></div>
        <div className="card"><Stat label="Lifetime spend" value={money(stats?.spent ?? 0)} /></div>
        <div className="card">
          <Stat
            label="Loyalty points"
            value={loyalty?.points ?? user.loyaltyPoints}
            sub={`worth ${money((loyalty?.points ?? user.loyaltyPoints) * 10)}`}
          />
        </div>
        <div className="card">
          <Stat label="Saved addresses" value={addresses.length} />
        </div>
      </div>

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          <form className="card" onSubmit={saveProfile}>
            <h3>Your details</h3>
            <label className="field">
              <span>Name</span>
              <input className="input" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
            </label>
            <label className="field">
              <span>Phone</span>
              <input className="input" value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} placeholder="073 811 2207" />
            </label>
            <button className="btn btn-primary" disabled={savingProfile}>
              {savingProfile ? <Spinner label="Saving" /> : 'Save details'}
            </button>
          </form>

          <form className="card" onSubmit={changePassword}>
            <h3>Password</h3>
            <label className="field">
              <span>Current password</span>
              <input className="input" type="password" value={passwords.current} onChange={(e) => setPasswords({ ...passwords, current: e.target.value })} required />
            </label>
            <label className="field">
              <span>New password</span>
              <input className="input" type="password" minLength={6} value={passwords.next} onChange={(e) => setPasswords({ ...passwords, next: e.target.value })} required />
            </label>
            <button className="btn btn-ghost" disabled={savingPassword}>
              {savingPassword ? <Spinner label="Updating" /> : 'Change password'}
            </button>
          </form>

          {loyalty?.history.length ? (
            <section className="card">
              <h3>Points activity</h3>
              <div className="table-wrap" style={{ border: 0 }}>
                <table style={{ minWidth: 0 }}>
                  <thead>
                    <tr><th>Order</th><th>Earned</th><th>Used</th><th>When</th></tr>
                  </thead>
                  <tbody>
                    {loyalty.history.map((order) => (
                      <tr key={order.code}>
                        <td><Link className="mono" to={`/orders/${order.code}`}>{order.code}</Link></td>
                        <td className="ok">+{order.points_earned}</td>
                        <td className={order.points_redeemed ? 'bad' : 'muted'}>−{order.points_redeemed}</td>
                        <td className="muted tiny">{dateTime(order.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>

        <div className="stack">
          <section className="card">
            <div className="row-between">
              <h3 style={{ margin: 0 }}>Delivery addresses</h3>
              <Pill>{addresses.length}</Pill>
            </div>
            <div className="stack" style={{ marginTop: '0.7rem' }}>
              {addresses.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No saved addresses yet.</p> : null}
              {addresses.map((address: Address) => (
                <div className="card card-tight" key={address.id}>
                  <div className="row-between">
                    <strong>{address.label}</strong>
                    <div className="row" style={{ gap: '0.4rem' }}>
                      {address.is_default ? <Pill tone="gold">default</Pill> : null}
                      <button className="btn btn-xs btn-ghost" onClick={() => void removeAddress(address.id)}>Delete</button>
                    </div>
                  </div>
                  <div className="small muted">{address.line1}{address.suburb ? `, ${address.suburb}` : ''}</div>
                  {address.notes ? <div className="tiny muted">“{address.notes}”</div> : null}
                  {address.lat === null ? <div className="tiny warn">Not pinned on the map — the store may confirm the fee</div> : null}
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <h3>Add an address</h3>
            <label className="field">
              <span>Label</span>
              <input className="input" value={newAddress.label} onChange={(e) => setNewAddress({ ...newAddress, label: e.target.value })} />
            </label>
            <label className="field">
              <span>Street address</span>
              <input className="input" placeholder="1123 Malamulele Main Road" value={newAddress.line1} onChange={(e) => setNewAddress({ ...newAddress, line1: e.target.value })} />
            </label>
            <label className="field">
              <span>Suburb</span>
              <input className="input" value={newAddress.suburb} onChange={(e) => setNewAddress({ ...newAddress, suburb: e.target.value })} />
            </label>
            <label className="field">
              <span>Rider notes</span>
              <input className="input" placeholder="Green gate next to the crèche" value={newAddress.notes} onChange={(e) => setNewAddress({ ...newAddress, notes: e.target.value })} />
            </label>
            <button className="btn btn-primary" onClick={addNewAddress}>Save address</button>
          </section>

          {user.role === 'driver' ? (
            <section className="card">
              <h3>Your rider profile</h3>
              <p className="small muted" style={{ margin: 0 }}>
                {vehicleIcon('scooter')} On-shift status, runs and earnings live in the rider app.
              </p>
              <Link className="btn btn-primary btn-sm" style={{ marginTop: '0.6rem' }} to="/rider">Open rider app</Link>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
