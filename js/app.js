// Интерфейс MVP. Состояние — в объекте S, отрисовка — функциями render*.
const S = {
  lat: null, lon: null,
  species: 'zander',
  waterbody: CONFIG.waterTemp.default,
  daypart: 'all',    // часы планируемой рыбалки: по ним цвет точки дня и лучший час
  data: null,        // из Weather.fetch
  results: [],       // Scoring.hour для каждого часа data.hours
  dayKeys: [],       // 'YYYY-MM-DD' для прогнозных дней
  dayIdx: 0,
  hourIdx: null,     // индекс в data.hours
};

const $ = id => document.getElementById(id);
const DOW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const DOW_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTH = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const pad = n => String(n).padStart(2, '0');
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => dateKey(new Date());

// --- карта ---
const map = L.map('map', { zoomControl: false, attributionControl: true })
  .setView([CONFIG.defaultPoint.lat, CONFIG.defaultPoint.lon], 9);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18, attribution: '&copy; OpenStreetMap',
}).addTo(map);
let marker = null;

map.on('click', e => setPoint(e.latlng.lat, e.latlng.lng));

$('locate').addEventListener('click', () => {
  if (!navigator.geolocation) return status('Геолокация недоступна в этом браузере.', true);
  navigator.geolocation.getCurrentPosition(
    p => { map.setView([p.coords.latitude, p.coords.longitude], 11); setPoint(p.coords.latitude, p.coords.longitude); },
    () => status('Не удалось получить геолокацию. Тапни точку на карте.', true),
    { timeout: 8000 },
  );
});

function setPoint(lat, lon) {
  S.lat = lat; S.lon = lon;
  const icon = L.divIcon({ className: '', html: '<div class="point-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
  if (marker) marker.setLatLng([lat, lon]); else marker = L.marker([lat, lon], { icon }).addTo(map);
  $('point-label').textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  localStorage.setItem('fishcast.point', JSON.stringify({ lat, lon }));
  renderPoints(); // синхронизировать селект сохранённых точек
  load();
}

// --- виды ---
const sel = $('species');
for (const [k, v] of Object.entries(CONFIG.species)) {
  const o = document.createElement('option'); o.value = k; o.textContent = v.name; sel.appendChild(o);
}
sel.value = localStorage.getItem('fishcast.species') || S.species;
S.species = sel.value;
sel.addEventListener('change', () => {
  S.species = sel.value;
  localStorage.setItem('fishcast.species', S.species);
  if (S.data) { compute(); renderAll(); }
});
$('cfg-version').textContent = 'v' + CONFIG.version;

// --- тип водоёма (инерция модели температуры воды) ---
const wbSel = $('waterbody');
for (const [k, label] of Object.entries(CONFIG.waterTemp.labels)) {
  const o = document.createElement('option'); o.value = k; o.textContent = label; wbSel.appendChild(o);
}
wbSel.value = localStorage.getItem('fishcast.waterbody') || S.waterbody;
S.waterbody = wbSel.value;
wbSel.addEventListener('change', () => {
  S.waterbody = wbSel.value;
  localStorage.setItem('fishcast.waterbody', S.waterbody);
  if (S.data) { compute(); renderAll(); }
});

// --- часы рыбалки ---
const DAYPARTS = [
  { key: 'all', label: 'Весь день', test: () => true },
  { key: 'morning', label: 'Утро', test: h => h >= 4 && h < 10 },
  { key: 'day', label: 'День', test: h => h >= 10 && h < 16 },
  { key: 'evening', label: 'Вечер', test: h => h >= 16 && h < 22 },
  { key: 'night', label: 'Ночь', test: h => h >= 22 || h < 4 },
];
S.daypart = localStorage.getItem('fishcast.daypart') || S.daypart;
if (!DAYPARTS.some(d => d.key === S.daypart)) S.daypart = 'all';
const daypartTest = () => DAYPARTS.find(d => d.key === S.daypart).test;

function renderDayparts() {
  const nav = $('dayparts');
  nav.innerHTML = '';
  DAYPARTS.forEach(d => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'dp'; b.textContent = d.label;
    b.setAttribute('aria-pressed', d.key === S.daypart ? 'true' : 'false');
    b.addEventListener('click', () => {
      S.daypart = d.key;
      localStorage.setItem('fishcast.daypart', d.key);
      S.hourIdx = null;
      renderAll();
    });
    nav.appendChild(b);
  });
}

// --- сохранённые точки ---
const Points = {
  all() { try { return JSON.parse(localStorage.getItem('fishcast.points')) || []; } catch (_) { return []; } },
  store(list) { localStorage.setItem('fishcast.points', JSON.stringify(list)); },
};

function renderPoints() {
  const sel = $('points');
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = ''; ph.textContent = 'Сохранённые точки…'; sel.appendChild(ph);
  for (const p of Points.all()) {
    const o = document.createElement('option');
    o.value = `${p.lat},${p.lon}`; o.textContent = p.name; sel.appendChild(o);
  }
  // выбрать текущую, если совпадает с сохранённой
  const cur = S.lat !== null ? `${S.lat},${S.lon}` : '';
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : '';
  $('del-point').hidden = !sel.value;
}

$('points').addEventListener('change', () => {
  const v = $('points').value;
  $('del-point').hidden = !v;
  if (!v) return;
  const [lat, lon] = v.split(',').map(Number);
  map.setView([lat, lon], Math.max(map.getZoom(), 10));
  setPoint(lat, lon);
});

$('save-point').addEventListener('click', () => {
  if (S.lat === null) return status('Сначала поставь точку на карте.', true);
  const def = `${S.lat.toFixed(4)}, ${S.lon.toFixed(4)}`;
  const name = (prompt('Название точки', def) || '').trim();
  if (!name) return;
  const list = Points.all().filter(p => !(p.lat === S.lat && p.lon === S.lon));
  list.push({ name, lat: S.lat, lon: S.lon });
  Points.store(list);
  renderPoints();
  scheduleSync();
});

$('del-point').addEventListener('click', () => {
  const v = $('points').value;
  if (!v) return;
  const [lat, lon] = v.split(',').map(Number);
  Points.store(Points.all().filter(p => !(p.lat === lat && p.lon === lon)));
  renderPoints();
  scheduleSync();
});

// --- загрузка и расчёт ---
function status(text, isError) {
  const el = $('status');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

async function load() {
  status('Загружаю прогноз…');
  $('forecast').hidden = true;
  try {
    S.data = await Weather.fetch(S.lat, S.lon);
    compute();
    // дни: прошедшие (past_days) + прогнозные; по умолчанию выбран сегодняшний
    S.dayKeys = Object.keys(S.data.days).sort();
    S.dayIdx = Math.max(0, S.dayKeys.indexOf(todayKey()));
    S.hourIdx = null;
    status('');
    $('forecast').hidden = false;
    renderAll();
  } catch (e) {
    status('Не удалось загрузить погоду: ' + e.message + '. Проверь интернет и попробуй ещё раз.', true);
  }
}

function compute() {
  S.data.waterTemp = WaterTemp.series(S.data.hours, S.waterbody);
  const ctx = { lat: S.lat, lon: S.lon, species: S.species };
  S.results = S.data.hours.map((_, i) => Scoring.hour(i, S.data, ctx));
}

function dayHours(key) {
  const out = [];
  S.data.hours.forEach((h, i) => { if (h.iso.startsWith(key)) out.push(i); });
  return out;
}

// --- отрисовка ---
function renderAll() { renderDayparts(); renderDays(); renderDay(); }

function renderDays() {
  const nav = $('days');
  nav.innerHTML = '';
  const tk = todayKey();
  const test = daypartTest();
  S.dayKeys.forEach((key, idx) => {
    const d = new Date(key);
    const idxs = dayHours(key);
    const inRange = idxs.filter(i => test(S.data.hours[i].time.getHours()));
    const best = Math.max(...(inRange.length ? inRange : idxs).map(i => S.results[i].score));
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'day';
    if (key < tk) b.classList.add('past');
    b.setAttribute('aria-current', idx === S.dayIdx ? 'true' : 'false');
    b.innerHTML = `<small>${DOW[d.getDay()]}</small><b>${d.getDate()}</b><span class="dot" style="background:${dotColor(best)}"></span>`;
    b.addEventListener('click', () => { S.dayIdx = idx; S.hourIdx = null; renderAll(); });
    nav.appendChild(b);
  });
  // прокрутить ленту к выбранному дню (прошедшие уводят сегодня за левый край)
  const cur = nav.querySelector('[aria-current="true"]');
  if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function dotColor(score) {
  const c = CONFIG.categories;
  if (score >= c[0].from) return 'var(--amber)';
  if (score >= c[1].from) return 'var(--amber-dim)';
  if (score >= c[2].from) return '#4f6474';
  return 'var(--silt)';
}

function renderDay() {
  const key = S.dayKeys[S.dayIdx];
  const d = new Date(key);
  const idxs = dayHours(key);
  const dayRes = idxs.map(i => S.results[i]);
  const dayInfo = S.data.days[key];

  $('day-title').textContent = `${DOW_FULL[d.getDay()]}, ${d.getDate()} ${MONTH[d.getMonth()]}`;
  const sr = dayInfo ? `${pad(dayInfo.sunrise.getHours())}:${pad(dayInfo.sunrise.getMinutes())}` : '—';
  const ss = dayInfo ? `${pad(dayInfo.sunset.getHours())}:${pad(dayInfo.sunset.getMinutes())}` : '—';
  $('day-meta').textContent = `Солнце ${sr}–${ss}, ${Solunar.phaseName(d)}` +
    (key < todayKey() ? ' · прошедший день (факт погоды)' : '');

  const ban = $('ban');
  ban.hidden = !Scoring.inSpawningBan(d);
  ban.textContent = CONFIG.spawningBan.text;

  renderDaySummary(idxs);

  // окна клёва
  const dayMax = Math.max(...dayRes.map(r => r.score));
  const w = Scoring.windows(dayRes, Math.max(CONFIG.categories[1].from, dayMax - 14)); // окна — лучшие часы дня, не всё подряд
  const wEl = $('windows');
  wEl.innerHTML = w.length
    ? 'Окна: ' + w.map(x => `<span class="w">${pad(x.from)}–${pad(x.to + 1)} · до ${x.max}</span>`).join('')
    : '<span class="none">Явных окон нет, день ровный или слабый.</span>';

  // столбики
  const bars = $('bars');
  bars.innerHTML = '';
  const test = daypartTest();
  idxs.forEach((i, hour) => {
    const r = S.results[i];
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'bar'; b.setAttribute('role', 'listitem');
    b.dataset.cat = r.category;
    if (!test(hour)) b.classList.add('off'); // вне выбранных часов рыбалки
    if (r.period) b.classList.add(r.period.type);
    b.title = `${pad(hour)}:00 — ${r.score}`;
    b.setAttribute('aria-label', `${pad(hour)}:00, оценка ${r.score}, ${r.category}`);
    b.innerHTML = `<i style="height:${Math.max(4, r.score)}%"></i>`;
    b.addEventListener('click', () => { S.hourIdx = i; renderHour(); markBar(); });
    bars.appendChild(b);
  });

  // час по умолчанию: лучший среди выбранных часов рыбалки (иначе — по всему дню)
  if (S.hourIdx === null || !idxs.includes(S.hourIdx)) {
    const pool = idxs.filter(i => test(S.data.hours[i].time.getHours()));
    S.hourIdx = (pool.length ? pool : idxs).reduce((a, b) => (S.results[b].score > S.results[a].score ? b : a));
  }
  renderHour();
  markBar();
}

// Погода дня одной строкой: диапазоны вместо почасовой простыни
function renderDaySummary(idxs) {
  const hs = idxs.map(i => S.data.hours[i]);
  const tMin = Math.min(...hs.map(h => h.temp)), tMax = Math.max(...hs.map(h => h.temp));
  const wMin = Math.min(...hs.map(h => h.wind)), wMax = Math.max(...hs.map(h => h.wind));
  const gMax = Math.max(...hs.map(h => h.gust));
  // преобладающее направление — среднее векторное, иначе С и СЗ усреднились бы в чушь
  let sx = 0, sy = 0;
  hs.forEach(h => { const a = h.windDir * Math.PI / 180; sx += Math.sin(a); sy += Math.cos(a); });
  const dir = dirName((Math.atan2(sx, sy) * 180 / Math.PI + 360) % 360);
  const dP = hs[hs.length - 1].pressure - hs[0].pressure;
  const pTxt = Math.abs(dP) < 2 ? 'ровное' : dP > 0 ? `растёт, +${dP.toFixed(0)} гПа` : `падает, ${dP.toFixed(0)} гПа`;
  const rain = hs.reduce((s, h) => s + h.precip, 0);
  const cloudAvg = hs.reduce((s, h) => s + h.cloud, 0) / hs.length;
  const sky = cloudAvg >= 70 ? 'пасмурно' : cloudAvg >= 35 ? 'переменная облачность' : 'ясно';
  const parts = [
    `${Math.round(tMin)}…${Math.round(tMax)}°, ${sky}`,
    `ветер ${wMin.toFixed(0)}–${wMax.toFixed(0)} м/с ${dir}` +
      (gMax >= CONFIG.wind.gustyFrom ? `, порывы до ${gMax.toFixed(0)}` : ''),
    `давление ${pTxt}`,
    rain >= 0.2 ? `осадки ${rain.toFixed(1)} мм` : 'без осадков',
  ];
  if (S.data.waterTemp) parts.push(`вода ~${S.data.waterTemp[idxs[Math.min(12, idxs.length - 1)]].toFixed(0)}°`);
  $('day-summary').innerHTML = parts.map(p => `<span>${p}</span>`).join('');
}

function markBar() {
  const key = S.dayKeys[S.dayIdx];
  const idxs = dayHours(key);
  [...$('bars').children].forEach((b, hour) => b.setAttribute('aria-current', idxs[hour] === S.hourIdx ? 'true' : 'false'));
}

function renderHour() {
  const h = S.data.hours[S.hourIdx];
  const r = S.results[S.hourIdx];
  $('hour-time').textContent = `${pad(h.time.getHours())}:00`;
  $('hour-score').innerHTML = `${r.score}<small>${r.category}</small>`;
  $('hour-weather').textContent =
    `${h.temp.toFixed(0)}°, ${h.pressure.toFixed(0)} гПа, ветер ${h.wind.toFixed(0)} м/с ${dirName(h.windDir)}, облачность ${h.cloud}%` +
    (h.precip > 0 ? `, осадки ${h.precip} мм` : '') +
    (S.data.waterTemp ? `, вода ~${S.data.waterTemp[S.hourIdx].toFixed(0)}°` : '');
  const ul = $('factors');
  ul.innerHTML = '';
  [...r.factors].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).forEach(f => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="d ${f.delta > 0 ? 'plus' : 'minus'}">${f.delta > 0 ? '+' : ''}${f.delta}</span>` +
      `<span>${f.name}<div class="t">${f.text}</div></span>`;
    ul.appendChild(li);
  });
  if (!r.factors.length) ul.innerHTML = '<li><span class="d">0</span><span>Нет выраженных факторов</span></li>';
}

function dirName(deg) {
  const n = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
  return n[Math.round(deg / 45) % 8];
}

// --- журнал рыбалок: запись = факт + снапшот всех факторов на этот час ---
const Journal = {
  all() { try { return JSON.parse(localStorage.getItem('fishcast.journal')) || []; } catch (_) { return []; } },
  store(list) { localStorage.setItem('fishcast.journal', JSON.stringify(list)); },
};

$('log-add').addEventListener('click', () => {
  if (S.hourIdx === null || !S.data) return;
  const rating = parseInt(prompt('Клёв по факту, 1–5', '3'), 10);
  if (!(rating >= 1 && rating <= 5)) return;
  const note = (prompt('Заметка: снасть, улов (можно пусто)', '') || '').trim();
  const h = S.data.hours[S.hourIdx];
  const r = S.results[S.hourIdx];
  const list = Journal.all();
  list.unshift({
    ts: new Date().toISOString(),
    hourIso: h.iso,
    lat: S.lat, lon: S.lon,
    species: S.species, waterbody: S.waterbody,
    configVersion: CONFIG.version,
    score: r.score, factors: r.factors,        // снапшот для будущей калибровки весов
    weather: { temp: h.temp, pressure: h.pressure, wind: h.wind, windDir: h.windDir, cloud: h.cloud, precip: h.precip },
    waterTemp: S.data.waterTemp ? +S.data.waterTemp[S.hourIdx].toFixed(1) : null,
    rating, note,
  });
  Journal.store(list);
  renderJournal();
  scheduleSync();
});

$('log-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(Journal.all(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'fishcast-journal.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

function renderJournal() {
  const list = Journal.all();
  $('journal-sec').hidden = list.length === 0;
  const ul = $('journal');
  ul.innerHTML = '';
  list.forEach((e, idx) => {
    const d = new Date(e.hourIso);
    const sp = CONFIG.species[e.species];
    const li = document.createElement('li');
    li.innerHTML =
      `<div class="j-row"><b>${d.getDate()} ${MONTH[d.getMonth()]} ${pad(d.getHours())}:00</b>` +
      `<span>${sp ? sp.name : e.species}</span>` +
      `<span class="j-cmp">прогноз ${e.score} · факт ${'★'.repeat(e.rating)}${'☆'.repeat(5 - e.rating)}</span>` +
      `<button type="button" class="j-del" aria-label="Удалить запись">✕</button></div>` +
      (e.note ? `<div class="j-note">${e.note.replace(/</g, '&lt;')}</div>` : '');
    li.querySelector('.j-del').addEventListener('click', () => {
      if (!confirm('Удалить запись из журнала?')) return;
      const l = Journal.all(); l.splice(idx, 1); Journal.store(l); renderJournal(); scheduleSync();
    });
    ul.appendChild(li);
  });
}

// --- синхронизация с бэкендом (если настроен CONFIG.apiBase) ---
// Слияние: точки — объединение по координатам, журнал — по метке времени записи.
async function syncNow(pullFirst) {
  if (!Api.loggedIn()) return;
  try {
    if (pullFirst) {
      const remote = await Api.pullState();
      const pts = Points.all();
      const seen = new Set(pts.map(p => `${p.lat},${p.lon}`));
      for (const p of remote.points || [])
        if (p && p.name && !seen.has(`${p.lat},${p.lon}`)) pts.push(p);
      Points.store(pts);
      const jr = Journal.all();
      const jseen = new Set(jr.map(e => e.ts));
      for (const e of remote.journal || [])
        if (e && e.ts && !jseen.has(e.ts)) jr.push(e);
      jr.sort((a, b) => (a.ts < b.ts ? 1 : -1));
      Journal.store(jr);
      renderPoints();
      renderJournal();
    }
    await Api.pushState(Points.all(), Journal.all());
  } catch (e) {
    console.warn('синхронизация:', e.message);
  }
}

let syncTimer = null;
function scheduleSync() {
  if (!Api.loggedIn()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(false), 2000);
}

function renderAuth() {
  const el = $('auth-area');
  if (!Api.ready) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '';
  if (Api.token) {
    const name = localStorage.getItem('fishcast.user') || '';
    el.innerHTML = `<span>Синхронизация включена${name ? ': ' + name : ''}</span> ` +
      `<button id="logout" type="button">Выйти</button>`;
    $('logout').addEventListener('click', () => { Api.logout(); renderAuth(); });
    return;
  }
  // вход по логину и паролю: без внешних сервисов, работает откуда угодно
  el.innerHTML =
    `<form id="auth-form" class="auth-form">
       <input id="auth-login" type="text" placeholder="логин" autocomplete="username" required>
       <input id="auth-pass" type="password" placeholder="пароль (от 8 символов)" autocomplete="current-password" required>
       <button type="submit">Войти</button>
       <button type="button" id="auth-reg">Создать аккаунт</button>
       <div class="auth-msg" id="auth-msg" hidden></div>
     </form>`;
  const doAuth = async action => {
    const msg = $('auth-msg');
    msg.hidden = true;
    try {
      await Api.auth(action, $('auth-login').value.trim(), $('auth-pass').value);
      renderAuth();
      await syncNow(true);
    } catch (e) {
      msg.hidden = false;
      msg.textContent = e.message;
    }
  };
  $('auth-form').addEventListener('submit', e => { e.preventDefault(); doAuth('login'); });
  $('auth-reg').addEventListener('click', () => doAuth('register'));
}

// --- резервная копия: до появления аккаунтов данные живут только в localStorage ---
const BACKUP_KEYS = ['fishcast.point', 'fishcast.points', 'fishcast.species',
  'fishcast.waterbody', 'fishcast.journal', 'fishcast.daypart'];

$('backup-save').addEventListener('click', () => {
  const data = {};
  for (const k of BACKUP_KEYS) { const v = localStorage.getItem(k); if (v !== null) data[k] = v; }
  const blob = new Blob(
    [JSON.stringify({ app: 'fishcast', version: CONFIG.version, saved: new Date().toISOString(), data }, null, 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fishcast-backup-${dateKey(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('backup-load').addEventListener('click', () => $('backup-file').click());
$('backup-file').addEventListener('change', async () => {
  const f = $('backup-file').files[0];
  $('backup-file').value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (j.app !== 'fishcast' || !j.data) throw new Error('это не копия FishCast');
    if (!confirm('Заменить текущие точки, журнал и настройки данными из файла?')) return;
    for (const [k, v] of Object.entries(j.data))
      if (BACKUP_KEYS.includes(k) && typeof v === 'string') localStorage.setItem(k, v);
    location.reload();
  } catch (e) {
    alert('Не удалось восстановить: ' + e.message);
  }
});

// --- старт ---
(function init() {
  renderPoints();
  renderJournal();
  // Kp подтягивается в фоне; когда придёт — пересчитать, если прогноз уже на экране
  Kp.load().then(() => { if (Kp.ready && S.data) { compute(); renderAll(); } });
  // бэкенд (если настроен): проба health, кнопка входа, стартовый синк
  Api.init().then(() => { renderAuth(); if (Api.loggedIn()) syncNow(true); });
  const saved = localStorage.getItem('fishcast.point');
  if (saved) {
    try { const p = JSON.parse(saved); map.setView([p.lat, p.lon], 10); setPoint(p.lat, p.lon); return; } catch (_) {}
  }
  status('Тапни точку на карте или нажми «Где я».');
})();
