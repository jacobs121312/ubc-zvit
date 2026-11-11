// Перенесення зі старої системи і синхронізація таблиці служінь.
//  • syncSettings — таблиця служінь (назва, відповідальний, папка, пошти) → ministries / ministry_emails. Cron, раз на 5 хв.
//  • importMinistry — «Звіт 26-27» служіння → categories, opening_balance, ops (+ посилання на чеки). Повторний запуск
//    безпечний: ключ — ID операції з колонки K; рядкам без ID він присвоюється й дописується в K.
//  • reconcile — звірка сум і кількостей таблиця ↔ D1.
import { MONTHS, FY_ORDER, round2, splitEmails } from './util.js';
import { sheetsGet, sheetsValues, sheetsBatchUpdate, listChildren, copyAsSheet } from './google.js';

const FIRST_ROW = 8, MAX_ROW = 600, REPORT_NAME = 'Звіт 26-27', XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TOTAL_RE = /^\s*Total Expenses/i;

export function parseFolderId(link) {
  const s = String(link || '').trim();
  const m = s.match(/folders\/([A-Za-z0-9_-]+)/) || s.match(/[?&]id=([A-Za-z0-9_-]+)/) || s.match(/^([A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : '';
}

/** Таблиця служінь → D1. Служіння, яких більше немає в таблиці, вимикаються (дані лишаються). */
export async function syncSettings(env) {
  const r = await sheetsValues(env, env.SETTINGS_SPREADSHEET_ID, ['A1:Z500'], 'valueRenderOption=FORMATTED_VALUE');
  const rows = ((r.valueRanges || [])[0] || {}).values || [];
  if (!rows.length) return { count: 0 };
  const head = rows[0].map(h => String(h).trim().toLowerCase());
  const col = re => head.findIndex(h => re.test(h));
  const iName = col(/^(назва|служіння)/), iFolder = col(/папк/), iMails = col(/пошт|мейл|e-?mail/), iResp = col(/відповідальн/);
  if (iName < 0 || iFolder < 0 || iMails < 0) throw new Error('У таблиці служінь потрібні колонки «Назва», «Посилання на папку» і «Пошти».');
  const seen = new Set(), st = [env.DB.prepare('DELETE FROM ministry_emails'), env.DB.prepare('UPDATE ministries SET active = 0')];
  rows.slice(1).forEach((row, i) => {
    const id = parseFolderId(row[iFolder]), name = String(row[iName] || '').trim();
    if (!id || !name || seen.has(id)) return;
    seen.add(id);
    const emails = String(row[iMails] || '').trim();
    st.push(env.DB.prepare(`INSERT INTO ministries (id, name, responsible, emails, sort, active) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, responsible = excluded.responsible, emails = excluded.emails,
      sort = excluded.sort, active = 1`).bind(id, name, iResp >= 0 ? String(row[iResp] || '').trim() : '', emails, i));
    for (const e of new Set(splitEmails(emails))) st.push(env.DB.prepare('INSERT OR IGNORE INTO ministry_emails (ministry_id, email) VALUES (?, ?)').bind(id, e));
  });
  await env.DB.batch(st);
  return { count: seen.size };
}

/** «Звіт 26-27» служіння: відомий, знайдений у папці або (create) створений з «Звіт.xlsx». */
export async function reportSheetId(env, ministry, create) {
  if (ministry.report_sheet_id) return ministry.report_sheet_id;
  const files = await listChildren(env, ministry.id);
  let f = files.find(x => x.name === REPORT_NAME && x.mimeType === 'application/vnd.google-apps.spreadsheet');
  if (!f && create) {
    const xlsx = files.find(x => x.name === 'Звіт.xlsx') || files.find(x => x.mimeType === XLSX);
    if (!xlsx) throw new Error(`У папці «${ministry.name}» не знайдено «Звіт.xlsx».`);
    f = await copyAsSheet(env, xlsx.id, ministry.id, REPORT_NAME);
  }
  const receipts = files.find(x => x.mimeType === 'application/vnd.google-apps.folder' && /^Чеки/i.test(x.name));
  if (!f) return null;
  await env.DB.prepare('UPDATE ministries SET report_sheet_id = ?, receipts_folder_id = COALESCE(receipts_folder_id, ?) WHERE id = ?')
    .bind(f.id, receipts ? receipts.id : null, ministry.id).run();
  ministry.report_sheet_id = f.id;
  return f.id;
}

const isoFromSerial = v => (typeof v === 'number' && v > 20000 ? new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10) : '');
const num = v => (typeof v === 'number' ? v : Number(String(v || '').replace(/\s/g, '').replace(',', '.')) || 0);

/** «Подав(ла): пошта» і «дд.мм.рррр гг:хх» з примітки старого застосунку. */
function noteMeta(note) {
  const lines = String(note || '').split('\n');
  const by = ((lines[0] || '').match(/(?:Подав\(ла\)|Аванс отримав\(ла\)):\s*(\S+)/) || [])[1] || '';
  const t = (lines[1] || '').match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})/);
  // час у примітці — київський; переводимо в UTC з поправкою на зимовий/літній час
  const at = t ? Date.UTC(+t[3], +t[2] - 1, +t[1], +t[4], +t[5]) - kyivOffsetMs(Date.UTC(+t[3], +t[2] - 1, +t[1])) : 0;
  const over = (String(note || '').match(/Перевищення бюджету:\s*(.*)/) || [])[1];
  return { by: by.toLowerCase(), at, over: over != null, overReason: over ? over.trim() : '' };
}
function kyivOffsetMs(utcMs) {
  const d = new Date(utcMs), s = d.toLocaleString('en-US', { timeZone: 'Europe/Kyiv', hour12: false });
  return new Date(s + ' UTC') - new Date(d.toLocaleString('en-US', { timeZone: 'UTC', hour12: false }) + ' UTC');
}
/** «✓ пошта, дд.мм.рррр» → {by, at}. */
function markMeta(text) {
  const s = String(text || '').trim();
  if (!s) return { by: null, at: null };
  const m = s.match(/^[✓₴]\s*(\S+@\S+?),\s*(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? { by: m[1].toLowerCase(), at: Date.UTC(+m[4], +m[3] - 1, +m[2], 12) } : { by: s.slice(0, 80), at: 0 };
}

/** Рядки місяців з посиланнями (G) і примітками (A) — двома запитами, як monthBlocks_ у старому скрипті. */
async function readMonths(env, sheetId) {
  const names = FY_ORDER.map(i => MONTHS[i]);
  const vr = await sheetsValues(env, sheetId, names.map(n => `'${n}'!A${FIRST_ROW}:K${MAX_ROW}`));
  const fields = 'sheets(properties(title,sheetId),data(startColumn,rowData(values(note,hyperlink,textFormatRuns(format(link(uri)))))))';
  const meta = await sheetsGet(env, sheetId, 'fields=' + encodeURIComponent(fields) + '&' +
    names.flatMap(n => [`ranges=${encodeURIComponent(`'${n}'!A${FIRST_ROW}:A${MAX_ROW}`)}`, `ranges=${encodeURIComponent(`'${n}'!G${FIRST_ROW}:G${MAX_ROW}`)}`]).join('&'));
  const links = {}, notes = {}, gids = {};
  for (const sh of meta.sheets || []) {
    gids[sh.properties.title] = sh.properties.sheetId;
    for (const d of sh.data || []) {
      const cells = (d.rowData || []).map(rd => (rd && rd.values && rd.values[0]) || null);
      if (d.startColumn === 6) {
        links[sh.properties.title] = cells.map(c => (c ? c.hyperlink || ((c.textFormatRuns || []).find(t => t.format && t.format.link && t.format.link.uri) || { format: { link: {} } }).format.link.uri || '' : ''));
      } else notes[sh.properties.title] = cells.map(c => (c && c.note) || '');
    }
  }
  return names.map((name, k) => {
    let vals = ((vr.valueRanges || [])[k] || {}).values || [];
    const cut = vals.findIndex(v => TOTAL_RE.test(String((v || [])[0] || '')));
    if (cut >= 0) vals = vals.slice(0, cut);
    return { name, gid: gids[name], rows: vals.map((v, i) => ({ row: FIRST_ROW + i, v: v || [], link: (links[name] || [])[i] || '', note: (notes[name] || [])[i] || '' })) };
  });
}

/** Категорії з аркуша «БЮДЖЕТ…» (з 3-го рядка до «ВСЬОГО»). */
async function readCategories(env, sheetId) {
  const m = await sheetsGet(env, sheetId, 'fields=' + encodeURIComponent('sheets(properties(title))'));
  const budget = (m.sheets || []).map(s => s.properties.title).find(t => t.toUpperCase().startsWith('БЮДЖЕТ'));
  if (!budget) throw new Error('У звіті не знайдено аркуша бюджету.');
  const vals = ((((await sheetsValues(env, sheetId, [`'${budget}'!A3:D200`])).valueRanges || [])[0] || {}).values) || [];
  const out = [];
  for (const [name, plan] of vals) {
    const label = String(name || '');
    if (!label.trim() || label.trim().toUpperCase().startsWith('ВСЬОГО')) break;
    out.push({ name: label, plan: num(plan) });
  }
  return out;
}

/** «Початковий залишок» жовтня (рядок «Advance beginning…», колонка C). */
async function readOpening(env, sheetId) {
  const vals = ((((await sheetsValues(env, sheetId, [`'Жовтень'!A1:C7`])).valueRanges || [])[0] || {}).values) || [];
  const row = vals.find(v => /Advance beginning|Початковий залишок/i.test(String((v || [])[0] || '')));
  return row ? num(row[2]) : 0;
}

/** Переносить одне служіння. Повертає звірку. Рядки, змінені вже в новій системі (source=app), не перезаписуються. */
export async function importMinistry(env, ministryId, { create = false } = {}) {
  const ministry = await env.DB.prepare('SELECT * FROM ministries WHERE id = ?').bind(ministryId).first();
  if (!ministry) throw new Error('Служіння не знайдено.');
  const sheetId = await reportSheetId(env, ministry, create);
  if (!sheetId) return { id: ministryId, name: ministry.name, status: 'no-report' };
  const [cats, opening, months] = await Promise.all([readCategories(env, sheetId), readOpening(env, sheetId), readMonths(env, sheetId)]);
  const st = [env.DB.prepare('DELETE FROM categories WHERE ministry_id = ?').bind(ministryId),
    env.DB.prepare('UPDATE ministries SET opening_balance = ? WHERE id = ?').bind(opening, ministryId)];
  cats.forEach((c, i) => st.push(env.DB.prepare('INSERT INTO categories (ministry_id, name, plan, sort) VALUES (?, ?, ?, ?)').bind(ministryId, c.name, c.plan, i)));
  const writeIds = [], sheetTotals = { income: 0, expense: 0, count: 0 }, now = Date.now();
  for (const b of months) {
    for (const r of b.rows) {
      const [date, inc, exp, cat, desc, vendor, receipt, reason, checked, reimb, id0] = r.v;
      const income = num(inc), expense = num(exp);
      if (!income && !expense) continue;
      const iso = isoFromSerial(date) || `${(MONTHS.indexOf(b.name) >= 9 ? Number(env.FISCAL_YEAR_START || 2026) : Number(env.FISCAL_YEAR_START || 2026) + 1)}-${String(MONTHS.indexOf(b.name) + 1).padStart(2, '0')}-01`;
      sheetTotals.income += income; sheetTotals.expense += expense; sheetTotals.count++;
      let id = String(id0 || '').trim();
      if (!id) { id = crypto.randomUUID(); writeIds.push({ gid: b.gid, row: r.row, id }); }
      const meta = noteMeta(r.note), chk = markMeta(checked), rb = markMeta(reimb);
      const adv = income > 0 && !expense;
      const file = (String(r.link || '').match(/\/d\/([\w-]{20,})/) || [])[1] || (String(r.link || '').match(/[?&]id=([\w-]{20,})/) || [])[1];
      const extra = [...String(r.note || '').matchAll(/https:\/\/drive\.google\.com\/file\/d\/([\w-]{20,})/g)].map(m => m[1]);
      const files = [...new Set([file, ...extra].filter(Boolean))];
      st.push(env.DB.prepare(`INSERT INTO ops (id, ministry_id, type, date, amount, category, description, vendor, has_receipt, receipt_text,
          no_receipt_reason, over, over_reason, by_email, created_at, checked_by, checked_at, reimbursed_by, reimbursed_at, note, sheet_month, sheet_row, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import')
        ON CONFLICT (id) DO UPDATE SET type = excluded.type, date = excluded.date, amount = excluded.amount, category = excluded.category,
          description = excluded.description, vendor = excluded.vendor, has_receipt = excluded.has_receipt, receipt_text = excluded.receipt_text,
          no_receipt_reason = excluded.no_receipt_reason, over = excluded.over, over_reason = excluded.over_reason, by_email = excluded.by_email,
          created_at = excluded.created_at, checked_by = excluded.checked_by, checked_at = excluded.checked_at,
          reimbursed_by = excluded.reimbursed_by, reimbursed_at = excluded.reimbursed_at, note = excluded.note,
          sheet_month = excluded.sheet_month, sheet_row = excluded.sheet_row
        WHERE ops.source = 'import'`).bind(id, ministryId, adv ? 'advance' : 'expense', iso, adv ? income : expense,
        /^\d/.test(String(cat || '')) ? String(cat).trim() : '',
        adv ? String(desc || '').replace(/^Аванс:?\s*/, '').trim() : String(desc || '').trim(), String(vendor || '').trim(),
        /^\s*(так|yes)/i.test(String(receipt || '')) || files.length ? 1 : 0, String(receipt || '').trim(), String(reason || '').trim(),
        meta.over ? 1 : 0, meta.overReason, meta.by, meta.at, chk.by, chk.at, rb.by, rb.at, r.note, b.name, r.row));
      st.push(env.DB.prepare('DELETE FROM op_receipts WHERE op_id = ? AND EXISTS (SELECT 1 FROM ops WHERE id = ? AND source = \'import\')').bind(id, id));
      files.forEach((f, pos) => st.push(env.DB.prepare(`INSERT OR IGNORE INTO op_receipts (op_id, file_id, pos)
        SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM ops WHERE id = ? AND source = 'import')`).bind(id, f, pos, id)));
    }
  }
  await env.DB.batch(st);
  if (writeIds.length) { // ID для рядків без нього — у колонку K (решту рядка не чіпаємо)
    await sheetsBatchUpdate(env, sheetId, writeIds.map(w => ({ updateCells: { rows: [{ values: [{ userEnteredValue: { stringValue: w.id } }] }],
      fields: 'userEnteredValue', start: { sheetId: w.gid, rowIndex: w.row - 1, columnIndex: 10 } } })));
  }
  return Object.assign({ id: ministryId, name: ministry.name, status: 'ok', categories: cats.length, opening,
    sheet: { income: round2(sheetTotals.income), expense: round2(sheetTotals.expense), count: sheetTotals.count }, idsWritten: writeIds.length },
  { db: await reconcileDb(env, ministryId) }, { time: Date.now() - now });
}

async function reconcileDb(env, ministryId) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN type = 'advance' THEN amount END), 0) AS income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense
    FROM ops WHERE ministry_id = ? AND deleted_at IS NULL`).bind(ministryId).first();
  return { income: round2(r.income), expense: round2(r.expense), count: r.count };
}

/** Імпорт усіх служінь порціями (з cron або адмінки). → звіт звірки по кожному. */
export async function importAll(env, { budgetMs = 20000 } = {}) {
  const t0 = Date.now();
  const { results } = await env.DB.prepare('SELECT id FROM ministries WHERE active = 1 ORDER BY sort').all();
  const report = [];
  for (const m of results) {
    if (Date.now() - t0 > budgetMs) { report.push({ id: m.id, status: 'pending' }); continue; }
    try { report.push(await importMinistry(env, m.id)); } catch (e) { report.push({ id: m.id, status: 'error', error: String(e.message || e).slice(0, 200) }); }
  }
  return report;
}

/** Порція черги перенесення (cron): кілька служінь за запуск, звірка — у import_jobs.report. */
export async function processImportJobs(env, batch = 4) {
  const { results } = await env.DB.prepare("SELECT ministry_id FROM import_jobs WHERE status = 'pending' LIMIT ?").bind(batch).all();
  for (const j of results) {
    let status = 'done', report;
    try { report = await importMinistry(env, j.ministry_id); if (report.status !== 'ok') status = report.status; }
    catch (e) { status = 'error'; report = { error: String(e.message || e).slice(0, 300) }; }
    await env.DB.prepare('UPDATE import_jobs SET status = ?, report = ?, at = ? WHERE ministry_id = ?')
      .bind(status, JSON.stringify(report), Date.now(), j.ministry_id).run();
  }
}
