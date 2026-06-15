// Рендереры расписания. Одна модель (lesson) — три вида (block/compact/ribbon).
// Здесь только презентация; загрузка/навигация/состояние — в screens.js.

import {
  LECTURE_TYPES, WEATHER_ICONS, WEEKDAYS_SHORT, WEEKDAYS_FULL, MONTHS_GENITIVE,
} from './constants.js?v=30';

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
// В режиме просмотра расписания преподавателя — вместо ФИО показываем группу
// и курс (полезная инфа: «кому он читает» вместо самого себя).
function metaLine(lesson, viewMode = 'group') {
  if (viewMode === 'teacher') {
    const audience = teacherAudience(lesson);
    return [audience, lesson.room ? `ауд. ${lesson.room}` : '']
      .filter(Boolean).join(' · ');
  }
  return [lesson.teacher, lesson.room ? `ауд. ${lesson.room}` : '']
    .filter(Boolean).join(' · ');
}

// «Кому читает» в расписании преподавателя: курс + поток/группа.
// Поле flow упстрим отдаёт как «1-Б-О ИАИ-ИФ-И-ИК» (код потока), group обычно '-'.
function teacherAudience(lesson) {
  const parts = [];
  if (lesson.course) parts.push(`${lesson.course} курс`);
  if (lesson.flow) parts.push(lesson.flow);
  else if (lesson.group) parts.push(lesson.group);
  return parts.join(' · ');
}

// =========================================================
// renderLesson(lesson, layout) — одна пара под выбранный вид
// =========================================================
export function renderLesson(lesson, layout, viewMode = 'group') {
  if (layout === 'compact') return renderCompact(lesson, viewMode);
  if (layout === 'ribbon') return renderRibbon(lesson, viewMode);
  return renderBlock(lesson, viewMode);
}

// Блочный (дефолт): карточка с цветной левой полосой и бейджем типа.
function renderBlock(lesson, viewMode) {
  const { label, kind } = lessonTypeInfo(lesson.lessontype);
  const meta = metaLine(lesson, viewMode);
  const card = h(`
    <button class="lesson lesson--block kind-${kind}">
      <div class="lesson__time">${lesson.pair ? `${lesson.pair}-я пара · ` : ''}${esc(lesson.start)} — ${esc(lesson.end)}</div>
      <div class="lesson__title">${esc(lesson.subject)}</div>
      <div class="lesson__badge-row"><span class="badge badge--${kind}">${esc(label)}</span></div>
      ${meta ? `<div class="lesson__meta">${esc(meta)}</div>` : ''}
    </button>
  `);
  return card;
}

// Компактный: точка(тип) + время + название + аудитория (или группа в teacher-view).
function renderCompact(lesson, viewMode) {
  const { kind } = lessonTypeInfo(lesson.lessontype);
  const right = viewMode === 'teacher' ? teacherAudience(lesson) : lesson.room;
  const row = h(`
    <button class="lesson lesson--compact kind-${kind}">
      <span class="dot dot--${kind}"></span>
      <span class="lesson__c-time">${esc(lesson.start)}</span>
      <span class="lesson__c-title">${esc(lesson.subject)}</span>
      <span class="lesson__c-room">${esc(right || '')}</span>
    </button>
  `);
  return row;
}

// Ленточный: время на оси слева + карточка с цветной полосой.
function renderRibbon(lesson, viewMode) {
  const { label, kind } = lessonTypeInfo(lesson.lessontype);
  const audienceOrTeacher = viewMode === 'teacher' ? teacherAudience(lesson) : lesson.teacher;
  const meta = [label.toLowerCase(), audienceOrTeacher, lesson.room].filter(Boolean).join(' · ');
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

// Горизонтально прокручиваемая полоска всех дней загруженного диапазона.
// onSelect(Date). days — массив Date.
// opts: { hasLessons(d), dimEmpty }
//  - сегодня → акцентный жёлтый;
//  - выбранный → фиолетовый кружок, лента сразу центрируется на нём
//    (без анимации: draw() пересоздаёт DOM при каждой смене дня, анимация
//    «от scrollLeft=0 до выбранного» выглядит как длинный скролл от начала);
//  - пустой день (без пар) + dimEmpty → приглушаем.
export function weekStrip(days, selectedDate, onSelect, opts = {}) {
  const { hasLessons = () => true, dimEmpty = true, inRange = null, weekly = false } = opts;
  const today = new Date(); today.setHours(0, 0, 0, 0);

  const strip = h(`<div class="week-strip${weekly ? ' week-strip--weekly' : ''}"></div>`);
  let selectedCell = null;
  // В недельном виде 7 дней текущей недели оборачиваем в один контейнер-pill —
  // получается общая скруглённая плашка за всеми днями (вместо отдельных кружков).
  let pill = null;
  for (const d of days) {
    const isSel = d.toDateString() === selectedDate.toDateString();
    const isToday = d.toDateString() === today.toDateString();
    const empty = dimEmpty && !hasLessons(d);
    const inWeek = inRange ? inRange(d) : false;
    const cls = [
      'day-cell',
      isToday ? 'day-cell--today' : '',
      isSel ? 'day-cell--sel' : '',
      inWeek && !isSel ? 'day-cell--in-range' : '',
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
    if (weekly && inWeek) {
      if (!pill) { pill = h('<div class="week-strip__pill"></div>'); strip.appendChild(pill); }
      pill.appendChild(cell);
    } else {
      strip.appendChild(cell);
    }
  }

  // Центрируем мгновенно. В недельном режиме целимся в pill целиком (selected =
  // понедельник новой недели, центрирование по нему «выкидывало» pill вправо).
  // В режиме «по дням» — по-прежнему выбранный день.
  const centerTarget = (weekly && pill) ? pill : selectedCell;
  if (centerTarget) {
    requestAnimationFrame(() => {
      const cr = centerTarget.getBoundingClientRect();
      const sr = strip.getBoundingClientRect();
      const left = strip.scrollLeft + (cr.left - sr.left) - (strip.clientWidth - cr.width) / 2;
      strip.scrollLeft = Math.max(0, left);
    });
  }
  return strip;
}

// Понедельник недели, в которую попадает date.
export function weekMonday(date) {
  const m = new Date(date);
  m.setHours(0, 0, 0, 0);
  const dow = (m.getDay() + 6) % 7; // 0 = Пн
  m.setDate(m.getDate() - dow);
  return m;
}

// Заголовок недели: ‹ «16–22 июня» ›. Месяц склеивается, если разные.
export function weekNav(monday, onPrev, onNext) {
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const sameMonth = monday.getMonth() === sunday.getMonth();
  const title = sameMonth
    ? `${monday.getDate()}–${sunday.getDate()} ${MONTHS_GENITIVE[monday.getMonth()]}`
    : `${monday.getDate()} ${MONTHS_GENITIVE[monday.getMonth()]} – ${sunday.getDate()} ${MONTHS_GENITIVE[sunday.getMonth()]}`;
  const nav = h(`
    <div class="day-nav">
      <button class="day-nav__arrow" aria-label="Предыдущая неделя">‹</button>
      <span class="day-nav__title">${esc(title)}</span>
      <button class="day-nav__arrow" aria-label="Следующая неделя">›</button>
    </div>
  `);
  const [prev, , next] = nav.children;
  prev.addEventListener('click', onPrev);
  next.addEventListener('click', onNext);
  return nav;
}

// Заголовок дня в недельном виде: «Понедельник, 16 июня» (+ опц. погода справа).
// weather = { code, temp } из weatherForDate; если null — справа ничего.
export function weekDayHeader(date, isToday, weather = null) {
  const title = `${WEEKDAYS_FULL[date.getDay()]}, ${date.getDate()} ${MONTHS_GENITIVE[date.getMonth()]}`;
  const cls = isToday ? 'week-day__head week-day__head--today' : 'week-day__head';
  const head = h(`<div class="${cls}"><span class="week-day__title">${esc(title)}</span></div>`);
  if (weather) {
    const badge = weatherBadge(weather);
    if (badge) head.appendChild(badge);
  }
  return head;
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

// Ищет погоду на конкретный день в forecast.days. Возвращает {code,temp} или
// null (день за пределами 16-дневного прогноза или forecast отсутствует).
export function weatherForDate(forecast, date) {
  if (!forecast || !Array.isArray(forecast.days)) return null;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const key = `${yyyy}-${mm}-${dd}`;
  return forecast.days.find((d) => d.date === key) || null;
}

// «ДД.ММ.ГГГГ» + слот → человекочитаемая дата «16 июня, 09:00».
function humanDate(dateKey, start) {
  const [d, m] = dateKey.split('.').map(Number);
  return `${d} ${MONTHS_GENITIVE[m - 1]}${start ? `, ${start}` : ''}`;
}

// Контент bottom sheet'а деталей пары (без обёртки sheet).
// stats (опц.) — сводка «по предмету», см. screens.subjectStats().
export function lessonDetail(lesson, stats, viewMode = 'group') {
  const { label, kind } = lessonTypeInfo(lesson.lessontype);
  const rows = [];
  const dur = '90 мин';
  rows.push(['Время', `${lesson.start} — ${lesson.end} (${dur})`]);
  if (lesson.room) rows.push(['Аудитория', lesson.room]);
  // В режиме преподавателя строку «Преподаватель» убираем (это и так он сам),
  // а «Группа» делаем первичной — показываем курс + поток + группа + подгруппа.
  if (viewMode !== 'teacher' && lesson.teacher) {
    rows.push(['Преподаватель', lesson.teacher]);
  }
  const groupBits = [
    viewMode === 'teacher' && lesson.course ? `${lesson.course} курс` : '',
    lesson.flow && `поток ${lesson.flow}`,
    lesson.group && `группа ${lesson.group}`,
    lesson.subgroup && `подгруппа ${lesson.subgroup}`,
  ].filter(Boolean).join(', ');
  if (groupBits) rows.push([viewMode === 'teacher' ? 'Для кого' : 'Группа', groupBits]);

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
    const np = (n, forms) => `${n} ${plural(n, forms)}`;
    if (stats.viewedIsExam) {
      // Просматриваем экзамен. Дата/время экзамена дублирует «Время» выше —
      // не повторяем; вместо «следующей пары» — сколько занятий ещё впереди.
      if (stats.lessonsBeforeExam > 0) {
        lines.push(['До экзамена осталось',
          np(stats.lessonsBeforeExam, ['занятие', 'занятия', 'занятий'])]);
      }
    } else {
      if (stats.next) {
        lines.push(['Следующая пара', humanDate(stats.next.dateKey, stats.next.start)]);
      } else if (stats.isLast) {
        lines.push(['Следующая пара', 'это последняя пара по предмету']);
      }
    }
    if (stats.remaining > 0) {
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
    // Дата экзамена — только если просматриваем не сам экзамен.
    if (stats.exam && !stats.viewedIsExam) {
      lines.push(['Экзамен', humanDate(stats.exam.dateKey, stats.exam.start)]);
    }

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
