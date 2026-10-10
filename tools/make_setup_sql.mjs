// Собирает supabase/setup.local.sql = schema.sql + ваши секреты (код приглашения, ключ контента, часовой пояс).
// Этот файл выполняется один раз в Supabase → SQL Editor. Он содержит секреты и не публикуется.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secrets } from './encrypt.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const s = secrets();
const q = v => `'${String(v).replace(/'/g, "''")}'`;
const sql = readFileSync(join(ROOT, 'supabase', 'schema.sql'), 'utf8') + `
-- Ваши настройки
insert into public.app_config (k, v) values
  ('invite_code', ${q(s.inviteCode)}),
  ('content_key', ${q(s.contentKey)}),
  ('tz', ${q(s.tz)})
on conflict (k) do update set v = excluded.v;
`;
writeFileSync(join(ROOT, 'supabase', 'setup.local.sql'), sql);
console.log('Готово: supabase/setup.local.sql — выполните его в Supabase → SQL Editor.');
