// Работа с бэкендом (backend/). CONFIG.apiBase == null → всё выключено,
// приложение полностью живёт на localStorage, как и раньше. Graceful degradation:
// бэкенд недоступен — молча работаем локально.
const Api = {
  base: null,
  token: null,
  ready: false,   // health прошёл — можно ходить в API

  async init() {
    this.base = CONFIG.apiBase ?? null;
    if (this.base === null) return;
    this.token = localStorage.getItem('fishcast.token');
    try {
      const r = await fetch(this.base + '/api/health', { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      this.ready = !!(j.ok && j.db);
    } catch (_) { this.ready = false; }
  },

  loggedIn() { return this.ready && !!this.token; },

  async call(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    const r = await fetch(this.base + path, Object.assign({}, opts, { headers }));
    if (r.status === 401) { this.logout(); throw new Error('сессия истекла, войди заново'); }
    if (!r.ok) {
      let msg = 'API ответил ' + r.status;
      try { msg = (await r.json()).error || msg; } catch (_) {}
      throw new Error(msg);
    }
    return r.json();
  },

  // action: 'login' или 'register'
  async auth(action, login, password) {
    const j = await this.call('/api/auth/' + action, {
      method: 'POST',
      body: JSON.stringify({ login, password }),
    });
    this.token = j.token;
    localStorage.setItem('fishcast.token', j.token);
    localStorage.setItem('fishcast.user', j.name);
    return j;
  },

  logout() {
    this.token = null;
    localStorage.removeItem('fishcast.token');
    localStorage.removeItem('fishcast.user');
  },

  pullState() { return this.call('/api/state'); },
  pushState(points, journal) {
    return this.call('/api/state', { method: 'PUT', body: JSON.stringify({ points, journal }) });
  },
};
