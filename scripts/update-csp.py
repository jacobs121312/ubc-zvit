#!/usr/bin/env python3
"""Оновлює Content-Security-Policy в index.html: геші вбудованих <script>.
Запускати після кожної зміни скриптів у index.html, інакше браузер їх заблокує:
    python3 scripts/update-csp.py [шлях до сторінки, типово index.html]
"""
import base64, hashlib, pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent
page = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / 'index.html'
html = page.read_text(encoding='utf-8')
hashes = ["'sha256-%s'" % base64.b64encode(hashlib.sha256(body.encode('utf-8')).digest()).decode()
          for body in re.findall(r'<script>(.*?)</script>', html, re.S)]

policy = '; '.join([
    "default-src 'none'",
    "script-src 'self' https://accounts.google.com/gsi/client " + ' '.join(hashes),
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.googleusercontent.com https://*.gstatic.com",
    "connect-src 'self' https://script.google.com https://script.googleusercontent.com "
    "https://www.googleapis.com https://accounts.google.com/gsi/",
    "frame-src https://accounts.google.com/gsi/",
    "manifest-src 'self'",
    "worker-src 'self'",                     # sw.js — застосунок на головному екрані
    "base-uri 'none'",
    "form-action 'none'",
])
tag = '<meta http-equiv="Content-Security-Policy" content="%s">' % policy
html, n = re.subn(r'<meta http-equiv="Content-Security-Policy" content="[^"]*">', tag, html)
if not n:
    html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  ' + tag, 1)
page.write_text(html, encoding='utf-8')
print('CSP: %d вбудованих скриптів' % len(hashes))
