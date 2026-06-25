// Состояние приложения + persistence.
// Persistence: Telegram CloudStorage (синхронизируется между устройствами) с
// fallback на localStorage. В памяти держим текущее состояние и кэш расписания.

import { cloudGet, cloudSet, hasCloudStorage } from './telegram.js?v=51';

const LS_PREFIX = 'rsuhspace:';

// Ключи, которые персистим.
const PERSIST_KEYS = ['group', 'layout', 'displayMode', 'theme', 'weatherEnabled', 'highlightEmptyDays', 'attendance', 'dismissed_banners'];

// Ключи, реально найденные в хранилище при loadState (для «первого запуска»).
const persistedKeys = new Set();

// Состояние в памяти.
const state = {
  group: null,            // { form, year, id, name, details }
  layout: 'block',        // 'block' | 'compact' | 'ribbon' (рендер одной пары)
  displayMode: 'feed',    // 'day' | 'week' | 'feed' (один день / неделя / лента всего семестра)
                          // Дефолт для новых пользователей — 'feed'. Существующие
                          // сохраняют свой выбор (persistence по ключу displayMode).
  theme: 'dark',          // 'dark' | 'light'
  weatherEnabled: false,  // boolean
  highlightEmptyDays: true, // boolean — серое выделение дней без пар
  // Посещаемость: { [subject]: { [dateKey 'ДД.ММ.ГГГГ']: { status, note? } } }
  // status: 'present' | 'absent'. Если ключа нет — статус «не отмечено».
  // Хранится в CloudStorage (4KB лимит на ключ — для типичных 10–15 предметов
  // помещается), c зеркалом в localStorage. JSON-сериализация.
  attendance: {},
  // ID баннеров, которые юзер закрыл крестиком. Шлём на сервер при
  // /api/banners — чтобы их не возвращало.
  dismissed_banners: [],

  // Сессионное (не персистим):
  schedule: null,         // { byDate: { 'ДД.ММ.ГГГГ': [lesson...] }, dates: [...], fetchedAt }
  weather: null,          // { days: [{ date:'YYYY-MM-DD', code, temp }*16] }
};

// --- low-level persistence ---

function lsGet(key) {
  try {
    return localStorage.getItem(LS_PREFIX + key);
  } catch (_) {
    return null;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, value);
  } catch (_) { /* приватный режим / переполнение — тихо */ }
}

// Читает значение: сначала CloudStorage, затем localStorage.
async function readPersisted(key) {
  if (hasCloudStorage()) {
    const v = await cloudGet(key);
    if (v != null) return v;
  }
  return lsGet(key);
}

// Пишет значение и в CloudStorage (если есть), и в localStorage (зеркало).
async function writePersisted(key, value) {
  lsSet(key, value);
  if (hasCloudStorage()) await cloudSet(key, value);
}

// --- сериализация значений ---

function serialize(key, value) {
  if (key === 'group' || key === 'attendance' || key === 'dismissed_banners') return JSON.stringify(value);
  return String(value);
}

function deserialize(key, raw) {
  if (raw == null) return undefined;
  if (key === 'group' || key === 'attendance' || key === 'dismissed_banners') {
    try { return JSON.parse(raw); } catch (_) { return undefined; }
  }
  if (key === 'weatherEnabled' || key === 'highlightEmptyDays') return raw === 'true';
  // Миграция: раньше «недельный вид» был четвёртым layout. Теперь это
  // отдельный displayMode='week' — нужно превратить старое значение.
  if (key === 'layout' && raw === 'weekly') return 'block';
  return raw;
}

// --- публичный API ---

// Загружает персистентные поля в state. Вызывать один раз на старте.
export async function loadState() {
  let legacyWeekly = false;
  for (const key of PERSIST_KEYS) {
    const raw = await readPersisted(key);
    if (key === 'layout' && raw === 'weekly') legacyWeekly = true;
    const value = deserialize(key, raw);
    if (value !== undefined) {
      state[key] = value;
      persistedKeys.add(key);
    }
  }
  // Миграция: пользователи со старым layout='weekly' переезжают на
  // displayMode='week' (если он явно ещё не задан) — сохраняем намерение.
  if (legacyWeekly && !persistedKeys.has('displayMode')) {
    state.displayMode = 'week';
    persistedKeys.add('displayMode');
    await writePersisted('displayMode', 'week');
  }
  return getState();
}

// Было ли значение ключа найдено в хранилище на старте (а не дефолт).
export function isPersisted(key) {
  return persistedKeys.has(key);
}

// Снимок состояния (только чтение).
export function getState() {
  return { ...state };
}

// Геттеры по полям.
export const get = {
  group: () => state.group,
  layout: () => state.layout,
  displayMode: () => state.displayMode,
  theme: () => state.theme,
  weatherEnabled: () => state.weatherEnabled,
  highlightEmptyDays: () => state.highlightEmptyDays,
  schedule: () => state.schedule,
  weather: () => state.weather,
  attendance: () => state.attendance || {},
  dismissedBanners: () => Array.isArray(state.dismissed_banners) ? state.dismissed_banners : [],
};

// Добавить ID баннера в список закрытых (дедуп). Сразу пишется в persistence.
export async function dismissBanner(id) {
  const cur = new Set(Array.isArray(state.dismissed_banners) ? state.dismissed_banners : []);
  cur.add(Number(id));
  state.dismissed_banners = [...cur];
  persistedKeys.add('dismissed_banners');
  await writePersisted('dismissed_banners', JSON.stringify(state.dismissed_banners));
}

// Точечный апдейт посещаемости: одна ячейка [subject][dateKey] = {status, note?}.
// Передан null/undefined как status — запись удаляется. Сразу пишется в store
// и в persistence.
export async function setAttendanceCell(subject, dateKey, status, note) {
  const att = { ...(state.attendance || {}) };
  const day = { ...(att[subject] || {}) };
  if (status == null) {
    delete day[dateKey];
  } else {
    day[dateKey] = note ? { status, note } : { status };
  }
  if (Object.keys(day).length) att[subject] = day;
  else delete att[subject];
  state.attendance = att;
  persistedKeys.add('attendance');
  await writePersisted('attendance', JSON.stringify(att));
  notifyDataChanged();
}

// — Зеркало state на сервер (debounced). Хук вызывается из setAttendanceCell,
// set('group'|'displayMode'|'layout'|'theme'). Реализация (analytics.scheduleSync)
// прокидывается через registerSyncHook в main.js — store сам не импортирует
// analytics, чтобы не создавать циклический import.
let onDataChanged = null;
export function registerSyncHook(fn) { onDataChanged = fn; }
function notifyDataChanged() {
  if (!onDataChanged) return;
  try { onDataChanged(buildSyncSnapshot()); } catch (_) {}
}
function buildSyncSnapshot() {
  return {
    attendance: state.attendance || {},
    group_id: state.group?.id || null,
    group_label: state.group ? `${state.group.name}${state.group.details ? ' · ' + state.group.details : ''}` : null,
    settings: {
      displayMode: state.displayMode,
      layout: state.layout,
      theme: state.theme,
      weatherEnabled: state.weatherEnabled,
      highlightEmptyDays: state.highlightEmptyDays,
    },
  };
}

// Устанавливает персистентное поле и сохраняет его.
export async function set(key, value) {
  if (!PERSIST_KEYS.includes(key)) {
    throw new Error(`set(): "${key}" не персистентный ключ`);
  }
  state[key] = value;
  persistedKeys.add(key);
  await writePersisted(key, serialize(key, value));
  // dismissed_banners в зеркале не нужен — у каждого юзера свой локальный список.
  if (key !== 'dismissed_banners') notifyDataChanged();
}

// Применить снимок с сервера (restoreFromServer) к state. Записывает в
// persistence через стандартный writePersisted — отсюда зеркалится в обе
// бочки (Cloud + LS). Вызывается main.js при пустом локальном state.
export async function applyServerSnapshot(snap) {
  if (!snap) return;
  if (snap.attendance && Object.keys(snap.attendance).length) {
    state.attendance = snap.attendance;
    persistedKeys.add('attendance');
    await writePersisted('attendance', JSON.stringify(snap.attendance));
  }
  const s = snap.settings || {};
  for (const k of ['displayMode', 'layout', 'theme']) {
    if (s[k] != null && PERSIST_KEYS.includes(k)) {
      state[k] = s[k];
      persistedKeys.add(k);
      await writePersisted(k, serialize(k, s[k]));
    }
  }
  for (const k of ['weatherEnabled', 'highlightEmptyDays']) {
    if (typeof s[k] === 'boolean') {
      state[k] = s[k];
      persistedKeys.add(k);
      await writePersisted(k, serialize(k, s[k]));
    }
  }
}

// --- Кэш расписания на сессию (по группе, инвалидация после ~22:30 МСК) ---
// state.schedule = { groupId, data } | null. data = результат normalizeSchedule.

// Граница обновления: последняя точка 22:30 МСК (= 19:30 UTC) перед `now`.
function lastRefreshBoundary(now = Date.now()) {
  const d = new Date(now);
  const boundary = Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 19, 30, 0,
  );
  return now >= boundary ? boundary : boundary - 24 * 60 * 60 * 1000;
}

// Свежий ли кэш для группы: та же группа и загружен после последней границы.
export function getFreshSchedule(groupId) {
  const cache = state.schedule;
  if (!cache || cache.groupId !== groupId) return null;
  if (cache.data.fetchedAt < lastRefreshBoundary()) return null;
  return cache.data;
}

export function setScheduleFor(groupId, data) {
  state.schedule = { groupId, data };
}

// Сессионные сеттеры (без persistence).
export function setSchedule(schedule) {
  state.schedule = schedule;
}

export function setWeather(weather) {
  state.weather = weather;
}

// Сброс группы (при «Сменить группу»).
export async function clearGroup() {
  state.group = null;
  state.schedule = null;
  await writePersisted('group', JSON.stringify(null));
}
