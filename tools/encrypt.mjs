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

async function encryptFile(key, src, dst) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = readFileSync(src);
  JSON.parse(plain); // не шифруем битый JSON
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, Buffer.concat([iv, ct]));
}
async function decryptFile(key, src, dst) {
  const buf = readFileSync(src);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12));
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, Buffer.from(plain));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

async function main() {
const key = await importKey(secrets().contentKey);
mkdirSync(join(ENC, 'lessons'), { recursive: true });
rmSync(join(ENC, 'meta.json'), { force: true });

if (process.argv.includes('--decrypt')) {
  await decryptFile(key, join(ENC, 'index.bin'), join(DATA, 'index.json'));
  const files = readdirSync(join(ENC, 'lessons')).filter(f => f.endsWith('.bin'));
  for (const f of files) await decryptFile(key, join(ENC, 'lessons', f), join(DATA, 'lessons', f.replace(/\.bin$/, '.json')));
  console.log(`Расшифровано: index + ${files.length} уроков → data/`);
} else {
  await encryptFile(key, join(DATA, 'index.json'), join(ENC, 'index.bin'));
  const lessons = readdirSync(join(DATA, 'lessons')).filter(f => f.endsWith('.json'));
  const keep = new Set(lessons.map(f => f.replace(/\.json$/, '.bin')));
  for (const f of lessons) await encryptFile(key, join(DATA, 'lessons', f), join(ENC, 'lessons', f.replace(/\.json$/, '.bin')));
  for (const f of readdirSync(join(ENC, 'lessons'))) if (!keep.has(f)) rmSync(join(ENC, 'lessons', f));
  console.log(`Зашифровано: index + ${lessons.length} уроков → enc/`);
}
}
