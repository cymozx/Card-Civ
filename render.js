// ===========================================================================
// render.js — 화면 그리기 + 드래그 처리
// ===========================================================================
'use strict';

var Render = (function () {

  var elBoard, elCanvas, elShop, elInfo, elLog, elToast;
  var toastTimer = null;

  var SNAP_MS = 150;             // 붙을 때 미끄러져 들어오는 시간
  var DROP_SNAP_MARGIN = 30;     // 카드 중심이 무더기 밖이어도 이 거리(px)까지는 붙여줌

  // 드래그 상태
  var pending = null;   // 마우스를 눌렀지만 아직 움직이지 않은 상태
  var drag = null;      // 실제 드래그 중

  // ----------------------------------------------------------- 카드 DOM
  function makeCardEl(cardId, instance) {
    var def = CARD_BY_ID[cardId];
    var el = document.createElement('div');
    el.className = 'card ' + typeClassOf(def);

    var name = document.createElement('div');
    name.className = 'cname';
    name.textContent = def.name;
    el.appendChild(name);

    var icon = document.createElement('div');
    icon.className = 'cicon';
    icon.textContent = iconOf(def);
    el.appendChild(icon);

    // 자동 생산량 (인스턴스가 있으면 modifyStat 보정이 반영된 실제 값)
    if (def.baseProductionResource) {
      var prodAmt = instance
        ? effectiveStat(instance, 'baseProductionAmount')
        : (def.baseProductionAmount || 0);
      var prodDef = CARD_BY_ID[def.baseProductionResource];
      var prod = document.createElement('div');
      prod.className = 'cprod';
      prod.textContent = '⏱ ' + (prodDef ? iconOf(prodDef) : '?') + ' +' + prodAmt;
      el.appendChild(prod);
    }

    if (def.attack !== null || def.health !== null) {
      var stat = document.createElement('div');
      stat.className = 'cstat';
      stat.textContent = '⚔' + (def.attack === null ? '-' : def.attack) +
                         '  ♥' + (def.health === null ? '-' : def.health);
      el.appendChild(stat);
    }

    var type = document.createElement('div');
    type.className = 'ctype';
    type.textContent = typeLabelOf(def);
    el.appendChild(type);

    el.addEventListener('mouseenter', function () { showInfo(def, instance); });
    return el;
  }

  // ------------------------------------------------------------- 상단바
  // 표시할 자원 목록은 엑셀에서 유도된 CURRENCY_IDS / PLAY_RESOURCE_IDS 를
  // 그대로 따라간다. 자원 카드를 추가하면 상단바에도 자동으로 칸이 생긴다.
  function renderStatGroup(containerId, labelText, resourceIds, isCurrency) {
    var box = document.getElementById(containerId);
    box.innerHTML = '';

    var label = document.createElement('span');
    label.className = 'group-label';
    label.textContent = labelText;
    box.appendChild(label);

    for (var i = 0; i < resourceIds.length; i++) {
      var def = CARD_BY_ID[resourceIds[i]];
      if (!def) continue;

      var stat = document.createElement('div');
      stat.className = 'stat' + (isCurrency ? ' currency' : '');

      var icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = iconOf(def);

      var name = document.createElement('span');
      name.className = 'label';
      name.textContent = def.name;

      var value = document.createElement('span');
      value.className = 'value';
      value.textContent = countResource(def.id);

      stat.appendChild(icon);
      stat.appendChild(name);
      stat.appendChild(value);
      box.appendChild(stat);
    }
  }

  function renderTopbar() {
    renderStatGroup('stat-currency', '카드 자원', CURRENCY_IDS, true);
    renderStatGroup('stat-play', '플레이 자원', PLAY_RESOURCE_IDS, false);
    document.getElementById('turn-num').textContent = Game.turn;
  }

  // 변환 스크립트가 남긴 데이터 경고를 화면 위에 띄운다.
  function renderDataWarnings() {
    var box = document.getElementById('data-warning');
    var list = (typeof DATA_WARNINGS !== 'undefined') ? DATA_WARNINGS : [];
    if (!list || list.length === 0) { box.style.display = 'none'; return; }

    var html = '<b>⚠ 엑셀 데이터 경고 ' + list.length + '건</b> — 게임은 실행되지만 확인해 주세요.<ul>';
    for (var i = 0; i < list.length; i++) html += '<li>' + esc(list[i]) + '</li>';
    html += '</ul><button id="warn-close">닫기</button>';
    box.innerHTML = html;
    box.style.display = 'block';
    document.getElementById('warn-close').addEventListener('click', function () {
      box.style.display = 'none';
    });
  }

  // --------------------------------------------------------------- 상점
  function renderShop() {
    elShop.innerHTML = '';

    for (var i = 0; i < Game.shopSlots.length; i++) {
      elShop.appendChild(makeShopSlot(Game.shopSlots[i], i));
    }
    // 6번째: 항상 고정 노출되는 인구 슬롯
    elShop.appendChild(makeShopSlot(FIXED_SHOP_CARD_ID, -1));
  }

  function makeShopSlot(cardId, slotIndex) {
    var slot = document.createElement('div');
    slot.className = 'shop-slot' + (slotIndex === -1 ? ' fixed' : '');

    if (!cardId) {
      var note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = '턴 종료 시\n보충';
      note.style.whiteSpace = 'pre-line';
      slot.appendChild(note);
      return slot;
    }

    var def = CARD_BY_ID[cardId];
    var el = makeCardEl(cardId, null);

    var affordable = def.costResource !== null &&
                     countResource(def.costResource) >= def.costAmount;
    if (!affordable) el.classList.add('unaffordable');

    var costDef = def.costResource ? CARD_BY_ID[def.costResource] : null;
    var price = document.createElement('div');
    price.className = 'price-tag';
    price.textContent = costDef
      ? iconOf(costDef) + ' ' + def.costAmount
      : '구매 불가';
    el.appendChild(price);

    el.addEventListener('click', function () {
      var res = buyFromShop(slotIndex);
      if (!res.ok) { toast(res.reason); return; }
      renderAll();
    });

    slot.appendChild(el);
    return slot;
  }

  // --------------------------------------------------------------- 보드
  function renderBoard() {
    elCanvas.innerHTML = '';
    elCanvas.style.width = BOARD_W + 'px';
    elCanvas.style.height = BOARD_H + 'px';

    var fireMap = pendingFireMap();

    for (var si = 0; si < Game.stacks.length; si++) {
      var stack = Game.stacks[si];
      var sEl = document.createElement('div');
      sEl.className = 'stack';
      sEl.style.left = stack.x + 'px';
      sEl.style.top = stack.y + 'px';
      sEl.style.width = CARD_W + 'px';
      sEl.style.height = stackHeight(stack) + 'px';
      sEl.dataset.stackId = stack.id;

      for (var ci = 0; ci < stack.cardUids.length; ci++) {
        var uid = stack.cardUids[ci];
        var card = Game.cards[uid];
        var cEl = makeCardEl(card.cardId, card);
        cEl.style.top = (ci * STACK_OFFSET) + 'px';
        cEl.style.zIndex = ci + 1;
        cEl.dataset.uid = uid;
        cEl.dataset.stackId = stack.id;

        if (fireMap[uid]) {
          cEl.classList.add('will-fire');
          var badge = document.createElement('div');
          badge.className = 'fire-badge';
          badge.textContent = '▶ ' + fireMap[uid];
          cEl.appendChild(badge);
        }

        // 스택 맨 아래 카드에는 총 장수를 표시
        if (ci === 0 && stack.cardUids.length > 1) {
          var cnt = document.createElement('div');
          cnt.className = 'count-badge';
          cnt.textContent = stack.cardUids.length;
          cEl.appendChild(cnt);
        }

        cEl.addEventListener('mousedown', onCardMouseDown);
        sEl.appendChild(cEl);
      }
      elCanvas.appendChild(sEl);
    }
  }

  // ------------------------------------------------------------ 정보/로그
  function showInfo(def, instance) {
    var html = '<div class="iname">' + esc(def.name) + '</div>';

    var meta = typeLabelOf(def);
    if (def.costResource) {
      meta += ' · 가격 ' + esc(nameOfId(def.costResource)) + ' ' + def.costAmount;
    }
    if (def.baseProductionResource) {
      var amt = instance ? effectiveStat(instance, 'baseProductionAmount') : def.baseProductionAmount;
      meta += ' · 매 턴 시작 ' + esc(nameOfId(def.baseProductionResource)) + ' +' + amt;
    }
    if (def.attack !== null || def.health !== null) {
      meta += ' · 공격 ' + (def.attack === null ? '-' : def.attack) +
              ' / 체력 ' + (def.health === null ? '-' : def.health);
    }
    html += '<div class="imeta">' + meta + '</div>';
    html += '<div>' + esc(def.description) + '</div>';

    if (def.specialAbility) {
      html += '<div class="irecipe">★ ' + esc(def.specialAbility) + ' (전투 미구현)</div>';
    }

    var recipes = RECIPES_BY_OWNER[def.id];
    if (recipes) {
      for (var i = 0; i < recipes.length; i++) {
        var r = recipes[i];
        var ing = [];
        for (var j = 0; j < r.ingredients.length; j++) {
          var g = r.ingredients[j];
          ing.push(esc(nameOfId(g.id)) + '×' + g.qty + (g.consumed ? '(소모)' : '(유지)'));
        }
        var result = r.resultType === 'produceCard'
          ? esc(nameOfId(r.resultCardId)) + '×' + r.resultQty
          : esc(r.statTarget) + ' ' + (r.statChange >= 0 ? '+' : '') + r.statChange;
        html += '<div class="irecipe">[' + r.recipeId + '] ' + ing.join(' + ') + ' → ' + result + '</div>';
      }
    }
    elInfo.innerHTML = html;
  }

  function renderLog() {
    var html = '';
    for (var i = 0; i < Game.log.length; i++) {
      var line = Game.log[i];
      html += '<div' + (line.indexOf('──') === 0 ? ' class="lturn"' : '') + '>' + esc(line) + '</div>';
    }
    elLog.innerHTML = html;
    elLog.scrollTop = elLog.scrollHeight;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function toast(msg) {
    elToast.textContent = msg;
    elToast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { elToast.classList.remove('show'); }, 1700);
  }

  // ------------------------------------------------------------- 드래그
  function canvasPointXY(clientX, clientY) {
    var r = elCanvas.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  function canvasPoint(e) { return canvasPointXY(e.clientX, e.clientY); }

  // 붙는 애니메이션이 아직 돌고 있으면 카드의 '보이는 위치'가 최종 위치와 다르다.
  // 그 상태에서 카드를 집으면 잡은 지점이 어긋나므로, 집기 전에 애니메이션을 끝낸다.
  function finishSnapAnimations() {
    var cards = elCanvas.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      if (!cards[i].style.transform && !cards[i].style.transition) continue;
      cards[i].style.transition = '';
      cards[i].style.transform = '';
    }
    var landed = elCanvas.querySelectorAll('.stack.stack-landed');
    for (var j = 0; j < landed.length; j++) landed[j].classList.remove('stack-landed');
  }

  function onCardMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    finishSnapAnimations();
    pending = {
      uid: parseInt(this.dataset.uid, 10),
      startClientX: e.clientX,
      startClientY: e.clientY
    };
  }

  function beginDrag(e) {
    var uid = pending.uid;
    var srcStack = stackOfCard(uid);
    if (!srcStack) { pending = null; return; }

    var idx = srcStack.cardUids.indexOf(uid);

    // 잡은 카드와 그 위에 얹힌 카드들을 통째로 떼어내 새 스택으로 만든다.
    var moved = srcStack.cardUids.splice(idx);
    var newStack = {
      id: Game._nextStackId++,
      x: srcStack.x,
      y: srcStack.y + idx * STACK_OFFSET,
      cardUids: moved
    };
    if (srcStack.cardUids.length === 0) {
      Game.stacks.splice(Game.stacks.indexOf(srcStack), 1);
    }
    Game.stacks.push(newStack);   // 배열 끝 = 맨 위에 그려짐

    renderBoard();

    var el = elCanvas.querySelector('.stack[data-stack-id="' + newStack.id + '"]');
    if (!el) { pending = null; return; }
    el.classList.add('dragging');

    // 잡은 지점은 '마우스를 누른 순간' 기준으로 잰다. 드래그가 시작되는 첫 이동
    // 시점으로 재면 그 이동거리만큼 카드가 커서보다 밀려서 따라온다.
    var p = canvasPointXY(pending.startClientX, pending.startClientY);
    drag = {
      stack: newStack,
      el: el,
      target: null,          // 지금 놓으면 붙을 스택
      grabDX: p.x - newStack.x,
      grabDY: p.y - newStack.y
    };
    updateDropHighlight(findDropTarget(newStack));
    document.body.classList.add('dragging-now');
    pending = null;
  }

  function onMouseMove(e) {
    if (pending) {
      var dx = e.clientX - pending.startClientX;
      var dy = e.clientY - pending.startClientY;
      if (dx * dx + dy * dy <= 16) return;   // 그냥 클릭인지 드래그인지 구분하는 최소 거리
      beginDrag(e);
      // 아래로 계속 진행해서 이번 이동분까지 바로 반영한다.
    }
    if (!drag) return;

    var p = canvasPoint(e);
    var nx = clamp(p.x - drag.grabDX, 0, BOARD_W - CARD_W);
    var ny = clamp(p.y - drag.grabDY, 0, BOARD_H - stackHeight(drag.stack));
    drag.stack.x = nx;
    drag.stack.y = ny;
    drag.el.style.left = nx + 'px';
    drag.el.style.top = ny + 'px';

    updateDropHighlight(findDropTarget(drag.stack));
  }

  // 놓을 대상 찾기 — 규칙은 딱 하나다.
  //
  //   "끌고 있는 카드의 한가운데(●)가 올라가 있는 무더기에 붙는다."
  //
  // 카드도 무더기도 화면에 그려진 실제 사각형 그대로 계산한다. 끌고 있는 카드에
  // 확대/회전 같은 효과를 주지 않는 것도 이 때문이다 — 보이는 자리와 계산하는
  // 자리가 어긋나면 판정이 이상하게 느껴진다.
  //
  // 중심이 어떤 무더기에도 안 걸쳤을 때만, 가장 가까운 무더기가 DROP_SNAP_MARGIN
  // px 안에 있으면 거기에 붙여준다(살짝 빗나간 경우를 위한 여유).
  function findDropTarget(draggedStack) {
    // 실제로 내려놓게 되는 카드 = 끌고 있는 무더기의 맨 아래 카드
    var cx = draggedStack.x + CARD_W / 2;
    var cy = draggedStack.y + CARD_H / 2;

    var best = null;
    var bestScore = Infinity;

    for (var i = 0; i < Game.stacks.length; i++) {
      var s = Game.stacks[i];
      if (s === draggedStack) continue;

      var left = s.x;
      var right = s.x + CARD_W;
      var top = s.y;
      var bottom = s.y + stackHeight(s);   // 무더기가 실제로 차지하는 세로 길이

      // 중심점에서 무더기 사각형까지의 거리. 사각형 안이면 0.
      var gapX = Math.max(left - cx, 0, cx - right);
      var gapY = Math.max(top - cy, 0, cy - bottom);
      var gap = Math.sqrt(gapX * gapX + gapY * gapY);
      if (gap > DROP_SNAP_MARGIN) continue;

      // 여러 무더기가 걸리면: 먼저 '안에 들어간 것' 우선, 그다음 중심이 가까운 것.
      var toCenterX = cx - (left + right) / 2;
      var toCenterY = cy - (top + bottom) / 2;
      var score = gap * 10000 + Math.sqrt(toCenterX * toCenterX + toCenterY * toCenterY);

      if (score < bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  function clearDropHighlight() {
    var marked = elCanvas.querySelectorAll('.stack.drop-target');
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove('drop-target');
  }

  // 지금 놓으면 어디에 붙는지 점선 자리로 미리 보여준다.
  function updateDropHighlight(target) {
    if (drag.target === target) return;
    clearDropHighlight();
    drag.target = target;
    if (!target) return;
    var el = elCanvas.querySelector('.stack[data-stack-id="' + target.id + '"]');
    if (el) el.classList.add('drop-target');
  }

  // 놓은 자리에서 붙을 자리로 '착' 미끄러져 들어오는 효과.
  // 게임 상태는 이미 합쳐진 뒤라, 애니메이션 도중 무슨 일이 생겨도 데이터는 안전하다.
  function snapAnimate(stackId, fromDX, fromDY, startIndex) {
    var sEl = elCanvas.querySelector('.stack[data-stack-id="' + stackId + '"]');
    if (!sEl) return;
    var cards = sEl.querySelectorAll('.card');

    for (var i = startIndex; i < cards.length; i++) {
      cards[i].style.transition = 'none';
      cards[i].style.transform = 'translate(' + fromDX + 'px, ' + fromDY + 'px)';
    }
    void sEl.offsetWidth;   // 위 시작 위치를 확정시키기 위한 강제 리플로우

    for (var j = startIndex; j < cards.length; j++) {
      cards[j].style.transition = 'transform ' + SNAP_MS + 'ms cubic-bezier(0.2, 0.85, 0.3, 1.3)';
      cards[j].style.transform = 'translate(0, 0)';
    }

    sEl.classList.add('stack-landed');
    setTimeout(function () { sEl.classList.remove('stack-landed'); }, 340);
  }

  function onMouseUp(e) {
    pending = null;
    if (!drag) return;

    var draggedStack = drag.stack;
    var target = drag.target;
    drag.el.classList.remove('dragging');
    document.body.classList.remove('dragging-now');
    clearDropHighlight();
    drag = null;

    if (!target) { renderAll(); return; }

    // 붙기 전(놓은 자리)과 붙은 뒤 자리의 차이를 재두었다가 애니메이션 시작점으로 쓴다.
    var landedIndex = target.cardUids.length;
    var fromDX = draggedStack.x - target.x;
    var fromDY = draggedStack.y - (target.y + landedIndex * STACK_OFFSET);

    target.cardUids = target.cardUids.concat(draggedStack.cardUids);
    Game.stacks.splice(Game.stacks.indexOf(draggedStack), 1);
    // 얹은 스택을 맨 위로 올려 그린다.
    Game.stacks.splice(Game.stacks.indexOf(target), 1);
    Game.stacks.push(target);

    renderAll();
    snapAnimate(target.id, fromDX, fromDY, landedIndex);
  }

  // ------------------------------------------------------------- 렌더 전체
  function renderAll() {
    renderTopbar();
    renderShop();
    renderBoard();
    renderLog();
  }

  // --------------------------------------------------------------- 초기화
  function init() {
    elBoard  = document.getElementById('board');
    elCanvas = document.getElementById('board-canvas');
    elShop   = document.getElementById('shop-slots');
    elInfo   = document.getElementById('info-panel');
    elLog    = document.getElementById('log-panel');
    elToast  = document.getElementById('toast');

    document.getElementById('end-turn').addEventListener('click', function () {
      endTurn();
      renderAll();
    });

    renderDataWarnings();

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    // 브라우저 기본 드래그(이미지/텍스트) 방지
    document.addEventListener('dragstart', function (e) { e.preventDefault(); });

    renderAll();
  }

  // renderDataWarnings 는 init 에서 한 번만 부른다(닫기 상태를 유지하기 위해).
  return { init: init, renderAll: renderAll, renderDataWarnings: renderDataWarnings, toast: toast };
})();
