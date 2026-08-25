# ---------------------------------------------------------------------------
# card_recipe_table_v3.xlsx  ->  cards-data.js  (엑셀 → 게임 데이터 변환 스크립트)
#
# '카드' / '레시피' 시트를 xlsx 패키지(zip + XML)에서 직접 읽어, 평범한
# <script src> 로 불러올 수 있는 JS 파일 하나로 내보낸다.
#
#   전역 변수 3개를 만든다:
#     CARD_DATA          카드 시트 전체
#     RECIPE_DATA        레시피 시트 전체
#     DATA_WARNINGS      변환 중 발견한 데이터 문제 (게임 화면 상단에 배너로 표시)
#
# 엑셀을 수정한 뒤에는 update-data.bat 을 더블클릭하면 이 스크립트가 돌아간다.
#
#   powershell -ExecutionPolicy Bypass -File tools\convert_xlsx_to_js.ps1
#
# (Python/openpyxl 이 첫 선택이었지만 이 PC에는 실제 Python 이 없어 —
#  Windows 스토어 스텁만 있음 — PowerShell 로 작성했다.)
# ---------------------------------------------------------------------------
param(
  [string]$XlsxPath = "$PSScriptRoot\..\card_recipe_table_v3.xlsx",
  [string]$OutPath  = "$PSScriptRoot\..\cards-data.js"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-EntryXml($zip, $name) {
  $entry = $zip.Entries | Where-Object { $_.FullName -eq $name }
  if ($null -eq $entry) { return $null }
  $sr = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
  $text = $sr.ReadToEnd(); $sr.Close()
  $xml = New-Object System.Xml.XmlDocument
  $xml.LoadXml($text)
  return $xml
}

function Convert-ColRefToIndex([string]$ref) {
  $letters = ($ref -replace '[0-9]', '')
  $n = 0
  foreach ($ch in $letters.ToCharArray()) { $n = $n * 26 + ([int][char]$ch - 64) }
  return $n - 1
}

# 시트를 string[] 행 배열로 읽는다 (0번 = 헤더 행).
function Read-Sheet($zip, $sheetName) {
  $wb   = Get-EntryXml $zip 'xl/workbook.xml'
  $rels = Get-EntryXml $zip 'xl/_rels/workbook.xml.rels'
  $relMap = @{}
  foreach ($r in $rels.DocumentElement.ChildNodes) {
    $relMap[$r.Id] = ($r.Target -replace '^/xl/', '' -replace '^/', '')
  }
  $shared = @()
  $ssXml = Get-EntryXml $zip 'xl/sharedStrings.xml'
  if ($ssXml) { foreach ($si in $ssXml.DocumentElement.ChildNodes) { $shared += $si.InnerText } }

  $target = $null
  foreach ($s in $wb.DocumentElement.SelectNodes('//*[local-name()="sheet"]')) {
    if ($s.GetAttribute('name') -eq $sheetName) {
      $rid = $s.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
      $target = $relMap[$rid]
    }
  }
  if (-not $target) { throw "'$sheetName' 시트를 찾을 수 없습니다. 시트 이름을 바꾸셨나요?" }
  if ($target -notlike 'xl/*') { $target = "xl/$target" }

  $sh = Get-EntryXml $zip $target
  $rows = @()
  foreach ($row in $sh.DocumentElement.SelectNodes('//*[local-name()="row"]')) {
    $cells = @{}; $maxIdx = -1
    foreach ($c in $row.SelectNodes('*[local-name()="c"]')) {
      $idx = Convert-ColRefToIndex $c.GetAttribute('r')
      $t = $c.GetAttribute('t')
      $vNode  = $c.SelectSingleNode('*[local-name()="v"]')
      $isNode = $c.SelectSingleNode('*[local-name()="is"]')
      $val = ''
      if ($t -eq 'inlineStr' -and $isNode) { $val = $isNode.InnerText }
      elseif ($t -eq 's' -and $vNode)      { $val = $shared[[int]$vNode.InnerText] }
      elseif ($vNode)                      { $val = $vNode.InnerText }
      $cells[$idx] = $val.Trim()
      if ($idx -gt $maxIdx) { $maxIdx = $idx }
    }
    $line = @()
    for ($i = 0; $i -le $maxIdx; $i++) {
      if ($cells.ContainsKey($i)) { $line += $cells[$i] } else { $line += '' }
    }
    $rows += ,$line
  }
  return ,$rows
}

function Get-Col($row, $map, $name) {
  if (-not $map.ContainsKey($name)) { return '' }
  $i = $map[$name]
  if ($i -ge $row.Count) { return '' }
  return $row[$i]
}

function ConvertTo-JsString($s) {
  if ($null -eq $s -or $s -eq '') { return '""' }
  $e = $s.Replace('\', '\\').Replace('"', '\"').Replace("`r", '').Replace("`n", '\n')
  return '"' + $e + '"'
}

# 빈 칸 -> null, 그 외에는 시트에 적힌 숫자 그대로.
function ConvertTo-JsNum($s) {
  if ($null -eq $s -or $s -eq '') { return 'null' }
  return $s
}

# 시트는 TRUE/FALSE 를 1/0 으로 저장한다.
function ConvertTo-JsBool($s) {
  if ($s -eq '1' -or $s -eq 'TRUE' -or $s -eq 'true') { return 'true' }
  return 'false'
}

$zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $XlsxPath))
try {
  $cardRows   = Read-Sheet $zip '카드'
  $recipeRows = Read-Sheet $zip '레시피'
} finally { $zip.Dispose() }

# --- 헤더 맵 ---------------------------------------------------------------
$cardHdr = @{}
for ($i = 0; $i -lt $cardRows[0].Count; $i++) { $cardHdr[$cardRows[0][$i]] = $i }
$recHdr = @{}
for ($i = 0; $i -lt $recipeRows[0].Count; $i++) { $recHdr[$recipeRows[0][$i]] = $i }

$requiredCardCols = @('id','name','type','costResource','costAmount','appearsInStartShop',
                      'appearsInLaterPool','startsOnBoard','startBoardCount',
                      'baseProductionResource','baseProductionAmount','attack','health',
                      'specialAbility','description')
$requiredRecipeCols = @('recipeId','ownerCardId','timing','ingredient1Id','ingredient1Qty',
                        'ingredient1Consumed','ingredient2Id','ingredient2Qty','ingredient2Consumed',
                        'resultType','resultCardId','resultQty','statTarget','statChange')

# --- 카드 이름 -> id (costResource 의 '황금' 을 'gold' 로 바꾸기 위함) --------
$nameToId = @{}
$idSet = @{}
for ($r = 1; $r -lt $cardRows.Count; $r++) {
  $id = Get-Col $cardRows[$r] $cardHdr 'id'
  if ($id -eq '') { continue }
  $nameToId[(Get-Col $cardRows[$r] $cardHdr 'name')] = $id
  $idSet[$id] = $r + 1
}

# ---------------------------------------------------------------------------
# 검증 — 엑셀을 고칠 때 흔히 나는 실수를 잡아 경고로 남긴다.
# 경고는 콘솔에 찍히고 DATA_WARNINGS 로도 나가서 게임 화면 위에 배너로 뜬다.
# 경고가 있어도 변환은 그대로 끝까지 진행한다(게임은 뜬다).
# ---------------------------------------------------------------------------
$warnings = @()
$knownTypes = @('resourceSite','resource','building','item','army','building/resourceSite')

foreach ($col in $requiredCardCols) {
  if (-not $cardHdr.ContainsKey($col)) { $warnings += "'카드' 시트에 '$col' 컬럼이 없습니다. 컬럼 이름은 바꾸지 마세요." }
}
foreach ($col in $requiredRecipeCols) {
  if (-not $recHdr.ContainsKey($col)) { $warnings += "'레시피' 시트에 '$col' 컬럼이 없습니다. 컬럼 이름은 바꾸지 마세요." }
}

$seen = @{}
$startShopCount = 0
for ($r = 1; $r -lt $cardRows.Count; $r++) {
  $row = $cardRows[$r]
  $id = Get-Col $row $cardHdr 'id'
  $rowNo = $r + 1
  if ($id -eq '') {
    if ((Get-Col $row $cardHdr 'name') -ne '') {
      $warnings += "'카드' ${rowNo}행: 이름은 있는데 id 가 비어 있습니다. 이 행은 무시됩니다."
    }
    continue
  }
  if ($seen.ContainsKey($id)) { $warnings += "'카드' ${rowNo}행: id '$id' 가 중복입니다. 뒤에 나온 행이 이깁니다." }
  $seen[$id] = $true

  $type = Get-Col $row $cardHdr 'type'
  if ($knownTypes -notcontains $type) {
    $warnings += "'카드' ${rowNo}행 ($id): 모르는 type '$type'. 아는 값은 $($knownTypes -join ', ') 입니다."
  }

  $costName = Get-Col $row $cardHdr 'costResource'
  if ($costName -ne '' -and -not $nameToId.ContainsKey($costName)) {
    $warnings += "'카드' ${rowNo}행 ($id): costResource '$costName' 와 이름이 같은 카드가 없습니다."
  }
  if ($costName -ne '' -and (Get-Col $row $cardHdr 'costAmount') -eq '') {
    $warnings += "'카드' ${rowNo}행 ($id): costResource 는 있는데 costAmount 가 비어 있어 구매할 수 없습니다."
  }
  if ($costName -eq '' -and ((Get-Col $row $cardHdr 'appearsInStartShop') -eq '1' -or (Get-Col $row $cardHdr 'appearsInLaterPool') -eq '1')) {
    $warnings += "'카드' ${rowNo}행 ($id): 가격이 없는데 상점에 등장하도록 돼 있어, 살 수 없는 카드가 상점 칸을 막습니다."
  }

  $bp = Get-Col $row $cardHdr 'baseProductionResource'
  if ($bp -ne '' -and -not $idSet.ContainsKey($bp)) {
    $warnings += "'카드' ${rowNo}행 ($id): baseProductionResource '$bp' 라는 id 의 카드가 없습니다."
  }
  if ($bp -ne '' -and (Get-Col $row $cardHdr 'baseProductionAmount') -eq '') {
    $warnings += "'카드' ${rowNo}행 ($id): baseProductionResource 는 있는데 baseProductionAmount 가 비어 있습니다."
  }
  $sbc = Get-Col $row $cardHdr 'startBoardCount'
  if ((Get-Col $row $cardHdr 'startsOnBoard') -eq '1' -and ($sbc -eq '' -or [double]$sbc -le 0)) {
    $warnings += "'카드' ${rowNo}행 ($id): startsOnBoard 가 TRUE 인데 startBoardCount 가 0 이라 보드에 놓이지 않습니다."
  }
  if ((Get-Col $row $cardHdr 'appearsInStartShop') -eq '1') { $startShopCount++ }
}

if ($startShopCount -ne 5) {
  $warnings += "appearsInStartShop=TRUE 인 카드가 ${startShopCount}장입니다. 상점은 5칸이라, 5장보다 많으면 넘치는 카드가 안 나오고 적으면 시작부터 빈 칸이 생깁니다."
}

for ($r = 1; $r -lt $recipeRows.Count; $r++) {
  $row = $recipeRows[$r]
  $rid = Get-Col $row $recHdr 'recipeId'
  $rowNo = $r + 1
  if ($rid -eq '') { continue }

  $owner = Get-Col $row $recHdr 'ownerCardId'
  if (-not $idSet.ContainsKey($owner)) {
    $warnings += "'레시피' ${rowNo}행 ($rid): ownerCardId '$owner' 라는 id 의 카드가 없어 이 레시피는 절대 발동하지 않습니다."
  }

  $timing = Get-Col $row $recHdr 'timing'
  if ($timing -ne '턴종료') {
    $warnings += "'레시피' ${rowNo}행 ($rid): timing 이 '$timing' 입니다. 이번 프로토타입은 '턴종료' 만 처리합니다."
  }

  $hasIng = $false
  foreach ($n in 1, 2) {
    $iid = Get-Col $row $recHdr "ingredient${n}Id"
    if ($iid -eq '') { continue }
    $hasIng = $true
    if (-not $idSet.ContainsKey($iid)) {
      $warnings += "'레시피' ${rowNo}행 ($rid): ingredient${n}Id '$iid' 라는 id 의 카드가 없습니다."
    }
    if ((Get-Col $row $recHdr "ingredient${n}Qty") -eq '') {
      $warnings += "'레시피' ${rowNo}행 ($rid): ingredient${n}Qty 가 비어 있습니다."
    }
  }
  if (-not $hasIng) {
    $warnings += "'레시피' ${rowNo}행 ($rid): 재료가 하나도 없어 조건 없이 매 턴 발동합니다."
  }

  $rtype = Get-Col $row $recHdr 'resultType'
  if ($rtype -eq 'produceCard') {
    $rc = Get-Col $row $recHdr 'resultCardId'
    if (-not $idSet.ContainsKey($rc)) {
      $warnings += "'레시피' ${rowNo}행 ($rid): resultCardId '$rc' 라는 id 의 카드가 없습니다."
    }
    if ((Get-Col $row $recHdr 'resultQty') -eq '') {
      $warnings += "'레시피' ${rowNo}행 ($rid): resultQty 가 비어 있습니다."
    }
  } elseif ($rtype -eq 'modifyStat') {
    $st = Get-Col $row $recHdr 'statTarget'
    if ($st -notmatch '^[A-Za-z0-9_]+\.[A-Za-z0-9_]+') {
      $warnings += "'레시피' ${rowNo}행 ($rid): statTarget '$st' 형식이 '카드id.능력치이름' 이 아닙니다."
    } elseif (-not $idSet.ContainsKey(($st -split '\.')[0])) {
      $warnings += "'레시피' ${rowNo}행 ($rid): statTarget 이 가리키는 카드 id '$(($st -split '\.')[0])' 가 없습니다."
    }
    if ((Get-Col $row $recHdr 'statChange') -eq '') {
      $warnings += "'레시피' ${rowNo}행 ($rid): statChange 가 비어 있습니다."
    }
  } else {
    $warnings += "'레시피' ${rowNo}행 ($rid): 모르는 resultType '$rtype'. produceCard 또는 modifyStat 만 됩니다."
  }
}

# ---------------------------------------------------------------------------
# 출력
# ---------------------------------------------------------------------------
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('// ===========================================================================')
[void]$sb.AppendLine('// 자동 생성 파일 — 직접 고치지 마세요. 다음 변환 때 덮어써집니다.')
[void]$sb.AppendLine('// 원본: card_recipe_table_v3.xlsx  (시트: 카드, 레시피)')
[void]$sb.AppendLine('// 다시 만들기: update-data.bat 더블클릭')
[void]$sb.AppendLine('//')
[void]$sb.AppendLine('// 평범한 <script src="cards-data.js"> 로 불러오므로 서버 없이 file:// 에서도')
[void]$sb.AppendLine('// 동작한다 (fetch 도 module 도 쓰지 않음).')
[void]$sb.AppendLine('// ===========================================================================')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('var DATA_GENERATED_AT = ' + (ConvertTo-JsString (Get-Date -Format 'yyyy-MM-dd HH:mm')) + ';')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('// 변환 중 발견한 데이터 문제. 비어 있지 않으면 게임 화면 위에 배너로 뜬다.')
if ($warnings.Count -eq 0) {
  [void]$sb.AppendLine('var DATA_WARNINGS = [];')
} else {
  [void]$sb.AppendLine('var DATA_WARNINGS = [')
  foreach ($w in $warnings) { [void]$sb.AppendLine('  ' + (ConvertTo-JsString $w) + ',') }
  [void]$sb.AppendLine('];')
}
[void]$sb.AppendLine('')
[void]$sb.AppendLine('var CARD_DATA = [')

for ($r = 1; $r -lt $cardRows.Count; $r++) {
  $row = $cardRows[$r]
  $id = Get-Col $row $cardHdr 'id'
  if ($id -eq '') { continue }

  # costResource 칸에는 한글 카드 이름이 들어 있다. 해석한 id 도 같이 저장한다.
  $costName = Get-Col $row $cardHdr 'costResource'
  $costId = 'null'
  if ($costName -ne '') {
    if ($nameToId.ContainsKey($costName)) { $costId = ConvertTo-JsString $nameToId[$costName] }
    else { $costId = ConvertTo-JsString $costName }
  }

  $f = @()
  $f += 'id: ' + (ConvertTo-JsString $id)
  $f += 'name: ' + (ConvertTo-JsString (Get-Col $row $cardHdr 'name'))
  $f += 'type: ' + (ConvertTo-JsString (Get-Col $row $cardHdr 'type'))
  $f += 'costResource: ' + $costId
  $f += 'costResourceName: ' + (ConvertTo-JsString $costName)
  $f += 'costAmount: ' + (ConvertTo-JsNum (Get-Col $row $cardHdr 'costAmount'))
  $f += 'appearsInStartShop: ' + (ConvertTo-JsBool (Get-Col $row $cardHdr 'appearsInStartShop'))
  $f += 'appearsInLaterPool: ' + (ConvertTo-JsBool (Get-Col $row $cardHdr 'appearsInLaterPool'))
  $f += 'startsOnBoard: ' + (ConvertTo-JsBool (Get-Col $row $cardHdr 'startsOnBoard'))
  $f += 'startBoardCount: ' + (ConvertTo-JsNum (Get-Col $row $cardHdr 'startBoardCount'))
  $f += 'baseProductionResource: ' + (ConvertTo-JsString (Get-Col $row $cardHdr 'baseProductionResource'))
  $f += 'baseProductionAmount: ' + (ConvertTo-JsNum (Get-Col $row $cardHdr 'baseProductionAmount'))
  $f += 'attack: ' + (ConvertTo-JsNum (Get-Col $row $cardHdr 'attack'))
  $f += 'health: ' + (ConvertTo-JsNum (Get-Col $row $cardHdr 'health'))
  $f += 'specialAbility: ' + (ConvertTo-JsString (Get-Col $row $cardHdr 'specialAbility'))
  $f += 'description: ' + (ConvertTo-JsString (Get-Col $row $cardHdr 'description'))
  [void]$sb.AppendLine('  { ' + ($f -join ', ') + ' },')
}
[void]$sb.AppendLine('];')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('var RECIPE_DATA = [')

$order = 0
for ($r = 1; $r -lt $recipeRows.Count; $r++) {
  $row = $recipeRows[$r]
  $rid = Get-Col $row $recHdr 'recipeId'
  if ($rid -eq '') { continue }

  # ingredient1 / ingredient2 를 배열 하나로 합친다. 빈 칸은 버린다.
  $ing = @()
  foreach ($n in 1, 2) {
    $iid = Get-Col $row $recHdr "ingredient${n}Id"
    if ($iid -eq '') { continue }
    $iq = Get-Col $row $recHdr "ingredient${n}Qty"
    $ic = Get-Col $row $recHdr "ingredient${n}Consumed"
    $ing += '{ id: ' + (ConvertTo-JsString $iid) + ', qty: ' + (ConvertTo-JsNum $iq) + ', consumed: ' + (ConvertTo-JsBool $ic) + ' }'
  }

  $f = @()
  $f += 'recipeId: ' + (ConvertTo-JsString $rid)
  $f += 'ownerCardId: ' + (ConvertTo-JsString (Get-Col $row $recHdr 'ownerCardId'))
  $f += 'ownerCardName: ' + (ConvertTo-JsString (Get-Col $row $recHdr 'ownerCardName'))
  $f += 'timing: ' + (ConvertTo-JsString (Get-Col $row $recHdr 'timing'))
  $f += 'ingredients: [' + ($ing -join ', ') + ']'
  $f += 'resultType: ' + (ConvertTo-JsString (Get-Col $row $recHdr 'resultType'))
  $f += 'resultCardId: ' + (ConvertTo-JsString (Get-Col $row $recHdr 'resultCardId'))
  $f += 'resultQty: ' + (ConvertTo-JsNum (Get-Col $row $recHdr 'resultQty'))
  $f += 'statTarget: ' + (ConvertTo-JsString (Get-Col $row $recHdr 'statTarget'))
  $f += 'statChange: ' + (ConvertTo-JsNum (Get-Col $row $recHdr 'statChange'))
  $f += 'description: ' + (ConvertTo-JsString (Get-Col $row $recHdr 'description'))
  # 시트 행 순서 — resultQty 가 같을 때의 우선순위 판정에 쓴다.
  $f += 'sheetOrder: ' + $order
  $order++
  [void]$sb.AppendLine('  { ' + ($f -join ', ') + ' },')
}
[void]$sb.AppendLine('];')

# BOM 포함: file:// 로 열었을 때 브라우저가 한글을 확실히 UTF-8 로 읽도록.
$utf8 = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($OutPath, $sb.ToString(), $utf8)

Write-Output ""
Write-Output ("[완료] cards-data.js 를 새로 만들었습니다. 카드 {0}장, 레시피 {1}개" -f $seen.Count, $order)
if ($warnings.Count -gt 0) {
  Write-Output ""
  Write-Output ("[경고 {0}건] 게임은 실행되지만 아래를 확인해 주세요:" -f $warnings.Count)
  foreach ($w in $warnings) { Write-Output ("  - " + $w) }
} else {
  Write-Output "[검사] 데이터 문제 없음."
}
Write-Output ""
Write-Output "index.html 을 새로고침(F5)하면 반영됩니다."
