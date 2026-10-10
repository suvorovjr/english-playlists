"""Проверяет файлы уроков data/lessons/*.json.

Использование: python3 tools/validate.py [A1-02 A1-03 ...]   (без аргументов — все)
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIN = {"vocab": 12, "sentences": 60, "gaps": 25, "quiz": 10}


def check(path: Path) -> list[str]:
    errs = []
    try:
        d = json.loads(path.read_text())
    except Exception as e:
        return [f"невалидный JSON: {e}"]
    if d.get("id") != path.stem:
        errs.append("id не совпадает с именем файла")
    for k in ("title", "topics", "theory", "vocab", "sentences", "gaps", "quiz"):
        if k not in d:
            errs.append(f"нет поля {k}")
    for k, n in MIN.items():
        if len(d.get(k, [])) < n:
            errs.append(f"{k}: {len(d.get(k, []))} < {n}")
    for i, t in enumerate(d.get("theory", [])):
        if not (t.get("h") and t.get("text")):
            errs.append(f"theory[{i}] без h/text")
    for i, v in enumerate(d.get("vocab", [])):
        if not (v.get("en") and v.get("ru")):
            errs.append(f"vocab[{i}] без en/ru")
    for i, s in enumerate(d.get("sentences", [])):
        if not (s.get("ru") and s.get("en")) or s.get("src") not in ("video", "extra"):
            errs.append(f"sentences[{i}] неполное: {s}")
        if not isinstance(s.get("alt", []), list):
            errs.append(f"sentences[{i}].alt не список")
    for i, g in enumerate(d.get("gaps", [])):
        if g.get("en", "").count("___") != 1:
            errs.append(f"gaps[{i}] должен содержать ровно один ___: {g.get('en')}")
        opts = g.get("options", [])
        if g.get("answer") not in opts or len(opts) < 3 or len(set(opts)) != len(opts):
            errs.append(f"gaps[{i}] answer должен быть среди 3+ уникальных options")
        if not g.get("ru"):
            errs.append(f"gaps[{i}] без ru")
    for i, q in enumerate(d.get("quiz", [])):
        opts = q.get("options", [])
        if len(opts) < 3 or not isinstance(q.get("answer"), int) or not 0 <= q["answer"] < len(opts):
            errs.append(f"quiz[{i}] некорректный answer/options")
    return errs


def main(ids):
    files = [ROOT / "data" / "lessons" / f"{i}.json" for i in ids] if ids else sorted((ROOT / "data" / "lessons").glob("*.json"))
    bad = 0
    for f in files:
        errs = ["файл не найден"] if not f.exists() else check(f)
        if errs:
            bad += 1
            print(f"✗ {f.stem}:", *errs[:10], sep="\n   ")
        else:
            d = json.loads(f.read_text())
            print(f"✓ {f.stem}: {len(d['sentences'])} предл., {len(d['gaps'])} пропусков, {len(d['quiz'])} тестов, {len(d['vocab'])} слов")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main(sys.argv[1:])
