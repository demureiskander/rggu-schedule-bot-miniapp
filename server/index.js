// Standalone прокси для Mini App «РсухСпейс».
// Отдельный Railway-сервис (root = server/), независимый от бота.
// Делает: проксирует API РГГУ (с CORS) + кэширует погоду Москвы из open-meteo.
//
// Эндпоинты:
//   GET /api/flows?form=<id>&course=<n>      -> [{ id, name, details }]
//   GET /api/schedule?flow=<id>&form=<id>&course=<n> -> { item, tblData }
//   GET /api/weather                         -> { days: [{date,code,temp}*16], + date/code/temp (compat)
//   GET /            (health-check)          -> { ok: true }
//
// Требует Node >= 18 (глобальные fetch / FormData / Blob).

import http from 'node:http';

const PORT = process.env.PORT || 3000;
// Upstream базы официального API РГГУ (заказчик берёт из кода бота).
const API_URL = (process.env.API_URL || '').replace(/\/+$/, '');
// Origin для CORS. '*' допустим — расписание публичное.
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

// --- CORS ---
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
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

// --- Upstream-вызовы API РГГУ ---
// Upstream — Yandex Cloud Function. Метод передаётся НЕ как path-сегмент, а как
// query-параметр ?method=/<Метод> (значение начинается со слэша — так шлёт бот).
// Тело — FormData (multipart). Поля:
//   Get_Flows_List:     поле '0' = JSON { eduform, course }
//   Get_Schedule_Table: eduform, course, flow, intervalMode=4, menuMode=flow
// ВНИМАНИЕ: eduform — числовой id формы ('1'..'12'), НЕ код '1-Б-О'.

async function callUpstream(method, formData) {
  if (!API_URL) throw new Error('API_URL not configured');
  // Литеральный слэш в значении (method=/Get_Flows_List) — как шлёт бот.
  const url = `${API_URL}?method=/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    body: formData,
  });
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
  // Отдаём как есть — нормализация в карту по датам делается на фронте (api.js).
  return { item: data?.item ?? '', tblData: Array.isArray(data?.tblData) ? data.tblData : [] };
}

// --- Погода: open-meteo, без ключа, кэш на сутки ---
const WEATHER_TTL_MS = 24 * 60 * 60 * 1000;
let weatherCache = null; // { data, fetchedAt }

// WMO weather_code -> нормализованный code.
function mapWeatherCode(wmo) {
  if (wmo === 0) return 'clear';
  if ([1, 2, 3].includes(wmo)) return 'clouds';
  if ([45, 48].includes(wmo)) return 'fog';
  if ([71, 73, 75, 77, 85, 86].includes(wmo)) return 'snow';
  if ([95, 96, 99].includes(wmo)) return 'storm';
  // 51..67 (морось/дождь), 80..82 (ливни) и прочее осадочное -> rain
  if ((wmo >= 51 && wmo <= 67) || [80, 81, 82].includes(wmo)) return 'rain';
  return 'clouds';
}

async function getWeather() {
  const now = Date.now();
  if (weatherCache && now - weatherCache.fetchedAt < WEATHER_TTL_MS) {
    return weatherCache.data;
  }
  // Daily-прогноз на 16 дней (максимум open-meteo). temperature_2m_max —
  // дневной максимум; ставку на min/avg не делаем — пользователю важнее
  // «насколько тепло будет».
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
  // Обратная совместимость со старым фронтом: дублируем корневые date/code/temp
  // с первого дня (фронт ?v<15 ждёт именно такой shape).
  const data = days.length
    ? { days, date: days[0].date, code: days[0].code, temp: days[0].temp }
    : { days: [] };
  weatherCache = { data, fetchedAt: now };
  return data;
}

// --- Роутинг ---
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const q = url.searchParams;

  try {
    if (path === '/' || path === '/health') {
      return sendJSON(res, 200, { ok: true, service: 'rsuhspace-proxy' });
    }

    if (path === '/api/flows') {
      const form = q.get('form');
      const course = q.get('course');
      if (!form || !course) return sendJSON(res, 400, { error: 'form and course required' });
      return sendJSON(res, 200, await getFlows(form, course));
    }

    if (path === '/api/schedule') {
      const flow = q.get('flow');
      const form = q.get('form');
      const course = q.get('course');
      if (!flow || !form || !course) {
        return sendJSON(res, 400, { error: 'flow, form and course required' });
      }
      return sendJSON(res, 200, await getSchedule(flow, form, course));
    }

    if (path === '/api/weather') {
      return sendJSON(res, 200, await getWeather());
    }

    return sendJSON(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(`[${req.method} ${path}]`, err.message);
    return sendJSON(res, 502, { error: 'upstream_failed' });
  }
});

server.listen(PORT, () => {
  console.log(`rsuhspace-proxy слушает :${PORT} (API_URL=${API_URL || 'НЕ ЗАДАН'})`);
});
