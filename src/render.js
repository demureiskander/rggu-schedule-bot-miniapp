// Рендереры расписания. Одна модель (lesson) — три вида (block/compact/ribbon).
// Здесь только презентация; загрузка/навигация/состояние — в screens.js.

import {
  LECTURE_TYPES, WEATHER_ICONS, WEEKDAYS_SHORT, WEEKDAYS_FULL, MONTHS_GENITIVE,
} from './constants.js?v=9';

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
  const isLec = t.includes('лек');
  const isSem = t.includes('сем');
  const label = LECTURE_TYPES[t] || (type ? type[0].toUpperCase() + type.slice(1) : 'Занятие');
  if (isLec && isSem) return { label: 'Лекция-семинар', kind: 'lecture-seminar' };
  if (isLec) return { label, kind: 'lecture' };
  if (isSem) return { label, kind: 'seminar' };
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
      <div class="lesson__time">${lesson.pair ? `${lesson.pair}-я пара · ` : ''}${esc(lesson.start)} — ${esc(lesson.end)}</div>
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

// Горизонтально прокручиваемая полоска всех дней загруженного диапазона
// (обычно весь семестр). onSelect(Date). days — массив Date (весь schedule.dates).
// opts: { hasLessons(d), dimEmpty, scrollBehavior }
//  - сегодня → акцентный жёлтый;
//  - выбранный → фиолетовый кружок, полоска центрируется на нём
//    (scrollBehavior: 'auto' при первой отрисовке, 'smooth' при навигации);
//  - пустой день (без пар) + dimEmpty → приглушаем.
export function weekStrip(days, selectedDate, onSelect, opts = {}) {
  const { hasLessons = () => true, dimEmpty = true, scrollBehavior = 'auto' } = opts;
  const today = new Date(); today.setHours(0, 0, 0, 0);

  const strip = h('<div class="week-strip"></div>');
  let selectedCell = null;
  for (const d of days) {
    const isSel = d.toDateString() === selectedDate.toDateString();
    const isToday = d.toDateString() === today.toDateString();
    const empty = dimEmpty && !hasLessons(d);
    const cls = [
      'day-cell',
      isToday ? 'day-cell--today' : '',
      isSel ? 'day-cell--sel' : '',
      empty ? 'day-cell--empty' : '',
    ].filter(Boolean).join(' ');
    const cell = h(`
      <button class="${cls}">
        <span class="day-cell__num">${d.getDate()}</span>
        <span class="day-cell__dow">${WEEKDAYS_SHORT[d.getDay()]}</span>
      </button>
    `);
    cell.addEventListener('click', () => onSelect(new Date(d)));
    if (isSel) selectedCell = cell;
    strip.appendChild(cell);
  }

  if (selectedCell) {
    requestAnimationFrame(() => {
      selectedCell.scrollIntoView({ behavior: scrollBehavior, inline: 'center', block: 'nearest' });
    });
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

// «ДД.ММ.ГГГГ» + слот → человекочитаемая дата «16 июня, 09:00».
function humanDate(dateKey, start) {
  const [d, m] = dateKey.split('.').map(Number);
  return `${d} ${MONTHS_GENITIVE[m - 1]}${start ? `, ${start}` : ''}`;
}

// Контент bottom sheet'а деталей пары (без обёртки sheet).
// stats (опц.) — сводка «по предмету», см. screens.subjectStats().
export function lessonDetail(lesson, stats) {
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

  // Блок «по этому предмету» (до конца семестра, из загруженного расписания).
  if (stats) {
    const lines = [];
    if (stats.next) lines.push(['Следующая пара', humanDate(stats.next.dateKey, stats.next.start)]);
    if (stats.remaining > 0) {
      const np = (n, forms) => `${n} ${plural(n, forms)}`;
      const items = [
        ['лекций', stats.lectures],
        ['семинаров', stats.seminars],
      ];
      if (stats.combo > 0) items.push(['лек/семов', stats.combo]);
      const breakdown = `<ul class="detail__breakdown">${items.map(([name, n]) => `<li>${esc(name)} — ${n > 0 ? n : 'нет'}</li>`).join('')}</ul>`;
      lines.push(['Осталось до конца семестра', `${np(stats.remaining, ['пара', 'пары', 'пар'])}:`, breakdown]);
      if (stats.other > 0) {
        lines.push(['Спецкурсы и прочее', np(stats.other, ['пара', 'пары', 'пар'])]);
      }
    }
    if (stats.exam) lines.push(['Экзамен', humanDate(stats.exam.dateKey, stats.exam.start)]);

    if (lines.length) {
      const sec = h(`
        <div class="detail__section">
          <div class="detail__section-title">По этому предмету</div>
          <div class="detail__rows"></div>
        </div>
      `);
      const secRows = sec.querySelector('.detail__rows');
      for (const [k, v, extra] of lines) {
        secRows.appendChild(h(`
          <div class="detail__row">
            <span class="detail__dot detail__dot--amber"></span>
            <div><div class="detail__k">${esc(k)}</div><div class="detail__v">${esc(v)}</div>${extra || ''}</div>
          </div>
        `));
      }
      wrap.appendChild(sec);
    }
  }

  return wrap;
}
