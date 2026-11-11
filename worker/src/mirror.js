// Дзеркало в «Звіт 26-27» служіння (для бухгалтерії). Джерело правди — D1; сюди лише дописуємо.
// Зміни лягають у outbox у тій самій транзакції, що й запис у D1, і виконуються після відповіді (waitUntil),
// а що не вдалося — повторює cron. Рядок операції шукається за її ID у колонці K, тож повтор не створює дубль.
import { monthName, stamp, receiptUrl } from './util.js';
import { sheetsGet, sheetsValues, sheetsBatchUpdate, fileMeta, patchFile, monthFolderId } from './google.js';

const FIRST_ROW = 8;          // перший рядок даних на аркуші місяця
const MAX_ROW = 600;
const LEASE_MS = 120000;
const TOTAL_RE = /^\s*Total Expenses/i;

/** Завдання для дзеркала — як підготовлений запит, щоб піти в той самий batch, що й запис у D1. */
export const enqueue = (env, ministryId, kind, payload) => env.DB.prepare(
  'INSERT INTO outbox (ministry_id, kind, payload, next_at) VALUES (?, ?, ?, ?)').bind(ministryId, kind, JSON.stringify(payload), Date.now());

/** Після відповіді лідерові — спробувати одразу записати в таблицю. */
export function kick(ctx, ministryId) {
  if (ctx.exec && ctx.env.GOOGLE_SA_KEY) ctx.exec.waitUntil(processMinistry(ctx.env, ministryId).catch(e => console.error('mirror', e)));
}

async function lease(env, ministryId) {
  const now = Date.now();
  const r = await env.DB.prepare(`INSERT INTO locks (key, until) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET until = ?2
    WHERE until < ?3 RETURNING until`).bind('mirror:' + ministryId, now + LEASE_MS, now).first();
  return !!r;
}
const release = (env, ministryId) => env.DB.prepare('DELETE FROM locks WHERE key = ?').bind('mirror:' + ministryId).run();

/** Усі завдання, яким настав час (cron). */
export async function processDue(env, limit = 20) {
  if (!env.GOOGLE_SA_KEY) return;
  const { results } = await env.DB.prepare('SELECT DISTINCT ministry_id FROM outbox WHERE next_at <= ? LIMIT ?').bind(Date.now(), limit).all();
  for (const r of results) await processMinistry(env, r.ministry_id).catch(e => console.error('mirror', r.ministry_id, e));
}

/** Виконує чергу одного служіння під орендою (послідовно, щоб рядки не перетнулись). */
export async function processMinistry(env, ministryId) {
  if (!(await lease(env, ministryId))) return; // уже пише інший процес — він підбере й ці завдання
  try {
    const ministry = await env.DB.prepare('SELECT * FROM ministries WHERE id = ?').bind(ministryId).first();
    const { results: jobs } = await env.DB.prepare('SELECT * FROM outbox WHERE ministry_id = ? AND next_at <= ? ORDER BY id LIMIT 30')
      .bind(ministryId, Date.now()).all();
    if (!jobs.length) return;
    // Перенесення фото таблиці звіту не потребує; решта — лише коли таблиця є.
    const sheetJobs = jobs.filter(j => j.kind !== 'move_receipt');
    if (sheetJobs.length && (!ministry || !ministry.report_sheet_id)) {
      await postpone(env, sheetJobs.map(j => j.id), 'немає таблиці звіту', 10 * 60000);
    }
    const sheet = ministry && ministry.report_sheet_id ? new SheetCtx(env, ministry.report_sheet_id) : null;
    // Спершу рядки в таблиці (їх чекає бухгалтерія), потім перенесення фото — посилання від нього не змінюється.
    jobs.sort((a, b) => (a.kind === 'move_receipt') - (b.kind === 'move_receipt') || a.id - b.id);
    for (const job of jobs) {
      if (job.kind !== 'move_receipt' && !sheet) continue;
      try {
        const p = JSON.parse(job.payload), t0 = Date.now();
        if (job.kind === 'move_receipt') await moveReceipt(env, ministry, p);
        else if (job.kind === 'upsert_op' || job.kind === 'delete_op') await syncOp(env, sheet, p.id);
        await env.DB.prepare('DELETE FROM outbox WHERE id = ?').bind(job.id).run();
        // час запису в таблицю і затримка від подання до рядка в «Звіт 26-27» (для журналу wrangler tail)
        console.log(JSON.stringify({ mirror: job.kind, op: p.id, sheetMs: Date.now() - t0, lagMs: Date.now() - job.next_at, tries: job.tries }));
      } catch (e) {
        console.error('mirror job', job.id, e);
        const wait = Math.min(60 * 60000, 60000 * 2 ** Math.min(job.tries, 6)); // 1, 2, 4 … 60 хв
        await env.DB.prepare('UPDATE outbox SET tries = tries + 1, next_at = ?, error = ? WHERE id = ?')
          .bind(Date.now() + wait, String(e.message || e).slice(0, 300), job.id).run();
      }
    }
  } finally {
    await release(env, ministryId);
  }
}

const postpone = (env, ids, error, ms) => env.DB.prepare(`UPDATE outbox SET next_at = ?, error = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
  .bind(Date.now() + ms, error, ...ids).run();

/** Кеш аркушів таблиці звіту на час однієї обробки. */
class SheetCtx {
  constructor(env, id) { this.env = env; this.id = id; this.meta = null; this.blocks = {}; }
  async sheetId(name) {
    if (!this.meta) {
      const m = await sheetsGet(this.env, this.id, 'fields=' + encodeURIComponent('sheets(properties(sheetId,title))'));
      this.meta = Object.fromEntries((m.sheets || []).map(s => [s.properties.title, s.properties.sheetId]));
    }
    if (!(name in this.meta)) throw new Error(`У звіті немає аркуша «${name}»`);
    return this.meta[name];
  }
  /** Рядки даних аркуша місяця (A–K від 8-го до «Total Expenses»). */
  async block(name, fresh) {
    if (!this.blocks[name] || fresh) {
      const r = await sheetsValues(this.env, this.id, [`'${name}'!A${FIRST_ROW}:K${MAX_ROW}`]);
      const vals = ((r.valueRanges || [])[0] || {}).values || [];
      const total = vals.findIndex(v => TOTAL_RE.test(String((v || [])[0] || '')));
      this.blocks[name] = { rows: total < 0 ? vals : vals.slice(0, total), total: total < 0 ? FIRST_ROW + vals.length : FIRST_ROW + total };
    }
    return this.blocks[name];
  }
}

const serial = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5 + 25569;
const str = v => ({ userEnteredValue: { stringValue: String(v == null ? '' : v) } });
const num = v => ({ userEnteredValue: { numberValue: v } });
const empty = () => ({});
const label = (s, by, at) => (by ? `${s} ${by}, ${new Date(at).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' })}` : '');

/** Примітка до дати — як у старому застосунку: хто й коли подав, частина чека, валюта, перевищення, фото, історія змін. */
function noteFor(o, urls) {
  if (o.source === 'import') return o.note; // перенесений зі старої таблиці рядок — примітка як була
  const orig = o.orig ? JSON.parse(o.orig) : null;
  return [
    `${o.type === 'advance' ? 'Аванс отримав(ла)' : 'Подав(ла)'}: ${o.by_email || '—'}`, stamp(o.created_at),
    o.part_note,
    orig ? `Оригінал: ${orig.amount} ${orig.currency} × ${orig.rate} (курс НБУ на ${o.date.split('-').reverse().join('.')})` : '',
    o.over && o.over_reason ? `Перевищення бюджету: ${o.over_reason}` : '',
  ].concat(urls.length > 1 ? ['Фото:'].concat(urls) : []).concat(o.note ? [o.note] : []).filter(Boolean).join('\n');
}

function rowCells(o, urls) {
  if (o.deleted_at) return Array.from({ length: 11 }, empty);
  const adv = o.type === 'advance';
  const receipt = !adv && o.has_receipt
    ? (urls.length ? { userEnteredValue: { stringValue: o.receipt_text || 'Так' }, textFormatRuns: [{ startIndex: 0, format: { link: { uri: urls[0] } } }] } : str(o.receipt_text || 'Так'))
    : adv ? empty() : str('Ні');
  return [
    Object.assign(num(serial(o.date)), { note: noteFor(o, urls) }),
    adv ? num(o.amount) : empty(),
    adv ? empty() : num(o.amount),
    adv ? empty() : str(o.category),
    str(adv ? (o.description ? `Аванс: ${o.description}` : 'Аванс') : o.description),
    adv ? empty() : str(o.vendor),
    receipt,
    adv || o.has_receipt ? empty() : str(o.no_receipt_reason),
    str(label('✓', o.checked_by, o.checked_at)),
    str(label('₴', o.reimbursed_by, o.reimbursed_at)),
    str(o.id),
  ];
}

/** Приводить рядок операції в таблиці до стану в D1 (створює, оновлює або очищає). */
async function syncOp(env, sheet, id) {
  const o = await env.DB.prepare('SELECT * FROM ops WHERE id = ?').bind(id).first();
  if (!o) return;
  const { results: rec } = await env.DB.prepare('SELECT file_id FROM op_receipts WHERE op_id = ? ORDER BY pos').bind(id).all();
  const urls = rec.map(r => receiptUrl(r.file_id));
  const name = monthName(o.date), sid = await sheet.sheetId(name);
  let blk = await sheet.block(name);
  let idx = blk.rows.findIndex(v => String((v || [])[10] || '').trim() === o.id);
  if (idx < 0 && o.deleted_at) return; // і так немає в таблиці
  const requests = [];
  let row;
  if (idx >= 0) row = FIRST_ROW + idx;
  else {
    idx = blk.rows.findIndex(v => [0, 1, 2].every(i => v == null || v[i] === '' || v[i] == null));
    if (idx < 0 && blk.rows.length < blk.total - FIRST_ROW) idx = blk.rows.length; // порожні рядки в кінці не повертаються API
    if (idx >= 0) row = FIRST_ROW + idx;
    else {
      // Місця немає — вставляємо рядок усередину діапазону даних: формули SUM/SUMIF розтягуються самі.
      row = blk.total;
      requests.push({ insertDimension: { range: { sheetId: sid, dimension: 'ROWS', startIndex: row - 2, endIndex: row - 1 }, inheritFromBefore: true } });
      for (const pasteType of ['PASTE_FORMAT', 'PASTE_DATA_VALIDATION']) {
        requests.push({ copyPaste: { pasteType, source: { sheetId: sid, startRowIndex: row - 3, endRowIndex: row - 2 },
          destination: { sheetId: sid, startRowIndex: row - 2, endRowIndex: row - 1 } } });
      }
      row = row - 1;
    }
  }
  requests.push({ updateCells: {
    rows: [{ values: rowCells(o, urls) }],
    fields: 'userEnteredValue,note,textFormatRuns',
    start: { sheetId: sid, rowIndex: row - 1, columnIndex: 0 },
  } });
  if (!o.deleted_at) { // дата — як дата (лише колонка A, щоб не чіпати формат сум)
    requests.push({ repeatCell: { range: { sheetId: sid, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 0, endColumnIndex: 1 },
      cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd.mm.yyyy' } } }, fields: 'userEnteredFormat.numberFormat' } });
  }
  await sheetsBatchUpdate(env, sheet.id, requests);
  await sheet.block(name, true);
  await env.DB.prepare('UPDATE ops SET sheet_month = ?, sheet_row = ? WHERE id = ?').bind(o.deleted_at ? null : name, o.deleted_at ? null : row, o.id).run();
}

/** Фото «наперед»: звична назва й перенесення з «_Завантаження» в папку місяця. */
async function moveReceipt(env, ministry, p) {
  const f = await fileMeta(env, p.fileId, 'id,parents,trashed');
  if (!f || f.trashed) return;
  const monthId = await monthFolderId(env, ministry, p.date);
  const from = (f.parents || []).filter(x => x !== monthId);
  await patchFile(env, p.fileId, { name: p.name, description: p.description, appProperties: { pre: null, used: '1' } },
    `&addParents=${monthId}` + (from.length ? `&removeParents=${from.join(',')}` : ''));
}
