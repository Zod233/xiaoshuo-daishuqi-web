#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""小说带入器 · 网页版本地服务。

作用只有三件：
1. 把 web/ 当前端发出去（file:// 读不了本地文件，所以必须过一层 http）；
2. 提供 /api/bundle，把框架提示词与设定集拼成一份交给浏览器；
3. 提供 /api/chat，把请求转发给玩家自己填的模型接口（key 只在浏览器与本机之间走，不落盘）。

启动：python serve.py      （默认 127.0.0.1:8765，自动开浏览器）
换端口：python serve.py --port 9000 --no-open
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import re
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
FW = ROOT / "framework"


def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def worlds() -> list[dict]:
    out = []
    for d in sorted((FW / "canon").glob("*")):
        if not d.is_dir() or d.name.startswith("_"):
            continue
        title = d.name
        head = read(d / "00-设定概览.md")
        m = re.search(r"^标题:\s*(.+)$", head, re.M) or re.search(r"^#\s+(.+)$", head, re.M)
        if m:
            title = m.group(1).strip()
        out.append({"id": d.name, "title": title})
    return out


def characters() -> list[dict]:
    out = []
    for d in sorted((FW / "characters").glob("*")):
        card = d / "角色卡.md"
        if not card.exists() or d.name.startswith("_"):
            continue
        text = read(card)
        m = re.search(r"^姓名:\s*(.+)$", text, re.M)
        out.append({"id": d.name, "name": m.group(1).strip() if m else d.name})
    return out


def bundle(world: str, character: str, persona: str) -> dict:
    cdir = FW / "canon" / world
    if not cdir.is_dir():
        raise ValueError(f"找不到设定集：canon/{world}")
    files = []
    for f in sorted(cdir.glob("*.md")):
        files.append({"name": f.name, "text": read(f)})
    card = ""
    if character:
        cp = FW / "characters" / character / "角色卡.md"
        if cp.exists():
            card = read(cp)
    return {
        "system_prompt": read(FW / "narrator" / "system-prompt.md"),
        "framework": read(FW / "narrator" / "_framework.md"),
        "persona": read(FW / "narrator" / "personas" / f"{persona}.md"),
        "canon": files,
        "card": card,
        "world": world,
        "character": character,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 安静一点
        return

    # ---------- 工具 ----------
    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    # ---------- 路由 ----------
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/meta":
            return self.send_json({"worlds": worlds(), "characters": characters()})
        if path == "/api/bundle":
            import urllib.parse as up
            q = up.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            try:
                return self.send_json(bundle(
                    (q.get("world") or ["shuihu"])[0],
                    (q.get("character") or [""])[0],
                    (q.get("persona") or ["原著旁白"])[0],
                ))
            except Exception as e:  # noqa: BLE001
                return self.send_json({"error": str(e)}, 400)
        return self.serve_static(path)

    def serve_static(self, path: str):
        if path in ("/", ""):
            path = "/index.html"
        target = (WEB / path.lstrip("/")).resolve()
        if not str(target).startswith(str(WEB.resolve())) or not target.is_file():
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        data = target.read_bytes()
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix in (".md", ".txt"):
            ctype = "text/plain; charset=utf-8"
        elif target.suffix in (".html", ".css", ".js"):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path.split("?")[0] != "/api/chat":
            return self.send_json({"error": "not found"}, 404)
        try:
            req = self.body()
        except Exception:  # noqa: BLE001
            return self.send_json({"error": "请求体不是合法 JSON"}, 400)

        base = (req.get("base_url") or "").strip().rstrip("/")
        key = (req.get("api_key") or "").strip()
        model = (req.get("model") or "").strip()
        messages = req.get("messages") or []
        if not base or not key or not model:
            return self.send_json({"error": "接口地址 / 模型名 / API Key 三项都要填"}, 400)

        url = base + "/chat/completions"
        payload = json.dumps({
            "model": model,
            "messages": messages,
            "temperature": req.get("temperature", 0.8),
            "stream": False,
        }, ensure_ascii=False).encode("utf-8")
        r = urllib.request.Request(url, data=payload, method="POST", headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        })
        try:
            with urllib.request.urlopen(r, timeout=120) as resp:
                raw = json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:600]
            return self.send_json({"error": f"接口返回 {e.code}", "detail": detail}, 200)
        except Exception as e:  # noqa: BLE001
            return self.send_json({"error": f"连不上接口：{e}"}, 200)

        try:
            content = raw["choices"][0]["message"]["content"]
        except Exception:  # noqa: BLE001
            return self.send_json({"error": "接口返回里没有 choices[0].message.content", "detail": str(raw)[:600]}, 200)
        usage = raw.get("usage") or {}
        return self.send_json({"content": content, "usage": usage})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args()
    url = f"http://{a.host}:{a.port}/"
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"小说带入器 · 网页版   {url}")
    print("按 Ctrl+C 停止。")
    if not a.no_open:
        threading.Thread(target=lambda: (time.sleep(0.8), webbrowser.open(url)), daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
