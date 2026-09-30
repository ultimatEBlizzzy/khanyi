import { useCallback, useEffect, useState } from 'react';

import api from '../../lib/api';
import { useToast, Pill, Spinner, Stat } from '../../components/ui';
import { money, dateTime } from '../../lib/format';

interface Settings {
  [key: string]: string;
}

interface AuditEntry {
  id: number;
  actor_name: string;
  action: string;
  entity: string;
  entity_id: string;
  created_at: string;
  meta: string;
}

interface Customer {
  id: number;
  name: string;
  email: string;
  phone: string;
  loyalty_points: number;
  orders: number;
  spent: number;
  last_order: string | null;
  is_active: number;
}

export default function SettingsAdmin() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings>({});
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [riderForm, setRiderForm] = useState({ name: '', email: '', phone: '', password: '', vehicle: 'scooter', plate: '' });
  const { push } = useToast();

  const load = useCallback(async () => {
    try {
      const [settingsData, auditData, customerData] = await Promise.all([
        api.get<{ settings: Settings }>('/api/admin/settings'),
        api.get<{ entries: AuditEntry[] }>('/api/admin/audit?limit=40'),
        api.get<{ customers: Customer[] }>('/api/admin/customers'),
      ]);
      setSettings(settingsData.settings);
      setDraft(settingsData.settings);
      setAudit(auditData.entries);
      setCustomers(customerData.customers);
    } catch (error) {
      push({ tone: 'bad', title: 'Could not load settings', body: (error as Error).message });
    }
  }, [push]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (key: string, value: boolean) => {
    setBusy(key);
    try {
      const result = await api.post<{ settings: Settings }>('/api/admin/settings/toggle', { key, value });
      setSettings(result.settings);
      setDraft(result.settings);
      push({ tone: 'ok', title: key === 'store_open' ? (value ? 'Kitchen opened' : 'Kitchen closed') : key === 'accepting_orders' ? (value ? 'Taking orders again' : 'Orders paused') : value ? 'Auto-dispatch on' : 'Auto-dispatch off' });
    } catch (error) {
      push({ tone: 'bad', title: 'Could not save that', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = async () => {
    setBusy('save');
    try {
      const payload: Record<string, string | number> = {};
      for (const key of ['base_delivery_fee', 'per_km_fee', 'free_delivery_over', 'delivery_radius_km', 'min_order', 'prep_capacity_per_hour', 'busy_threshold_orders', 'loyalty_point_value', 'min_points_to_redeem', 'announcement', 'store_lat', 'store_lng']) {
        payload[key] = draft[key];
      }
      const result = await api.patch<{ settings: Settings }>('/api/admin/settings', payload);
      setSettings(result.settings);
      setDraft(result.settings);
      push({ tone: 'ok', title: 'Settings saved', body: 'The storefront picked them up immediately.' });
    } catch (error) {
      push({ tone: 'bad', title: 'Could not save', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const createRider = async () => {
    setBusy('rider');
    try {
      await api.post('/api/admin/riders', {
        name: riderForm.name,
        email: riderForm.email,
        phone: riderForm.phone,
        password: riderForm.password,
        vehicle: riderForm.vehicle,
        plate: riderForm.plate,
      });
      push({ tone: 'ok', title: `${riderForm.name} is on the fleet` });
      setRiderForm({ name: '', email: '', phone: '', password: '', vehicle: 'scooter', plate: '' });
      await load();
    } catch (error) {
      push({ tone: 'bad', title: 'Could not add that rider', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const reconcile = async () => {
    setBusy('reconcile');
    try {
      const result = await api.post<{ checked: number; corrected: number }>('/api/admin/reconcile');
      push({ tone: 'ok', title: 'Books checked', body: `${result.checked} orders verified, ${result.corrected} corrected` });
    } catch (error) {
      push({ tone: 'bad', title: 'Reconcile failed', body: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  if (!settings) return <Spinner label="Loading settings…" />;

  const loyaltyValue = Number(settings.loyalty_point_value ?? 10);

  return (
    <div className="stack" style={{ marginTop: '0.6rem' }}>
      <div className="grid grid-3">
        <section className="card">
          <h3>Trading switches</h3>
          <label className="switch" style={{ marginBottom: '0.7rem' }}>
            <input type="checkbox" checked={settings.store_open === '1'} disabled={busy === 'store_open'} onChange={(event) => toggle('store_open', event.target.checked)} />
            <span className="switch-track" />
            <span className="small">Kitchen is open</span>
          </label>
          <label className="switch" style={{ marginBottom: '0.7rem' }}>
            <input type="checkbox" checked={settings.accepting_orders === '1'} disabled={busy === 'accepting_orders'} onChange={(event) => toggle('accepting_orders', event.target.checked)} />
            <span className="switch-track" />
            <span className="small">Accepting new orders</span>
          </label>
          <label className="switch">
            <input type="checkbox" checked={settings.auto_assign_riders === '1'} disabled={busy === 'auto_assign_riders'} onChange={(event) => toggle('auto_assign_riders', event.target.checked)} />
            <span className="switch-track" />
            <span className="small">Auto-assign the nearest free rider</span>
          </label>
          <p className="tiny muted" style={{ marginTop: '0.6rem' }}>
            Switching orders off shows customers a friendly “back shortly” instead of refusing the payment.
          </p>
        </section>

        <section className="card">
          <h3>Delivery &amp; pricing</h3>
          <label className="field">
            <span>Call-out fee (cents)</span>
            <input className="input" type="number" value={draft.base_delivery_fee ?? ''} onChange={(e) => setDraft({ ...draft, base_delivery_fee: e.target.value })} />
            <span className="field-hint">{money(Number(draft.base_delivery_fee ?? 0))}</span>
          </label>
          <label className="field">
            <span>Per kilometre (cents)</span>
            <input className="input" type="number" value={draft.per_km_fee ?? ''} onChange={(e) => setDraft({ ...draft, per_km_fee: e.target.value })} />
            <span className="field-hint">{money(Number(draft.per_km_fee ?? 0))} per km</span>
          </label>
          <label className="field">
            <span>Free delivery over (cents)</span>
            <input className="input" type="number" value={draft.free_delivery_over ?? ''} onChange={(e) => setDraft({ ...draft, free_delivery_over: e.target.value })} />
            <span className="field-hint">{money(Number(draft.free_delivery_over ?? 0))}</span>
          </label>
          <label className="field">
            <span>Delivery radius (km)</span>
            <input className="input" type="number" value={draft.delivery_radius_km ?? ''} onChange={(e) => setDraft({ ...draft, delivery_radius_km: e.target.value })} />
          </label>
          <label className="field">
            <span>Minimum order (cents)</span>
            <input className="input" type="number" value={draft.min_order ?? ''} onChange={(e) => setDraft({ ...draft, min_order: e.target.value })} />
            <span className="field-hint">{money(Number(draft.min_order ?? 0))}</span>
          </label>
        </section>

        <section className="card">
          <h3>Kitchen &amp; loyalty</h3>
          <label className="field">
            <span>Prep capacity per hour</span>
            <input className="input" type="number" value={draft.prep_capacity_per_hour ?? ''} onChange={(e) => setDraft({ ...draft, prep_capacity_per_hour: e.target.value })} />
          </label>
          <label className="field">
            <span>“Busy” after this many open orders</span>
            <input className="input" type="number" value={draft.busy_threshold_orders ?? ''} onChange={(e) => setDraft({ ...draft, busy_threshold_orders: e.target.value })} />
          </label>
          <label className="field">
            <span>Point value (cents per point)</span>
            <input className="input" type="number" value={draft.loyalty_point_value ?? ''} onChange={(e) => setDraft({ ...draft, loyalty_point_value: e.target.value })} />
            <span className="field-hint">
              {Number(draft.loyalty_points_per_rand ?? 0.1)} point per R1 spent · {loyaltyValue}c each
            </span>
          </label>
          <label className="field">
            <span>Minimum points to redeem</span>
            <input className="input" type="number" value={draft.min_points_to_redeem ?? ''} onChange={(e) => setDraft({ ...draft, min_points_to_redeem: e.target.value })} />
          </label>
          <label className="field">
            <span>Store location (lat, lng)</span>
            <div className="row" style={{ gap: '0.4rem' }}>
              <input className="input" value={draft.store_lat ?? ''} onChange={(e) => setDraft({ ...draft, store_lat: e.target.value })} />
              <input className="input" value={draft.store_lng ?? ''} onChange={(e) => setDraft({ ...draft, store_lng: e.target.value })} />
            </div>
            <span className="field-hint">Used for the delivery distance and fee.</span>
          </label>
        </section>
      </div>

      <section className="card">
        <label className="field">
          <span>Storefront announcement</span>
          <input className="input" value={draft.announcement ?? ''} onChange={(e) => setDraft({ ...draft, announcement: e.target.value })} />
        </label>
        <div className="row wrap" style={{ gap: '0.5rem' }}>
          <button className="btn btn-primary" onClick={saveSettings} disabled={busy === 'save'}>
            {busy === 'save' ? <Spinner /> : 'Save settings'}
          </button>
          <button className="btn btn-ghost" onClick={reconcile} disabled={busy === 'reconcile'}>
            {busy === 'reconcile' ? <Spinner /> : 'Reconcile the books'}
          </button>
          <button className="btn btn-ghost" onClick={() => setDraft(settings)}>Reset changes</button>
        </div>
      </section>

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <section className="card">
          <h3>Onboard a rider</h3>
          <div className="grid grid-2" style={{ gap: '0.6rem' }}>
            <label className="field"><span>Name</span><input className="input" value={riderForm.name} onChange={(e) => setRiderForm({ ...riderForm, name: e.target.value })} /></label>
            <label className="field"><span>Phone</span><input className="input" value={riderForm.phone} onChange={(e) => setRiderForm({ ...riderForm, phone: e.target.value })} /></label>
            <label className="field"><span>Email</span><input className="input" type="email" value={riderForm.email} onChange={(e) => setRiderForm({ ...riderForm, email: e.target.value })} /></label>
            <label className="field"><span>Temporary password</span><input className="input" value={riderForm.password} onChange={(e) => setRiderForm({ ...riderForm, password: e.target.value })} /></label>
            <label className="field">
              <span>Vehicle</span>
              <select className="input" value={riderForm.vehicle} onChange={(e) => setRiderForm({ ...riderForm, vehicle: e.target.value })}>
                <option value="scooter">Scooter (2 runs)</option>
                <option value="bike">Bicycle (1 run)</option>
                <option value="car">Car (3 runs)</option>
              </select>
            </label>
            <label className="field"><span>Plate</span><input className="input" value={riderForm.plate} onChange={(e) => setRiderForm({ ...riderForm, plate: e.target.value })} /></label>
          </div>
          <button className="btn btn-primary" onClick={createRider} disabled={busy === 'rider' || !riderForm.name || !riderForm.email || riderForm.password.length < 6}>
            {busy === 'rider' ? <Spinner /> : 'Create rider account'}
          </button>
        </section>

        <section className="card">
          <div className="card-head">
            <h3 style={{ margin: 0 }}>Customers</h3>
            <Pill>{customers.length}</Pill>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Orders</th><th>Spend</th><th>Points</th><th>Last order</th></tr></thead>
              <tbody>
                {customers.slice(0, 12).map((customer) => (
                  <tr key={customer.id}>
                    <td>
                      {customer.name}
                      <div className="tiny muted">{customer.email}</div>
                    </td>
                    <td>{customer.orders}</td>
                    <td className="mono">{money(customer.spent)}</td>
                    <td>{customer.loyalty_points}</td>
                    <td className="tiny muted nowrap">{customer.last_order ? dateTime(customer.last_order) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h3 style={{ margin: 0 }}>Audit trail</h3>
          <Pill tone="gold">everything the team changes is logged</Pill>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
            <tbody>
              {audit.map((entry) => (
                <tr key={entry.id}>
                  <td className="tiny muted nowrap">{dateTime(entry.created_at)}</td>
                  <td>{entry.actor_name}</td>
                  <td><code className="inline">{entry.action}</code></td>
                  <td className="muted">{entry.entity}{entry.entity_id ? ` #${entry.entity_id}` : ''}</td>
                  <td className="tiny muted">{entry.meta}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-4">
        <div className="card"><Stat label="Store latitude" value={settings.store_lat} /></div>
        <div className="card"><Stat label="Store longitude" value={settings.store_lng} /></div>
        <div className="card"><Stat label="Points per rand" value={settings.loyalty_points_per_rand} /></div>
        <div className="card"><Stat label="Prep capacity / hour" value={settings.prep_capacity_per_hour} /></div>
      </div>
    </div>
  );
}
