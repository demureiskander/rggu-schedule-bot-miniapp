// Standalone прокси для Mini App «РсухСпейс».
// Отдельный Railway-сервис (root = server/), независимый от бота.
// Делает:
//   - проксирует API РГГУ (с CORS) — /api/flows, /api/schedule, /api/teachers
//   - кэширует погоду Москвы (open-meteo) — /api/weather
//   - аналитика событий + синхронизация данных юзера + баннеры (SQLite)
//   - админ-панель (/admin) — dashboard + управление баннерами
//
// Требует Node >= 18 (глобальные fetch / FormData / Blob).
//
// ENV:
//   PORT                 — порт (default 3000)
//   API_URL              — upstream API РГГУ
//   ALLOW_ORIGIN         — CORS Origin (default '*')
//   MINI_APP_BOT_TOKEN   — токен Telegram-бота для проверки initData (приоритет)
//   BOT_TOKEN            — fallback на тот же токен
//   ADMIN_TOKEN          — секрет для GET /admin?token=…
//   ADMIN_ID             — telegram user_id админа (default 918330630)
//   DB_PATH              — путь к SQLite (default /data/analytics.db, fallback ./analytics.db)
//
// Все аналитические/sync-эндпоинты валидируют initData soft-режимом:
//   - заголовок X-Telegram-Init-Data отсутствует → пропускаем без user_id
//   - присутствует и валиден → user_id = из payload
//   - присутствует и невалиден → 403
// Старые проксирующие эндпоинты (flows/schedule/weather/teachers) ничего
// не валидируют — обратная совместимость для уже выкаченного фронта.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 3000;
const API_URL = (process.env.API_URL || '').replace(/\/+$/, '');
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const BOT_TOKEN = process.env.MINI_APP_BOT_TOKEN || process.env.BOT_TOKEN || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ADMIN_ID = process.env.ADMIN_ID || '918330630';
const DB_PATH = process.env.DB_PATH ||
  (fs.existsSync('/data') ? '/data/analytics.db' : path.resolve('./analytics.db'));

// ============================================================
// SQLite — better-sqlite3. Если модуль не подгрузился (нет npm
// install / неверный нативный билд), сервер всё равно стартует:
// все аналитические эндпоинты будут отдавать { ok: false } без падения.
// ============================================================
let db = null;
let dbErr = null;
try {
  const mod = await import('better-sqlite3');
  const Database = mod.default;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT,
      platform TEXT,
      ts DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_events_user_ts ON events(user_id, ts);
    CREATE INDEX IF NOT EXISTS idx_events_event_ts ON events(event, ts);

    CREATE TABLE IF NOT EXISTS banners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT,
      btn_text TEXT,
      btn_url TEXT,
      type TEXT DEFAULT 'info',
      color TEXT DEFAULT '#F59E0B',
      active INTEGER DEFAULT 1,
      show_from TEXT,
      show_until TEXT,
      frequency INTEGER DEFAULT 5,
      dismissable INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS banner_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      banner_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT DEFAULT 'click',
      ts DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bc_banner ON banner_clicks(banner_id);

    CREATE TABLE IF NOT EXISTS user_data (
      user_id TEXT PRIMARY KEY,
      attendance TEXT,
      notes TEXT,
      group_id TEXT,
      group_label TEXT,
      settings TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
} catch (e) {
  dbErr = e.message;
  console.warn(`[db] SQLite недоступна, аналитика отключена: ${e.message}`);
}

if (!BOT_TOKEN) {
  console.warn('[init] BOT_TOKEN не задан, валидация initData отключена (soft)');
}
if (!ADMIN_TOKEN) {
  console.warn('[init] ADMIN_TOKEN не задан, /admin/* недоступна (403)');
}

// ============================================================
// initData: парсинг + HMAC-проверка по спецификации Telegram WebApp.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Возвращает { ok, userId } | { ok: false, error }.
// ============================================================
function parseInitData(raw) {
  const params = new URLSearchParams(raw || '');
  const hash = params.get('hash');
  if (!hash) return null;
  // Собираем data_check_string из всех полей кроме hash, отсортированных по
  // ключу, в формате key=value\n…
  const pairs = [];
  for (const [k, v] of params.entries()) {
    if (k === 'hash') continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');
  const userRaw = params.get('user') || '';
  let userId = null;
  try {
    const u = JSON.parse(userRaw);
    if (u && (u.id != null)) userId = String(u.id);
  } catch (_) { /* user может отсутствовать */ }
  return { hash, dataCheckString, userId };
}

function verifyInitData(raw) {
  if (!BOT_TOKEN || !raw) return { ok: false, error: 'no_token_or_data' };
  const parsed = parseInitData(raw);
  if (!parsed) return { ok: false, error: 'bad_format' };
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calcHash = crypto.createHmac('sha256', secretKey)
    .update(parsed.dataCheckString)
    .digest('hex');
  if (calcHash !== parsed.hash) return { ok: false, error: 'bad_hash' };
  return { ok: true, userId: parsed.userId };
}

// Soft-проверка: возвращает userId или null. Если header отсутствует — null
// (без ошибки). Если присутствует и невалиден — кидаем 403 через except.
function authSoft(req) {
  const raw = req.headers['x-telegram-init-data'];
  if (!raw) return null;
  const r = verifyInitData(String(raw));
  if (!r.ok) throw new HttpError(403, `initdata_${r.error}`);
  return r.userId;
}

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// ============================================================
// CORS
// ============================================================
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Telegram-Init-Data',
    'Access-Control-Max-Age': '86400',
  };
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(),
  });
  res.end(body);
}

function sendHTML(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    ...corsHeaders(),
  });
  res.end(html);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { // 1MB лимит на запрос
        reject(new HttpError(413, 'payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({});
      try { resolve(JSON.parse(buf.toString('utf8'))); }
      catch (_) { reject(new HttpError(400, 'bad_json')); }
    });
    req.on('error', reject);
  });
}

// ============================================================
// Upstream API РГГУ (без изменений)
// ============================================================
async function callUpstream(method, formData) {
  if (!API_URL) throw new Error('API_URL not configured');
  const url = `${API_URL}?method=/${method}`;
  const res = await fetch(url, { method: 'POST', body: formData });
  if (!res.ok) throw new Error(`upstream ${method} -> ${res.status}`);
  return res.json();
}

async function getFlows(form, course) {
  const fd = new FormData();
  fd.append('0', JSON.stringify({ eduform: form, course: String(course) }));
  const data = await callUpstream('Get_Flows_List', fd);
  if (!Array.isArray(data)) return [];
  return data.map((g) => ({
    id: g.id,
    name: g.data ?? '',
    details: [g.direction, g.profile].filter(Boolean).join(' › '),
  }));
}

async function getSchedule(flow, form, course) {
  const fd = new FormData();
  fd.append('eduform', form);
  fd.append('course', String(course));
  fd.append('flow', flow);
  fd.append('intervalMode', '4');
  fd.append('menuMode', 'flow');
  const data = await callUpstream('Get_Schedule_Table', fd);
  return { item: data?.item ?? '', tblData: Array.isArray(data?.tblData) ? data.tblData : [] };
}

async function getTeacherSchedule(teacher) {
  const fd = new FormData();
  fd.append('menuMode', 'teacher');
  fd.append('teacher', teacher);
  fd.append('intervalMode', '4');
  const data = await callUpstream('Get_Schedule_Table', fd);
  return { item: data?.item ?? '', tblData: Array.isArray(data?.tblData) ? data.tblData : [] };
}

async function getTeachers() {
  const data = await callUpstream('Get_Teachers_List', new FormData());
  if (!Array.isArray(data)) return [];
  return data
    .map((t) => ({ id: String(t.id ?? ''), name: t.data ?? '' }))
    .filter((t) => t.id && t.name);
}

// ============================================================
// Погода (без изменений)
// ============================================================
const WEATHER_TTL_MS = 24 * 60 * 60 * 1000;
let weatherCache = null;

function mapWeatherCode(wmo) {
  if (wmo === 0) return 'clear';
  if ([1, 2, 3].includes(wmo)) return 'clouds';
  if ([45, 48].includes(wmo)) return 'fog';
  if ([71, 73, 75, 77, 85, 86].includes(wmo)) return 'snow';
  if ([95, 96, 99].includes(wmo)) return 'storm';
  if ((wmo >= 51 && wmo <= 67) || [80, 81, 82].includes(wmo)) return 'rain';
  return 'clouds';
}

async function getWeather() {
  const now = Date.now();
  if (weatherCache && now - weatherCache.fetchedAt < WEATHER_TTL_MS) {
    return weatherCache.data;
  }
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    '?latitude=55.75&longitude=37.62' +
    '&daily=weather_code,temperature_2m_max' +
    '&timezone=Europe/Moscow&forecast_days=16';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`open-meteo -> ${res.status}`);
  const json = await res.json();
  const daily = json.daily || {};
  const dates = Array.isArray(daily.time) ? daily.time : [];
  const codes = Array.isArray(daily.weather_code) ? daily.weather_code : [];
  const temps = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
  const days = dates.map((date, i) => ({
    date,
    code: mapWeatherCode(Number(codes[i])),
    temp: Math.round(Number(temps[i])),
  }));
  const data = days.length
    ? { days, date: days[0].date, code: days[0].code, temp: days[0].temp }
    : { days: [] };
  weatherCache = { data, fetchedAt: now };
  return data;
}

// ============================================================
// Аналитика / sync / баннеры — все требуют db; если db не подключилась,
// эндпоинты отдают { ok: false, db_disabled: true } и НЕ падают.
// ============================================================
function requireDb() {
  if (!db) throw new HttpError(503, 'db_disabled');
}

// POST /api/event { event, payload }
function logEvent(userId, event, payload) {
  if (!db) return;
  const platform = payload?.platform || null;
  db.prepare(`
    INSERT INTO events (user_id, event, payload, platform)
    VALUES (?, ?, ?, ?)
  `).run(userId || 'anon', String(event || ''), JSON.stringify(payload || {}), platform);
}

// GET /api/banners?dismissed=1,3,7
function listActiveBanners(dismissed) {
  if (!db) return [];
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT id, title, body, btn_text, btn_url, type, color, frequency, dismissable, show_from, show_until
    FROM banners
    WHERE active = 1
      AND (show_from IS NULL OR show_from <= ?)
      AND (show_until IS NULL OR show_until >= ?)
    ORDER BY id ASC
  `).all(today, today);
  return rows
    .filter((b) => !dismissed.includes(b.id))
    .map((b) => ({
      id: b.id,
      title: b.title,
      body: b.body,
      btn_text: b.btn_text,
      btn_url: b.btn_url,
      type: b.type,
      color: b.color,
      frequency: b.frequency,
      dismissable: !!b.dismissable,
    }));
}

// Учёт показа баннера для CTR (отдельная таблица событий).
function logBannerImpression(bannerId, userId) {
  if (!db) return;
  db.prepare(`
    INSERT INTO events (user_id, event, payload)
    VALUES (?, 'banner_impression', ?)
  `).run(userId || 'anon', JSON.stringify({ banner_id: bannerId }));
}

// POST /api/sync — INSERT OR REPLACE
function upsertUserData(userId, payload) {
  if (!db) return null;
  const att = payload?.attendance ? JSON.stringify(payload.attendance) : null;
  const notes = payload?.notes ? JSON.stringify(payload.notes) : null;
  const gId = payload?.group_id || null;
  const gLabel = payload?.group_label || null;
  const settings = payload?.settings ? JSON.stringify(payload.settings) : null;
  const ts = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_data (user_id, attendance, notes, group_id, group_label, settings, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      attendance = COALESCE(excluded.attendance, attendance),
      notes = COALESCE(excluded.notes, notes),
      group_id = COALESCE(excluded.group_id, group_id),
      group_label = COALESCE(excluded.group_label, group_label),
      settings = COALESCE(excluded.settings, settings),
      updated_at = excluded.updated_at
  `).run(userId, att, notes, gId, gLabel, settings, ts);
  return ts;
}

// GET /api/sync
function readUserData(userId) {
  if (!db || !userId) return null;
  const row = db.prepare(`
    SELECT attendance, notes, group_id, group_label, settings, updated_at
    FROM user_data WHERE user_id = ?
  `).get(userId);
  if (!row) return null;
  const parse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
  return {
    attendance: row.attendance ? parse(row.attendance) : null,
    notes: row.notes ? parse(row.notes) : null,
    group_id: row.group_id,
    group_label: row.group_label,
    settings: row.settings ? parse(row.settings) : null,
    updated_at: row.updated_at,
  };
}

// ============================================================
// Админка — авторизация по ?token, опционально проверка user_id через
// initData (если он есть в заголовке).
// ============================================================
function requireAdmin(req, url) {
  if (!ADMIN_TOKEN) throw new HttpError(403, 'admin_disabled');
  if (url.searchParams.get('token') !== ADMIN_TOKEN) throw new HttpError(403, 'bad_token');
  // Доп. проверка ID (если фронт админки прокидывает initData) — но не обязательна.
  const raw = req.headers['x-telegram-init-data'];
  if (raw) {
    const r = verifyInitData(String(raw));
    if (r.ok && r.userId && r.userId !== String(ADMIN_ID)) {
      throw new HttpError(403, 'not_admin');
    }
  }
}

function adminStats() {
  requireDb();
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

  const dau = db.prepare(`SELECT COUNT(DISTINCT user_id) c FROM events WHERE ts > ? AND user_id != 'anon'`).get(dayAgo).c;
  const wau = db.prepare(`SELECT COUNT(DISTINCT user_id) c FROM events WHERE ts > ? AND user_id != 'anon'`).get(weekAgo).c;
  const mau = db.prepare(`SELECT COUNT(DISTINCT user_id) c FROM events WHERE ts > ? AND user_id != 'anon'`).get(monthAgo).c;
  const totalUsers = db.prepare(`SELECT COUNT(*) c FROM user_data`).get().c;
  const todayOpens = db.prepare(`SELECT COUNT(*) c FROM events WHERE event = 'app_open' AND ts > ?`).get(todayStart.toISOString()).c;

  const topGroups = db.prepare(`
    SELECT group_id, group_label, COUNT(*) c
    FROM user_data
    WHERE group_id IS NOT NULL
    GROUP BY group_id
    ORDER BY c DESC
    LIMIT 20
  `).all().map((r) => ({ group_id: r.group_id, label: r.group_label, count: r.c }));

  // Режимы — из user_data.settings (JSON). Считаем по последнему сохранённому.
  const modes = { day: 0, week: 0, feed: 0 };
  for (const row of db.prepare(`SELECT settings FROM user_data WHERE settings IS NOT NULL`).all()) {
    try {
      const s = JSON.parse(row.settings);
      const m = s?.displayMode;
      if (m && modes[m] != null) modes[m]++;
    } catch (_) { /* ignore */ }
  }

  const countEvent = (e) =>
    db.prepare(`SELECT COUNT(DISTINCT user_id) c FROM events WHERE event = ? AND user_id != 'anon'`).get(e).c;
  const funnel = {
    app_open: countEvent('app_open'),
    profile_open: countEvent('profile_open'),
    donate_click: countEvent('donate_click'),
  };

  const banners = db.prepare(`SELECT id, title FROM banners`).all().map((b) => {
    const shows = db.prepare(
      `SELECT COUNT(*) c FROM events WHERE event = 'banner_impression' AND json_extract(payload, '$.banner_id') = ?`
    ).get(b.id).c;
    const clicks = db.prepare(
      `SELECT COUNT(*) c FROM events WHERE event = 'banner_click' AND json_extract(payload, '$.banner_id') = ?`
    ).get(b.id).c;
    const dismisses = db.prepare(
      `SELECT COUNT(*) c FROM events WHERE event = 'banner_dismiss' AND json_extract(payload, '$.banner_id') = ?`
    ).get(b.id).c;
    const ctr = shows > 0 ? Math.round((clicks / shows) * 1000) / 10 : 0;
    return { id: b.id, title: b.title, shows, clicks, dismisses, ctr };
  });

  return {
    dau, wau, mau,
    total_users: totalUsers,
    today_opens: todayOpens,
    top_groups: topGroups,
    modes,
    funnel,
    banners,
  };
}

function adminListBanners() {
  requireDb();
  return db.prepare(`SELECT * FROM banners ORDER BY id DESC`).all();
}

function adminUpsertBanner(payload) {
  requireDb();
  const id = payload.id ? Number(payload.id) : null;
  const fields = {
    title: payload.title ?? '',
    body: payload.body ?? null,
    btn_text: payload.btn_text ?? null,
    btn_url: payload.btn_url ?? null,
    type: payload.type ?? 'info',
    color: payload.color ?? '#F59E0B',
    active: payload.active ? 1 : 0,
    show_from: payload.show_from || null,
    show_until: payload.show_until || null,
    frequency: Number(payload.frequency) || 5,
    dismissable: payload.dismissable ? 1 : 0,
  };
  if (id) {
    db.prepare(`
      UPDATE banners SET title=?, body=?, btn_text=?, btn_url=?, type=?, color=?, active=?, show_from=?, show_until=?, frequency=?, dismissable=?
      WHERE id=?
    `).run(fields.title, fields.body, fields.btn_text, fields.btn_url, fields.type, fields.color, fields.active, fields.show_from, fields.show_until, fields.frequency, fields.dismissable, id);
    return id;
  }
  const r = db.prepare(`
    INSERT INTO banners (title, body, btn_text, btn_url, type, color, active, show_from, show_until, frequency, dismissable)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(fields.title, fields.body, fields.btn_text, fields.btn_url, fields.type, fields.color, fields.active, fields.show_from, fields.show_until, fields.frequency, fields.dismissable);
  return r.lastInsertRowid;
}

function adminDeleteBanner(id) {
  requireDb();
  db.prepare(`DELETE FROM banners WHERE id = ?`).run(Number(id));
}

function adminListUsers(limit, offset) {
  requireDb();
  const lim = Math.min(Number(limit) || 50, 200);
  const off = Math.max(Number(offset) || 0, 0);
  const rows = db.prepare(`
    SELECT user_id, group_label, attendance, updated_at
    FROM user_data ORDER BY updated_at DESC LIMIT ? OFFSET ?
  `).all(lim, off);
  return rows.map((r) => {
    let attCount = 0;
    try {
      const a = JSON.parse(r.attendance || '{}');
      for (const s of Object.values(a || {})) attCount += Object.keys(s || {}).length;
    } catch (_) { /* ignore */ }
    return {
      user_id: r.user_id,
      group_label: r.group_label,
      attendance_marks: attCount,
      updated_at: r.updated_at,
    };
  });
}

// ============================================================
// Админка — inline HTML (vanilla JS, без фреймворков).
// ============================================================
function adminDashboardHTML(token) {
  const t = JSON.stringify(token);
  return `<!doctype html><html lang="ru"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>РсухСпейс — админка</title>
<style>
  :root { --bg:#0f0a2e; --surface:#1a1340; --border:#2c2456; --text:#fff; --muted:#8d85b3; --amber:#F59E0B; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; padding: 24px; line-height: 1.4; }
  h1 { font-size: 22px; margin-bottom: 24px; color: var(--amber); }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin: 24px 0 8px; }
  a { color: var(--amber); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  .kpi { font-size: 28px; font-weight: 700; color: var(--amber); }
  .label { font-size: 12px; color: var(--muted); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 6px; border-bottom: 1px solid var(--border); text-align: left; }
  th { color: var(--muted); font-weight: 600; }
  .nav { margin-bottom: 24px; }
  .nav a { margin-right: 16px; }
</style>
</head><body>
<div class="nav"><a href="/admin?token=${encodeURIComponent(token)}">Dashboard</a><a href="/admin/banners?token=${encodeURIComponent(token)}">Banners</a><a href="/admin/users?token=${encodeURIComponent(token)}">Users</a></div>
<h1>РсухСпейс — Dashboard</h1>
<div id="root">Loading…</div>
<script>
  const TOKEN = ${t};
  // Абсолютный путь '/admin/api/…' — относительный 'api/' от страницы '/admin'
  // резолвится в '/api/…' (без префикса /admin), и dashboard ходил мимо ручек.
  async function api(p) {
    const r = await fetch('/admin/api/' + p + '?token=' + encodeURIComponent(TOKEN));
    return r.json();
  }
  function el(t,a={},c='') { const e=document.createElement(t); Object.assign(e,a); if(c)e.innerHTML=c; return e; }
  function fmt(n){return (n||0).toLocaleString('ru-RU')}
  function row(k,v){return '<tr><td>'+k+'</td><td><b>'+fmt(v)+'</b></td></tr>'}
  (async () => {
    const s = await api('stats');
    const root = document.getElementById('root');
    if (s.error) { root.textContent = 'Ошибка: '+s.error; return; }
    root.innerHTML = '';
    // Обзор
    const ov = el('div',{className:'grid'});
    for (const [k,v] of [['DAU',s.dau],['WAU',s.wau],['MAU',s.mau],['Всего',s.total_users],['Сегодня open',s.today_opens]]) {
      ov.appendChild(el('div',{className:'card'},'<div class="kpi">'+fmt(v)+'</div><div class="label">'+k+'</div>'));
    }
    root.appendChild(el('h2',{},'Обзор'));
    root.appendChild(ov);
    // Топ групп
    root.appendChild(el('h2',{},'Топ групп'));
    root.appendChild(el('div',{className:'card'},
      '<table><thead><tr><th>Группа</th><th>Юзеров</th></tr></thead><tbody>' +
      s.top_groups.map(g => '<tr><td>'+(g.label||g.group_id)+'</td><td><b>'+g.count+'</b></td></tr>').join('') +
      '</tbody></table>'));
    // Режимы
    root.appendChild(el('h2',{},'Режимы отображения'));
    root.appendChild(el('div',{className:'card'},'<table>' + row('day',s.modes.day) + row('week',s.modes.week) + row('feed',s.modes.feed) + '</table>'));
    // Воронка
    const f = s.funnel;
    const pct = (n,base) => base>0 ? Math.round(n/base*100)+'%' : '—';
    root.appendChild(el('h2',{},'Воронка'));
    root.appendChild(el('div',{className:'card'},
      '<table>' +
      '<tr><td>app_open</td><td><b>'+fmt(f.app_open)+'</b></td><td></td></tr>' +
      '<tr><td>profile_open</td><td><b>'+fmt(f.profile_open)+'</b></td><td>'+pct(f.profile_open,f.app_open)+'</td></tr>' +
      '<tr><td>donate_click</td><td><b>'+fmt(f.donate_click)+'</b></td><td>'+pct(f.donate_click,f.app_open)+'</td></tr>' +
      '</table>'));
    // Баннеры
    root.appendChild(el('h2',{},'Баннеры'));
    root.appendChild(el('div',{className:'card'},
      '<table><thead><tr><th>#</th><th>Title</th><th>Показы</th><th>Клики</th><th>Dismiss</th><th>CTR</th></tr></thead><tbody>' +
      s.banners.map(b => '<tr><td>'+b.id+'</td><td>'+b.title+'</td><td>'+fmt(b.shows)+'</td><td>'+fmt(b.clicks)+'</td><td>'+fmt(b.dismisses)+'</td><td>'+b.ctr+'%</td></tr>').join('') +
      '</tbody></table>'));
  })().catch(e => { document.getElementById('root').textContent = 'Ошибка JS: '+e.message; });
</script>
</body></html>`;
}

function adminBannersHTML(token) {
  const t = JSON.stringify(token);
  return `<!doctype html><html lang="ru"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>РсухСпейс — баннеры</title>
<style>
  :root { --bg:#0f0a2e; --surface:#1a1340; --border:#2c2456; --text:#fff; --muted:#8d85b3; --amber:#F59E0B; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; padding: 24px; }
  h1 { font-size: 22px; color: var(--amber); margin-bottom: 16px; }
  a { color: var(--amber); }
  .nav { margin-bottom: 16px; } .nav a { margin-right: 16px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin-bottom: 12px; }
  label { display: block; font-size: 12px; color: var(--muted); margin-top: 8px; }
  input, textarea, select { width: 100%; padding: 8px; background: #0c0825; color: var(--text); border: 1px solid var(--border); border-radius: 6px; font-family: inherit; font-size: 14px; }
  textarea { min-height: 60px; resize: vertical; }
  button { background: var(--amber); color: #1a1340; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-weight: 700; margin-top: 12px; margin-right: 6px; }
  button.danger { background: #e63946; color: white; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .row { display: flex; gap: 12px; align-items: center; }
  .row label { display: inline-flex; align-items: center; gap: 6px; margin: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 6px; border-bottom: 1px solid var(--border); text-align: left; }
</style>
</head><body>
<div class="nav"><a href="/admin?token=${encodeURIComponent(token)}">Dashboard</a><a href="/admin/banners?token=${encodeURIComponent(token)}">Banners</a><a href="/admin/users?token=${encodeURIComponent(token)}">Users</a></div>
<h1>Баннеры</h1>
<div class="card" id="form-card">
  <h2 style="font-size:14px;color:var(--muted);margin-bottom:12px">Новый баннер</h2>
  <div class="grid2">
    <div><label>Заголовок</label><input id="title"/></div>
    <div><label>Тип</label><select id="type"><option value="info">info</option><option value="donate">donate</option><option value="link">link</option></select></div>
  </div>
  <label>Текст</label><textarea id="body"></textarea>
  <div class="grid2">
    <div><label>Текст кнопки</label><input id="btn_text"/></div>
    <div><label>URL кнопки</label><input id="btn_url"/></div>
  </div>
  <div class="grid2">
    <div><label>Цвет</label><input type="color" id="color" value="#F59E0B"/></div>
    <div><label>Частота (каждые N карточек)</label><input type="number" id="frequency" value="5"/></div>
  </div>
  <div class="grid2">
    <div><label>Показывать с</label><input type="date" id="show_from"/></div>
    <div><label>Показывать до</label><input type="date" id="show_until"/></div>
  </div>
  <div class="row">
    <label><input type="checkbox" id="active" checked/>Активен</label>
    <label><input type="checkbox" id="dismissable" checked/>Можно закрыть</label>
  </div>
  <input type="hidden" id="id"/>
  <button id="save">Сохранить</button>
  <button id="reset" class="danger">Сбросить форму</button>
</div>
<h2 style="font-size:14px;color:var(--muted);margin:16px 0 8px">Все баннеры</h2>
<div class="card">
  <table><thead><tr><th>#</th><th>Title</th><th>Type</th><th>Active</th><th>Действия</th></tr></thead><tbody id="rows"></tbody></table>
</div>
<script>
  const TOKEN = ${t};
  async function api(p, opt={}) {
    const url = '/admin/api/' + p + '?token=' + encodeURIComponent(TOKEN);
    const r = await fetch(url, opt);
    return r.json();
  }
  function $(id) { return document.getElementById(id); }
  function fill(b) {
    $('id').value = b.id || '';
    $('title').value = b.title || '';
    $('body').value = b.body || '';
    $('btn_text').value = b.btn_text || '';
    $('btn_url').value = b.btn_url || '';
    $('type').value = b.type || 'info';
    $('color').value = b.color || '#F59E0B';
    $('frequency').value = b.frequency || 5;
    $('show_from').value = b.show_from || '';
    $('show_until').value = b.show_until || '';
    $('active').checked = !!b.active;
    $('dismissable').checked = b.dismissable !== 0 && b.dismissable !== false;
  }
  function reset() { fill({}); }
  async function render() {
    const list = await api('banners');
    $('rows').innerHTML = (list.banners||list||[]).map(b =>
      '<tr><td>'+b.id+'</td><td>'+b.title+'</td><td>'+b.type+'</td><td>'+(b.active?'✓':'—')+'</td>' +
      '<td><a href="#" data-edit="'+b.id+'">edit</a> · <a href="#" data-del="'+b.id+'">delete</a></td></tr>'
    ).join('');
    document.querySelectorAll('[data-edit]').forEach(a => a.onclick = async (e) => {
      e.preventDefault();
      const id = +a.dataset.edit;
      const list2 = await api('banners');
      const items = list2.banners||list2||[];
      const b = items.find(x => x.id === id);
      if (b) fill(b);
    });
    document.querySelectorAll('[data-del]').forEach(a => a.onclick = async (e) => {
      e.preventDefault();
      if (!confirm('Удалить баннер #'+a.dataset.del+'?')) return;
      await api('banners', { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id: +a.dataset.del}) });
      render();
    });
  }
  $('save').onclick = async () => {
    const payload = {
      id: $('id').value ? +$('id').value : null,
      title: $('title').value,
      body: $('body').value,
      btn_text: $('btn_text').value,
      btn_url: $('btn_url').value,
      type: $('type').value,
      color: $('color').value,
      frequency: +$('frequency').value,
      show_from: $('show_from').value || null,
      show_until: $('show_until').value || null,
      active: $('active').checked,
      dismissable: $('dismissable').checked,
    };
    await api('banners', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    reset(); render();
  };
  $('reset').onclick = reset;
  render();
</script>
</body></html>`;
}

function adminUsersHTML(token) {
  const t = JSON.stringify(token);
  return `<!doctype html><html lang="ru"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>РсухСпейс — юзеры</title>
<style>
  :root { --bg:#0f0a2e; --surface:#1a1340; --border:#2c2456; --text:#fff; --muted:#8d85b3; --amber:#F59E0B; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; padding: 24px; }
  h1 { font-size: 22px; color: var(--amber); margin-bottom: 16px; }
  a { color: var(--amber); }
  .nav { margin-bottom: 16px; } .nav a { margin-right: 16px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 6px; border-bottom: 1px solid var(--border); text-align: left; }
  button { background: var(--amber); color: #1a1340; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-weight: 700; }
</style>
</head><body>
<div class="nav"><a href="/admin?token=${encodeURIComponent(token)}">Dashboard</a><a href="/admin/banners?token=${encodeURIComponent(token)}">Banners</a><a href="/admin/users?token=${encodeURIComponent(token)}">Users</a></div>
<h1>Юзеры</h1>
<div class="card">
  <table><thead><tr><th>user_id</th><th>группа</th><th>отметок</th><th>last sync</th></tr></thead><tbody id="rows"></tbody></table>
  <p style="margin-top:12px"><button id="more">Загрузить ещё</button></p>
</div>
<script>
  const TOKEN = ${t};
  let offset = 0; const LIMIT = 50;
  async function load() {
    const r = await fetch('/admin/api/users?token=' + encodeURIComponent(TOKEN) + '&limit=' + LIMIT + '&offset=' + offset);
    const json = await r.json();
    const users = json.users || [];
    const rows = users.map(u => '<tr><td>'+u.user_id+'</td><td>'+(u.group_label||'')+'</td><td>'+u.attendance_marks+'</td><td>'+(u.updated_at||'')+'</td></tr>').join('');
    document.getElementById('rows').insertAdjacentHTML('beforeend', rows);
    if (users.length < LIMIT) document.getElementById('more').style.display = 'none';
    offset += LIMIT;
  }
  document.getElementById('more').onclick = load;
  load();
</script>
</body></html>`;
}

// ============================================================
// Роутинг
// ============================================================
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const q = url.searchParams;

  try {
    // — Health —
    if (path === '/' || path === '/health') {
      return sendJSON(res, 200, {
        ok: true,
        service: 'rsuhspace-proxy',
        db: db ? 'ok' : 'disabled',
        db_error: dbErr || undefined,
      });
    }

    // — Старые прокси-эндпоинты (без обязательной auth) —
    if (path === '/api/flows') {
      authSoft(req); // если header пришёл — валидируем; иначе пускаем
      const form = q.get('form');
      const course = q.get('course');
      if (!form || !course) return sendJSON(res, 400, { error: 'form and course required' });
      return sendJSON(res, 200, await getFlows(form, course));
    }
    if (path === '/api/schedule') {
      authSoft(req);
      const mode = q.get('mode');
      if (mode === 'teacher') {
        const teacher = q.get('teacher');
        if (!teacher) return sendJSON(res, 400, { error: 'teacher required' });
        return sendJSON(res, 200, await getTeacherSchedule(teacher));
      }
      const flow = q.get('flow');
      const form = q.get('form');
      const course = q.get('course');
      if (!flow || !form || !course) return sendJSON(res, 400, { error: 'flow, form and course required' });
      return sendJSON(res, 200, await getSchedule(flow, form, course));
    }
    if (path === '/api/teachers') {
      authSoft(req);
      return sendJSON(res, 200, await getTeachers());
    }
    if (path === '/api/weather') {
      authSoft(req);
      return sendJSON(res, 200, await getWeather());
    }

    // — Аналитика —
    if (path === '/api/event' && req.method === 'POST') {
      const userId = authSoft(req);
      const body = await readBody(req);
      logEvent(userId, body.event, body.payload || {});
      // Спец: если событие 'banner_impression' пришло клиентом — это нормально,
      // мы сами добавляем такое же через listActiveBanners? Нет, impression
      // пишет именно клиент при показе. Логируем как обычно.
      return sendJSON(res, 200, { ok: true });
    }

    // — Sync —
    if (path === '/api/sync') {
      const userId = authSoft(req);
      if (!userId) return sendJSON(res, 401, { error: 'no_user' });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const ts = upsertUserData(userId, body);
        return sendJSON(res, 200, { ok: true, ts });
      }
      if (req.method === 'GET') {
        const data = readUserData(userId);
        if (!data) return sendJSON(res, 200, { empty: true });
        return sendJSON(res, 200, data);
      }
      return sendJSON(res, 405, { error: 'method_not_allowed' });
    }

    // — Баннеры —
    if (path === '/api/banners' && req.method === 'GET') {
      const userId = authSoft(req);
      const dismissedRaw = q.get('dismissed') || '';
      const dismissed = dismissedRaw.split(',').map((s) => Number(s)).filter((n) => !Number.isNaN(n));
      const banners = listActiveBanners(dismissed);
      // Учитываем показы — по одному на каждый возвращённый баннер (impression).
      // Реальный показ всё равно идёт на клиенте, но сервер фиксирует факт того,
      // что баннер был отдан в выдаче (это «impression»).
      for (const b of banners) logBannerImpression(b.id, userId);
      return sendJSON(res, 200, { banners });
    }

    // — Админка —
    if (path === '/admin' || path === '/admin/') {
      requireAdmin(req, url);
      return sendHTML(res, 200, adminDashboardHTML(ADMIN_TOKEN));
    }
    if (path === '/admin/banners') {
      requireAdmin(req, url);
      return sendHTML(res, 200, adminBannersHTML(ADMIN_TOKEN));
    }
    if (path === '/admin/users') {
      requireAdmin(req, url);
      return sendHTML(res, 200, adminUsersHTML(ADMIN_TOKEN));
    }
    if (path === '/admin/api/stats') {
      requireAdmin(req, url);
      return sendJSON(res, 200, adminStats());
    }
    if (path === '/admin/api/banners') {
      requireAdmin(req, url);
      if (req.method === 'GET') return sendJSON(res, 200, { banners: adminListBanners() });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const id = adminUpsertBanner(body);
        return sendJSON(res, 200, { ok: true, id });
      }
      if (req.method === 'DELETE') {
        const body = await readBody(req);
        adminDeleteBanner(body.id);
        return sendJSON(res, 200, { ok: true });
      }
      return sendJSON(res, 405, { error: 'method_not_allowed' });
    }
    if (path === '/admin/api/users') {
      requireAdmin(req, url);
      const users = adminListUsers(q.get('limit'), q.get('offset'));
      return sendJSON(res, 200, { users });
    }

    return sendJSON(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof HttpError) {
      return sendJSON(res, err.status, { error: err.message });
    }
    console.error(`[${req.method} ${path}]`, err.message);
    return sendJSON(res, 502, { error: 'upstream_failed' });
  }
});

server.listen(PORT, () => {
  console.log(`rsuhspace-proxy слушает :${PORT} (API_URL=${API_URL || 'НЕ ЗАДАН'}, DB=${db ? DB_PATH : 'disabled'})`);
});
