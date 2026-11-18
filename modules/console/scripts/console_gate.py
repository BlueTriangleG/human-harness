#!/usr/bin/env python3
"""给 HH 控制台（127.0.0.1:7790，只读、没登录）套一层口令，再交给 cloudflared 隧道。
第一次带 ?k=口令 打开会种 cookie，之后不用再带。用法：console_gate.py <口令> [端口 7791]"""
import sys, http.server, urllib.request, urllib.parse, http.cookies
TOKEN = sys.argv[1]; PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 7791
UP = 'http://127.0.0.1:' + (sys.argv[3] if len(sys.argv) > 3 else '7790')  # 第三个参数：上游端口（11-13 加，英文演示控制台 7796）
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass
    def do_GET(self):
        u = urllib.parse.urlsplit(self.path); q = urllib.parse.parse_qs(u.query)
        c = http.cookies.SimpleCookie(self.headers.get('Cookie', ''))
        if q.get('k', [''])[0] == TOKEN:
            rest = urllib.parse.urlencode([(k, v) for k, vs in q.items() if k != 'k' for v in vs])
            self.send_response(302); self.send_header('Location', u.path + ('?' + rest if rest else ''))
            self.send_header('Set-Cookie', f'hhk={TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000')
            self.send_header('Content-Length', '0'); self.end_headers(); return
        if 'hhk' not in c or c['hhk'].value != TOKEN:
            b = '没有口令'.encode(); self.send_response(403); self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b); return
        try:
            r = urllib.request.urlopen(UP + self.path, timeout=600)
        except urllib.error.HTTPError as e:
            r = e
        self.send_response(r.status if hasattr(r, 'status') else r.code)
        ct = r.headers.get('Content-Type', 'application/octet-stream')
        self.send_header('Content-Type', ct)
        stream = 'event-stream' in ct
        if stream:
            self.send_header('Cache-Control', 'no-store'); self.send_header('Transfer-Encoding', 'chunked'); self.end_headers()
            try:
                while True:
                    d = r.read1(4096) if hasattr(r, 'read1') else r.read(4096)
                    if not d: break
                    self.wfile.write(b'%x\r\n%s\r\n' % (len(d), d)); self.wfile.flush()
                self.wfile.write(b'0\r\n\r\n')
            except Exception: pass
            self.close_connection = True; return
        b = r.read(); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_HEAD(self): self.send_response(405); self.end_headers()
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
