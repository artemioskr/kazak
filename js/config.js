// Вся настройка модели живёт здесь. В коде скоринга — только формулы.
// Версия конфига нужна для будущей калибровки по журналу.
const CONFIG = {
  version: '0.2.0',
  baseline: 42,

  // Профили видов. multiplier — насколько сильно фактор влияет на этот вид.
  species: {
    zander: {
      name: 'Судак',
      kind: 'predator',
      night: true,            // ловится ночью
      cloud: 1.2,             // любит пасмурно
      wind: 1.0,
      pressure: 1.2,
      solunar: 1.0,
      season: [ -5, -5, 0, 8, 10, 6, 0, 3, 10, 12, 8, 2 ], // янв..дек
      tempAir: { cold: 0, hotFrom: 26, hotPenalty: -10 },
      waterOpt: [8, 20],        // оптимум температуры воды, °C
    },
    pike: {
      name: 'Щука',
      kind: 'predator',
      night: false,
      cloud: 1.3,
      wind: 1.1,
      pressure: 1.3,
      solunar: 0.9,
      season: [ 2, 0, 5, 10, 6, 2, -3, 0, 10, 14, 10, 4 ],
      tempAir: { cold: 0, hotFrom: 24, hotPenalty: -15 },
      waterOpt: [6, 18],        // оптимум температуры воды, °C
    },
    bersh: {
      name: 'Берш',
      kind: 'predator',
      night: true,
      cloud: 1.0,
      wind: 0.9,
      pressure: 1.1,
      solunar: 1.0,
      season: [ 0, -2, 2, 6, 6, 4, 2, 4, 8, 10, 8, 3 ],
      tempAir: { cold: 0, hotFrom: 27, hotPenalty: -8 },
      waterOpt: [8, 18],        // оптимум температуры воды, °C
    },
    perch: {
      name: 'Окунь',
      kind: 'predator',
      night: false,
      cloud: 0.8,
      wind: 1.0,
      pressure: 1.0,
      solunar: 1.0,
      season: [ 3, 2, 4, 6, 6, 8, 6, 8, 10, 8, 4, 4 ],
      tempAir: { cold: 0, hotFrom: 29, hotPenalty: -6 },
      waterOpt: [10, 22],        // оптимум температуры воды, °C
    },
    bream: {
      name: 'Лещ',
      kind: 'peaceful',
      night: true,
      cloud: 0.6,
      wind: 1.2,
      pressure: 1.4,
      solunar: 1.1,
      season: [ -2, -4, -2, 4, 10, 10, 8, 8, 6, 2, -2, -2 ],
      tempAir: { cold: -8, hotFrom: 30, hotPenalty: -5 },
      waterOpt: [12, 23],        // оптимум температуры воды, °C
    },
  },

  // Давление: пороги в гПа. Оценивается изменение за 6 и 24 ч.
  pressure: {
    stableBand: 1.5,        // |Δ6h| < 1.5 — стабильно
    slowFallMax: 4,         // −1.5..−4 за 6 ч — плавно падает (хорошо)
    sharpBand: 4,           // |Δ6h| > 4 — резкий скачок (плохо)
    day24Bad: 8,            // |Δ24h| > 8 — сутки нестабильности
    // stable — норма, а не событие: маленький бонус, иначе инфляция оценок
    // (при stable:8 на реальном прогнозе 38% часов выходили «отлично»)
    weights: { stable: 2, slowFall: 10, slowRise: 0, sharp: -16, day24: -8 },
  },

  // Детект фронта: скачок давления + (разворот ветра ИЛИ скачок температуры) за окно.
  // Фазы: перед фронтом хищник активизируется, прохождение и первые часы после — провал.
  front: {
    window: 6,          // ч, окно анализа
    pressureJump: 3.5,  // гПа за окно — обязательный признак
    windTurn: 60,       // градусов разворота за окно
    tempJump: 3,        // °C за окно
    horizonBefore: 8,   // за сколько часов до фронта включать бонус «перед фронтом»
    afterHours: 12,     // сколько часов после прохождения держать штраф
    weights: { before: 8, during: -6, after: -6 }, // during мал: скачок давления уже штрафуется отдельно
  },

  // Модель температуры воды v0: экспоненциальное сглаживание температуры воздуха.
  // tau — инерция водоёма в днях. Инициализация — среднее за первые сутки архива,
  // поэтому для водохранилища первые дни оценка грубая (нужен архив длиннее).
  waterTemp: {
    tauDays: { pond: 1.5, river: 3, reservoir: 6 },
    labels: { pond: 'пруд', river: 'река', reservoir: 'водохранилище' },
    default: 'reservoir',
    nearBand: 3,        // °C от границы оптимума — переходная зона
    // opt почти нейтрален: вода в оптимуме — норма; фактор ценен штрафом за отклонение
    weights: { opt: 2, near: 0, off: -10 },
  },

  // Kp-индекс (NOAA SWPC). Слабый фактор; нет данных — фактор просто выключен.
  kp: {
    stormFrom: 5,       // Kp >= 5 — магнитная буря
    weights: { storm: -5 },
  },

  // Ветер, м/с
  wind: {
    calmMax: 1.0,
    goodMin: 2, goodMax: 6,
    strongFrom: 9,
    stormFrom: 13,
    weights: { calm: -4, good: 6, moderate: 0, strong: -12, storm: -25 },
    calmSummerOnly: true,   // штиль штрафуем только в тёплый сезон (июн–авг)
  },

  cloud: {
    weights: { overcast: 6, partly: 2, clearMidday: -8 },
  },

  precipitation: {
    lightMax: 1.5,          // мм/ч
    heavyFrom: 4,
    weights: { light: 3, heavy: -12 },
  },

  timeOfDay: {
    twilightHours: 1.5,     // ±1.5 ч от восхода/заката
    weights: { twilight: 12, midday: -6, night: 4, nightNoNight: -6 },
    middayFrom: 11, middayTo: 15,
  },

  solunar: {
    weights: { major: 10, minor: 5, phaseBonus: 3 },
    phaseWindowDays: 2,     // ±2 дня от новолуния/полнолуния
  },

  // Нерестовый запрет — ПЛЕЙСХОЛДЕР. Уточнить по актуальным правилам рыболовства.
  spawningBan: {
    from: { month: 4, day: 25 },
    to: { month: 6, day: 5 },
    text: 'Возможен нерестовый запрет. Проверь правила рыболовства для своего региона.',
  },

  // Категории по итоговой оценке
  categories: [
    { from: 78, label: 'отлично' },
    { from: 62, label: 'хорошо' },
    { from: 42, label: 'средне' },
    { from: 0,  label: 'слабо' },
  ],

  defaultPoint: { lat: 56.30, lon: 53.20 }, // Нижнекамское вдхр., район Каракулино
};
