<?php
// Применяет sql/*.sql, которых ещё нет в таблице migrations. Идёмпотентно.
declare(strict_types=1);
require __DIR__ . '/../src/lib.php';

$dir = __DIR__ . '/../sql';
$files = glob("$dir/*.sql");
sort($files);

db()->exec('CREATE TABLE IF NOT EXISTS migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
$done = db()->query('SELECT filename FROM migrations')->fetchAll(PDO::FETCH_COLUMN);

foreach ($files as $f) {
    $name = basename($f);
    if (in_array($name, $done, true)) continue;
    echo "применяю $name\n";
    db()->exec(file_get_contents($f));
    db()->prepare('INSERT INTO migrations (filename) VALUES (:f) ON CONFLICT DO NOTHING')->execute([':f' => $name]);
}
echo "миграции в порядке\n";
