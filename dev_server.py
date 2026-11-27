#!/usr/bin/env python3
"""Local dev server: serves the app and a /proxy?url= endpoint (same API as worker.js)."""
import ipaddress, os, socket, ssl, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, urlopen

MAX_BYTES = 5 * 1024 * 1024
UA = "Mozilla/5.0 (compatible; Feedlight/1.0)"
# python.org builds on macOS ship without CA certs; fall back to the system bundle.
CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem" if os.path.exists("/etc/ssl/cert.pem") else None)


def is_public(host):
    try:
        for info in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return False
        return True
    except Exception:
        return False


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/proxy":
            return self.proxy(parse_qs(u.query).get("url", [""])[0])
        return super().do_GET()

    def proxy(self, target):
        p = urlparse(target)
        if p.scheme not in ("http", "https") or not p.hostname or not is_public(p.hostname):
            return self.fail(400, "bad url")
        try:
            req = Request(target, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/atom+xml, text/xml, text/html, */*"})
            with urlopen(req, timeout=12, context=CTX) as r:
                body = r.read(MAX_BYTES)
                ctype = r.headers.get("Content-Type", "text/plain")
        except Exception as e:
            return self.fail(502, str(e))
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def fail(self, code, msg):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(msg.encode())

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f"Feedlight dev server: http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
