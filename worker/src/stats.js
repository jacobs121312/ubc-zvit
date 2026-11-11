// Статистика для дешборду адміна: атомарні лічильники в D1 (без read-modify-write), пошти — лише відбитком.
import { LIMITS, kyivDay, kyivHour, sha256b64, splitEmails } from './util.js';
import { isAdmin } from './auth.js';

export async function recordStat(env, fn, email, failure, out, ms) {
  try {
    const day = kyivDay(), hour = kyivHour(), name = fn || '—';
    const isAuth = !!(failure && failure.auth), isErr = !!failure && !isAuth;
    const st = [env.DB.prepare(`INSERT INTO stat_counts (day, hour, fn, n, e, a, t, x) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT (day, hour, fn) DO UPDATE SET n = n + 1, e = e + excluded.e, a = a + excluded.a,
      t = t + excluded.t, x = MAX(x, excluded.x)`).bind(day, hour, name, isErr ? 1 : 0, isAuth ? 1 : 0, ms, ms)];
    if (email && !failure) {
      st.push(env.DB.prepare('INSERT OR IGNORE INTO stat_users (day, hash) VALUES (?, ?)').bind(day, (await sha256b64('st:' + email)).slice(0, 8)));
    }
    if (isErr) {
      st.push(env.DB.prepare('INSERT INTO stat_errors (at, fn, m) VALUES (?, ?, ?)').bind(Date.now(), name, String(out && out.error || '').slice(0, 160)));
      st.push(env.DB.prepare('DELETE FROM stat_errors WHERE id NOT IN (SELECT id FROM stat_errors ORDER BY id DESC LIMIT ?)').bind(LIMITS.STATS_ERRORS));
    }
    await env.DB.batch(st);
  } catch (e) { console.error('stat', e); }
}

/** Прибирання старих днів — раз на добу з cron. */
export async function pruneStats(env) {
  const cut = kyivDay(new Date(Date.now() - LIMITS.STATS_DAYS * 864e5));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM stat_counts WHERE day < ?').bind(cut),
    env.DB.prepare('DELETE FROM stat_users WHERE day < ?').bind(cut),
  ]);
}

export async function adminStats(env) {
  const now = Date.now(), first = kyivDay(new Date(now - (LIMITS.STATS_DAYS - 1) * 864e5)), today = kyivDay();
  const [counts, users, errs, sinceRow, ministries, seen, sessions] = await env.DB.batch([
    env.DB.prepare('SELECT day, hour, fn, n, e, a, t, x FROM stat_counts WHERE day >= ?').bind(first),
    env.DB.prepare('SELECT day, hash FROM stat_users WHERE day >= ?').bind(first),
    env.DB.prepare('SELECT at, fn, m FROM stat_errors ORDER BY at DESC LIMIT ?').bind(LIMITS.STATS_ERRORS),
    env.DB.prepare('SELECT MIN(day) AS d FROM stat_counts'),
    env.DB.prepare('SELECT name, emails FROM ministries WHERE active = 1 ORDER BY sort, name'),
    env.DB.prepare('SELECT email, at FROM seen'),
    env.DB.prepare('SELECT email, COUNT(*) AS n FROM sessions WHERE exp > ? GROUP BY email').bind(now),
  ]);
  const byDay = {};
  for (const c of counts.results) {
    const d = byDay[c.day] = byDay[c.day] || { n: 0, e: 0, a: 0, t: 0, x: 0, h: new Array(24).fill(0), fn: {} };
    d.n += c.n; d.e += c.e; d.a += c.a; d.t += c.t; d.x = Math.max(d.x, c.x); d.h[c.hour] += c.n; d.fn[c.fn] = (d.fn[c.fn] || 0) + c.n;
  }
  const usersByDay = {};
  for (const u of users.results) (usersByDay[u.day] = usersByDay[u.day] || new Set()).add(u.hash);
  const days = [];
  for (let i = LIMITS.STATS_DAYS - 1; i >= 0; i--) {
    const d = kyivDay(new Date(now - i * 864e5)), s = byDay[d] || { n: 0, e: 0, a: 0, t: 0, x: 0 };
    days.push({ d, n: s.n, e: s.e, a: s.a, avg: s.n ? Math.round(s.t / s.n) : 0, x: s.x, users: (usersByDay[d] || new Set()).size });
  }
  const uniq = n => { const set = new Set(); days.slice(-n).forEach(x => (usersByDay[x.d] || []).forEach(h => set.add(h))); return set.size; };
  const fnWeek = {};
  days.slice(-7).forEach(x => { const s = byDay[x.d]; if (s) for (const f in s.fn) fnWeek[f] = (fnWeek[f] || 0) + s.fn[f]; });

  const seenMap = Object.fromEntries(seen.results.map(r => [r.email, r.at]));
  const devMap = Object.fromEntries(sessions.results.map(r => [r.email, r.n]));
  const people = {};
  for (const m of ministries.results) for (const e of splitEmails(m.emails)) (people[e] = people[e] || []).push(m.name);
  for (const e of String(env.ADMINS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean)) people[e] = people[e] || ['адмін'];
  const list = Object.keys(people).map(e => ({
    email: e, ministries: people[e], lastSeen: seenMap[e] || 0, devices: devMap[e] || 0,
    church: e.endsWith('@' + env.ALLOWED_DOMAIN),
  })).sort((a, b) => b.lastSeen - a.lastSeen);

  return {
    since: (sinceRow.results[0] && sinceRow.results[0].d) || today,
    days, hours: (byDay[today] || { h: new Array(24).fill(0) }).h,
    users7: uniq(7), users30: uniq(30), fnWeek, errors: errs.results, people: list,
  };
}

export { isAdmin };
