// Open-Meteo. Возвращает почасовые ряды, включая 2 прошлых дня для тренда давления.
const Weather = {
  async fetch(lat, lon) {
    // через бэкенд, если он доступен: кэш щадит лимиты Open-Meteo
    if (typeof Api !== 'undefined' && Api.ready) {
      try {
        const r = await fetch(`${Api.base}/api/weather?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
        if (r.ok) return Weather.normalize(await r.json());
      } catch (_) { /* упал — идём напрямую */ }
    }
    const p = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      hourly: [
        'temperature_2m', 'pressure_msl', 'wind_speed_10m', 'wind_direction_10m',
        'wind_gusts_10m', 'cloud_cover', 'precipitation', 'weather_code',
      ].join(','),
      daily: 'sunrise,sunset',
      timezone: 'auto',
      past_days: 7,   // архив: тренд давления (2 суток) + разгон модели температуры воды
      forecast_days: 7,
      wind_speed_unit: 'ms',
    });
    const r = await fetch('https://api.open-meteo.com/v1/forecast?' + p.toString());
    if (!r.ok) throw new Error('Open-Meteo ответил ' + r.status);
    const j = await r.json();
    return Weather.normalize(j);
  },

  // Приводим к удобному виду: массив часов + карта дней
  normalize(j) {
    const h = j.hourly;
    const hours = h.time.map((t, i) => ({
      time: new Date(t),          // локальное время точки, парсится как локальное браузера
      iso: t,
      temp: h.temperature_2m[i],
      pressure: h.pressure_msl[i],
      wind: h.wind_speed_10m[i],
      windDir: h.wind_direction_10m[i],
      gust: h.wind_gusts_10m[i],
      cloud: h.cloud_cover[i],
      precip: h.precipitation[i],
      code: h.weather_code[i],
    }));
    const days = {};
    j.daily.time.forEach((d, i) => {
      days[d] = { sunrise: new Date(j.daily.sunrise[i]), sunset: new Date(j.daily.sunset[i]) };
    });
    return { hours, days, timezone: j.timezone, elevation: j.elevation, pastDays: 7 };
  },
};
