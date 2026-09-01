<?php
// FishCast API. Роутинг в лоб: метод + путь. Все ответы — JSON.
declare(strict_types=1);
require __DIR__ . '/../src/lib.php';

cors();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$path = preg_replace('#^/api#', '', $path) ?: '/';

try {
    route($method, $path);
} catch (Throwable $e) {
    error_log('fishcast: ' . $e->getMessage());
    fail('внутренняя ошибка', 500);
}

function route(string $method, string $path): never {
    match (true) {
        $method === 'GET' && $path === '/health' => health(),
        $method === 'POST' && $path === '/auth/register' => auth_register(),
        $method === 'POST' && $path === '/auth/login' => auth_login(),
        $method === 'POST' && $path === '/auth/telegram' => auth_telegram(),
        $method === 'GET' && $path === '/state' => state_get(),
        $method === 'PUT' && $path === '/state' => state_put(),
        $method === 'GET' && $path === '/weather' => weather(),
        $method === 'GET' && $path === '/hydro' => hydro(),
        default => fail('нет такого пути', 404),
    };
}

function health(): never {
    $dbOk = true;
    try { db()->query('SELECT 1'); } catch (Throwable) { $dbOk = false; }
    json_out(['ok' => true, 'db' => $dbOk, 'version' => APP_VERSION]);
}

// Логин + пароль — без внешних сервисов (Telegram в РФ заблокирован, SMS дорого).
function auth_credentials(): array {
    $b = read_json_body();
    $login = mb_strtolower(trim((string)($b['login'] ?? '')));
    $pass = (string)($b['password'] ?? '');
    if (!preg_match('/^[a-z0-9@._-]{3,64}$/', $login))
        fail('логин: 3-64 символа, латиница/цифры/@._-');
    if (mb_strlen($pass) < 8) fail('пароль: минимум 8 символов');
    return [$login, $pass];
}

function auth_register(): never {
    [$login, $pass] = auth_credentials();
    $hash = password_hash($pass, PASSWORD_DEFAULT);
    try {
        $st = db()->prepare('INSERT INTO users (login, pass_hash) VALUES (:l, :h) RETURNING id');
        $st->execute([':l' => $login, ':h' => $hash]);
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'users_login_key')) fail('такой логин уже занят', 409);
        throw $e;
    }
    json_out(['token' => token_issue((int)$st->fetchColumn()), 'name' => $login]);
}

function auth_login(): never {
    [$login, $pass] = auth_credentials();
    $st = db()->prepare('SELECT id, pass_hash FROM users WHERE login = :l');
    $st->execute([':l' => $login]);
    $row = $st->fetch();
    usleep(300_000); // притормаживаем перебор
    if (!$row || !$row['pass_hash'] || !password_verify($pass, $row['pass_hash'])) {
        fail('неверный логин или пароль', 403);
    }
    db()->prepare('UPDATE users SET last_seen = now() WHERE id = :id')->execute([':id' => $row['id']]);
    json_out(['token' => token_issue((int)$row['id']), 'name' => $login]);
}

// Вход через Telegram Login Widget: браузер шлёт поля виджета как есть.
// Задел на будущее (телеграм-бот из плана); в UI не используется — Telegram в РФ заблокирован.
function auth_telegram(): never {
    $fields = read_json_body();
    $tg = telegram_verify($fields);
    if ($tg === null) fail('подпись Telegram не сошлась', 403);
    $name = trim(($tg['first_name'] ?? '') . ' ' . ($tg['last_name'] ?? ''));
    $st = db()->prepare(
        'INSERT INTO users (tg_id, name, username) VALUES (:tg, :name, :un)
         ON CONFLICT (tg_id) DO UPDATE SET name = :name, username = :un, last_seen = now()
         RETURNING id');
    $st->execute([':tg' => (int)$tg['id'], ':name' => $name, ':un' => $tg['username'] ?? '']);
    $uid = (int)$st->fetchColumn();
    json_out(['token' => token_issue($uid), 'name' => $name ?: ($tg['username'] ?? 'рыбак')]);
}

function state_get(): never {
    $uid = auth_user_id();
    $st = db()->prepare('SELECT points, journal, updated_at FROM user_state WHERE user_id = :u');
    $st->execute([':u' => $uid]);
    $row = $st->fetch();
    json_out($row
        ? ['points' => json_decode($row['points']), 'journal' => json_decode($row['journal']), 'updatedAt' => $row['updated_at']]
        : ['points' => [], 'journal' => [], 'updatedAt' => null]);
}

function state_put(): never {
    $uid = auth_user_id();
    $body = read_json_body();
    $points = $body['points'] ?? [];
    $journal = $body['journal'] ?? [];
    if (!is_array($points) || !is_array($journal)) fail('points и journal должны быть массивами');
    if (strlen(json_encode($journal)) > 2_000_000) fail('журнал слишком большой', 413);
    $st = db()->prepare(
        'INSERT INTO user_state (user_id, points, journal, updated_at) VALUES (:u, :p, :j, now())
         ON CONFLICT (user_id) DO UPDATE SET points = :p, journal = :j, updated_at = now()');
    $st->execute([
        ':u' => $uid,
        ':p' => json_encode($points, JSON_UNESCAPED_UNICODE),
        ':j' => json_encode($journal, JSON_UNESCAPED_UNICODE),
    ]);
    json_out(['ok' => true]);
}

// Кэширующий прокси Open-Meteo: щадим лимиты API и ускоряем открытие.
function weather(): never {
    $lat = (float)($_GET['lat'] ?? 0);
    $lon = (float)($_GET['lon'] ?? 0);
    if ($lat < -90 || $lat > 90 || $lon < -180 || $lon > 180 || ($lat === 0.0 && $lon === 0.0)) {
        fail('нужны lat и lon');
    }
    // ключ — сетка ~2 км: соседние тапы по карте попадают в один кэш
    $key = sprintf('%.2f,%.2f', $lat, $lon);
    $ttl = (int)envs('WEATHER_TTL_SEC', '1800');

    $st = db()->prepare('SELECT payload FROM weather_cache WHERE key = :k AND fetched_at > now() - make_interval(secs => :ttl)');
    $st->execute([':k' => $key, ':ttl' => $ttl]);
    if ($row = $st->fetch()) {
        header('X-Cache: hit');
        json_out(json_decode($row['payload']));
    }

    $q = http_build_query([
        'latitude' => sprintf('%.4f', $lat), 'longitude' => sprintf('%.4f', $lon),
        'hourly' => 'temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation,weather_code',
        'daily' => 'sunrise,sunset', 'timezone' => 'auto',
        'past_days' => 7, 'forecast_days' => 7, 'wind_speed_unit' => 'ms',
    ]);
    $body = http_get('https://api.open-meteo.com/v1/forecast?' . $q);
    if ($body === null || json_decode($body) === null) fail('Open-Meteo недоступен', 502);

    db()->prepare('INSERT INTO weather_cache (key, payload, fetched_at) VALUES (:k, :p, now())
                   ON CONFLICT (key) DO UPDATE SET payload = :p, fetched_at = now()')
        ->execute([':k' => $key, ':p' => $body]);
    header('X-Cache: miss');
    json_out(json_decode($body));
}

// Последние данные гидрологии (наполняет bin/fetch-hydro.php на кроне).
function hydro(): never {
    $station = $_GET['station'] ?? 'Нижнекамская';
    $st = db()->prepare('SELECT date, uvb, unb, inflow, discharge FROM hydro
                         WHERE station = :s ORDER BY date DESC LIMIT 30');
    $st->execute([':s' => $station]);
    json_out(['station' => $station, 'days' => $st->fetchAll()]);
}
