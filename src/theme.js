// Управление темой. Единственный источник истины — store.theme
// (дефолт 'dark', либо сохранённое пользователем). И стартовая инициализация,
// и тумблер в настройках читают/пишут одно и то же значение — без расхождения
// CSS и состояния.

import { get } from './store.js?v=36';

// Применяет тему к документу (CSS-токены висят на [data-theme]).
export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}

// Стартовая тема = текущее значение store (дефолт 'dark' или сохранённое).
export function resolveInitialTheme() {
  return get.theme();
}
