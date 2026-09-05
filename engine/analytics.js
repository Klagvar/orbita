/* Своя аналитика: подробные события игры на наш приёмник.
 *
 * Зачем. Панель площадки даёт только агрегаты — уникальные, запуски,
 * источники. Сколько человек играл, докуда дошёл, какие механики вообще
 * успел увидеть, почему реклама не показалась — этого там нет и не будет.
 * А чинить в игре надо именно то, что видно в этих цифрах.
 *
 * Как устроено. События копятся в буфере и уходят пачкой. Каждое
 * пронумеровано внутри сессии, приёмник кладёт их по ключу (сессия, номер)
 * и молча игнорирует повторы. Поэтому пересылать можно сколько угодно раз:
 * дубликаты не портят счёт, а непереданное переживает закрытие вкладки
 * в localStorage и уезжает при следующем заходе.
 *
 * Игрок опознаётся хешем vk_user_id, а не самим id. Нам нужно ровно две
 * вещи: отличать людей друг от друга и узнавать вернувшегося. Кто это
 * конкретно — не нужно, поэтому и не храним.
 *
 * Транспорт — text/plain. Так браузер считает запрос простым и не шлёт
 * предварительный OPTIONS, который на телефоне лишняя точка отказа.
 *
 * Синтаксис ES5 без ?. и ??: ВК крутит игры в WebView на старых Android.
 */
(function (global) {
  'use strict';

  /* Адрес приёмника. Пусто — аналитика молча выключена: игра работает,
     события просто никуда не идут. Это же и режим локальной отладки. */
  var ENDPOINT = 'https://178-20-44-237.sslip.io';

  var SCHEMA = 1;
  var Q_KEY = 'an_q';        // непереданные пачки
  var ID_KEY = 'an_id';      // запасной id игрока вне ВК
  var SEEN_KEY = 'an_seen';  // был ли этот игрок здесь раньше
  var MAX_BATCHES = 12;      // сколько пачек держим в очереди
  var MAX_EVENTS = 300;      // предохранитель от бесконечного буфера
  var FLUSH_MS = 30000;

  function now() { return Date.now ? Date.now() : new Date().getTime(); }

  function param(name) {
    var search = global.location.search || '';
    var pairs = search.replace(/^\?/, '').split('&');
    for (var i = 0; i < pairs.length; i++) {
      var kv = pairs[i].split('=');
      if (decodeURIComponent(kv[0]) === name) return decodeURIComponent(kv[1] || '');
    }
    return '';
  }

  function ls(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { global.localStorage.setItem(key, value); } catch (e) { /* приватный режим */ }
  }

  /* FNV-1a двумя разными затравками — 64 бита в hex. Это не криптография
     и не должно ею быть: задача хеша здесь только развести игроков. */
  function hash(str) {
    function fnv(seed) {
      var h = seed;
      for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        // h *= 16777619 без переполнения double
        h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
        h = h >>> 0;
      }
      return ('0000000' + h.toString(16)).slice(-8);
    }
    return fnv(2166136261) + fnv(1099511628);
  }

  function rid() {
    return hash(String(now()) + ':' + Math.random() + ':' +
      (global.navigator.userAgent || '')).slice(0, 12);
  }

  function Analytics() {
    this.on = false;
    this.meta = null;
    this.buf = [];
    this.idx = 0;
    this.t0 = now();
    this.timer = null;
  }

  /* Вызывать как можно раньше: до этого момента события копятся впустую. */
  Analytics.prototype.init = function (game) {
    if (this.meta) return this;

    var uid = param('vk_user_id');
    var known;
    if (uid) {
      known = 'vk:' + hash('u' + uid);
    } else {
      // Вне ВК (локально, Яндекс, прямой заход) — свой стабильный id.
      known = ls(ID_KEY);
      if (!known) { known = 'an:' + rid(); lsSet(ID_KEY, known); }
    }

    var back = ls(SEEN_KEY);
    lsSet(SEEN_KEY, String(now()));

    this.meta = {
      g: game,
      s: rid(),                       // сессия
      u: known,                       // игрок
      p: param('vk_platform') || 'web',
      r: param('vk_ref') || '',       // откуда пришёл: каталог, поиск, ссылка
      l: param('vk_language') || (global.navigator.language || '').slice(0, 2),
      w: (global.innerWidth || 0) + 'x' + (global.innerHeight || 0),
      v: SCHEMA
    };
    this.on = !!ENDPOINT;

    var self = this;
    // Уход со страницы — последний шанс отправить хвост сессии.
    function bye() { self.event('end', { dur: Math.round((now() - self.t0) / 1000) }); self.flush(true); }
    global.addEventListener('pagehide', bye, false);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) self.flush(true);
    }, false);
    this.timer = global.setInterval(function () { self.flush(false); }, FLUSH_MS);

    this.event('boot', { back: back ? 1 : 0 });
    this.flush(false);   // заодно вытолкнет хвосты прошлых сессий
    return this;
  };

  Analytics.prototype.event = function (name, data) {
    if (!this.meta || this.buf.length >= MAX_EVENTS) return;
    this.buf.push({
      i: this.idx++,
      t: now() - this.t0,
      n: name,
      d: data || {}
    });
  };

  /* --- Очередь ------------------------------------------------------- */

  Analytics.prototype._queue = function () {
    var raw = ls(Q_KEY);
    if (!raw) return [];
    try {
      var q = JSON.parse(raw);
      return q && q.length ? q : [];
    } catch (e) { return []; }
  };

  Analytics.prototype._store = function (list) {
    while (list.length > MAX_BATCHES) list.shift();   // старое теряем первым
    try { lsSet(Q_KEY, JSON.stringify(list)); } catch (e) { /* переполнение */ }
  };

  /* beacon=true — страница закрывается, шлём через sendBeacon и не ждём
     подтверждения. Иначе XHR: он умеет сказать, дошло ли, и неудачную
     пачку мы кладём обратно в очередь. */
  Analytics.prototype.flush = function (beacon) {
    if (!this.on) { this.buf = []; return; }

    var queue = this._queue();
    if (this.buf.length) {
      queue.push({ m: this.meta, e: this.buf });
      this.buf = [];
    }
    if (!queue.length) return;
    this._store(queue);

    var body = JSON.stringify({ v: SCHEMA, ts: now(), b: queue });
    var self = this;

    function done() {
      // Убираем ровно то, что отправляли: за время запроса могли
      // накопиться новые пачки.
      var left = self._queue().slice(queue.length);
      self._store(left);
    }

    if (beacon && global.navigator && global.navigator.sendBeacon) {
      try {
        var blob = new global.Blob([body], { type: 'text/plain;charset=UTF-8' });
        if (global.navigator.sendBeacon(ENDPOINT, blob)) done();
        return;
      } catch (e) { /* падаем в XHR ниже */ }
    }

    try {
      var xhr = new global.XMLHttpRequest();
      xhr.open('POST', ENDPOINT, true);
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      xhr.onload = function () { if (xhr.status >= 200 && xhr.status < 300) done(); };
      xhr.send(body);
    } catch (e) { /* нет сети — пачка осталась в очереди до следующего раза */ }
  };

  global.Analytics = new Analytics();
})(window);
