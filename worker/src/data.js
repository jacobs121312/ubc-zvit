// Читання з D1 у тих самих формах, що віддавав Apps Script (щоб сторінка не змінювалась).
import { MONTHS, FY_ORDER, LIMITS, UserError, fy, kyivDay, monthName, round2, receiptUrl } from './util.js';

/** Служіння, доступні пошті. */
export async function ministriesFor(env, email) {
  const { results } = await env.DB.prepare(`SELECT m.id, m.name FROM ministries m
    JOIN ministry_emails e ON e.ministry_id = m.id WHERE e.email = ? AND m.active = 1 ORDER BY m.sort, m.name`).bind(email).all();
  return results;
}

export async function requireMinistry(env, email, id) {
  const m = await env.DB.prepare(`SELECT m.* FROM ministries m JOIN ministry_emails e ON e.ministry_id = m.id
    WHERE e.email = ? AND m.id = ? AND m.active = 1`).bind(email, String(id || '')).first();
  if (!m) throw new UserError('Оберіть своє служіння.');
  return m;
}

export async function ministryById(env, id) {
  const m = await env.DB.prepare('SELECT * FROM ministries WHERE id = ? AND active = 1').bind(String(id || '')).first();
  if (!m) throw new UserError('Служіння не знайдено.');
  return m;
}

const label = (sign, by, at) => (by ? `${sign} ${by}, ${new Date(at).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' })}` : '');

/** Операція у формі старого API (opFromRow_). email — для позначок editable/deletable. */
export function opShape(o, receipts, email) {
  const chk = label('✓', o.checked_by, o.checked_at), rb = label('₴', o.reimbursed_by, o.reimbursed_at);
  const mine = !!email && o.by_email === email && !chk && !rb;
  return {
    id: o.id, month: monthName(o.date), row: o.sheet_row || 0,
    date: o.date,
    income: o.type === 'advance' ? o.amount : 0,
    expense: o.type === 'expense' ? o.amount : 0,
    category: /^\d/.test(o.category) ? o.category.trim() : '',
    description: o.type === 'advance' ? (o.description ? `Аванс: ${o.description}` : 'Аванс') : o.description,
    vendor: o.vendor,
    receiptText: o.receipt_text,
    receipt: receipts && receipts.length ? receiptUrl(receipts[0]) : '',
    noReceiptReason: o.no_receipt_reason,
    // Чек мав бути («Так» у таблиці), але фото не прив'язане — лідер може додати його пізніше.
    needsReceipt: o.type === 'expense' && !!o.has_receipt && !(receipts && receipts.length),
    checked: chk, reimbursed: rb,
    status: rb ? 'reimbursed' : chk ? 'checked' : 'submitted',
    by: o.by_email, over: !!o.over,
    deletable: mine,
    editable: mine && Date.now() - o.created_at < LIMITS.EDIT_WINDOW_H * 3600e3,
  };
}

async function loadOps(env, ministryId) {
  const [ops, rec] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM ops WHERE ministry_id = ? AND deleted_at IS NULL ORDER BY date DESC, created_at DESC').bind(ministryId),
    env.DB.prepare(`SELECT r.op_id, r.file_id FROM op_receipts r JOIN ops o ON o.id = r.op_id
      WHERE o.ministry_id = ? AND o.deleted_at IS NULL ORDER BY r.op_id, r.pos`).bind(ministryId),
  ]);
  const byOp = {};
  for (const r of rec.results) (byOp[r.op_id] = byOp[r.op_id] || []).push(r.file_id);
  return { ops: ops.results, byOp };
}

/** Категорії із залишками (як аркуш «БЮДЖЕТ»): витрачено = сума витрат категорії за рік. */
export async function categoriesWithSpent(env, ministryId) {
  const { results } = await env.DB.prepare(`SELECT c.name, c.plan,
      COALESCE((SELECT SUM(amount) FROM ops o WHERE o.ministry_id = c.ministry_id AND o.category = c.name
        AND o.type = 'expense' AND o.deleted_at IS NULL), 0) AS spent
    FROM categories c WHERE c.ministry_id = ? ORDER BY c.sort`).bind(ministryId).all();
  return results.map(c => ({ name: c.name, plan: c.plan, spent: round2(c.spent), left: round2(c.plan - c.spent) }));
}

/** «Баланс на кінець» поточного місяця фін. року: початковий залишок + аванси − витрати до кінця місяця. */
function balanceOf(env, ministry, ops) {
  const today = kyivDay(), min = `${fy(env)}-10-01`, max = `${fy(env) + 1}-09-30`;
  const cur = today < min ? min : today > max ? max : today;
  const end = cur.slice(0, 7) + '-31';
  let amount = ministry.opening_balance || 0;
  for (const o of ops) if (o.date <= end) amount += o.type === 'advance' ? o.amount : -o.amount;
  return { amount: round2(amount), month: monthName(cur) };
}

function monthsOf(ops) {
  const acc = {};
  for (const o of ops) {
    const m = monthName(o.date), a = acc[m] = acc[m] || { income: 0, expense: 0 };
    if (o.type === 'advance') a.income += o.amount; else a.expense += o.amount;
  }
  return FY_ORDER.map(i => MONTHS[i]).map(name => ({ name, income: round2((acc[name] || {}).income || 0), expense: round2((acc[name] || {}).expense || 0) }));
}

/** Усе, що показує форма лідера: категорії, баланс, місяці, операції року. */
export async function snapshot(env, ministry, email) {
  const [{ ops, byOp }, categories] = await Promise.all([loadOps(env, ministry.id), categoriesWithSpent(env, ministry.id)]);
  return { categories, balance: balanceOf(env, ministry, ops), months: monthsOf(ops), ops: ops.map(o => opShape(o, byOp[o.id], email)) };
}

export function opsStats(ops) {
  const exp = ops.filter(o => o.expense > 0);
  return {
    count: ops.length,
    noReceipt: exp.filter(o => !o.receipt).length,
    unchecked: ops.filter(o => !o.checked).length,
    unreimbursed: exp.filter(o => !o.reimbursed).length,
    overCount: exp.filter(o => o.over).length,
    lastDate: ops.length ? ops[0].date : '',
  };
}

export const sheetUrl = id => (id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : '');
export const folderUrl = id => (id ? `https://drive.google.com/drive/folders/${id}` : '');
