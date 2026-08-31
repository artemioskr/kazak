// Kp-индекс: прогноз NOAA SWPC (3-часовые интервалы, UTC).
// Слабый фактор с graceful degradation: не загрузился — Kp.ready=false, скоринг его не трогает.
const Kp = {
  ready: false,
  _map: {}, // 'YYYY-MM-DDTHH' (UTC, кратно 3 ч) -> kp

  async load() {
    try {
      const r = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json');
      if (!r.ok) return;
      const rows = await r.json(); // [time_tag, kp, observed, noaa_scale], первая строка — заголовок
      for (const row of rows.slice(1)) {
        const key = row[0].replace(' ', 'T').slice(0, 13);
        this._map[key] = parseFloat(row[1]);
      }
      this.ready = Object.keys(this._map).length > 0;
    } catch (_) { /* нет сети до NOAA — фактор выключен */ }
  },

  // Kp для момента времени: округляем UTC-час вниз до 3-часового интервала.
  at(date) {
    const h3 = Math.floor(date.getUTCHours() / 3) * 3;
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h3));
    const v = this._map[d.toISOString().slice(0, 13)];
    return v === undefined ? null : v;
  },
};
