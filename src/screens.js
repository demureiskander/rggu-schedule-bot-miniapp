// Экраны приложения: welcome, picker (форма→курс→поиск), расписание + sheets.

import {
  fetchFlows, fetchSchedule, fetchTeacherSchedule, fetchTeachers,
  fetchWeather, tsToDateKey, dateKeyToTs,
} from './api.js?v=20';
import { formGroups, COURSES, MASCOT, GROUP_FORMS, formatFormCode, buildTree, splitDetails } from './constants.js?v=20';
import { APP_VERSION, BOT_USERNAME } from '../config.js?v=20';
import { set, get, getFreshSchedule, setScheduleFor, setWeather } from './store.js?v=20';
import { applyTheme } from './theme.js?v=20';
import { haptic, hapticSelection, setBackVisible } from './telegram.js?v=20';
import {
  renderLesson, weekStrip, dayNav, weekNav, weekMonday, weekDayHeader,
  counterText, weatherBadge, weatherForDate, lessonDetail,
} from './render.js?v=20';

const LAYOUT_LABELS = {
  block: 'Блочный', compact: 'Компакт.', ribbon: 'Ленточный',
};
const DISPLAY_MODE_LABELS = { day: 'По дням', week: 'По неделям' };

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

  // Свайп вниз по шиту — закрытие.
  let startY = null;
  sheet.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
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
  const group = {
    form: params.form, year: params.course,
    id: flow.id, name: flow.name, details: flow.details,
  };
  await set('group', group);
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
        if (!data) {
          data = await fetchSchedule(group.id, group.form, group.year);
          setScheduleFor(group.id, data);
        }
      }
      schedule = data;
      selected = pickInitialDate(data);
      ensureWeather();
      draw();
    } catch (_) {
      renderError();
    }
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

  // Направление мягкой анимации тела при следующем draw():
  //   'forward'  — приехать справа (день/неделя вперёд)
  //   'backward' — приехать слева (день/неделя назад)
  //   'fade'     — плавное появление без направления (для «Сегодня»)
  //   null       — без анимации (первая отрисовка, обновление по weather и т.п.)
  let nextDirection = null;

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
    const cmp = date.getTime() - selected.getTime();
    nextDirection = cmp > 0 ? 'forward' : cmp < 0 ? 'backward' : null;
    selected = date;
    draw();
  }

  // Прыжок на сегодняшний день (в пределах загруженного диапазона).
  function goToday() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const { min, max } = rangeBounds();
    if (today.getTime() < min || today.getTime() > max) return;
    haptic('light');
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

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const isToday = selected.toDateString() === today.toDateString();
    const { min, max } = rangeBounds();
    const todayInRange = today.getTime() >= min && today.getTime() <= max;
    const layout = get.layout();
    const isWeek = get.displayMode() === 'week';

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
    // слева — только в режиме «по дням». В недельном виде погода уезжает в
    // заголовки каждого дня (drawWeeklyBody).
    const top = h('<div class="sched-top"></div>');
    const headerWeather = (!isWeek && get.weatherEnabled())
      ? weatherBadge(weatherForDate(get.weather(), selected)) : null;
    top.appendChild(headerWeather || h('<span></span>'));
    const right = h('<div class="sched-top__right"></div>');
    if (!isToday && todayInRange) {
      const todayBtn = h('<button class="today-btn">Сегодня</button>');
      todayBtn.addEventListener('click', goToday);
      right.appendChild(todayBtn);
    }
    const gear = h('<button class="icon-btn" aria-label="Настройки">⚙</button>');
    gear.addEventListener('click', () => openSettings());
    right.appendChild(gear);
    top.appendChild(right);
    screen.appendChild(top);

    // Полоска дней — горизонтальный скролл по всему загруженному диапазону.
    // Дни генерируем сплошным интервалом от min до max (включая дни без пар
    // и «сегодня» даже если без пар); пустые дни приглушены, сегодня — жёлтый;
    // выбранный день центрируется (плавно при навигации, мгновенно при первой
    // отрисовке). Если «сегодня» лежит между min..max, оно гарантированно
    // оказывается в ленте — иначе кнопка «Сегодня» не имела бы куда прыгнуть.
    const hasLessons = (d) => (schedule.byDate[tsToDateKey(d)] || []).length > 0;
    const days = [];
    for (let t = min; t <= max; ) {
      const d = new Date(t);
      days.push(d);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      t = next.getTime();
    }
    // Полоска: в режиме «по неделям» подсвечиваем все 7 дней текущей недели мягким фоном.
    const monday = weekMonday(selected);
    const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6);
    const inCurrentWeek = (d) => d.getTime() >= monday.getTime() && d.getTime() <= sunday.getTime();
    screen.appendChild(weekStrip(days, selected, selectDate, {
      hasLessons, dimEmpty: get.highlightEmptyDays(),
      inRange: isWeek ? inCurrentWeek : null,
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
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday); d.setDate(monday.getDate() + i);
      const isTodayDay = d.toDateString() === today.toDateString();
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
      wrap.appendChild(dayBlock);
    }
    body.appendChild(wrap);
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
    for (const key of ['day', 'week']) {
      const chip = h(`<button class="seg${get.displayMode() === key ? ' seg--on' : ''}">${DISPLAY_MODE_LABELS[key]}</button>`);
      chip.addEventListener('click', async () => {
        hapticSelection();
        await set('displayMode', key);
        segDM.querySelectorAll('.seg').forEach((c) => c.classList.remove('seg--on'));
        chip.classList.add('seg--on');
        draw();
      });
      segDM.appendChild(chip);
    }
    content.appendChild(segDM);

    // Погода.
    content.appendChild(toggleRow('Погода', get.weatherEnabled(), async (on) => {
      await set('weatherEnabled', on);
      if (on) await ensureWeather();
      draw();
    }));

    // Подсветка дней без пар.
    content.appendChild(toggleRow('Затемнять дни без пар', get.highlightEmptyDays(), async (on) => {
      await set('highlightEmptyDays', on);
      draw();
    }));

    // Тема.
    content.appendChild(toggleRow('Тёмная тема', get.theme() === 'dark', async (on) => {
      const theme = on ? 'dark' : 'light';
      await set('theme', theme);
      applyTheme(theme);
    }));

    content.appendChild(h(`<div class="settings__version">Версия ${esc(APP_VERSION)} · ${esc(BOT_USERNAME)}</div>`));

    const close = openSheet(content, router);
  }

  // FAB: лупа (в режиме группы) / ✕ (в режиме преподавателя).
  // Прячется при скролле вниз, выезжает при скролле вверх. Живёт на mount,
  // а не на screen — draw() не пересоздаёт.
  function createFab() {
    const icon = isTeacher
      ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
      : '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
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
