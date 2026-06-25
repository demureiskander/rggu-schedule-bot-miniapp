// Экраны приложения: welcome, picker (форма→курс→поиск), расписание + sheets.

import {
  fetchFlows, fetchSchedule, fetchTeacherSchedule, fetchTeachers,
  fetchWeather, tsToDateKey, dateKeyToTs,
} from './api.js?v=47';
import {
  formGroups, COURSES, MASCOT, GROUP_FORMS, formatFormCode, buildTree, splitDetails,
  MONTHS_GENITIVE, MONTHS_NOMINATIVE, WEEKDAYS_SHORT, WEEKDAYS_FULL,
  instituteAbbr, instituteName, instituteIcon,
} from './constants.js?v=47';
import { APP_VERSION, BOT_USERNAME } from '../config.js?v=47';
import {
  set, get, getFreshSchedule, setScheduleFor, setWeather, setAttendanceCell,
  dismissBanner,
} from './store.js?v=47';
import { trackEvent, fetchBanners } from './analytics.js?v=47';
import { applyTheme } from './theme.js?v=47';
import { haptic, hapticSelection, setBackVisible, openLink, openTelegramLink } from './telegram.js?v=47';
import {
  renderLesson, weekStrip, dayNav, weekNav, weekMonday, weekDayHeader,
  counterText, weatherBadge, weatherForDate, lessonDetail, lessonTypeInfo,
} from './render.js?v=47';

const LAYOUT_LABELS = {
  block: 'Блочный', compact: 'Компакт.', ribbon: 'Ленточный',
};
const DISPLAY_MODE_LABELS = { day: 'По дням', week: 'По неделям', feed: 'Лента' };

// --- DOM-хелперы ---
function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Блок «маскот + сообщение» — общий для welcome/пустого/загрузки/ошибки.
export function mascotBlock({ pose, title, subtitle = '', actions = [], spinner = false, compact = false }) {
  const wrap = h(`
    <div class="${compact ? 'mascot-block' : 'center-screen'}">
      <img class="mascot" src="${MASCOT[pose]}" alt="" />
      ${spinner ? '<div class="spinner" role="status" aria-label="Загрузка"></div>' : ''}
      <div class="stack" style="gap:8px;align-items:center">
        <h1>${esc(title)}</h1>
        ${subtitle ? `<p class="muted">${esc(subtitle)}</p>` : ''}
      </div>
      <div class="stack actions" style="width:100%;max-width:320px"></div>
    </div>
  `);
  const actionsEl = wrap.querySelector('.actions');
  for (const a of actions) {
    const cls = a.variant === 'ghost' ? 'btn--ghost' : a.variant === 'amber' ? 'btn--amber' : '';
    const btn = h(`<button class="btn btn--block ${cls}">${esc(a.label)}</button>`);
    btn.addEventListener('click', () => { haptic('light'); a.onClick(); });
    actionsEl.appendChild(btn);
  }
  return wrap;
}

// =========================================================
// Bottom sheet (общий паттерн) + перехват системного BackButton
// =========================================================
const escapeStack = [];

// main вызывает это первым на BackButton: true = событие поглощено (закрыли sheet).
export function handleBack() {
  const fn = escapeStack[escapeStack.length - 1];
  if (fn) { fn(); return true; }
  return false;
}

// Открывает bottom sheet с произвольным контентом. router нужен для возврата
// корректной видимости BackButton после закрытия. Возвращает close().
function openSheet(content, router) {
  const root = document.getElementById('sheet-root');
  const overlay = h('<div class="overlay"></div>');
  const sheet = h('<div class="sheet" role="dialog" aria-modal="true"></div>');
  sheet.appendChild(h('<div class="sheet__handle"></div>'));
  sheet.appendChild(content);
  overlay.appendChild(sheet);
  root.appendChild(overlay);

  // Анимация появления.
  requestAnimationFrame(() => overlay.classList.add('overlay--in'));

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    const idx = escapeStack.indexOf(close);
    if (idx >= 0) escapeStack.splice(idx, 1);
    overlay.classList.remove('overlay--in');
    setBackVisible(!router.isRoot() || escapeStack.length > 0);
    setTimeout(() => overlay.remove(), 200);
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) { haptic('light'); close(); } });

  // Свайп вниз по шиту — закрытие. Срабатывает только когда шит проскроллен
  // в самый верх (иначе свайп = обычный скролл контента).
  let startY = null;
  sheet.addEventListener('touchstart', (e) => {
    startY = sheet.scrollTop <= 0 ? e.touches[0].clientY : null;
  }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    if (startY == null) return;
    const dy = e.changedTouches[0].clientY - startY;
    startY = null;
    if (dy > 70) { haptic('light'); close(); }
  }, { passive: true });

  escapeStack.push(close);
  setBackVisible(true);
  return close;
}

// =========================================================
// 6.1 Приветствие
// =========================================================
export function renderWelcome(mount, _params, router) {
  mount.appendChild(mascotBlock({
    pose: 'wave',
    title: 'Привет!',
    subtitle: 'Теперь я есть прямо в приложении',
    actions: [
      { label: 'Выбрать группу', onClick: () => router.navigate('picker', { step: 'form' }) },
    ],
  }));
}

// =========================================================
// 6.2 Выбор группы: форма → курс → институт → направление → группа
// Каждый шаг — отдельный кадр стека (BackButton листает шаги назад).
// Список групп грузится один раз на форму+курс и кэшируется на сессию.
// =========================================================
const flowsCache = new Map(); // `${form}:${course}` -> flows[]

export function renderPicker(mount, params, router) {
  const step = params.step || 'form';
  if (step === 'form') return renderPickerForm(mount, params, router);
  if (step === 'course') return renderPickerCourse(mount, params, router);
  if (step === 'institute') return renderPickerInstitute(mount, params, router);
  if (step === 'direction') return renderPickerDirection(mount, params, router);
  return renderPickerGroup(mount, params, router);
}

// Шапка шага с видимой кнопкой «назад» (← в интерфейсе, помимо системного
// BackButton). Стрелку показываем, только если есть куда возвращаться.
function pickerHeader(title, subtitle, router) {
  const canBack = router && !router.isRoot();
  const head = h(`
    <header class="picker-head">
      <div class="picker-head__top">
        ${canBack ? '<button class="picker-back" aria-label="Назад">←</button>' : ''}
        <h2>${esc(title)}</h2>
      </div>
      ${subtitle ? `<p class="caption">${esc(subtitle)}</p>` : ''}
    </header>
  `);
  const back = head.querySelector('.picker-back');
  if (back) back.addEventListener('click', () => { haptic('light'); router.back(); });
  return head;
}

function renderPickerForm(mount, params, router) {
  const screen = h('<section class="picker stack"></section>');
  screen.appendChild(pickerHeader('Форма обучения', '', router));
  // Сгруппировано по уровню: Бакалавриат / Магистратура / Второе высшее.
  for (const group of formGroups()) {
    screen.appendChild(h(`<div class="picker-group-title">${esc(group.title)}</div>`));
    const list = h('<div class="option-list"></div>');
    for (const f of group.items) {
      const item = h(`
        <button class="option-row">
          <span class="option-row__label">${esc(f.label)}</span>
        </button>
      `);
      item.addEventListener('click', () => {
        hapticSelection();
        router.navigate('picker', { step: 'course', form: f.id });
      });
      list.appendChild(item);
    }
    screen.appendChild(list);
  }
  mount.appendChild(screen);
}

function renderPickerCourse(mount, params, router) {
  const screen = h('<section class="picker stack"></section>');
  const formLabel = formatFormCode(GROUP_FORMS[params.form] || '');
  screen.appendChild(pickerHeader('Курс', formLabel, router));
  const grid = h('<div class="course-grid"></div>');
  for (const c of COURSES) {
    const item = h(`<button class="course-chip">${c} курс</button>`);
    item.addEventListener('click', () => {
      hapticSelection();
      router.navigate('picker', { step: 'institute', form: params.form, course: c });
    });
    grid.appendChild(item);
  }
  screen.appendChild(grid);
  mount.appendChild(screen);
}

// Сохраняет выбранную группу и переходит на расписание.
async function commitGroup(params, flow, router) {
  haptic('light');
  const prev = get.group();
  const group = {
    form: params.form, year: params.course,
    id: flow.id, name: flow.name, details: flow.details,
  };
  await set('group', group);
  trackEvent('group_change', {
    from: prev?.id || null,
    to: group.id,
    name: group.name,
  });
  router.reset('schedule', { group });
}

// Загружает группы (с кэшем) и зовёт onReady(flows) / показывает загрузку/ошибку/пусто.
function withFlows(body, params, router, onReady) {
  const key = `${params.form}:${params.course}`;
  const run = async () => {
    body.innerHTML = '';
    body.appendChild(mascotBlock({ pose: 'think', title: 'Загружаю…', spinner: true }));
    try {
      let flows = flowsCache.get(key);
      if (!flows) {
        flows = await fetchFlows(params.form, params.course);
        flowsCache.set(key, flows);
      }
      if (!flows.length) {
        body.innerHTML = '';
        body.appendChild(mascotBlock({
          pose: 'sleep',
          title: 'Тут пусто',
          subtitle: 'Для этой формы и курса групп не нашлось. Попробуй другой курс.',
          actions: [{ label: 'Назад к курсу', variant: 'ghost', onClick: () => router.back() }],
        }));
        return;
      }
      body.innerHTML = '';
      onReady(flows);
    } catch (_) {
      body.innerHTML = '';
      body.appendChild(mascotBlock({
        pose: 'sad',
        title: 'Не получилось загрузить',
        subtitle: 'Похоже, пропала связь. Давай попробуем ещё раз.',
        actions: [{ label: 'Попробовать снова', onClick: run }],
      }));
    }
  };
  run();
}

// Шаг 3 — институт.
function renderPickerInstitute(mount, params, router) {
  const screen = h('<section class="picker stack"></section>');
  const formLabel = formatFormCode(GROUP_FORMS[params.form] || '');
  screen.appendChild(pickerHeader('Институт', `${formLabel} · ${params.course} курс`, router));
  const body = h('<div class="picker-body"></div>');
  screen.appendChild(body);
  mount.appendChild(screen);

  withFlows(body, params, router, (flows) => {
    // Поиск по всем группам формы+курса (минуя дерево). Пусто — показываем дерево.
    const search = h(`<input class="search-input" type="search" inputmode="search"
      placeholder="Знаешь группу? Найди по названию" aria-label="Поиск группы" />`);
    const list = h('<div class="option-list"></div>');
    body.appendChild(search);
    body.appendChild(list);

    const drawTree = () => {
      list.innerHTML = '';
      for (const inst of buildTree(flows)) {
        const count = [...inst.dirs.values()].reduce((s, a) => s + a.length, 0);
        // Расшифрованным дописываем аббревиатуру в скобках; фолбэк — без дубля.
        const title = inst.resolved ? `${inst.icon} ${[...inst.abbrs].join('/')} — ${inst.name}` : `${inst.icon} ${inst.name}`;
        const item = h(`
          <button class="option-row">
            <span class="option-row__label">${esc(title)}</span>
            <span class="option-row__sub">${inst.dirs.size} напр. · ${count} групп</span>
          </button>
        `);
        item.addEventListener('click', () => {
          hapticSelection();
          router.navigate('picker', { ...params, step: 'direction', inst: inst.name });
        });
        list.appendChild(item);
      }
    };

    const drawSearch = (needle) => {
      list.innerHTML = '';
      const shown = flows.filter((f) =>
        f.name.toLowerCase().includes(needle) ||
        f.details.toLowerCase().includes(needle));
      if (!shown.length) {
        list.appendChild(h('<p class="muted" style="padding:16px 4px">Ничего не нашлось — попробуй иначе или выбери деревом.</p>'));
        return;
      }
      for (const f of shown) {
        const item = h(`
          <button class="option-row">
            <span class="option-row__label">${esc(f.name)}</span>
            ${f.details ? `<span class="option-row__sub">${esc(f.details)}</span>` : ''}
          </button>
        `);
        item.addEventListener('click', () => commitGroup(params, f, router));
        list.appendChild(item);
      }
    };

    search.addEventListener('input', () => {
      const needle = search.value.trim().toLowerCase();
      if (needle) drawSearch(needle); else drawTree();
    });
    drawTree();
  });
}

// Шаг 4 — направление.
function renderPickerDirection(mount, params, router) {
  const screen = h('<section class="picker stack"></section>');
  screen.appendChild(pickerHeader('Направление', params.inst, router));
  const body = h('<div class="picker-body"></div>');
  screen.appendChild(body);
  mount.appendChild(screen);

  withFlows(body, params, router, (flows) => {
    const inst = buildTree(flows).find((i) => i.name === params.inst);
    const dirs = inst ? [...inst.dirs.keys()].sort((a, b) => a.localeCompare(b, 'ru')) : [];
    const list = h('<div class="option-list"></div>');
    for (const dir of dirs) {
      const n = inst.dirs.get(dir).length;
      const item = h(`
        <button class="option-row">
          <span class="option-row__label">${esc(dir)}</span>
          <span class="option-row__sub">${n} ${n === 1 ? 'группа' : 'групп'}</span>
        </button>
      `);
      item.addEventListener('click', () => {
        hapticSelection();
        router.navigate('picker', { ...params, step: 'group', dir });
      });
      list.appendChild(item);
    }
    body.appendChild(list);
  });
}

// Шаг 5 — группа (профиль показываем подписью).
function renderPickerGroup(mount, params, router) {
  const screen = h('<section class="picker stack"></section>');
  screen.appendChild(pickerHeader('Группа', params.dir, router));
  const body = h('<div class="picker-body"></div>');
  screen.appendChild(body);
  mount.appendChild(screen);

  withFlows(body, params, router, (flows) => {
    const inst = buildTree(flows).find((i) => i.name === params.inst);
    const groups = (inst && inst.dirs.get(params.dir)) || [];
    const list = h('<div class="option-list"></div>');
    for (const f of groups) {
      const { profile } = splitDetails(f.details);
      const item = h(`
        <button class="option-row">
          <span class="option-row__label">${esc(f.name)}</span>
          ${profile ? `<span class="option-row__sub">${esc(profile)}</span>` : ''}
        </button>
      `);
      item.addEventListener('click', () => commitGroup(params, f, router));
      list.appendChild(item);
    }
    body.appendChild(list);
  });
}

// =========================================================
// 6.3 Расписание: общая шапка + 3 вида + состояния + sheets
// =========================================================
export function renderSchedule(mount, params, router) {
  // Два режима: своя группа (params.group) и просмотр преподавателя (params.teacher).
  // Преподавательский режим временный — не персистится, отдельный экран
  // (push в стек), возврат через BackButton, FAB (✕) или кнопку в баннере.
  const teacher = params.teacher || null;
  const isTeacher = Boolean(teacher);
  const group = isTeacher ? null : params.group;
  const screen = h('<section class="schedule"></section>');
  mount.appendChild(screen);
  // FAB (лупа/закрыть) — вне screen, чтобы перерисовка draw() его не убивала.
  // Стартует скрытой; показываем только когда расписание реально нарисовано.
  const fab = createFab();
  fab.el.classList.add('fab--gone');
  mount.appendChild(fab.el);

  let schedule = null;
  let selected = null; // Date
  // Список активных баннеров для интеграции в поток расписания. Загружается
  // один раз на сессию после render(). До этого — пустой массив, баннеры
  // просто не показываются.
  let activeBanners = [];
  // Только для своей группы — в teacher-режиме баннеры не нужны.
  if (!isTeacher) {
    fetchBanners(get.dismissedBanners()).then((b) => {
      if (!b || !b.length) return;
      activeBanners = b;
      if (schedule) draw();
    });
  }
  // Направление мягкой анимации тела при следующем draw():
  //   'forward'  — приехать справа (день/неделя вперёд)
  //   'backward' — приехать слева (день/неделя назад)
  //   'fade'     — плавное появление без направления (для «Сегодня»)
  //   null       — без анимации (первая отрисовка, обновление по weather и т.п.)
  // ВАЖНО: объявлено ДО load(), потому что load() → draw() → applyEnterAnimation
  // обращается к nextDirection; если объявить ниже, на первый sync-вызов попадаем
  // в TDZ и весь catch ловит ReferenceError вместо реальной ошибки.
  let nextDirection = null;
  // Флаг: при следующем draw() в weekly/feed-режиме проскроллить к выбранному дню.
  // Ставится в selectDate (тап по дате/ячейке в strip); сбрасывается после скролла.
  let nextScrollToSelected = false;
  // В режиме «Лента» один раз за жизнь экрана автоскроллим к сегодняшнему дню
  // (после первой отрисовки). Дальше пользователь сам управляет скроллом.
  let feedAutoscrolled = false;

  load();

  async function load() {
    screen.innerHTML = '';
    fab.el.classList.add('fab--gone');
    screen.appendChild(mascotBlock({ pose: 'think', title: 'Загружаю расписание…', spinner: true }));
    try {
      let data;
      if (isTeacher) {
        data = await fetchTeacherSchedule(teacher.id);
      } else {
        data = getFreshSchedule(group.id);
        if (!isValidSchedule(data)) {
          data = await fetchSchedule(group.id, group.form, group.year);
          setScheduleFor(group.id, data);
        }
      }
      schedule = data;
      selected = pickInitialDate(data);
      ensureWeather();
      draw();
    } catch (e) {
      console.error('[schedule load failed]', e);
      renderError();
    }
  }

  // Считаем кэш валидным только если в нём есть и массив dates, и карта byDate.
  // Защита от ситуации, когда в state.schedule осталось что-то «полупустое»
  // (битый/устаревший формат) — иначе draw() упадёт на schedule.byDate/dates.
  function isValidSchedule(d) {
    return Boolean(d && Array.isArray(d.dates) && d.byDate && typeof d.byDate === 'object');
  }

  function renderError() {
    screen.innerHTML = '';
    fab.el.classList.add('fab--gone');
    const actions = isTeacher
      ? [
          { label: 'Попробовать снова', onClick: load },
          { label: 'Вернуться к моему расписанию', variant: 'ghost', onClick: () => router.back() },
        ]
      : [
          { label: 'Попробовать снова', onClick: load },
          { label: 'Выбрать другую группу', variant: 'ghost', onClick: () => router.reset('picker', { step: 'form' }) },
        ];
    screen.appendChild(mascotBlock({
      pose: 'sad',
      title: 'Что-то пошло не так',
      subtitle: 'Не удалось загрузить расписание. Проверь подключение к интернету.',
      actions,
    }));
  }

  // Стартовый день: сегодня (если есть в данных) → ближайший будущий → первый.
  function pickInitialDate(data) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayKey = tsToDateKey(today);
    if (data.byDate[todayKey]) return today;
    const future = data.dates.find((k) => dateKeyToTs(k) >= today.getTime());
    const key = future || data.dates[data.dates.length - 1];
    return key ? new Date(dateKeyToTs(key)) : today;
  }

  // Границы загруженного диапазона — чтобы не листать в бесконечную пустоту.
  function rangeBounds() {
    const ds = schedule.dates;
    return {
      min: ds.length ? dateKeyToTs(ds[0]) : -Infinity,
      max: ds.length ? dateKeyToTs(ds[ds.length - 1]) : Infinity,
    };
  }

  function changeDay(delta) {
    const next = new Date(selected);
    next.setDate(next.getDate() + delta);
    const { min, max } = rangeBounds();
    if (next.getTime() < min || next.getTime() > max) return;
    haptic('light');
    nextDirection = delta > 0 ? 'forward' : 'backward';
    selected = next;
    draw();
  }

  // Перелистывание недели (в режиме «по неделям»): сдвиг ±7 дней с прижатием к границам.
  function changeWeek(delta) {
    const next = new Date(selected);
    next.setDate(next.getDate() + delta * 7);
    const { min, max } = rangeBounds();
    if (next.getTime() < min) next.setTime(min);
    if (next.getTime() > max) next.setTime(max);
    if (next.toDateString() === selected.toDateString()) return;
    haptic('light');
    nextDirection = delta > 0 ? 'forward' : 'backward';
    selected = next;
    draw();
  }

  function selectDate(date) {
    hapticSelection();
    // В weekly/feed мы скроллим к выбранному дню — slide-анимация контента
    // здесь не нужна (и мешает scrollIntoView правильно посчитать геометрию).
    // В дневном режиме оставляем направление: вперёд/назад.
    const mode = get.displayMode();
    if (mode === 'day') {
      const cmp = date.getTime() - selected.getTime();
      nextDirection = cmp > 0 ? 'forward' : cmp < 0 ? 'backward' : null;
    } else {
      nextDirection = null;
    }
    selected = date;
    nextScrollToSelected = true;
    draw();
  }

  // Прыжок на сегодняшний день (в пределах загруженного диапазона).
  // В режиме «Лента» — плавный скролл к блоку сегодня, без перерисовки.
  function goToday() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const { min, max } = rangeBounds();
    if (today.getTime() < min || today.getTime() > max) return;
    haptic('light');
    if (get.displayMode() === 'feed') {
      const todayKey = tsToDateKey(today);
      const block = document.querySelector(`.feed-day[data-date-key="${todayKey}"]`);
      if (block) {
        block.scrollIntoView({ behavior: 'smooth', block: 'start' });
        selected = today;
        return;
      }
    }
    nextDirection = 'fade';
    selected = today;
    draw();
  }

  // Помечает sched-body классом анимации входа (или ничего, если nextDirection
  // не выставлен — например, первая отрисовка или обновление по погоде).
  function applyEnterAnimation(bodyEl) {
    if (!nextDirection) return;
    bodyEl.classList.add(`sched-body--in-${nextDirection}`);
    nextDirection = null;
  }

  function draw() {
    screen.innerHTML = '';
    // Расписание готово — открываем FAB (если был скрыт скроллом — тоже сбрасываем).
    fab.el.classList.remove('fab--gone', 'fab--hidden');

    // Пустое расписание (часто у преподов, которые сейчас не ведут): не строим
    // ленту дней (был бы Invalid Date на ±Infinity границах) — рисуем баннер
    // teacher-режима + дружелюбный mascot. Внутри teacher тут же даём «Вернуться».
    if (!schedule.dates.length) {
      if (isTeacher) {
        const banner = h(`
          <div class="teacher-banner">
            <div class="teacher-banner__text">
              <div class="teacher-banner__label">Расписание преподавателя</div>
              <div class="teacher-banner__name">${esc(schedule.item || teacher.name)}</div>
            </div>
            <button class="teacher-banner__back link-amber" type="button">Вернуться</button>
          </div>
        `);
        banner.querySelector('button').addEventListener('click', () => { haptic('light'); router.back(); });
        screen.appendChild(banner);
      }
      screen.appendChild(mascotBlock({
        pose: 'sleep',
        title: isTeacher ? 'Сейчас занятий нет' : 'В семестре пар нет',
        subtitle: isTeacher ? 'У преподавателя пусто в расписании.' : 'Похоже, у группы пока ничего не загружено.',
      }));
      return;
    }

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const isToday = selected.toDateString() === today.toDateString();
    const { min, max } = rangeBounds();
    const todayInRange = today.getTime() >= min && today.getTime() <= max;
    const layout = get.layout();
    const displayMode = get.displayMode();
    const isWeek = displayMode === 'week';
    const isFeed = displayMode === 'feed';

    // Класс на самой секции — режим feed включает sticky-шапку (CSS).
    screen.classList.toggle('schedule--feed', isFeed);

    // Баннер режима преподавателя — отличает от своего расписания.
    if (isTeacher) {
      const banner = h(`
        <div class="teacher-banner">
          <div class="teacher-banner__text">
            <div class="teacher-banner__label">Расписание преподавателя</div>
            <div class="teacher-banner__name">${esc(schedule.item || teacher.name)}</div>
          </div>
          <button class="teacher-banner__back link-amber" type="button">Вернуться</button>
        </div>
      `);
      banner.querySelector('button').addEventListener('click', () => { haptic('light'); router.back(); });
      screen.appendChild(banner);
    }

    // Шапка: погода (если включена и день в пределах 16-дневного прогноза)
    // слева — только в режиме «по дням». В недельном виде / ленте погода
    // уезжает в заголовки каждого дня.
    const top = h('<div class="sched-top"></div>');
    const showHeaderWeather = !isWeek && !isFeed && get.weatherEnabled();
    const headerWeather = showHeaderWeather
      ? weatherBadge(weatherForDate(get.weather(), selected)) : null;
    top.appendChild(headerWeather || h('<span></span>'));
    const right = h('<div class="sched-top__right"></div>');
    // В режимах day/week «Сегодня» показываем только когда смотрим не на
    // сегодня. В feed-режиме selected не меняется при скролле (это просто
    // якорь автоскролла), поэтому isToday остаётся true — кнопка должна
    // быть видна всегда, пока сегодня в диапазоне.
    const showTodayBtn = todayInRange && (isFeed || !isToday);
    if (showTodayBtn) {
      const todayBtn = h('<button class="today-btn">Сегодня</button>');
      todayBtn.addEventListener('click', goToday);
      right.appendChild(todayBtn);
    }
    // Профиль — только в режиме своей группы (в teacher-режиме своего профиля
    // нет). Слева от шестерёнки настроек.
    if (!isTeacher && group) {
      const profileBtn = h('<button class="icon-btn" aria-label="Профиль">👤</button>');
      profileBtn.addEventListener('click', () => {
        haptic('light');
        router.navigate('profile', { group });
      });
      right.appendChild(profileBtn);
    }
    const gear = h('<button class="icon-btn" aria-label="Настройки">⚙</button>');
    gear.addEventListener('click', () => openSettings());
    right.appendChild(gear);
    top.appendChild(right);
    screen.appendChild(top);

    // Режим «Лента» — без полоски дней и навигации: сплошной скролл по всему
    // семестру. Скроллбар-ползунок справа + sticky-заголовки месяцев.
    if (isFeed) {
      drawFeed(layout);
      return;
    }

    // Полоска дней — горизонтальный скролл по всему загруженному диапазону.
    // Дни генерируем сплошным интервалом от min до max (включая дни без пар
    // и «сегодня» даже если без пар); пустые дни приглушены, сегодня — жёлтый;
    // выбранный день центрируется (плавно при навигации, мгновенно при первой
    // отрисовке). Если «сегодня» лежит между min..max, оно гарантированно
    // оказывается в ленте — иначе кнопка «Сегодня» не имела бы куда прыгнуть.
    const hasLessons = (d) => (schedule.byDate[tsToDateKey(d)] || []).length > 0;
    const monday = weekMonday(selected);
    const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6);
    const inCurrentWeek = (d) => d.getTime() >= monday.getTime() && d.getTime() <= sunday.getTime();

    // В недельном режиме лента = ровно 7 дней текущей недели (без горизонтального
    // скролла по семестру — иначе на разной ширине слева/справа просвечивают
    // соседние недели, и тестеры видят «8 дней»). В дневном — весь диапазон.
    const days = [];
    if (isWeek) {
      for (let i = 0; i < 7; i++) {
        const d = new Date(monday); d.setDate(monday.getDate() + i);
        days.push(d);
      }
    } else {
      for (let t = min; t <= max; ) {
        const d = new Date(t);
        days.push(d);
        const next = new Date(d);
        next.setDate(next.getDate() + 1);
        t = next.getTime();
      }
    }
    screen.appendChild(weekStrip(days, selected, selectDate, {
      hasLessons, dimEmpty: get.highlightEmptyDays(),
      inRange: isWeek ? inCurrentWeek : null,
      weekly: isWeek,
    }));

    if (isWeek) {
      drawWeeklyBody(monday, layout);
      return;
    }

    screen.appendChild(dayNav(selected, () => changeDay(-1), () => changeDay(1)));

    const lessons = schedule.byDate[tsToDateKey(selected)] || [];

    const counter = h(`<div class="counter">${esc(counterText(lessons, isToday))}</div>`);
    screen.appendChild(counter);
    startTicker(counter, lessons, isToday);

    // Тело: список пар или пустой день.
    const body = h('<div class="sched-body"></div>');
    applyEnterAnimation(body);
    screen.appendChild(body);
    attachSwipe(body);

    if (!lessons.length) {
      body.appendChild(mascotBlock({ pose: 'sleep', title: 'На сегодня пар нет', compact: true }));
      return;
    }

    const list = h(`<div class="lessons lessons--${layout}"></div>`);
    for (const lesson of lessons) {
      const el = renderLesson(lesson, layout, isTeacher ? 'teacher' : 'group');
      const card = el.matches('button') ? el : el.querySelector('button') || el;
      card.addEventListener('click', () => openDetail(lesson));
      list.appendChild(el);
    }
    body.appendChild(list);
    // Один баннер после последней карточки дня (если есть активные).
    if (activeBanners.length) body.appendChild(buildBannerCard(activeBanners[0]));
  }

  // Недельный режим отображения: 7 дней друг под другом, шапки + список пар
  // (renderLesson с выбранным layout). Свайп/стрелки в weekNav листают неделю.
  function drawWeeklyBody(monday, layout) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    screen.appendChild(weekNav(monday, () => changeWeek(-1), () => changeWeek(1)));

    // Сумма пар за неделю (помещаем в общий .counter, чтоб не плодить классы).
    let weekTotal = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday); d.setDate(monday.getDate() + i);
      weekTotal += (schedule.byDate[tsToDateKey(d)] || []).length;
    }
    const pairWord = (n) => n === 1 ? 'пара' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'пары' : 'пар');
    screen.appendChild(h(`<div class="counter">${weekTotal ? `${weekTotal} ${pairWord(weekTotal)} на неделе` : 'на неделе пар нет'}</div>`));

    const body = h('<div class="sched-body"></div>');
    applyEnterAnimation(body);
    screen.appendChild(body);
    attachWeekSwipe(body);

    const forecast = get.weatherEnabled() ? get.weather() : null;
    const wrap = h('<div class="week-days"></div>');
    let selectedBlock = null;
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday); d.setDate(monday.getDate() + i);
      const isTodayDay = d.toDateString() === today.toDateString();
      const isSelectedDay = d.toDateString() === selected.toDateString();
      const dayLessons = schedule.byDate[tsToDateKey(d)] || [];
      const dayBlock = h('<div class="week-day"></div>');
      const dayWeather = forecast ? weatherForDate(forecast, d) : null;
      dayBlock.appendChild(weekDayHeader(d, isTodayDay, dayWeather));
      if (!dayLessons.length) {
        dayBlock.appendChild(h('<div class="week-day__empty">Ничего</div>'));
      } else {
        const list = h(`<div class="lessons lessons--${layout}"></div>`);
        for (const lesson of dayLessons) {
          const el = renderLesson(lesson, layout, isTeacher ? 'teacher' : 'group');
          const card = el.matches('button') ? el : el.querySelector('button') || el;
          card.addEventListener('click', () => openDetail(lesson));
          list.appendChild(el);
        }
        dayBlock.appendChild(list);
      }
      if (isSelectedDay) selectedBlock = dayBlock;
      wrap.appendChild(dayBlock);
    }
    body.appendChild(wrap);
    // Один баннер после последнего дня недели.
    if (activeBanners.length) body.appendChild(buildBannerCard(activeBanners[0]));

    // Тап по дате в полоске → скроллим к блоку выбранного дня. Откладываем на
    // следующий кадр, чтобы DOM успел смонтироваться (block:start учитывает
    // фиксированный header через scroll-margin-top в CSS).
    if (selectedBlock && nextScrollToSelected) {
      nextScrollToSelected = false;
      requestAnimationFrame(() => {
        selectedBlock.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  // Инлайн-карточка баннера. type=donate/link/info определяет действие
  // по кнопке; крестик опционально (banner.dismissable).
  function buildBannerCard(banner) {
    const colorBar = banner.color || '#F59E0B';
    const card = h(`
      <div class="banner" style="--banner-color:${esc(colorBar)}">
        <div class="banner__top">
          <span class="banner__from muted">от разработчика</span>
          ${banner.dismissable ? '<button class="banner__close" aria-label="Закрыть">✕</button>' : ''}
        </div>
        <div class="banner__title">${esc(banner.title || '')}</div>
        ${banner.body ? `<div class="banner__body">${esc(banner.body)}</div>` : ''}
        ${banner.btn_text ? `<button class="banner__btn">${esc(banner.btn_text)}</button>` : ''}
      </div>
    `);
    const btn = card.querySelector('.banner__btn');
    if (btn) {
      btn.addEventListener('click', () => {
        haptic('light');
        trackEvent('banner_click', { banner_id: banner.id, type: banner.type });
        if (banner.type === 'donate') {
          openTelegramLink('https://t.me/RsuhSpaceBot?start=coffee');
        } else if (banner.type === 'link' && banner.btn_url) {
          openLink(banner.btn_url);
        }
      });
    }
    const close = card.querySelector('.banner__close');
    if (close) {
      close.addEventListener('click', async () => {
        haptic('light');
        trackEvent('banner_dismiss', { banner_id: banner.id });
        await dismissBanner(banner.id);
        activeBanners = activeBanners.filter((b) => b.id !== banner.id);
        card.remove();
      });
    }
    return card;
  }

  // Состояние для ротации баннеров в feed-режиме.
  // bannerCounter — сколько карточек пар прошло с последнего показа.
  // bannerIdx — следующий индекс в activeBanners (циклически).
  const feedBannerState = { counter: 0, idx: 0 };

  // --- Режим «Лента»: сплошной скролл по всему семестру ---
  function drawFeed(layout) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayKey = tsToDateKey(today);
    const forecast = get.weatherEnabled() ? get.weather() : null;

    // В feed-режиме нет strip/dayNav/счётчика — только тело с лентой и
    // вертикальный ползунок справа.
    const body = h('<div class="sched-body sched-body--feed"></div>');
    applyEnterAnimation(body);
    screen.appendChild(body);

    const feed = h('<div class="feed"></div>');
    let curMonthKey = null;
    let curMonthDays = null;
    // Сбрасываем состояние ротации на каждую отрисовку (draw пересоздаёт DOM).
    feedBannerState.counter = 0;
    for (const dateKey of schedule.dates) {
      const d = new Date(dateKeyToTs(dateKey));
      const monthKey = `${d.getFullYear()}-${d.getMonth()}`;
      if (monthKey !== curMonthKey) {
        curMonthKey = monthKey;
        const monthBlock = h(`
          <section class="feed-month">
            <header class="feed-month__head">${esc(MONTHS_NOMINATIVE[d.getMonth()])} ${d.getFullYear()}</header>
            <div class="feed-month__days"></div>
          </section>
        `);
        curMonthDays = monthBlock.querySelector('.feed-month__days');
        feed.appendChild(monthBlock);
      }
      curMonthDays.appendChild(buildFeedDay(d, dateKey, todayKey, forecast, layout));
      // Учёт частоты баннеров: набираем счётчик карточек по дню, и если
      // перевалили за frequency следующего баннера — вставляем баннер.
      const dayLessons = schedule.byDate[dateKey] || [];
      feedBannerState.counter += dayLessons.length;
      if (activeBanners.length) {
        const banner = activeBanners[feedBannerState.idx % activeBanners.length];
        if (feedBannerState.counter >= (banner.frequency || 5)) {
          curMonthDays.appendChild(buildBannerCard(banner));
          feedBannerState.counter = 0;
          feedBannerState.idx++;
        }
      }
    }
    body.appendChild(feed);

    // Вертикальный ползунок-индикатор — справа, поверх контента.
    body.appendChild(createFeedScrubber(feed));

    // Автоскролл к сегодняшнему дню (или к ближайшему доступному). Если
    // сегодня вне диапазона — оставляем скролл там, где он был (как обычно
    // делает прыжок-к-выбранному после selectDate).
    if (!feedAutoscrolled) {
      feedAutoscrolled = true;
      requestAnimationFrame(() => {
        const target = feed.querySelector(`.feed-day[data-date-key="${todayKey}"]`)
          || feed.querySelector('.feed-day');
        if (target) target.scrollIntoView({ block: 'start', behavior: 'auto' });
      });
    } else if (nextScrollToSelected) {
      nextScrollToSelected = false;
      const key = tsToDateKey(selected);
      requestAnimationFrame(() => {
        const target = feed.querySelector(`.feed-day[data-date-key="${key}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  // Один день в ленте — заголовок (+ погода) и список пар. Пустой день —
  // только компактный заголовок с лёгким приглушением.
  function buildFeedDay(date, dateKey, todayKey, forecast, layout) {
    const lessons = schedule.byDate[dateKey] || [];
    const isTodayDay = dateKey === todayKey;
    const empty = lessons.length === 0;
    const cls = `feed-day${isTodayDay ? ' feed-day--today' : ''}${empty && get.highlightEmptyDays() ? ' feed-day--empty' : ''}`;
    const block = h(`<div class="${cls}" data-date-key="${esc(dateKey)}"></div>`);
    const title = `${WEEKDAYS_SHORT[date.getDay()]}, ${date.getDate()} ${MONTHS_GENITIVE[date.getMonth()]}`;
    const head = h(`<div class="feed-day__head"><span class="feed-day__title">${esc(title)}</span></div>`);
    if (forecast) {
      const w = weatherForDate(forecast, date);
      if (w) {
        const wb = weatherBadge(w);
        if (wb) head.appendChild(wb);
      }
    }
    block.appendChild(head);
    if (!empty) {
      const list = h(`<div class="lessons lessons--${layout}"></div>`);
      for (const lesson of lessons) {
        const el = renderLesson(lesson, layout, isTeacher ? 'teacher' : 'group');
        const card = el.matches('button') ? el : el.querySelector('button') || el;
        card.addEventListener('click', () => openDetail(lesson));
        list.appendChild(el);
      }
      block.appendChild(list);
    }
    return block;
  }

  // Вертикальный ползунок справа: индикатор позиции в семестре + drag для
  // быстрой навигации. При перетаскивании рядом всплывает дата под пальцем.
  function createFeedScrubber(feed) {
    const scrubber = h(`
      <div class="feed-scrubber" aria-hidden="true">
        <div class="feed-scrubber__track"></div>
        <div class="feed-scrubber__thumb"></div>
        <div class="feed-scrubber__tip"></div>
      </div>
    `);
    const track = scrubber.querySelector('.feed-scrubber__track');
    const thumb = scrubber.querySelector('.feed-scrubber__thumb');
    const tip = scrubber.querySelector('.feed-scrubber__tip');

    let dragging = false;

    function pageScrollRange() {
      const root = document.scrollingElement || document.documentElement;
      return Math.max(0, root.scrollHeight - window.innerHeight);
    }
    function pageScrollY() {
      return window.scrollY || (document.scrollingElement || document.documentElement).scrollTop;
    }
    function setPageScroll(y, smooth = false) {
      window.scrollTo({ top: y, behavior: smooth ? 'smooth' : 'auto' });
    }

    function updateFromScroll() {
      if (!scrubber.isConnected) return;
      const docH = pageScrollRange();
      const pct = docH > 0 ? Math.max(0, Math.min(1, pageScrollY() / docH)) : 0;
      const trackH = Math.max(0, track.clientHeight - thumb.clientHeight);
      thumb.style.transform = `translateY(${pct * trackH}px)`;
    }

    // Ищет день, ближайший к верху viewport — отдаёт его dateKey для тултипа.
    function dateAtViewportTop() {
      const cells = feed.querySelectorAll('.feed-day[data-date-key]');
      let best = null, bestDist = Infinity;
      for (const el of cells) {
        const r = el.getBoundingClientRect();
        const dist = Math.abs(r.top);
        if (dist < bestDist) { best = el; bestDist = dist; }
      }
      return best ? best.getAttribute('data-date-key') : null;
    }
    function showTip(visible) {
      tip.classList.toggle('feed-scrubber__tip--on', visible);
    }
    function refreshTip() {
      const key = dateAtViewportTop();
      if (!key) return;
      const [d, m] = key.split('.').map(Number);
      tip.textContent = `${d} ${MONTHS_GENITIVE[m - 1]}`;
      const thumbRect = thumb.getBoundingClientRect();
      const scrubRect = scrubber.getBoundingClientRect();
      tip.style.top = `${thumbRect.top - scrubRect.top + thumbRect.height / 2}px`;
    }

    function onDown(e) {
      dragging = true;
      try { thumb.setPointerCapture(e.pointerId); } catch (_) {}
      scrubber.classList.add('feed-scrubber--drag');
      showTip(true);
      onMove(e);
    }
    function onMove(e) {
      if (!dragging) return;
      e.preventDefault();
      const r = track.getBoundingClientRect();
      const y = Math.max(0, Math.min(r.height, e.clientY - r.top));
      const pct = r.height > 0 ? y / r.height : 0;
      setPageScroll(pct * pageScrollRange());
      updateFromScroll();
      refreshTip();
    }
    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      try { thumb.releasePointerCapture(e.pointerId); } catch (_) {}
      scrubber.classList.remove('feed-scrubber--drag');
      // Прячем тултип чуть позже, чтобы пользователь успел увидеть финальную дату.
      setTimeout(() => showTip(false), 400);
    }

    // Слушатели на самом ползунке — у контейнера pointer-events:none, иначе
    // скролл пальцем у правого края экрана случайно ловил бы drag.
    thumb.addEventListener('pointerdown', onDown);
    thumb.addEventListener('pointermove', onMove);
    thumb.addEventListener('pointerup', onUp);
    thumb.addEventListener('pointercancel', onUp);

    const onScroll = () => updateFromScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    // Отписка не нужна — скруббер живёт ровно пока feed-body в DOM, при draw()
    // оба пересоздаются (старый обработчик быстро no-op'ит через isConnected).

    requestAnimationFrame(updateFromScroll);
    return scrubber;
  }

  // Свайп листает неделю (в недельном виде).
  function attachWeekSwipe(el) {
    let x0 = null, y0 = null;
    el.addEventListener('touchstart', (e) => {
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0;
      const dy = e.changedTouches[0].clientY - y0;
      x0 = y0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) changeWeek(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  // Счётчик «осталось пар» тикает раз в минуту, только пока виден и это сегодня.
  function startTicker(counterEl, lessons, isToday) {
    if (!isToday || !lessons.length) return;
    const id = setInterval(() => {
      if (!counterEl.isConnected) { clearInterval(id); return; }
      counterEl.textContent = counterText(lessons, true);
    }, 60000);
  }

  // Горизонтальный свайп листает дни (не конфликтует со стек-роутером).
  function attachSwipe(el) {
    let x0 = null, y0 = null;
    el.addEventListener('touchstart', (e) => {
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0;
      const dy = e.changedTouches[0].clientY - y0;
      x0 = y0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) changeDay(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  // Погода: один раз за сессию, только если включена.
  async function ensureWeather() {
    if (!get.weatherEnabled() || get.weather()) return;
    const w = await fetchWeather();
    if (w) { setWeather(w); if (schedule) draw(); }
  }

  // Сводка по предмету (из загруженного расписания = весь семестр):
  //  remaining/breakdown — от сегодняшней даты;
  //  next — ближайшая пара ПОСЛЕ просматриваемой (важно: не «после сегодня»,
  //    иначе при просмотре будущего экзамена «Следующая пара» оказывается
  //    в прошлом);
  //  isLast — просматриваемая не-экзамен пара последняя по предмету;
  //  viewedIsExam — просматриваемая пара = экзамен;
  //  lessonsBeforeExam — для экзамена: сколько занятий ещё впереди до него
  //    (от сегодня).
  function subjectStats(subject, viewed) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const atDateTime = (dateKey, start) => {
      const ts = dateKeyToTs(dateKey);
      const [hh, mm] = (start || '00:00').split(':').map(Number);
      return ts + (hh * 60 + mm) * 60000;
    };
    const viewedKey = tsToDateKey(selected);
    const viewedTs = atDateTime(viewedKey, viewed.start);
    const viewedIsExam = (viewed.lessontype || '').toLowerCase() === 'экзамен';

    let remaining = 0, lectures = 0, seminars = 0, combo = 0, other = 0;
    let next = null, exam = null;
    for (const dateKey of schedule.dates) {
      const ts = dateKeyToTs(dateKey);
      for (const l of schedule.byDate[dateKey]) {
        if (l.subject !== subject) continue;
        const type = (l.lessontype || '').toLowerCase();
        if (type === 'экзамен') {
          if (!exam) exam = { dateKey, start: l.start, ts: atDateTime(dateKey, l.start) };
          continue;
        }
        const lessonTs = atDateTime(dateKey, l.start);
        if (ts >= today.getTime()) {
          remaining++;
          const isLec = type.includes('лек');
          const isSem = type.includes('сем');
          if (isLec && isSem) combo++;
          else if (isLec) lectures++;
          else if (isSem) seminars++;
          else other++;
        }
        if (lessonTs > viewedTs && (!next || lessonTs < next.ts)) {
          next = { dateKey, start: l.start, ts: lessonTs };
        }
      }
    }

    let lessonsBeforeExam = 0;
    if (viewedIsExam) {
      const examTs = viewedTs;
      for (const dateKey of schedule.dates) {
        const ts = dateKeyToTs(dateKey);
        if (ts < today.getTime()) continue;
        for (const l of schedule.byDate[dateKey]) {
          if (l.subject !== subject) continue;
          if ((l.lessontype || '').toLowerCase() === 'экзамен') continue;
          if (atDateTime(dateKey, l.start) < examTs) lessonsBeforeExam++;
        }
      }
    }

    const isLast = !viewedIsExam && !next;
    return {
      remaining, lectures, seminars, combo, other,
      next, exam, isLast, viewedIsExam, lessonsBeforeExam,
    };
  }

  // --- Sheet: детали пары (6.7) ---
  function openDetail(lesson) {
    haptic('light');
    openSheet(
      lessonDetail(lesson, subjectStats(lesson.subject, lesson), isTeacher ? 'teacher' : 'group'),
      router,
    );
  }

  // --- Sheet: настройки (6.6) ---
  function openSettings() {
    haptic('light');
    const content = h('<div class="settings"></div>');
    content.appendChild(h('<div class="sheet__title">Настройки</div>'));

    // Группа — только в режиме своей группы (в teacher-режиме её просто нет).
    if (!isTeacher && group) {
      content.appendChild(h('<div class="settings__label">Группа</div>'));
      const groupRow = h(`
        <div class="settings__group">
          <div><div class="settings__group-name">${esc(group.name)}</div>
          ${group.details ? `<div class="settings__group-sub">${esc(group.details)}</div>` : ''}</div>
          <button class="link-amber">Сменить</button>
        </div>
      `);
      groupRow.querySelector('.link-amber').addEventListener('click', () => {
        close(); router.reset('picker', { step: 'form' });
      });
      content.appendChild(groupRow);
    }

    // Вид расписания (как рендерится одна пара).
    content.appendChild(h('<div class="settings__label">Вид расписания</div>'));
    const seg = h('<div class="segmented"></div>');
    for (const key of ['block', 'compact', 'ribbon']) {
      const chip = h(`<button class="seg${get.layout() === key ? ' seg--on' : ''}">${LAYOUT_LABELS[key]}</button>`);
      chip.addEventListener('click', async () => {
        hapticSelection();
        await set('layout', key);
        seg.querySelectorAll('.seg').forEach((c) => c.classList.remove('seg--on'));
        chip.classList.add('seg--on');
        draw();
      });
      seg.appendChild(chip);
    }
    content.appendChild(seg);

    // Отображение (что в окне — один день или вся неделя).
    content.appendChild(h('<div class="settings__label">Отображение</div>'));
    const segDM = h('<div class="segmented"></div>');
    for (const key of ['day', 'week', 'feed']) {
      const chip = h(`<button class="seg${get.displayMode() === key ? ' seg--on' : ''}">${DISPLAY_MODE_LABELS[key]}</button>`);
      chip.addEventListener('click', async () => {
        hapticSelection();
        const prev = get.displayMode();
        await set('displayMode', key);
        if (prev !== key) trackEvent('mode_change', { mode: key, prev });
        segDM.querySelectorAll('.seg').forEach((c) => c.classList.remove('seg--on'));
        chip.classList.add('seg--on');
        draw();
      });
      segDM.appendChild(chip);
    }
    content.appendChild(segDM);

    // Оформление: тумблеры одной группой.
    content.appendChild(h('<div class="settings__label">Оформление</div>'));
    const appearance = h('<div class="toggle-list"></div>');
    appearance.appendChild(toggleRow('Затемнять дни без пар', get.highlightEmptyDays(), async (on) => {
      await set('highlightEmptyDays', on);
      draw();
    }));
    appearance.appendChild(toggleRow('Погода', get.weatherEnabled(), async (on) => {
      await set('weatherEnabled', on);
      if (on) await ensureWeather();
      draw();
    }));
    appearance.appendChild(toggleRow('Тёмная тема', get.theme() === 'dark', async (on) => {
      const theme = on ? 'dark' : 'light';
      await set('theme', theme);
      applyTheme(theme);
    }));
    content.appendChild(appearance);

    // ── Разделитель функционального и информационного блоков ──
    content.appendChild(h('<div class="settings__divider"></div>'));

    // Поддержать проект.
    content.appendChild(h('<div class="settings__label">Поддержать проект ☕</div>'));
    content.appendChild(h('<div class="settings__hint">Если приложение полезно — буду рад поддержке</div>'));
    const support = h('<div class="settings__list"></div>');
    // Deep link с параметром coffee: бот ловит /start coffee и сразу
    // открывает оплату Stars'ами. Mini App при этом закрывается — пользователь
    // оказывается в чате с ботом, и обработка идёт уже на стороне бота.
    support.appendChild(linkRow('⭐', 'Telegram Stars', '', () => {
      trackEvent('donate_click', { source: 'settings' });
      openTelegramLink('https://t.me/RsuhSpaceBot?start=coffee');
    }));
    support.appendChild(linkRow('💳', 'Cloudtips', 'рублями по СБП', () => openLink('https://pay.cloudtips.ru/p/b5c9b884')));
    content.appendChild(support);

    content.appendChild(h('<div class="settings__divider"></div>'));

    // О приложении.
    content.appendChild(h('<div class="settings__label">О приложении</div>'));
    const about = h('<div class="settings__list"></div>');
    about.appendChild(linkRow('📱', '@RsuhSpaceBot', 'наш бот', () => openTelegramLink('https://t.me/RsuhSpaceBot')));
    about.appendChild(linkRow('✉️', '@textquestion', 'связаться в Telegram', () => openTelegramLink('https://t.me/textquestion')));
    content.appendChild(about);

    // О разработчике.
    content.appendChild(h('<div class="settings__divider"></div>'));
    content.appendChild(h('<div class="settings__label">О разработчике</div>'));
    const dev = h('<div class="settings__list"></div>');
    dev.appendChild(linkRow('👨‍🎓', 'Искендер Аннамухаммедов', 'студент РГГУ · ФМиР', () => openTelegramLink('https://t.me/textquestion')));
    content.appendChild(dev);

    content.appendChild(h(`<div class="settings__version">Версия ${esc(APP_VERSION)} · ${esc(BOT_USERNAME)}</div>`));

    const close = openSheet(content, router);
  }

  // FAB: лупа (в режиме группы) / ✕ (в режиме преподавателя).
  // Прячется при скролле вниз, выезжает при скролле вверх. Живёт на mount,
  // а не на screen — draw() не пересоздаёт.
  function createFab() {
    const icon = isTeacher
      ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
      : '<svg viewBox="0 0 495 524" width="24" height="24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M349.212 280.149C369.179 278.747 392.282 285.678 409.047 296.437C432.712 311.879 449.189 336.17 454.792 363.87C460.903 393.175 453.739 420.967 437.47 445.606L442.846 447.958C453.102 452.446 472.512 477.409 482.67 485.431C492.938 493.544 500.102 507.29 488.995 518.342C485.475 521.856 480.693 523.81 475.715 523.761C472.237 523.749 468.832 522.708 465.942 520.773C460.873 517.43 435.964 491.812 429.669 485.603C421.256 477.643 420.392 477.318 418.041 465.972C400.523 478.53 384.316 486.699 362.42 488.481C334.395 491.015 306.534 482.1 285.189 463.755C264.188 445.637 251.286 419.877 249.363 392.201C247.392 363.888 256.858 335.967 275.644 314.695C295.084 292.401 320.152 282.115 349.212 280.149ZM426.437 381.523C424.716 341.123 390.696 309.693 350.29 311.175C309.548 312.669 277.799 347.031 279.532 387.762C281.259 428.498 315.812 460.044 356.536 458.072C396.924 456.119 428.151 421.922 426.437 381.523Z"/><path d="M133.119 317.487C143.097 316.207 152.06 323.457 162.63 326.537C193.467 335.525 214.659 334.515 244.766 326.726C236.763 343.602 231.436 358.089 230.297 376.984C227.315 426.293 252.236 468.273 293.976 492.869C257.348 493.641 218.779 493.034 182.007 493.022L74.3955 493.053L42.4638 493.084C31.2035 493.096 18.9097 494.627 9.8898 487.15C4.34294 482.558 0.587037 475.67 0.184753 468.512C-1.74646 434.149 11.6122 397.503 33.2345 371.07C58.0727 340.626 94.0211 321.344 133.119 317.487Z"/><path d="M200.906 0.115119C206.105 -0.330027 208.58 0.510676 213.262 2.72661C267.28 28.3001 321.077 54.38 374.953 80.2652C377.164 81.3281 379.601 82.7934 381.248 84.6138C381.603 88.5081 380.354 89.4167 377.041 91.0497C357.325 100.765 337.395 110.093 317.538 119.525L207.056 172C206.26 172.081 205.467 172.154 204.667 172.185C202.233 172.277 200.235 171.469 198.029 170.532C174.868 160.693 150.519 147.951 127.586 137.032C114.611 130.854 33.5262 93.7108 28.6541 88.9477C27.2617 87.5865 26.9965 86.5872 27.0082 84.6879C32.9059 79.6768 57.891 68.5224 66.219 64.5871L120.728 38.555L172.503 13.456C181.284 9.21521 191.97 3.71608 200.906 0.115119Z"/><path d="M97.6624 143.735L162.336 174.689C173.328 179.964 184.367 185.481 195.577 190.266C203.061 193.46 207.455 192.603 214.67 189.302C223.383 185.316 232.035 181.109 240.705 176.985C263.93 165.786 287.228 154.729 310.588 143.811C313.147 149.656 315.296 155.673 317.017 161.82C325.84 194.065 319.827 223.592 303.65 252.17C289.739 273.267 273.335 288.14 249.865 298.145C221.357 310.165 189.268 310.514 160.504 299.119C131.743 287.632 108.752 265.144 96.6245 236.645C83.3167 204.895 84.9558 175.101 97.6624 143.735Z"/></svg>';
    const el = h(`<button class="fab" aria-label="${isTeacher ? 'Закрыть' : 'Поиск преподавателя'}">${icon}</button>`);
    el.addEventListener('click', () => {
      haptic('light');
      if (isTeacher) router.back();
      else openTeacherSearch();
    });

    // Скролл-аутохайд. Источник скролла — window.
    let lastY = window.scrollY;
    let hidden = false;
    const onScroll = () => {
      if (!el.isConnected) { window.removeEventListener('scroll', onScroll); return; }
      const y = window.scrollY;
      const dy = y - lastY;
      if (Math.abs(dy) < 6) return;
      const shouldHide = dy > 0 && y > 40;
      if (shouldHide !== hidden) {
        hidden = shouldHide;
        el.classList.toggle('fab--hidden', hidden);
      }
      lastY = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return { el };
  }

  // Sheet поиска преподавателя. Список грузится при первом открытии и кэшируется
  // в модульной переменной teachersCache на сессию. Фильтр — после 2+ символов,
  // нечувствительный к регистру, по подстроке.
  async function openTeacherSearch() {
    const content = h('<div class="teacher-search"></div>');
    content.appendChild(h('<div class="sheet__title">Поиск преподавателя</div>'));
    const inputWrap = h(`
      <div class="teacher-search__input">
        <input type="search" placeholder="Имя или фамилия" autocomplete="off" />
      </div>
    `);
    const input = inputWrap.querySelector('input');
    content.appendChild(inputWrap);
    const status = h('<div class="teacher-search__status caption">Загружаю список…</div>');
    content.appendChild(status);
    const list = h('<div class="teacher-search__list"></div>');
    content.appendChild(list);

    const closeSheet = openSheet(content, router);

    let teachers = teachersCache;
    if (!teachers) {
      try {
        teachers = await fetchTeachers();
        teachersCache = teachers;
      } catch (_) {
        status.textContent = 'Не удалось загрузить список. Попробуй ещё раз.';
        return;
      }
    }
    status.textContent = `Введи 2+ символа (всего ${teachers.length})`;

    // Каждая смена состояния (статус-строка/контейнер списка) — мягкое появление
    // через Web Animations API. Прерывает предыдущее, не плодит классы и сбросы.
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const softIn = (el) => {
      if (!el || reduceMotion) return;
      el.animate(
        [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 200, easing: 'ease-out' },
      );
    };
    const setStatus = (text) => {
      if (status.textContent === text) return;
      status.textContent = text;
      softIn(status);
    };

    const renderList = () => {
      const q = input.value.trim().toLowerCase();
      const hadRows = list.children.length > 0;
      list.innerHTML = '';
      if (q.length < 2) {
        setStatus(`Введи 2+ символа (всего ${teachers.length})`);
        return;
      }
      const found = teachers.filter((t) => t.name.toLowerCase().includes(q)).slice(0, 80);
      if (!found.length) {
        setStatus('Никого не нашлось');
        return;
      }
      setStatus(`Найдено: ${found.length}${found.length === 80 ? '+ (уточни запрос)' : ''}`);
      // Контейнер списка плавно появляется при переходе «нет строк → есть строки»;
      // при поверх-фильтрации (строки уже были) не анимируем контейнер — за
      // плавность отвечает staggered-анимация самих строк.
      if (!hadRows) softIn(list);
      for (let i = 0; i < found.length; i++) {
        const t = found[i];
        // Staggered fade-in + slide-up: первые 10 строк с задержкой 30ms друг
        // за другом (общая «волна» ~300ms), остальные появляются разом.
        const delay = i < 10 ? i * 30 : 0;
        const row = h(`<button class="option-row teacher-row" style="animation-delay:${delay}ms"><span class="option-row__label">${esc(t.name)}</span></button>`);
        row.addEventListener('click', () => {
          hapticSelection();
          closeSheet();
          router.navigate('schedule', { teacher: t });
        });
        list.appendChild(row);
      }
    };

    input.addEventListener('input', renderList);
    setTimeout(() => input.focus(), 50);
  }
}

// Сессионный кэш списка преподавателей (1600 шт., грузим один раз).
let teachersCache = null;

// =========================================================
// 6.4 Профиль: данные о группе + экзамены + статистика семестра + посещаемость
// =========================================================

// Является ли пара экзаменом/зачётом по типу. Считаем все варианты написания.
function isExamLike(lessontype) {
  const t = (lessontype || '').toLowerCase();
  return t.includes('экзамен') || t.includes('зачет') || t.includes('зачёт');
}

// Двузначная дата вида "03.02". new Date(timestamp) → берёт месяц/день.
function pad2(n) { return String(n).padStart(2, '0'); }
function shortDate(date) {
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}, ${WEEKDAYS_SHORT[date.getDay()]}`;
}

// Простой тултип на тап по элементу (для ℹ️ значков). Использует Web Animations
// API для плавного появления, прячется по тайм-ауту.
function attachTip(triggerEl, text) {
  const tip = h(`<span class="tip-bubble" role="tooltip">${esc(text)}</span>`);
  triggerEl.classList.add('info-tip-wrap');
  triggerEl.appendChild(tip);
  let timer = null;
  triggerEl.addEventListener('click', (e) => {
    e.stopPropagation();
    tip.classList.add('tip-bubble--on');
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => tip.classList.remove('tip-bubble--on'), 3500);
  });
}

export function renderProfile(mount, params, router) {
  const group = params.group || get.group();
  if (!group) {
    // Без выбранной группы профиль показывать нечего — отправляем в picker.
    router.reset('picker', { step: 'form' });
    return;
  }

  const screen = h('<section class="profile stack"></section>');
  mount.appendChild(screen);

  let schedule = null;
  trackEvent('profile_open', { group: group.id });
  load();

  async function load() {
    drawHeader('Загружаю профиль…');
    try {
      let data = getFreshSchedule(group.id);
      if (!isValid(data)) {
        data = await fetchSchedule(group.id, group.form, group.year);
        setScheduleFor(group.id, data);
      }
      schedule = data;
      drawAll();
    } catch (_) {
      drawError();
    }
  }

  function isValid(d) {
    return Boolean(d && Array.isArray(d.dates) && d.byDate && typeof d.byDate === 'object');
  }

  function drawHeader(loadingNote) {
    screen.innerHTML = '';
    screen.appendChild(h(`
      <header class="profile-head">
        <button class="picker-back" aria-label="Назад">←</button>
        <h2>Профиль</h2>
      </header>
    `));
    screen.querySelector('.picker-back').addEventListener('click', () => {
      haptic('light'); router.back();
    });
    if (loadingNote) {
      screen.appendChild(h(`<div class="profile-loading">${esc(loadingNote)}</div>`));
    }
  }

  function drawError() {
    drawHeader();
    screen.appendChild(mascotBlock({
      pose: 'sad',
      title: 'Не получилось загрузить профиль',
      subtitle: 'Похоже, пропала связь. Попробуй ещё раз.',
      actions: [
        { label: 'Попробовать снова', onClick: load },
        { label: 'Назад к расписанию', variant: 'ghost', onClick: () => router.back() },
      ],
    }));
  }

  function drawAll() {
    drawHeader();
    screen.appendChild(buildStudentBlock(group, router));
    screen.appendChild(buildExamsBlock(schedule));
    screen.appendChild(buildStatsBlock(schedule));
    screen.appendChild(buildAttendanceBlock(schedule));
  }
}

// ── Блок «Студент» ──
function buildStudentBlock(group, router) {
  const { direction, profile: profileTitle } = splitDetails(group.details);
  const abbr = instituteAbbr(group.name);
  const inst = instituteName(abbr);
  const icon = instituteIcon(abbr);
  const formCode = GROUP_FORMS[group.form] || '';
  const formLabel = formatFormCode(formCode); // «Бакалавриат, очная»
  // Курс + lowercased форма: «2 курс · бакалавриат · очная».
  const formLower = formLabel ? formLabel.toLowerCase().replace(/,\s*/g, ' · ') : '';
  const courseLevel = `${group.year} курс${formLower ? ' · ' + formLower : ''}`;
  // Имя направления (если есть) первичный заголовок; иначе код группы как fallback.
  const headline = direction || group.name;

  const block = h(`
    <section class="profile-block">
      <div class="profile-block__title">Студент</div>
      <div class="profile-block__card">
        <div class="profile-student">
          <div class="profile-student__direction">${esc(headline)}</div>
          <div class="profile-student__details">${esc(courseLevel)}</div>
          <div class="profile-student__institute">${esc(icon)} ${esc(inst.name)}</div>
          ${profileTitle ? `<div class="profile-student__profile muted">${esc(profileTitle)}</div>` : ''}
          <div class="profile-student__group muted">Группа ${esc(group.name)}</div>
          <button class="btn btn--ghost btn--block profile-student__change">Изменить группу</button>
        </div>
      </div>
    </section>
  `);
  block.querySelector('.profile-student__change').addEventListener('click', () => {
    haptic('light');
    router.reset('picker', { step: 'form' });
  });
  return block;
}

// ── Блок «Экзамены» ──
function buildExamsBlock(schedule) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exams = [];
  // Дедуп по subject|date|teacher: один экзамен часто стоит как две пары
  // подряд (двойной слот). Аудитория из ключа исключена — в данных она
  // может различаться (но это всё равно один экзамен).
  const seen = new Set();
  for (const dateKey of schedule.dates) {
    const ts = dateKeyToTs(dateKey);
    for (const l of schedule.byDate[dateKey] || []) {
      if (!isExamLike(l.lessontype)) continue;
      const key = `${l.subject}|${dateKey}|${l.teacher || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      exams.push({ dateKey, ts, lesson: l });
    }
  }
  exams.sort((a, b) => a.ts - b.ts);

  const block = h(`
    <section class="profile-block">
      <div class="profile-block__title">Экзамены</div>
      <div class="profile-block__card"></div>
    </section>
  `);
  const card = block.querySelector('.profile-block__card');

  if (!exams.length) {
    card.appendChild(h('<div class="profile-empty">Экзамены не найдены в расписании.</div>'));
    return block;
  }

  const remaining = exams.filter((e) => e.ts >= today.getTime()).length;
  const counter = h(`
    <div class="exams-counter">
      <span>Осталось <strong>${remaining}</strong> из ${exams.length}</span>
      <button class="info-tip" aria-label="Что значит счётчик?">ℹ️</button>
    </div>
  `);
  attachTip(counter.querySelector('.info-tip'),
    'Считается по дате — прошёл день экзамена или нет, не по факту сдачи.');
  card.appendChild(counter);

  const list = h('<div class="exam-list"></div>');
  for (const e of exams) {
    const past = e.ts < today.getTime();
    const d = new Date(e.ts);
    const meta = [e.lesson.room, e.lesson.teacher].filter(Boolean).join(' · ');
    list.appendChild(h(`
      <div class="exam-row${past ? ' exam-row--past' : ''}">
        <div class="exam-row__date">${esc(shortDate(d))}</div>
        <div class="exam-row__subject">${esc(e.lesson.subject)}</div>
        ${meta ? `<div class="exam-row__meta">${esc(meta)}</div>` : ''}
      </div>
    `));
  }
  card.appendChild(list);
  return block;
}

// ── Блок «Статистика семестра» ──
function buildStatsBlock(schedule) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let total = 0, remaining = 0;
  let lectures = 0, seminars = 0, examsZachet = 0;
  let daysWithLessons = 0, daysPassed = 0;
  for (const dateKey of schedule.dates) {
    const ts = dateKeyToTs(dateKey);
    const lessons = schedule.byDate[dateKey] || [];
    if (lessons.length) {
      daysWithLessons++;
      if (ts < today.getTime()) daysPassed++;
    }
    for (const l of lessons) {
      total++;
      if (ts >= today.getTime()) remaining++;
      const t = (l.lessontype || '').toLowerCase();
      if (isExamLike(l.lessontype)) examsZachet++;
      else if (t.includes('лек')) lectures++;
      else if (t.includes('сем')) seminars++;
    }
  }
  const pct = daysWithLessons > 0 ? Math.round((daysPassed / daysWithLessons) * 100) : 0;
  const np = (n, forms) => `${n} ${pluralRu(n, forms)}`;

  const breakdownParts = [
    np(lectures, ['лекция', 'лекции', 'лекций']),
    np(seminars, ['семинар', 'семинара', 'семинаров']),
    np(examsZachet, ['экзамен', 'экзамена', 'экзаменов']),
  ];

  return h(`
    <section class="profile-block">
      <div class="profile-block__title">Статистика семестра</div>
      <div class="profile-block__card">
        <div class="stat-row"><span>Всего пар</span><strong>${total}</strong></div>
        <div class="stat-row"><span>Осталось</span><strong>${remaining}</strong></div>
        <div class="stat-row stat-row--col">
          <span class="muted">Из них</span>
          <span>${esc(breakdownParts.join(' · '))}</span>
        </div>
        <div class="progress"><div class="progress__bar" style="width:${pct}%"></div></div>
        <div class="progress-label">Семестр пройден на <strong>${pct}%</strong></div>
      </div>
    </section>
  `);
}

// Локальная плюрализация (хелпер render.js не экспортирован).
function pluralRu(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

// ── Блок «Посещаемость» ──
// Аккордеоны по предметам. Циклическое переключение статуса:
//   ○ (не отмечено) → ✅ (был) → ❌ (не был) → ○
// Будущие даты — без статуса, только дата. Изменения сразу пишутся через
// setAttendanceCell (CloudStorage + localStorage mirror).
function buildAttendanceBlock(schedule) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTs = today.getTime();

  // Группируем все даты по предмету (без экзаменов/зачётов).
  // Значение в Map по dateKey — { ts, lessontype } — нужно, чтобы рядом с
  // датой показывать «· лекция / · семинар». Если в один день предмета
  // несколько пар, берём тип первой.
  const bySubject = new Map();
  for (const dateKey of schedule.dates) {
    const ts = dateKeyToTs(dateKey);
    for (const l of schedule.byDate[dateKey] || []) {
      if (isExamLike(l.lessontype)) continue;
      if (!bySubject.has(l.subject)) bySubject.set(l.subject, new Map());
      const dayMap = bySubject.get(l.subject);
      if (!dayMap.has(dateKey)) dayMap.set(dateKey, { ts, lessontype: l.lessontype });
    }
  }

  const block = h(`
    <section class="profile-block">
      <div class="profile-block__title">Посещаемость</div>
      <div class="profile-block__card"></div>
    </section>
  `);
  const card = block.querySelector('.profile-block__card');

  if (!bySubject.size) {
    card.appendChild(h('<div class="profile-empty">Предметы в расписании не найдены.</div>'));
    return block;
  }

  const attendance = get.attendance();

  // Общая сводка по всем предметам: N посещений из M прошедших дат с парами.
  // Tultip справа — поясняет что считается. Если нет ни одной отметки —
  // вместо процента fallback-сообщение.
  const summary = h(`
    <div class="attend-summary">
      <div class="attend-summary__row">
        <span class="attend-summary__label">Общая посещаемость</span>
        <span class="attend-summary__value-wrap">
          <strong class="attend-summary__value"></strong>
          <button class="info-tip" aria-label="Что это значит?">ℹ️</button>
        </span>
      </div>
      <div class="progress"><div class="progress__bar attend-summary__bar"></div></div>
      <div class="attend-summary__hint muted"></div>
    </div>
  `);
  attachTip(summary.querySelector('.info-tip'),
    'На основе ваших отметок о посещении.');
  card.appendChild(summary);

  const summaryValueEl = summary.querySelector('.attend-summary__value');
  const summaryBarEl = summary.querySelector('.attend-summary__bar');
  const summaryHintEl = summary.querySelector('.attend-summary__hint');

  // Состояние посещаемости держим в одной структуре, чтобы переключение
  // статуса конкретной ячейки обновляло и общую сводку.
  const liveData = {}; // { subject: { dateKey: { status, ... } } }
  for (const s of bySubject.keys()) liveData[s] = { ...(attendance[s] || {}) };

  function refreshSummary() {
    let totalPast = 0, totalPresent = 0, totalMarked = 0;
    for (const [subject, dayMap] of bySubject.entries()) {
      const sd = liveData[subject] || {};
      for (const [dateKey, info] of dayMap.entries()) {
        if (info.ts >= todayTs) continue;
        totalPast++;
        const status = sd[dateKey]?.status;
        if (status === 'present') totalPresent++;
        if (status === 'present' || status === 'absent') totalMarked++;
      }
    }
    if (totalMarked === 0) {
      summaryValueEl.textContent = '—';
      summaryBarEl.style.width = '0%';
      summaryHintEl.textContent = 'Отметьте посещение чтобы увидеть статистику.';
    } else {
      const pct = totalPast > 0 ? Math.round((totalPresent / totalPast) * 100) : 0;
      summaryValueEl.textContent = `${pct}%`;
      summaryBarEl.style.width = `${pct}%`;
      summaryHintEl.textContent = `Посетил ${totalPresent} из ${totalPast}.`;
    }
  }
  refreshSummary();

  const list = h('<div class="attend-list"></div>');

  // Сортируем по алфавиту имени предмета.
  const subjects = [...bySubject.keys()].sort((a, b) => a.localeCompare(b, 'ru'));

  for (const subject of subjects) {
    const dates = [...bySubject.get(subject).entries()].sort((a, b) => a[1].ts - b[1].ts);
    // dates: [ [dateKey, {ts, lessontype}], ... ]
    const subjectData = liveData[subject];
    const presentCount = dates.reduce((s, [k]) =>
      s + (subjectData[k]?.status === 'present' ? 1 : 0), 0);
    const pastCount = dates.filter(([, info]) => info.ts < todayTs).length;

    const item = h(`
      <div class="attend-item">
        <button class="attend-item__head" aria-expanded="false">
          <span class="attend-item__subject">${esc(subject)}</span>
          <span class="attend-item__counter">Посетил ${presentCount} из ${pastCount}</span>
          <span class="attend-item__chev">›</span>
        </button>
        <div class="attend-item__body"></div>
      </div>
    `);
    const head = item.querySelector('.attend-item__head');
    const body = item.querySelector('.attend-item__body');
    const counterEl = item.querySelector('.attend-item__counter');

    head.addEventListener('click', () => {
      haptic('light');
      const open = item.classList.toggle('attend-item--open');
      head.setAttribute('aria-expanded', String(open));
    });

    // Рендерим строки дат. Eager-рендер — обычно 10-30 дат на предмет.
    for (const [dateKey, info] of dates) {
      const d = new Date(info.ts);
      const isFuture = info.ts > todayTs;
      const cell = subjectData[dateKey] || {};
      const typeLabel = lessonTypeInfo(info.lessontype).label.toLowerCase();
      const dateLine = `${shortDate(d)}${typeLabel ? ' · ' + typeLabel : ''}`;
      const row = h(`
        <div class="attend-row${isFuture ? ' attend-row--future' : ''}">
          <span class="attend-row__date">${esc(dateLine)}</span>
          ${isFuture
            ? '<span class="attend-row__future-mark muted">впереди</span>'
            : `<button class="attend-status attend-status--${cell.status || 'none'}" aria-label="Сменить статус">
                 ${statusGlyph(cell.status)}
               </button>`}
        </div>
      `);
      if (!isFuture) {
        const statusBtn = row.querySelector('.attend-status');
        statusBtn.addEventListener('click', async () => {
          haptic('light');
          const cur = (subjectData[dateKey] || {}).status || null;
          const nextStatus = cur === null ? 'present' : cur === 'present' ? 'absent' : null;
          await setAttendanceCell(subject, dateKey, nextStatus);
          if (nextStatus === null) delete subjectData[dateKey];
          else subjectData[dateKey] = { status: nextStatus };
          statusBtn.className = `attend-status attend-status--${nextStatus || 'none'}`;
          statusBtn.innerHTML = statusGlyph(nextStatus);
          const newPresent = dates.reduce((s, [k]) =>
            s + (subjectData[k]?.status === 'present' ? 1 : 0), 0);
          counterEl.textContent = `Посетил ${newPresent} из ${pastCount}`;
          refreshSummary();
        });
      }
      body.appendChild(row);
    }
    list.appendChild(item);
  }
  card.appendChild(list);
  return block;
}

function statusGlyph(status) {
  if (status === 'present') return '✅';
  if (status === 'absent') return '❌';
  return '○';
}

// Строка-ссылка для настроек (поддержать, о приложении). Иконка слева как
// акцент, текст по центру, шеврон справа. onClick — обработчик нажатия.
function linkRow(icon, label, sub, onClick) {
  const row = h(`
    <button class="link-row">
      <span class="link-row__icon">${esc(icon)}</span>
      <span class="link-row__text">
        <span class="link-row__label">${esc(label)}</span>
        ${sub ? `<span class="link-row__sub">${esc(sub)}</span>` : ''}
      </span>
      <span class="link-row__chev">›</span>
    </button>
  `);
  row.addEventListener('click', () => { haptic('light'); onClick(); });
  return row;
}

// Строка-тумблер для настроек. onChange(boolean).
function toggleRow(label, on, onChange) {
  const row = h(`
    <div class="toggle-row">
      <span>${esc(label)}</span>
      <button class="toggle${on ? ' toggle--on' : ''}" role="switch" aria-checked="${on}"><span class="toggle__knob"></span></button>
    </div>
  `);
  const tg = row.querySelector('.toggle');
  tg.addEventListener('click', () => {
    haptic('light');
    const next = !tg.classList.contains('toggle--on');
    tg.classList.toggle('toggle--on', next);
    tg.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  return row;
}
