<?php
// FishCast backend: общие функции. Без фреймворка и composer — чистый PHP 8.3+.
// Причина: развёртывание на любом VPS одной командой, ноль внешних зависимостей.

declare(strict_types=1);

const APP_VERSION = '0.1.0';

function envs(string $key, ?string $default = null): string {
    $v = getenv($key);
    if ($v === false || $v === '') {
        if ($default === null) {
            throw new RuntimeException("нет переменной окружения $key");
        }
        return $default;
    }
    return $v;
}

function db(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $dsn = sprintf(
            'pgsql:host=%s;port=%s;dbname=%s',
            envs('DB_HOST', 'db'), envs('DB_PORT', '5432'), envs('DB_NAME', 'fishcast')
        );
        $pdo = new PDO($dsn, envs('DB_USER', 'fishcast'), envs('DB_PASS'), [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    }
    return $pdo;
}

// --- ответы ---

function json_out(mixed $data, int $code = 200): never {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $message, int $code = 400): never {
    json_out(['error' => $message], $code);
}

function read_json_body(): array {
    $raw = file_get_contents('php://input');
    $data = json_decode($raw ?: '', true);
    if (!is_array($data)) fail('ожидается JSON-тело запроса');
    return $data;
}

// --- CORS: фронт может жить на github.io, бэкенд — на своём домене ---

function cors(): void {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $allowed = array_filter(array_map('trim', explode(',', envs('CORS_ORIGINS', ''))));
    if ($origin !== '' && in_array($origin, $allowed, true)) {
        header("Access-Control-Allow-Origin: $origin");
        header('Vary: Origin');
        header('Access-Control-Allow-Headers: Authorization, Content-Type');
        header('Access-Control-Allow-Methods: GET, PUT, POST, OPTIONS');
        header('Access-Control-Max-Age: 86400');
    }
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

// --- токены: подписанный HMAC-ом JSON, без внешних JWT-библиотек ---

function b64url_encode(string $s): string {
    return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
}

function b64url_decode(string $s): string|false {
    return base64_decode(strtr($s, '-_', '+/'));
}

function token_issue(int $userId, int $ttlDays = 90): string {
    $payload = b64url_encode(json_encode(['uid' => $userId, 'exp' => time() + $ttlDays * 86400]));
    $sig = b64url_encode(hash_hmac('sha256', $payload, envs('APP_SECRET'), true));
    return "$payload.$sig";
}

function token_verify(string $token): ?int {
    $parts = explode('.', $token);
    if (count($parts) !== 2) return null;
    [$payload, $sig] = $parts;
    $expected = b64url_encode(hash_hmac('sha256', $payload, envs('APP_SECRET'), true));
    if (!hash_equals($expected, $sig)) return null;
    $data = json_decode(b64url_decode($payload) ?: '', true);
    if (!is_array($data) || ($data['exp'] ?? 0) < time()) return null;
    return (int)($data['uid'] ?? 0) ?: null;
}

function auth_user_id(): int {
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/^Bearer\s+(\S+)$/i', $h, $m)) {
        $uid = token_verify($m[1]);
        if ($uid !== null) return $uid;
    }
    fail('нужна авторизация', 401);
}

// --- Telegram Login Widget: проверка подписи данных ботом ---
// https://core.telegram.org/widgets/login#checking-authorization

function telegram_verify(array $fields): ?array {
    $hash = $fields['hash'] ?? '';
    if ($hash === '' || empty($fields['id']) || empty($fields['auth_date'])) return null;
    unset($fields['hash']);
    ksort($fields);
    $pairs = [];
    foreach ($fields as $k => $v) $pairs[] = "$k=$v";
    $secret = hash('sha256', envs('TELEGRAM_BOT_TOKEN'), true);
    $check = hash_hmac('sha256', implode("\n", $pairs), $secret);
    if (!hash_equals($check, $hash)) return null;
    if (time() - (int)$fields['auth_date'] > 86400) return null; // сутки на вход
    return $fields;
}

// --- HTTP-клиент для крона/прокси ---

function http_get(string $url, int $timeout = 20): ?string {
    $ctx = stream_context_create(['http' => [
        'timeout' => $timeout,
        'header' => "User-Agent: FishCast/1.0 (personal, non-commercial)\r\n",
    ]]);
    $body = @file_get_contents($url, false, $ctx);
    return $body === false ? null : $body;
}
