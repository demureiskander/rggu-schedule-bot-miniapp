// Экраны приложения: welcome, picker (форма→курс→поиск), расписание + sheets.

import { fetchFlows, fetchSchedule, fetchWeather, tsToDateKey, dateKeyToTs } from './api.js?v=7';
import { formGroups, COURSES, MASCOT, GROUP_FORMS, formatFormCode, buildTree, splitDetails } from './constants.js?v=7';
import { APP_VERSION, BOT_USERNAME } from '../config.js?v=7';
import { set, get, getFreshSchedule, setScheduleFor, setWeather } from './store.js?v=7';
import { applyTheme } from './theme.js?v=7';
import { haptic, hapticSelection, setBackVisible } from './telegram.js?v=7';
import { renderLesson, weekStrip, dayNav, counterText, weatherBadge, lessonDetail } from './render.js?v=7';

const LAYOUT_LABELS = { block: 'Блочный', compact: 'Компакт.', ribbon: 'Ленточный' };

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
  const group = params.group;
  const screen = h('<section class="schedule"></section>');
  mount.appendChild(screen);

  let schedule = null;
  let selected = null; // Date

  load();

  async function load() {
    screen.innerHTML = '';
    screen.appendChild(mascotBlock({ pose: 'think', title: 'Загружаю расписание…', spinner: true }));
    try {
      let data = getFreshSchedule(group.id);
      if (!data) {
        data = await fetchSchedule(group.id, group.form, group.year);
        setScheduleFor(group.id, data);
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
    screen.appendChild(mascotBlock({
      pose: 'sad',
      title: 'Что-то пошло не так',
      subtitle: 'Не удалось загрузить расписание. Проверь подключение к интернету.',
      actions: [
        { label: 'Попробовать снова', onClick: load },
        { label: 'Выбрать другую группу', variant: 'ghost', onClick: () => router.reset('picker', { step: 'form' }) },
      ],
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
    selected = next;
    draw();
  }

  function selectDate(date) {
    hapticSelection();
    selected = date;
    draw();
  }

  // Свайп полоски недели — переключение на ±7 дней; если новая дата вне
  // загруженного диапазона, прижимаем к границе (а не игнорируем свайп).
  function changeWeek(delta) {
    const next = new Date(selected);
    next.setDate(next.getDate() + delta * 7);
    const { min, max } = rangeBounds();
    if (next.getTime() < min) next.setTime(min);
    if (next.getTime() > max) next.setTime(max);
    if (next.toDateString() === selected.toDateString()) return;
    haptic('light');
    selected = next;
    draw();
  }

  // Прыжок на сегодняшний день (в пределах загруженного диапазона).
  function goToday() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const { min, max } = rangeBounds();
    if (today.getTime() < min || today.getTime() > max) return;
    haptic('light');
    selected = today;
    draw();
  }

  function draw() {
    screen.innerHTML = '';

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const isToday = selected.toDateString() === today.toDateString();
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const isTomorrow = selected.toDateString() === tomorrow.toDateString();
    const { min, max } = rangeBounds();
    const todayInRange = today.getTime() >= min && today.getTime() <= max;

    // Шапка: погода (если включена, и только для сегодня/завтра) слева;
    // справа — «Сегодня» (если не на сегодня) + шестерёнка.
    const top = h('<div class="sched-top"></div>');
    const wEl = (get.weatherEnabled() && (isToday || isTomorrow)) ? weatherBadge(get.weather()) : null;
    top.appendChild(wEl || h('<span></span>'));
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

    // Полоска недели (7 дней) + навигация дня + счётчик.
    // Вне диапазона — погашены; пустые дни (если включено) — приглушены; сегодня — жёлтый.
    const inRange = (d) => d.getTime() >= min && d.getTime() <= max;
    const hasLessons = (d) => (schedule.byDate[tsToDateKey(d)] || []).length > 0;
    screen.appendChild(weekStrip(selected, selectDate, {
      isEnabled: inRange, hasLessons, dimEmpty: get.highlightEmptyDays(),
      onWeekSwipe: changeWeek,
    }));
    screen.appendChild(dayNav(selected, () => changeDay(-1), () => changeDay(1)));

    const lessons = schedule.byDate[tsToDateKey(selected)] || [];

    const counter = h(`<div class="counter">${esc(counterText(lessons, isToday))}</div>`);
    screen.appendChild(counter);
    startTicker(counter, lessons, isToday);

    // Тело: список пар или пустой день.
    const body = h('<div class="sched-body"></div>');
    screen.appendChild(body);
    attachSwipe(body);

    if (!lessons.length) {
      body.appendChild(mascotBlock({ pose: 'sleep', title: 'На сегодня пар нет', compact: true }));
      return;
    }

    const layout = get.layout();
    const list = h(`<div class="lessons lessons--${layout}"></div>`);
    for (const lesson of lessons) {
      const el = renderLesson(lesson, layout);
      const card = el.matches('button') ? el : el.querySelector('button') || el;
      card.addEventListener('click', () => openDetail(lesson));
      list.appendChild(el);
    }
    body.appendChild(list);
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

  // Сводка по предмету до конца семестра (из загруженного расписания = весь семестр).
  // remaining/breakdown — от сегодняшней даты; next — ближайшая будущая пара;
  // exam — занятие с lessontype 'экзамен' (если есть).
  function subjectStats(subject) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const now = new Date();
    const atDateTime = (dateKey, start) => {
      const ts = dateKeyToTs(dateKey);
      const [hh, mm] = (start || '00:00').split(':').map(Number);
      return ts + (hh * 60 + mm) * 60000;
    };
    let remaining = 0, lectures = 0, seminars = 0, combo = 0, other = 0;
    let next = null, exam = null;
    for (const dateKey of schedule.dates) {
      const ts = dateKeyToTs(dateKey);
      for (const l of schedule.byDate[dateKey]) {
        if (l.subject !== subject) continue;
        const type = (l.lessontype || '').toLowerCase();
        // Экзамен — отдельной строкой, в «осталось пар» и «следующую» не считаем.
        if (type === 'экзамен') {
          if (!exam) exam = { dateKey, start: l.start };
          continue;
        }
        if (ts >= today.getTime()) {
          remaining++;
          const isLec = type.includes('лек');
          const isSem = type.includes('сем');
          if (isLec && isSem) combo++;
          else if (isLec) lectures++;
          else if (isSem) seminars++;
          else other++;
          if (!next && atDateTime(dateKey, l.start) > now.getTime()) {
            next = { dateKey, start: l.start };
          }
        }
      }
    }
    return { remaining, lectures, seminars, combo, other, next, exam };
  }

  // --- Sheet: детали пары (6.7) ---
  function openDetail(lesson) {
    haptic('light');
    openSheet(lessonDetail(lesson, subjectStats(lesson.subject)), router);
  }

  // --- Sheet: настройки (6.6) ---
  function openSettings() {
    haptic('light');
    const content = h('<div class="settings"></div>');
    content.appendChild(h('<div class="sheet__title">Настройки</div>'));

    // Группа.
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

    // Вид расписания.
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
