// Юнит-тесты модели на синтетических данных — без сети и без suncalc-солунара
// в проверках, где он не нужен. Тестируем инварианты, а не конкретные веса,
// чтобы тесты не ломались при каждой калибровке config.js.
//
// Запуск: npm i --no-save suncalc && TZ=Europe/Samara node tools/test-scoring.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SunCalc = require('suncalc');
const ctx = { SunCalc, console, Math, Date, JSON };
vm.createContext(ctx);
for (const f of ['config.js', 'watertemp.js', 'kp.js', 'solunar.js', 'scoring.js']) {
  vm.runInContext(fs.readFileSync(path.join(REPO, 'js', f), 'utf8'), ctx, { filename: f });
}
const G = name => vm.runInContext(name, ctx); // достать const из контекста vm
const CONFIG = G('CONFIG');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + ' — ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// --- синтетический прогноз: N часов от заданного старта, базовая «ровная» погода ---
function mkData(startIso, n, patch) {
  const hours = [];
  for (let i = 0; i < n; i++) {
    const time = new Date(new Date(startIso).getTime() + i * 3600000);
    const iso = `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')}T${String(time.getHours()).padStart(2, '0')}:00`;
    hours.push({
      time, iso,
      temp: 18, pressure: 1015, wind: 3, windDir: 270, gust: 5, cloud: 50, precip: 0, code: 2,
    });
  }
  if (patch) patch(hours);
  const days = {};
  for (const h of hours) {
    const k = h.iso.slice(0, 10);
    if (!days[k]) {
      const d = new Date(h.time); d.setHours(0, 0, 0, 0);
      days[k] = {
        sunrise: new Date(d.getTime() + 4.5 * 3600000),  // 04:30
        sunset: new Date(d.getTime() + 20.5 * 3600000),  // 20:30
      };
    }
  }
  return { hours, days };
}

function score(i, data, species) {
  return vm.runInContext('Scoring.hour(__i, __d, __c)',
    Object.assign(ctx, { __i: i, __d: data, __c: { lat: 56.3, lon: 53.2, species } }));
}

console.log('— инварианты —');
t('оценка в границах 0..100 и сумма вкладов сходится с baseline', () => {
  const data = mkData('2026-07-14T00:00', 72);
  for (let i = 0; i < 72; i++) {
    for (const sp of Object.keys(CONFIG.species)) {
      const r = score(i, data, sp);
      assert(r.score >= 0 && r.score <= 100, `score ${r.score} вне 0..100`);
      const raw = CONFIG.baseline + r.factors.reduce((s, f) => s + f.delta, 0);
      assert(r.score === Math.max(0, Math.min(100, Math.round(raw))),
        `сумма вкладов ${raw} не сходится со score ${r.score} (${sp}, час ${i})`);
      for (const f of r.factors) assert(f.name && f.text !== undefined && Number.isInteger(f.delta),
        'формат фактора {name, delta, text} нарушен');
    }
  }
});

t('категории: монотонные пороги, каждая оценка попадает ровно в одну', () => {
  const c = CONFIG.categories;
  for (let i = 1; i < c.length; i++) assert(c[i].from < c[i - 1].from, 'пороги не убывают');
  assert(c[c.length - 1].from === 0, 'нижняя категория должна начинаться с 0');
  const S = G('Scoring');
  assert(vm.runInContext('Scoring.category(0)', ctx) === 'слабо');
  assert(vm.runInContext(`Scoring.category(${c[0].from})`, ctx) === 'отлично');
});

console.log('— давление —');
t('плавное падение даёт фактор «Давление падает»', () => {
  const data = mkData('2026-07-14T00:00', 48, hs => {
    hs.forEach((h, i) => { h.pressure = 1020 - i * 0.45; }); // ~2.7 гПа за 6 ч
  });
  const r = score(30, data, 'zander');
  assert(r.factors.some(f => f.name === 'Давление падает' && f.delta > 0), JSON.stringify(r.factors));
});

t('резкий скачок даёт штраф «Скачок давления»', () => {
  const data = mkData('2026-07-14T00:00', 48, hs => {
    hs.forEach((h, i) => { if (i >= 24) h.pressure = 1015 + (i - 24 + 1) * 1.2; }); // +7 гПа за 6 ч
  });
  const r = score(30, data, 'zander');
  assert(r.factors.some(f => f.name === 'Скачок давления' && f.delta < 0), JSON.stringify(r.factors));
});

console.log('— фронт —');
t('падение давления + разворот ветра = фронтовый час, до него — «Перед фронтом», после — «После фронта»', () => {
  const F = CONFIG.front;
  const data = mkData('2026-07-13T00:00', 96, hs => {
    // фронт около часа 48: за 6 ч до него давление -5 гПа и ветер разворачивается на 120°
    hs.forEach((h, i) => {
      if (i >= 42 && i <= 48) { h.pressure = 1015 - (i - 42) * 0.9; h.windDir = 270 - (i - 42) * 20; }
      if (i > 48) { h.pressure = 1009.6; h.windDir = 150; }
    });
  });
  const fronts = vm.runInContext('Scoring.detectFronts(__d)', Object.assign(ctx, { __d: data }));
  assert(fronts[48], 'час 48 не распознан как фронт');
  const before = score(48 - 3, data, 'pike');
  assert(before.factors.some(f => f.name === 'Перед фронтом' && f.delta > 0), JSON.stringify(before.factors));
  const after = score(48 + F.window + 3, data, 'pike');
  assert(after.factors.some(f => f.name === 'После фронта' && f.delta < 0), JSON.stringify(after.factors));
});

t('то же падение без разворота ветра и без скачка T — не фронт', () => {
  const data = mkData('2026-07-13T00:00', 96, hs => {
    hs.forEach((h, i) => { if (i >= 42 && i <= 48) h.pressure = 1015 - (i - 42) * 0.9; if (i > 48) h.pressure = 1009.6; });
  });
  const fronts = vm.runInContext('Scoring.detectFronts(__d)', Object.assign(ctx, { __d: data }));
  assert(!fronts.some(Boolean), 'фронт не должен детектиться без второго признака');
});

console.log('— температура воды —');
t('при постоянном воздухе вода сходится к температуре воздуха', () => {
  const hours = Array.from({ length: 24 * 40 }, () => ({ temp: 20 }));
  const w = vm.runInContext('WaterTemp.series(__h, "reservoir")', Object.assign(ctx, { __h: hours }));
  assert(Math.abs(w[w.length - 1] - 20) < 0.01, 'не сошлась: ' + w[w.length - 1]);
});

t('инерция: пруд реагирует на скачок воздуха быстрее водохранилища', () => {
  const hours = Array.from({ length: 24 * 10 }, (_, i) => ({ temp: i < 24 ? 10 : 25 }));
  const pond = vm.runInContext('WaterTemp.series(__h, "pond")', Object.assign(ctx, { __h: hours }));
  const res = vm.runInContext('WaterTemp.series(__h, "reservoir")', Object.assign(ctx, { __h: hours }));
  const last = hours.length - 1;
  assert(pond[last] > res[last] + 2, `пруд ${pond[last].toFixed(1)}° должен прогреться заметно сильнее вдхр ${res[last].toFixed(1)}°`);
});

t('вода вне оптимума штрафуется, в оптимуме — почти нейтральна', () => {
  const data = mkData('2026-07-14T00:00', 30);
  data.waterTemp = data.hours.map(() => 27);         // сильно выше оптимума судака 8-20
  const hot = score(26, data, 'zander');
  const f = hot.factors.find(f => f.name === 'Вода тёплая');
  assert(f && f.delta < 0, JSON.stringify(hot.factors));
  data.waterTemp = data.hours.map(() => 15);         // в оптимуме
  const ok = score(26, data, 'zander');
  const f2 = ok.factors.find(f => f.name === 'Вода в оптимуме');
  assert(!f2 || f2.delta <= 2, 'бонус за норму должен быть 0..2');
});

console.log('— солунар и время суток —');
t('за сутки находится 1-2 major-периода и до 2 minor', () => {
  const day = new Date(2026, 6, 14); // 14 июля, локальная полночь
  const per = vm.runInContext('Solunar.periods(__d, 56.3, 53.2)', Object.assign(ctx, { __d: day }));
  const majors = per.filter(p => p.type === 'major').length;
  const minors = per.filter(p => p.type === 'minor').length;
  assert(majors >= 1 && majors <= 2, 'major: ' + majors);
  assert(minors <= 2, 'minor: ' + minors);
  for (let i = 1; i < per.length; i++) assert(per[i].start >= per[i - 1].start, 'периоды не отсортированы');
});

t('час на рассвете получает «Сумерки»', () => {
  const data = mkData('2026-07-14T00:00', 30);
  const r = score(5, data, 'zander'); // 05:00 при рассвете 04:30
  assert(r.factors.some(f => f.name === 'Сумерки' && f.delta > 0), JSON.stringify(r.factors));
});

console.log('— прочее —');
t('Kp.at: округление к 3-часовому интервалу UTC и обе формы ответа SWPC', () => {
  const Kp = G('Kp');
  vm.runInContext('Kp._map = {"2026-07-14T06": 5.33}; Kp.ready = true;', ctx);
  const v = vm.runInContext('Kp.at(new Date(Date.UTC(2026, 6, 14, 8, 40)))', ctx); // 08:40 UTC -> интервал 06
  assert(v === 5.33, 'получено: ' + v);
  const miss = vm.runInContext('Kp.at(new Date(Date.UTC(2026, 6, 14, 12, 0)))', ctx);
  assert(miss === null, 'вне карты должен быть null');
});

t('нерестовый запрет: границы включительно', () => {
  const B = CONFIG.spawningBan;
  const inb = d => vm.runInContext('Scoring.inSpawningBan(__d)', Object.assign(ctx, { __d: d }));
  assert(inb(new Date(2026, B.from.month - 1, B.from.day)) === true, 'первый день');
  assert(inb(new Date(2026, B.to.month - 1, B.to.day, 12)) === true, 'последний день');
  assert(inb(new Date(2026, B.from.month - 1, B.from.day - 1)) === false, 'канун');
});

t('окна клёва: непрерывные отрезки над порогом', () => {
  const rs = [50, 70, 75, 55, 80, 80, 40].map(s => ({ score: s }));
  const w = vm.runInContext('Scoring.windows(__r, 60)', Object.assign(ctx, { __r: rs }));
  assert(w.length === 2 && w[0].from === 1 && w[0].to === 2 && w[1].from === 4 && w[1].to === 5, JSON.stringify(w));
});

console.log(`\nитого: ${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
