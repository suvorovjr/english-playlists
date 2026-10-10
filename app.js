'use strict';

/* ============================================================
   English по плейлистам — уроки + упражнения в стиле Duolingo
   ============================================================ */

const LEVEL_NAMES = ['Знакомство', 'Основа', 'Закрепление', 'Перевод', 'Мастер'];
const MAX_LEVEL = 5;
const DAY = 864e5;
// интервалы повторения (в днях) по «силе» элемента 0..7
const INTERVALS = [0.007, 1, 2, 4, 7, 15, 30, 60];
// до какой силы может поднять элемент упражнение данного типа (лёгкие задания не дают «выучить» фразу)
const KIND_CAP = {
  vocabChoice: 3, match: 3, choiceEnRu: 2, gapChoice: 3, quiz: 7, tilesRuEn: 3, tilesListen: 4,
  speakRead: 3, gapType: 7, typeRuEn: 7, typeListen: 7, speakTrans: 7,
};
// план тренировки: [тип, количество] для каждого уровня урока
const PLAN = {
  1: [['vocabChoice', 3], ['match', 2], ['choiceEnRu', 2], ['gapChoice', 3], ['quiz', 2], ['tilesRuEn', 4]],
  2: [['match', 1], ['gapChoice', 3], ['quiz', 2], ['tilesRuEn', 5], ['tilesListen', 3], ['speakRead', 2]],
  3: [['gapType', 4], ['tilesRuEn', 3], ['typeRuEn', 4], ['tilesListen', 2], ['quiz', 1], ['speakRead', 1], ['speakTrans', 1]],
  4: [['typeRuEn', 6], ['gapType', 3], ['typeListen', 3], ['speakTrans', 2], ['quiz', 2]],
  5: [['typeRuEn', 8], ['typeListen', 3], ['gapType', 2], ['speakTrans', 3]],
};
const SPEAK_KINDS = new Set(['speakRead', 'speakTrans']);
const KIND_TITLE = {
  vocabChoice: 'Выберите перевод', match: 'Найдите пары', choiceEnRu: 'Что означает это предложение?',
  gapChoice: 'Заполните пропуск', gapType: 'Впишите пропущенное', quiz: 'Выберите правильный ответ',
  tilesRuEn: 'Переведите предложение', tilesListen: 'Соберите то, что услышали', typeRuEn: 'Напишите по-английски',
  typeListen: 'Напишите, что услышали', speakRead: 'Прочитайте вслух', speakTrans: 'Скажите по-английски',
};

/* ---------------- баллы ---------------- */
// баллы за верный ответ с первой попытки (после ошибки — 1 балл); видео баллов не даёт
const POINTS = {
  vocabChoice: 1, choiceEnRu: 1, gapChoice: 1, quiz: 2, match: 3, tilesRuEn: 2, tilesListen: 2,
  speakRead: 2, gapType: 3, typeRuEn: 3, typeListen: 3, speakTrans: 3,
};
const BONUS_DONE = 5, BONUS_PERFECT = 5, MAX_FREEZES = 2;

/* ---------------- storage ----------------
   Прогресс лежит в localStorage (отдельно для каждого пользователя) и синхронизируется с Supabase. */
const defaults = () => ({
  xp: 0, streak: 0, longest: 0, lastDay: null, freezes: 0, days: {}, today: { date: null, xp: 0 }, last: null,
  lessons: {}, items: {}, updatedAt: 0,
  settings: { goal: 30, tts: true, speech: true, sfx: true, tab: 'A1', theme: 'auto', speechPauseUntil: 0, voice: '' },
});
function normalize(raw) {
  const d = defaults();
  return raw ? { ...d, ...raw, days: raw.days || {}, settings: { ...d.settings, ...raw.settings } } : d;
}
const storeKey = () => `eg-progress-v2:${AUTH?.user?.id || 'guest'}`;
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey()));
    if (raw) return normalize(raw);
    const old = JSON.parse(localStorage.getItem('eg-progress-v1')); // прогресс до появления аккаунтов
    if (old) { localStorage.removeItem('eg-progress-v1'); return normalize(old); }
  } catch (e) { /* пусто или недоступно */ }
  return defaults();
}
let syncTimer = null;
function save(sync = true) {
  P.updatedAt = Date.now();
  try { localStorage.setItem(storeKey(), JSON.stringify(P)); } catch (e) { /* приватный режим */ }
  if (sync) { clearTimeout(syncTimer); syncTimer = setTimeout(pushProgress, 20000); }
}
const dayKey = (t = Date.now()) => new Date(t).toLocaleDateString('sv');
const keyTime = k => new Date(k + 'T12:00:00').getTime();
const daysBetween = (a, b) => Math.round((keyTime(b) - keyTime(a)) / DAY);
function todayXP() { return P.today.date === dayKey() ? P.today.xp : 0; }
function addPoints(n) {
  const today = dayKey();
  if (P.today.date !== today) P.today = { date: today, xp: 0 };
  P.today.xp += n;
  P.xp += n;
  queuePoints(n);
}
const lessonState = id => (P.lessons[id] ||= { level: 0, watched: false, sessions: 0 });
function applyTheme() {
  const t = P.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
}

/* ---------------- ударный режим ---------------- */
/** состояние серии сейчас: n — длина, doneToday, needFreeze — сколько заморозок спишется, lost — сгоревшая серия */
function streakInfo() {
  if (!P.lastDay || !P.streak) return { n: 0, doneToday: false };
  const gap = daysBetween(P.lastDay, dayKey());
  if (gap <= 0) return { n: P.streak, doneToday: true };
  const missed = gap - 1;
  if (missed <= P.freezes) return { n: P.streak, doneToday: false, needFreeze: missed };
  return { n: 0, doneToday: false, lost: P.streak };
}
/** засчитать сегодняшний день; null — если сегодня уже засчитан */
function extendStreak() {
  const today = dayKey();
  if (P.lastDay === today) return null;
  const info = streakInfo();
  let usedFreeze = 0, gotFreeze = false;
  if (info.n > 0) {
    usedFreeze = info.needFreeze || 0;
    for (let i = 1; i <= usedFreeze; i++) P.days[dayKey(keyTime(P.lastDay) + i * DAY)] = 'frozen';
    P.freezes -= usedFreeze;
    P.streak += 1;
  } else P.streak = 1;
  P.lastDay = today;
  P.days[today] = 'done';
  if (P.streak % 7 === 0 && P.freezes < MAX_FREEZES) { P.freezes++; gotFreeze = true; }
  P.longest = Math.max(P.longest || 0, P.streak);
  const cutoff = dayKey(Date.now() - 120 * DAY);
  for (const k of Object.keys(P.days)) if (k < cutoff) delete P.days[k];
  return { streak: P.streak, usedFreeze, gotFreeze, lost: info.lost };
}
function weekHTML() {
  const names = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const noon = keyTime(dayKey());
  const dow = (new Date(noon).getDay() + 6) % 7;
  return `<div class="week">${names.map((n, i) => {
    const k = dayKey(noon + (i - dow) * DAY), st = P.days[k];
    const cls = st === 'done' ? 'done' : st === 'frozen' ? 'frozen' : i === dow ? 'today' : i < dow ? 'miss' : '';
    return `<div class="wd ${cls}"><span>${n}</span><b>${st === 'done' ? '🔥' : st === 'frozen' ? '❄️' : ''}</b></div>`;
  }).join('')}</div>`;
}
function daysWord(n) { return plural(n, 'день', 'дня', 'дней'); }

/* ---------------- Supabase: аккаунты, баллы, синхронизация ---------------- */
const CFG = window.APP_CONFIG || {};
const AUTH_STORE = 'eg-auth-v1';
const KEY_STORE = 'eg-key-v2';
let AUTH = (() => { try { return JSON.parse(localStorage.getItem(AUTH_STORE)); } catch (e) { return null; } })();
let KEY = null;
let P = load();
const loginToEmail = login => `${login.trim().toLowerCase()}@${CFG.emailDomain || 'players.english-app.local'}`;
function persistAuth() { try { AUTH ? localStorage.setItem(AUTH_STORE, JSON.stringify(AUTH)) : localStorage.removeItem(AUTH_STORE); } catch (e) { /* ok */ } }
function setSession(d) {
  const same = AUTH?.user?.id === d.user.id;
  AUTH = {
    access_token: d.access_token, refresh_token: d.refresh_token,
    expires_at: d.expires_at || Math.floor(Date.now() / 1000) + d.expires_in, user: { id: d.user.id },
    username: same ? AUTH.username : undefined, pendingLogin: same ? AUTH.pendingLogin : undefined,
  };
  persistAuth();
}
async function sb(path, { body, auth = true } = {}) {
  if (!CFG.supabaseUrl || !CFG.supabaseKey) throw Object.assign(new Error('Сервер не настроен: заполните config.js'), { code: 'no_config' });
  if (auth) await ensureFresh();
  let r;
  try {
    r = await fetch(CFG.supabaseUrl.replace(/\/$/, '') + path, {
      method: 'POST',
      // новые publishable-ключи — не JWT, поэтому Authorization шлём только с токеном пользователя
      headers: { apikey: CFG.supabaseKey, 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${AUTH.access_token}` } : {}) },
      body: JSON.stringify(body || {}),
    });
  } catch (e) { throw Object.assign(new Error('Нет соединения'), { offline: true }); }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!r.ok) {
    const msg = data?.message || data?.msg || data?.error_description || data?.error || r.statusText;
    throw Object.assign(new Error(msg), { status: r.status, code: data?.error_code || data?.code });
  }
  return data;
}
async function ensureFresh() {
  if (!AUTH) throw Object.assign(new Error('Нужно войти'), { auth: true });
  if (AUTH.expires_at - 60 > Date.now() / 1000) return;
  try {
    setSession(await sb('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: AUTH.refresh_token }, auth: false }));
  } catch (e) {
    if (!e.offline) { logout(); e.auth = true; }
    throw e;
  }
}
const rpc = (fn, args = {}) => sb(`/rest/v1/rpc/${fn}`, { body: args });

const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function loadStoredKey() {
  try {
    const raw = localStorage.getItem(KEY_STORE);
    if (raw && AUTH) KEY = await crypto.subtle.importKey('raw', fromB64(raw), 'AES-GCM', false, ['decrypt']);
  } catch (e) { KEY = null; }
}
/** после входа: проверить участие, получить ключ уроков, подтянуть прогресс */
async function afterLogin() {
  const me = await rpc('me');
  if (!me.member) return false;
  AUTH.username = me.username; persistAuth();
  const raw = await rpc('content_key');
  KEY = await crypto.subtle.importKey('raw', fromB64(raw), 'AES-GCM', false, ['decrypt']);
  try { localStorage.setItem(KEY_STORE, raw); } catch (e) { /* ok */ }
  P = load();
  await pullProgress();
  return true;
}
function logout() {
  clearTimeout(syncTimer);
  for (const k of [AUTH_STORE, KEY_STORE]) try { localStorage.removeItem(k); } catch (e) { /* ok */ }
  AUTH = null; KEY = null; INDEX = null; LEAGUE = null;
  for (const k in LESSONS) delete LESSONS[k];
  P = load();
}
async function pullProgress() {
  try {
    const server = await rpc('load_progress');
    if (server && (server.updatedAt || 0) > (P.updatedAt || 0)) { P = normalize(server); save(false); return true; }
    if (P.updatedAt) pushProgress();
  } catch (e) { /* офлайн — работаем с локальным */ }
  return false;
}
async function pushProgress() {
  clearTimeout(syncTimer);
  if (!AUTH) return;
  try { await rpc('save_progress', { p_data: P }); } catch (e) { /* повторим позже */ }
}
// баллы копятся локально и отправляются пачками (переживает офлайн)
const pendingKey = () => `eg-pending:${AUTH?.user?.id}`;
const getPending = () => { try { return +localStorage.getItem(pendingKey()) || 0; } catch (e) { return 0; } };
const setPending = n => { try { localStorage.setItem(pendingKey(), String(n)); } catch (e) { /* ok */ } };
let flushTimer = null, flushing = false;
function queuePoints(n) {
  if (!AUTH) return;
  setPending(getPending() + n);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushPoints, 1500);
}
async function flushPoints() {
  if (flushing || !AUTH) return;
  flushing = true;
  try {
    let left = getPending();
    while (left > 0) {
      const chunk = Math.min(60, left);
      await rpc('add_points', { p: chunk });
      left -= chunk;
      setPending(getPending() - chunk);
      LEAGUE = null;
    }
  } catch (e) { /* офлайн — отправим позже */ }
  flushing = false;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && AUTH) { save(false); pushProgress(); flushPoints(); }
});
window.addEventListener('online', () => flushPoints());

/* ---------------- контент (зашифрован, ключ выдаёт сервер участникам) ---------------- */
let INDEX = null;
const LESSONS = {};
async function fetchEncRaw(path) {
  const r = await fetch(`enc/${path}.bin`);
  if (!r.ok) throw new Error(r.status === 404 ? 'Урок не найден' : 'Нет соединения');
  const buf = new Uint8Array(await r.arrayBuffer());
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, KEY, buf.slice(12))); }
  catch (e) { throw Object.assign(new Error('Ключ устарел'), { badKey: true }); }
}
async function fetchEnc(path) {
  return JSON.parse(new TextDecoder().decode(await fetchEncRaw(path)));
}
async function getIndex() {
  if (!INDEX) INDEX = await fetchEnc('index');
  return INDEX;
}
async function getLesson(id) {
  if (!LESSONS[id]) LESSONS[id] = await fetchEnc(`lessons/${id}`);
  loadAudio(id);
  return LESSONS[id];
}

/* ---------------- вход и регистрация ---------------- */
function authError(e) {
  const m = `${e.code || ''} ${e.message || ''}`.toLowerCase();
  if (e.offline) return 'Нет соединения с сервером';
  if (e.code === 'no_config') return e.message;
  if (m.includes('invalid login') || m.includes('invalid_credentials')) return 'Неверный логин или пароль';
  if (m.includes('already') || m.includes('username_taken')) return 'Этот логин уже занят';
  if (m.includes('bad_invite')) return 'Неверный код приглашения';
  if (m.includes('username_check')) return 'Логин: 3–20 символов — латиница, цифры или _';
  if (m.includes('password') && (m.includes('6') || m.includes('weak') || m.includes('short'))) return 'Пароль слишком короткий (минимум 6 символов)';
  if (m.includes('email')) return 'Ошибка регистрации: проверьте, что в Supabase отключено подтверждение email';
  return 'Ошибка: ' + e.message;
}
function screenAuth(mode = 'login', msg = '') {
  const reg = mode === 'register', inv = mode === 'invite';
  app().innerHTML = `<form class="login" id="authForm" autocomplete="on">
    <img src="icons/icon.svg" alt="" width="72" height="72">
    <h2>${inv ? 'Почти готово' : reg ? 'Регистрация' : 'English по плейлистам'}</h2>
    <p class="muted small">${inv ? 'Введите код приглашения, который прислал друг' : reg ? 'Нужен код приглашения от друга' : 'Учим английский и соревнуемся с друзьями'}</p>
    ${inv ? '' : `<input class="answer" name="username" id="lg" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Логин (латиница, цифры, _)" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}">
    <input class="answer" name="password" id="pw" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" placeholder="Пароль" required minlength="6">`}
    ${reg || inv ? '<input class="answer" id="inv" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="Код приглашения" required>' : ''}
    <div class="login-err" id="err">${esc(msg)}</div>
    <button class="btn primary block" id="go">${inv ? 'Продолжить' : reg ? 'Создать аккаунт' : 'Войти'}</button>
    ${inv ? '<button type="button" class="btn ghost" id="alt">Выйти</button>'
      : `<button type="button" class="btn ghost" id="alt">${reg ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Регистрация'}</button>`}
  </form>`;
  $('#alt').onclick = () => { if (inv) logout(); screenAuth(inv ? 'login' : reg ? 'login' : 'register'); };
  $('#authForm').onsubmit = async e => {
    e.preventDefault();
    const btn = $('#go'), label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Подождите…'; $('#err').textContent = '';
    try {
      const login = inv ? AUTH.pendingLogin : $('#lg').value.trim().toLowerCase();
      if (!inv) {
        const password = $('#pw').value;
        const creds = { email: loginToEmail(login), password };
        if (reg) {
          try {
            const d = await sb('/auth/v1/signup', { body: creds, auth: false });
            if (!d.access_token) throw new Error('email confirmation required');
            setSession(d);
          } catch (err) {
            // аккаунт мог остаться от прошлой попытки с неверным кодом — пробуем войти тем же паролем
            if (!/already/i.test(err.message)) throw err;
            setSession(await sb('/auth/v1/token?grant_type=password', { body: creds, auth: false }));
          }
        } else {
          setSession(await sb('/auth/v1/token?grant_type=password', { body: creds, auth: false }));
        }
        AUTH.pendingLogin = login; persistAuth();
      }
      if (reg || inv) await rpc('register', { p_username: login, p_invite: $('#inv').value.trim().toUpperCase() });
      if (await afterLogin()) { location.hash = '#/'; route(); }
      else screenAuth('invite');
    } catch (err) {
      $('#err').textContent = authError(err);
      btn.disabled = false; btn.textContent = label;
    }
  };
}

function metaOf(id) {
  for (const lv of INDEX.levels) for (const l of lv.lessons) if (l.id === id) return { ...l, level: lv.id };
  return null;
}

/* ---------------- helpers ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a, n) => shuffle(a).slice(0, n);
const wc = s => s.trim().split(/\s+/).length;
const app = () => $('#app');

/* ---------------- answer checking ---------------- */
const CONTRACT = [
  [/\bcan not\b|\bcannot\b/g, "can't"], [/\bwill not\b/g, "won't"], [/\bshall not\b/g, "shan't"],
  [/\b(do|does|did|is|are|was|were|have|has|had|would|could|should|must|need|might)\s+not\b/g, "$1n't"],
  [/\bi am\b/g, "i'm"], [/\b(you|we|they)\s+are\b/g, "$1're"],
  [/\b(he|she|it|that|there|what|who|where|how|here)\s+(is|has)\b/g, "$1's"],
  [/\b(i|you|we|they)\s+have\b/g, "$1've"],
  [/\b(i|you|we|they|he|she|it|that|there)\s+will\b/g, "$1'll"],
  [/\b(i|you|we|they|he|she|it)\s+(would|had)\b/g, "$1'd"],
  [/\blet us\b/g, "let's"],
  [/\b(\w+)'s not\b/g, "$1 isn't"], [/\b(you|we|they)'re not\b/g, "$1 aren't"],
  [/\bo'clock\b/g, 'oclock'], [/\bok\b/g, 'okay'],
];
function canon(s) {
  s = String(s).toLowerCase().replace(/[’‘`´]/g, "'").replace(/\$(\d+)/g, '$1 dollars')
    .replace(/[^a-z0-9'\s]/g, ' ').replace(/(^|\s)'+|'+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, rep] of CONTRACT) s = s.replace(re, rep);
  return s.replace(/\s+/g, ' ').trim();
}
function damerau(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const CONFUSABLE = new Set("were where then than live life lose loose quite quiet advice advise much many some same does dose four for too two their there they them this these those that what want went work word walk sit seat house hose leave feel fill sleep slip buy by bye its it's who whom whose your you're bring brought think thing".split(' '));
const stem = w => w.replace(/(ing|ed|es|s|d|'s|'d|'ll|'ve|'re|n't)$/, '');
function typoish(a, b) {
  if (b.length < 4 || CONFUSABLE.has(a) || CONFUSABLE.has(b)) return false;
  if (stem(a) === stem(b)) return false; // окончание = грамматика, а не опечатка
  return damerau(a, b) === 1;
}
function lcs(a, b) {
  const d = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    d[i][j] = a[i] === b[j] ? d[i + 1][j + 1] + 1 : Math.max(d[i + 1][j], d[i][j + 1]);
  return d;
}
/** проверка ответа: targets — список правильных вариантов */
function check(input, targets, { typos = true, fuzzy = 0 } = {}) {
  const c = canon(input);
  if (!c) return { ok: false, target: targets[0] };
  // «I've got a car» = «I have a car»
  const noGot = c.replace(/\b(i've|you've|we've|they've|he's|she's|it's) got\b/g, '$1');
  for (const t of targets) { const ct = canon(t); if (ct === c || (!/\bgot\b/.test(ct) && ct === noGot)) return { ok: true, target: t }; }
  const cw = c.split(' ');
  if (typos) for (const t of targets) {
    const tw = canon(t).split(' ');
    if (tw.length !== cw.length) continue;
    const diffs = tw.map((w, i) => [cw[i], w]).filter(([x, y]) => x !== y);
    if (diffs.length <= Math.max(1, Math.floor(tw.length / 6)) && diffs.every(([x, y]) => typoish(x, y)))
      return { ok: true, typo: true, target: t };
  }
  // ближайший вариант — для показа правильного ответа (и нечёткого зачёта речи)
  let best = targets[0], bestScore = -1;
  for (const t of targets) {
    const tw = canon(t).split(' ');
    const score = lcs(cw, tw)[0][0] / Math.max(tw.length, cw.length);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  if (fuzzy && bestScore >= fuzzy) return { ok: true, fuzzy: true, target: best };
  return { ok: false, target: best };
}
/** подсветить слова правильного ответа, которых не было в ответе пользователя */
function diffHTML(input, target) {
  const tokens = target.split(/\s+/);
  const tw = tokens.map(t => canon(t));
  const uw = canon(input).split(' ').filter(Boolean);
  if (!uw.length) return esc(target);
  const d = lcs(tw, uw);
  const keep = new Set();
  let i = 0, j = 0;
  while (i < tw.length && j < uw.length) {
    if (tw[i] === uw[j]) { keep.add(i); i++; j++; } else if (d[i + 1][j] >= d[i][j + 1]) i++; else j++;
  }
  return tokens.map((t, k) => keep.has(k) || !tw[k] ? esc(t) : `<span class="miss">${esc(t)}</span>`).join(' ');
}

/* ---------------- audio ----------------
   Основной голос — нейросетевой (Kokoro, af_heart): фразы урока озвучены заранее и лежат
   зашифрованными пакетами enc/audio/<ID>.bin. Чего нет в пакете — читает системный синтезатор. */
const PACKS = {};   // id → Promise<pack|null>
const LOADED = {};  // id → pack { index: {текст: [смещение, длина]}, bytes, urls }
const player = new Audio();
player.preload = 'auto';
function loadAudio(id) {
  PACKS[id] ||= fetchEncRaw(`audio/${id}`).then(buf => {
    const n = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
    const pack = { index: JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + n))), bytes: buf.subarray(4 + n), urls: {} };
    return (LOADED[id] = pack);
  }).catch(() => { delete PACKS[id]; return null; });
  return PACKS[id];
}
/** дождаться пакетов, но не дольше ms — без сети тренировка не должна зависать */
const audioReady = (ids, ms = 4000) => Promise.race([Promise.all(ids.map(loadAudio)), new Promise(r => setTimeout(r, ms))]);
function clipURL(text) {
  const key = text.trim();
  for (const p of Object.values(LOADED)) {
    const r = p.index[key];
    if (r) return (p.urls[key] ||= URL.createObjectURL(new Blob([p.bytes.subarray(r[0], r[0] + r[1])], { type: 'audio/mpeg' })));
  }
  return null;
}
// iOS разрешает программный play() только элементу, который уже играл по касанию — «разблокируем» его
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
document.addEventListener('pointerdown', () => { if (!player.src) { player.src = SILENT; player.play().catch(() => {}); } }, { once: true, capture: true });

let voices = [];
function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  voices = speechSynthesis.getVoices().filter(v => /^en[-_]/i.test(v.lang));
}
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
function pickVoice() {
  if (P.settings.voice) { const v = voices.find(v => v.name === P.settings.voice); if (v) return v; }
  const pref = ['Premium', 'Enhanced', 'Natural', 'Neural', 'Samantha', 'Google US English', 'Microsoft Aria', 'Karen', 'Daniel'];
  for (const name of pref) { const v = voices.find(v => v.name.includes(name) && /en[-_]US/i.test(v.lang)) || voices.find(v => v.name.includes(name)); if (v) return v; }
  return voices.find(v => /en[-_]US/i.test(v.lang)) || voices[0];
}
function sysSay(text, rate) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) u.voice = v;
  u.lang = v?.lang || 'en-US';
  u.rate = rate;
  speechSynthesis.speak(u);
}
/** озвучить: rate < 0.8 — медленно; clipOnly — только если есть нейросетевая запись */
function say(text, rate = 1, { clipOnly = false } = {}) {
  if (!text) return;
  const url = !P.settings.voice && clipURL(text);
  if (!url && clipOnly) return;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  player.pause();
  if (!url) return sysSay(text, rate < 0.8 ? 0.6 : 0.95);
  player.src = url;
  player.preservesPitch = true;
  player.playbackRate = rate < 0.8 ? 0.7 : 1;
  player.play().catch(() => sysSay(text, rate < 0.8 ? 0.6 : 0.95));
}
let actx;
function sfx(ok) {
  if (!P.settings.sfx) return;
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    const notes = ok ? [660, 880] : [220, 180];
    notes.forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = ok ? 'sine' : 'triangle'; o.frequency.value = f;
      const t = actx.currentTime + i * 0.09;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.18);
    });
  } catch (e) { /* без звука */ }
  if (!ok && navigator.vibrate) navigator.vibrate(60);
}

/* ---------------- speech recognition ---------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const speechAvailable = () => !!SR && P.settings.speech && Date.now() > (P.settings.speechPauseUntil || 0);
let recog = null;
function listen(onInterim) {
  return new Promise((resolve, reject) => {
    const r = new SR();
    recog = r;
    r.lang = 'en-US'; r.interimResults = true; r.maxAlternatives = 5; r.continuous = false;
    let finals = [];
    r.onresult = e => {
      const res = e.results[e.results.length - 1];
      onInterim?.(res[0].transcript);
      if (res.isFinal) finals = [...res].map(a => a.transcript);
    };
    r.onerror = e => { recog = null; reject(e.error || 'error'); };
    r.onend = () => { recog = null; resolve(finals); };
    r.start();
  });
}

/* ---------------- spaced repetition ---------------- */
const itemOf = key => P.items[key];
function grade(key, ok, kind) {
  const st = P.items[key] || { s: 0, due: 0, n: 0, w: 0 };
  st.n++;
  if (ok) st.s = Math.max(st.s, Math.min(KIND_CAP[kind] ?? 7, st.s + 1));
  else { st.w++; st.s = Math.max(0, st.s - 2); }
  st.due = Date.now() + INTERVALS[st.s] * DAY;
  P.items[key] = st;
}
function lessonMastery(L) {
  const keys = [...L.sentences.map((_, i) => `${L.id}|s|${i}`), ...L.gaps.map((_, i) => `${L.id}|g|${i}`), ...L.vocab.map((_, i) => `${L.id}|v|${i}`)];
  const strong = keys.filter(k => (itemOf(k)?.s || 0) >= 4).length;
  return Math.round(100 * strong / keys.length);
}
function dueKeys() {
  const now = Date.now();
  return Object.entries(P.items).filter(([, st]) => st.due <= now).sort((a, b) => a[1].s - b[1].s || a[1].due - b[1].due).map(([k]) => k);
}

/* ---------------- task building ---------------- */
const pools = {
  vocabChoice: 'v', match: 'v', choiceEnRu: 's', gapChoice: 'g', gapType: 'g', quiz: 'q',
  tilesRuEn: 's', tilesListen: 's', typeRuEn: 's', typeListen: 's', speakRead: 's', speakTrans: 's',
};
const listOf = (L, t) => ({ s: L.sentences, g: L.gaps, q: L.quiz, v: L.vocab }[t]);
function fallbackKind(kind) {
  if (!SPEAK_KINDS.has(kind) || speechAvailable()) return kind;
  return kind === 'speakRead' ? 'tilesListen' : 'typeRuEn';
}
/** выбрать индексы элементов: сначала невиданные и слабые */
function chooseItems(L, t, n, used, filter) {
  const list = listOf(L, t);
  let idx = list.map((_, i) => i).filter(i => !used.has(`${t}${i}`) && (!filter || filter(list[i])));
  if (idx.length < n && filter) idx = list.map((_, i) => i).filter(i => !used.has(`${t}${i}`));
  const score = i => { const st = itemOf(`${L.id}|${t}|${i}`); return (st ? st.s + 1 : 0) + Math.random() * 1.5; };
  const chosen = idx.map(i => [i, score(i)]).sort((a, b) => a[1] - b[1]).slice(0, n).map(([i]) => i);
  chosen.forEach(i => used.add(`${t}${i}`));
  return chosen;
}
function buildLessonSession(L, level) {
  const used = new Set();
  const tasks = [];
  for (let [kind, n] of PLAN[level]) {
    kind = fallbackKind(kind);
    const t = pools[kind];
    if (kind === 'match') {
      for (let k = 0; k < n; k++) {
        const ids = chooseItems(L, 'v', 5, used);
        if (ids.length >= 3) tasks.push({ kind, L, ids, keys: ids.map(i => `${L.id}|v|${i}`) });
      }
      continue;
    }
    let filter = null;
    if (t === 's' && level <= 2) filter = s => wc(s.en) <= 9;
    if (t === 's' && level <= 1) filter = s => wc(s.en) <= 7;
    if (kind === 'speakRead' || kind === 'speakTrans') filter = s => wc(s.en) <= 12;
    for (const i of chooseItems(L, t, n, used, filter)) tasks.push({ kind, L, i, key: `${L.id}|${t}|${i}` });
  }
  // match и знакомство со словами — в начало, остальное перемешать
  const head = tasks.filter(t => t.kind === 'vocabChoice' || t.kind === 'match');
  return [...head, ...shuffle(tasks.filter(t => !head.includes(t)))];
}
function kindForReview(t, s) {
  if (t === 'v') return s < 3 ? 'vocabChoice' : 'match';
  if (t === 'g') return s < 3 ? 'gapChoice' : 'gapType';
  if (t === 'q') return 'quiz';
  const opts = s < 2 ? ['tilesRuEn', 'tilesListen'] : s < 4 ? ['tilesRuEn', 'typeRuEn', 'tilesListen', 'speakRead'] : ['typeRuEn', 'typeRuEn', 'typeListen', 'speakTrans'];
  return fallbackKind(opts[Math.random() * opts.length | 0]);
}
async function buildReviewSession(keys) {
  const tasks = [];
  const vocabByLesson = {};
  for (const key of keys) {
    const [id, t, si] = key.split('|');
    let L;
    try { L = await getLesson(id); } catch (e) { continue; }
    const i = +si;
    if (!listOf(L, t)?.[i]) continue;
    const kind = kindForReview(t, itemOf(key)?.s || 0);
    if (kind === 'match') { (vocabByLesson[id] ||= { L, ids: [] }).ids.push(i); continue; }
    tasks.push({ kind, L, i, key });
  }
  for (const { L, ids } of Object.values(vocabByLesson)) {
    for (let k = 0; k < ids.length; k += 5) {
      const chunk = ids.slice(k, k + 5);
      if (chunk.length >= 3) tasks.push({ kind: 'match', L, ids: chunk, keys: chunk.map(i => `${L.id}|v|${i}`) });
      else chunk.forEach(i => tasks.push({ kind: 'vocabChoice', L, i, key: `${L.id}|v|${i}` }));
    }
  }
  return shuffle(tasks);
}

/* ============================================================
   Screens
   ============================================================ */
function topbar() {
  const st = streakInfo();
  const goal = Math.min(100, Math.round(100 * todayXP() / P.settings.goal));
  return `<header class="topbar">
    <span class="stat fire ${st.doneToday ? '' : 'off'}" title="Ударный режим: дней подряд">🔥 ${st.n}</span>
    <div class="goal" title="Цель дня: ${todayXP()}/${P.settings.goal} баллов"><i style="width:${goal}%"></i></div>
    <span class="stat xp" title="Всего баллов">⚡ ${P.xp}</span>
    <a class="icon-btn" href="#/league" aria-label="Турнир">🏆</a>
    <a class="icon-btn" href="#/settings" aria-label="Настройки">⚙️</a>
  </header>`;
}

async function screenHome() {
  await getIndex();
  const tab = P.settings.tab;
  const level = INDEX.levels.find(l => l.id === tab) || INDEX.levels[0];
  const due = dueKeys().length;
  const lastMeta = P.last && metaOf(P.last);
  const firstOpenRow = level.lessons.find(l => l.ready && (P.lessons[l.id]?.level || 0) < MAX_LEVEL);
  const firstOpen = firstOpenRow && metaOf(firstOpenRow.id);
  const cont = lastMeta && (P.lessons[P.last]?.level || 0) < MAX_LEVEL ? lastMeta : firstOpen;
  app().innerHTML = `${topbar()}
  <div class="stack">
    ${streakCard()}
    <a class="card hero" href="#/league" id="leagueCard" style="text-decoration:none;color:inherit">
      <div class="emoji">🏆</div><div class="grow"><div style="font-weight:800">Турнир недели</div>
      <div class="muted small" id="leagueLine">Загружаю таблицу…</div></div><span class="muted">›</span></a>
    ${cont ? `<a class="card hero" href="#/lesson/${cont.id}" style="text-decoration:none;color:inherit">
      <div class="emoji">▶️</div>
      <div class="grow"><div class="muted small">Продолжить · ${cont.level} · Урок ${cont.num}</div>
      <div style="font-weight:800">${esc(cont.title || 'Урок ' + cont.num)}</div></div></a>` : ''}
    <div class="card hero">
      <div class="emoji">🧠</div>
      <div class="grow"><div style="font-weight:800">Повторение</div>
      <div class="muted small">${due ? `${due} ${plural(due, 'карточка ждёт', 'карточки ждут', 'карточек ждут')} повторения` : 'Сейчас всё повторено'}</div></div>
      <a class="btn ${due ? 'primary' : ''}" href="#/review">${due ? 'Начать' : 'Слабые места'}</a>
    </div>
    <nav class="tabs">${INDEX.levels.map(l => {
      const ready = l.lessons.some(x => x.ready);
      return `<button class="tab ${l.id === level.id ? 'active' : ''} ${ready ? '' : 'soon'}" data-tab="${l.id}">${l.id}</button>`;
    }).join('')}</nav>
    <div>${level.lessons.map(l => lessonRow(l, cont)).join('')}</div>
  </div>`;
  $$('[data-tab]').forEach(b => b.onclick = () => { P.settings.tab = b.dataset.tab; save(); screenHome(); });
  getLeague().then(rows => {
    const line = $('#leagueLine');
    if (!line || !rows) return;
    const me = rows.findIndex(r => r.is_me);
    line.textContent = me < 0 ? 'Таблица недоступна'
      : `Вы на ${me + 1}-м месте из ${rows.length} · ${rows[me].pts} ${plural(rows[me].pts, 'балл', 'балла', 'баллов')}`;
  }).catch(() => { const l = $('#leagueLine'); if (l) l.textContent = 'Нет соединения — таблица обновится позже'; });
}
function streakCard() {
  const st = streakInfo();
  let line;
  if (st.doneToday) line = '✅ Сегодня выполнено — серия продлена';
  else if (st.lost) line = `Серия из ${st.lost} ${daysWord(st.lost)} прервалась. Начните новую сегодня!`;
  else if (st.needFreeze) line = `❄️ Вы пропустили ${st.needFreeze} ${daysWord(st.needFreeze)} — заморозка спасёт серию, если позанимаетесь сегодня`;
  else if (st.n) line = '⚠️ Пройдите тренировку сегодня, иначе серия сгорит';
  else line = 'Пройдите тренировку, чтобы начать серию';
  return `<div class="card streak-card">
    <div class="row"><div class="streak-num ${st.doneToday ? '' : 'off'}">🔥 ${st.n}</div>
      <div class="grow"><div style="font-weight:800">${st.n ? `${st.n} ${daysWord(st.n)} подряд` : 'Ударный режим'}</div>
      <div class="small muted">Рекорд: ${P.longest || 0} · Заморозки: ${'❄️'.repeat(P.freezes) || '—'}</div></div></div>
    ${weekHTML()}
    <div class="small ${st.doneToday ? 'muted' : ''}" style="margin-top:8px">${line}</div>
  </div>`;
}
function lessonRow(l, cont) {
  const st = P.lessons[l.id] || {};
  const lv = st.level || 0;
  const dots = Array.from({ length: MAX_LEVEL }, (_, i) => `<i class="${i < lv ? 'on' : ''}"></i>`).join('');
  const inner = `<div class="lesson-num ${lv >= MAX_LEVEL ? 'done' : ''}">${lv >= MAX_LEVEL ? '★' : l.num}</div>
    <div class="grow"><div class="lesson-title">${esc(l.title || 'Урок ' + l.num)}</div>
    ${l.ready ? `<div class="dots">${dots}${st.watched ? '<span class="small muted" style="margin-left:6px">🎬</span>' : ''}</div>` : '<div class="small muted">Упражнения скоро</div>'}</div>`;
  return l.ready
    ? `<a class="lesson-item ${cont && cont.id === l.id ? 'current' : ''}" href="#/lesson/${l.id}">${inner}</a>`
    : `<div class="lesson-item locked">${inner}</div>`;
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

async function screenLesson(id) {
  await getIndex();
  const meta = metaOf(id);
  let L;
  try { L = await getLesson(id); } catch (e) { app().innerHTML = `${topbar()}<p>Урок пока не готов. <a href="#/">На главную</a></p>`; return; }
  P.last = id; save();
  const st = lessonState(id);
  const lv = st.level;
  const next = Math.min(lv + 1, MAX_LEVEL);
  const mastered = lv >= MAX_LEVEL;
  const mastery = lessonMastery(L);
  const path = LEVEL_NAMES.map((n, i) => `<span class="${i < lv ? 'on' : i === lv ? 'next' : ''}"><b>${i < lv ? '✓' : i + 1}</b>${n}</span>`).join('');
  app().innerHTML = `
  <header class="topbar"><a class="icon-btn" href="#/" aria-label="Назад">←</a>
    <div class="grow" style="font-weight:800">${meta.level} · Урок ${meta.num}</div>
    <span class="stat xp">⚡ ${P.xp}</span></header>
  <div class="stack">
    <h2>${esc(L.title)}</h2>
    <div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${meta.videoId}?rel=0&playsinline=1&modestbranding=1" title="Видеоурок" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe></div>
    <div class="row">
      <label class="row grow small"><span class="switch"><input type="checkbox" id="watched" ${st.watched ? 'checked' : ''}><span></span></span> Видео просмотрено</label>
      <a class="small" href="https://www.youtube.com/watch?v=${meta.videoId}" target="_blank" rel="noopener">Открыть в YouTube ↗</a>
    </div>
    <div class="card">
      <div class="level-path">${path}</div>
      <div class="row small muted" style="margin:10px 0 6px"><span class="grow">Освоено фраз и слов</span><b>${mastery}%</b></div>
      <div class="meter"><i style="width:${mastery}%"></i></div>
      <div style="margin-top:14px" class="stack">
        <a class="btn primary block" href="#/practice/${id}/${next}">${mastered ? '🏆 Тренировать (Мастер)' : `Уровень ${next}: ${LEVEL_NAMES[next - 1]}`}</a>
        ${lv > 0 && !mastered ? `<div class="row small muted"><span class="grow">Повторить пройденный уровень:</span>${Array.from({ length: lv }, (_, i) => `<a href="#/practice/${id}/${i + 1}">${i + 1}</a>`).join(' ')}</div>` : ''}
      </div>
    </div>
    <details class="card theory" ${lv === 0 ? 'open' : ''}><summary>📘 Конспект</summary>
      ${L.theory.map(t => `<h3>${esc(t.h)}</h3><p>${esc(t.text)}</p>${(t.ex || []).map(([en, ru]) => exLine(en, ru)).join('')}`).join('')}
    </details>
    <details class="card"><summary>📒 Слова урока (${L.vocab.length})</summary>
      ${L.vocab.map(v => exLine(v.en, v.ru)).join('')}
    </details>
    <details class="card"><summary>💬 Фразы из видео</summary>
      ${L.sentences.filter(s => s.src === 'video').map(s => exLine(s.en, s.ru)).join('')}
    </details>
  </div>`;
  $('#watched').onchange = e => { st.watched = e.target.checked; save(); };
  bindSay(app());
}
const exLine = (en, ru) => `<div class="ex-line"><button class="say" data-say="${esc(en)}" aria-label="Озвучить">🔊</button><div><div class="en">${esc(en)}</div><div class="ru">${esc(ru)}</div></div></div>`;
function bindSay(root) { $$('[data-say]', root).forEach(b => b.onclick = () => say(b.dataset.say)); }

/* ---------------- session ---------------- */
let S = null;
async function screenPractice(id, level) {
  await getIndex();
  const L = await getLesson(id);
  level = Math.max(1, Math.min(MAX_LEVEL, +level || 1));
  await audioReady([id]);
  const tasks = buildLessonSession(L, level);
  startSession({ tasks, lessonId: id, level, back: `#/lesson/${id}` });
}
async function screenReview() {
  await getIndex();
  let keys = dueKeys().slice(0, 20);
  let title = 'Повторение';
  if (!keys.length) {
    // слабые места: самые слабые из уже встречавшихся
    keys = Object.entries(P.items).sort((a, b) => a[1].s - b[1].s || b[1].w - a[1].w).slice(0, 15).map(([k]) => k);
    title = 'Слабые места';
  }
  if (!keys.length) {
    app().innerHTML = `${topbar()}<div class="result"><div class="big">🌱</div><h2>Пока нечего повторять</h2>
      <p class="muted">Пройдите хотя бы одну тренировку урока — фразы попадут в повторение.</p><a class="btn primary" href="#/">К урокам</a></div>`;
    return;
  }
  app().innerHTML = '<div class="loading">Собираю повторение…</div>';
  const tasks = await buildReviewSession(keys);
  await audioReady([...new Set(tasks.map(t => t.L.id))]);
  startSession({ tasks, title, back: '#/' });
}
function startSession(opts) {
  S = { ...opts, queue: [...opts.tasks], total: opts.tasks.length, done: 0, mistakes: 0, firstTry: 0, earned: 0, started: Date.now(), seenWrong: new Set() };
  if (!S.total) { location.hash = opts.back; return; }
  app().innerHTML = `<div class="session">
    <div class="sess-top"><button class="icon-btn" id="quit" aria-label="Выйти">✕</button><div class="progress"><i id="prog" style="width:0"></i></div></div>
    <div class="ex" id="ex"></div></div>
    <div class="actionbar" id="bar"><div class="inner" id="barInner"></div></div>`;
  $('#quit').onclick = () => { if (confirm('Завершить тренировку? Пройденные задания уже учтены в повторении.')) { save(); location.hash = S.back; } };
  nextTask();
}
function setProgress() { $('#prog').style.width = `${Math.round(100 * S.done / S.total)}%`; }

function nextTask() {
  setProgress();
  if (recog) try { recog.abort(); } catch (e) { /* ok */ }
  if (!S.queue.length) return finishSession();
  const task = S.queue.shift();
  task.kind = fallbackKind(task.kind);
  S.cur = task;
  const ex = $('#ex');
  ex.innerHTML = '';
  window.scrollTo(0, 0);
  RENDER[task.kind](task, ex);
}
/** нижняя панель: кнопка «Проверить» */
function actionCheck(getAnswer, { skip } = {}) {
  const bar = $('#bar'); bar.className = 'actionbar';
  $('#barInner').innerHTML = `<div class="row">${skip ? '<button class="btn" id="skipBtn">Пропустить</button>' : ''}<button class="btn primary grow" id="checkBtn" disabled>Проверить</button></div>`;
  const btn = $('#checkBtn');
  btn.onclick = () => { if (!btn.disabled) getAnswer(); };
  if (skip) $('#skipBtn').onclick = skip;
  return {
    enable: (on = true) => { btn.disabled = !on; },
  };
}
/** показать результат и кнопку «Продолжить» */
function feedback(ok, { title, html = '', explain = '', speakText = '' } = {}) {
  const task = S.cur;
  sfx(ok);
  let pts = 0;
  if (ok) {
    S.done++;
    pts = S.seenWrong.has(task) ? 1 : (POINTS[task.kind] || 1);
    if (!S.seenWrong.has(task)) S.firstTry++;
    S.earned += pts;
    addPoints(pts);
  } else {
    S.mistakes++;
    S.seenWrong.add(task);
    S.queue.push(task); // вернуть в конец, как в Duolingo
  }
  const bar = $('#bar'); bar.className = `actionbar ${ok ? 'ok' : 'bad'}`;
  $('#barInner').innerHTML = `
    <div class="fb-title">${ok ? '✅' : '❌'} ${esc(title || (ok ? pick(['Отлично!', 'Верно!', 'Супер!', 'Так держать!'], 1)[0] : 'Неправильно'))}
      ${speakText ? `<button class="say" data-say="${esc(speakText)}">🔊</button>` : ''}${pts ? `<span class="pts">+${pts}</span>` : ''}</div>
    ${html || explain ? `<div class="fb-text">${html}${explain ? `<div class="fb-explain">💡 ${esc(explain)}</div>` : ''}</div>` : ''}
    <button class="btn ${ok ? 'ok' : 'bad'} block" id="contBtn">Продолжить</button>`;
  bindSay(bar);
  if (speakText && P.settings.tts) say(speakText);
  setProgress();
  save();
  const cont = $('#contBtn');
  cont.focus();
  cont.onclick = () => nextTask();
}
function finishSession() {
  const acc = Math.round(100 * S.firstTry / S.total);
  const bonus = BONUS_DONE + (S.mistakes === 0 ? BONUS_PERFECT : 0);
  addPoints(bonus);
  const xp = S.earned + bonus;
  const streak = extendStreak();
  if (S.lessonId) {
    const st = lessonState(S.lessonId);
    st.sessions++;
    if (S.level > st.level) st.level = S.level;
  }
  save();
  pushProgress();
  LEAGUE = null;
  const mins = Math.max(1, Math.round((Date.now() - S.started) / 60000));
  const msg = acc === 100 ? 'Идеально! Ни одной ошибки' : acc >= 80 ? 'Отличная работа!' : 'Хорошая тренировка — ошибки попадут в повторение';
  $('#bar').className = 'actionbar';
  $('#barInner').innerHTML = `<div class="stack"><a class="btn primary block" href="${S.back}">Продолжить</a>
    ${S.lessonId ? `<a class="btn block" href="#/practice/${S.lessonId}/${Math.min(MAX_LEVEL, lessonState(S.lessonId).level + 1)}">Следующая тренировка</a>` : ''}</div>`;
  const streakHTML = streak ? `<div class="card streak-win">
      <div class="streak-big">🔥 ${streak.streak}</div>
      <div style="font-weight:800">${streak.streak === 1 ? (streak.lost ? 'Новая серия началась!' : 'Серия началась!') : `${streak.streak} ${daysWord(streak.streak)} подряд!`}</div>
      ${weekHTML()}
      ${streak.usedFreeze ? `<div class="small" style="margin-top:6px">❄️ Заморозка спасла серию</div>` : ''}
      ${streak.gotFreeze ? `<div class="small" style="margin-top:6px">🎁 Неделя подряд — вы получили заморозку ❄️</div>` : ''}
    </div>` : '';
  $('#ex').innerHTML = `<div class="result">${streakHTML}<div class="big">${acc >= 80 ? '🎉' : '💪'}</div><h2>${esc(msg)}</h2>
    ${S.lessonId ? `<p class="muted">${S.level >= MAX_LEVEL ? 'Уровень «Мастер» пройден' : `Уровень ${S.level} «${LEVEL_NAMES[S.level - 1]}» пройден`}</p>` : ''}
    <div class="result-stats"><div class="card"><b style="color:var(--gold)">+${xp}</b><span class="small muted">баллов</span></div>
    <div class="card"><b style="color:var(--ok)">${acc}%</b><span class="small muted">точность</span></div>
    <div class="card"><b>${mins}</b><span class="small muted">мин</span></div></div></div>`;
  $('#prog').style.width = '100%';
  S = null;
}

/* ---------------- exercise renderers ---------------- */
const head = (kind, extra = '') => `<div class="ex-kind">${KIND_TITLE[kind]}</div>${extra}`;
const sentTargets = s => [s.en, ...(s.alt || [])];

function renderOptions(container, options, onSelect) {
  container.innerHTML = `<div class="options">${options.map((o, i) => `<button class="opt" data-i="${i}">${esc(o)}</button>`).join('')}</div>`;
  $$('.opt', container).forEach(b => b.onclick = () => {
    $$('.opt', container).forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
    onSelect(+b.dataset.i);
  });
}
function markOptions(container, rightIdx, chosenIdx) {
  $$('.opt', container).forEach((b, i) => { b.disabled = true; b.classList.remove('sel'); if (i === rightIdx) b.classList.add('right'); else if (i === chosenIdx) b.classList.add('wrong'); });
}

const RENDER = {
  vocabChoice(task, ex) {
    const L = task.L, v = L.vocab[task.i];
    const enToRu = Math.random() < 0.6;
    const others = pick(L.vocab.filter(x => x !== v), 3);
    const opts = shuffle([v, ...others]);
    const right = opts.indexOf(v);
    ex.innerHTML = head('vocabChoice', `<div class="prompt">${enToRu ? `<button class="say" data-say="${esc(v.en)}">🔊</button>` : ''}<div class="bubble">${esc(enToRu ? v.en : v.ru)}</div></div><div id="opts"></div>`);
    bindSay(ex);
    if (enToRu) say(v.en);
    let chosen = -1;
    const ac = actionCheck(() => {
      const ok = chosen === right;
      grade(task.key, ok, task.kind);
      markOptions($('#opts'), right, chosen);
      feedback(ok, { html: ok ? '' : `${esc(v.en)} — ${esc(v.ru)}`, speakText: v.en });
    });
    renderOptions($('#opts'), opts.map(o => enToRu ? o.ru : o.en), i => { chosen = i; ac.enable(); });
  },

  match(task, ex) {
    const L = task.L;
    const pairs = task.ids.map(i => ({ i, ...L.vocab[i] }));
    const left = shuffle(pairs), right = shuffle(pairs);
    ex.innerHTML = head('match', `<div class="match">${left.map((p, k) => `<button class="opt" data-side="l" data-i="${p.i}">${esc(p.en)}</button><button class="opt" data-side="r" data-i="${right[k].i}">${esc(right[k].ru)}</button>`).join('')}</div>`);
    $('#bar').className = 'actionbar';
    $('#barInner').innerHTML = `<button class="btn primary block" disabled>Проверить</button>`;
    const wrongIds = new Set();
    let sel = null, left_n = pairs.length;
    $$('.match .opt', ex).forEach(b => b.onclick = () => {
      if (b.dataset.side === 'l') say(pairs.find(p => p.i === +b.dataset.i).en, 1);
      if (!sel || sel.dataset.side === b.dataset.side) {
        if (sel) sel.classList.remove('sel');
        sel = b; b.classList.add('sel'); return;
      }
      if (sel.dataset.i === b.dataset.i) {
        [sel, b].forEach(x => { x.classList.remove('sel'); x.classList.add('right'); setTimeout(() => x.classList.add('gone'), 250); });
        left_n--;
        if (!left_n) {
          task.keys.forEach((k, n) => grade(k, !wrongIds.has(task.ids[n]), 'match'));
          S.done++; if (!wrongIds.size) S.firstTry++;
          const pts = wrongIds.size ? 1 : POINTS.match;
          S.earned += pts; addPoints(pts);
          sfx(true);
          const bar = $('#bar'); bar.className = 'actionbar ok';
          $('#barInner').innerHTML = `<div class="fb-title">✅ ${wrongIds.size ? 'Готово!' : 'Без ошибок!'}<span class="pts">+${pts}</span></div><button class="btn ok block" id="contBtn">Продолжить</button>`;
          setProgress(); save();
          $('#contBtn').onclick = () => nextTask();
        }
      } else {
        wrongIds.add(+sel.dataset.i); wrongIds.add(+b.dataset.i);
        [sel, b].forEach(x => { x.classList.remove('sel'); x.classList.add('wrong', 'shake'); setTimeout(() => x.classList.remove('wrong', 'shake'), 400); });
        sfx(false);
      }
      sel = null;
    });
  },

  choiceEnRu(task, ex) {
    const L = task.L, s = L.sentences[task.i];
    const others = pick(L.sentences.filter(x => x !== s && x.ru !== s.ru), 2);
    const opts = shuffle([s, ...others]);
    const right = opts.indexOf(s);
    ex.innerHTML = head('choiceEnRu', `<div class="prompt"><button class="say" data-say="${esc(s.en)}">🔊</button><div class="bubble">${esc(s.en)}</div></div><div id="opts"></div>`);
    bindSay(ex); say(s.en);
    let chosen = -1;
    const ac = actionCheck(() => {
      const ok = chosen === right;
      grade(task.key, ok, task.kind);
      markOptions($('#opts'), right, chosen);
      feedback(ok, { html: ok ? '' : esc(s.ru) });
    });
    renderOptions($('#opts'), opts.map(o => o.ru), i => { chosen = i; ac.enable(); });
  },

  gapChoice(task, ex) {
    const g = task.L.gaps[task.i];
    const opts = shuffle(g.options);
    const [a, b] = g.en.split('___');
    ex.innerHTML = head('gapChoice', `<div class="gap-sent">${esc(a)}<span class="blank" id="blank">&nbsp;</span>${esc(b)}</div><div class="sub">${esc(g.ru)}</div><div id="opts"></div>`);
    let chosen = -1;
    const full = ans => (a + (ans === '—' ? '' : ans) + b).replace(/\s+/g, ' ').trim();
    const ac = actionCheck(() => {
      const ok = opts[chosen] === g.answer;
      grade(task.key, ok, task.kind);
      markOptions($('#opts'), opts.indexOf(g.answer), chosen);
      feedback(ok, { html: ok ? '' : esc(full(g.answer)), explain: g.explain, speakText: full(g.answer) });
    });
    renderOptions($('#opts'), opts, i => { chosen = i; $('#blank').textContent = opts[i]; ac.enable(); });
  },

  gapType(task, ex) {
    const g = task.L.gaps[task.i];
    const [a, b] = g.en.split('___');
    const full = ans => (a + (ans === '—' ? '' : ans) + b).replace(/\s+/g, ' ').trim();
    const zeroOK = g.answer === '—';
    ex.innerHTML = head('gapType', `<div class="gap-sent">${esc(a)}<span class="blank">?</span>${esc(b)}</div><div class="sub">${esc(g.ru)}</div>
      <input class="answer" id="inp" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${zeroOK ? 'Если слово не нужно — поставьте «-»' : 'Пропущенное слово'}">`);
    const inp = $('#inp');
    const ac = actionCheck(() => {
      const val = inp.value.trim();
      const answers = [g.answer, ...(g.alt || [])];
      let res;
      if (zeroOK) res = { ok: /^[-—–]?$/.test(val) || val.toLowerCase() === 'нет' };
      else res = check(full(val), answers.map(full));
      inp.disabled = true;
      grade(task.key, res.ok, task.kind);
      feedback(res.ok, {
        title: res.typo ? 'Почти! Опечатка' : undefined,
        html: res.ok && !res.typo ? '' : `Правильно: <b>${esc(full(g.answer))}</b>`,
        explain: g.explain, speakText: full(g.answer),
      });
    });
    inp.oninput = () => ac.enable(inp.value.trim().length > 0 || zeroOK);
    if (zeroOK) ac.enable();
    inp.onkeydown = e => { if (e.key === 'Enter') $('#checkBtn')?.click(); };
    setTimeout(() => inp.focus(), 50);
  },

  quiz(task, ex) {
    const q = task.L.quiz[task.i];
    const order = shuffle(q.options.map((_, i) => i));
    const right = order.indexOf(q.answer);
    ex.innerHTML = head('quiz', `<div class="prompt"><div>${esc(q.q)}</div></div><div id="opts"></div>`);
    let chosen = -1;
    const ac = actionCheck(() => {
      const ok = chosen === right;
      grade(task.key, ok, task.kind);
      markOptions($('#opts'), right, chosen);
      feedback(ok, { html: ok ? '' : `Правильно: <b>${esc(q.options[q.answer])}</b>`, explain: q.explain });
    });
    renderOptions($('#opts'), order.map(i => q.options[i]), i => { chosen = i; ac.enable(); });
  },

  tilesRuEn(task, ex) { tiles(task, ex, false); },
  tilesListen(task, ex) { tiles(task, ex, true); },
  typeRuEn(task, ex) { typed(task, ex, false); },
  typeListen(task, ex) { typed(task, ex, true); },
  speakRead(task, ex) { speak(task, ex, true); },
  speakTrans(task, ex) { speak(task, ex, false); },
};

/* --- плитки --- */
const PAIRS = [['is', 'are'], ['am', 'is'], ['are', 'is'], ['do', 'does'], ['does', 'do'], ["don't", "doesn't"], ["doesn't", "don't"], ['has', 'have'], ['have', 'has'],
  ['a', 'an'], ['an', 'a'], ['the', 'a'], ['was', 'were'], ['were', 'was'], ['this', 'these'], ['these', 'this'], ['that', 'those'], ['much', 'many'], ['many', 'much'],
  ['some', 'any'], ['any', 'some'], ['in', 'at'], ['at', 'in'], ['on', 'in'], ['to', 'for'], ['for', 'to'], ['will', 'would'], ['did', 'does'], ['he', 'him'], ['she', 'her'],
  ['they', 'them'], ['i', 'me'], ['we', 'us'], ['my', 'me'], ['your', "you're"], ['his', 'he'], ['their', 'there']];
function grammarDistractors(tokens) {
  const low = new Set(tokens.map(t => t.toLowerCase()));
  const out = [];
  for (const t of tokens) {
    const w = t.toLowerCase();
    for (const [x, y] of PAIRS) if (w === x && !low.has(y)) out.push(y);
    if (/^[a-z]{3,}s$/.test(w) && !/ss$/.test(w)) out.push(w.slice(0, -1));
    else if (/^[a-z]{3,}$/.test(w) && !/(ed|ing|ly|s)$/.test(w) && Math.random() < 0.3) out.push(w + 's');
    if (/^[a-z]{3,}ing$/.test(w)) out.push(w.slice(0, -3));
  }
  return [...new Set(out)].filter(w => !low.has(w));
}
const tokenize = s => s.replace(/[.!?;:"«»()]/g, ' ').replace(/,/g, ' ').split(/\s+/).filter(Boolean);
function tiles(task, ex, listen) {
  const L = task.L, s = L.sentences[task.i];
  const tokens = tokenize(s.en);
  const nDis = Math.min(7, Math.max(4, Math.round(tokens.length * 0.6)));
  const low = new Set(tokens.map(t => t.toLowerCase()));
  const gram = shuffle(grammarDistractors(tokens)).slice(0, Math.ceil(nDis / 2));
  const pool = shuffle([...new Set(L.sentences.flatMap(x => tokenize(x.en)).map(w => w === 'I' ? w : w.toLowerCase()))].filter(w => !low.has(w.toLowerCase())));
  const distract = [...gram, ...pool].filter((w, i, a) => a.indexOf(w) === i).slice(0, nDis);
  const bank = shuffle([...tokens, ...distract]).map((w, id) => ({ w, id }));
  ex.innerHTML = head(task.kind, listen
    ? `<div class="big-audio"><button id="play" aria-label="Прослушать">🔊</button><button class="slow" id="slow" aria-label="Медленно">🐢</button></div>`
    : `<div class="prompt"><div class="bubble">${esc(s.ru)}</div></div>`)
    + `<div class="answer-zone" id="zone"></div><div class="bank" id="bank">${bank.map(b => `<button class="tile" data-id="${b.id}">${esc(b.w)}</button>`).join('')}</div>`;
  if (listen) { $('#play').onclick = () => say(s.en); $('#slow').onclick = () => say(s.en, 0.6); setTimeout(() => say(s.en), 250); }
  const answer = [];
  const zone = $('#zone');
  const ac = actionCheck(() => {
    const text = answer.map(id => bank[id].w).join(' ');
    const res = check(text, sentTargets(s), { typos: false });
    grade(task.key, res.ok, task.kind);
    $$('.tile', ex).forEach(t => t.disabled = true);
    feedback(res.ok, {
      html: (res.ok ? '' : diffHTML(text, res.target)) + (listen ? `<div class="fb-explain">${esc(res.ok ? s.en + ' — ' : '')}${esc(s.ru)}</div>` : ''),
      speakText: res.ok ? text : s.en,
    });
  });
  const redraw = () => {
    zone.innerHTML = answer.map(id => `<button class="tile" data-zid="${id}">${esc(bank[id].w)}</button>`).join('');
    $$('#bank .tile').forEach(t => t.classList.toggle('used', answer.includes(+t.dataset.id)));
    $$('[data-zid]', zone).forEach(t => t.onclick = () => { answer.splice(answer.indexOf(+t.dataset.zid), 1); redraw(); });
    ac.enable(answer.length > 0);
  };
  $$('#bank .tile').forEach(t => t.onclick = () => {
    const id = +t.dataset.id;
    if (answer.includes(id)) return;
    answer.push(id);
    if (!listen) say(bank[id].w, 1, { clipOnly: true });
    redraw();
  });
}

/* --- ввод с клавиатуры --- */
function typed(task, ex, listen) {
  const s = task.L.sentences[task.i];
  ex.innerHTML = head(task.kind, listen
    ? `<div class="big-audio"><button id="play" aria-label="Прослушать">🔊</button><button class="slow" id="slow" aria-label="Медленно">🐢</button></div>`
    : `<div class="prompt"><div class="bubble">${esc(s.ru)}</div></div>`)
    + `<textarea class="answer" id="inp" rows="3" autocomplete="off" autocapitalize="sentences" autocorrect="off" spellcheck="false" placeholder="${listen ? 'Напишите по-английски' : 'Перевод на английский'}"></textarea>`;
  if (listen) { $('#play').onclick = () => say(s.en); $('#slow').onclick = () => say(s.en, 0.6); setTimeout(() => say(s.en), 250); }
  const inp = $('#inp');
  const ac = actionCheck(() => {
    const val = inp.value;
    const res = check(val, listen ? [s.en] : sentTargets(s));
    inp.disabled = true;
    grade(task.key, res.ok, task.kind);
    let html = '';
    if (!res.ok) html = `Правильно: ${diffHTML(val, res.target)}`;
    else if (res.typo) html = `Правильно: <b>${esc(res.target)}</b>`;
    else if (!listen && canon(res.target) !== canon(s.en)) html = `Другой вариант: ${esc(s.en)}`;
    if (listen) html += `<div class="fb-explain">${esc(s.ru)}</div>`;
    feedback(res.ok, { title: res.typo ? 'Почти! Опечатка' : undefined, html, speakText: res.ok ? res.target : s.en });
  }, { skip: () => { inp.disabled = true; giveUp(task, s); } });
  inp.oninput = () => ac.enable(inp.value.trim().length > 0);
  inp.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#checkBtn')?.click(); } };
  setTimeout(() => inp.focus(), listen ? 400 : 50);
}
function giveUp(task, s) {
  grade(task.key, false, task.kind);
  feedback(false, { title: 'Ответ', html: esc(s.en), speakText: s.en });
}

/* --- говорение --- */
function speak(task, ex, read) {
  const s = task.L.sentences[task.i];
  ex.innerHTML = head(task.kind, read
    ? `<div class="prompt"><button class="say" data-say="${esc(s.en)}">🔊</button><div class="bubble">${esc(s.en)}</div></div>`
    : `<div class="prompt"><div class="bubble">${esc(s.ru)}</div></div>`)
    + `<div class="mic-wrap"><button class="mic" id="mic" aria-label="Говорить">🎤</button><div class="heard" id="heard">Нажмите и говорите</div></div>`;
  bindSay(ex);
  $('#bar').className = 'actionbar';
  $('#barInner').innerHTML = `<div class="row"><button class="btn grow" id="noMic">Не могу говорить</button><button class="btn grow" id="skip">Не знаю</button></div>`;
  $('#noMic').onclick = () => {
    P.settings.speechPauseUntil = Date.now() + 15 * 60000; save();
    S.queue.unshift({ ...task, kind: read ? 'tilesListen' : 'typeRuEn' });
    nextTask();
  };
  $('#skip').onclick = () => giveUp(task, s);
  const mic = $('#mic'), heard = $('#heard');
  let busy = false;
  mic.onclick = async () => {
    if (busy) { recog?.stop(); return; }
    busy = true; mic.classList.add('rec'); heard.textContent = 'Слушаю…';
    speechSynthesis?.cancel?.();
    try {
      const alts = await listen(t => { heard.textContent = t; });
      busy = false; mic.classList.remove('rec');
      if (!alts.length) { heard.textContent = 'Ничего не услышал — нажмите ещё раз'; return; }
      const targets = read ? [s.en] : sentTargets(s);
      let res = null;
      for (const a of alts) { const r = check(a, targets, { fuzzy: read ? 0.75 : 0.85 }); if (r.ok) { res = r; break; } }
      res ||= check(alts[0], targets);
      grade(task.key, res.ok, task.kind);
      heard.textContent = `«${alts[0]}»`;
      feedback(res.ok, {
        title: res.ok ? (res.fuzzy ? 'Засчитано!' : undefined) : 'Не совсем',
        html: res.ok && !res.fuzzy ? '' : `Правильно: ${diffHTML(alts[0], res.target)}`,
        speakText: res.target,
      });
    } catch (err) {
      busy = false; mic.classList.remove('rec');
      heard.textContent = err === 'not-allowed' || err === 'service-not-allowed'
        ? 'Нет доступа к микрофону. Разрешите его в настройках браузера или нажмите «Не могу говорить».'
        : 'Не удалось распознать речь. Попробуйте ещё раз.';
    }
  };
}

/* ---------------- settings ---------------- */
function screenSettings() {
  const st = P.settings;
  const vs = voices.length ? voices : [];
  app().innerHTML = `
  <header class="topbar"><a class="icon-btn" href="#/" aria-label="Назад">←</a><div class="grow" style="font-weight:800">Настройки</div></header>
  <div class="card">
    <div class="list-row" style="border:0"><span>Цель дня</span>
      <select id="goal">${[20, 30, 50, 80, 120].map(g => `<option value="${g}" ${g === st.goal ? 'selected' : ''}>${g} XP</option>`).join('')}</select></div>
    <div class="list-row"><span>Озвучивать ответы</span><label class="switch"><input type="checkbox" id="tts" ${st.tts ? 'checked' : ''}><span></span></label></div>
    <div class="list-row"><span>Упражнения на говорение${SR ? '' : '<br><span class="small muted">Браузер не поддерживает распознавание речи</span>'}</span>
      <label class="switch"><input type="checkbox" id="speech" ${st.speech ? 'checked' : ''} ${SR ? '' : 'disabled'}><span></span></label></div>
    <div class="list-row"><span>Звуки</span><label class="switch"><input type="checkbox" id="sfx" ${st.sfx ? 'checked' : ''}><span></span></label></div>
    <div class="list-row"><span>Голос</span><select id="voice"><option value="">Нейросеть (рекомендуется)</option>${vs.map(v => `<option ${v.name === st.voice ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></div>
    <div class="list-row"><span>Тема</span><select id="theme">${[['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']].map(([v, n]) => `<option value="${v}" ${v === st.theme ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
  </div>
  <div class="card stack" style="margin-top:12px">
    <div style="font-weight:800">Аккаунт</div>
    <div class="small muted">Вы вошли как <b>${esc(AUTH?.username || '')}</b>. Прогресс синхронизируется — можно заниматься с нескольких устройств.</div>
    <div class="small muted">Всего баллов: ${P.xp} · рекорд серии: ${P.longest || 0} ${daysWord(P.longest || 0)} · уроков начато: ${Object.keys(P.lessons).length} · элементов в повторении: ${Object.keys(P.items).length}</div>
    <button class="btn" id="logout">Выйти из аккаунта</button>
    <button class="btn ghost" id="reset">Сбросить прогресс обучения</button>
  </div>
  <p class="small muted" style="text-align:center;margin-top:20px">Видеоуроки — канал «Английский язык по плейлистам».</p>`;
  const bind = (id, fn) => { $('#' + id).onchange = e => { fn(e.target); save(); }; };
  bind('goal', t => st.goal = +t.value);
  bind('tts', t => st.tts = t.checked);
  bind('speech', t => { st.speech = t.checked; st.speechPauseUntil = 0; });
  bind('sfx', t => st.sfx = t.checked);
  bind('voice', t => { st.voice = t.value; loadAudio('A1-01').then(() => say('I want to tell you that you look great.')); });
  bind('theme', t => { st.theme = t.value; applyTheme(); });
  $('#logout').onclick = async () => {
    if (!confirm('Выйти из аккаунта?')) return;
    save(false); await Promise.all([pushProgress(), flushPoints()]);
    logout(); location.hash = '#/'; route();
  };
  $('#reset').onclick = () => {
    if (!confirm('Сбросить уровни уроков, повторение и серию? Баллы в турнире останутся.')) return;
    P = { ...defaults(), settings: P.settings }; save(); pushProgress(); location.hash = '#/';
  };
}

/* ---------------- турнир ---------------- */
let LEAGUE = null; // кэш текущей недели: { at, rows }
async function getLeague(week = 0) {
  if (week === 0 && LEAGUE && Date.now() - LEAGUE.at < 30000) return LEAGUE.rows;
  await flushPoints();
  const rows = await rpc('leaderboard', { p_week: week });
  if (week === 0) LEAGUE = { at: Date.now(), rows };
  return rows;
}
const AVATAR_COLORS = ['#3b6cf6', '#1f9d55', '#f0a20b', '#dc3d3d', '#8b5cf6', '#0ea5e9', '#ec4899', '#14b8a6'];
const avatarColor = name => AVATAR_COLORS[[...name].reduce((h, c) => h * 31 + c.charCodeAt(0), 7) % AVATAR_COLORS.length];
function weekRange(start) {
  const s = new Date(start + 'T12:00:00'), e = new Date(s.getTime() + 6 * DAY);
  const f = d => d.toLocaleDateString('ru', { day: 'numeric', month: 'long' });
  return `${f(s)} — ${f(e)}`;
}
async function screenLeague(week = 0) {
  week = +week || 0;
  app().innerHTML = `<header class="topbar"><a class="icon-btn" href="#/" aria-label="Назад">←</a>
    <div class="grow" style="font-weight:800">🏆 Турнир недели</div></header><div id="lg-body" class="loading">Загружаю таблицу…</div>`;
  let rows;
  try { rows = await getLeague(week); } catch (e) {
    $('#lg-body').innerHTML = `<p class="muted">Не удалось загрузить таблицу: ${esc(e.offline ? 'нет соединения' : e.message)}</p>`;
    return;
  }
  const ws = rows[0]?.week_start;
  const left = ws ? 7 - daysBetween(ws, dayKey()) : 0;
  const medal = i => ['🥇', '🥈', '🥉'][i] || `${i + 1}`;
  $('#lg-body').className = 'stack';
  $('#lg-body').innerHTML = `
    <div class="tabs"><a class="tab ${week === 0 ? 'active' : ''}" href="#/league/0">Эта неделя</a><a class="tab ${week === 1 ? 'active' : ''}" href="#/league/1">Прошлая</a></div>
    <div class="small muted">${ws ? weekRange(ws) : ''}${week === 0 && left > 0 ? ` · до конца ${left} ${daysWord(left)}` : ''}${week === 1 && rows[0]?.pts > 0 ? ` · победитель — ${esc(rows[0].username)} 🎉` : ''}</div>
    <div class="card league">${rows.map((r, i) => `
      <div class="lg-row ${r.is_me ? 'me' : ''}">
        <div class="lg-rank">${r.pts > 0 ? medal(i) : i + 1}</div>
        <div class="avatar" style="background:${avatarColor(r.username)}">${esc(r.username[0].toUpperCase())}</div>
        <div class="grow"><div class="lg-name">${esc(r.username)}${r.is_me ? ' <span class="small muted">(вы)</span>' : ''}</div>
          <div class="small muted">${r.streak ? `🔥 ${r.streak}` : '🔥 0'}${week === 0 && r.today ? ` · сегодня +${r.today}` : ''}</div></div>
        <div class="lg-pts">${r.pts}</div>
      </div>`).join('')}</div>
    <p class="small muted">Баллы начисляются за каждое верное задание: выбор и пропуски — 1, плитки и тесты — 2, пары, перевод, вписывание, диктант и говорение — 3 (после ошибки — 1). За завершённую тренировку +${BONUS_DONE}, без ошибок ещё +${BONUS_PERFECT}. Неделя начинается в понедельник.</p>`;
}

/* ---------------- router ---------------- */
async function route() {
  const [, page, a, b] = location.hash.replace(/^#/, '').split('/');
  if (S && page !== 'practice' && page !== 'review') S = null;
  $('#bar')?.remove();
  if (!AUTH) return screenAuth('login');
  if (!KEY) {
    // вошли, но нет ключа (новое устройство или сменился ключ) — спросить сервер
    try { if (!(await afterLogin())) return screenAuth('invite'); }
    catch (e) { if (e.auth) return screenAuth('login'); return screenAuth('login', authError(e)); }
  }
  try {
    if (page === 'lesson') await screenLesson(a);
    else if (page === 'practice') await screenPractice(a, b);
    else if (page === 'review') await screenReview();
    else if (page === 'settings') screenSettings();
    else if (page === 'league') await screenLeague(a);
    else await screenHome();
  } catch (e) {
    console.error(e);
    if (e.auth) return screenAuth('login', 'Войдите заново');
    if (e.badKey && !route.retried) {
      route.retried = true;
      KEY = null; INDEX = null; for (const k in LESSONS) delete LESSONS[k];
      return route();
    }
    app().innerHTML = `<div class="result"><div class="big">⚠️</div><h2>Что-то пошло не так</h2><p class="muted">${esc(e.message)}</p><a class="btn primary" href="#/">На главную</a></div>`;
  }
}
window.addEventListener('hashchange', route);
applyTheme();
loadStoredKey().then(async () => {
  await route();
  if (AUTH && KEY) {
    flushPoints();
    // подтянуть прогресс с другого устройства; если он новее — перерисовать (кроме идущей тренировки)
    if (await pullProgress() && !S) { applyTheme(); route(); }
  }
});
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
