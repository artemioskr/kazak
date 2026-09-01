-- FishCast: начальная схема. Файлы из этой папки postgres выполняет при первом старте
-- (docker-entrypoint-initdb.d); дальнейшие миграции — новыми файлами + bin/migrate.php.

CREATE TABLE IF NOT EXISTS users (
    id         bigserial PRIMARY KEY,
    login      text UNIQUE,                     -- основной вход: логин + пароль
    pass_hash  text,
    tg_id      bigint UNIQUE,                   -- запас на будущее (телеграм-бот)
    name       text NOT NULL DEFAULT '',
    username   text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen  timestamptz NOT NULL DEFAULT now()
);

-- Синк в лоб: состояние пользователя целиком, last-write-wins.
-- Для одного рыбака этого достаточно; дельта-синк — когда появятся общие точки.
CREATE TABLE IF NOT EXISTS user_state (
    user_id    bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    points     jsonb NOT NULL DEFAULT '[]',
    journal    jsonb NOT NULL DEFAULT '[]',
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Кэш ответов Open-Meteo: ключ — округлённые координаты, TTL проверяется в коде.
CREATE TABLE IF NOT EXISTS weather_cache (
    key        text PRIMARY KEY,
    payload    jsonb NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now()
);

-- Гидрология: суточные значения по станции (Нижнекамская ГЭС и далее каскад).
CREATE TABLE IF NOT EXISTS hydro (
    id         bigserial PRIMARY KEY,
    station    text NOT NULL,
    date       date NOT NULL,
    uvb        numeric,          -- уровень верхнего бьефа, м БС
    unb        numeric,          -- уровень нижнего бьефа, м БС
    inflow     numeric,          -- приток, м3/с
    discharge  numeric,          -- сброс (средний за сутки), м3/с
    fetched_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (station, date)
);

CREATE TABLE IF NOT EXISTS migrations (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO migrations (filename) VALUES ('001_init.sql') ON CONFLICT DO NOTHING;
