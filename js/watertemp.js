// Модель температуры воды v0: экспоненциальное сглаживание температуры воздуха
// с постоянной времени по типу водоёма (CONFIG.waterTemp.tauDays, в днях).
// Это грубая оценка: нет ни ледостава, ни притока, ни ветрового перемешивания.
// Инициализация — среднее за первые сутки архива, поэтому чем длиннее past_days,
// тем честнее хвост. Позже добавится ручная поправка «померил на рыбалке» (этап 2).
const WaterTemp = {
  series(hours, waterbody) {
    const tau = CONFIG.waterTemp.tauDays[waterbody] || CONFIG.waterTemp.tauDays[CONFIG.waterTemp.default];
    const alpha = 1 / (tau * 24); // шаг — час
    const init = hours.slice(0, 24);
    let t = init.reduce((s, h) => s + h.temp, 0) / init.length;
    return hours.map(h => (t += alpha * (h.temp - t)));
  },
};
