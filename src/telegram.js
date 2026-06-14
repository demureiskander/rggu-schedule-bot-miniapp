// Обёртка над Telegram WebApp SDK.
// SDK подключается скриптом в index.html (window.Telegram.WebApp).
// Все вызовы безопасны вне Telegram (например, при локальной отладке в браузере).

const tg = window.Telegram?.WebApp ?? null;

export function isTelegram() {
  // Внутри Telegram initData непустой; в обычном браузере — пустой.
  return Boolean(tg && tg.initData);
}

// Старт: сообщаем о готовности и разворачиваем на весь экран.
export function initWebApp() {
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
  } catch (_) { /* нет SDK — игнорируем */ }
}

// Цветовая схема Telegram: 'dark' | 'light' (или null вне Telegram).
export function colorScheme() {
  return tg?.colorScheme ?? null;
}

// Параметры темы Telegram (можно подмешивать в наши цвета).
export function themeParams() {
  return tg?.themeParams ?? {};
}

// Подписка на смену темы Telegram.
export function onThemeChanged(cb) {
  if (!tg) return;
  tg.onEvent('themeChanged', cb);
}

// --- BackButton ---
// Хендлер регистрируется один раз (onBackButton), видимость — setBackVisible.
export function onBackButton(handler) {
  if (!tg?.BackButton) return;
  tg.BackButton.onClick(handler);
}

export function setBackVisible(visible) {
  if (!tg?.BackButton) return;
  if (visible) tg.BackButton.show();
  else tg.BackButton.hide();
}

// --- HapticFeedback ---
export function haptic(style = 'light') {
  try {
    tg?.HapticFeedback?.impactOccurred(style);
  } catch (_) { /* не поддерживается — тихо */ }
}

export function hapticSelection() {
  try {
    tg?.HapticFeedback?.selectionChanged();
  } catch (_) { /* тихо */ }
}

// --- CloudStorage (с проверкой доступности) ---
// Возвращает Promise<string|null>. Если CloudStorage нет — резолвит null,
// чтобы вызывающий код мог сделать fallback на localStorage.
export function cloudGet(key) {
  return new Promise((resolve) => {
    if (!tg?.CloudStorage?.getItem) return resolve(null);
    try {
      tg.CloudStorage.getItem(key, (err, value) => {
        resolve(err ? null : (value || null));
      });
    } catch (_) {
      resolve(null);
    }
  });
}

export function cloudSet(key, value) {
  return new Promise((resolve) => {
    if (!tg?.CloudStorage?.setItem) return resolve(false);
    try {
      tg.CloudStorage.setItem(key, value, (err, ok) => resolve(!err && ok));
    } catch (_) {
      resolve(false);
    }
  });
}

export function hasCloudStorage() {
  return Boolean(tg?.CloudStorage?.getItem);
}
