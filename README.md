# FishCast

Прогноз активности рыбы по точке на карте. MVP — только фронтенд.

**Веб-версия: https://artemioskr.github.io/kazak/** — публикуется автоматически
(workflow `pages` пушит index.html/css/js в ветку `gh-pages` при каждом пуше).

## Запуск
Открой `index.html` в браузере — ничего собирать не нужно.
Для геолокации и части браузеров лучше через локальный сервер:

    python3 -m http.server 8080
    # или
    php -S localhost:8080

## Структура
- `js/config.js` — веса, сезоны, профили видов (единственное место для настройки модели)
- `js/weather.js` — Open-Meteo
- `js/solunar.js` — лунные периоды
- `js/watertemp.js` — модель температуры воды (сглаживание T воздуха с инерцией водоёма)
- `js/kp.js` — Kp-индекс NOAA SWPC (не загрузился — фактор просто выключен)
- `js/scoring.js` — расчёт оценки и расшифровка (давление, фронт, ветер, солунар, вода…)
- `js/app.js` — интерфейс: карта, сохранённые точки, журнал рыбалок
- `tools/check-scoring.js` — проверка скоринга на реальном прогнозе из консоли:
  `npm i --no-save suncalc && TZ=Europe/Samara node tools/check-scoring.js zander 0`
- `tools/test-scoring.js` — юнит-тесты модели: `TZ=Europe/Samara node tools/test-scoring.js`
- `tools/backtest.js` — бэктест на историческом архиве:
  `TZ=Europe/Samara node tools/backtest.js 2026-06-01 2026-08-31 zander`
- `docs/plan.md` — план проекта
- `backend/` — API для VPS: аккаунты (Telegram), синк точек/журнала, кэш погоды,
  гидрология Нижнекамской ГЭС. Развёртывание: `backend/README.md`

## Данные
- Open-Meteo, лицензия CC BY 4.0, бесплатно для некоммерческого использования.
- NOAA SWPC (Kp-индекс) — публичные данные.
