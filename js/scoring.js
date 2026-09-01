// Скоринг активности рыбы. Каждый фактор возвращает вклад и объяснение.
// Формат {score, factors:[{name, delta, text}]} — не менять, на нём держится расшифровка и калибровка.
const Scoring = {
  hour(i, data, ctx) {
    const h = data.hours[i];
    const sp = CONFIG.species[ctx.species];
    const factors = [];
    const add = (name, delta, text) => { delta = Math.round(delta); if (delta !== 0) factors.push({ name, delta, text }); };

    // 1. Сезон
    const m = h.time.getMonth();
    add('Сезон', sp.season[m], sp.season[m] >= 0 ? 'сезонная активность вида' : 'вне сезона для вида');

    // 2. Температура воздуха (прокси температуры воды до появления модели)
    if (h.temp >= sp.tempAir.hotFrom) add('Жара', sp.tempAir.hotPenalty, `${h.temp.toFixed(0)}°, рыба вялая`);
    else if (h.temp < 3 && sp.tempAir.cold) add('Холод', sp.tempAir.cold, `${h.temp.toFixed(0)}°`);

    // 2б. Температура воды (модель v0, если посчитана)
    if (data.waterTemp && sp.waterOpt) this.waterTemp(i, data, sp, add);

    // 3. Тренд давления
    this.pressure(i, data, sp, add);

    // 3б. Фронт: скачок давления + разворот ветра / скачок T
    this.front(i, data, sp, add);

    // 4. Ветер
    this.wind(h, sp, add);

    // 5. Облачность и время суток
    const day = data.days[h.iso.slice(0, 10)];
    const hr = h.time.getHours();
    const P = CONFIG.timeOfDay;
    let twilight = false;
    if (day) {
      const dSun = Math.min(Math.abs(h.time - day.sunrise), Math.abs(h.time - day.sunset)) / 3600000;
      twilight = dSun <= P.twilightHours;
      const isNight = h.time < day.sunrise || h.time > day.sunset;
      if (twilight) add('Сумерки', P.weights.twilight, 'рассвет или закат');
      else if (isNight) add('Ночь', sp.night ? P.weights.night : P.weights.nightNoNight,
        sp.night ? 'вид активен ночью' : 'вид ночью почти не кормится');
      else if (hr >= P.middayFrom && hr < P.middayTo) add('Полдень', P.weights.midday, 'дневной провал');
    }
    const C = CONFIG.cloud.weights;
    if (h.cloud >= 70) add('Облачно', C.overcast * sp.cloud, `${h.cloud}% облаков`);
    else if (h.cloud >= 35) add('Переменно', C.partly * sp.cloud, `${h.cloud}% облаков`);
    else if (!twilight && hr >= 10 && hr < 17) add('Ясно днём', C.clearMidday * sp.cloud, 'яркое солнце, рыба уходит в тень');

    // 6. Осадки
    const R = CONFIG.precipitation;
    if (h.precip >= R.heavyFrom) add('Ливень', R.weights.heavy, `${h.precip} мм/ч, муть и шум`);
    else if (h.precip > 0.1 && h.precip <= R.lightMax) add('Дождик', R.weights.light, `${h.precip} мм/ч`);

    // 6б. Kp-индекс (если данные загрузились; нет данных — фактор выключен)
    if (typeof Kp !== 'undefined' && Kp.ready) {
      const kp = Kp.at(h.time);
      if (kp !== null && kp >= CONFIG.kp.stormFrom)
        add('Магнитная буря', CONFIG.kp.weights.storm, `Kp ${kp.toFixed(0)}`);
    }

    // 7. Солунар
    const S = CONFIG.solunar;
    const per = Solunar.at(h.time, ctx.lat, ctx.lon);
    if (per) add(per.type === 'major' ? 'Major-период' : 'Minor-период',
      (per.type === 'major' ? S.weights.major : S.weights.minor) * sp.solunar,
      per.type === 'major' ? 'Луна в кульминации' : 'восход или заход Луны');
    if (Solunar.daysToSyzygy(h.time) <= S.phaseWindowDays)
      add('Фаза Луны', S.weights.phaseBonus * sp.solunar, Solunar.phaseName(h.time));

    const raw = CONFIG.baseline + factors.reduce((s, f) => s + f.delta, 0);
    const score = Math.max(0, Math.min(100, Math.round(raw)));
    return { score, factors, category: this.category(score), period: per };
  },

  pressure(i, data, sp, add) {
    const P = CONFIG.pressure, W = P.weights, k = sp.pressure;
    const h = data.hours[i];
    const p6 = data.hours[i - 6], p24 = data.hours[i - 24];
    if (!p6) return;
    const d6 = h.pressure - p6.pressure;
    const s6 = (d6 > 0 ? '+' : '') + d6.toFixed(1);
    if (Math.abs(d6) > P.sharpBand) add('Скачок давления', W.sharp * k, `${s6} гПа за 6 ч`);
    else if (d6 <= -P.stableBand && d6 >= -P.slowFallMax) add('Давление падает', W.slowFall * k, `${s6} гПа за 6 ч, плавно`);
    else if (Math.abs(d6) < P.stableBand) add('Давление стабильно', W.stable * k, `${s6} гПа за 6 ч`);
    else if (d6 > 0) add('Давление растёт', W.slowRise * k, `${s6} гПа за 6 ч`);
    if (p24) {
      const d24 = h.pressure - p24.pressure;
      if (Math.abs(d24) > P.day24Bad) add('Нестабильные сутки', W.day24 * k, `${d24 > 0 ? '+' : ''}${d24.toFixed(1)} гПа за 24 ч`);
    }
  },

  // Температура воды против оптимума вида. Границы мягкие: nearBand — переходная зона.
  waterTemp(i, data, sp, add) {
    const W = CONFIG.waterTemp;
    const t = data.waterTemp[i];
    const [lo, hi] = sp.waterOpt;
    const txt = `вода ~${t.toFixed(0)}°, оптимум ${lo}–${hi}°`;
    if (t >= lo && t <= hi) add('Вода в оптимуме', W.weights.opt, txt);
    else {
      const dist = t < lo ? lo - t : t - hi;
      if (dist > W.nearBand) add(t < lo ? 'Вода холодная' : 'Вода тёплая', W.weights.off, txt);
      else if (W.weights.near) add('Вода на грани оптимума', W.weights.near, txt);
    }
  },

  // Часы прохождения фронта: |ΔP| за окно >= pressureJump И (разворот ветра ИЛИ скачок T).
  // Кэш на объекте данных — прогноз один на все виды.
  detectFronts(data) {
    if (data._fronts) return data._fronts;
    const F = CONFIG.front, w = F.window;
    data._fronts = data.hours.map((h, i) => {
      const p = data.hours[i - w];
      if (!p) return false;
      if (Math.abs(h.pressure - p.pressure) < F.pressureJump) return false;
      let turn = Math.abs(h.windDir - p.windDir) % 360;
      if (turn > 180) turn = 360 - turn;
      return turn >= F.windTurn || Math.abs(h.temp - p.temp) >= F.tempJump;
    });
    return data._fronts;
  },

  front(i, data, sp, add) {
    const F = CONFIG.front, k = sp.pressure;
    const fronts = this.detectFronts(data);
    if (fronts[i]) { add('Фронт проходит', F.weights.during * k, 'смена давления с разворотом ветра или скачком T'); return; }
    for (let d = 1; d <= F.horizonBefore; d++)
      if (fronts[i + d]) { add('Перед фронтом', F.weights.before * k, `фронт через ~${d} ч, окно активности`); return; }
    for (let d = 1; d <= F.afterHours; d++)
      if (fronts[i - d]) { add('После фронта', F.weights.after * k, `фронт прошёл ~${d} ч назад`); return; }
  },

  wind(h, sp, add) {
    const W = CONFIG.wind, w = W.weights, k = sp.wind, v = h.wind;
    const summer = [5, 6, 7].includes(h.time.getMonth());
    if (v >= W.stormFrom) add('Шторм', w.storm * k, `${v.toFixed(0)} м/с, порывы ${h.gust.toFixed(0)}`);
    else if (v >= W.strongFrom) add('Сильный ветер', w.strong * k, `${v.toFixed(0)} м/с, порывы ${h.gust.toFixed(0)}`);
    else if (h.gust >= W.gustyFrom) add('Порывистый ветер', w.gusty * k, `${v.toFixed(1)} м/с с порывами ${h.gust.toFixed(0)}, крутая волна`);
    else if (v >= W.goodMin && v <= W.goodMax) add('Ветер в меру', w.good * k, `${v.toFixed(1)} м/с, рябь`);
    else if (v <= W.calmMax && (!W.calmSummerOnly || summer)) add('Штиль', w.calm * k, 'зеркало, рыба осторожна');
  },

  category(score) {
    return CONFIG.categories.find(c => score >= c.from).label;
  },

  // Окна клёва за день: непрерывные отрезки часов с оценкой >= threshold
  windows(results, threshold = 60) {
    const out = [];
    let cur = null;
    results.forEach((r, i) => {
      if (r.score >= threshold) {
        if (!cur) cur = { from: i, to: i, max: r.score };
        else { cur.to = i; cur.max = Math.max(cur.max, r.score); }
      } else if (cur) { out.push(cur); cur = null; }
    });
    if (cur) out.push(cur);
    return out;
  },

  inSpawningBan(date) {
    const B = CONFIG.spawningBan;
    const y = date.getFullYear();
    const from = new Date(y, B.from.month - 1, B.from.day);
    const to = new Date(y, B.to.month - 1, B.to.day, 23, 59);
    return date >= from && date <= to;
  },
};
