// Дії на читання: вхід, бюджет служіння, курс, адмінка.
import { LIMITS, UserError, fyBounds, splitEmails } from './util.js';
import { isAdmin } from './auth.js';
import { ministriesFor, requireMinistry, ministryById, snapshot, categoriesWithSpent, opsStats, sheetUrl, folderUrl } from './data.js';

export function requireAdmin(ctx) {
  if (!isAdmin(ctx.env, ctx.email)) throw new UserError('Немає доступу адміністратора.');
  return ctx.email;
}

/** Хто зайшов і які служіння йому доступні. */
export async function getInitData(ctx) {
  const { env, email } = ctx;
  await env.DB.prepare('INSERT INTO seen (email, at) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET at = excluded.at')
    .bind(email, Date.now()).run();
  const ministries = await ministriesFor(env, email);
  const admin = isAdmin(env, email);
  if (!ministries.length && !admin) {
    throw new UserError(`Для пошти ${email} не знайдено служіння. Попросіть адміністратора вписати її в таблицю служінь.`);
  }
  let order = null;
  try { order = JSON.parse(env.ORDER_CONTACT || 'null'); } catch (e) {}
  const { min, max } = fyBounds(env);
  return {
    email, isAdmin: admin, ministries: ministries.map(m => ({ id: m.id, name: m.name })),
    order, minDate: min, maxDate: max, currencies: LIMITS.CURRENCIES, editWindowH: LIMITS.EDIT_WINDOW_H,
  };
}

/** Категорії, баланс, аналітика й операції служіння. */
export async function getCategories(ctx, folderId) {
  return snapshot(ctx.env, await requireMinistry(ctx.env, ctx.email, folderId), ctx.email);
}

/** Офіційний курс НБУ на дату (кеш через Cache API Cloudflare). */
export async function nbuRate(currency, iso) {
  const url = `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=${currency}&date=${iso.replace(/-/g, '')}&json`;
  let rate = 0;
  try { rate = Number(((await (await fetch(url, { cf: { cacheTtl: 21600, cacheEverything: true } })).json())[0] || {}).rate); } catch (e) {}
  if (!(rate > 0)) throw new UserError('Не вдалося отримати курс НБУ на цю дату. Спробуйте пізніше або вкажіть суму в гривнях.');
  return rate;
}

export async function getRate(ctx, currency, date) {
  if (currency === 'UAH' || !LIMITS.CURRENCIES.includes(currency)) throw new UserError('Невідома валюта.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new UserError('Вкажіть дату витрати.');
  return { rate: await nbuRate(currency, date) };
}

// ---------------- адмінка ----------------

export async function adminListMinistries(ctx) {
  requireAdmin(ctx);
  const [mins, seen, inv] = await ctx.env.DB.batch([
    ctx.env.DB.prepare('SELECT id, name, responsible, emails FROM ministries WHERE active = 1 ORDER BY sort, name'),
    ctx.env.DB.prepare('SELECT email, at FROM seen'),
    ctx.env.DB.prepare('SELECT email, at FROM invites'),
  ]);
  const s = Object.fromEntries(seen.results.map(r => [r.email, r.at])), v = Object.fromEntries(inv.results.map(r => [r.email, r.at]));
  return mins.results.map(m => ({
    id: m.id, name: m.name, responsible: m.responsible, emails: m.emails,
    users: splitEmails(m.emails).map(e => ({ email: e, lastSeen: s[e] || 0, invitedAt: v[e] || 0 })),
  }));
}

/** Короткий підсумок служіння для огляду. */
export async function adminMinistrySummary(ctx, folderId) {
  requireAdmin(ctx);
  const m = await ministryById(ctx.env, folderId);
  const snap = await snapshot(ctx.env, m, '');
  if (!snap.categories.length) return { id: m.id, status: 'no-report' };
  return Object.assign({
    id: m.id, status: 'ok',
    plan: snap.categories.reduce((a, c) => a + c.plan, 0),
    spent: snap.categories.reduce((a, c) => a + c.spent, 0),
    over: snap.categories.filter(c => c.spent > c.plan).length,
    balance: snap.balance,
  }, opsStats(snap.ops));
}

/** Повні дані служіння для звірки. */
export async function adminMinistryDetail(ctx, folderId) {
  requireAdmin(ctx);
  const m = await ministryById(ctx.env, folderId);
  const base = { id: m.id, name: m.name, responsible: m.responsible, emails: m.emails, folderUrl: folderUrl(m.id) };
  const snap = await snapshot(ctx.env, m, '');
  if (!snap.categories.length) return Object.assign(base, { status: 'no-report', hasXlsx: true });
  return Object.assign(base, {
    status: 'ok', reportUrl: sheetUrl(m.report_sheet_id), receiptsUrl: folderUrl(m.receipts_folder_id || m.id),
    categories: snap.categories, balance: snap.balance, ops: snap.ops,
  }, opsStats(snap.ops));
}

export { categoriesWithSpent };
