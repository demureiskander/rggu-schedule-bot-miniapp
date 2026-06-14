// Тайм-слоты пар (НЕ из API). Индекс = номер пары - 1.
export const TIME_SLOTS = [
  { start: '08:45', end: '10:05' }, // 1
  { start: '10:15', end: '11:35' }, // 2
  { start: '12:10', end: '13:30' }, // 3
  { start: '13:40', end: '15:00' }, // 4
  { start: '15:35', end: '16:55' }, // 5
  { start: '17:05', end: '18:25' }, // 6
  { start: '18:50', end: '20:10' }, // 7
  { start: '20:20', end: '21:40' }, // 8
];

// Человекочитаемые названия типов пар.
export const LECTURE_TYPES = {
  'лек': 'Лекция',
  'сем': 'Семинар',
  'экзамен': 'Экзамен',
  'спец': 'Спецкурс',
};

// Краткие бейджи для блочного вида.
export const LECTURE_BADGES = {
  'лек': 'ЛЕКЦИЯ',
  'сем': 'СЕМИНАР',
  'экзамен': 'ЭКЗАМЕН',
  'спец': 'СПЕЦКУРС',
};

// Коды форм обучения официального API (id -> код).
export const GROUP_FORMS = {
  '1': '1-Б-З', '2': '1-Б-ЗДОТ', '3': '1-Б-О', '4': '1-Б-ОЗ',
  '5': '1-М-З', '6': '1-М-ЗДОТ', '7': '1-М-О', '8': '1-М-ОЗ',
  '9': '2-Б-З', '10': '2-Б-ЗДОТ', '11': '2-Б-ОЗ', '12': '1-М-ОЗДОТ',
};

// Части кода формы -> человекочитаемые куски.
const FORM_LEVEL = { '1': '', '2': 'Второе высшее' };
const FORM_DEGREE = { 'Б': 'Бакалавриат', 'М': 'Магистратура' };
const FORM_MODE = {
  'О': 'очная',
  'ОЗ': 'очно-заочная',
  'З': 'заочная',
  'ЗДОТ': 'дистанционная',
  'ОЗДОТ': 'очно-заочная дистанционная',
};

// Разбирает код вида "1-Б-О" в человекочитаемую строку: "Бак / спец, очная".
export function formatFormCode(code) {
  const [level, degree, mode] = code.split('-');
  const parts = [];
  if (FORM_LEVEL[level]) parts.push(FORM_LEVEL[level]);
  if (FORM_DEGREE[degree]) parts.push(FORM_DEGREE[degree]);
  if (FORM_MODE[mode]) parts.push(FORM_MODE[mode]);
  const str = parts.join(', ');
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Список форм для экрана выбора: { id, code, label }.
export function formOptions() {
  return Object.entries(GROUP_FORMS).map(([id, code]) => ({
    id,
    code,
    label: formatFormCode(code),
  }));
}

// Курсы для выбора.
export const COURSES = [1, 2, 3, 4, 5, 6];

// Словарь институтов: аббревиатура (name.split('-')[0]) → полное название.
// Нерасшифрованные аббревиатуры показываем как есть (фолбэк), см. instituteName().
export const INSTITUTES = {
  ИАИ:    'Историко-архивный институт',
  ИЭУП:   'Институт экономики, управления и права',
  ИСЭН:   'Институт социально-экономических наук',
  ИП:     'Институт психологии им. Л.С. Выготского',
  ФИИ:    'Факультет истории искусства',
  ИФИ:    'Институт филологии и истории',
  ФРиСО:  'Факультет маркетинга и рекламы',
  ФРИСО:  'Факультет маркетинга и рекламы',
  ИПр:    'Институт правоведения',
  ФК:     'Факультет культурологии',
  ИЛ:     'Институт лингвистики',
  ИВКА:   'Институт восточных культур и античности',
  ИИНиТБ: 'Институт информационных наук и технологий безопасности',
  СФ:     'Социологический факультет',
  ФФ:     'Философский факультет',
  ИМОиПН: 'Институт международных отношений и политических наук',
  ИИРиДК: 'Институт истории религий и духовной культуры',
  ОИСвГС: 'Отделение интеллектуальных систем в гуманитарной сфере',
};

// Аббревиатура института из кода группы (name = "ИАИ-ФАД-ДА-... (Группа: 1)").
export function instituteAbbr(name) {
  return (name || '').split('-')[0] || '—';
}

// Полное название института или сама аббревиатура (фолбэк) + флаг расшифровки.
export function instituteName(abbr) {
  const resolved = Object.prototype.hasOwnProperty.call(INSTITUTES, abbr);
  return { name: resolved ? INSTITUTES[abbr] : abbr, resolved };
}

// Направление и профиль из details ("Направление › Профиль").
export function splitDetails(details) {
  const [direction = '', profile = ''] = (details || '').split(' › ');
  return { direction: direction.trim(), profile: profile.trim() };
}

// Дерево из плоского списка групп: институт → направление → [группы].
// Институты слиты по полному названию (ФРиСО/ФРИСО → одна ветка), отсортированы
// по алфавиту названия; нерасшифрованные (фолбэк) — в конце.
export function buildTree(flows) {
  const byInst = new Map(); // displayName -> { name, resolved, dirs: Map(dir -> flows[]) }
  for (const f of flows) {
    const { name, resolved } = instituteName(instituteAbbr(f.name));
    if (!byInst.has(name)) byInst.set(name, { name, resolved, dirs: new Map() });
    const inst = byInst.get(name);
    const { direction } = splitDetails(f.details);
    const dir = direction || 'Без направления';
    if (!inst.dirs.has(dir)) inst.dirs.set(dir, []);
    inst.dirs.get(dir).push(f);
  }
  return [...byInst.values()].sort((a, b) => {
    if (a.resolved !== b.resolved) return a.resolved ? -1 : 1;
    return a.name.localeCompare(b.name, 'ru');
  });
}

// Дни недели (короткие) для полоски дней и заголовков.
export const WEEKDAYS_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
export const WEEKDAYS_FULL = [
  'Воскресенье', 'Понедельник', 'Вторник', 'Среда',
  'Четверг', 'Пятница', 'Суббота',
];
export const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

// Погода: код состояния -> эмодзи-иконка (до подключения SVG-спрайтов).
export const WEATHER_ICONS = {
  clear: '☀️',
  clouds: '☁️',
  rain: '🌧️',
  snow: '❄️',
  fog: '🌫️',
  storm: '⛈️',
};

// Маскот: состояние -> файл спрайта.
export const MASCOT = {
  wave: 'public/mascot/wave.webp',
  sleep: 'public/mascot/sleep.webp',
  sad: 'public/mascot/sad.webp',
  think: 'public/mascot/think.webp',
};
