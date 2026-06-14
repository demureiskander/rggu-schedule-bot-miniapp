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
const FORM_DEGREE = { 'Б': 'Бак / спец', 'М': 'Магистратура' };
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
