import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';
import { useToast, Spinner } from '../components/ui';
import { ApiError } from '../lib/api';

const DEMO_ACCOUNTS = [
  { role: 'Customer', email: 'customer@demo.kk', icon: '🧑' },
  { role: 'Rider', email: 'driver@demo.kk', icon: '🛵' },
  { role: 'Store admin', email: 'admin@demo.kk', icon: '👩‍🍳' },
];

export default function Auth({ mode }: { mode: 'login' | 'register' }) {
  const { login, register, loading } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const { push } = useToast();

  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    password: '',
  });
  const [error, setError] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const user =
        mode === 'login'
          ? await login(form.email.trim(), form.password)
          : await register({
              name: form.name.trim(),
              email: form.email.trim(),
              phone: form.phone.trim() || undefined,
              password: form.password,
            });

      push({ tone: 'ok', title: `Welcome${mode === 'register' ? '' : ' back'}, ${user.name.split(' ')[0]}!` });

      // Send people where they were headed, or where their role belongs.
      if (from) navigate(from, { replace: true });
      else if (user.role === 'admin') navigate('/admin');
      else if (user.role === 'driver') navigate('/rider');
      else navigate('/');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Something went wrong — try again');
    }
  };

  const fillDemo = (email: string) => {
    setForm({ ...form, email, password: 'demo1234' });
    setError(null);
  };

  return (
    <div className="container-narrow section">
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="card card-gold">
          <span className="eyebrow gold" style={{ letterSpacing: '0.2em', fontSize: '0.72rem' }}>
            {mode === 'login' ? 'Welcome back' : 'Join the family'}
          </span>
          <h1 style={{ margin: '0.3rem 0 0.8rem' }}>
            {mode === 'login' ? 'Sign in' : 'Create your account'}
          </h1>

          <form onSubmit={submit}>
            {mode === 'register' ? (
              <label className="field">
                <span>Your name</span>
                <input
                  className="input"
                  value={form.name}
                  required
                  minLength={2}
                  placeholder="Nomsa Mokoena"
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </label>
            ) : null}

            <label className="field">
              <span>Email</span>
              <input
                className="input"
                type="email"
                value={form.email}
                required
                autoComplete="email"
                placeholder="you@example.com"
                onChange={(event) => setForm({ ...form, email: event.target.value })}
              />
            </label>

            {mode === 'register' ? (
              <label className="field">
                <span>Phone (for the rider)</span>
                <input
                  className="input"
                  value={form.phone}
                  placeholder="073 811 2207"
                  onChange={(event) => setForm({ ...form, phone: event.target.value })}
                />
              </label>
            ) : null}

            <label className="field">
              <span>Password</span>
              <input
                className="input"
                type="password"
                value={form.password}
                required
                minLength={6}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                placeholder="At least 6 characters"
                onChange={(event) => setForm({ ...form, password: event.target.value })}
              />
            </label>

            {error ? <div className="notice notice-error" style={{ marginBottom: '0.8rem' }}><span aria-hidden>⚠️</span><span>{error}</span></div> : null}

            <button className="btn btn-primary btn-block btn-lg" disabled={loading} type="submit">
              {loading ? <Spinner /> : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <p className="small muted center" style={{ marginTop: '0.9rem' }}>
            {mode === 'login' ? (
              <>New here? <Link to="/register">Create an account</Link></>
            ) : (
              <>Already have one? <Link to="/login">Sign in</Link></>
            )}
          </p>
        </div>

        <div className="stack">
          <div className="card">
            <h3>Try it instantly</h3>
            <p className="small muted">
              These demo accounts are pre-loaded with orders, a menu and riders on shift.
              Password for all three is <code className="inline">demo1234</code>.
            </p>
            <div className="stack" style={{ gap: '0.5rem' }}>
              {DEMO_ACCOUNTS.map((account) => (
                <button
                  key={account.email}
                  className="btn btn-ghost btn-block"
                  style={{ justifyContent: 'flex-start' }}
                  onClick={() => fillDemo(account.email)}
                  type="button"
                >
                  <span aria-hidden>{account.icon}</span>
                  <span className="grow" style={{ textAlign: 'left' }}>
                    <strong style={{ display: 'block' }}>{account.role}</strong>
                    <span className="tiny muted mono">{account.email}</span>
                  </span>
                  <span className="tiny muted">use</span>
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <h3>What you get</h3>
            <ul className="small muted" style={{ paddingLeft: '1.1rem', margin: 0 }}>
              <li>Order for collection or delivery by bike — live rider availability</li>
              <li>Track your food from the fryer to your gate</li>
              <li>Loyalty points on every order, redeemable at checkout</li>
              <li>Saved addresses so checkout takes seconds</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
