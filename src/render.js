// Рендереры расписания. Одна модель (lesson) — три вида (block/compact/ribbon).
// Здесь только презентация; загрузка/навигация/состояние — в screens.js.

import {
  LECTURE_TYPES, WEATHER_ICONS, WEEKDAYS_SHORT, WEEKDAYS_FULL, MONTHS_GENITIVE,
} from './constants.js?v=2';

// --- DOM/утилиты ---
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
// Русская плюрализация: pick(n, ['пара','пары','пар']).
function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

// Тип пары: лекция / семинар / прочее (для цвета бейджа и точки).
export function lessonTypeInfo(type) {
  const t = (type || '').toLowerCase();
  const label = LECTURE_TYPES[t] || (type ? type[0].toUpperCase() + type.slice(1) : 'Занятие');
  if (t === 'лек') return { label, kind: 'lecture' };
  if (t === 'сем') return { label, kind: 'seminar' };
  return { label, kind: 'other' };
}

// Строка «препод · ауд. N» (room/teacher могут быть пустыми после чистки '-').
function metaLine(lesson) {
  return [lesson.teacher, lesson.room ? `ауд. ${lesson.room}` : '']
    .filter(Boolean).join(' · ');
}

// =========================================================
// renderLesson(lesson, layout) — одна пара под выбранный вид
// =========================================================
export function renderLesson(lesson, layout) {
  if (layout === 'compact') return renderCompact(lesson);
  if (layout === 'ribbon') return renderRibbon(lesson);
  return renderBlock(lesson);
}

// Блочный (дефолт): карточка с цветной левой полосой и бейджем типа.
function renderBlock(lesson) {
  const { label, kind } = lessonTypeInfo(lesson.lessontype);
  const card = h(`
    <button class="lesson lesson--block kind-${kind}">
      <div class="lesson__time">${esc(lesson.start)} — ${esc(lesson.end)}</div>
      <div class="lesson__title">${esc(lesson.subject)}</div>
      <div class="lesson__badge-row"><span class="badge badge--${kind}">${esc(label)}</span></div>
      ${metaLine(lesson) ? `<div class="lesson__meta">${esc(metaLine(lesson))}</div>` : ''}
    </button>
  `);
  return card;
}

// Компактный: точка(тип) + время + название + аудитория.
function renderCompact(lesson) {
  const { kind } = lessonTypeInfo(lesson.lessontype);
  const row = h(`
    <button class="lesson lesson--compact kind-${kind}">
      <span class="dot dot--${kind}"></span>
      <span class="lesson__c-time">${esc(lesson.start)}</span>
      <span class="lesson__c-title">${esc(lesson.subject)}</span>
      <span class="lesson__c-room">${esc(lesson.room)}</span>
    </button>
  `);
  return row;
}

// Ленточный: время на оси слева + карточка с цветной полосой.
function renderRibbon(lesson) {
  const { label, kind } = lessonTypeInfo(lesson.lessontype);
  const meta = [label.toLowerCase(), lesson.teacher, lesson.room].filter(Boolean).join(' · ');
  const row = h(`
    <div class="lesson lesson--ribbon kind-${kind}">
      <div class="ribbon__axis">
        <div class="ribbon__time">${esc(lesson.start)}</div>
        <div class="ribbon__line"></div>
      </div>
      <button class="ribbon__card kind-${kind}">
        <div class="lesson__title ribbon__title">${esc(lesson.subject)}</div>
        <div class="lesson__meta">${esc(meta)}</div>
      </button>
    </div>
  `);
  return row;
}

// =========================================================
// Шапка: полоска недели, навигация по дню, счётчик, погода
// =========================================================

// Полоска 6 дней (Пн–Сб) недели выбранного дня. onSelect(Date).
// isEnabled(Date) -> bool: дни вне загруженного диапазона гасятся и не кликаются
// (честнее клампа: пустой день = «каникулы», а недоступный — явно неактивен).
export function weekStrip(selectedDate, onSelect, isEnabled = () => true) {
  // Понедельник недели выбранного дня.
  const monday = new Date(selectedDate);
  const dow = (monday.getDay() + 6) % 7; // 0 = Пн
  monday.setDate(monday.getDate() - dow);

  const strip = h('<div class="week-strip"></div>');
  for (let i = 0; i < 6; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const isSel = d.toDateString() === selectedDate.toDateString();
    const off = !isEnabled(d);
    const cell = h(`
      <button class="day-cell${isSel ? ' day-cell--sel' : ''}${off ? ' day-cell--off' : ''}"${off ? ' disabled' : ''}>
        <span class="day-cell__num">${d.getDate()}</span>
        <span class="day-cell__dow">${WEEKDAYS_SHORT[d.getDay()]}</span>
      </button>
    `);
    if (!off) cell.addEventListener('click', () => onSelect(new Date(d)));
    strip.appendChild(cell);
  }
  return strip;
}

// Заголовок дня: ‹ «Среда, 16 июня» ›. onPrev/onNext листают день.
export function dayNav(selectedDate, onPrev, onNext) {
  const title = `${WEEKDAYS_FULL[selectedDate.getDay()]}, ${selectedDate.getDate()} ${MONTHS_GENITIVE[selectedDate.getMonth()]}`;
  const nav = h(`
    <div class="day-nav">
      <button class="day-nav__arrow" aria-label="Предыдущий день">‹</button>
      <span class="day-nav__title">${esc(title)}</span>
      <button class="day-nav__arrow" aria-label="Следующий день">›</button>
    </div>
  `);
  const [prev, , next] = nav.children;
  prev.addEventListener('click', onPrev);
  next.addEventListener('click', onNext);
  return nav;
}

// Текст счётчика пар. Для сегодня — динамика, иначе общее число.
export function counterText(lessons, isToday, now = new Date()) {
  const n = lessons.length;
  if (!n) return '';
  const pairWord = (k) => plural(k, ['пара', 'пары', 'пар']);
  if (!isToday) return `${n} ${pairWord(n)}`;

  const atTime = (hhmm) => {
    const [hh, mm] = hhmm.split(':').map(Number);
    const d = new Date(now);
    d.setHours(hh, mm, 0, 0);
    return d;
  };
  const sorted = [...lessons].sort((a, b) => a.start.localeCompare(b.start));
  const firstStart = atTime(sorted[0].start);
  const lastEnd = atTime(sorted[sorted.length - 1].end);

  if (now < firstStart) return `сегодня ${n} ${pairWord(n)}`;
  if (now > lastEnd) return 'пары закончились';

  const remaining = sorted.filter((l) => atTime(l.end) > now).length;
  const next = sorted.find((l) => atTime(l.start) > now);
  const parts = [`осталось ${remaining} ${pairWord(remaining)}`];
  if (next) {
    const mins = Math.max(1, Math.round((atTime(next.start) - now) / 60000));
    parts.push(`следующая через ${mins} мин`);
  }
  return parts.join(' · ');
}

// Бейдж погоды: иконка состояния + температура. weather = { code, temp }.
export function weatherBadge(weather) {
  if (!weather) return null;
  const icon = WEATHER_ICONS[weather.code] || '';
  const temp = Number.isFinite(weather.temp) ? `${weather.temp > 0 ? '+' : ''}${weather.temp}°` : '';
  return h(`<div class="weather"><span class="weather__icon">${icon}</span><span class="weather__temp">${esc(temp)}</span></div>`);
}

// Контент bottom sheet'а деталей пары (без обёртки sheet).
export function lessonDetail(lesson) {
  const { label, kind } = lessonTypeInfo(lesson.lessontype);
  const rows = [];
  const dur = '90 мин';
  rows.push(['Время', `${lesson.start} — ${lesson.end} (${dur})`]);
  if (lesson.room) rows.push(['Аудитория', lesson.room]);
  if (lesson.teacher) rows.push(['Преподаватель', lesson.teacher]);
  const groupBits = [
    lesson.flow && `поток ${lesson.flow}`,
    lesson.group && `группа ${lesson.group}`,
    lesson.subgroup && `подгруппа ${lesson.subgroup}`,
  ].filter(Boolean).join(', ');
  if (groupBits) rows.push(['Группа', groupBits]);

  const wrap = h(`
    <div class="detail">
      <div class="detail__title">${esc(lesson.subject)}</div>
      <div class="detail__badge-row"><span class="badge badge--${kind} badge--solid">${esc(label)}</span></div>
      <div class="detail__rows"></div>
    </div>
  `);
  const rowsEl = wrap.querySelector('.detail__rows');
  for (const [k, v] of rows) {
    rowsEl.appendChild(h(`
      <div class="detail__row">
        <span class="detail__dot"></span>
        <div><div class="detail__k">${esc(k)}</div><div class="detail__v">${esc(v)}</div></div>
      </div>
    `));
  }
  return wrap;
}
