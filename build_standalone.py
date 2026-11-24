#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 web/ 与 framework/ 打成一份可双击打开的单文件 HTML（不需要 Python、不需要服务器）。

用法：python build_standalone.py
产物：小说带入器.html
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
FW = ROOT / "framework"
OUT = ROOT / "小说带入器.html"


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8", errors="replace")


def safe_json(obj) -> str:
    # 防止 </script> 提前闭合
    return json.dumps(obj, ensure_ascii=False).replace("</", "<\\/")


def collect() -> dict:
    worlds, canon = [], {}
    for d in sorted((FW / "canon").glob("*")):
        if not d.is_dir() or d.name.startswith("_"):
            continue
        head = read(d / "00-设定概览.md")
        m = re.search(r"^标题:\s*(.+)$", head, re.M) or re.search(r"^#\s+(.+)$", head, re.M)
        worlds.append({"id": d.name, "title": m.group(1).strip() if m else d.name})
        canon[d.name] = [{"name": f.name, "text": read(f)} for f in sorted(d.glob("*.md"))]

    chars, cards = [], {}
    for d in sorted((FW / "characters").glob("*")):
        card = d / "角色卡.md"
        if not card.exists() or d.name.startswith("_"):
            continue
        text = read(card)
        m = re.search(r"^姓名:\s*(.+)$", text, re.M)
        chars.append({"id": d.name, "name": m.group(1).strip() if m else d.name})
        cards[d.name] = text

    personas = {p.stem: read(p) for p in sorted((FW / "narrator" / "personas").glob("*.md"))}

    return {
        "system_prompt": read(FW / "narrator" / "system-prompt.md"),
        "framework": read(FW / "narrator" / "_framework.md"),
        "personas": personas,
        "worlds": worlds,
        "characters": chars,
        "canon": canon,
        "cards": cards,
        "built_at": str(Path(__file__).stat().st_mtime)[:10],
    }


def main() -> int:
    html = read(WEB / "index.html")
    css = read(WEB / "style.css")
    js = read(WEB / "app.js")
    data = collect()

    html = html.replace('<link rel="stylesheet" href="/style.css">', f"<style>\n{css}\n</style>")
    script_block = (
        "<script>window.XB_DATA=" + safe_json(data) + ";</script>\n"
        "<script>\n" + js + "\n</script>"
    )
    html = html.replace('<script src="/app.js"></script>', script_block)
    html = html.replace('<title>小说带入器</title>', '<title>小说带入器 · 单文件版</title>')

    OUT.write_text(html, encoding="utf-8")
    kb = OUT.stat().st_size / 1024
    print(f"✓ {OUT.name}  {kb:.0f} KB")
    print(f"  世界：{', '.join(w['title'] for w in data['worlds'])}")
    print(f"  角色：{', '.join(c['name'] for c in data['characters'])}")
    print(f"  设定集：{sum(len(v) for v in data['canon'].values())} 份｜人设：{len(data['personas'])} 个")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
