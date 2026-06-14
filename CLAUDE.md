# РсухСпейсЭп — Telegram Mini App расписания РГГУ

## Что за проект
Telegram Mini App для просмотра расписания студентов РГГУ. Часть экосистемы бота
`@RsuhSpaceBot` (~1300+ пользователей). Открывается по кнопке WebApp внутри бота.
Это **альтернатива** текстовому интерфейсу бота, не замена. Своей БД нет — данные
тянутся из официального API РГГУ через прокси-эндпоинты бота.

- **Фронт:** статика на GitHub Pages (корень репо + `src/`).
- **Бэкенд:** standalone Node-прокси в `server/` этого же репо — **отдельный
  Railway-сервис** (root directory = `server/`), независимый от бота. Бот может
  лежать/передеплоиваться — Mini App работает. Прокси: форвардит API РГГУ (CORS)
  + кэширует погоду Москвы из open-meteo (без ключа). Та же модель, что у
  rsuh.space (фронт + standalone прокси), только прокси на Railway.
- Референс по контракту (НЕ форкать): https://github.com/rsuhspace/rsuh.space (Vue 3).

### Upstream-контракт API РГГУ (кухня прокси, сверено с референсом)
- `Get_Flows_List` (POST multipart): поле `0` = JSON `{ eduform, course }`.
  Ответ `[{ id, data, direction, profile }]` → `{ id, name:data, details:"dir › prof" }`.
- `Get_Schedule_Table` (POST multipart): `eduform`, `course`, `flow`,
  `intervalMode=4`, `menuMode=flow`. Ответ уже в форме §4.2.
- ⚠️ **`eduform` = числовой id формы ('1'..'12'), НЕ код '1-Б-О'.** ТЗ §4.1 пишет
  `form=<код>`, но рабочий референс шлёт id. Поэтому: прокси форвардит `form`→`eduform`
  как есть; фронт в picker'е сохраняет и шлёт **числовой id** формы (код '1-Б-О'
  используется только как человекочитаемая подпись через `formatFormCode`).

## Стек
Vanilla HTML/CSS/JS, без фреймворка. Telegram WebApp SDK. Одна страница расписания.

## Структура файлов
```
server/index.js   — standalone прокси (Node http): /api/flows|schedule|weather + CORS
server/package.json, server/.env.example (API_URL, PORT, ALLOW_ORIGIN)
public/mascot/{wave,sleep,sad,think}.png  — спрайты маскота (предоставит заказчик)
public/favicon.svg, manifest.webmanifest
src/api.js        — слой запросов к эндпоинтам бота
src/store.js      — состояние + persistence (CloudStorage → localStorage)
src/constants.js  — тайм-слоты, формы обучения, типы пар
src/render.js     — рендереры расписания: renderLesson(lesson, layout), шапка, счётчик, погода
src/screens.js    — экраны: welcome / picker / schedule + bottom sheets (детали, настройки)
src/telegram.js   — обёртка Telegram WebApp SDK
src/theme.js      — applyTheme / resolveInitialTheme (без window-глобалов)
config.js         — API_BASE = https://<домен-прокси>/api
index.html, styles.css
```

## Контракт API (бот отдаёт нормализованный JSON)
- `GET /api/flows?form=<код>&course=<n>` →
  `[{ "id", "name": "ИФИ-2Б", "details": "Направление › Профиль" }]`
- `GET /api/schedule?flow=<id>&form=<код>&course=<n>` →
  `{ "item": "ИФИ-2Б", "tblData": [{ "date": "16.06.2026 Ср",
    "pairs": [{ "pair": 1, "flows": [{ "flow","group","course","lessontype",
    "room","subgroup","subject","teacher" }] }] }] }`
  - `date` = `"ДД.ММ.ГГГГ Деньнедели"`; `pair` = слот 1–8.
  - `lessontype`: `лек | сем | экзамен | спец | прочее`.
  - Время пар НЕ из API — берётся из `TIME_SLOTS` (constants.js).
  - `room: "-"` → показываем пусто, не дефис.
- `GET /api/weather` → `{ "date":"ГГГГ-ММ-ДД", "code":"clear|clouds|rain|snow|fog|storm", "temp":18 }`
  - Источник — open-meteo (Москва 55.75,37.62), без ключа, кэш в памяти на сутки.
  - Маппинг WMO weather_code → code в `server/index.js` (mapWeatherCode).
  - Опционально. Упал запрос → просто не показываем.

## Дизайн-токены (финальная палитра Hi-Fi эталона)
Шрифт: **Onest** (Google Fonts), fallback `system-ui, -apple-system, BlinkMacSystemFont, sans-serif`.
Тёмная тема — основная:
```
--bg:#0E0B18  --surface(карточки):#17132A  --surface-2(sheet):#201A38
--border:rgba(255,255,255,.07)  --text:#F1EEFA  --text-muted:#9D98B5  --text-dim:#6A6582
--primary(акцент/CTA):#7C6CF7  --selected:rgba(124,108,247,.15)
--amber(CTA-аксессор/бейдж лекции):#F59E0B  --seminar(контур):#7C6CF7
```
Светлая: --bg:#F6F4FB --surface:#FFFFFF --border:#ECE8F5 --text:#1A1530 --primary:#5A43E0, amber тот же.
Уважать `Telegram.WebApp.themeParams`. Spacing/radius/shadows — в `styles.css`.
Spacing: 4·8·12·16·20·24·32·40. Radius: 8 карточки · 12 кнопки · 16 модалки · 50% аватары.
Shadows: soft `0 2px 8px rgba(20,8,63,.10)`, mid `0 4px 16px rgba(20,8,63,.15)`.
Z: content 0 · header 10 · sheet 100 · overlay 200. Мин. кликабельный элемент 44px.
Заголовки 20–24 semibold · body 14–15 · caption 11–12.

## Ключевые решения
- Дефолтный вид — **Блочный**. Переключатель 3 видов в настройках:
  Блочный / Компактный / Ленточный.
- Один рендерер `renderLesson(lesson, layout)` — три вида работают с одними
  данными, отличается только разметка одной пары. Шапка навигации, состояния
  загрузки/пустоты/ошибки — общие, НЕ дублировать.
- Расписание грузится один раз (диапазон на недели), кладётся в объект по датам;
  листание дней — без новых запросов.
- Persistence: Telegram `CloudStorage` → fallback `localStorage`. Хранится
  `group`, `layout` (деф. `block`), `theme` (деф. `dark`), `weatherEnabled` (деф. `false`).
- Расписание кэшируется в памяти на сессию; инвалидация после ~22:30 МСК.
- Детали пары и настройки — bottom sheet (общий паттерн).
- Счётчик «осталось пар» — только для сегодня, тикер раз в минуту из `TIME_SLOTS`.

## UX-философия владельца
Тёплый человеческий тон. Никаких «Ошибка»/«Неверный формат». Каждый шаг даёт
обратную связь. Ошибка всегда с выходом (что делать дальше). Минимум трений.
Маскот — «душа» приложения, появляется в ожидании/пустоте/ошибке.

## Как работать с владельцем (Iskender, @demureuser, GitHub demureiskander)
- Прямой лаконичный стиль на русском.
- Перед изменениями объяснять что и зачем; сначала список улучшений, потом —
  после подтверждения — реализация.
- Код-ревью по частям (1/3, 2/3, 3/3), ошибки исправляем по одной.
- Готовые bash-команды для copy-paste.
- git commit/push — отдельным блоком в конце, ТОЛЬКО по команде.

## Объём
MVP: welcome → выбор группы (форма→курс→поиск) → расписание (день, 3 вида),
детали пары, счётчик пар, погода (опц.), пустой/загрузка/ошибка с маскотом,
тёмная+светлая тема, persistence.
v2: недельный вид, поиск по препод./аудитории, экспорт .ics, оффлайн (PWA).
