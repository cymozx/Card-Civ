// ===========================================================================
// render.js — 화면 그리기 + 드래그 처리
// ===========================================================================
'use strict';

var Render = (function () {

  var elBoard, elCanvas, elShop, elInfo, elLog, elToast;
  var toastTimer = null;

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
  function canvasPoint(e) {
    var r = elCanvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onCardMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
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

    var p = canvasPoint(e);
    drag = {
      stack: newStack,
      el: el,
      grabDX: p.x - newStack.x,
      grabDY: p.y - newStack.y
    };
    pending = null;
  }

  function onMouseMove(e) {
    if (pending) {
      var dx = e.clientX - pending.startClientX;
      var dy = e.clientY - pending.startClientY;
      if (dx * dx + dy * dy > 16) beginDrag(e);
      return;
    }
    if (!drag) return;

    var p = canvasPoint(e);
    var nx = clamp(p.x - drag.grabDX, 0, BOARD_W - CARD_W);
    var ny = clamp(p.y - drag.grabDY, 0, BOARD_H - stackHeight(drag.stack));
    drag.stack.x = nx;
    drag.stack.y = ny;
    drag.el.style.left = nx + 'px';
    drag.el.style.top = ny + 'px';
  }

  function onMouseUp(e) {
    pending = null;
    if (!drag) return;

    var draggedStack = drag.stack;
    drag.el.classList.remove('dragging');
    drag = null;

    // .dragging 은 pointer-events:none 이었으므로, 커서 아래에는 놓을 대상이 잡힌다.
    var under = document.elementFromPoint(e.clientX, e.clientY);
    var targetCardEl = under ? under.closest('.card') : null;

    if (targetCardEl && targetCardEl.dataset.stackId) {
      var targetStack = stackById(parseInt(targetCardEl.dataset.stackId, 10));
      if (targetStack && targetStack !== draggedStack) {
        // 대상 스택 위에 얹는다.
        targetStack.cardUids = targetStack.cardUids.concat(draggedStack.cardUids);
        Game.stacks.splice(Game.stacks.indexOf(draggedStack), 1);
        // 얹은 스택을 맨 위로 올려 그린다.
        Game.stacks.splice(Game.stacks.indexOf(targetStack), 1);
        Game.stacks.push(targetStack);
      }
    }
    renderAll();
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
