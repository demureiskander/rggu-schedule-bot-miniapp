// Состояние приложения + persistence.
// Persistence: Telegram CloudStorage (синхронизируется между устройствами) с
// fallback на localStorage. В памяти держим текущее состояние и кэш расписания.

import { cloudGet, cloudSet, hasCloudStorage } from './telegram.js?v=27';

const LS_PREFIX = 'rsuhspace:';

// Ключи, которые персистим.
const PERSIST_KEYS = ['group', 'layout', 'displayMode', 'theme', 'weatherEnabled', 'highlightEmptyDays'];

// Ключи, реально найденные в хранилище при loadState (для «первого запуска»).
const persistedKeys = new Set();

// Состояние в памяти.
const state = {
  group: null,            // { form, year, id, name, details }
  layout: 'block',        // 'block' | 'compact' | 'ribbon' (рендер одной пары)
  displayMode: 'week',    // 'day' | 'week' (что показывать — один день или неделю)
  theme: 'dark',          // 'dark' | 'light'
  weatherEnabled: false,  // boolean
  highlightEmptyDays: true, // boolean — серое выделение дней без пар

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
  return key === 'group' ? JSON.stringify(value) : String(value);
}

function deserialize(key, raw) {
  if (raw == null) return undefined;
  if (key === 'group') {
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
};

// Устанавливает персистентное поле и сохраняет его.
export async function set(key, value) {
  if (!PERSIST_KEYS.includes(key)) {
    throw new Error(`set(): "${key}" не персистентный ключ`);
  }
  state[key] = value;
  persistedKeys.add(key);
  await writePersisted(key, serialize(key, value));
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
