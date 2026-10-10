"""Собирает data/index.json из метаданных плейлистов и транскрипты уроков.

Использование:
  python3 tools/build_index.py <папка_с_playlist_json> <папка_с_субтитрами>   — полная сборка
  python3 tools/build_index.py                                                — только обновить названия/готовность уроков
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLAYLISTS = [  # порядок уровней
    ("A1", "PLD6SPjEPomavJCbsDoJLG1hq5JietJuK9"),
    ("A2", "PLD6SPjEPomavsYE8OCNmmTCOdbvjkh6LQ"),
    ("B1", "PLD6SPjEPomavVsbi9RNEMMA2qPI1UrqF9"),
    ("B2", "PLD6SPjEPomau5ehJxHo9oy0TJAUco9Rf8"),
    ("C1", "PLD6SPjEPomas3z_YSZTDDiiqUlaGiVKXJ"),
]


def transcript(path: Path) -> str:
    d = json.loads(path.read_text())
    lines, cur = [], []
    for ev in d.get("events", []):
        text = "".join(s.get("utf8", "") for s in ev.get("segs", []))
        if not text.strip():
            continue
        cur.append(text.strip())
        if len(" ".join(cur)) > 300:
            mm, ss = divmod(ev.get("tStartMs", 0) // 1000, 60)
            lines.append(f"[{mm:02d}:{ss:02d}] " + " ".join(cur))
            cur = []
    if cur:
        lines.append(" ".join(cur))
    return "\n".join(lines)


def refresh():
    """Обновляет title/ready в data/index.json по готовым файлам уроков."""
    path = ROOT / "data" / "index.json"
    index = json.loads(path.read_text())
    ready = 0
    for lv in index["levels"]:
        for l in lv["lessons"]:
            f = ROOT / "data" / "lessons" / f"{l['id']}.json"
            l["ready"] = f.exists()
            if f.exists():
                l["title"] = json.loads(f.read_text())["title"]
                ready += 1
            else:
                l.pop("title", None)
    path.write_text(json.dumps(index, ensure_ascii=False, indent=1))
    print("ready lessons:", ready)


def main(pl_dir: Path, subs_dir: Path):
    index = {"levels": []}
    out = ROOT / "content_src" / "transcripts"
    out.mkdir(parents=True, exist_ok=True)
    for level, pl in PLAYLISTS:
        entries = json.loads((pl_dir / f"{pl}.json").read_text())["entries"]
        lessons = []
        for n, e in enumerate(entries, 1):
            lid = f"{level}-{n:02d}"
            lessons.append({"id": lid, "num": n, "videoId": e["id"], "duration": e.get("duration") or 0})
            sub = subs_dir / f"{e['id']}.ru-orig.json3"
            if sub.exists():
                (out / f"{lid}.txt").write_text(transcript(sub))
        index["levels"].append({"id": level, "playlist": pl, "lessons": lessons})
    (ROOT / "data" / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1))
    refresh()
    print("ok:", sum(len(l["lessons"]) for l in index["levels"]), "lessons;", len(list(out.glob("*.txt"))), "transcripts")


if __name__ == "__main__":
    if len(sys.argv) == 3:
        main(Path(sys.argv[1]), Path(sys.argv[2]))
    else:
        refresh()
