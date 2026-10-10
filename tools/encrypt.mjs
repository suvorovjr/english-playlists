// Шифрует контент приложения: data/*.json → enc/*.bin (AES-256-GCM).
// В репозиторий и на GitHub Pages попадает только enc/. Ключ (contentKey) и код приглашения лежат
// в secrets.local.json (не публикуется); участникам ключ выдаёт Supabase после входа (функция content_key()).
//
//   node tools/encrypt.mjs            — зашифровать data/ → enc/
//   node tools/encrypt.mjs --decrypt  — восстановить data/ из enc/ (например, на новом компьютере)
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const ENC = join(ROOT, 'enc');
const SECRETS = join(ROOT, 'secrets.local.json');
const { subtle } = globalThis.crypto;
const b64 = buf => Buffer.from(buf).toString('base64');

export function secrets() {
  const s = existsSync(SECRETS) ? JSON.parse(readFileSync(SECRETS, 'utf8')) : {};
  let changed = false;
  if (!s.contentKey) { s.contentKey = b64(crypto.getRandomValues(new Uint8Array(32))); changed = true; }
  if (!s.inviteCode) {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    s.inviteCode = [...crypto.getRandomValues(new Uint8Array(8))].map(b => alphabet[b % alphabet.length]).join('');
    changed = true;
  }
  s.tz ||= 'Europe/Moscow';
  delete s.login; delete s.password;
  if (changed) { writeFileSync(SECRETS, JSON.stringify(s, null, 2) + '\n'); console.log(`Обновлён ${SECRETS}`); }
  return s;
}

const importKey = raw => subtle.importKey('raw', Buffer.from(raw, 'base64'), 'AES-GCM', false, ['encrypt', 'decrypt']);

// IV = SHA-256(ключ ‖ содержимое)[:12]: одинаковый файл → одинаковый шифротекст (нет лишних изменений в git),
// а один IV никогда не встречается с разным содержимым.
async function encryptFile(key, rawKey, src, dst, { json = true } = {}) {
  const plain = readFileSync(src);
  if (json) JSON.parse(plain); // не шифруем битый JSON
  const iv = new Uint8Array(await subtle.digest('SHA-256', Buffer.concat([Buffer.from(rawKey, 'base64'), plain]))).slice(0, 12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = Buffer.concat([iv, ct]);
  if (existsSync(dst) && readFileSync(dst).equals(out)) return;
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, out);
}
async function decryptFile(key, src, dst) {
  const buf = readFileSync(src);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12));
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, Buffer.from(plain));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

async function main() {
const rawKey = secrets().contentKey;
const key = await importKey(rawKey);
mkdirSync(join(ENC, 'lessons'), { recursive: true });
rmSync(join(ENC, 'meta.json'), { force: true });

const sync = async (srcDir, ext, dstDir, json) => {
  if (!existsSync(srcDir)) return 0;
  const files = readdirSync(srcDir).filter(f => f.endsWith(ext));
  const keep = new Set(files.map(f => f.slice(0, -ext.length) + '.bin'));
  for (const f of files) await encryptFile(key, rawKey, join(srcDir, f), join(dstDir, f.slice(0, -ext.length) + '.bin'), { json });
  if (existsSync(dstDir)) for (const f of readdirSync(dstDir)) if (!keep.has(f)) rmSync(join(dstDir, f));
  return files.length;
};
const unsync = async (srcDir, dstDir, ext) => {
  if (!existsSync(srcDir)) return 0;
  const files = readdirSync(srcDir).filter(f => f.endsWith('.bin'));
  for (const f of files) await decryptFile(key, join(srcDir, f), join(dstDir, f.replace(/\.bin$/, ext)));
  return files.length;
};

if (process.argv.includes('--decrypt')) {
  await decryptFile(key, join(ENC, 'index.bin'), join(DATA, 'index.json'));
  const n = await unsync(join(ENC, 'lessons'), join(DATA, 'lessons'), '.json');
  const a = await unsync(join(ENC, 'audio'), join(DATA, 'audio'), '.pack');
  console.log(`Расшифровано: index + ${n} уроков + ${a} аудиопакетов → data/`);
} else {
  await encryptFile(key, rawKey, join(DATA, 'index.json'), join(ENC, 'index.bin'));
  const n = await sync(join(DATA, 'lessons'), '.json', join(ENC, 'lessons'), true);
  const a = await sync(join(DATA, 'audio'), '.pack', join(ENC, 'audio'), false);
  console.log(`Зашифровано: index + ${n} уроков + ${a} аудиопакетов → enc/`);
}
}
