/* Обёртка над VK Bridge — платформенный слой для VK Games.
 *
 * Интерфейс тот же, что у engine/platform-yandex.js, поэтому game.js
 * не знает, на какой площадке он запущен, и не меняется при портировании.
 *
 * Различия площадок, которые пришлось учесть:
 *  - у ВК нет аналогов LoadingAPI и GameplayAPI — эти методы пустые;
 *  - реклама одна на оба формата, вид задаётся параметром ad_format;
 *  - сохранения идут в VK Storage и привязаны к user_id, а не к домену.
 *    Это важно: на хостинге статики ВК домен меняется после каждой
 *    выкладки, и localStorage бы обнулялся. Поэтому облако тут основное,
 *    а localStorage — только запасной вариант.
 *
 * Синтаксис консервативный (без ?. и ??): ВК крутит игры в WebView
 * на старых Android.
 */
(function (global) {
  'use strict';

  // При подключении библиотеки скриптом объект называется vkBridge.
  function bridge() {
    return global.vkBridge || null;
  }

  /* Параметры запуска ВК передаёт в строке адреса: vk_language, vk_platform
     и прочие. Берём язык оттуда, иначе — из браузера. */
  function launchParam(name) {
    var search = global.location.search || '';
    var pairs = search.replace(/^\?/, '').split('&');
    for (var i = 0; i < pairs.length; i++) {
      var kv = pairs[i].split('=');
      if (decodeURIComponent(kv[0]) === name) return decodeURIComponent(kv[1] || '');
    }
    return '';
  }

  function Platform() {
    this.sdk = null;
    this.player = null;
    this.available = false;
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
    var b = bridge();

    if (!b) {
      this.available = false;
      this.lang = (global.navigator.language || 'ru').slice(0, 2);
      console.warn('[platform-vk] локальный режим: vk-bridge не подключён');
      return Promise.resolve(this);
    }

    var platform = launchParam('vk_platform');
    if (platform.indexOf('mobile') === 0) this.deviceType = 'mobile';
    this.lang = launchParam('vk_language') ||
      (global.navigator.language || 'ru').slice(0, 2);

    // VKWebAppInit обязателен и должен уйти до загрузки основных ресурсов.
    // Вне ВК ответа может не быть вообще — тогда промис висит вечно и игра
    // не выходит с экрана загрузки. Поэтому гонка с таймаутом.
    var timeout = new Promise(function (resolve) {
      global.setTimeout(function () { resolve('timeout'); }, 3000);
    });

    return Promise.race([b.send('VKWebAppInit', {}), timeout])
      .then(function (res) {
        if (res === 'timeout') {
          console.warn('[platform-vk] VKWebAppInit не ответил за 3 с — офлайн-режим');
          self.available = false;
          return self;
        }
        self.sdk = b;
        self.available = true;
        return self;
      })
      .catch(function (err) {
        self.available = false;
        console.warn('[platform-vk] VKWebAppInit не прошёл:', err);
        return self;
      });
  };

  /* --- События загрузки и геймплея ---------------------------------- */
  /* У ВК аналогов нет. Методы оставлены пустыми, чтобы game.js был общим
     для всех площадок и не оброс проверками. */

  Platform.prototype.ready = function () { this._readySent = true; };
  Platform.prototype.gameplayStart = function () { this._gameplayOn = true; };
  Platform.prototype.gameplayStop = function () { this._gameplayOn = false; };
  Platform.prototype.isGameplayOn = function () { return this._gameplayOn; };

  /* --- Реклама ------------------------------------------------------ */

  Platform.prototype._showAd = function (format, waterfall) {
    var self = this;
    if (!this.sdk) return Promise.resolve(false);

    var params = { ad_format: format };
    if (format === 'reward') params.use_waterfall = !!waterfall;

    return this.sdk.send('VKWebAppShowNativeAds', params)
      .then(function (data) {
        return !!(data && data.result);
      })
      .catch(function (err) {
        // error_code 20 — «нет рекламных материалов». Это штатная ситуация,
        // а не поломка: показывать нечего, играем дальше.
        var code = err && err.error_data ? err.error_data.error_code : null;
        if (code !== 20) console.warn('[platform-vk] реклама:', err);
        return false;
      });
  };

  Platform.prototype.showInterstitial = function () {
    return this._showAd('interstitial', false);
  };

  // use_waterfall: true — если ролика с вознаграждением нет, ВК покажет
  // межэкранный. Игрок всё равно посмотрел рекламу, поэтому награду выдаём.
  Platform.prototype.showRewarded = function () {
    return this._showAd('reward', true);
  };

  /* --- Сохранения ---------------------------------------------------- */
  /* Ключ VK Storage допускает только [a-zA-Z_\-0-9], значение — строка
     до 4096 символов. Наше сохранение занимает около сотни. */

  Platform.prototype.load = function (localKey) {
    var self = this;
    var key = localKey || 'save';

    function fromLocal() {
      try {
        var raw = global.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }

    if (!this.sdk) return Promise.resolve(fromLocal());

    return this.sdk.send('VKWebAppStorageGet', { keys: [key] })
      .then(function (data) {
        var list = (data && data.keys) || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i].key === key && list[i].value) {
            try { return JSON.parse(list[i].value); } catch (e) { return fromLocal(); }
          }
        }
        return fromLocal();
      })
      .catch(function () { return fromLocal(); });
  };

  // Троттлим: у VK Storage лимит 1000 вызовов в час на пользователя.
  Platform.prototype.save = function (state, localKey) {
    var self = this;
    var key = localKey || 'save';

    try { global.localStorage.setItem(key, JSON.stringify(state)); } catch (e) { /* приватный режим */ }

    if (!this.sdk) return;

    this._saveQueue = state;
    if (this._saveTimer) return;
    this._saveTimer = global.setTimeout(function () {
      self._saveTimer = null;
      try {
        self.sdk.send('VKWebAppStorageSet', {
          key: key,
          value: JSON.stringify(self._saveQueue)
        }).catch(function (e) { console.warn('[platform-vk] StorageSet:', e); });
      } catch (e) { console.warn('[platform-vk] StorageSet throw:', e); }
    }, 3000);
  };

  /* --- Лидерборд ------------------------------------------------------ */
  /* В кабинете ВК есть «Таблица результатов», но её API я ещё не сверял
     по документации. До тех пор — заглушка: игра от этого не ломается,
     рекорд просто не уезжает в общий рейтинг. */

  Platform.prototype.submitScore = function () { return Promise.resolve(false); };
  Platform.prototype.getTopScores = function () { return Promise.resolve([]); };

  global.Platform = new Platform();
})(window);
