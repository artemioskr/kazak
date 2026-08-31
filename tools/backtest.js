// Бэктест модели на историческом архиве Open-Meteo (archive-api).
// Гоняет штатный скоринг по прошедшему периоду и печатает сводки для оценки
// правдоподобия: распределение категорий по месяцам, суточный профиль,
// лучшие/худшие дни, фронты, температура воды, влияние каждого фактора.
//
// Это проверка правдоподобия (face validity), НЕ точности: фактов об уловах
// здесь нет, честная проверка точности — по журналу рыбалок (этап 3).
//
// Запуск из корня репо: npm i --no-save suncalc
//   TZ=Europe/Samara node tools/backtest.js 2026-06-01 2026-08-31 [вид]
// Начало периода автоматически сдвигается на 45 дней назад для разгона
// модели температуры воды; эти дни в отчёт не входят. Ответ архива кэшируется
// в tools/.backtest-cache.json (в гите его нет).
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SunCalc = require('suncalc');
const ctx = { SunCalc, console, Math, Date, JSON };
vm.createContext(ctx);
for (const f of ['config.js', 'watertemp.js', 'kp.js', 'solunar.js', 'scoring.js', 'weather.js']) {
  vm.runInContext(fs.readFileSync(path.join(REPO, 'js', f), 'utf8'), ctx, { filename: f });
}
const CONFIG = vm.runInContext('CONFIG', ctx);

const from = process.argv[2] || '2026-06-01';
const to = process.argv[3] || '2026-08-31';
const mainSpecies = process.argv[4] || 'zander';
const SPINUP_DAYS = 45;

const CACHE = path.join(__dirname, '.backtest-cache.json');

async function fetchArchive(lat, lon, start, end) {
  const key = [lat, lon, start, end].join('|');
  if (fs.existsSync(CACHE)) {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (c.key === key) return c.json;
  }
  const p = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4),
    start_date: start, end_date: end,
    hourly: 'temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation,weather_code',
    daily: 'sunrise,sunset', timezone: 'auto', wind_speed_unit: 'ms',
  });
  const r = await fetch('https://archive-api.open-meteo.com/v1/archive?' + p);
  if (!r.ok) throw new Error('Open-Meteo archive ' + r.status);
  const json = await r.json();
  fs.writeFileSync(CACHE, JSON.stringify({ key, json }));
  return json;
}

const fmt = (x, w = 5) => String(x).padStart(w);
const pct = (n, d) => (100 * n / d).toFixed(0).padStart(3) + '%';
const MONTH = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

async function main() {
  const { lat, lon } = CONFIG.defaultPoint;
  const spinupStart = new Date(new Date(from).getTime() - SPINUP_DAYS * 86400000).toISOString().slice(0, 10);
  console.log(`Точка ${lat}, ${lon} · архив ${spinupStart}..${to} (отчёт с ${from}, ${SPINUP_DAYS} дн — разгон воды)`);

  const j = await fetchArchive(lat, lon, spinupStart, to);
  // архив может отдавать null в свежих часах — обрезаем хвост
  const H = j.hourly;
  let n = H.time.length;
  while (n > 0 && (H.temperature_2m[n - 1] === null || H.pressure_msl[n - 1] === null)) n--;
  for (const k of Object.keys(H)) H[k] = H[k].slice(0, n);
  console.log(`часов в архиве: ${n} (${H.time[0]} .. ${H.time[n - 1]}), зона ${j.timezone}\n`);

  const data = vm.runInContext('Weather.normalize(__j)', Object.assign(ctx, { __j: j }));
  vm.runInContext('__d.waterTemp = WaterTemp.series(__d.hours, "reservoir")', Object.assign(ctx, { __d: data }));

  // индексы отчётного периода
  const rep = [];
  data.hours.forEach((h, i) => { if (h.iso >= from && h.iso <= to + 'T23:59') rep.push(i); });

  // скоринг всех видов
  const results = {};
  for (const sp of Object.keys(CONFIG.species)) {
    results[sp] = data.hours.map((_, i) =>
      vm.runInContext('Scoring.hour(__i, __d, __c)', Object.assign(ctx, { __i: i, __d: data, __c: { lat, lon, species: sp } })));
  }

  // 1. Распределение категорий по месяцам и видам
  console.log('=== Категории по месяцам (слабо/средне/хорошо/отлично, % часов) ===');
  const cats = CONFIG.categories;
  const bucket = s => s >= cats[0].from ? 3 : s >= cats[1].from ? 2 : s >= cats[2].from ? 1 : 0;
  const months = [...new Set(rep.map(i => data.hours[i].iso.slice(0, 7)))];
  for (const sp of Object.keys(CONFIG.species)) {
    const row = months.map(m => {
      const b = [0, 0, 0, 0]; let cnt = 0, sum = 0;
      for (const i of rep) if (data.hours[i].iso.startsWith(m)) { b[bucket(results[sp][i].score)]++; cnt++; sum += results[sp][i].score; }
      return `${MONTH[+m.slice(5) - 1]}: ${b.map(x => pct(x, cnt)).join('/')} avg ${(sum / cnt).toFixed(0)}`;
    }).join('   ');
    console.log(CONFIG.species[sp].name.padEnd(6), row);
  }

  // 2. Суточный профиль основного вида
  console.log(`\n=== Суточный профиль, ${CONFIG.species[mainSpecies].name} (средняя оценка по часу суток) ===`);
  const byHour = Array.from({ length: 24 }, () => []);
  for (const i of rep) byHour[data.hours[i].time.getHours()].push(results[mainSpecies][i].score);
  byHour.forEach((arr, h) => {
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    console.log(`${String(h).padStart(2, '0')}:00 ${fmt(avg.toFixed(1), 6)} ${'█'.repeat(Math.round(avg / 2))}`);
  });

  // 3. Лучшие и худшие дни основного вида
  console.log(`\n=== Дни, ${CONFIG.species[mainSpecies].name}: топ-5 и антитоп-5 по средней за день ===`);
  const dayMap = {};
  for (const i of rep) {
    const k = data.hours[i].iso.slice(0, 10);
    (dayMap[k] = dayMap[k] || []).push(i);
  }
  const dayStats = Object.entries(dayMap).map(([k, ii]) => {
    const sc = ii.map(i => results[mainSpecies][i].score);
    return { day: k, avg: sc.reduce((a, b) => a + b, 0) / sc.length, max: Math.max(...sc) };
  }).sort((a, b) => b.avg - a.avg);
  const show = d => {
    const ii = dayMap[d.day];
    const fc = {};
    for (const i of ii) for (const f of results[mainSpecies][i].factors) fc[f.name] = (fc[f.name] || 0) + f.delta;
    const top = Object.entries(fc).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3)
      .map(([nm, s]) => `${nm} ${s > 0 ? '+' : ''}${Math.round(s / ii.length)}`).join(', ');
    console.log(`${d.day}  avg ${d.avg.toFixed(0).padStart(3)} max ${String(d.max).padStart(3)}  | в среднем за час: ${top}`);
  };
  dayStats.slice(0, 5).forEach(show);
  console.log('  …');
  dayStats.slice(-5).forEach(show);

  // 4. Фронты за период
  const fronts = vm.runInContext('Scoring.detectFronts(__d)', Object.assign(ctx, { __d: data }));
  const events = [];
  let run = null;
  rep.forEach(i => {
    if (fronts[i]) { if (run) run.to = i; else run = { from: i, to: i }; }
    else if (run) { events.push(run); run = null; }
  });
  if (run) events.push(run);
  console.log(`\n=== Фронты: ${events.length} событий, ${rep.filter(i => fronts[i]).length} фронтовых часов за ${Object.keys(dayMap).length} дней ===`);
  for (const e of events.slice(0, 30)) {
    const a = data.hours[e.from], b = data.hours[e.to];
    console.log(`${a.iso} .. ${b.iso.slice(11)}  P ${data.hours[Math.max(0, e.from - CONFIG.front.window)].pressure.toFixed(0)}->${b.pressure.toFixed(0)}`);
  }

  // 5. Температура воды по месяцам (модель, вдхр)
  console.log('\n=== Температура воды (модель v0, вдхр): месяц min/avg/max ===');
  for (const m of months) {
    const w = rep.filter(i => data.hours[i].iso.startsWith(m)).map(i => data.waterTemp[i]);
    const avg = w.reduce((a, b) => a + b, 0) / w.length;
    console.log(`${MONTH[+m.slice(5) - 1]}  ${Math.min(...w).toFixed(1)} / ${avg.toFixed(1)} / ${Math.max(...w).toFixed(1)} °C`);
  }

  // 6. Влияние факторов на основном виде: как часто срабатывает и средний вклад
  console.log(`\n=== Факторы, ${CONFIG.species[mainSpecies].name}: доля часов и средний вклад ===`);
  const inf = {};
  for (const i of rep) for (const f of results[mainSpecies][i].factors) {
    (inf[f.name] = inf[f.name] || { n: 0, sum: 0 }).n++;
    inf[f.name].sum += f.delta;
  }
  Object.entries(inf).sort((a, b) => b[1].n - a[1].n).forEach(([nm, v]) => {
    console.log(`${nm.padEnd(20)} ${pct(v.n, rep.length)} часов, средний вклад ${(v.sum / v.n).toFixed(1)}`);
  });

  // 7. Общая нормировка за период
  console.log('\n=== Распределение за период (все виды) ===');
  const b = [0, 0, 0, 0]; let cnt = 0;
  for (const sp of Object.keys(CONFIG.species)) for (const i of rep) { b[bucket(results[sp][i].score)]++; cnt++; }
  console.log(`слабо ${pct(b[0], cnt)}  средне ${pct(b[1], cnt)}  хорошо ${pct(b[2], cnt)}  отлично ${pct(b[3], cnt)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
