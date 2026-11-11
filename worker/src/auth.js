// Вхід: Google ID token перевіряється локально (підпис RS256 за публічними ключами Google),
// без запиту до tokeninfo на кожен вхід. Довгий вхід — власний ключ сесії (у базі лише геш).
import { authError, sha256b64, LIMITS } from './util.js';

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let jwks = { keys: new Map(), exp: 0 };

async function googleKey(kid) {
  if (Date.now() > jwks.exp || !jwks.keys.has(kid)) {
    const res = await fetch(JWKS_URL, { cf: { cacheTtl: 3600 } });
    if (!res.ok) throw new Error('JWKS ' + res.status);
    const maxAge = Number((res.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
    const keys = new Map();
    for (const jwk of (await res.json()).keys || []) {
      keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    }
    jwks = { keys, exp: Date.now() + Math.min(maxAge, 6 * 3600) * 1000 };
  }
  return jwks.keys.get(kid);
}

const b64urlBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

/** Перевіряє Google ID token і повертає пошту (лише церковний домен). */
export async function verifyIdToken(env, token) {
  if (!token || typeof token !== 'string' || token.length > 4096) throw authError('Увійдіть через Google.');
  const parts = token.split('.');
  let head, p;
  try { head = b64urlJson(parts[0]); p = b64urlJson(parts[1]); } catch (e) { throw authError('Недійсний вхід — увійдіть знову.'); }
  if (parts.length !== 3 || head.alg !== 'RS256' || !head.kid) throw authError('Недійсний вхід — увійдіть знову.');
  const issuerOk = p.iss === 'accounts.google.com' || p.iss === 'https://accounts.google.com';
  const verified = p.email_verified === true || p.email_verified === 'true';
  if (p.aud !== env.GOOGLE_CLIENT_ID || !issuerOk || !verified || !p.email) throw authError('Недійсний вхід — увійдіть знову.');
  if (!(Number(p.exp) * 1000 > Date.now())) throw authError('Сесія завершилась — увійдіть знову.');
  const key = await googleKey(head.kid);
  const ok = key && await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw authError('Недійсний вхід — увійдіть знову.');
  const email = String(p.email).toLowerCase();
  if (p.hd !== env.ALLOWED_DOMAIN || !email.endsWith('@' + env.ALLOWED_DOMAIN)) {
    throw authError(`Вхід лише з церковною поштою @${env.ALLOWED_DOMAIN}.`);
  }
  return email;
}

/** Ключ сесії → пошта. До Google не звертається. */
export async function verifySession(env, session) {
  if (!/^[0-9a-f]{64}$/.test(String(session || ''))) throw authError('Сесія завершилась — увійдіть знову.');
  const row = await env.DB.prepare('SELECT email, exp FROM sessions WHERE hash = ?').bind(await sha256b64(session)).first();
  if (!row || !(row.exp > Date.now())) throw authError('Сесія завершилась — увійдіть знову.');
  return row.email;
}

export const isAdmin = (env, email) => String(env.ADMINS || '').toLowerCase().split(/[\s,;]+/).includes(String(email || '').toLowerCase());

/** Після входу через Google — новий ключ сесії (найстаріші пристрої понад ліміт виходять). */
export async function startSession(env, email) {
  const now = Date.now();
  const days = isAdmin(env, email) ? LIMITS.SESSION_DAYS_ADMIN : LIMITS.SESSION_DAYS;
  const exp = now + days * 864e5;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const session = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE exp <= ?').bind(now),
    env.DB.prepare(`DELETE FROM sessions WHERE email = ?1 AND hash NOT IN
      (SELECT hash FROM sessions WHERE email = ?1 ORDER BY exp DESC LIMIT ?2)`).bind(email, LIMITS.SESSIONS_PER_USER - 1),
    env.DB.prepare('INSERT INTO sessions (hash, email, exp) VALUES (?, ?, ?)').bind(await sha256b64(session), email, exp),
  ]);
  return { session, exp };
}

export async function endSession(env, session) {
  if (/^[0-9a-f]{64}$/.test(String(session || ''))) {
    await env.DB.prepare('DELETE FROM sessions WHERE hash = ?').bind(await sha256b64(session)).run();
  }
}

/**
 * Хто робить запит: {email, via}. Локально (ENV=dev і DEV_AUTH=1) приймається токен «dev:пошта» —
 * лише для тестів; у робочому розгортанні цих змінних немає.
 */
export async function identify(env, req) {
  if (env.ENV === 'dev' && env.DEV_AUTH === '1' && /^dev:[^@\s]+@[^@\s]+$/.test(String(req.token || ''))) {
    return { email: req.token.slice(4).toLowerCase(), via: 'google' };
  }
  if (req.session) return { email: await verifySession(env, req.session), via: 'session' };
  return { email: await verifyIdToken(env, req.token), via: 'google' };
}
