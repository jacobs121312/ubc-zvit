// Спільне: константи, дати, суми, перевірки карток. Логіка перенесена з Apps Script (Code.gs), щоб
// поведінка для лідерів не змінилась.

export const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень',
  'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
export const FY_ORDER = [9, 10, 11, 0, 1, 2, 3, 4, 5, 6, 7, 8]; // жовтень → вересень

export const LIMITS = {
  EDIT_WINDOW_H: 24,
  CURRENCIES: ['UAH', 'USD', 'EUR'],
  MAX_SPLITS: 10,
  MAX_AMOUNT: 1000000,
  MAX_ITEMS: 30,
  MAX_FILES_PER_ITEM: 10,
  MAX_LEN: { description: 300, vendor: 100, noReceiptReason: 300, overReason: 300 },
  UPLOAD_LIMIT: { files: 150, bytes: 1500 * 1024 * 1024, windowMs: 6 * 3600e3 },
  SESSION_DAYS: 30, SESSION_DAYS_ADMIN: 7, SESSIONS_PER_USER: 5,
  STATS_DAYS: 60, STATS_ERRORS: 20,
};

/** Помилка для людини (текст показується як є). auth = true — повернути на вхід. */
export class UserError extends Error {
  constructor(message, auth = false) { super(message); this.name = 'UserError'; this.auth = auth; }
}
export const authError = msg => new UserError(msg, true);

export const fy = env => Number(env.FISCAL_YEAR_START || 2026);
export const fyBounds = env => ({ min: `${fy(env)}-10-01`, max: `${fy(env) + 1}-09-30` });

/** Сьогодні за Києвом: рррр-мм-дд. */
export const kyivDay = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
export const kyivHour = (d = new Date()) => Number(d.toLocaleString('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false })) % 24;
export const dmy = iso => String(iso).split('-').reverse().join('.');
/** «дд.мм.рррр гг:хх» за Києвом — як у примітках таблиці. */
export const stamp = (ms = Date.now()) => {
  const d = new Date(ms);
  const p = Object.fromEntries(new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
};

export const monthName = iso => MONTHS[Number(String(iso).slice(5, 7)) - 1];

/** Дата лише рррр-мм-дд і лише реальна (31.02 — помилка, а не 3 березня). */
export function parseDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new UserError('Вкажіть дату витрати.');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new UserError('Такої дати не існує.');
  return iso;
}

/** Сума: число > 0 і не більше MAX_AMOUNT, до копійок. Кома теж годиться. */
export function parseAmount(v) {
  const n = Number(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.'));
  if (!isFinite(n) || !(n > 0)) throw new UserError('Вкажіть суму більше нуля.');
  if (n > LIMITS.MAX_AMOUNT) throw new UserError(`Сума завелика: понад ${LIMITS.MAX_AMOUNT} грн за одну операцію.`);
  return round2(n);
}
export const round2 = n => Math.round(n * 100) / 100;

/**
 * Перевіряє й нормалізує картку. categories = null — категорію не звіряємо зі списком.
 * Поля, які ставить лише сервер (orig, receiptIds), з картки НЕ беруться.
 */
export function validateCard(env, form, categories) {
  if (!form || typeof form !== 'object') throw new UserError('Порожня картка.');
  const date = parseDate(form.date);
  const { min, max } = fyBounds(env);
  if (date < min || date > max) {
    throw new UserError(`Дата має бути в межах фінансового року (жовтень ${fy(env)} — вересень ${fy(env) + 1}).`);
  }
  const amount = parseAmount(form.amount);
  const opId = /^[\w-]{8,64}$/.test(String(form.opId || '')) ? String(form.opId) : '';
  const text = (key, label) => {
    const s = String(form[key] == null ? '' : form[key]).trim();
    if (s.length > LIMITS.MAX_LEN[key]) throw new UserError(`${label}: не довше ${LIMITS.MAX_LEN[key]} символів.`);
    return s;
  };
  const currency = LIMITS.CURRENCIES.includes(form.currency) ? form.currency : 'UAH';
  if (form.type === 'advance') {
    return { type: 'advance', date, amount, currency, description: text('description', 'Коментар'), opId };
  }
  const isCategory = c => typeof c === 'string' && !!c.trim() && c.length <= 200 && (!categories || categories.includes(c));
  let category = typeof form.category === 'string' ? form.category : '';
  let splits = [];
  if (Array.isArray(form.splits) && form.splits.length) {
    if (form.splits.length < 2 || form.splits.length > LIMITS.MAX_SPLITS) {
      throw new UserError(`Розділити витрату можна на 2–${LIMITS.MAX_SPLITS} категорій.`);
    }
    splits = form.splits.map(pt => {
      if (!pt || !isCategory(pt.category)) throw new UserError('Оберіть категорію для кожної частини.');
      return { category: pt.category, amount: parseAmount(pt.amount) };
    });
    const sum = round2(splits.reduce((a, pt) => a + pt.amount, 0));
    if (Math.abs(sum - amount) > 0.005) throw new UserError(`Сума частин (${sum}) не дорівнює сумі чека (${amount}).`);
    category = splits[0].category;
  } else if (!isCategory(category)) {
    throw new UserError('Оберіть категорію зі списку.');
  }
  const description = text('description', 'Опис');
  const vendor = text('vendor', 'Постачальник');
  if (!description) throw new UserError('Опишіть, що це і для чого.');
  if (!vendor) throw new UserError('Вкажіть постачальника (магазин / сервіс).');
  const hasReceipt = form.hasReceipt !== false;
  const noReceiptReason = hasReceipt ? '' : text('noReceiptReason', 'Причина');
  if (!hasReceipt && !noReceiptReason) throw new UserError('Якщо чека немає — обов\'язково поясніть чому.');
  const overReason = text('overReason', 'Пояснення перевищення');
  const item = { type: 'expense', date, amount, currency, category, description, vendor, hasReceipt, noReceiptReason, overReason, opId };
  if (splits.length) item.splits = splits;
  return item;
}

/** Чек — лише фото (JPEG, PNG, HEIC, WebP) або PDF, до 25 МБ. */
export function checkReceiptType(f) {
  const ok = /^(image\/(jpeg|png|heic|heif|webp)|application\/pdf)$/i.test(String(f.mimeType || ''))
    && /\.(jpe?g|png|hei[cf]|webp|pdf)$/i.test(String(f.name || ''));
  if (!ok) throw new UserError('Можна додавати лише фото (JPG, PNG, HEIC) або PDF.');
  const size = Number(f.size);
  if (!(size > 0)) throw new UserError('Файл чека порожній.');
  if (size > 25 * 1024 * 1024) throw new UserError('Файл чека завеликий (понад 25 МБ).');
}

/** Назва файлу чека: дата_код_сума_постачальник (з уже перевіреної витрати). */
export function receiptBaseName(item) {
  const catCode = (String(item.category || '').match(/^\d+/) || [''])[0];
  const cur = !item.currency || item.currency === 'UAH' ? 'грн' : item.currency;
  return [item.date, catCode, `${item.amount}${cur}`,
    String(item.vendor || '').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').trim().slice(0, 40)].filter(Boolean).join('_');
}
export const receiptExt = name => (String(name || '').match(/\.[a-z0-9]+$/i) || ['.jpg'])[0].toLowerCase();
export const receiptUrl = id => `https://drive.google.com/file/d/${id}/view`;

/** SHA-256 → base64url (для гешів ключів сесій і відбитків пошт). */
export async function sha256b64(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const splitEmails = str => String(str || '').toLowerCase().split(/[\s,;]+/).filter(x => /@/.test(x));
