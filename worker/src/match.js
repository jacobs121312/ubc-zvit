// Прив'язка чеків, які лежать у папках служіння на Диску, до витрат без посилання (позначених «так» у колонці «Чек»).
// Зіставлення — лише за назвою файлу: точна сума (і дата, якщо вона є в назві, ±3 дні). Прив'язуються тільки
// однозначні пари: одна витрата ↔ один файл, файл ще ніде не використаний. Решта — у звіті для ручного розбору.
import { listChildren } from './google.js';
import { enqueue } from './mirror.js';

const FOLDER = 'application/vnd.google-apps.folder';
const RECEIPT = /^(image\/|application\/pdf$)/;

/** Усі фото й PDF у папці служіння (з вкладеними папками, до 3 рівнів). */
async function receiptFiles(env, rootId) {
  const out = [];
  async function walk(id, path, depth) {
    for (const f of await listChildren(env, id)) {
      if (f.mimeType === FOLDER) { if (depth < 3) await walk(f.id, path + f.name + '/', depth + 1); }
      else if (RECEIPT.test(f.mimeType)) out.push({ id: f.id, name: f.name, path: path + f.name });
    }
  }
  await walk(rootId, '', 0);
  return out;
}

/**
 * Суми з назви: «924,87», «1104.4грн», «1 635 грн», «2026-11-07_3401_1635грн_…».
 * strong — сума з копійками або з «грн/uah/₴» поруч (голе ціле число, як у «IMG_1234», — слабка ознака).
 */
export function amountsIn(name) {
  const base = String(name).replace(/\.[a-z0-9]+$/i, '');
  const cleaned = base
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')                       // 2026-11-07
    .replace(/(?<!\d)\d{1,2}[.:]\d{2}[.:]\d{2}(?!\d)/g, ' ')    // час 13.57.00
    .replace(/(?<!\d)\d{1,2}[./]\d{1,2}[./](?:\d{4}|\d{2})(?!\d)/g, ' ') // 30.10.26
    .replace(/_3\d{3}_/g, '_');                               // код категорії
  const out = new Map();
  for (const m of cleaned.matchAll(/(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,](\d{1,2}))?(\s*(?:грн|uah|₴))?/gi)) {
    const n = Math.round(Number(m[1].replace(/[  ]/g, '') + (m[2] ? '.' + m[2] : '')) * 100) / 100;
    if (!(n > 0 && n < 1e7)) continue;
    out.set(n, out.get(n) || !!(m[2] || m[3]));
  }
  return [...out].map(([v, strong]) => ({ v, strong }));
}

/** Дати з назви → ISO: «30.10.26», «29.10.2026», «2026-11-07» (лише реальні дні й місяці). */
export function datesIn(name) {
  const out = [];
  const ok = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2020 && y <= 2035;
  for (const m of String(name).matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) if (ok(+m[1], +m[2], +m[3])) out.push(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of String(name).matchAll(/(?<!\d)(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})(?!\d)/g)) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (ok(y, +m[2], +m[1])) out.push(`${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
  }
  return out;
}

const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;

/** Пропозиції для служіння: [{op, file, why}] однозначні + {op, candidates} неоднозначні + без кандидатів. */
export async function proposeMatches(env, ministryId) {
  const { results: ops } = await env.DB.prepare(`SELECT id, date, amount, description FROM ops WHERE ministry_id = ? AND type = 'expense'
    AND has_receipt = 1 AND deleted_at IS NULL AND id NOT IN (SELECT op_id FROM op_receipts) ORDER BY date`).bind(ministryId).all();
  if (!ops.length) return { matched: [], ambiguous: [], none: [] };
  const { results: used } = await env.DB.prepare('SELECT DISTINCT file_id FROM op_receipts').all();
  const taken = new Set(used.map(u => u.file_id));
  const files = (await receiptFiles(env, ministryId)).filter(f => !taken.has(f.id))
    .map(f => ({ ...f, amounts: amountsIn(f.name), dates: datesIn(f.name) }));

  // Кандидати: сума точна; якщо в назві є дата — не далі ніж 3 дні від дати витрати.
  const hit = (f, o) => f.amounts.find(a => Math.abs(a.v - o.amount) < 0.005);
  const cand = new Map(ops.map(o => [o.id, files.filter(f => hit(f, o) && (!f.dates.length || f.dates.some(d => dayDiff(d, o.date) <= 3)))]));
  // Сильний збіг: дата в назві поруч із датою витрати або сума з копійками / «грн».
  const strong = (f, o) => f.dates.some(d => dayDiff(d, o.date) <= 3) || hit(f, o).strong;
  // Однозначно: у витрати рівно один кандидат, і цей файл — кандидат лише для неї.
  const usage = new Map();
  for (const list of cand.values()) for (const f of list) usage.set(f.id, (usage.get(f.id) || 0) + 1);
  const matched = [], ambiguous = [], none = [];
  for (const o of ops) {
    const list = cand.get(o.id);
    if (list.length === 1 && usage.get(list[0].id) === 1 && strong(list[0], o)) {
      matched.push({ op: o, file: list[0], why: list[0].dates.length ? 'сума і дата' : 'сума' });
    } else if (list.length) ambiguous.push({ op: o, candidates: list.map(f => f.path) });
    else none.push({ op: o });
  }
  return { matched, ambiguous, none, filesSeen: files.length };
}

/** Прив'язує однозначні пари: op_receipts + завдання дзеркалу поставити посилання в колонці «Чек». */
export async function applyMatches(env, ministryId, matched) {
  if (!matched.length) return 0;
  const st = [];
  for (const m of matched) {
    st.push(env.DB.prepare('INSERT OR IGNORE INTO op_receipts (op_id, file_id, pos) VALUES (?, ?, 0)').bind(m.op.id, m.file.id));
    st.push(env.DB.prepare(`INSERT INTO changelog (ministry_id, at, email, action, details) VALUES (?, ?, 'система', 'Чек прив''язано', ?)`)
      .bind(ministryId, Date.now(), `${m.op.date} · ${m.op.amount} грн · ${m.op.description} ← ${m.file.path} (${m.why})`));
    st.push(enqueue(env, ministryId, 'upsert_op', { id: m.op.id }));
  }
  await env.DB.batch(st);
  return matched.length;
}

/** Порція черги (cron): match_jobs.mode = 'dry' — лише звіт; 'apply' — прив'язати однозначні. */
export async function processMatchJobs(env, batch = 2) {
  const { results } = await env.DB.prepare("SELECT ministry_id, mode FROM match_jobs WHERE status = 'pending' LIMIT ?").bind(batch).all();
  for (const j of results) {
    let status = 'done', report;
    try {
      const p = await proposeMatches(env, j.ministry_id);
      const applied = j.mode === 'apply' ? await applyMatches(env, j.ministry_id, p.matched) : 0;
      report = {
        applied, filesSeen: p.filesSeen,
        matched: p.matched.map(m => ({ date: m.op.date, amount: m.op.amount, desc: m.op.description, file: m.file.path, why: m.why })),
        ambiguous: p.ambiguous.map(a => ({ date: a.op.date, amount: a.op.amount, desc: a.op.description, candidates: a.candidates })),
        none: p.none.map(n => ({ date: n.op.date, amount: n.op.amount, desc: n.op.description })),
      };
    } catch (e) { status = 'error'; report = { error: String(e.message || e).slice(0, 300) }; }
    await env.DB.prepare('UPDATE match_jobs SET status = ?, report = ?, at = ? WHERE ministry_id = ?')
      .bind(status, JSON.stringify(report), Date.now(), j.ministry_id).run();
  }
}
