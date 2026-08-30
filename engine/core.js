/* Каркас: canvas во весь экран, игровой цикл, ввод.
 *
 * Здесь закрыт весь список технических придирок модерации:
 *  - канвас тянется на всю доступную область и переживает поворот экрана
 *  - учитывается devicePixelRatio (иначе на телефоне всё мыло)
 *  - лонгтап не выделяет текст и не открывает контекстное меню
 *  - управление и с мыши/клавиатуры, и жестами
 *  - вкладка ушла в фон -> игра ставится на паузу
 */
(function (global) {
  'use strict';

  function Core(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.width = 0;          // логические (CSS) пиксели
    this.height = 0;
    this.dpr = 1;
    this.time = 0;
    this.hidden = false;
    // Полная остановка цикла. Нужна режиму съёмки промо: там кадры
    // рисуются вручную, и самопроизвольный тик портит выставленную сцену.
    this.paused = false;

    this.onResize = null;
    this.onUpdate = null;    // (dt, time)
    this.onRender = null;    // (ctx)
    this.onPress = null;     // (x, y) — тап/клик/пробел
    this.onRelease = null;   // (x, y)
    this.onVisibility = null;// (hidden)

    this._last = 0;
    this._raf = null;
    this._pointerDown = false;
  }

  Core.prototype.start = function () {
    var self = this;

    this._bindResize();
    this._bindInput();
    this._bindVisibility();
    this.resize();

    this._last = performance.now();
    var loop = function (now) {
      self._raf = global.requestAnimationFrame(loop);
      if (self.paused) { self._last = now; return; }

      // Клампим dt: после сворачивания вкладки прилетает огромная дельта,
      // с которой физика проскакивает сквозь объекты.
      var dt = Math.min((now - self._last) / 1000, 1 / 20);
      self._last = now;

      if (!self.hidden) {
        self.time += dt;
        if (self.onUpdate) self.onUpdate(dt, self.time);
      }
      if (self.onRender) self.onRender(self.ctx);
    };
    this._raf = global.requestAnimationFrame(loop);
  };

  Core.prototype.resize = function () {
    var w = Math.max(1, global.innerWidth);
    var h = Math.max(1, global.innerHeight);
    // Ограничиваем DPR: на 3x-телефонах полноэкранный канвас душит fps.
    var dpr = Math.min(global.devicePixelRatio || 1, 2);

    this.width = w;
    this.height = h;
    this.dpr = dpr;

    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);

    if (this.onResize) this.onResize(w, h);
  };

  Core.prototype._bindResize = function () {
    var self = this;
    var pending = null;
    function schedule() {
      // Поворот экрана на мобильных сообщает старые размеры,
      // поэтому пересчитываем ещё раз следующим кадром.
      if (pending) global.clearTimeout(pending);
      self.resize();
      pending = global.setTimeout(function () { self.resize(); }, 250);
    }
    global.addEventListener('resize', schedule, false);
    global.addEventListener('orientationchange', schedule, false);
  };

  Core.prototype._bindVisibility = function () {
    var self = this;
    document.addEventListener('visibilitychange', function () {
      self.hidden = document.hidden;
      self._last = performance.now();
      if (self.onVisibility) self.onVisibility(self.hidden);
    }, false);
  };

  Core.prototype._bindInput = function () {
    var self = this;
    var c = this.canvas;

    function point(e) {
      var rect = c.getBoundingClientRect();
      var src = e;
      if (e.changedTouches && e.changedTouches.length) src = e.changedTouches[0];
      return { x: src.clientX - rect.left, y: src.clientY - rect.top };
    }

    function press(e) {
      if (e.cancelable) e.preventDefault();
      self._pointerDown = true;
      var p = point(e);
      if (self.onPress) self.onPress(p.x, p.y);
    }

    function release(e) {
      if (!self._pointerDown) return;
      self._pointerDown = false;
      var p = point(e);
      if (self.onRelease) self.onRelease(p.x, p.y);
    }

    if (global.PointerEvent) {
      c.addEventListener('pointerdown', press, { passive: false });
      c.addEventListener('pointerup', release, { passive: false });
      c.addEventListener('pointercancel', release, { passive: false });
    } else {
      c.addEventListener('touchstart', press, { passive: false });
      c.addEventListener('touchend', release, { passive: false });
      c.addEventListener('touchcancel', release, { passive: false });
      c.addEventListener('mousedown', press, false);
      c.addEventListener('mouseup', release, false);
    }

    // Лонгтап не должен открывать контекстное меню и выделять поле.
    c.addEventListener('contextmenu', function (e) { e.preventDefault(); }, false);
    c.addEventListener('selectstart', function (e) { e.preventDefault(); }, false);
    c.addEventListener('dragstart', function (e) { e.preventDefault(); }, false);

    // Клавиатура: обязательное требование для десктопа.
    global.addEventListener('keydown', function (e) {
      if (e.repeat) return;
      var k = e.code || e.key;
      if (k === 'Space' || k === 'Enter' || k === 'ArrowUp' || k === ' ') {
        e.preventDefault();
        if (self.onPress) self.onPress(-1, -1); // -1 = «нажатие без координат»
      }
    }, false);
  };

  global.Core = Core;
})(window);
