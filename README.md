# РсухСпейс — Telegram Mini App расписания РГГУ

Веб-приложение внутри Telegram для просмотра расписания студентов РГГУ.
Часть экосистемы бота [`@RsuhSpaceBot`](https://t.me/RsuhSpaceBot).

- **Фронт:** vanilla HTML/CSS/JS, статика на GitHub Pages.
- **Бэкенд:** standalone Node-прокси в [`server/`](server/) — отдельный Railway-сервис,
  независимый от бота. `/api/flows`, `/api/schedule`, `/api/weather`. Свою БД не держим.

Подробный контекст — в [CLAUDE.md](CLAUDE.md).

## Настройка перед деплоем

1. **Домен прокси.** В [config.js](config.js) заменить плейсхолдер
   `https://CHANGE_ME.up.railway.app/api` на реальный домен прокси (см. деплой).
2. **`API_URL` прокси.** В `server/` задать env `API_URL` = upstream базы API РГГУ
   (заказчик берёт из кода бота). Шаблон — [server/.env.example](server/.env.example).
3. **Спрайты маскота.** Положить PNG/SVG в `public/mascot/`:
   `wave.png` (машет), `sleep.png` (спит), `sad.png` (грустный),
   `think.png` (думает). Сейчас там пустые плейсхолдеры.

## Локальный запуск

**Прокси** (Node ≥ 18):

```bash
cd server
cp .env.example .env   # вписать API_URL
npm start              # слушает :3000
```

`/api/weather` и health-check `/` работают и без `API_URL` (погода из open-meteo).

**Фронт** — ES-модули требуют HTTP (не `file://`):

```bash
python3 -m http.server 8000
# открыть http://localhost:8000
```

Вне Telegram SDK-вызовы безопасно деградируют (CloudStorage → localStorage,
BackButton/Haptic — no-op).

## Деплой

1. **Прокси:** деплой папки `server/` отдельным Railway-сервисом
   (root directory = `server/`), env `API_URL`. Публичный домен сервиса → это
   `API_BASE` фронта (`https://<домен>.up.railway.app/api`).
2. **Фронт:** GitHub Pages, ветка `main` (или `gh-pages`). Прописать `API_BASE` из шага 1.
3. **Бот:** в `@BotFather` Mini App URL = адрес Pages + кнопка `WebAppInfo(url=...)`.
