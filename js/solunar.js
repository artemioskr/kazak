// Солунарные периоды по SunCalc.
// major — ±1 ч от верхней и нижней кульминации Луны (экстремумы высоты над горизонтом),
// minor — ±30 мин от восхода и захода Луны.
const Solunar = {
  _cache: {},

  // Кульминации за сутки от локальной полуночи: сэмплируем высоту Луны каждые 5 минут.
  transits(dayStart, lat, lon) {
    const step = 5 * 60000;
    const pts = [];
    for (let t = dayStart.getTime() - step; t <= dayStart.getTime() + 86400000 + step; t += step) {
      pts.push({ t, alt: SunCalc.getMoonPosition(new Date(t), lat, lon).altitude });
    }
    const out = [];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1].alt, b = pts[i].alt, c = pts[i + 1].alt;
      if (b > a && b >= c) out.push({ type: 'upper', t: new Date(pts[i].t) });
      if (b < a && b <= c) out.push({ type: 'lower', t: new Date(pts[i].t) });
    }
    return out.filter(x => x.t >= dayStart && x.t < new Date(dayStart.getTime() + 86400000));
  },

  periods(dayStart, lat, lon) {
    const key = dayStart.toDateString() + lat.toFixed(3) + lon.toFixed(3);
    if (this._cache[key]) return this._cache[key];
    const H = 3600000;
    const res = [];
    for (const tr of this.transits(dayStart, lat, lon)) {
      res.push({ type: 'major', start: new Date(tr.t - H), end: new Date(tr.t.getTime() + H), peak: tr.t });
    }
    const mt = SunCalc.getMoonTimes(dayStart, lat, lon);
    for (const ev of [mt.rise, mt.set]) {
      if (ev) res.push({ type: 'minor', start: new Date(ev - H / 2), end: new Date(ev.getTime() + H / 2), peak: ev });
    }
    res.sort((a, b) => a.start - b.start);
    this._cache[key] = res;
    return res;
  },

  // Какой период накрывает данный час (проверяем середину часа)
  at(time, lat, lon) {
    const day = new Date(time); day.setHours(0, 0, 0, 0);
    const mid = new Date(time.getTime() + 30 * 60000);
    // периоды могут начинаться в предыдущих сутках и заканчиваться в следующих — смотрим 3 дня
    for (const off of [-1, 0, 1]) {
      const d = new Date(day.getTime() + off * 86400000);
      for (const p of this.periods(d, lat, lon)) {
        if (mid >= p.start && mid < p.end) return p;
      }
    }
    return null;
  },

  phase(date) { return SunCalc.getMoonIllumination(date).phase; }, // 0 новолуние, 0.5 полнолуние

  // Дней до ближайшего новолуния/полнолуния (по модулю). Лунный месяц ≈ 29.53 дня.
  daysToSyzygy(date) {
    const p = this.phase(date);
    const d = Math.min(p, Math.abs(p - 0.5), 1 - p);
    return d * 29.53;
  },

  phaseName(date) {
    const p = this.phase(date);
    if (p < 0.03 || p > 0.97) return 'новолуние';
    if (p < 0.22) return 'растущий серп';
    if (p < 0.28) return 'первая четверть';
    if (p < 0.47) return 'растущая луна';
    if (p < 0.53) return 'полнолуние';
    if (p < 0.72) return 'убывающая луна';
    if (p < 0.78) return 'последняя четверть';
    return 'убывающий серп';
  },
};
