<?php
// Крон: тянем гидрообстановку Нижнекамской ГЭС и пишем в таблицу hydro.
// ВАЖНО: rushydro.ru и tatgencom.ru отдают данные только с российских IP —
// поэтому этот скрипт живёт на VPS, а не на GitHub Actions (см. CLAUDE.md).
//
// Парсер эвристический: со своей песочницы я до источника не достучался
// (гео-блок), поэтому при нулевом результате скрипт сохраняет сырой HTML
// в /tmp/hydro-raw.html — посмотри его и поправь регэкспы под фактическую вёрстку.
declare(strict_types=1);
require __DIR__ . '/../src/lib.php';

$sources = [
    // информер РусГидро: блоки по станциям каскада
    'https://www.rushydro.ru/informer/',
    'http://www.rushydro.ru/hydrology/informer/',
];

$html = null;
foreach ($sources as $url) {
    $html = http_get($url, 30);
    if ($html !== null && mb_stripos($html, 'ижнекамск') !== false) {
        fwrite(STDERR, "источник: $url\n");
        break;
    }
    $html = null;
}
if ($html === null) {
    fwrite(STDERR, "не удалось получить страницу с упоминанием Нижнекамской\n");
    exit(1);
}

// Кусок HTML вокруг «Нижнекамская» — числа ищем в нём, чтобы не зацепить соседнюю ГЭС.
$pos = mb_stripos($html, 'ижнекамск');
$chunk = mb_substr($html, max(0, $pos - 200), 4000);
$chunk = html_entity_decode(strip_tags(preg_replace('/>/', '> ', $chunk)));

$num = '([\d]{1,4}(?:[.,]\d{1,2})?)';
$val = function (string $re) use ($chunk, $num): ?float {
    if (preg_match($re, $chunk, $m)) return (float)str_replace(',', '.', $m[1]);
    return null;
};

$uvb = $val("/(?:УВБ|верхн\w+\s+бьеф\w*)\D{0,40}$num/iu");
$unb = $val("/(?:УНБ|нижн\w+\s+бьеф\w*)\D{0,40}$num/iu");
$inflow = $val("/приток\D{0,40}$num/iu");
$discharge = $val("/(?:сброс|расход)\D{0,40}$num/iu");

if ($uvb === null && $discharge === null) {
    @file_put_contents('/tmp/hydro-raw.html', $html);
    fwrite(STDERR, "числа не распознаны — сырой HTML сохранён в /tmp/hydro-raw.html, поправь регэкспы\n");
    exit(2);
}

db()->prepare('INSERT INTO hydro (station, date, uvb, unb, inflow, discharge)
               VALUES (:s, CURRENT_DATE, :uvb, :unb, :in, :dis)
               ON CONFLICT (station, date) DO UPDATE
               SET uvb = :uvb, unb = :unb, inflow = :in, discharge = :dis, fetched_at = now()')
    ->execute([':s' => 'Нижнекамская', ':uvb' => $uvb, ':unb' => $unb, ':in' => $inflow, ':dis' => $discharge]);

echo "ок: УВБ=$uvb УНБ=$unb приток=$inflow сброс=$discharge\n";
