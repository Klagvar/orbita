/* Орбита — гиперказуальная аркада.
 *
 * Механика: шарик вращается вокруг звезды. Тап — отцепиться и лететь
 * по касательной. Долетел до следующей звезды — зацепился, +1 очко.
 * Промахнулся — конец забега.
 *
 * Денежная петля:
 *   rewarded «Продолжить»  — один раз за забег, в момент максимальной
 *                            досады игрока (самый дорогой момент для показа);
 *   rewarded «Удвоить»     — на монеты забега;
 *   fullscreen             — редко, раз в INTERSTITIAL_EVERY забегов.
 */
(function (global) {
  'use strict';

  var P = global.Platform;
  var S = global.Sound;
  var T = global.I18n;
  var A = global.Analytics;

  /* --- Константы мира (в мировых единицах) --------------------------- */

  var HALF_W = 220;        // половина игровой колонки
  var VIEW_H = 760;        // расчётная высота вида
  var BALL_R = 11;
  var FLY_SPEED = 470;     // скорость полёта, ед/с
  var ORBIT_GAP = 26;      // зазор между поверхностью звезды и шариком
  var OMEGA = 3.1;         // угловая скорость вращения, рад/с
  var MAX_FLY = 1.5;       // дольше летишь без захвата — промах
  var FRAGILE_LIFE = 1.15; // сколько живёт хрупкая звезда после захвата

  // Метеор игрока: core — раскалённое ядро, mid — тело пламени, glow — ореол.
  var SKINS = [
    { cost: 0,    core: '#fff3c4', mid: '#ffb347', glow: '#ff6a00', ru: 'Уголёк',  en: 'Ember' },
    { cost: 60,   core: '#eaffff', mid: '#7fe3ff', glow: '#2b8cff', ru: 'Иней',    en: 'Frost' },
    { cost: 200,  core: '#ffe6fb', mid: '#ff7fe0', glow: '#c026d3', ru: 'Неон',    en: 'Neon' },
    { cost: 500,  core: '#f2ffe0', mid: '#a3ff6b', glow: '#22c55e', ru: 'Токсин',  en: 'Toxin' },
    { cost: 1200, core: '#ffffff', mid: '#c4a7ff', glow: '#7c3aed', ru: 'Пульсар', en: 'Pulsar' }
  ];

  /* Палитры светил. Звезда — это горящий шар, поэтому у каждой:
     hot   — пересвеченное ядро,
     core  — основная плазма,
     mid   — более холодные пятна на поверхности,
     edge  — потемнение к краю (лимбовое затемнение),
     flame — цвет короны и протуберанцев. */
  var STAR_PALETTE = {
    normal:  { hot: '#fffdf2', core: '#ffd34d', mid: '#ff9a1f', edge: '#d1470a',
               flame: 'rgba(255,150,40,0.50)', halo: 'rgba(220,110,20,0.18)' },
    fragile: { hot: '#ffe6cc', core: '#ff8a5c', mid: '#e8452a', edge: '#7d1409',
               flame: 'rgba(255,90,40,0.50)',  halo: 'rgba(190,50,20,0.18)' },
    mover:   { hot: '#ffffff', core: '#d6ecff', mid: '#7db8ff', edge: '#2559b8',
               flame: 'rgba(120,180,255,0.50)', halo: 'rgba(60,110,220,0.18)' },
    // Спутники дыры — отдельный цвет, иначе их не отличить от обычных звёзд.
    sat:     { hot: '#fff2ff', core: '#f0a9ff', mid: '#c065ef', edge: '#5f1a8f',
               flame: 'rgba(210,120,255,0.50)', halo: 'rgba(140,50,200,0.18)' }
  };

  var TAU = Math.PI * 2;

  var LB_NAME = 'orbita_best';

  // Раз во сколько забегов показывать принудительную полноэкранную рекламу.
  // Проверено на ВК: принудительный показ — это баннер с крестиком через
  // 5 секунд, он безобиден. Длинные двухминутные ролики бывают только
  // у rewarded, а его игрок запускает сам. Это одно число, крутить сюда.
  var INTERSTITIAL_EVERY = 3;

  /* --- Состояние ------------------------------------------------------ */

  var core, ctx;
  var worldTime = 0;
  var W = 0, H = 0, scale = 1, us = 1;
  var state = 'boot';      // boot | menu | play | dead | shop
  var camY = 0;
  var shake = 0;
  var runs = 0;

  var save = { best: 0, coins: 0, skin: 0, owned: [0], sound: true };

  var stars = [];
  var holes = [];
  var portals = [];
  var lastX = 0, lastY = 0;
  var lastKind = 'plain';  // чтобы не выдавать один и тот же тип подряд
  var spreadCap = 0;       // ограничение разброса для следующего узла
  var pickups = [];
  var particles = [];
  var bgDots = [];
  var nebulae = [];
  var trail = [];

  var ball = null;
  var nextIndex = 0;       // сколько звёзд уже сгенерировано за забег
  var score = 0;
  var runCoins = 0;
  var continueUsed = false;
  var adOffer = '';        // какое предложение рекламы уже засчитано на этом экране смерти
  var newBest = false;
  var adBusy = false;      // блокирует ввод, пока крутится реклама

  // Что игрок успел увидеть за забег: в статистику уезжает только этот
  // набор, по нему видно, доходит ли кто-нибудь до поздних механик.
  var runAt = 0;           // время старта забега
  var seen = {};           // типы звёзд и порталы, реально пройденные

  var buttons = [];        // хит-зоны UI текущего кадра
  var toast = { text: '', life: 0 };  // короткое сообщение поверх экрана

  /* --- Утилиты -------------------------------------------------------- */

  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function skin() { return SKINS[clamp(save.skin, 0, SKINS.length - 1)]; }

  /* --- Генерация мира -------------------------------------------------- */

  function makeStar(x, y, r, type) {
    return {
      x: x, baseX: x, y: y, r: r,
      type: type,
      phase: rand(0, TAU),
      amp: type === 'mover' ? 55 : 0,
      speed: rand(0.7, 1.2),
      spinSpeed: rand(0.15, 0.45) * (Math.random() < 0.5 ? -1 : 1),
      rot: rand(0, TAU),
      host: null,            // чёрная дыра, вокруг которой ходит спутник
      offset: 0,
      visited: false,
      decay: -1              // >= 0 только у догорающей хрупкой звезды
    };
  }

  /* Система: чёрная дыра плюс две звезды на общей эллиптической орбите.
     Зацепиться можно только за звёзды, сама дыра убивает при касании. */
  function spawnSystem(n, x, y) {
    var satR = clamp(24 - n * 0.15, 17, 24);
    var holeR = rand(24, 30);

    // Малая полуось считается от геометрии, а не на глаз: пока метеор
    // крутится вокруг спутника, он не должен доставать до горизонта событий.
    var b = holeR + (satR + ORBIT_GAP) + BALL_R + 22;
    var a = Math.min(b * rand(1.15, 1.45), 150);
    var rot = rand(-0.3, 0.3);

    // Габариты повёрнутого эллипса. Без них спутники наезжают на соседние
    // звёзды: система занимает куда больше места, чем одиночное светило.
    var cr = Math.cos(rot), sr = Math.sin(rot);
    function extH() { return Math.sqrt(a * cr * a * cr + b * sr * b * sr) + satR; }
    function extV() { return Math.sqrt(a * sr * a * sr + b * cr * b * cr) + satR; }

    var maxH = HALF_W - 30;
    if (extH() > maxH) a = Math.max(b, a * (maxH / extH()));

    var pad = extV() + 34;
    var hx = clamp(x, -(HALF_W - extH()), HALF_W - extH());
    var hy = y - pad;          // низ системы не должен доставать до предыдущего узла

    var hole = {
      x: hx, y: hy, r: holeR,
      a: a, b: b,
      rot: rot,
      w: rand(0.55, 0.95) * (Math.random() < 0.5 ? 1 : -1),
      phase: rand(0, TAU),
      spin: 0
    };
    holes.push(hole);

    for (var i = 0; i < 2; i++) {
      var sat = makeStar(hx, hy, satR, 'sat');
      sat.host = hole;
      sat.offset = i * Math.PI;
      stars.push(sat);
    }

    // И сверху тоже оставляем зазор под следующий узел.
    lastX = hx;
    lastY = hy - pad;
  }

  /* Кротовая нора: влетел во вход — вылетел из выхода строго вверх.
     Промахнулся мимо входа — цепляться не за что, забег окончен. */
  function spawnPortal(x, y) {
    var ex = clamp(x + rand(-120, 120), -(HALF_W - 70), HALF_W - 70);
    var ey = y - rand(330, 430);
    portals.push({ ax: x, ay: y, bx: ex, by: ey, r: 46, spin: rand(0, TAU) });

    lastX = ex;
    lastY = ey - 40;
    // Из выхода метеор летит вверх, поэтому следующую звезду ставим почти
    // над ним — иначе прыжок был бы невыполнимым.
    spreadCap = 55;
  }

  /* Одиночная дыра-преграда примерно на маршруте между узлами. */
  function spawnObstacle(px, py, x, y) {
    var side = Math.random() < 0.5 ? -1 : 1;
    var hx = clamp((px + x) / 2 + rand(45, 85) * side, -(HALF_W - 45), HALF_W - 45);
    holes.push({
      x: hx, y: (py + y) / 2, r: rand(17, 23),
      a: 0, b: 0, rot: 0, w: 0, phase: 0, spin: 0
    });
  }

  /* Режиссёр сложности: что ставить следующим.
     Типы вводятся по стадиям и не повторяются подряд, иначе трасса
     превращается в монотонную полосу одинаковых объектов. */
  function pickKind(n) {
    if (n < 4) return 'plain';
    // После тяжёлого узла всегда даём передышку.
    if (lastKind === 'system' || lastKind === 'portal') return 'plain';

    var pool = [{ k: 'plain', w: 30 }];
    if (n >= 4)  pool.push({ k: 'fragile', w: Math.min(10 + n, 26) });
    if (n >= 9)  pool.push({ k: 'mover',   w: Math.min(8 + n, 24) });
    if (n >= 16) pool.push({ k: 'system',  w: Math.min(6 + (n - 16) * 1.5, 20) });
    if (n >= 25) pool.push({ k: 'portal',  w: Math.min(6 + (n - 25) * 1.5, 18) });

    var total = 0, i;
    for (i = 0; i < pool.length; i++) {
      if (pool[i].k === lastKind) pool[i].w *= 0.25;
      total += pool[i].w;
    }
    var roll = Math.random() * total;
    for (i = 0; i < pool.length; i++) {
      roll -= pool[i].w;
      if (roll <= 0) return pool[i].k;
    }
    return 'plain';
  }

  function spawnNext() {
    var n = nextIndex++;

    // Вся кривая сложности живёт здесь: дистанция растёт, размер падает.
    var gap = 150 + Math.min(n, 40) * 4;
    var r = 34 - Math.min(n, 30) * 0.5;
    var prevX = lastX, prevY = lastY;

    var x, y;
    if (n === 0) {
      x = 0;
      y = 0;
    } else {
      var spread = spreadCap || clamp(60 + n * 4, 60, 200);
      spreadCap = 0;
      x = clamp(lastX + rand(-spread, spread), -(HALF_W - 55), HALF_W - 55);
      y = lastY - gap;
    }

    // Монетка примерно на траектории к следующему узлу.
    if (n > 0 && Math.random() < 0.45) {
      pickups.push({
        x: (prevX + x) / 2 + rand(-30, 30),
        y: (prevY + y) / 2,
        taken: false,
        t: rand(0, TAU)
      });
    }

    var kind = pickKind(n);
    lastKind = kind;

    if (kind === 'system') {
      spawnSystem(n, x, y);
      return stars[stars.length - 1];
    }
    if (kind === 'portal') {
      spawnPortal(x, y);
      return null;
    }

    var star = makeStar(x, y, r, kind === 'plain' ? 'normal' : kind);
    stars.push(star);
    lastX = x;
    lastY = y;

    // Преграда на подлёте — только к обычным узлам, чтобы не громоздить.
    if (n >= 20 && kind === 'plain' && Math.random() < 0.28) {
      spawnObstacle(prevX, prevY, x, y);
    }
    return star;
  }

  function ensureStars() {
    while (stars.length < 8 || lastY > camY - VIEW_H) spawnNext();

    // Чистим строго по позиции. По количеству нельзя: у системы с чёрной
    // дырой объектов втрое больше обычного, и лимит выбрасывал дыру,
    // которая ещё видна на экране.
    var floor = camY + VIEW_H;
    while (stars.length > 6 && stars[0].y > floor && (!ball || stars[0] !== ball.anchor)) stars.shift();
    while (holes.length && holes[0].y > floor) holes.shift();
    while (pickups.length && pickups[0].y > floor) pickups.shift();
    while (portals.length && portals[0].ay > floor && portals[0].by > floor) portals.shift();
  }

  /* Задник строится под фактическую ширину вьюпорта: игровая колонка узкая,
     и на широком мониторе по краям иначе остаются пустые чёрные поля. */
  function makeBackdrop() {
    var halfW = (W * 0.5) / scale + 80;

    bgDots = [];
    var count = Math.round(clamp(halfW / 3.2, 90, 220));
    for (var i = 0; i < count; i++) {
      bgDots.push({
        x: rand(-halfW, halfW),
        y: rand(-VIEW_H, VIEW_H),
        r: rand(0.6, 2.0),
        depth: rand(0.15, 0.6)
      });
    }

    var TINTS = [
      'rgba(96,64,190,',
      'rgba(32,86,180,',
      'rgba(158,44,128,',
      'rgba(40,130,160,'
    ];
    nebulae = [];
    for (var k = 0; k < 5; k++) {
      nebulae.push({
        x: rand(-halfW, halfW),
        y: rand(-VIEW_H, VIEW_H),
        r: rand(200, 420),
        tint: TINTS[k % TINTS.length],
        alpha: rand(0.10, 0.20),
        depth: rand(0.05, 0.16)
      });
    }
  }

  /* --- Забег ------------------------------------------------------------ */

  function attach(star, angle, dir) {
    ball.mode = 'orbit';
    ball.anchor = star;
    ball.angle = angle;
    ball.dir = dir;
    ball.radius = star.r + ORBIT_GAP;
    ball.flyTime = 0;
    if (star.type === 'fragile' && star.decay < 0) star.decay = FRAGILE_LIFE;
    // 'sat' — спутник чёрной дыры, то есть механика «система».
    seen[star.type === 'sat' ? 'system' : star.type] = 1;
  }

  function syncOrbitPosition() {
    var a = ball.anchor;
    ball.x = a.x + Math.cos(ball.angle) * ball.radius;
    ball.y = a.y + Math.sin(ball.angle) * ball.radius;
  }

  function resetRun() {
    stars = [];
    holes = [];
    portals = [];
    pickups = [];
    particles = [];
    trail = [];
    lastX = 0;
    lastY = 0;
    lastKind = 'plain';
    spreadCap = 0;
    nextIndex = 0;
    score = 0;
    runCoins = 0;
    continueUsed = false;
    newBest = false;
    camY = 0;
    shake = 0;
    seen = {};
    runAt = Date.now();

    var first = spawnNext();
    ensureStars();

    ball = {
      x: 0, y: 0, mode: 'orbit', anchor: null, angle: -Math.PI / 2,
      dir: 1, radius: 0, vx: 0, vy: 0, flyTime: 0, portalCd: 0
    };
    attach(first, -Math.PI / 2, 1);
    first.visited = true;
    first.decay = -1;
    syncOrbitPosition();
    camY = ball.y - 150;
  }

  function release() {
    if (ball.mode !== 'orbit') return;
    // Скорость по касательной, в сторону текущего вращения.
    var tx = -Math.sin(ball.angle) * ball.dir;
    var ty = Math.cos(ball.angle) * ball.dir;
    ball.vx = tx * FLY_SPEED;
    ball.vy = ty * FLY_SPEED;
    ball.mode = 'fly';
    ball.flyTime = 0;
    if (ball.anchor.type === 'fragile') ball.anchor.decay = -2; // отпустил — звезда гаснет
    ball.anchor = null;
    S.launch();
    burst(ball.x, ball.y, 6, skin().glow);
  }

  function burst(x, y, n, color) {
    for (var i = 0; i < n; i++) {
      var a = rand(0, Math.PI * 2);
      var sp = rand(40, 210);
      particles.push({
        x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.3, 0.8), max: 0.8, color: color, r: rand(1.5, 3.5)
      });
    }
  }

  function die() {
    if (state !== 'play') return;
    state = 'dead';
    adOffer = '';
    shake = 1;
    S.death();
    burst(ball.x, ball.y, 22, '#ff5470');
    P.gameplayStop();

    save.coins += runCoins;
    if (score > save.best) {
      save.best = score;
      newBest = true;
    }
    persist();
    if (newBest && score > 0) P.submitScore(LB_NAME, save.best);

    A.event('run_end', {
      n: runs, score: score, best: save.best, coins: runCoins,
      dur: Math.round((Date.now() - runAt) / 1000),
      cont: continueUsed ? 1 : 0,
      seen: seen
    });
    A.flush(false);

    // Обновляем доступность ролика к следующему экрану смерти. Ответ придёт
    // асинхронно, поэтому текущий экран рисуется по прошлому значению —
    // инвентарь меняется медленно, отставание на один забег не страшно.
    P.checkRewarded();
  }

  /* --- Апдейт ----------------------------------------------------------- */

  /* Спутники ходят по общему эллипсу вокруг своей чёрной дыры. */
  function moveSatellites(time) {
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var h = s.host;
      if (!h) continue;
      var ang = h.phase + s.offset + time * h.w;
      var lx = Math.cos(ang) * h.a;
      var ly = Math.sin(ang) * h.b;
      var c = Math.cos(h.rot), sn = Math.sin(h.rot);
      s.x = h.x + lx * c - ly * sn;
      s.y = h.y + lx * sn + ly * c;
    }
  }

  function update(dt, time) {
    var i;
    worldTime = time;

    // Кипение светил и вращение дисков идёт всегда — в меню мир не должен
    // выглядеть мёртвым.
    for (i = 0; i < stars.length; i++) stars[i].rot += stars[i].spinSpeed * dt;
    for (i = 0; i < holes.length; i++) holes[i].spin += dt * 1.6;
    for (i = 0; i < portals.length; i++) portals[i].spin += dt * 2.2;
    moveSatellites(time);

    for (i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.94;
      p.vy *= 0.94;
    }
    shake = Math.max(0, shake - dt * 2.2);
    if (toast.life > 0) toast.life -= dt;

    if (state !== 'play') return;

    for (i = 0; i < stars.length; i++) {
      var st = stars[i];
      if (st.type === 'mover') st.x = st.baseX + Math.sin(time * st.speed + st.phase) * st.amp;
    }

    if (ball.mode === 'orbit') {
      var a = ball.anchor;
      ball.angle += OMEGA * ball.dir * dt;
      syncOrbitPosition();

      if (a.type === 'fragile' && a.decay > 0) {
        a.decay -= dt;
        if (a.decay <= 0) {
          burst(a.x, a.y, 14, '#ff9f43');
          die();
          return;
        }
      }
    } else {
      ball.flyTime += dt;
      ball.portalCd -= dt;
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;

      // Кротовая нора. Выбрасывает строго вверх: направление входа
      // сохранять нельзя — тогда после выхода часто некуда цепляться.
      if (ball.portalCd <= 0) {
        for (i = 0; i < portals.length; i++) {
          var pt = portals[i];
          var pdx = ball.x - pt.ax;
          var pdy = ball.y - pt.ay;
          if (pdx * pdx + pdy * pdy < pt.r * pt.r) {
            burst(ball.x, ball.y, 10, '#38bdf8');
            ball.x = pt.bx;
            ball.y = pt.by;
            ball.vx = 0;
            ball.vy = -FLY_SPEED;
            ball.flyTime = 0;
            ball.portalCd = 0.4;
            seen.portal = 1;
            trail = [];
            burst(ball.x, ball.y, 12, '#f472b6');
            S.portal();
            break;
          }
        }
      }

      // Захват ближайшей ещё не пройденной звездой.
      for (i = 0; i < stars.length; i++) {
        var t = stars[i];
        if (t.visited || t.decay === -2) continue;
        var dx = ball.x - t.x;
        var dy = ball.y - t.y;
        if (Math.sqrt(dx * dx + dy * dy) < t.r + ORBIT_GAP + 16) {
          // Направление вращения наследуем из знака векторного произведения,
          // иначе шарик дёргается в обратную сторону в момент захвата.
          var cross = dx * ball.vy - dy * ball.vx;
          attach(t, Math.atan2(dy, dx), cross > 0 ? 1 : -1);
          t.visited = true;
          score++;
          S.latch(score);
          burst(ball.x, ball.y, 8, skin().core);
          ensureStars();
          break;
        }
      }
      if (ball.flyTime > MAX_FLY) { die(); return; }
    }

    for (i = 0; i < pickups.length; i++) {
      var c = pickups[i];
      if (c.taken) continue;
      c.t += dt * 3;
      if (Math.abs(c.x - ball.x) < 22 && Math.abs(c.y - ball.y) < 22) {
        c.taken = true;
        runCoins++;
        S.coin();
        burst(c.x, c.y, 5, '#ffd166');
      }
    }

    // Камера едет только вверх — кроме случая, когда метеор висит на спутнике
    // чёрной дыры. Спутник сам уезжает вниз по эллипсу и утаскивает игрока
    // за нижний край экрана, поэтому за ним камера следует в обе стороны.
    var onSatellite = ball.mode === 'orbit' && ball.anchor && ball.anchor.host;
    var target = ball.y - 150;
    if (target < camY || onSatellite) camY = lerp(camY, target, Math.min(1, dt * 5));

    // Горизонт событий: коснулся — забег окончен.
    for (i = 0; i < holes.length; i++) {
      var h = holes[i];
      var hdx = ball.x - h.x;
      var hdy = ball.y - h.y;
      if (hdx * hdx + hdy * hdy < (h.r + BALL_R) * (h.r + BALL_R)) {
        burst(ball.x, ball.y, 18, '#c084fc');
        die();
        return;
      }
    }

    // За края убиваем только в полёте. Пока метеор висит на звезде, игрок
    // ничего не решает — умирать там не за что.
    if (ball.mode === 'fly') {
      var bottom = camY + (H * 0.5) / scale + 40;
      if (ball.y > bottom || Math.abs(ball.x) > HALF_W + 80) die();
    }
  }

  /* --- Рендер ----------------------------------------------------------- */

  function render(c) {
    ctx = c;
    ctx.setTransform(core.dpr, 0, 0, core.dpr, 0, 0);

    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0a1030');
    g.addColorStop(1, '#05070f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    drawBackdrop();

    var sx = shake ? rand(-1, 1) * shake * 9 : 0;
    var sy = shake ? rand(-1, 1) * shake * 9 : 0;

    ctx.save();
    ctx.translate(W / 2 + sx, H / 2 + sy);
    ctx.scale(scale, scale);
    ctx.translate(0, -camY);
    drawWorld();
    ctx.restore();

    drawVignette();

    buttons = [];
    drawUI();
  }

  // Дальний план едет медленнее — дешёвый параллакс с зацикливанием.
  function parallaxY(y, depth) {
    var span = VIEW_H * 2;
    return ((y - camY * depth) % span + span) % span - VIEW_H;
  }

  function drawBackdrop() {
    var i;
    ctx.save();

    for (i = 0; i < nebulae.length; i++) {
      var n = nebulae[i];
      var nx = W / 2 + n.x * scale;
      var ny = H / 2 + parallaxY(n.y, n.depth) * scale;
      var nr = n.r * scale;
      if (nx + nr < 0 || nx - nr > W) continue;
      var g = ctx.createRadialGradient(nx, ny, 0, nx, ny, nr);
      g.addColorStop(0, n.tint + n.alpha + ')');
      g.addColorStop(0.55, n.tint + (n.alpha * 0.35) + ')');
      g.addColorStop(1, n.tint + '0)');
      ctx.fillStyle = g;
      ctx.fillRect(nx - nr, ny - nr, nr * 2, nr * 2);
    }

    for (i = 0; i < bgDots.length; i++) {
      var d = bgDots[i];
      var px = W / 2 + d.x * scale;
      var py = H / 2 + parallaxY(d.y, d.depth) * scale;
      if (px < -5 || px > W + 5) continue;
      ctx.globalAlpha = d.depth;
      ctx.fillStyle = '#9fb4ff';
      ctx.beginPath();
      ctx.arc(px, py, d.r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /* Виньетка: на широком экране собирает внимание к игровой колонке. */
  function drawVignette() {
    var g = ctx.createRadialGradient(
      W / 2, H / 2, Math.min(W, H) * 0.32,
      W / 2, H / 2, Math.max(W, H) * 0.72
    );
    g.addColorStop(0, 'rgba(2,4,12,0)');
    g.addColorStop(1, 'rgba(2,4,12,0.72)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawWorld() {
    var i;

    for (i = 0; i < portals.length; i++) drawPortal(portals[i]);
    for (i = 0; i < holes.length; i++) drawHole(holes[i]);
    for (i = 0; i < stars.length; i++) drawStar(stars[i]);

    for (i = 0; i < pickups.length; i++) {
      var c = pickups[i];
      if (c.taken) continue;
      ctx.fillStyle = '#ffd166';
      ctx.shadowColor = '#ffd166';
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(c.x, c.y + Math.sin(c.t) * 3, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    if (state === 'play' || state === 'dead') {
      trail.push({ x: ball.x, y: ball.y });
      if (trail.length > 22) trail.shift();
      drawTail();
    }

    for (i = 0; i < particles.length; i++) {
      var p = particles[i];
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (state === 'play') drawMeteor();
  }

  function drawStar(st) {
    if (st.decay === -2) return;   // погасшая

    var pal = STAR_PALETTE[st.type] || STAR_PALETTE.normal;
    var t = worldTime;
    var R = st.r * (1 + 0.04 * Math.sin(t * 2.2 + st.phase));
    // Хрупкая звезда мигает тем чаще, чем меньше ей осталось.
    var alpha = st.decay > 0 ? 0.45 + 0.55 * Math.abs(Math.sin(st.decay * 14)) : 1;
    var k, a0;

    ctx.save();
    ctx.translate(st.x, st.y);
    ctx.globalAlpha = alpha;

    // Мягкое свечение — ровный круг. Рваным его делать нельзя:
    // получается не звезда, а клякса.
    var halo = ctx.createRadialGradient(0, 0, R * 0.9, 0, 0, R * 2.5);
    halo.addColorStop(0, pal.flame);
    halo.addColorStop(0.32, pal.halo);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, R * 2.5, 0, TAU);
    ctx.fill();

    // Кайма пламени: слегка колышущийся контур чуть шире диска.
    // Центр потом перекроется телом, наружу останется только огненный край.
    ctx.globalAlpha = alpha * 0.5;
    ctx.fillStyle = pal.mid;
    ctx.beginPath();
    for (k = 0; k <= 48; k++) {
      a0 = (k / 48) * TAU;
      var wob = R * (1.16 + 0.055 * Math.sin(a0 * 5 + t * 1.8 + st.phase)
                          + 0.035 * Math.sin(a0 * 9 - t * 2.6));
      var px = Math.cos(a0) * wob, py = Math.sin(a0) * wob;
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = alpha;

    // Протуберанцы — короткие дуги, прижатые к поверхности.
    ctx.save();
    ctx.globalAlpha = alpha * 0.45;
    ctx.strokeStyle = pal.hot;
    ctx.lineWidth = R * 0.07;
    ctx.lineCap = 'round';
    for (k = 0; k < 3; k++) {
      a0 = st.phase + k * 2.2 + t * st.spinSpeed * 1.4;
      ctx.beginPath();
      ctx.arc(0, 0, R * (1.05 + 0.05 * Math.sin(t * 2 + k)), a0, a0 + 0.42);
      ctx.stroke();
    }
    ctx.restore();

    // Диск с лимбовым затемнением: центр пересвечен, край уходит в тёмное.
    var body = ctx.createRadialGradient(0, 0, R * 0.05, 0, 0, R);
    body.addColorStop(0, pal.hot);
    body.addColorStop(0.4, pal.core);
    body.addColorStop(0.78, pal.mid);
    body.addColorStop(1, pal.edge);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();

    // Кипящая поверхность: пятна плазмы, ползущие по диску.
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.clip();
    for (k = 0; k < 6; k++) {
      var ang = st.phase + k * 1.05 + t * st.spinSpeed * 0.8;
      var rad = R * (0.28 + 0.24 * Math.sin(t * 0.9 + k * 1.7 + st.phase));
      var bx = Math.cos(ang) * R * 0.5;
      var by = Math.sin(ang) * R * 0.5;
      var hot = k % 2 === 0;
      var blob = ctx.createRadialGradient(bx, by, 0, bx, by, Math.abs(rad) + R * 0.2);
      blob.addColorStop(0, hot ? pal.hot : pal.mid);
      blob.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = alpha * (hot ? 0.42 : 0.5);
      ctx.fillStyle = blob;
      ctx.beginPath();
      ctx.arc(bx, by, Math.abs(rad) + R * 0.2, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // Кольцо орбиты показываем только у звезды, на которой висим.
    if (ball && ball.anchor === st) {
      ctx.globalAlpha = alpha * 0.32;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, ball.radius, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* Кротовая нора: вход (голубой) и выход (розовый), связанные пунктиром. */
  function drawPortal(p) {
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.strokeStyle = '#a5b4fc';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 12]);
    ctx.beginPath();
    ctx.moveTo(p.ax, p.ay);
    ctx.lineTo(p.bx, p.by);
    ctx.stroke();
    ctx.restore();

    drawPortalEnd(p.ax, p.ay, p.r, p.spin, '#7dd3fc', 'rgba(14,165,233,0.55)');
    drawPortalEnd(p.bx, p.by, p.r, -p.spin, '#f9a8d4', 'rgba(219,39,119,0.55)');
  }

  function drawPortalEnd(x, y, r, spin, ring, glow) {
    ctx.save();
    ctx.translate(x, y);

    var g = ctx.createRadialGradient(0, 0, r * 0.1, 0, 0, r * 1.5);
    g.addColorStop(0, 'rgba(3,4,12,0.95)');
    g.addColorStop(0.5, glow);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.5, 0, TAU);
    ctx.fill();

    // Вихрь из трёх дуг, крутящихся в разные стороны.
    ctx.strokeStyle = ring;
    ctx.lineCap = 'round';
    for (var i = 0; i < 3; i++) {
      var s = spin * (i % 2 ? -1.4 : 1) + i * 2.1;
      ctx.globalAlpha = 0.8 - i * 0.2;
      ctx.lineWidth = r * (0.15 - i * 0.03);
      ctx.beginPath();
      ctx.arc(0, 0, r * (0.42 + i * 0.24), s, s + 2.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* Чёрная дыра: аккреционный диск, фотонное кольцо и абсолютно чёрный центр. */
  function drawHole(h) {
    ctx.save();
    ctx.translate(h.x, h.y);

    // Траектория спутников — иначе система не читается заранее.
    // У одиночной дыры-преграды спутников нет, орбиту рисовать нечего.
    if (h.a > 0 && h.b > 0) {
      ctx.save();
      ctx.rotate(h.rot);
      ctx.globalAlpha = 0.16;
      ctx.strokeStyle = '#b39dff';
      ctx.setLineDash([5, 9]);
      // Эллипс через scale+arc: ctx.ellipse есть не во всех старых Safari.
      ctx.scale(1, h.b / h.a);
      ctx.lineWidth = 1.4 * (h.a / h.b);
      ctx.beginPath();
      ctx.arc(0, 0, h.a, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    // Гравитационное свечение вокруг горизонта.
    var glow = ctx.createRadialGradient(0, 0, h.r * 0.9, 0, 0, h.r * 3.4);
    glow.addColorStop(0, 'rgba(190,120,255,0.45)');
    glow.addColorStop(0.4, 'rgba(90,40,180,0.20)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, h.r * 3.4, 0, TAU);
    ctx.fill();

    // Аккреционный диск — сплюснутое вращающееся кольцо.
    ctx.save();
    ctx.rotate(h.rot - 0.25);
    ctx.scale(1, 0.34);
    for (var i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.55 - i * 0.15;
      ctx.strokeStyle = i === 0 ? '#ffd36b' : (i === 1 ? '#ff7a3d' : '#a855f7');
      ctx.lineWidth = h.r * (0.34 - i * 0.08);
      ctx.beginPath();
      ctx.arc(0, 0, h.r * (1.55 + i * 0.42), h.spin + i, h.spin + i + 5.1);
      ctx.stroke();
    }
    ctx.restore();

    // Фотонное кольцо и сам горизонт событий.
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = '#ffe9b0';
    ctx.lineWidth = Math.max(1.5, h.r * 0.11);
    ctx.beginPath();
    ctx.arc(0, 0, h.r * 1.12, 0, TAU);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.fillStyle = '#02030a';
    ctx.beginPath();
    ctx.arc(0, 0, h.r, 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  /* Хвост метеора: широкое пламя снаружи и яркая жила внутри. */
  function drawTail() {
    if (trail.length < 2) return;
    var sk = skin();
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? sk.glow : sk.core;
      for (var i = 1; i < trail.length; i++) {
        var f = i / trail.length;
        ctx.globalAlpha = (pass === 0 ? 0.4 : 0.8) * f * f;
        ctx.lineWidth = (pass === 0 ? BALL_R * 2.1 : BALL_R * 0.7) * f;
        ctx.beginPath();
        ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
        ctx.lineTo(trail[i].x, trail[i].y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawMeteor() {
    var sk = skin();
    var dx, dy;
    if (ball.mode === 'orbit') {
      dx = -Math.sin(ball.angle) * ball.dir;
      dy = Math.cos(ball.angle) * ball.dir;
    } else {
      var m = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy) || 1;
      dx = ball.vx / m;
      dy = ball.vy / m;
    }

    ctx.save();
    ctx.translate(ball.x, ball.y);
    ctx.rotate(Math.atan2(dy, dx));

    // Кома — раскалённое облако вокруг ядра.
    var coma = ctx.createRadialGradient(BALL_R * 0.3, 0, BALL_R * 0.2, 0, 0, BALL_R * 2.7);
    coma.addColorStop(0, sk.core);
    coma.addColorStop(0.35, sk.mid);
    coma.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = coma;
    ctx.beginPath();
    ctx.arc(0, 0, BALL_R * 2.7, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;

    var body = ctx.createRadialGradient(BALL_R * 0.35, -BALL_R * 0.3, BALL_R * 0.1, 0, 0, BALL_R);
    body.addColorStop(0, '#ffffff');
    body.addColorStop(0.45, sk.core);
    body.addColorStop(1, sk.mid);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, BALL_R, 0, TAU);
    ctx.fill();

    // Пара кратеров: без них голова читается как обычный шарик.
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#2b1a0e';
    ctx.beginPath();
    ctx.arc(-BALL_R * 0.28, BALL_R * 0.22, BALL_R * 0.26, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(BALL_R * 0.05, -BALL_R * 0.38, BALL_R * 0.15, 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  /* Мини-метеор для витрины скинов.
     Хвост держим коротким: длинный вылезал за ячейку и наезжал на соседей. */
  function drawSkinPreview(x, y, sk, s) {
    var N = 7;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.3);
    for (var i = N - 1; i >= 0; i--) {
      var f = 1 - i / N;
      ctx.globalAlpha = f * f * 0.85;
      ctx.fillStyle = i < 2 ? sk.core : sk.mid;
      ctx.beginPath();
      ctx.arc(-i * s * 0.24, 0, s * 0.45 * f, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    var g = ctx.createRadialGradient(s * 0.15, -s * 0.15, s * 0.04, 0, 0, s * 0.5);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.45, sk.core);
    g.addColorStop(1, sk.mid);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.5, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /* --- UI (рисуется в экранных координатах) ------------------------------ */

  function text(str, x, y, size, color, align, weight) {
    ctx.font = (weight || 700) + ' ' + Math.round(size * us) +
      'px Rubik, system-ui, -apple-system, Arial, sans-serif';
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color || '#ffffff';
    ctx.fillText(str, x, y);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function button(label, sub, cx, cy, w, h, fill, action) {
    w *= us;
    h *= us;
    var x = cx - w / 2;
    var y = cy - h / 2;

    ctx.save();
    ctx.fillStyle = fill;
    roundRect(x, y, w, h, h / 2);
    ctx.fill();
    if (sub) {
      text(label, cx, cy - h * 0.14, 20, '#0b1020', 'center', 800);
      text(sub, cx, cy + h * 0.24, 12, 'rgba(11,16,32,0.75)', 'center', 600);
    } else {
      text(label, cx, cy, 21, '#0b1020', 'center', 800);
    }
    ctx.restore();

    buttons.push({ x: x, y: y, w: w, h: h, action: action });
  }

  function panel(cx, cy, w, h) {
    w *= us;
    h *= us;
    ctx.save();
    ctx.fillStyle = 'rgba(8,12,30,0.86)';
    roundRect(cx - w / 2, cy - h / 2, w, h, 22 * us);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,150,255,0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  function drawUI() {
    var cx = W / 2;

    if (state === 'play') {
      text(String(score), cx, 46 * us, 44, 'rgba(255,255,255,0.95)', 'center', 800);
      text(T.t('best') + ' ' + save.best, cx, 84 * us, 14, 'rgba(160,180,255,0.7)', 'center', 600);
      text('◈ ' + (save.coins + runCoins), W - 16 * us, 34 * us, 16, '#ffd166', 'right', 700);
      // Подсказка живёт только до первого набранного очка.
      if (score === 0) {
        text(T.t('tapToStart'), cx, H - 46 * us, 15, 'rgba(200,215,255,0.55)', 'center', 600);
      }
    } else if (state !== 'boot') {
      // Затемняем мир, иначе звёзды просвечивают сквозь текст меню.
      ctx.fillStyle = 'rgba(4,7,18,0.66)';
      ctx.fillRect(0, 0, W, H);
    }

    if (toast.life > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, toast.life * 2);
      text(toast.text, cx, H - 92 * us, 15, '#ffd166', 'center', 700);
      ctx.restore();
    }

    if (state === 'menu') drawMenu(cx);
    else if (state === 'dead') drawDead(cx);
    else if (state === 'shop') drawShop(cx);
    else if (state === 'boot') text(T.t('loading'), cx, H / 2, 18, 'rgba(255,255,255,0.7)');
  }

  function drawMenu(cx) {
    var cy = H * 0.32;
    text(T.t('title'), cx, cy, 52, '#ffffff', 'center', 800);
    text(T.t('hint'), cx, cy + 44 * us, 14, 'rgba(160,180,255,0.75)', 'center', 500);

    button(T.t('play'), null, cx, H * 0.56, 210, 60, '#7cf0c0', startRun);
    button(T.t('shop'), null, cx, H * 0.56 + 80 * us, 210, 52, '#5f7bff', openShop);

    text('◈ ' + save.coins, cx, H * 0.56 + 142 * us, 16, '#ffd166', 'center', 700);
    soundToggle(cx, H - 34 * us);
  }

  function drawDead(cx) {
    // Показываем ровно одну rewarded-кнопку: продолжить важнее удвоения.
    // rewardedReady — ответ площадки на «есть ли сейчас ролик». Без него
    // игрок жмёт кнопку, ждёт и получает «награда не засчитана».
    var adAction = null, adLabel = '', adKind = '';
    if (P.available && P.rewardedReady) {
      if (!continueUsed && score > 0) {
        adAction = doContinue;
        adLabel = '▶ ' + T.t('continueAd');
        adKind = 'continue';
      } else if (runCoins > 0) {
        adAction = doDoubleCoins;
        adLabel = '×2  ◈' + runCoins;
        adKind = 'x2';
      }
    }

    /* Экран рисуется каждый кадр, поэтому предложение считаем один раз за
       смерть. Без этой отметки видны только нажатия, а сколько игроков
       кнопку вообще увидели — нет, и конверсия в показ не считается. */
    if (adKind && adOffer !== adKind) {
      adOffer = adKind;
      A.event('ad_offer', { s: adKind, dev: P.deviceType || '?' });
    }

    var cy = H * 0.44;
    var h = adAction ? 268 : 200;
    panel(cx, cy, 300, h);

    var top = cy - (h / 2) * us;
    text(T.t('gameOver'), cx, top + 34 * us, 22, 'rgba(255,255,255,0.85)', 'center', 700);
    text(String(score), cx, top + 78 * us, 46, '#ffffff', 'center', 800);
    text(newBest ? T.t('newBest') : T.t('best') + ' ' + save.best,
      cx, top + 114 * us, 14, newBest ? '#7cf0c0' : 'rgba(160,180,255,0.75)', 'center', 600);

    var row = top + (adAction ? 224 : 156) * us;
    if (adAction) button(adLabel, T.t('forAd'), cx, top + 160 * us, 250, 58, '#ffd166', adAction);

    button(T.t('again'), null, cx - 68 * us, row, 124, 46, '#7cf0c0', startRun);
    button(T.t('shop'), null, cx + 68 * us, row, 124, 46, '#5f7bff', openShop);
  }

  function drawShop(cx) {
    text(T.t('shop'), cx, H * 0.14, 30, '#ffffff', 'center', 800);
    text('◈ ' + save.coins, cx, H * 0.14 + 34 * us, 16, '#ffd166', 'center', 700);

    var cols = 3;
    var cellW = 104 * us;
    var cellH = 116 * us;
    var startX = cx - (cols - 1) * cellW / 2;
    var startY = H * 0.34;

    for (var i = 0; i < SKINS.length; i++) {
      var sk = SKINS[i];
      var x = startX + (i % cols) * cellW;
      var y = startY + Math.floor(i / cols) * cellH;
      var owned = save.owned.indexOf(i) >= 0;
      var active = save.skin === i;

      if (active) {
        ctx.save();
        ctx.fillStyle = 'rgba(124,240,192,0.10)';
        roundRect(x - 46 * us, y - 34 * us, 92 * us, 92 * us, 16 * us);
        ctx.fill();
        ctx.strokeStyle = '#7cf0c0';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      ctx.globalAlpha = owned ? 1 : 0.38;
      ctx.shadowColor = sk.glow;
      ctx.shadowBlur = 18;
      drawSkinPreview(x + 14 * us, y - 6 * us, sk, 34 * us);
      ctx.restore();

      text(T.lang === 'ru' ? sk.ru : sk.en, x, y + 28 * us, 12,
        owned ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)', 'center', 700);

      var label = active ? T.t('equipped') : (owned ? T.t('equip') : '◈ ' + sk.cost);
      text(label, x, y + 45 * us, 11,
        active ? '#7cf0c0' : (owned ? 'rgba(160,180,255,0.75)' : '#ffd166'), 'center', 600);

      buttons.push({
        x: x - 46 * us, y: y - 34 * us, w: 92 * us, h: 92 * us,
        action: makeSkinAction(i)
      });
    }

    button(T.t('back'), null, cx, H - 74 * us, 190, 52, '#5f7bff', function () {
      state = 'menu';
      S.click();
    });
    soundToggle(cx, H - 26 * us);
  }

  function makeSkinAction(i) {
    return function () {
      if (save.owned.indexOf(i) >= 0) {
        save.skin = i;
        S.click();
      } else if (save.coins >= SKINS[i].cost) {
        save.coins -= SKINS[i].cost;
        save.owned.push(i);
        save.skin = i;
        S.reward();
      } else {
        S.tone({ freq: 200, dur: 0.12, type: 'square', gain: 0.3 });
        return;
      }
      persist();
    };
  }

  function soundToggle(cx, cy) {
    text(T.t('sound') + ': ' + (save.sound ? T.t('on') : T.t('off')),
      cx, cy, 13, 'rgba(160,180,255,0.7)', 'center', 600);
    var w = 140 * us;
    var h = 32 * us;
    buttons.push({
      x: cx - w / 2, y: cy - h / 2, w: w, h: h,
      action: function () {
        save.sound = !save.sound;
        S.setEnabled(save.sound);
        S.click();
        persist();
      }
    });
  }

  /* --- Переходы состояний ------------------------------------------------ */

  /* Короткое сообщение внизу экрана. Нужно, когда действие не
     сработало по внешней причине — например, реклама не загрузилась:
     без него кнопка просто молчит, и игрок думает, что игра сломана. */
  function showToast(msg) {
    toast.text = msg;
    toast.life = 2.4;
  }

  function openShop() {
    state = 'shop';
    S.click();
  }

  function startRun() {
    S.click();
    runs++;
    // Полноэкранная — раз в 3 забега; частоту всё равно режет платформа.
    var wantAd = (runs > 1 && runs % INTERSTITIAL_EVERY === 1);
    A.event('run_start', { n: runs, ad: wantAd ? 1 : 0 });
    var pre = wantAd ? P.showInterstitial() : Promise.resolve(false);
    adBusy = true;
    pre.then(function (shown) {
      adBusy = false;
      if (wantAd) A.event('ad', adInfo('interstitial', 'pre', shown));
      resetRun();
      state = 'play';
      P.gameplayStart();
    }).catch(function () {
      // Забег важнее рекламы: что бы ни случилось с показом, играть можно.
      adBusy = false;
      resetRun();
      state = 'play';
      P.gameplayStart();
    });
  }

  /* Одно место, где собирается всё про показ рекламы: формат, откуда
     вызвали, показалось ли, и код отказа от площадки. Без кода отказа
     нельзя отличить пустой инвентарь от закрытого игроком ролика, а это
     разные проблемы. */
  function adInfo(format, src, ok) {
    var o = { f: format, s: src, ok: ok ? 1 : 0, dev: P.deviceType || '?' };
    if (!ok && P.lastAdError !== undefined && P.lastAdError !== null) o.err = P.lastAdError;
    return o;
  }

  /* Возрождение на последней пройденной звезде, с неё же снимается
     хрупкость. Вынесено отдельно, потому что вызывается из двух мест: сразу
     после просмотренного ролика и позже, если ответ площадки опоздал. */
  function revive() {
    continueUsed = true;
    S.reward();

    var host = null;
    for (var i = stars.length - 1; i >= 0; i--) {
      if (stars[i].visited && stars[i].decay !== -2) { host = stars[i]; break; }
    }
    if (!host) {
      host = stars[0];
      host.visited = true;
    }
    host.type = 'normal';
    host.decay = -1;

    trail = [];
    attach(host, -Math.PI / 2, 1);
    syncOrbitPosition();
    camY = ball.y - 150;
    ensureStars();
    state = 'play';
    P.gameplayStart();
  }

  /* Награда, которую площадка подтвердила уже после того, как игра перестала
     её ждать. Игрок ролик посмотрел, значит он своё получает — вопрос лишь
     в том, где он к этому моменту находится. Если всё ещё на экране смерти,
     отдаём обещанное продолжение; если уже убежал играть дальше, монетами,
     потому что возрождать посреди чужого забега нельзя. */
  function onLateReward() {
    A.event('ad', adInfo('reward', 'late', 1));
    A.flush(false);
    if (state === 'dead' && !continueUsed && score > 0) {
      revive();
      return;
    }
    var bonus = runCoins > 0 ? runCoins : 1;
    save.coins += bonus;
    runCoins = 0;
    S.reward();
    persist();
    showToast('+' + bonus + ' ◈');
  }

  function doContinue() {
    if (adBusy) return;
    adBusy = true;
    S.click();
    // Ввод на это время закрыт, поэтому экран обязан сказать, что он занят,
    // а не просто перестать отзываться.
    showToast(T.t('adWait'));
    P.showRewarded().then(function (rewarded) {
      adBusy = false;
      A.event('ad', adInfo('reward', 'continue', rewarded));
      if (!rewarded) {
        showToast(T.t('adFailed'));
        A.flush(false);
        return;
      }
      revive();
    }).catch(function () {
      adBusy = false;
      showToast(T.t('adFailed'));
    });
  }

  function doDoubleCoins() {
    if (adBusy) return;
    adBusy = true;
    S.click();
    showToast(T.t('adWait'));
    P.showRewarded().then(function (rewarded) {
      adBusy = false;
      A.event('ad', adInfo('reward', 'x2', rewarded));
      if (!rewarded) {
        showToast(T.t('adFailed'));
        A.flush(false);
        return;
      }
      // runCoins уже начислены в die(), реклама даёт вторую такую же порцию.
      save.coins += runCoins;
      runCoins = 0;
      S.reward();
      persist();
    }).catch(function () {
      adBusy = false;
      showToast(T.t('adFailed'));
    });
  }

  function persist() {
    P.save({
      best: save.best, coins: save.coins, skin: save.skin,
      owned: save.owned, sound: save.sound
    }, 'orbita');
  }

  /* --- Ввод -------------------------------------------------------------- */

  function onPress(x, y) {
    S.unlock();
    S.resume();
    if (adBusy) return;

    // (-1,-1) приходит с клавиатуры: это всегда действие, а не клик по кнопке.
    if (x < 0) {
      if (state === 'play') release();
      else if (state === 'menu' || state === 'dead') startRun();
      return;
    }

    if (state === 'play') {
      release();
      return;
    }

    for (var i = buttons.length - 1; i >= 0; i--) {
      var b = buttons[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        b.action();
        return;
      }
    }
  }

  /* --- Старт ------------------------------------------------------------- */

  function layout(w, h) {
    W = w;
    H = h;
    scale = Math.min(W / (HALF_W * 2 + 30), H / VIEW_H);
    us = clamp(Math.min(W / 420, H / 760), 0.72, 1.9);
    makeBackdrop();
  }

  /* Канвас сам шрифт не подгружает: если не дождаться, первые кадры
     нарисуются запасным шрифтом и «прыгнут» при подмене. */
  function waitForFont() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    return Promise.all([
      document.fonts.load('800 44px Rubik', '0123456789'),
      document.fonts.load('700 21px Rubik', 'Орбита Играть Скины'),
      document.fonts.load('600 14px Rubik', 'Score Best Play Skins')
    ]).catch(function () { /* нет шрифта — рисуем запасным */ });
  }

  function boot() {
    // До всего остального: события до init() просто теряются.
    A.init('orbita');

    core = new global.Core('game');
    core.onResize = layout;
    core.onUpdate = update;
    core.onRender = render;
    core.onPress = onPress;
    core.onVisibility = function (hidden) {
      // Уход со вкладки — это пауза геймплея по требованиям площадки.
      if (hidden) P.gameplayStop();
      else if (state === 'play') P.gameplayStart();
    };

    layout(global.innerWidth, global.innerHeight);
    resetRun();
    core.start();

    P.init().then(function () {
      T.use(P.lang);
      return P.load('orbita');
    }).then(function (data) {
      if (data) {
        save.best = data.best || 0;
        save.coins = data.coins || 0;
        save.skin = data.skin || 0;
        save.owned = (data.owned && data.owned.length) ? data.owned : [0];
        save.sound = data.sound !== false;
      }
      S.setEnabled(save.sound);
      state = 'menu';
      return waitForFont();
    }).then(function () {
      // Всё готово, игрок может играть — сообщаем площадке ровно один раз.
      P.ready();
      /* Баннер поднимаем здесь, а не раньше: до этой точки игрок смотрит
         на экран загрузки, а показ меняет размер окна и пересобирает
         канвас. Пусть перестройка случится, пока смотреть не на что. */
      P.onBannerClosed = function () { A.event('ad', adInfo('banner', 'closed', 0)); };
      P.onLateAd = onLateReward;
      P.showBanner().then(function (shown) {
        A.event('ad', adInfo('banner', 'boot', shown));
      });
      // Спрашиваем про рекламу заранее, чтобы к первой смерти ответ был.
      P.checkRewarded().then(function (has) {
        A.event('ready', {
          dev: P.deviceType || '?',
          sdk: P.available ? 1 : 0,
          rew: has ? 1 : 0,
          best: save.best
        });
        A.flush(false);
      });
    });
  }

  /* Единственный след режима съёмки в боевой сборке. Без engine/shot.js
     условие ложно, и блок не выполняется — в zip ничего лишнего не уезжает. */
  if (global.Shot) {
    global.Shot.attach({
      C: { HALF_W: HALF_W, VIEW_H: VIEW_H, BALL_R: BALL_R,
           ORBIT_GAP: ORBIT_GAP, FLY_SPEED: FLY_SPEED, TAU: TAU },
      getState: function () { return state; },
      setState: function (v) { state = v; },
      world: function () {
        return { stars: stars, holes: holes, portals: portals,
                 pickups: pickups, particles: particles, ball: ball };
      },
      clear: function () {
        stars = []; holes = []; portals = []; pickups = [];
        particles = []; trail = [];
      },
      makeStar: makeStar,
      grab: function (star, angle, dir) {
        attach(star, angle, dir);
        star.visited = true;
        syncOrbitPosition();
      },
      fly: function (x, y, vx, vy) {
        ball.mode = 'fly';
        ball.anchor = null;
        ball.x = x; ball.y = y; ball.vx = vx; ball.vy = vy;
        ball.flyTime = 0;
      },
      trail: function (points) { trail = points; },
      set: function (o) {
        if (o.score !== undefined) score = o.score;
        if (o.best !== undefined) save.best = o.best;
        if (o.coins !== undefined) save.coins = o.coins;
        if (o.runCoins !== undefined) runCoins = o.runCoins;
        if (o.skin !== undefined) save.skin = o.skin;
        if (o.owned !== undefined) save.owned = o.owned;
        if (o.camY !== undefined) camY = o.camY;
        if (o.time !== undefined) worldTime = o.time;
      },
      moveSatellites: moveSatellites,
      // Съёмка сама решает, когда двигать и когда рисовать.
      freeze: function () { core.paused = true; },
      render: function () { render(core.ctx); },

      // Для видео: симуляция крутится вручную, по кадру за вызов.
      // Так запись не зависит от requestAnimationFrame и воспроизводима.
      step: function (dt) { update(dt, worldTime + dt); },
      release: release,
      // Начать забег сразу с узла n: в ролике механики должны появиться
      // в первые секунды, а не на двадцатом прыжке.
      startRunAt: function (n) {
        resetRun();
        nextIndex = n;
        state = 'play';
        ensureStars();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, false);
  } else {
    boot();
  }
})(window);
