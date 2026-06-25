// Аналитика + sync + баннеры. Все вызовы беззвучно глотают ошибки —
// аналитика никогда не должна ломать приложение.

import { API_BASE } from '../config.js?v=53';

function getInitData() {
  try { return window.Telegram?.WebApp?.initData || ''; }
  catch (_) { return ''; }
}

function getPlatform() {
  try { return window.Telegram?.WebApp?.platform || 'web'; }
  catch (_) { return 'web'; }
}

// POST /api/event. payload автоматически дополняется platform.
export async function trackEvent(event, payload = {}) {
  try {
    const initData = getInitData();
    if (!initData) return; // вне Telegram — не шумим
    const body = { event, payload: { platform: getPlatform(), ...payload } };
    await fetch(`${API_BASE}/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify(body),
      keepalive: true,
    });
  } catch (_) { /* swallow */ }
}

// Debounced sync — вызывается при изменении attendance/settings/group.
// Накатывает целый снимок (не дельту) — простой и надёжный INSERT OR REPLACE.
let syncTimer = null;
const SYNC_DELAY_MS = 5000;

export function scheduleSync(data) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(data), SYNC_DELAY_MS);
}

export async function syncNow(data) {
  try {
    const initData = getInitData();
    if (!initData) return;
    await fetch(`${API_BASE}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify(data),
      keepalive: true,
    });
  } catch (_) { /* swallow */ }
}

// GET /api/sync. Возвращает снимок пользовательских данных с сервера или null.
// Фронт использует только если CloudStorage пуст (первый запуск/новое устройство).
export async function restoreFromServer() {
  try {
    const initData = getInitData();
    if (!initData) return null;
    const res = await fetch(`${API_BASE}/sync`, {
      headers: { 'X-Telegram-Init-Data': initData },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.empty) return null;
    return data;
  } catch (_) { return null; }
}

// GET /api/banners?dismissed=1,3. Возвращает массив активных баннеров.
export async function fetchBanners(dismissedIds = []) {
  try {
    const initData = getInitData();
    const headers = initData ? { 'X-Telegram-Init-Data': initData } : {};
    const qs = dismissedIds.length ? `?dismissed=${dismissedIds.join(',')}` : '';
    const res = await fetch(`${API_BASE}/banners${qs}`, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.banners) ? data.banners : [];
  } catch (_) { return []; }
}
