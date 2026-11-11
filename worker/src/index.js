// Звіт по витратах УБЦ — API на Cloudflare Workers + D1.
// Сторінка (GitHub Pages) надсилає POST {fn, args, token | session} → {ok, result | error, auth} — як старий Apps Script.
import { UserError, authError } from './util.js';
import { identify, isAdmin, startSession, endSession } from './auth.js';
import { ministriesFor } from './data.js';
import { recordStat, adminStats, pruneStats } from './stats.js';
import * as read from './read.js';
import * as ops from './ops.js';
import * as admin from './admin.js';
import { processDue } from './mirror.js';
import { syncSettings, processImportJobs } from './import.js';

const NOT_LISTED = 'Цієї пошти немає в списку служінь. Зверніться до адміністратора, щоб її додали.';

/** Дії для того, хто вже увійшов. Усе інше — заборонено. Кожна admin* сама перевіряє права. */
const ACTIONS = {
  getInitData: read.getInitData,
  getCategories: read.getCategories,
  getRate: read.getRate,
  adminListMinistries: read.adminListMinistries,
  adminMinistrySummary: read.adminMinistrySummary,
  adminMinistryDetail: read.adminMinistryDetail,
  adminStats: ctx => { read.requireAdmin(ctx); return adminStats(ctx.env); },
  submitExpenses: ops.submitExpenses,
  startUploads: ops.startUploads,
  startPreUploads: ops.startPreUploads,
  editOperation: ops.editOperation,
  cancelOperation: ops.cancelOperation,
  adminDeleteOperation: ops.adminDeleteOperation,
  adminSetStatus: ops.adminSetStatus,
  adminCreateReport: admin.adminCreateReport,
  adminCreateAllReports: admin.adminCreateAllReports,
  adminSendInvites: admin.adminSendInvites,
  adminImport: admin.adminImport,
  startSession: ctx => {
    if (ctx.via !== 'google') throw authError('Увійдіть через Google.');
    return startSession(ctx.env, ctx.email);
  },
  endSession: async ctx => { if (ctx.via === 'session') await endSession(ctx.env, ctx.session); return { ok: true }; },
};

/** Текст помилки для людини: наші UserError — як є, внутрішні — лише в журнал. */
function userMessage(err) {
  if (err instanceof UserError) return err.message;
  console.error(err && err.stack ? err.stack : String(err));
  return 'Сталася помилка на сервері. Спробуйте ще раз за хвилину.';
}

/** Звідки сторінка (для CORS сесій завантаження в Диск) — лише з дозволених адрес. */
function siteOrigin(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : allowed[0] || '';
}

function cors(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || (env.ENV === 'dev' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return ok ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {};
}

async function handlePost(request, env, ctxExec) {
  const t0 = Date.now();
  let out, fn = '', who = '', failure = null;
  try {
    let req;
    try { req = JSON.parse(await request.text() || '{}'); } catch (e) { throw new UserError('Невірний запит.'); }
    const args = Array.isArray(req.args) ? req.args : [];
    fn = Object.prototype.hasOwnProperty.call(ACTIONS, req.fn) ? req.fn : '';
    const { email, via } = await identify(env, req);
    who = email;
    if (!isAdmin(env, email) && !(await ministriesFor(env, email)).length) throw authError(NOT_LISTED);
    if (!fn) throw new UserError('Невідома дія.');
    const ctx = { env, email, via, session: req.session, exec: ctxExec, origin: siteOrigin(env, request) };
    out = { ok: true, result: await ACTIONS[fn](ctx, ...args) };
  } catch (err) {
    failure = err;
    out = { ok: false, error: userMessage(err), auth: !!(err && err.auth) };
  }
  ctxExec.waitUntil(recordStat(env, fn, who, failure, out, Date.now() - t0));
  if (fn === 'submitExpenses' || fn === 'startUploads' || fn === 'startPreUploads') console.log(JSON.stringify({ api: fn, ms: Date.now() - t0, ok: !failure }));
  return out;
}

export default {
  async fetch(request, env, ctxExec) {
    const headers = cors(env, request);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
    }
    if (request.method !== 'POST') return new Response('Звіт по витратах — API', { headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
    const out = await handlePost(request, env, ctxExec);
    return new Response(JSON.stringify(out), { headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  },

  async scheduled(event, env, ctxExec) {
    const t = new Date(event.scheduledTime);
    // Щохвилини — дозапис у таблиці того, що не вдалося одразу; раз на 5 хв — таблиця служінь.
    ctxExec.waitUntil(processDue(env).catch(e => console.error('mirror cron', e)));
    if (env.GOOGLE_SA_KEY) ctxExec.waitUntil(processImportJobs(env).catch(e => console.error('import cron', e)));
    if (env.GOOGLE_SA_KEY && env.SETTINGS_SPREADSHEET_ID && t.getUTCMinutes() % 5 === 0) {
      ctxExec.waitUntil(syncSettings(env).catch(e => console.error('settings sync', e)));
    }
    // Раз на добу (о 03:00 UTC) — прибирання старої статистики й прострочених сесій.
    if (new Date(event.scheduledTime).getUTCHours() === 3 && new Date(event.scheduledTime).getUTCMinutes() === 0) {
      ctxExec.waitUntil(pruneStats(env));
      ctxExec.waitUntil(env.DB.prepare('DELETE FROM sessions WHERE exp <= ?').bind(Date.now()).run());
    }
  },
};
