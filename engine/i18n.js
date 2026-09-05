/* Локализация. Язык берём из SDK (ysdk.environment.i18n.lang),
 * локально — из navigator.language. Требование площадки: игра должна
 * определять язык автоматически.
 * ru покрывает ru/be/kk/uk/uz, остальное — en.
 */
(function (global) {
  'use strict';

  var DICT = {
    ru: {
      title: 'ОРБИТА',
      tapToStart: 'Нажми, чтобы прыгнуть',
      hint: 'Тап — отцепиться. Попади на следующую звезду.',
      play: 'Играть',
      score: 'Счёт',
      best: 'Рекорд',
      newBest: 'Новый рекорд!',
      gameOver: 'Промах',
      again: 'Ещё раз',
      continueAd: 'Продолжить',
      doubleCoins: 'Удвоить',
      forAd: 'за рекламу',
      shop: 'Скины',
      back: 'Назад',
      equipped: 'Надет',
      equip: 'Надеть',
      locked: 'Нужно',
      sound: 'Звук',
      on: 'вкл',
      off: 'выкл',
      loading: 'Загрузка…',
      adFailed: 'Награда не засчитана',
      adWait: 'Загружаем рекламу…',
      paused: 'Пауза'
    },
    en: {
      title: 'ORBIT',
      tapToStart: 'Tap to jump',
      hint: 'Tap to release. Land on the next star.',
      play: 'Play',
      score: 'Score',
      best: 'Best',
      newBest: 'New record!',
      gameOver: 'Missed',
      again: 'Retry',
      continueAd: 'Continue',
      doubleCoins: 'Double',
      forAd: 'for an ad',
      shop: 'Skins',
      back: 'Back',
      equipped: 'Equipped',
      equip: 'Equip',
      locked: 'Need',
      sound: 'Sound',
      on: 'on',
      off: 'off',
      loading: 'Loading…',
      adFailed: 'No reward granted',
      adWait: 'Loading ad…',
      paused: 'Paused'
    }
  };

  var RU_LANGS = { ru: 1, be: 1, kk: 1, uk: 1, uz: 1 };

  var I18n = {
    lang: 'ru',
    dict: DICT.ru,

    use: function (lang) {
      var code = (lang || 'ru').slice(0, 2).toLowerCase();
      this.lang = RU_LANGS[code] ? 'ru' : 'en';
      this.dict = DICT[this.lang];
      return this.lang;
    },

    t: function (key) {
      var v = this.dict[key];
      return v === undefined ? key : v;
    }
  };

  global.I18n = I18n;
})(window);
