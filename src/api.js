// Слой запросов к эндпоинтам бота + нормализация ответов под нужды фронта.
// Бот уже отдаёт нормализованный JSON (см. CLAUDE.md §4); здесь мы только
// приводим расписание к удобной для рендера форме (карта по датам + тайм-слоты).

import { API_BASE } from '../config.js?v=5';
import { TIME_SLOTS } from './constants.js?v=5';

// Унифицированный GET. Бросает Error при сетевой ошибке/не-2xx —
// человекочитаемые сообщения для пользователя формируются в слое экранов.
async function getJSON(path) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: 'application/json' },
    });
  } catch (_) {
    throw new Error('network');
  }
  if (!res.ok) throw new Error(`http_${res.status}`);
  try {
    return await res.json();
  } catch (_) {
    throw new Error('bad_json');
  }
}

// Превращает "-" в пустую строку (API иногда так помечает «нет данных»).
function clean(value) {
  const v = (value ?? '').toString().trim();
  return v === '-' ? '' : v;
}

// --- /api/flows ---
// Возвращает [{ id, name, details }].
export async function fetchFlows(formCode, course) {
  const q = `?form=${encodeURIComponent(formCode)}&course=${encodeURIComponent(course)}`;
  const data = await getJSON(`/flows${q}`);
  if (!Array.isArray(data)) return [];
  return data.map((f) => ({
    id: f.id,
    name: clean(f.name),
    details: clean(f.details),
  }));
}

// --- /api/schedule ---
// Нормализует tblData в { item, byDate, dates, fetchedAt }.
// byDate: { 'ДД.ММ.ГГГГ': [lesson] }, lesson = одна строка занятия с тайм-слотом.
// dates: отсортированный массив ключей 'ДД.ММ.ГГГГ' для листания.
export async function fetchSchedule(flowId, formCode, course) {
  const q =
    `?flow=${encodeURIComponent(flowId)}` +
    `&form=${encodeURIComponent(formCode)}` +
    `&course=${encodeURIComponent(course)}`;
  const data = await getJSON(`/schedule${q}`);
  return normalizeSchedule(data);
}

function normalizeSchedule(data) {
  const byDate = {};
  const tbl = Array.isArray(data?.tblData) ? data.tblData : [];

  for (const day of tbl) {
    // day.date = "ДД.ММ.ГГГГ Деньнедели" — отделяем ключ-дату.
    const dateKey = (day.date || '').trim().split(/\s+/)[0];
    if (!dateKey) continue;

    const lessons = [];
    for (const slot of day.pairs || []) {
      const pairNum = Number(slot.pair);
      const time = TIME_SLOTS[pairNum - 1] || { start: '', end: '' };
      for (const flow of slot.flows || []) {
        lessons.push({
          pair: pairNum,
          start: time.start,
          end: time.end,
          subject: clean(flow.subject),
          lessontype: clean(flow.lessontype),
          teacher: clean(flow.teacher),
          room: clean(flow.room),
          flow: clean(flow.flow),
          group: clean(flow.group),
          subgroup: clean(flow.subgroup),
          course: clean(flow.course),
        });
      }
    }
    lessons.sort((a, b) => a.pair - b.pair);
    byDate[dateKey] = lessons;
  }

  return {
    item: clean(data?.item),
    byDate,
    dates: Object.keys(byDate).sort(sortDateKeys),
    fetchedAt: Date.now(),
  };
}

// Сравнение ключей "ДД.ММ.ГГГГ" по реальной дате.
function sortDateKeys(a, b) {
  return dateKeyToTs(a) - dateKeyToTs(b);
}

// "ДД.ММ.ГГГГ" -> timestamp (локальная полночь).
export function dateKeyToTs(key) {
  const [d, m, y] = key.split('.').map(Number);
  return new Date(y, m - 1, d).getTime();
}

// Date -> ключ "ДД.ММ.ГГГГ".
export function tsToDateKey(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${d}.${m}.${date.getFullYear()}`;
}

// --- /api/weather ---
// Возвращает { date, code, temp } или null (погода опциональна, не блокирует).
export async function fetchWeather() {
  try {
    const w = await getJSON('/weather');
    if (!w || !w.code) return null;
    return { date: w.date, code: w.code, temp: w.temp };
  } catch (_) {
    return null;
  }
}
