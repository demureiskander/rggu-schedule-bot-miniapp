// Управление темой. Вынесено из main.js, чтобы настройки переключали тему
// без глобалов (window.*). Источник правды по выбранной теме — store.

import { colorScheme } from './telegram.js';
import { isPersisted, get } from './store.js';

// Применяет тему к документу (CSS-токены висят на [data-theme]).
export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}

// Стартовая тема: сохранённая пользователем > тема Telegram > 'dark'.
export function resolveInitialTheme() {
  if (isPersisted('theme')) return get.theme();
  return colorScheme() || 'dark';
}
