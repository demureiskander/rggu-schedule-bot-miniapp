// Точка входа: инициализация SDK/темы/persistence + стек-роутер экранов.

import { initWebApp, onBackButton, setBackVisible } from './telegram.js?v=35';
import { loadState, get } from './store.js?v=35';
import { applyTheme, resolveInitialTheme } from './theme.js?v=35';
import * as screens from './screens.js?v=35';

const appEl = document.getElementById('app');

// Реестр экранов. settings/детали пары — bottom sheet'ы, не экраны.
const ROUTES = {
  welcome: screens.renderWelcome,
  picker: screens.renderPicker,
  schedule: screens.renderSchedule,
};

// Сохранённая группа считается валидной, если есть форма, id и имя.
function isValidGroup(g) {
  return Boolean(g && g.form && g.id && g.name);
}

// --- Стек-роутер ---
// Каждый кадр: { name, params }. BackButton показываем при глубине > 1.
let stack = [];

const router = {
  navigate(name, params = {}, { replace = false } = {}) {
    if (replace && stack.length) stack[stack.length - 1] = { name, params };
    else stack.push({ name, params });
    renderCurrent();
  },
  back() {
    if (stack.length > 1) {
      stack.pop();
      renderCurrent();
    }
  },
  // Полный сброс стека на конкретный экран (например, после выбора группы).
  reset(name, params = {}) {
    stack = [{ name, params }];
    renderCurrent();
  },
  // Находимся ли на корневом экране (нужно sheet'ам для возврата BackButton).
  isRoot() {
    return stack.length <= 1;
  },
};

function renderCurrent() {
  const frame = stack[stack.length - 1];
  const render = ROUTES[frame.name];
  appEl.innerHTML = '';
  setBackVisible(stack.length > 1);
  render(appEl, frame.params, router);
}

// Нейтральный сплэш на время ожидания persistence (CloudStorage асинхронный) —
// чтобы вернувшегося пользователя не моргало через welcome перед расписанием.
function renderSplash() {
  appEl.innerHTML = '<div class="splash" role="status" aria-label="Загрузка"><div class="spinner"></div></div>';
}

// --- Старт ---
async function start() {
  initWebApp();
  renderSplash();

  await loadState();

  // Тема из единого источника (store) до первого рендера контента.
  applyTheme(resolveInitialTheme());

  // Системный BackButton: сперва закрыть открытый sheet, иначе навигация назад.
  onBackButton(() => { if (!screens.handleBack()) router.back(); });

  // Стартовый экран: валидная сохранённая группа — сразу расписание, иначе приветствие.
  const group = get.group();
  if (isValidGroup(group)) router.reset('schedule', { group });
  else router.reset('welcome');
}

start();
