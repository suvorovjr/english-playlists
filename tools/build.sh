#!/bin/sh
# Перед публикацией: обновить список уроков, проверить их и зашифровать в enc/.
set -e
cd "$(dirname "$0")/.."
python3 tools/build_index.py
python3 tools/validate.py > /dev/null || { python3 tools/validate.py | grep '✗' -A3; exit 1; }
node tools/encrypt.mjs
