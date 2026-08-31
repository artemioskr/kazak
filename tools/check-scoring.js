// Проверка скоринга на реальном прогнозе Open-Meteo для точки по умолчанию.
// Гоняет штатные js/*.js без изменений (vm), печатает почасовую расшифровку,
// сводку по дням/видам и распределение категорий — контроль инфляции оценок.
//
// Запуск из корня репо (нужен npm-пакет suncalc: npm i --no-save suncalc):
//   TZ=Europe/Samara node tools/check-scoring.js [вид] [сдвиг дня]
// TZ ставь в зону точки, иначе солунар посчитается со сдвигом.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const REPO = process.env.REPO || path.join(__dirname, '..');
const SunCalc = require('suncalc');

const ctx = { SunCalc, console, Math, Date, JSON };
vm.createContext(ctx);
for (const f of ['config.js', 'watertemp.js', 'kp.js', 'solunar.js', 'scoring.js', 'weather.js']) {
  vm.runInContext(fs.readFileSync(path.join(REPO, 'js', f), 'utf8'), ctx, { filename: f });
}

async function main() {
  const { lat, lon } = vm.runInContext("CONFIG", ctx).defaultPoint;
  const p = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4),
    hourly: 'temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation,weather_code',
    daily: 'sunrise,sunset', timezone: 'auto', past_days: 2, forecast_days: 7, wind_speed_unit: 'ms',
  });
  const r = await fetch('https://api.open-meteo.com/v1/forecast?' + p);
  if (!r.ok) throw new Error('Open-Meteo ' + r.status);
  const j = await r.json();
  fs.writeFileSync(path.join(__dirname, 'forecast.json'), JSON.stringify(j));
  console.log('timezone:', j.timezone, '| node TZ:', Intl.DateTimeFormat().resolvedOptions().timeZone);

  const data = vm.runInContext('Weather.normalize(' + JSON.stringify(j) + ')', ctx);
  vm.runInContext('__d.waterTemp = WaterTemp.series(__d.hours, "reservoir")', Object.assign(ctx, {__d: data}));
  const species = process.argv[2] || 'zander';
  const scoringCtx = { lat, lon, species };
  const results = data.hours.map((_, i) =>
    vm.runInContext(`Scoring.hour(${i}, __data, __sctx)`, Object.assign(ctx, { __data: data, __sctx: scoringCtx })));

  const dayOffset = parseInt(process.argv[3] || '0', 10);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(today.getTime() + dayOffset * 86400000);
  const key = target.toISOString().slice(0, 10); // TZ-зависимо, но при TZ точки совпадает с локальной датой
  const dayKey = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;

  console.log(`\n=== ${vm.runInContext("CONFIG", ctx).species[species].name}, день ${dayKey} (offset ${dayOffset}) ===`);
  const idxs = [];
  data.hours.forEach((h, i) => { if (h.iso.startsWith(dayKey)) idxs.push(i); });
  let sum = 0, min = 999, max = -1;
  for (const i of idxs) {
    const h = data.hours[i], res = results[i];
    sum += res.score; min = Math.min(min, res.score); max = Math.max(max, res.score);
    const fs_ = res.factors.map(f => `${f.name} ${f.delta > 0 ? '+' : ''}${f.delta}`).join(', ');
    const bar = '█'.repeat(Math.round(res.score / 4));
    console.log(
      `${h.iso.slice(11, 16)}  ${String(res.score).padStart(3)} ${res.category.padEnd(7)} ` +
      `T=${String(h.temp.toFixed(0)).padStart(3)}° P=${h.pressure.toFixed(0)} W=${h.wind.toFixed(1)} обл=${String(h.cloud).padStart(3)}% ` +
      `| ${bar}\n       ${fs_}`);
  }
  console.log(`\nдень: min=${min} max=${max} avg=${(sum / idxs.length).toFixed(1)}`);

  // сводка по всем дням и видам
  console.log('\n=== Сводка max/avg по дням ===');
  const dayKeys = [...new Set(data.hours.map(h => h.iso.slice(0, 10)))];
  for (const sp of Object.keys(vm.runInContext("CONFIG", ctx).species)) {
    const rr = data.hours.map((_, i) =>
      vm.runInContext(`Scoring.hour(${i}, __data, __sctx2)`, Object.assign(ctx, { __sctx2: { lat, lon, species: sp } })));
    const row = dayKeys.map(k => {
      const ii = []; data.hours.forEach((h, i) => { if (h.iso.startsWith(k)) ii.push(i); });
      const sc = ii.map(i => rr[i].score);
      return `${k.slice(5)}: ${Math.max(...sc)}/${(sc.reduce((a, b) => a + b, 0) / sc.length).toFixed(0)}`;
    }).join('  ');
    console.log(vm.runInContext("CONFIG", ctx).species[sp].name.padEnd(6), row);
  }

  // распределение оценок по всем часам/видам — проверка нормировки
  console.log('\n=== Распределение (все виды, все часы) ===');
  const allScores = [];
  for (const sp of Object.keys(vm.runInContext("CONFIG", ctx).species)) {
    data.hours.forEach((_, i) => {
      allScores.push(vm.runInContext(`Scoring.hour(${i}, __data, __sctx3)`, Object.assign(ctx, { __sctx3: { lat, lon, species: sp } })).score);
    });
  }
  const buckets = [0, 0, 0, 0]; // слабо/средне/хорошо/отлично
  for (const s of allScores) buckets[s >= 78 ? 3 : s >= 62 ? 2 : s >= 42 ? 1 : 0]++;
  const n = allScores.length;
  console.log(`слабо(<42): ${(100 * buckets[0] / n).toFixed(0)}%  средне(42-61): ${(100 * buckets[1] / n).toFixed(0)}%  хорошо(62-77): ${(100 * buckets[2] / n).toFixed(0)}%  отлично(78+): ${(100 * buckets[3] / n).toFixed(0)}%`);
  console.log(`min=${Math.min(...allScores)} max=${Math.max(...allScores)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
