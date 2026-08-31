#!/usr/bin/env bash
# Установка FishCast на чистый Ubuntu 22.04/24.04 VPS (нужен root или sudo).
# Использование: залей репозиторий на VPS (git clone), затем:
#   cd kazak/backend && sudo bash install.sh
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "== ставлю docker"
  curl -fsSL https://get.docker.com | sh
fi

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^APP_SECRET=$/APP_SECRET=$(openssl rand -hex 32)/" .env
  sed -i "s/^DB_PASS=$/DB_PASS=$(openssl rand -hex 16)/" .env
  echo "== создан .env: открой его и впиши APP_DOMAIN и TELEGRAM_BOT_TOKEN"
  echo "== затем повтори: sudo bash install.sh"
  exit 0
fi

echo "== собираю и запускаю"
docker compose up -d --build

echo "== жду базу и применяю миграции"
sleep 5
docker compose exec -T php php /backend/bin/migrate.php

echo "== проверка API"
sleep 2
curl -sk "https://$(grep ^APP_DOMAIN= .env | cut -d= -f2)/api/health" || curl -s http://localhost/api/health || true
echo
echo "== готово. Логи: docker compose logs -f"
