import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="container-narrow section center">
      <div className="card card-gold">
        <div style={{ fontSize: '3.4rem' }} aria-hidden>🍽️</div>
        <h1 style={{ marginBottom: '0.2rem' }}>That page is not on the menu</h1>
        <p className="muted">The link may be old, or the dish sold out and went home.</p>
        <div className="row" style={{ justifyContent: 'center', gap: '0.6rem' }}>
          <Link className="btn btn-primary" to="/">Back to the menu</Link>
          <Link className="btn btn-ghost" to="/orders">My orders</Link>
        </div>
      </div>
    </div>
  );
}
