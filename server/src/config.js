import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');          // server/
export const REPO_ROOT = path.resolve(ROOT, '..');          // repo root
export const SERVER_ROOT = ROOT;

function envInt(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const dataDir = process.env.KHANYI_DATA_DIR || path.join(REPO_ROOT, 'data');
fs.mkdirSync(dataDir, { recursive: true });

/**
 * The signing secret is persisted on first boot so that sessions survive
 * restarts. In production you would inject KHANYI_SECRET from the platform.
 */
function resolveSecret() {
  if (process.env.KHANYI_SECRET) return process.env.KHANYI_SECRET;
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: envInt('PORT', 4000),
  host: process.env.HOST || '0.0.0.0',
  secret: resolveSecret(),
  dataDir,
  dbFile: process.env.KHANYI_DB || path.join(dataDir, 'khanyi.db'),
  webDist: path.join(REPO_ROOT, 'web', 'dist'),
  /** Brand + trading facts lifted straight off the shop posters. */
  store: {
    name: "Khanyisile's Kitchen",
    tagline: 'Sweet Treats',
    phone: '082 837 3077',
    altPhone: '073 811 2207',
    suburb: 'Malamulele',
    currency: 'ZAR',
    /**
     * Store coordinates. Malamulele, Limpopo — used for the delivery
     * radius + fee calculation. Overridable in Admin → Settings.
     */
    lat: -22.9573,
    lng: 30.7273,
  },
  tokenTtlSeconds: 60 * 60 * 24 * 7,
};

export default config;
