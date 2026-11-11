// Дії на запис: подання витрат і авансів, фото чеків, редагування, видалення, позначки адміна.
// Усе пишеться в D1 одразу (атомарно, batch); дзеркало в Google-таблиці — після відповіді (outbox).
import { LIMITS, UserError, validateCard, checkReceiptType, receiptBaseName, receiptExt, receiptUrl, monthName, round2, stamp, dmy } from './util.js';
import { requireMinistry, ministryById, categoriesWithSpent } from './data.js';
import { requireAdmin, nbuRate } from './read.js';
import { fileMeta, patchFile, monthFolderId, preUploadFolderId, openUploadSessions, uploadInline } from './google.js';
import { enqueue, kick } from './mirror.js';

const BAD_RECEIPT = 'Фото чека не знайдено серед завантажених. Додайте фото ще раз.';
const receiptProps = (ministry, email) => ({ zm: ministry.id, zb: email });
const opKey = (ministry, opId) => (/^[\w-]{8,64}$/.test(String(opId || '')) ? `${ministry.id}:${opId}` : '');

/** Сума у валюті → гривні за курсом НБУ на дату витрати; оригінал зберігається в orig. */
async function convertCurrency(item) {
  if (!item.currency || item.currency === 'UAH') return item;
  const rate = await nbuRate(item.currency, item.date);
  const conv = n => round2(n * rate);
  item.orig = { amount: item.amount, currency: item.currency, rate };
  item.amount = conv(item.amount);
  if (item.splits && item.splits.length) {
    item.splits.forEach(pt => { pt.amount = conv(pt.amount); });
    const last = item.splits[item.splits.length - 1];
    last.amount = round2(last.amount + item.amount - item.splits.reduce((a, pt) => a + pt.amount, 0));
  }
  item.currency = 'UAH';
  if (item.amount > LIMITS.MAX_AMOUNT) throw new UserError(`Сума завелика: понад ${LIMITS.MAX_AMOUNT} грн за одну операцію.`);
  return item;
}

/** Ліміт фото на пошту за 6 годин (атомарно в D1). */
async function chargeUploadQuota(env, email, files) {
  const n = files.length, bytes = files.reduce((a, f) => a + (Number(f.size) || 0), 0), now = Date.now();
  const row = await env.DB.prepare(`INSERT INTO upload_quota (email, since, n, bytes) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT (email) DO UPDATE SET
      n = CASE WHEN since < ?2 - ?5 THEN excluded.n ELSE n + excluded.n END,
      bytes = CASE WHEN since < ?2 - ?5 THEN excluded.bytes ELSE bytes + excluded.bytes END,
      since = CASE WHEN since < ?2 - ?5 THEN ?2 ELSE since END
    RETURNING n, bytes`).bind(email, now, n, bytes, LIMITS.UPLOAD_LIMIT.windowMs).first();
  if (row.n > LIMITS.UPLOAD_LIMIT.files || row.bytes > LIMITS.UPLOAD_LIMIT.bytes) {
    throw new UserError('Забагато фото за короткий час. Спробуйте через кілька годин або зверніться до адміністратора.');
  }
}

/** Відкриває сесії прямого завантаження фото для карток (як startUploads у старому API). */
export async function startUploads(ctx, ministryId, metas) {
  const { env, email } = ctx;
  const ministry = await requireMinistry(env, email, ministryId);
  if (!Array.isArray(metas) || !metas.length) throw new UserError('Немає фото для завантаження.');
  if (metas.length > LIMITS.MAX_ITEMS) throw new UserError(`Не більше ${LIMITS.MAX_ITEMS} карток за один раз.`);
  const list = metas.map(m => {
    const item = validateCard(env, Object.assign({}, m, { type: 'expense', hasReceipt: true }), null);
    const files = Array.isArray(m.files) ? m.files : [];
    if (files.length > LIMITS.MAX_FILES_PER_ITEM) throw new UserError(`Не більше ${LIMITS.MAX_FILES_PER_ITEM} фото на одну витрату.`);
    files.forEach(checkReceiptType);
    return { item, files };
  });
  await chargeUploadQuota(env, email, list.flatMap(x => x.files));
  const specs = [], map = [];
  const out = [];
  for (const [mi, { item, files }] of list.entries()) {
    const parent = await monthFolderId(env, ministry, item.date);
    const base = receiptBaseName(item);
    out.push({ uploads: files.map((f, fi) => {
      map.push([mi, fi]);
      specs.push({ f, parent, name: base + (files.length > 1 ? `_${fi + 1}` : '') + receiptExt(f.name),
        description: `${item.description}\nПодав(ла): ${email}`, props: receiptProps(ministry, email) });
      return { url: '' };
    }) });
  }
  (await openUploadSessions(env, specs, ctx.origin)).forEach((url, k) => { const [mi, fi] = map[k]; out[mi].uploads[fi].url = url; });
  return out;
}

/** Завантаження наперед: фото йде в «_Завантаження», поки лідер заповнює картку. */
export async function startPreUploads(ctx, ministryId, files) {
  const { env, email } = ctx;
  const ministry = await requireMinistry(env, email, ministryId);
  if (!Array.isArray(files) || !files.length) throw new UserError('Немає фото для завантаження.');
  if (files.length > LIMITS.MAX_FILES_PER_ITEM) throw new UserError(`Не більше ${LIMITS.MAX_FILES_PER_ITEM} фото за раз.`);
  files.forEach(checkReceiptType);
  await chargeUploadQuota(env, email, files);
  const parent = await preUploadFolderId(env, ministry);
  const st = stamp().replace(/[.: ]/g, '-');
  const urls = await openUploadSessions(env, files.map((f, i) => ({
    f, parent, name: `чек_${st}_${i + 1}${receiptExt(f.name)}`,
    description: `Ще не надіслано · ${email}`, props: Object.assign({ pre: '1' }, receiptProps(ministry, email)),
  })), ctx.origin);
  return urls.map(url => ({ url }));
}

/**
 * Чеки, які браузер завантажив напряму, приймаються лише якщо їх відкрив цей сервер для цього служіння й цієї
 * пошти (appProperties zm/zb) і вони ще не використані. «Зайняття» — атомарний INSERT у receipts.
 */
async function claimUploads(env, urls, ministry, email, item) {
  if (!urls.length) return [];
  const ids = urls.map(u => {
    const m = String(u || '').match(/^https:\/\/drive\.google\.com\/file\/d\/([\w-]{20,})(\/|$)/);
    if (!m) throw new UserError(BAD_RECEIPT);
    return m[1];
  });
  if (new Set(ids).size !== ids.length) throw new UserError('Одне й те саме фото додано двічі.');
  const metas = await Promise.all(ids.map(id => fileMeta(env, id)));
  metas.forEach(f => {
    const p = (f && f.appProperties) || {};
    if (!f || f.trashed || p.zm !== ministry.id || p.zb !== email) throw new UserError(BAD_RECEIPT);
    checkReceiptType(f); // фактичний тип і розмір — з Диска
  });
  const now = Date.now();
  const claimed = [];
  try {
    for (const f of metas) {
      const r = await env.DB.prepare(`INSERT INTO receipts (file_id, ministry_id, by_email, name, status, created_at)
        VALUES (?, ?, ?, ?, 'used', ?) ON CONFLICT (file_id) DO NOTHING`).bind(f.id, ministry.id, email, f.name, now).run();
      if (!r.meta.changes) throw new UserError('Це фото чека вже використано в іншій витраті.');
      claimed.push(f.id);
    }
  } catch (e) {
    await releaseReceipts(env, claimed);
    throw e;
  }
  // Фото «наперед» отримують звичну назву й переїжджають у папку місяця — фоном (черга з повторами),
  // щоб «Надіслати» не чекало на Диск. Посилання на фото від перенесення не змінюється.
  const pre = metas.filter(f => (f.appProperties || {}).pre === '1');
  if (pre.length) {
    const base = receiptBaseName(item);
    await env.DB.batch(pre.map(f => enqueue(env, ministry.id, 'move_receipt', {
      fileId: f.id, date: item.date, description: `${item.description}\nПодав(ла): ${email}`,
      name: base + (metas.length > 1 ? `_${metas.indexOf(f) + 1}` : '') + receiptExt(f.name),
    })));
  }
  return ids;
}

const releaseReceipts = (env, ids) => (ids.length
  ? env.DB.prepare(`DELETE FROM receipts WHERE file_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run() : null);

/** Готує картку: валюта, фото (пряме завантаження або з самого запиту). Нічого не пише в ops. */
async function prepare(ctx, ministry, form) {
  const { env, email } = ctx;
  const item = await convertCurrency(validateCard(env, form, null));
  if (item.type === 'advance') return item;
  const files = item.hasReceipt && Array.isArray(form.files) ? form.files : [];
  const urls = item.hasReceipt && Array.isArray(form.receiptUrls) ? form.receiptUrls : [];
  if (files.length + urls.length > LIMITS.MAX_FILES_PER_ITEM) throw new UserError(`Не більше ${LIMITS.MAX_FILES_PER_ITEM} фото на одну витрату.`);
  files.forEach(f => checkReceiptType({ ...f, size: f.size != null ? f.size : String(f.base64 || '').length * 0.75 }));
  item.receiptIds = await claimUploads(env, urls, ministry, email, item);
  if (files.length) {
    try {
      const parent = await monthFolderId(env, ministry, item.date);
      const base = receiptBaseName(item);
      for (const [i, f] of files.entries()) {
        const bytes = Uint8Array.from(atob(String(f.base64 || '')), c => c.charCodeAt(0));
        if (bytes.length > 25 * 1024 * 1024) throw new UserError('Файл чека завеликий (понад 25 МБ).');
        const created = await uploadInline(env, { parent, name: base + (files.length > 1 ? `_${i + 1}` : '') + receiptExt(f.name),
          mimeType: f.mimeType, description: `${item.description}\nПодав(ла): ${email}`,
          props: Object.assign({ used: '1' }, receiptProps(ministry, email)), bytes });
        await env.DB.prepare(`INSERT INTO receipts (file_id, ministry_id, by_email, name, status, created_at) VALUES (?, ?, ?, ?, 'used', ?)`)
          .bind(created.id, ministry.id, email, f.name || '', Date.now()).run();
        item.receiptIds.push(created.id);
      }
    } catch (e) { await releaseReceipts(env, item.receiptIds); throw e; }
  }
  if (item.hasReceipt && !item.receiptIds.length) throw new UserError('Додайте фото чека.');
  return item;
}

/**
 * Подання витрат і авансів (до MAX_ITEMS карток). → {results:[{month,row,id,…} | {error}]} у порядку карток.
 * opId картки: повтор того самого подання (обрив зв'язку) повертає збережений результат, а не дубль.
 */
export async function submitExpenses(ctx, ministryId, forms) {
  const { env, email } = ctx;
  const ministry = await requireMinistry(env, email, ministryId);
  if (!Array.isArray(forms) || !forms.length) throw new UserError('Немає що надсилати.');
  if (forms.length > LIMITS.MAX_ITEMS) throw new UserError(`Не більше ${LIMITS.MAX_ITEMS} карток за один раз.`);
  const results = new Array(forms.length);
  const keys = forms.map(f => opKey(ministry, f && f.opId));
  const done = {};
  const known = keys.filter(Boolean);
  if (known.length) {
    const { results: rows } = await env.DB.prepare(`SELECT key, result FROM op_keys WHERE key IN (${known.map(() => '?').join(',')})`).bind(...known).all();
    rows.forEach(r => { done[r.key] = JSON.parse(r.result); });
  }
  let cats = await categoriesWithSpent(env, ministry.id);
  for (const [i, form] of forms.entries()) {
    if (keys[i] && done[keys[i]]) { results[i] = done[keys[i]]; continue; }
    let item;
    try { item = await prepare(ctx, ministry, form); } catch (e) { results[i] = { error: errText(e) }; continue; }
    try {
      results[i] = await writeOp(ctx, ministry, item, cats, keys[i]);
      cats = await categoriesWithSpent(env, ministry.id); // наступна картка бачить новий залишок
    } catch (e) {
      await releaseReceipts(env, item.receiptIds || []);
      results[i] = { error: errText(e) };
    }
  }
  kick(ctx, ministry.id);
  return { results };
}

const errText = e => (e instanceof UserError ? e.message : (console.error(e), 'Сталася помилка на сервері. Спробуйте ще раз за хвилину.'));

/** Записує одну підготовлену картку: аванс — один рядок, витрата — по рядку на частину розбитого чека. */
async function writeOp(ctx, ministry, item, cats, key) {
  const { env, email } = ctx;
  const now = Date.now(), base = crypto.randomUUID(), month = monthName(item.date);
  const orig = item.orig ? JSON.stringify(item.orig) : null;
  const st = [];
  let result;
  if (item.type === 'advance') {
    st.push(env.DB.prepare(`INSERT INTO ops (id, ministry_id, type, date, amount, orig, description, by_email, created_at)
      VALUES (?, ?, 'advance', ?, ?, ?, ?, ?, ?)`).bind(base, ministry.id, item.date, item.amount, orig, item.description, email, now));
    result = { month, row: 0, advance: true, id: base };
  } else {
    validateCard(ctx.env, Object.assign({}, item, { currency: 'UAH' }), cats.map(c => c.name)); // категорія — зі списку
    const parts = item.splits && item.splits.length ? item.splits : [{ category: item.category, amount: item.amount }];
    const left = Object.fromEntries(cats.map(c => [c.name, c.left]));
    const over = [];
    for (const pt of parts) { left[pt.category] = (left[pt.category] || 0) - pt.amount; if (left[pt.category] < -0.005) over.push(pt.category); }
    if (over.length && !item.overReason) {
      throw new UserError(`Сума перевищує залишок бюджету «${over[0].replace(/^\d+\s*/, '').trim()}». Поясніть, чому перевищено.`);
    }
    const ids = item.receiptIds || [];
    const receiptText = item.hasReceipt ? (ids.length > 1 ? `Так (${ids.length} фото)` : 'Так') : 'Ні';
    const opIds = parts.map((pt, k) => (parts.length > 1 ? `${base}-${k + 1}` : base));
    parts.forEach((pt, k) => {
      st.push(env.DB.prepare(`INSERT INTO ops (id, ministry_id, type, date, amount, orig, category, description, vendor, has_receipt,
          receipt_text, no_receipt_reason, over, over_reason, part_of, part_note, by_email, created_at)
        VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(opIds[k], ministry.id, item.date, pt.amount, orig,
        pt.category, item.description, item.vendor, item.hasReceipt ? 1 : 0, receiptText, item.noReceiptReason,
        over.length ? 1 : 0, over.length ? item.overReason : '', parts.length > 1 ? base : null,
        parts.length > 1 ? `Частина ${k + 1} з ${parts.length} одного чека на ${item.amount} грн` : '', email, now));
      ids.forEach((fid, pos) => st.push(env.DB.prepare('INSERT INTO op_receipts (op_id, file_id, pos) VALUES (?, ?, ?)').bind(opIds[k], fid, pos)));
    });
    result = { month, row: 0, rows: [], receiptUrls: ids.map(receiptUrl), id: base, ids: opIds };
    opIds.forEach(id => st.push(enqueue(env, ministry.id, 'upsert_op', { id })));
  }
  if (item.type === 'advance') st.push(enqueue(env, ministry.id, 'upsert_op', { id: base }));
  if (key) st.push(env.DB.prepare('INSERT OR REPLACE INTO op_keys (key, result, created_at) VALUES (?, ?, ?)').bind(key, JSON.stringify(result), now));
  await env.DB.batch(st);
  return result;
}

/**
 * Фото чека до наявної витрати, у якої чек позначено, але файлу немає (перенесені зі старої таблиці, «Потрібно звірити чек»).
 * Будь-хто зі служіння; фото — лише свої, завантажені наперед. Позначка «Потрібно звірити чек» з примітки знімається.
 */
export async function attachReceipts(ctx, ministryId, id, receiptUrls) {
  const { env, email } = ctx;
  const ministry = await requireMinistry(env, email, ministryId);
  const o = await loadOp(env, ministry, id);
  if (o.type !== 'expense') throw new UserError('Фото чека можна додати лише до витрати.');
  if ((await env.DB.prepare('SELECT 1 FROM op_receipts WHERE op_id = ? LIMIT 1').bind(o.id).first())) {
    throw new UserError('У цієї витрати вже є фото чека. Оновіть сторінку.');
  }
  const urls = Array.isArray(receiptUrls) ? receiptUrls : [];
  if (!urls.length) throw new UserError('Додайте фото чека.');
  if (urls.length > LIMITS.MAX_FILES_PER_ITEM) throw new UserError(`Не більше ${LIMITS.MAX_FILES_PER_ITEM} фото на одну витрату.`);
  const ids = await claimUploads(env, urls, ministry, email, o);
  const note = String(o.note || '').split('\n').filter(l => !/^Потрібно звірити чек/.test(l.trim())).join('\n');
  await env.DB.batch([
    ...ids.map((fid, i) => env.DB.prepare('INSERT OR IGNORE INTO op_receipts (op_id, file_id, pos) VALUES (?, ?, ?)').bind(o.id, fid, i)),
    env.DB.prepare(`UPDATE ops SET has_receipt = 1, receipt_text = CASE WHEN receipt_text IN ('', 'Ні') THEN 'Так' ELSE receipt_text END,
      no_receipt_reason = '', note = ? WHERE id = ?`).bind(note, o.id),
    logEntry(env, ministry.id, email, 'Чек додано', `${monthName(o.date)}: ${opSummary(o)}`),
    enqueue(env, ministry.id, 'upsert_op', { id: o.id }),
  ]);
  kick(ctx, ministry.id);
  return { receiptUrls: ids.map(receiptUrl) };
}

// ---------------- зміни й видалення ----------------

async function loadOp(env, ministry, id) {
  if (!/^[\w-]{1,80}$/.test(String(id || ''))) throw new UserError('Невідома операція.');
  const o = await env.DB.prepare('SELECT * FROM ops WHERE id = ? AND ministry_id = ? AND deleted_at IS NULL').bind(id, ministry.id).first();
  if (!o) throw new UserError('Операцію не знайдено — можливо, її вже змінили. Оновіть сторінку.');
  return o;
}

function requireEditable(o, email, noTimeLimit) {
  if (o.by_email !== email) throw new UserError('Змінювати можна лише власні записи.');
  if (o.checked_by || o.reimbursed_by) throw new UserError('Запис уже перевірено — щоб щось змінити, зверніться до адміністратора.');
  if (!noTimeLimit && !(Date.now() - o.created_at < LIMITS.EDIT_WINDOW_H * 3600e3)) {
    throw new UserError(`Змінити чи скасувати запис можна протягом ${LIMITS.EDIT_WINDOW_H} годин після подання.`);
  }
}

const opSummary = o => [dmy(o.date), `${o.amount} грн`, o.category, o.description, o.vendor].map(x => String(x || '').trim()).filter(Boolean).join(' · ');
const logEntry = (env, ministryId, email, action, details) =>
  env.DB.prepare('INSERT INTO changelog (ministry_id, at, email, action, details) VALUES (?, ?, ?, ?, ?)').bind(ministryId, Date.now(), email, action, details);

/** Лідер змінює свій запис: суму, дату (у межах місяця), категорію, опис, постачальника — протягом 24 год. */
export async function editOperation(ctx, ministryId, id, changes) {
  const { env, email } = ctx;
  const ministry = await requireMinistry(env, email, ministryId);
  if (!changes || typeof changes !== 'object') throw new UserError('Немає змін.');
  const o = await loadOp(env, ministry, id);
  requireEditable(o, email);
  const pick = (k, def) => (changes[k] === undefined || changes[k] === null ? def : changes[k]);
  const cats = await categoriesWithSpent(env, ministry.id);
  const advance = o.type === 'advance';
  const item = advance
    ? validateCard(env, { type: 'advance', date: pick('date', o.date), amount: pick('amount', o.amount), description: pick('description', o.description) }, null)
    : validateCard(env, { type: 'expense', date: pick('date', o.date), amount: pick('amount', o.amount), category: pick('category', o.category),
      description: pick('description', o.description), vendor: pick('vendor', o.vendor), hasReceipt: !!o.has_receipt,
      noReceiptReason: pick('noReceiptReason', o.no_receipt_reason), overReason: pick('overReason', '') }, cats.map(c => c.name));
  if (monthName(item.date) !== monthName(o.date) || item.date.slice(0, 4) !== o.date.slice(0, 4)) {
    throw new UserError('Дату можна змінити лише в межах того самого місяця. Щоб перенести запис — скасуйте його й подайте знову.');
  }
  let over = !!o.over, overReason = o.over_reason;
  if (!advance) {
    const c = cats.find(x => x.name === item.category);
    const avail = c.left + (item.category === o.category ? o.amount : 0);
    if (avail - item.amount < -0.005) {
      if (!item.overReason && !o.over) throw new UserError('Нова сума перевищує залишок бюджету категорії. Поясніть, чому перевищено.');
      over = true; overReason = item.overReason || overReason;
    }
  }
  const was = opSummary(o);
  const line = `Змінено: ${email}, ${stamp()}. Було: ${was}`;
  const n = { ...o, date: item.date, amount: item.amount, category: advance ? '' : item.category, description: item.description,
    vendor: advance ? '' : item.vendor };
  await env.DB.batch([
    env.DB.prepare(`UPDATE ops SET date = ?, amount = ?, category = ?, description = ?, vendor = ?, no_receipt_reason = ?, over = ?, over_reason = ?,
      note = CASE WHEN note = '' THEN ? ELSE note || char(10) || ? END WHERE id = ?`).bind(n.date, n.amount, n.category, n.description, n.vendor,
      advance ? '' : item.noReceiptReason, over ? 1 : 0, overReason, line, line, o.id),
    logEntry(env, ministry.id, email, 'Зміна', `${monthName(o.date)}. Було: ${was}. Стало: ${opSummary(n)}`),
    enqueue(env, ministry.id, 'upsert_op', { id: o.id }),
  ]);
  kick(ctx, ministry.id);
  return { ok: true };
}

/**
 * Видалення: рядок позначається видаленим (у дзеркалі очищається), фото чеків — у кошик Диска (30 днів).
 * У кошик ідуть лише фото, які завантажив сам сервер для цього служіння й на які не посилається інший запис.
 */
async function deleteOp(ctx, ministry, o, email, action) {
  const { env } = ctx;
  const { results: files } = await env.DB.prepare(`SELECT r.file_id FROM op_receipts r JOIN receipts c ON c.file_id = r.file_id
    WHERE r.op_id = ? AND c.ministry_id = ? AND NOT EXISTS (SELECT 1 FROM op_receipts x JOIN ops y ON y.id = x.op_id
      WHERE x.file_id = r.file_id AND x.op_id <> r.op_id AND y.deleted_at IS NULL)`).bind(o.id, ministry.id).all();
  const trashed = [];
  for (const f of files) {
    try { await patchFile(env, f.file_id, { trashed: true }); trashed.push(f.file_id); } catch (e) { console.error('trash', f.file_id, e); }
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE ops SET deleted_at = ?, deleted_by = ? WHERE id = ?').bind(Date.now(), email, o.id),
    logEntry(env, ministry.id, email, action, `${monthName(o.date)}: ${opSummary(o)}` + (o.by_email ? ` (подав(ла) ${o.by_email})` : '') +
      (trashed.length ? `. Фото чека в кошику Диска (відновлюються 30 днів): ${trashed.map(receiptUrl).join(' ')}` : '')),
    enqueue(env, ministry.id, 'delete_op', { id: o.id }),
  ]);
  kick(ctx, ministry.id);
  return { ok: true };
}

/** Лідер видаляє свій неперевірений запис (дубль чи помилка) — без обмеження в часі. */
export async function cancelOperation(ctx, ministryId, id) {
  const ministry = await requireMinistry(ctx.env, ctx.email, ministryId);
  const o = await loadOp(ctx.env, ministry, id);
  requireEditable(o, ctx.email, true);
  return deleteOp(ctx, ministry, o, ctx.email, 'Видалення');
}

/** Адмін видаляє будь-який запис, навіть перевірений; слід лишається в журналі. */
export async function adminDeleteOperation(ctx, folderId, id) {
  const email = requireAdmin(ctx);
  const ministry = await ministryById(ctx.env, folderId);
  return deleteOp(ctx, ministry, await loadOp(ctx.env, ministry, id), email, 'Видалення (адмін)');
}

/** Позначки адміна: «Перевірено» / «Відшкодовано». */
export async function adminSetStatus(ctx, folderId, id, kind, on) {
  const email = requireAdmin(ctx);
  if (kind !== 'checked' && kind !== 'reimbursed') throw new UserError('Невідомий статус.');
  const ministry = await ministryById(ctx.env, folderId);
  const o = await loadOp(ctx.env, ministry, id);
  const now = Date.now(), col = kind === 'checked' ? 'checked' : 'reimbursed', label = kind === 'checked' ? 'Перевірено' : 'Відшкодовано';
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE ops SET ${col}_by = ?, ${col}_at = ? WHERE id = ?`).bind(on ? email : null, on ? now : null, o.id),
    logEntry(ctx.env, ministry.id, email, on ? label : `Знято «${label}»`, `${monthName(o.date)}: ${opSummary(o)}`),
    enqueue(ctx.env, ministry.id, 'upsert_op', { id: o.id }),
  ]);
  kick(ctx, ministry.id);
  const fmt = (s, by, at) => (by ? `${s} ${by}, ${new Date(at).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' })}` : '');
  const n = { ...o, [`${col}_by`]: on ? email : null, [`${col}_at`]: on ? now : null };
  return { checked: fmt('✓', n.checked_by, n.checked_at), reimbursed: fmt('₴', n.reimbursed_by, n.reimbursed_at) };
}
