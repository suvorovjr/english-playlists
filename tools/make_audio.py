"""Озвучивает уроки нейросетевым голосом (Kokoro) и собирает аудиопакеты data/audio/<ID>.pack.

Что озвучивается: английские фразы, слова, предложения из пропусков (с ответом), примеры конспекта
и отдельные слова для плиток.
Готовые клипы кэшируются в content_src/audio_cache/, поэтому повторный запуск озвучивает только новое.
Пакеты затем шифрует `node tools/encrypt.mjs` (→ enc/audio/<ID>.bin).

Подготовка (один раз):
  brew install espeak-ng ffmpeg
  python3 -m venv .tts && .tts/bin/pip install kokoro-onnx soundfile phonemizer-fork
  скачать kokoro-v1.0.onnx и voices-v1.0.bin из https://github.com/thewh1teagle/kokoro-onnx/releases

Запуск (щадящий режим: фоновый приоритет macOS, 2 потока):
  taskpolicy -b .tts/bin/python tools/make_audio.py <папка_с_моделью> [A1-01 A1-02 ...]
  Быстрее, но горячее: AUDIO_THREADS=8 .tts/bin/python tools/make_audio.py ...

Формат пакета: [4 байта — длина заголовка, big-endian][заголовок JSON {текст: [смещение, длина]}][mp3...]
"""
import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VOICE, LANG, SPEED = "af_heart", "en-us", 0.95
CACHE = ROOT / "content_src" / "audio_cache"
OUT = ROOT / "data" / "audio"
CYR = re.compile(r"[А-Яа-яЁё]")


def gap_full(g: dict) -> str:
    # та же сборка, что в app.js: (a + ответ + b), пробелы схлопнуты
    a, b = g["en"].split("___")
    ans = "" if g["answer"] == "—" else g["answer"]
    return re.sub(r"\s+", " ", a + ans + b).strip()


def lesson_texts(d: dict) -> list[str]:
    texts = [s["en"] for s in d["sentences"]] + [v["en"] for v in d["vocab"]]
    texts += [gap_full(g) for g in d["gaps"]]
    texts += [ex[0] for t in d["theory"] for ex in t.get("ex", [])]
    # отдельные слова для плиток (в нижнем регистре — так их ищет приложение)
    texts += [w.lower() for s in d["sentences"] for w in re.sub(r'[.!?;:"«»(),]', " ", s["en"]).split()]
    seen, out = set(), []
    for t in texts:
        t = t.strip()
        if t and t not in seen and not CYR.search(t):
            seen.add(t)
            out.append(t)
    return out


def clip_path(text: str) -> Path:
    h = hashlib.sha1(f"{VOICE}|{SPEED}|{text}".encode()).hexdigest()
    return CACHE / h[:2] / f"{h}.mp3"


def speakable(text: str) -> str:
    # «sb/sth» и скобки читаются плохо — упрощаем только для синтеза, ключ остаётся исходным
    t = re.sub(r"\bsb\b", "somebody", re.sub(r"\bsth\b", "something", text))
    return re.sub(r"[()]", "", t)


def synth(kokoro, text: str, dst: Path):
    audio, sr = kokoro.create(speakable(text), voice=VOICE, speed=SPEED, lang=LANG)
    pcm = (audio.clip(-1, 1) * 32767).astype("<i2").tobytes()
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "s16le", "-ar", str(sr), "-ac", "1", "-i", "-",
         "-codec:a", "libmp3lame", "-b:a", "32k", str(dst)],
        input=pcm, check=True,
    )


def pack(texts: list[str], dst: Path):
    index, blobs, off = {}, [], 0
    for t in texts:
        b = clip_path(t).read_bytes()
        index[t] = [off, len(b)]
        blobs.append(b)
        off += len(b)
    head = json.dumps(index, ensure_ascii=False).encode()
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(struct.pack(">I", len(head)) + head + b"".join(blobs))


def load_kokoro(model_dir: Path):
    import onnxruntime as rt
    from kokoro_onnx import EspeakConfig, Kokoro

    # мало потоков — Mac не греется (запускайте ещё и через `taskpolicy -b`, тогда только E-ядра)
    opts = rt.SessionOptions()
    opts.intra_op_num_threads = int(os.getenv("AUDIO_THREADS", "2"))
    opts.inter_op_num_threads = 1
    session = rt.InferenceSession(str(model_dir / "kokoro-v1.0.onnx"), opts, providers=["CPUExecutionProvider"])
    return Kokoro.from_session(session, str(model_dir / "voices-v1.0.bin"),
                               espeak_config=EspeakConfig(lib_path="/opt/homebrew/lib/libespeak-ng.dylib",
                                                          data_path="/opt/homebrew/share/espeak-ng-data"))


def main(model_dir: Path, ids: list[str]):
    files = [ROOT / "data" / "lessons" / f"{i}.json" for i in ids] if ids else sorted((ROOT / "data" / "lessons").glob("*.json"))
    plan = [(f.stem, lesson_texts(json.loads(f.read_text()))) for f in files]
    todo = {t for _, ts in plan for t in ts if not clip_path(t).exists()}
    print(f"уроков: {len(plan)}, клипов: {sum(len(ts) for _, ts in plan)}, озвучить: {len(todo)}", flush=True)
    kokoro, start, done = None, time.time(), 0
    # урок за уроком: каждый упаковывается сразу, как только готов, — публиковать можно частями
    for lid, ts in plan:
        for t in ts:
            if clip_path(t).exists():
                continue
            kokoro = kokoro or load_kokoro(model_dir)
            try:
                synth(kokoro, t, clip_path(t))
            except Exception as e:  # одна неудачная фраза не должна ронять весь прогон
                print(f"  ошибка: {t!r}: {e}", flush=True)
            done += 1
        pack([t for t in ts if clip_path(t).exists()], OUT / f"{lid}.pack")
        if done:
            el = time.time() - start
            print(f"  {lid} готов · {done}/{len(todo)} · {el / 60:.0f} мин · осталось ~{el / done * (len(todo) - done) / 60:.0f} мин", flush=True)
    total = sum(p.stat().st_size for p in OUT.glob("*.pack"))
    print(f"готово: {len(plan)} пакетов, {total / 1e6:.1f} МБ", flush=True)


if __name__ == "__main__":
    main(Path(sys.argv[1]), sys.argv[2:])
