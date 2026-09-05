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
    // Оптимистично по умолчанию: пока не спросили — считаем, что ролик есть.
    this.rewardedReady = true;
    // Код последнего отказа рекламы — его забирает аналитика. Без него
    // «не показалось» неотличимо от «игрок закрыл ролик».
    this.lastAdError = null;
    // Висит ли сейчас баннер. Нужен только для отчётности: показ и скрытие
    // мы не чередуем, см. showBanner.
    this.bannerShown = false;
    this.onBannerClosed = null;
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
        self._watchBanner();
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

  /* Сколько ждём ответа от моста, прежде чем считать показ несостоявшимся.
     Больше десяти секунд ждать нечего: игрок к этому моменту уже решил,
     что игра сломалась. */
  var AD_TIMEOUT = 10000;

  /* Все ветки логируем. Раньше «нет материалов» и «ответ без награды»
     молчали, и по логу нельзя было отличить пустой инвентарь от того,
     что игрок закрыл ролик — а это разные проблемы с разным лечением. */
  Platform.prototype._showAd = function (format, waterfall) {
    var self = this;
    if (!this.sdk) {
      console.warn('[platform-vk] реклама', format, '— моста нет, запуск вне ВК');
      return Promise.resolve(false);
    }

    var params = { ad_format: format };
    if (format === 'reward') params.use_waterfall = !!waterfall;

    /* Мост не обязан ответить. Наблюдалось живьём: игрок жмёт «продолжить
       за рекламу», ролика нет, ответа нет — и обещание не выполняется
       никогда. Игра при этом стоит на паузе и перестаёт принимать нажатия.
       Поэтому у показа есть срок: не ответили за AD_TIMEOUT — считаем, что
       рекламы нет, и отпускаем игру. */
    return new Promise(function (resolve) {
      var settled = false;
      function finish(ok) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      }
      var timer = setTimeout(function () {
        self.lastAdError = 'timeout';
        console.warn('[platform-vk] реклама', format, '— мост молчит',
          AD_TIMEOUT, 'мс, продолжаем без неё');
        finish(false);
      }, AD_TIMEOUT);

      self.sdk.send('VKWebAppShowNativeAds', params)
      .then(function (data) {
        var ok = !!(data && data.result);
        self.lastAdError = ok ? null : 'noresult';
        // Успех молчит. Ответ без ошибки, но и без награды — аномалия:
        // раньше этот путь молчал, и по логу нельзя было понять, что
        // произошло. Оставляем.
        if (!ok) {
          console.warn('[platform-vk] реклама', format,
            '— ответ без награды:', JSON.stringify(data));
        }
        finish(ok);
      })
      .catch(function (err) {
        // error_code 20 — «нет рекламных материалов»: показывать нечего,
        // играем дальше. Не поломка, но знать об этом надо.
        var d = (err && err.error_data) || {};
        var code = d.error_code;
        self.lastAdError = code === undefined ? (err && err.error_type) || 'unknown' : code;
        if (code === 20) {
          console.warn('[platform-vk] реклама', format,
            '— код 20: нет рекламных материалов. Инвентаря для этого формата' +
            ' сейчас нет, игра ни при чём');
          finish(false);
          return;
        }
        // Раскладываем ошибку по полям: в консоли объект печатается как
        // «Object», и по такому логу ничего не понять.
        console.warn('[platform-vk] реклама не показана.',
          'тип:', (err && err.error_type) || '?',
          'код:', code === undefined ? '?' : code,
          'причина:', d.error_reason || d.error_msg || '?',
          '| если код 3 или запросы к ad.mail.ru падают с ERR_BLOCKED_BY_CLIENT —' +
          ' это блокировщик рекламы в браузере, а не ошибка игры');
        finish(false);
      });
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

  /* Есть ли ролик с вознаграждением прямо сейчас. Спрашиваем заранее, чтобы
     не показывать кнопку, которая заведомо ответит «награда не засчитана»:
     у новых приложений инвентаря rewarded часто нет вовсе.

     При любом сбое считаем, что реклама есть. У метода была давняя болезнь —
     он всегда возвращал false; если она вернётся, лучше показать кнопку,
     которая иногда не сработает, чем спрятать работающую. */
  Platform.prototype.checkRewarded = function () {
    var self = this;
    if (!this.sdk) return Promise.resolve(this.rewardedReady);

    return this.sdk.send('VKWebAppCheckNativeAds', { ad_format: 'reward' })
      .then(function (data) {
        // Результат не логируем: он и так виден в игре — есть инвентарь,
        // значит на экране смерти есть кнопка.
        self.rewardedReady = !!(data && data.result);
        return self.rewardedReady;
      })
      .catch(function (err) {
        var d = (err && err.error_data) || {};
        console.warn('[platform-vk] проверка рекламы не прошла —',
          'считаем, что реклама есть. код:',
          d.error_code === undefined ? '?' : d.error_code);
        self.rewardedReady = true;
        return true;
      });
  };

  /* --- Баннер --------------------------------------------------------- */

  /* Баннер — единственный формат, который приносит показы сам, без действий
     игрока: он висит, пока открыта игра. Остальные упираются либо в частоту,
     которую режет площадка, либо в готовность игрока нажать кнопку. При
     одном показе на игрока, который мы намеряли, это главный рычаг.

     Показываем один раз на старте и больше не трогаем. Прятать на время
     забега заманчиво, но без layout_type ВК меняет размер окна, а мы на
     это пересобираем канвас — посреди забега это подножка игроку. Одна
     перестройка на загрузке стоит дешевле всех последующих.

     banner_location: 'bottom' — низ у нас свободнее верха: сверху счёт,
     снизу только переключатель звука, и тот уедет вместе с канвасом. */
  Platform.prototype.showBanner = function () {
    var self = this;
    if (!this.sdk) return Promise.resolve(false);

    return this.sdk.send('VKWebAppShowBannerAd', { banner_location: 'bottom' })
      .then(function (data) {
        var ok = !!(data && data.result);
        self.bannerShown = ok;
        self.lastAdError = ok ? null : 'noresult';
        if (!ok) {
          console.warn('[platform-vk] баннер — ответ без результата:',
            JSON.stringify(data));
        }
        return ok;
      })
      .catch(function (err) {
        var d = (err && err.error_data) || {};
        var code = d.error_code;
        self.lastAdError = code === undefined ? (err && err.error_type) || 'unknown' : code;
        self.bannerShown = false;
        console.warn('[platform-vk] баннер не показан.',
          'тип:', (err && err.error_type) || '?',
          'код:', code === undefined ? '?' : code,
          'причина:', d.error_reason || d.error_msg || '?');
        return false;
      });
  };

  Platform.prototype.hideBanner = function () {
    var self = this;
    if (!this.sdk) return Promise.resolve(false);
    return this.sdk.send('VKWebAppHideBannerAd', {})
      .then(function () { self.bannerShown = false; return true; })
      .catch(function () { return false; });
  };

  /* Игрок может закрыть баннер крестиком. Тогда показов больше не будет, и
     это надо видеть в отчёте: если закрывают массово, формат нам не подходит
     и место под ним лучше вернуть игре. */
  Platform.prototype._watchBanner = function () {
    var self = this;
    if (!this.sdk || !this.sdk.subscribe) return;
    this.sdk.subscribe(function (e) {
      var type = e && e.detail && e.detail.type;
      if (type !== 'VKWebAppBannerAdClosedByUser') return;
      self.bannerShown = false;
      if (self.onBannerClosed) self.onBannerClosed();
    });
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
