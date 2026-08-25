// ===========================================================================
// game.js — 게임 상태 / 턴 로직 / 레시피 엔진
//
// 모든 수치는 cards-data.js (엑셀에서 변환) 에서만 읽는다. 여기서 새 수치를
// 만들어내지 않는다.
// ===========================================================================
'use strict';

// ------------------------------------------------------------------ 상수
var CARD_W = 104;          // 카드 가로 (index.html 의 .card 와 동일해야 함)
var CARD_H = 140;          // 카드 세로
var STACK_OFFSET = 34;     // 스택된 카드 사이의 세로 간격
var BOARD_W = 1760;        // 보드(스크롤 영역) 크기
var BOARD_H = 1180;

var SHOP_SLOT_COUNT = 5;   // 무작위로 채워지는 칸 수 (UI 규칙이라 엑셀에 없음)

var RECIPE_TIMING_TURN_END = '턴종료';

// ------------------------------------------------------- 데이터 인덱싱
var CARD_BY_ID = {};
for (var _i = 0; _i < CARD_DATA.length; _i++) {
  CARD_BY_ID[CARD_DATA[_i].id] = CARD_DATA[_i];
}

// ownerCardId -> 레시피 배열 (엑셀 행 순서 유지)
var RECIPES_BY_OWNER = {};
for (var _r = 0; _r < RECIPE_DATA.length; _r++) {
  var _rec = RECIPE_DATA[_r];
  if (!RECIPES_BY_OWNER[_rec.ownerCardId]) RECIPES_BY_OWNER[_rec.ownerCardId] = [];
  RECIPES_BY_OWNER[_rec.ownerCardId].push(_rec);
}

// 시작 상점 / 이후 리필 풀.
// 풀에는 appearsInLaterPool=TRUE 인 행을 '행마다 한 번씩' 넣는다. 같은 카드가
// 엑셀에 여러 줄 들어있으면 그만큼 중복 등록되어 등장 확률이 높아진다.
var START_SHOP_POOL = [];
var LATER_POOL = [];
for (var _c = 0; _c < CARD_DATA.length; _c++) {
  if (CARD_DATA[_c].appearsInStartShop) START_SHOP_POOL.push(CARD_DATA[_c].id);
  if (CARD_DATA[_c].appearsInLaterPool)  LATER_POOL.push(CARD_DATA[_c].id);
}

// ---------------------------------------------------------------------------
// 아래 세 가지는 엑셀에서 '유도'한다. 카드를 추가하거나 자원을 바꿔도 이 파일을
// 고칠 필요가 없도록 하기 위함이다.
//
//   CURRENCY_IDS        누군가의 costResource 로 쓰이는 자원 = 구매 시 자동 차감
//                       되는 화폐 (현재 데이터에서는 황금 / 식량)
//   FIXED_SHOP_CARD_ID  가격은 있지만 두 등장 플래그가 모두 FALSE 인 카드
//                       = 상점 6번째 고정 슬롯에 항상 노출되는 카드 (인구)
//   PLAY_RESOURCE_IDS   나머지 type=resource 카드 = 상단에 합계만 보여주는 자원
//                       (현재 데이터에서는 석유 / 강철 / 지지도)
// ---------------------------------------------------------------------------
var CURRENCY_IDS = [];
var FIXED_SHOP_CARD_ID = null;
var PLAY_RESOURCE_IDS = [];

for (var _d = 0; _d < CARD_DATA.length; _d++) {
  var _def = CARD_DATA[_d];
  if (_def.costResource && CURRENCY_IDS.indexOf(_def.costResource) < 0) {
    CURRENCY_IDS.push(_def.costResource);
  }
  if (_def.costResource && !_def.appearsInStartShop && !_def.appearsInLaterPool &&
      !_def.startsOnBoard && FIXED_SHOP_CARD_ID === null) {
    FIXED_SHOP_CARD_ID = _def.id;
  }
}
for (var _p = 0; _p < CARD_DATA.length; _p++) {
  var _pdef = CARD_DATA[_p];
  if (_pdef.type !== 'resource') continue;
  if (CURRENCY_IDS.indexOf(_pdef.id) >= 0) continue;
  if (_pdef.id === FIXED_SHOP_CARD_ID) continue;
  PLAY_RESOURCE_IDS.push(_pdef.id);
}

if (START_SHOP_POOL.length !== SHOP_SLOT_COUNT) {
  console.warn('appearsInStartShop=TRUE 카드가 ' + START_SHOP_POOL.length +
               '장인데 상점은 ' + SHOP_SLOT_COUNT + '칸입니다.');
}

// ------------------------------------------------------------ 표시용 아이콘
// 여기에 없는 카드는 종류별 기본 아이콘으로 그려진다. 엑셀에 카드를 추가해도
// 게임은 그대로 뜨고, 전용 아이콘을 주고 싶을 때만 한 줄 추가하면 된다.
var CARD_ICONS = {
  gold: '💰', food: '🌽', steel: '🔩', oil: '🛢️', support: '🎖️',
  population: '👤', guns: '🔫', warship: '🚢', military_vehicle: '🚚',
  gun_blueprint: '📐', radio_address: '📻',
  infantry: '🚶', patrol_boat: '⛴️', armored_car: '🛡️',
  white_house: '🏛️', gun_factory: '🏭', shipyard: '⚓',
  recruitment_office: '🎖', tank_factory: '🏗️',
  steel_field: '⛏️', food_field: '🌾', oil_field: '🏜️'
};

var TYPE_FALLBACK_ICONS = {
  resourceSite: '⛰️', resource: '📦', building: '🏢',
  item: '🧰', army: '🎖️', 'building/resourceSite': '🏛️'
};

var TYPE_LABELS = {
  resourceSite: '자원지',
  resource: '자원',
  building: '건물',
  item: '물품',
  army: '군대',
  'building/resourceSite': '건물·자원지'
};

function iconOf(def) {
  return CARD_ICONS[def.id] || TYPE_FALLBACK_ICONS[def.type] || '▪';
}

// 엑셀에 오타가 있어 id 가 존재하지 않아도 게임이 죽지 않도록, 이름 대신 id 를
// 그대로 돌려준다 (경고 배너가 어느 행이 문제인지 알려준다).
function nameOfId(cardId) {
  return CARD_BY_ID[cardId] ? CARD_BY_ID[cardId].name : cardId;
}

function typeLabelOf(def) {
  return TYPE_LABELS[def.type] || def.type;
}

// 카드 색상 클래스. 모르는 type 이면 기본 카드 색으로 떨어진다.
function typeClassOf(def) {
  if (def.type === 'building/resourceSite') return 't-dual';   // 백악관 같은 겸용 카드
  if (def.type.indexOf('/') >= 0) return 't-' + def.type.split('/')[0];
  return 't-' + def.type;
}

// ===========================================================================
// 게임 상태
//
//   card  : { uid, cardId, statMods }        보드 위 카드 1장(인스턴스)
//   stack : { id, x, y, cardUids: [uid...] } 보드 위 한 무더기. 낱장도 스택 1개.
//   cardUids[0] 이 맨 아래(기준 카드), 뒤로 갈수록 위에 얹힌 카드.
// ===========================================================================
var Game = {
  turn: 1,
  cards: {},        // uid -> card
  stacks: [],       // 렌더 순서 = 배열 순서 (뒤일수록 위)
  shopSlots: [],    // 길이 5, 각 칸은 cardId 또는 null(구매되어 비어있음)
  log: [],
  _nextUid: 1,
  _nextStackId: 1
};

// ------------------------------------------------------------ 기본 헬퍼
function cardOf(uid) { return Game.cards[uid]; }
function defOf(uid)  { return CARD_BY_ID[Game.cards[uid].cardId]; }

function stackById(id) {
  for (var i = 0; i < Game.stacks.length; i++) {
    if (Game.stacks[i].id === id) return Game.stacks[i];
  }
  return null;
}

function stackOfCard(uid) {
  for (var i = 0; i < Game.stacks.length; i++) {
    if (Game.stacks[i].cardUids.indexOf(uid) >= 0) return Game.stacks[i];
  }
  return null;
}

function stackHeight(stack) {
  return CARD_H + (stack.cardUids.length - 1) * STACK_OFFSET;
}

// 카드 인스턴스의 실제 능력치 = 엑셀 기본값 + modifyStat 레시피로 누적된 보정
function effectiveStat(card, field) {
  var base = CARD_BY_ID[card.cardId][field];
  if (base === null || base === undefined || base === '') base = 0;
  var mod = card.statMods[field] || 0;
  return base + mod;
}

function logLine(text) {
  Game.log.push(text);
  if (Game.log.length > 120) Game.log.shift();
}

// ------------------------------------------------------------ 카드 생성/삭제
function spawnCard(cardId, nearX, nearY) {
  if (!CARD_BY_ID[cardId]) { console.warn('알 수 없는 카드 id: ' + cardId); return null; }
  var uid = Game._nextUid++;
  Game.cards[uid] = { uid: uid, cardId: cardId, statMods: {} };

  var spot = findFreeSpot(nearX, nearY);
  var stack = { id: Game._nextStackId++, x: spot.x, y: spot.y, cardUids: [uid] };
  Game.stacks.push(stack);
  return uid;
}

function removeCard(uid) {
  var stack = stackOfCard(uid);
  if (stack) {
    stack.cardUids.splice(stack.cardUids.indexOf(uid), 1);
    if (stack.cardUids.length === 0) {
      Game.stacks.splice(Game.stacks.indexOf(stack), 1);
    }
  }
  delete Game.cards[uid];
}

// 겹치지 않는 빈 자리를 (nearX, nearY) 주변에서 나선형으로 찾는다.
function findFreeSpot(nearX, nearY) {
  var stepX = CARD_W + 14;
  var stepY = 52;
  var startX = clamp(Math.round((nearX || 40) / stepX) * stepX, 10, BOARD_W - CARD_W - 10);
  var startY = clamp(Math.round((nearY || 40) / stepY) * stepY, 10, BOARD_H - CARD_H - 10);

  for (var ring = 0; ring < 40; ring++) {
    for (var dy = -ring; dy <= ring; dy++) {
      for (var dx = -ring; dx <= ring; dx++) {
        if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        var x = startX + dx * stepX;
        var y = startY + dy * stepY;
        if (x < 8 || y < 8 || x > BOARD_W - CARD_W - 8 || y > BOARD_H - CARD_H - 8) continue;
        if (isSpotFree(x, y)) return { x: x, y: y };
      }
    }
  }
  // 자리를 못 찾으면 그냥 아무 데나 놓는다(프로토타입 안전장치).
  return {
    x: 10 + Math.random() * (BOARD_W - CARD_W - 20),
    y: 10 + Math.random() * (BOARD_H - CARD_H - 20)
  };
}

function isSpotFree(x, y) {
  for (var i = 0; i < Game.stacks.length; i++) {
    var s = Game.stacks[i];
    if (x < s.x + CARD_W && x + CARD_W > s.x &&
        y < s.y + stackHeight(s) && y + CARD_H > s.y) return false;
  }
  return true;
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// ------------------------------------------------------------ 자원 합계/차감
// 보드 위(스택 안이든 낱장이든) 해당 자원 카드의 총 장수
function countResource(resourceId) {
  var n = 0;
  for (var uid in Game.cards) {
    if (Game.cards[uid].cardId === resourceId) n++;
  }
  return n;
}

// 상점 구매 시 자동 차감. 낱장(스택 1장)부터 먼저 없애서, 건물 위에 재료로
// 쌓아둔 카드는 최대한 건드리지 않는다.
function removeResourceCards(resourceId, count) {
  var loose = [], stacked = [];
  for (var i = 0; i < Game.stacks.length; i++) {
    var s = Game.stacks[i];
    for (var j = 0; j < s.cardUids.length; j++) {
      var uid = s.cardUids[j];
      if (Game.cards[uid].cardId !== resourceId) continue;
      (s.cardUids.length === 1 ? loose : stacked).push(uid);
    }
  }
  var order = loose.concat(stacked);
  var removed = 0;
  for (var k = 0; k < order.length && removed < count; k++) {
    removeCard(order[k]);
    removed++;
  }
  return removed;
}

// ===========================================================================
// 레시피 엔진
// ===========================================================================

// avail: cardId -> [uid...] 형태의 재료 풀
function poolOfStack(stack) {
  var pool = {};
  for (var i = 0; i < stack.cardUids.length; i++) {
    var uid = stack.cardUids[i];
    var id = Game.cards[uid].cardId;
    if (!pool[id]) pool[id] = [];
    pool[id].push(uid);
  }
  return pool;
}

function clonePool(pool) {
  var out = {};
  for (var k in pool) out[k] = pool[k].slice();
  return out;
}

function poolRemoveUid(pool, cardId, uid) {
  var arr = pool[cardId];
  if (!arr) return;
  var idx = arr.indexOf(uid);
  if (idx >= 0) arr.splice(idx, 1);
}

function recipeMatches(recipe, pool) {
  if (recipe.timing !== RECIPE_TIMING_TURN_END) return false;
  for (var i = 0; i < recipe.ingredients.length; i++) {
    var ing = recipe.ingredients[i];
    var have = pool[ing.id] ? pool[ing.id].length : 0;
    if (have < ing.qty) return false;
  }
  return true;
}

// Consumed=TRUE 인 재료만 실제로 소모한다. pool 에서 즉시 빼서, 같은 턴에
// 같은 카드가 두 번 소모되지 않게 한다.
function takeConsumed(recipe, pool) {
  var taken = [];
  for (var i = 0; i < recipe.ingredients.length; i++) {
    var ing = recipe.ingredients[i];
    if (!ing.consumed) continue;
    for (var n = 0; n < ing.qty; n++) {
      var arr = pool[ing.id];
      if (!arr || arr.length === 0) break;   // 다른 레시피가 이미 가져간 경우
      taken.push(arr.shift());
    }
  }
  return taken;
}

// 이번 턴 종료 시 실제로 발동할 레시피 목록을 만든다 (상태를 바꾸지 않음).
// 하이라이트 미리보기와 실제 실행이 같은 함수를 쓴다.
function planTurnEnd() {
  var plans = [];

  for (var si = 0; si < Game.stacks.length; si++) {
    var stack = Game.stacks[si];
    var stackPool = poolOfStack(stack);   // 이 스택에서 아직 소모되지 않은 카드들

    for (var oi = 0; oi < stack.cardUids.length; oi++) {
      var ownerUid = stack.cardUids[oi];
      var owner = Game.cards[ownerUid];
      var recipes = RECIPES_BY_OWNER[owner.cardId];
      if (!recipes) continue;

      // 기준 카드 자신은 재료가 될 수 없다.
      var avail = clonePool(stackPool);
      poolRemoveUid(avail, owner.cardId, ownerUid);

      var matched = [];
      for (var ri = 0; ri < recipes.length; ri++) {
        if (recipeMatches(recipes[ri], avail)) matched.push(recipes[ri]);
      }
      if (matched.length === 0) continue;

      var chosen = [];

      // (c) produceCard 끼리는 경쟁: resultQty 최대 1개만, 동률이면 시트 위쪽.
      var winner = null;
      for (var mi = 0; mi < matched.length; mi++) {
        var r = matched[mi];
        if (r.resultType !== 'produceCard') continue;
        if (!winner ||
            r.resultQty > winner.resultQty ||
            (r.resultQty === winner.resultQty && r.sheetOrder < winner.sheetOrder)) {
          winner = r;
        }
      }
      if (winner) chosen.push(winner);

      // (d) modifyStat 은 경쟁과 무관하게 독립 판정 — 같은 턴에 함께 발동.
      for (var mj = 0; mj < matched.length; mj++) {
        if (matched[mj].resultType === 'modifyStat') chosen.push(matched[mj]);
      }

      // 소모 재료 확정. 현재 데이터에서는 produceCard 와 modifyStat 이 같은
      // 재료를 쓰지 않지만, 겹치더라도 카드 1장이 두 번 소모되지는 않는다.
      for (var ci = 0; ci < chosen.length; ci++) {
        var recipe = chosen[ci];
        var consumeUids = takeConsumed(recipe, avail);
        plans.push({
          stackId: stack.id,
          ownerUid: ownerUid,
          recipe: recipe,
          consumeUids: consumeUids
        });
        // 같은 스택에 건물이 둘 이상이면 뒤 건물은 남은 재료만 쓸 수 있다.
        for (var ui = 0; ui < consumeUids.length; ui++) {
          poolRemoveUid(stackPool, Game.cards[consumeUids[ui]].cardId, consumeUids[ui]);
        }
      }
    }
  }
  return plans;
}

// 하이라이트용: 이번 턴 발동 예정인 카드 uid -> 배지 텍스트
function pendingFireMap() {
  var plans = planTurnEnd();
  var map = {};
  for (var i = 0; i < plans.length; i++) {
    var p = plans[i];
    var label = p.recipe.resultType === 'produceCard'
      ? nameOfId(p.recipe.resultCardId) + ' ×' + p.recipe.resultQty
      : '능력치 +' + p.recipe.statChange;
    map[p.ownerUid] = map[p.ownerUid] ? map[p.ownerUid] + ' / ' + label : label;
  }
  return map;
}

// statTarget 예: "white_house.baseProductionAmount(gold)"  ->  baseProductionAmount
function applyStatChange(ownerCard, statTarget, statChange) {
  var head = String(statTarget).split('(')[0];      // "white_house.baseProductionAmount"
  var parts = head.split('.');
  var field = parts.length > 1 ? parts[1] : parts[0];
  ownerCard.statMods[field] = (ownerCard.statMods[field] || 0) + statChange;
  return field;
}

// ===========================================================================
// 턴 진행
// ===========================================================================

// 1. 턴 시작: baseProductionResource 가 채워진 모든 카드가 조건 없이 자동 생산
function runTurnStartProduction() {
  var producers = [];
  for (var si = 0; si < Game.stacks.length; si++) {
    var s = Game.stacks[si];
    for (var ci = 0; ci < s.cardUids.length; ci++) {
      var card = Game.cards[s.cardUids[ci]];
      var def = CARD_BY_ID[card.cardId];
      if (!def.baseProductionResource) continue;
      producers.push({ card: card, stack: s });
    }
  }

  for (var pi = 0; pi < producers.length; pi++) {
    var card = producers[pi].card;
    var stack = producers[pi].stack;
    var def = CARD_BY_ID[card.cardId];
    var amount = effectiveStat(card, 'baseProductionAmount');
    if (amount <= 0) continue;

    for (var n = 0; n < amount; n++) {
      spawnCard(def.baseProductionResource, stack.x + CARD_W + 14, stack.y);
    }
    logLine('  · ' + def.name + ' → ' + nameOfId(def.baseProductionResource) + ' ×' + amount);
  }
}

// 3.a~e. 턴 종료 시 레시피 판정 및 적용
function runTurnEndRecipes() {
  var plans = planTurnEnd();
  if (plans.length === 0) {
    logLine('  · 발동한 레시피 없음');
    return;
  }

  for (var i = 0; i < plans.length; i++) {
    var p = plans[i];
    var ownerCard = Game.cards[p.ownerUid];
    if (!ownerCard) continue;                       // 방어적 처리
    var ownerDef = CARD_BY_ID[ownerCard.cardId];
    var stack = stackById(p.stackId);
    var sx = stack ? stack.x : 40;
    var sy = stack ? stack.y : 40;

    // (e) Consumed=TRUE 재료만 제거
    for (var ci = 0; ci < p.consumeUids.length; ci++) {
      removeCard(p.consumeUids[ci]);
    }

    if (p.recipe.resultType === 'produceCard') {
      for (var n = 0; n < p.recipe.resultQty; n++) {
        spawnCard(p.recipe.resultCardId, sx + CARD_W + 14, sy);
      }
      logLine('  · [' + p.recipe.recipeId + '] ' + ownerDef.name + ' → ' +
              nameOfId(p.recipe.resultCardId) + ' ×' + p.recipe.resultQty);
    } else if (p.recipe.resultType === 'modifyStat') {
      var field = applyStatChange(ownerCard, p.recipe.statTarget, p.recipe.statChange);
      logLine('  · [' + p.recipe.recipeId + '] ' + ownerDef.name + ' ' + field +
              ' ' + (p.recipe.statChange >= 0 ? '+' : '') + p.recipe.statChange +
              ' (현재 ' + effectiveStat(ownerCard, field) + ')');
    }
  }
}

// 3.f. 비어있는 상점 슬롯을 이후 풀에서 무작위로 채움
function refillShop() {
  if (LATER_POOL.length === 0) return;
  var filled = [];
  for (var i = 0; i < Game.shopSlots.length; i++) {
    if (Game.shopSlots[i] !== null) continue;
    var pick = LATER_POOL[Math.floor(Math.random() * LATER_POOL.length)];
    Game.shopSlots[i] = pick;
    filled.push(nameOfId(pick));
  }
  if (filled.length > 0) logLine('  · 상점 보충: ' + filled.join(', '));
}

// ------------------------------------------------------------------ 구매
// 반환: { ok, reason }
function buyFromShop(slotIndex) {
  // slotIndex === -1 이면 고정 인구 슬롯
  var cardId = (slotIndex === -1) ? FIXED_SHOP_CARD_ID : Game.shopSlots[slotIndex];
  if (!cardId) return { ok: false, reason: '빈 슬롯입니다.' };

  var def = CARD_BY_ID[cardId];
  if (!def.costResource || def.costAmount === null) {
    return { ok: false, reason: def.name + '은(는) 상점에서 구매할 수 없는 카드입니다.' };
  }

  var have = countResource(def.costResource);
  if (have < def.costAmount) {
    return { ok: false, reason: nameOfId(def.costResource) + '이(가) 부족합니다. (' + have + ' / ' + def.costAmount + ')' };
  }

  removeResourceCards(def.costResource, def.costAmount);
  spawnCard(cardId, 40, 230);   // 보드 왼쪽 위, 처음부터 보이는 자리에 놓는다

  // 고정 슬롯(인구)은 구매해도 사라지지 않는다.
  if (slotIndex !== -1) Game.shopSlots[slotIndex] = null;

  logLine('  · 구매: ' + def.name + ' (' + nameOfId(def.costResource) + ' ' + def.costAmount + ')');
  return { ok: true };
}

// ------------------------------------------------------------------ 턴 종료
function endTurn() {
  logLine('── 턴 ' + Game.turn + ' 종료 ──');
  runTurnEndRecipes();   // a~e
  refillShop();          // f
  Game.turn++;           // g

  logLine('── 턴 ' + Game.turn + ' 시작 ──');
  runTurnStartProduction();  // 다음 턴의 1단계
}

// ------------------------------------------------------------------ 초기화
Game.init = function () {
  Game.turn = 1;
  Game.cards = {};
  Game.stacks = [];
  Game.log = [];
  Game._nextUid = 1;
  Game._nextStackId = 1;

  // 시작 상점 5칸 (appearsInStartShop=TRUE 카드들)
  Game.shopSlots = [];
  for (var i = 0; i < SHOP_SLOT_COUNT; i++) {
    Game.shopSlots.push(i < START_SHOP_POOL.length ? START_SHOP_POOL[i] : null);
  }

  // startsOnBoard=TRUE 카드들을 startBoardCount 만큼 보드에 배치
  var x = 60;
  for (var c = 0; c < CARD_DATA.length; c++) {
    var def = CARD_DATA[c];
    if (!def.startsOnBoard) continue;
    var count = def.startBoardCount || 0;
    for (var n = 0; n < count; n++) {
      var uid = Game._nextUid++;
      Game.cards[uid] = { uid: uid, cardId: def.id, statMods: {} };
      Game.stacks.push({ id: Game._nextStackId++, x: x, y: 60, cardUids: [uid] });
      x += CARD_W + 40;
    }
  }

  // 엑셀을 고치고 update-data.bat 을 돌렸는지 한눈에 확인할 수 있게 남긴다.
  logLine('데이터 변환 시각: ' + (typeof DATA_GENERATED_AT === 'string' ? DATA_GENERATED_AT : '알 수 없음'));
  logLine('카드 ' + CARD_DATA.length + '종 / 레시피 ' + RECIPE_DATA.length + '개');

  logLine('── 턴 1 시작 ──');
  runTurnStartProduction();
};
