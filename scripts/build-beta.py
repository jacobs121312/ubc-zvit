#!/usr/bin/env python3
"""Збирає бета-версію з новим дизайном: beta/index.html = index.html + інший вигляд.
Логіка, вхід і дані — ті самі, що в робочій версії. Запускати після кожної зміни index.html:
    python3 scripts/build-beta.py
"""
import pathlib, re, subprocess, sys

root = pathlib.Path(__file__).resolve().parent.parent
html = (root / 'index.html').read_text(encoding='utf-8')


def sub(old, new, count=1):
    global html
    if html.count(old) < 1:
        sys.exit('build-beta: не знайдено фрагмент:\n' + old[:200])
    html = html.replace(old, new, count)


# ---------- шляхи: сторінка лежить у /beta/ ----------
sub('<title>Звіт по витратах · УБЦ</title>', '<title>Бета · Звіт по витратах · УБЦ</title>')
sub('href="manifest.webmanifest"', 'href="../manifest.webmanifest"')
sub('href="icon-192.png"', 'href="../icon-192.png"')
sub('href="apple-touch-icon.png"', 'href="../apple-touch-icon.png"')
sub("navigator.serviceWorker.register('sw.js')", "navigator.serviceWorker.register('../sw.js')")
html = re.sub(r'\s*<link rel="preconnect" href="https://fonts.googleapis.com">\s*<link href="https://fonts.googleapis.com/css2\?family=Inter[^>]*>', '', html)
sub('<meta name="theme-color" content="#f6f6f7"', '<meta name="theme-color" content="#f2f2ef"')
sub('<meta name="theme-color" content="#09090b"', '<meta name="theme-color" content="#000000"')

# ---------- шапка ----------
sub('''  <header>
    <div class="eyebrow">Українська Біблійна Церква</div>
    <h1>Звіт по витратах</h1>''', '''  <header class="topbar">
    <div class="tb-brand"><span class="logo">УБЦ</span><div><div class="eyebrow">Українська Біблійна Церква · <b class="beta-tag">бета</b></div>
    <h1>Звіт по витратах</h1></div></div>''')

# ---------- огляд: залишок бюджету + «Потребує уваги» ----------
sub('''  <div class="sub-main">''', '''  <div class="sub-main">
  <section class="hero hidden" id="hero">
    <div class="b-label" id="heroLabel">Залишок бюджету</div>
    <div class="b-sum" id="heroSum"></div>
    <div class="b-sub" id="heroSub"></div>
    <div class="pace" id="pace"></div>
  </section>
  <div class="hidden" id="attnBox">
    <div class="sec-t"><h2>Потребує уваги</h2></div>
    <div class="group" id="attn"></div>
  </div>
  <div class="sec-t"><h2>Новий запис</h2></div>''')

sub('''    renderHistory();
    animateStats();
  }''', '''    renderHistory();
    renderOverview(d);
    animateStats();
  }''')

OVERVIEW = r'''
  // ---------- бета: огляд (залишок, темп року, «Потребує уваги») ----------
  const C_N = 6;
  /** Стабільний колір категорії за її кодом: 1…6. */
  const catColor = name => { const s = String(name || ''); let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % C_N + 1; };
  const catInitial = name => (String(name || '').replace(/^\d+\s*/, '').trim()[0] || '•').toUpperCase();
  function opIcon(o) {
    if (isAdv(o)) return `<div class="op-ico inc">${ICO_INC}</div>`;
    const c = catColor(o.category);
    return `<div class="op-ico" style="background:var(--c${c}t);color:var(--c${c})">${esc(catInitial(o.category))}</div>`;
  }
  const UA_MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
  function dayLabel(iso) {
    if (!iso) return 'Без дати';
    const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (iso === isoOf(new Date())) return 'Сьогодні';
    if (iso === isoOf(new Date(Date.now() - 864e5))) return 'Вчора';
    const [Y, M, D] = iso.split('-').map(Number);
    return `${D} ${UA_MONTHS[M - 1]}${Y !== new Date().getFullYear() ? ' ' + Y : ''}`;
  }
  /** Яка частка навчального року (з 1 жовтня) уже минула. */
  function yearShare() {
    const now = new Date(), y = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
    const a = new Date(y, 9, 1), b = new Date(y + 1, 9, 1);
    return Math.min(1, Math.max(0, (now - a) / (b - a)));
  }
  function renderOverview(d) {
    const cats = d.categories || [];
    const plan = cats.reduce((a, c) => a + c.plan, 0), spent = cats.reduce((a, c) => a + c.spent, 0);
    if (!plan) { $('hero').classList.add('hidden'); }
    else {
      const left = plan - spent, share = yearShare(), used = spent / plan;
      const whole = Math.trunc(Math.abs(left)).toLocaleString('uk-UA');
      const kop = Math.round(Math.abs(left) % 1 * 100).toString().padStart(2, '0');
      $('heroLabel').textContent = left < 0 ? 'Бюджет перевищено на' : 'Залишок бюджету на рік';
      $('heroSum').innerHTML = `${whole}<span>,${kop} ₴</span>`;
      $('heroSum').classList.toggle('neg', left < 0);
      const ahead = used - share;
      const pace = ahead > 0.05 ? '<b class="warn">швидше за план</b>' : '<b class="ok">в межах плану</b>';
      $('heroSub').innerHTML = `з ${uah(plan)} · витрачено ${Math.round(used * 100)}% · ${pace}`;
      $('pace').innerHTML = `<div class="pace-track"><i style="width:${Math.min(100, used * 100).toFixed(1)}%"></i>
          <div class="pace-mark" style="left:${(share * 100).toFixed(1)}%"><span>сьогодні</span></div></div>
        <div class="pace-leg"><span>витрачено ${uah(spent)}</span><span>рік пройдено на ${Math.round(share * 100)}%</span></div>`;
      $('hero').classList.remove('hidden');
    }

    const ops = hist.ops || [];
    const noRc = ops.filter(o => o.expense > 0 && !o.receipt);
    const waiting = ops.filter(o => o.status === 'submitted');
    const over = cats.filter(c => c.spent > c.plan);
    const ICO = {
      bad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M12 8v4M12 15.5v.01"/></svg>',
      wait: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
      over: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.01"/></svg>',
      ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
    };
    const chev = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>';
    const item = (kind, cls, title, sub, go) => `<button type="button" class="todo" data-go="${go}"><span class="ic ${cls}">${ICO[kind]}</span>
      <span class="todo-m"><b>${title}</b><span>${sub}</span></span>${chev}</button>`;
    const rows = [];
    if (noRc.length) rows.push(item('bad', 'bad', `Без чека: ${noRc.length}`, esc([noRc[0].description || noRc[0].category.replace(/^\d+\s*/, ''), uah(noRc[0].expense)].filter(Boolean).join(' · ')) + (noRc.length > 1 ? ` і ще ${noRc.length - 1}` : ''), 'noReceipt'));
    if (over.length) rows.push(item('over', 'warn', `Перевищено бюджет: ${over.length} ${over.length === 1 ? 'категорія' : 'категорії'}`, esc(over.map(c => c.name.replace(/^\d+\s*/, '').trim()).slice(0, 2).join(', ')), 'over'));
    if (waiting.length) rows.push(item('wait', 'info', `На перевірці: ${waiting.length}`, `на суму ${uah(waiting.reduce((a, o) => a + o.expense + o.income, 0))}`, 'submitted'));
    if (!rows.length && ops.length) rows.push(item('ok', 'ok', 'Усе в порядку', 'усі витрати з чеками й перевірені', 'all'));
    $('attn').innerHTML = rows.join('');
    $('attnBox').classList.toggle('hidden', !rows.length);
  }
  $('attn').onclick = ev => {
    const b = ev.target.closest('[data-go]'); if (!b) return;
    const go = b.dataset.go;
    hist.status = go === 'submitted' ? 'submitted' : ''; hist.q = ''; hist.month = ''; hist.cat = ''; hist.limit = 50;
    hist.noReceipt = go === 'noReceipt';
    $('histStatus').value = hist.status; $('histQ').value = ''; $('histMonth').value = ''; $('histCat').value = '';
    setTab('stats'); renderHistory();
    const target = go === 'over' ? $('catList') : $('ops');
    setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };
'''
sub('  // ---------- історія операцій (F5), редагування (F2), експорт (F7) ----------',
    OVERVIEW + '\n  // ---------- історія операцій (F5), редагування (F2), експорт (F7) ----------')

# «Без чека» з огляду — окремий фільтр історії; будь-яка інша зміна фільтрів його знімає.
sub("      && (!hist.q || [o.description, o.vendor, o.category, o.noReceiptReason].join(' ').toLowerCase().includes(hist.q)));",
    "      && (!hist.q || [o.description, o.vendor, o.category, o.noReceiptReason].join(' ').toLowerCase().includes(hist.q))\n      && (!hist.noReceipt || (o.expense > 0 && !o.receipt)));")
sub("  $('histQ').oninput = () => { hist.q =", "  $('histQ').oninput = () => { hist.noReceipt = false; hist.q =")
sub("    $(id).onchange = () => { hist[k] = $(id).value;", "    $(id).onchange = () => { hist.noReceipt = false; hist[k] = $(id).value;")

# ---------- історія: групи по днях, кольорові іконки категорій ----------
sub('''    $('ops').innerHTML = shown.length ? shown.map((o, oi) => {
      const inc = isAdv(o);''', '''    const dayTot = {};
    shown.forEach(o => { dayTot[o.date] = (dayTot[o.date] || 0) + o.expense; });
    $('ops').innerHTML = shown.length ? shown.map((o, oi) => {
      const inc = isAdv(o);
      const head = oi === 0 || shown[oi - 1].date !== o.date
        ? `<div class="day">${esc(dayLabel(o.date))}<span>${dayTot[o.date] ? '−' + uah(dayTot[o.date]) : ''}</span></div>` : '';''')
sub('''      const sub = [dmy(o.date), inc ? 'аванс' : o.category.replace(/^\\d+\\s*/, ''), o.vendor].filter(Boolean).map(esc).join(' · ');
      const link = safeUrl(o.receipt) ? `<a class="op-link" href="${esc(safeUrl(o.receipt))}" target="_blank" rel="noopener">чек ↗</a>` : '';''',
    '''      const sub = [inc ? 'аванс' : o.category.replace(/^\\d+\\s*/, ''), o.vendor].filter(Boolean).map(esc).join(' · ');
      const link = safeUrl(o.receipt) ? `<a class="op-link" href="${esc(safeUrl(o.receipt))}" target="_blank" rel="noopener">чек ↗</a>`
        : (o.expense > 0 ? '<span class="st nr">без чека</span>' : '');''')
sub('''      return `<div class="op" data-id="${esc(o.id)}" style="--i:${Math.min(oi, 10)}"><div class="op-ico${inc ? ' inc' : ''}">${inc ? ICO_INC : ICO_EXP}</div>''',
    '''      return head + `<div class="op" data-id="${esc(o.id)}" style="--i:${Math.min(oi, 10)}">${opIcon(o)}''')

# ---------- підвал ----------
html, n = re.subn(r'<div class="ver"[^>]*>[^<]*</div>',
    '<div class="ver">Бета-версія нового дизайну · дані справжні · <a href="../">звичайна версія</a></div>', html)
if not n:
    sys.exit('build-beta: не знайдено мітку версії')

# ---------- новий вигляд поверх старих стилів ----------
sub('  </style>', (root / 'scripts' / 'beta.css').read_text(encoding='utf-8') + '\n  </style>')

out = root / 'beta' / 'index.html'
out.parent.mkdir(exist_ok=True)
out.write_text(html, encoding='utf-8')
subprocess.run([sys.executable, str(root / 'scripts' / 'update-csp.py'), str(out)], check=True)
print('beta/index.html готово')
