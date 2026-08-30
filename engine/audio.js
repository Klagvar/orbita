/* Звук на WebAudio, синтезом.
 *
 * Никаких mp3/ogg: нулевой вес в сборке (лимит площадки — 100 МБ,
 * но быстрая загрузка напрямую влияет на удержание, а значит на доход)
 * и никаких вопросов по лицензиям на модерации.
 * Контекст создаётся только после первого касания — иначе браузеры
 * блокируют автоплей.
 */
(function (global) {
  'use strict';

  function Audio() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this._unlocked = false;
  }

  Audio.prototype.unlock = function () {
    if (this._unlocked) return;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) { this._unlocked = true; return; }
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.25;
      this.master.connect(this.ctx.destination);
      this._unlocked = true;
    } catch (e) {
      this._unlocked = true;
    }
    this.resume();
  };

  Audio.prototype.resume = function () {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(function () {});
    }
  };

  Audio.prototype.setEnabled = function (on) {
    this.enabled = !!on;
    if (this.master) this.master.gain.value = this.enabled ? 0.25 : 0;
  };

  /* Один тон с огибающей. slideTo — частота в конце (для «вжух»). */
  Audio.prototype.tone = function (opts) {
    if (!this.enabled || !this.ctx) return;
    var t = this.ctx.currentTime;
    var dur = opts.dur || 0.12;

    var osc = this.ctx.createOscillator();
    var gain = this.ctx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.freq, t);
    if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slideTo), t + dur);

    var peak = opts.gain || 0.6;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  };

  /* Шумовой всплеск — для взрыва/проигрыша. */
  Audio.prototype.noise = function (dur, gainValue) {
    if (!this.enabled || !this.ctx) return;
    var t = this.ctx.currentTime;
    var len = Math.floor(this.ctx.sampleRate * dur);
    var buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    var src = this.ctx.createBufferSource();
    src.buffer = buf;

    var filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1800, t);
    filter.frequency.exponentialRampToValueAtTime(180, t + dur);

    var gain = this.ctx.createGain();
    gain.gain.setValueAtTime(gainValue || 0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start(t);
  };

  /* --- Пресеты игры --- */
  Audio.prototype.launch = function () { this.tone({ freq: 340, slideTo: 760, dur: 0.13, type: 'triangle', gain: 0.5 }); };
  Audio.prototype.latch = function (pitch) {
    var base = 480 + Math.min(pitch || 0, 12) * 28;
    this.tone({ freq: base, dur: 0.1, type: 'sine', gain: 0.6 });
  };
  Audio.prototype.coin = function () { this.tone({ freq: 980, slideTo: 1560, dur: 0.09, type: 'square', gain: 0.22 }); };
  Audio.prototype.death = function () {
    this.tone({ freq: 260, slideTo: 60, dur: 0.45, type: 'sawtooth', gain: 0.35 });
    this.noise(0.4, 0.35);
  };
  Audio.prototype.click = function () { this.tone({ freq: 620, dur: 0.06, type: 'square', gain: 0.25 }); };
  Audio.prototype.portal = function () {
    this.tone({ freq: 280, slideTo: 1100, dur: 0.28, type: 'sine', gain: 0.4 });
    this.tone({ freq: 140, slideTo: 550, dur: 0.28, type: 'triangle', gain: 0.25 });
  };
  Audio.prototype.reward = function () {
    var self = this;
    [660, 830, 990, 1320].forEach(function (f, i) {
      global.setTimeout(function () { self.tone({ freq: f, dur: 0.14, type: 'triangle', gain: 0.4 }); }, i * 85);
    });
  };

  global.Sound = new Audio();
})(window);
