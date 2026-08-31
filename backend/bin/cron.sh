#!/bin/sh
# Простой крон-цикл в контейнере: гидрология раз в час (данные суточные,
# но источник обновляется в разное время — час пропуска не страшен).
set -u
echo "cron: старт"
php /backend/bin/migrate.php || true
while true; do
  php /backend/bin/fetch-hydro.php || echo "cron: fetch-hydro не удался (это ок, попробуем через час)"
  sleep 3600
done
