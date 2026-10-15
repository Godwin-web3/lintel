#!/usr/bin/env python3
"""Minimal server that wraps the Lintel CLI for the website."""
import json, subprocess, sys
from http.server import HTTPServer, BaseHTTPRequestHandler

CLI = "lintel-cli"  # or full path to the built binary

class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw) if raw else {}
        except Exception:
            self._send(400, {"error": "invalid json"})
            return

        if self.path == "/create":
            amount = data.get("amount", "1.0")
            condition = data.get("condition", "test")
            try:
                out = subprocess.check_output([CLI, "create", amount, condition], text=True)
                self._send(200, json.loads(out))
            except Exception as e:
                self._send(500, {"error": str(e)})
        elif self.path == "/complete":
            try:
                proc = subprocess.run([CLI, "complete"], input=json.dumps(data),
                                       text=True, capture_output=True)
                if proc.returncode != 0:
                    self._send(500, {"error": proc.stderr})
                else:
                    self._send(200, json.loads(proc.stdout))
            except Exception as e:
                self._send(500, {"error": str(e)})
        else:
            self._send(404, {"error": "not found"})

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    print(f"Lintel engine server on http://localhost:{port}")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
