// Адмінка: створення звітів, імпорт зі старих таблиць, запрошення.
import { UserError, splitEmails } from './util.js';
import { requireAdmin, adminMinistryDetail } from './read.js';
import { ministryById } from './data.js';
import { importMinistry, importAll, syncSettings } from './import.js';

/** «Звіт 26-27» служінню без звіту: копія «Звіт.xlsx» + перенесення категорій. */
export async function adminCreateReport(ctx, folderId) {
  requireAdmin(ctx);
  await importMinistry(ctx.env, (await ministryById(ctx.env, folderId)).id, { create: true });
  return adminMinistryDetail(ctx, folderId);
}

export async function adminCreateAllReports(ctx) {
  requireAdmin(ctx);
  const t0 = Date.now(), created = [], failed = [];
  let remaining = 0;
  const { results } = await ctx.env.DB.prepare(`SELECT m.id, m.name FROM ministries m WHERE m.active = 1
    AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.ministry_id = m.id) ORDER BY m.sort`).all();
  for (const m of results) {
    if (Date.now() - t0 > 20000) { remaining++; continue; }
    try { const r = await importMinistry(ctx.env, m.id, { create: true }); if (r.status === 'ok') created.push(m.name); }
    catch (e) { failed.push({ name: m.name, error: String(e.message || e).slice(0, 160) }); }
  }
  return { created, failed, remaining };
}

/** Перенесення зі старих таблиць (адмін, разово перед перемиканням; повторний запуск безпечний). */
export async function adminImport(ctx, folderId) {
  requireAdmin(ctx);
  if (folderId) return [await importMinistry(ctx.env, (await ministryById(ctx.env, folderId)).id)];
  await syncSettings(ctx.env);
  return importAll(ctx.env);
}

/**
 * Запрошення на пошту: без списку — усім із таблиці служінь, хто ще не заходив і кому не надсилали 7 днів;
 * зі списком — саме цим людям. Лист відправляє маленький Apps Script-«поштар» (у Worker пошти немає).
 */
export async function adminSendInvites(ctx, emails) {
  requireAdmin(ctx);
  const { env } = ctx;
  if (!env.MAILER_URL || !env.MAILER_KEY) throw new UserError('Розсилку ще не налаштовано.');
  const [mins, seen, inv] = await env.DB.batch([
    env.DB.prepare('SELECT name, emails FROM ministries WHERE active = 1 ORDER BY sort'),
    env.DB.prepare('SELECT email FROM seen'), env.DB.prepare('SELECT email, at FROM invites'),
  ]);
  const byEmail = {};
  mins.results.forEach(m => splitEmails(m.emails).forEach(e => (byEmail[e] = byEmail[e] || []).push(m.name)));
  const seenSet = new Set(seen.results.map(r => r.email)), invMap = Object.fromEntries(inv.results.map(r => [r.email, r.at]));
  const week = Date.now() - 7 * 864e5;
  const targets = Array.isArray(emails) && emails.length
    ? emails.map(e => String(e || '').trim().toLowerCase()).filter(e => byEmail[e])
    : Object.keys(byEmail).filter(e => !seenSet.has(e) && (invMap[e] || 0) < week);
  let sent = 0, skipped = 0, remainingQuota = null;
  for (const e of targets) {
    const res = await fetch(env.MAILER_URL, { method: 'POST', redirect: 'follow', body: JSON.stringify({ key: env.MAILER_KEY, to: e, ministries: byEmail[e], site: env.SITE_URL || 'https://budget.ubchurch.lviv.ua/' }) });
    let j = {};
    try { j = await res.json(); } catch (err) {}
    if (!j.ok) { skipped = targets.length - sent; break; }
    remainingQuota = j.remainingQuota;
    await env.DB.prepare('INSERT INTO invites (email, at) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET at = excluded.at').bind(e, Date.now()).run();
    sent++;
  }
  return { sent, skipped, remainingQuota };
}
