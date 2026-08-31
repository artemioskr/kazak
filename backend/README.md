# FishCast backend

PHP 8.3 (без фреймворка и composer — ноль зависимостей), PostgreSQL 16, Caddy
(авто-HTTPS + раздаёт фронтенд), docker compose. Крон тянет гидрологию
Нижнекамской ГЭС — поэтому VPS должен быть с **российским IP**
(rushydro.ru гео-блокирует зарубежные адреса, см. CLAUDE.md).

## Развёртывание (Ubuntu 22.04/24.04)

1. Купи VPS (Timeweb Cloud / Beget, 1 vCPU / 2 ГБ, локация РФ) и домен,
   направь A-запись домена на IP VPS.
2. Создай бота у @BotFather (для входа через Telegram), командой
   `/setdomain` привяжи свой домен.
3. На VPS:

       git clone https://github.com/artemioskr/kazak.git
       cd kazak/backend
       sudo bash install.sh          # создаст .env и попросит его заполнить
       nano .env                     # APP_DOMAIN=твой.домен, TELEGRAM_BOT_TOKEN=...
       sudo bash install.sh          # соберёт, запустит, применит миграции

4. Проверка: `https://твой.домен/api/health` → `{"ok":true,"db":true}`.
   Фронтенд открывается прямо на домене (Caddy раздаёт корень репозитория).
5. Чтобы фронт на GitHub Pages ходил в этот API: в `js/config.js` пропиши
   `apiBase: 'https://твой.домен'` (Pages-домен уже разрешён в CORS_ORIGINS).

## Что внутри

- `public/index.php` — все маршруты API:
  - `GET  /api/health` — живость;
  - `POST /api/auth/telegram` — вход (проверка подписи Telegram Login Widget), выдаёт токен;
  - `GET/PUT /api/state` — синк точек и журнала (последняя запись побеждает);
  - `GET  /api/weather?lat=&lon=` — кэширующий прокси Open-Meteo (TTL 30 мин);
  - `GET  /api/hydro` — уровни/сброс Нижнекамской по дням.
- `bin/fetch-hydro.php` — крон-парсер РусГидро (раз в час). Парсер эвристический:
  при первом запуске на VPS проверь вывод; если числа не распознались — сырой
  HTML лежит в /tmp/hydro-raw.html внутри контейнера cron, поправь регэкспы.
- `bin/migrate.php` — накатывает новые `sql/*.sql`.
- Токены — HMAC-подписанный JSON (90 дней), без внешних JWT-библиотек.

## Обновление

    git pull && cd backend && docker compose up -d --build \
      && docker compose exec -T php php /backend/bin/migrate.php

## Бэкапы

    docker compose exec -T db pg_dump -U fishcast fishcast | gzip > backup-$(date +%F).sql.gz

Положи в крон хоста раз в сутки и утаскивай файл с VPS куда-нибудь ещё.
