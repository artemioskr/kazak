// Интерфейс MVP. Состояние — в объекте S, отрисовка — функциями render*.
const S = {
  lat: null, lon: null,
  species: 'zander',
  waterbody: CONFIG.waterTemp.default,
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
});

$('del-point').addEventListener('click', () => {
  const v = $('points').value;
  if (!v) return;
  const [lat, lon] = v.split(',').map(Number);
  Points.store(Points.all().filter(p => !(p.lat === lat && p.lon === lon)));
  renderPoints();
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
function renderAll() { renderDays(); renderDay(); }

function renderDays() {
  const nav = $('days');
  nav.innerHTML = '';
  const tk = todayKey();
  S.dayKeys.forEach((key, idx) => {
    const d = new Date(key);
    const idxs = dayHours(key);
    const best = Math.max(...idxs.map(i => S.results[i].score));
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
  idxs.forEach((i, hour) => {
    const r = S.results[i];
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'bar'; b.setAttribute('role', 'listitem');
    b.dataset.cat = r.category;
    if (r.period) b.classList.add(r.period.type);
    b.title = `${pad(hour)}:00 — ${r.score}`;
    b.setAttribute('aria-label', `${pad(hour)}:00, оценка ${r.score}, ${r.category}`);
    b.innerHTML = `<i style="height:${Math.max(4, r.score)}%"></i>`;
    b.addEventListener('click', () => { S.hourIdx = i; renderHour(); markBar(); });
    bars.appendChild(b);
  });

  // час по умолчанию: лучший в дне
  if (S.hourIdx === null || !idxs.includes(S.hourIdx)) {
    S.hourIdx = idxs[dayRes.indexOf(dayRes.reduce((a, b) => (b.score > a.score ? b : a)))];
  }
  renderHour();
  markBar();
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
      const l = Journal.all(); l.splice(idx, 1); Journal.store(l); renderJournal();
    });
    ul.appendChild(li);
  });
}

// --- старт ---
(function init() {
  renderPoints();
  renderJournal();
  // Kp подтягивается в фоне; когда придёт — пересчитать, если прогноз уже на экране
  Kp.load().then(() => { if (Kp.ready && S.data) { compute(); renderAll(); } });
  const saved = localStorage.getItem('fishcast.point');
  if (saved) {
    try { const p = JSON.parse(saved); map.setView([p.lat, p.lon], 10); setPoint(p.lat, p.lon); return; } catch (_) {}
  }
  status('Тапни точку на карте или нажми «Где я».');
})();
