/* Обёртка над SDK Яндекс Игр.
 *
 * Задача файла: игра работает одинаково и на площадке, и локально.
 * Если /sdk.js не загрузился — все методы деградируют в no-op,
 * а не роняют игру. Это же экономит нервы на модерации: 72% отказов
 * приходится на SDK и техбаги, поэтому все вызовы здесь защищены.
 *
 * Синтаксис намеренно консервативный (без ?. и ??): Яндекс заявляет
 * поддержку Android 5 и iOS 9, а модератор может открыть игру где угодно.
 */
(function (global) {
  'use strict';

  function feature(sdk, name) {
    if (!sdk || !sdk.features) return null;
    return sdk.features[name] || null;
  }

  function Platform() {
    this.sdk = null;
    this.player = null;
    this.available = false;   // true только если реальный SDK ответил
    this.lang = 'ru';
    this.deviceType = 'desktop';
    this._readySent = false;
    this._gameplayOn = false;
    this._saveTimer = null;
    this._saveQueue = null;
  }

  /* --- Инициализация ------------------------------------------------ */

  Platform.prototype.init = function () {
    var self = this;
    var boot;

    if (global.YaGames && typeof global.YaGames.init === 'function') {
      boot = global.YaGames.init();
    } else {
      boot = Promise.reject(new Error('/sdk.js не подключён'));
    }

    return boot
      .then(function (sdk) {
        self.sdk = sdk;
        self.available = true;

        var env = sdk.environment || {};
        if (env.i18n && env.i18n.lang) self.lang = env.i18n.lang;

        if (sdk.deviceInfo) {
          if (sdk.deviceInfo.isMobile && sdk.deviceInfo.isMobile()) self.deviceType = 'mobile';
          else if (sdk.deviceInfo.isTablet && sdk.deviceInfo.isTablet()) self.deviceType = 'tablet';
          else if (sdk.deviceInfo.isTV && sdk.deviceInfo.isTV()) self.deviceType = 'tv';
        }

        // scopes:false — не показываем окно авторизации, но сохранения работают
        return sdk.getPlayer({ scopes: false }).catch(function () { return null; });
      })
      .then(function (player) {
        self.player = player;
        return self;
      })
      .catch(function (err) {
        self.available = false;
        self.lang = (global.navigator.language || 'ru').slice(0, 2);
        console.warn('[platform] локальный режим:', err && err.message);
        return self;
      });
  };

  /* --- События загрузки и геймплея ---------------------------------- */

  // Вызывать ровно один раз, когда игрок реально может начать играть.
  Platform.prototype.ready = function () {
    if (this._readySent) return;
    this._readySent = true;
    var api = feature(this.sdk, 'LoadingAPI');
    if (api && api.ready) {
      try { api.ready(); } catch (e) { console.warn('[platform] ready:', e); }
    }
  };

  // Геймплей идёт: игрок управляет. Обязательно парно со stop().
  Platform.prototype.gameplayStart = function () {
    if (this._gameplayOn) return;
    this._gameplayOn = true;
    var api = feature(this.sdk, 'GameplayAPI');
    if (api && api.start) {
      try { api.start(); } catch (e) { console.warn('[platform] start:', e); }
    }
  };

  // Пауза, меню, проигрыш, реклама, уход со вкладки.
  Platform.prototype.gameplayStop = function () {
    if (!this._gameplayOn) return;
    this._gameplayOn = false;
    var api = feature(this.sdk, 'GameplayAPI');
    if (api && api.stop) {
      try { api.stop(); } catch (e) { console.warn('[platform] stop:', e); }
    }
  };

  Platform.prototype.isGameplayOn = function () {
    return this._gameplayOn;
  };

  /* --- Реклама ------------------------------------------------------ */

  // Полноэкранная. Частоту показа регулирует сама платформа, поэтому
  // зовём спокойно — лишний вызов просто вернёт wasShown === false.
  // Resolve(true), если реклама действительно была показана.
  Platform.prototype.showInterstitial = function () {
    var self = this;
    return new Promise(function (resolve) {
      if (!self.sdk || !self.sdk.adv) { resolve(false); return; }

      var resumeAfter = self._gameplayOn;
      var settled = false;
      function finish(shown) {
        if (settled) return;
        settled = true;
        if (resumeAfter) self.gameplayStart();
        resolve(!!shown);
      }

      self.gameplayStop();
      try {
        self.sdk.adv.showFullscreenAdv({
          callbacks: {
            onClose: function (wasShown) { finish(wasShown); },
            onError: function (error) { console.warn('[adv] fullscreen:', error); finish(false); }
          }
        });
      } catch (e) {
        console.warn('[adv] fullscreen throw:', e);
        finish(false);
      }
    });
  };

  // Реклама за вознаграждение. Частота не ограничена платформой —
  // это главный источник дохода, поэтому награду выдаём строго
  // по onRewarded, а не по onClose.
  Platform.prototype.showRewarded = function () {
    var self = this;
    return new Promise(function (resolve) {
      if (!self.sdk || !self.sdk.adv) { resolve(false); return; }

      var rewarded = false;
      var resumeAfter = self._gameplayOn;
      var settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        if (resumeAfter) self.gameplayStart();
        resolve(rewarded);
      }

      self.gameplayStop();
      try {
        self.sdk.adv.showRewardedVideo({
          callbacks: {
            onRewarded: function () { rewarded = true; },
            onClose: function () { finish(); },
            onError: function (error) { console.warn('[adv] rewarded:', error); finish(); }
          }
        });
      } catch (e) {
        console.warn('[adv] rewarded throw:', e);
        finish();
      }
    });
  };

  /* --- Сохранения ---------------------------------------------------- */
  /* Пишем и в облако игрока, и в localStorage. Читаем облако, а если
     его нет (гость, оффлайн, локальный запуск) — падаем на localStorage. */

  var LS_KEY = 'save';

  Platform.prototype.load = function (localKey) {
    var self = this;
    var key = localKey || LS_KEY;

    function fromLocal() {
      try {
        var raw = global.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }

    if (!this.player || !this.player.getData) {
      return Promise.resolve(fromLocal());
    }

    return this.player.getData([LS_KEY])
      .then(function (data) {
        if (data && data[LS_KEY]) return data[LS_KEY];
        return fromLocal();
      })
      .catch(function () { return fromLocal(); });
  };

  // Троттлим: setData нельзя дёргать на каждый кадр.
  Platform.prototype.save = function (state, localKey) {
    var self = this;
    var key = localKey || LS_KEY;

    try { global.localStorage.setItem(key, JSON.stringify(state)); } catch (e) { /* приватный режим */ }

    if (!this.player || !this.player.setData) return;

    this._saveQueue = state;
    if (this._saveTimer) return;
    this._saveTimer = global.setTimeout(function () {
      self._saveTimer = null;
      var payload = {};
      payload[LS_KEY] = self._saveQueue;
      try {
        self.player.setData(payload, false).catch(function (e) {
          console.warn('[platform] setData:', e);
        });
      } catch (e) { console.warn('[platform] setData throw:', e); }
    }, 3000);
  };

  /* --- Лидерборд ------------------------------------------------------ */
  /* Лидерборд нужно предварительно создать в Консоли разработчика.
     Пока он не создан — вызов просто молча упадёт в catch. */

  Platform.prototype.submitScore = function (boardName, score) {
    if (!this.sdk || !this.sdk.leaderboards) return Promise.resolve(false);
    try {
      return this.sdk.leaderboards.setScore(boardName, Math.round(score))
        .then(function () { return true; })
        .catch(function (e) { console.warn('[lb] setScore:', e); return false; });
    } catch (e) {
      return Promise.resolve(false);
    }
  };

  Platform.prototype.getTopScores = function (boardName, count) {
    if (!this.sdk || !this.sdk.leaderboards) return Promise.resolve([]);
    try {
      return this.sdk.leaderboards
        .getEntries(boardName, { quantityTop: count || 10, includeUser: true, quantityAround: 3 })
        .then(function (res) { return (res && res.entries) || []; })
        .catch(function () { return []; });
    } catch (e) {
      return Promise.resolve([]);
    }
  };

  global.Platform = new Platform();
})(window);
