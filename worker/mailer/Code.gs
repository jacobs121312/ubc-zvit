/**
 * «Поштар» для нового API (Cloudflare Worker): надсилає листи-запрошення з церковного акаунта.
 * Розгортання: Apps Script → Веб-застосунок, «Виконувати як: я», «Доступ: усі».
 * Ключ: Налаштування проєкту → Властивості скрипта → MAILER_KEY (той самий, що `wrangler secret put MAILER_KEY`).
 */
function doPost(e) {
  const out = (o) => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false }); }
  const key = PropertiesService.getScriptProperties().getProperty('MAILER_KEY');
  if (!key || req.key !== key) return out({ ok: false, error: 'forbidden' });
  const to = String(req.to || '').trim().toLowerCase();
  if (!/^[^\s@]+@ubchurch\.lviv\.ua$/.test(to)) return out({ ok: false, error: 'bad recipient' }); // лише церковні адреси
  if (MailApp.getRemainingDailyQuota() < 5) return out({ ok: false, error: 'quota' });
  const h = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const list = (Array.isArray(req.ministries) ? req.ministries : []).join(', ');
  const link = String(req.site || 'https://budget.ubchurch.lviv.ua/') + '?email=' + encodeURIComponent(to);
  MailApp.sendEmail({
    to, name: 'Звіт по витратах УБЦ', subject: 'Запрошення: звіт по витратах служіння',
    body: `Вітаємо!\n\nВас додано до звітування по витратах служіння: ${list}.\n\nВідкрийте сайт: ${link}\n\n` +
      `1) Натисніть «Увійти через Google» і виберіть акаунт ${to}.\n2) Подавайте витрати й аванси з фото чеків — усе потрапить у звіт служіння.\n\n` +
      'Пароль на сайті вводити не потрібно — вхід лише через Google.\n\nУкраїнська Біблійна Церква',
    htmlBody: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111"><p>Вітаємо!</p>
      <p>Вас додано до звітування по витратах служіння: <b>${h(list)}</b>.</p>
      <p><a href="${h(link)}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none">Відкрити звіт по витратах</a></p>
      <ol><li>Натисніть «Увійти через Google» і виберіть акаунт <b>${h(to)}</b>.</li>
      <li>Подавайте витрати й аванси з фото чеків — усе потрапить у звіт служіння.</li></ol>
      <p style="color:#666">Пароль на сайті вводити не потрібно — вхід лише через Google.</p><p>Українська Біблійна Церква</p></div>`,
  });
  return out({ ok: true, remainingQuota: MailApp.getRemainingDailyQuota() });
}
