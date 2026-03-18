// =========================================================
// 品出しアシスタント Pro - script.js
// バーコードスキャン + 商品情報自動取得 + タスク管理
// =========================================================

'use strict';

// =========================================================
// 定数・グローバル状態
// =========================================================
const TAB_FILES = { drinks: 'drinks.csv', paper: 'paper.csv' };
const CATEGORY_ORDER_DRINKS = ['水', 'お茶', 'ジュース', '炭酸', '大型飲料', 'コーヒー', 'その他'];
const CATEGORY_ORDER_PAPER  = ['キッチン', 'ティッシュ', 'トイレットペーパー'];

// 部門判定キーワード
const DEPT_DAILY_KEYWORDS  = ['牛乳', '乳', 'ヨーグルト', 'チーズ', '豆腐', '納豆', '卵', 'たまご', '惣菜', 'おにぎり', 'パン', '弁当', '刺身', '寿司', 'サラダ', '漬物', '日配'];
const DEPT_SNACK_KEYWORDS  = ['チョコ', 'ポテト', 'せんべい', 'クッキー', 'スナック', 'ガム', 'キャンディ', '飴', 'グミ', 'アイス', '菓子', 'ビスケット', 'おかし', 'プリン', 'ゼリー'];

let currentTab = 'drinks';
let products = [];
let tasks = [];
let outOfStockItems    = JSON.parse(localStorage.getItem('outOfStockItems')    || '[]');
let outOfStockCounts   = JSON.parse(localStorage.getItem('outOfStockCounts')   || '{}');
let outOfStockRestoreStatus = JSON.parse(localStorage.getItem('outOfStockRestoreStatus') || '{}');
let taskCounts = {};

// スキャナー状態
let scannerActive = false;
let codeReader = null;
let currentStream = null;
let currentCameraIndex = 0;
let availableCameras = [];

// 現在スキャン中の商品情報
let currentScannedProduct = { code: '', name: '', imageUrl: '', dept: '' };

// =========================================================
// ローカルキャッシュ（学習機能）
// =========================================================
// productCache: { [code]: { name, imageUrl, dept, timestamp } }
// codeMapping:  { [popCode7]: janCode13 }  POPコード→JANコード紐付け
// scanHistory:  [ { code, name, imageUrl, dept, time } ]

function getProductCache()  { return JSON.parse(localStorage.getItem('productCache')  || '{}'); }
function getCodeMapping()   { return JSON.parse(localStorage.getItem('codeMapping')   || '{}'); }
function getScanHistory()   { return JSON.parse(localStorage.getItem('scanHistory')   || '[]'); }

function saveProductCache(cache)   { localStorage.setItem('productCache',  JSON.stringify(cache));  }
function saveCodeMapping(mapping)  { localStorage.setItem('codeMapping',   JSON.stringify(mapping)); }
function saveScanHistory(history)  { localStorage.setItem('scanHistory',   JSON.stringify(history)); }

function setCachedProduct(code, data) {
  const cache = getProductCache();
  cache[code] = { ...data, timestamp: Date.now() };
  saveProductCache(cache);
}

function getCachedProduct(code) {
  const cache = getProductCache();
  return cache[code] || null;
}

function addToScanHistory(code, data) {
  let history = getScanHistory();
  // 重複除去（同一コードがあれば先頭に移動）
  history = history.filter(h => h.code !== code);
  history.unshift({ code, ...data, time: Date.now() });
  if (history.length > 20) history = history.slice(0, 20);
  saveScanHistory(history);
}

// =========================================================
// CSV ユーティリティ
// =========================================================
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const parseLine = (line) => {
    const cols = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === ',' && !inQuotes) {
        cols.push(cur); cur = '';
      } else { cur += ch; }
    }
    cols.push(cur);
    return cols;
  };
  const rawHeaders = parseLine(lines[0]);
  // BOM除去
  const headers = rawHeaders.map((h, i) => i === 0 ? h.replace(/^\uFEFF/, '') : h);
  return lines.slice(1).map(line => {
    if (!line.trim()) return null;
    const cols = parseLine(line);
    const obj = {};
    headers.forEach((h, i) => {
      let v = cols[i] || '';
      if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
        v = v.slice(1, -1).replace(/""/g, '"');
      }
      obj[h] = v;
    });
    obj.boxCount = Number(obj.boxCount) || 0;
    try { obj.tasks = obj.tasks ? JSON.parse(obj.tasks) : []; } catch { obj.tasks = []; }
    obj.order = Number(obj.order) || 0;
    return obj;
  }).filter(Boolean);
}

// =========================================================
// 商品データ読み込み
// =========================================================
async function loadProducts(tab) {
  try {
    const res = await fetch(TAB_FILES[tab]);
    const text = await res.text();
    products = parseCSV(text).sort((a, b) => a.order - b.order);
    renderProducts();
    renderTasks();
  } catch (e) {
    console.error('CSV読み込みエラー:', e);
  }
}

// =========================================================
// 部門判定
// =========================================================
function detectDepartment(name) {
  if (!name) return 'other';
  const n = name;
  if (DEPT_DAILY_KEYWORDS.some(k => n.includes(k))) return 'daily';
  if (DEPT_SNACK_KEYWORDS.some(k => n.includes(k))) return 'snack';
  return 'food';
}
function deptLabel(dept) {
  const map = { daily: '日配', snack: '菓子', food: '食品', other: 'その他' };
  return map[dept] || 'その他';
}

// =========================================================
// 商品情報をネットから取得（Yahoo!ショッピング API経由 / CORS Proxy）
// =========================================================
async function fetchProductInfo(code) {
  // 1. まずキャッシュチェック
  const cached = getCachedProduct(code);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  // 2. COOP商品（POPコード7桁）の場合
  if (code.length === 7) {
    const result = await fetchCoopProduct(code);
    if (result) return result;
  }

  // 3. Yahoo!ショッピング商品検索（JANコード）
  const yahooResult = await fetchYahooProduct(code);
  if (yahooResult) return yahooResult;

  // 4. Open Food Facts（JANコード国際DB）
  const offResult = await fetchOpenFoodFacts(code);
  if (offResult) return offResult;

  // 5. それでも見つからなければコードをそのまま名前に
  return { name: `コード: ${code}`, imageUrl: '', dept: 'other', fromCache: false };
}

// COOP商品ページから情報取得
async function fetchCoopProduct(popCode) {
  try {
    // COOPの商品ページ（内部番号形式）
    // 実際のURLパターン: https://goods.jccu.coop/lineup/com-images/{内部番号}.jpg
    // 商品検索はhttps://goods.jccu.coop/lineup/ から
    // CORS制限があるため allOrigins proxy経由
    const searchUrl = `https://api.allorigins.win/get?url=${encodeURIComponent('https://goods.jccu.coop/lineup/')}`;
    const res = await fetchWithTimeout(searchUrl, 5000);
    if (!res.ok) throw new Error('COOP取得失敗');
    const data = await res.json();
    const html = data.contents;
    // HTMLからPOPコードに一致する商品名を探す
    // COOP商品ページのHTML構造に依存するためシンプルなフォールバック
    return null; // フォールバックへ
  } catch {
    return null;
  }
}

// Yahoo!ショッピング商品検索
async function fetchYahooProduct(code) {
  try {
    // Yahoo!ショッピング商品検索ページをスクレイピング（allOrigins proxy経由）
    const searchQuery = encodeURIComponent(code);
    const yahooUrl = `https://shopping.yahoo.co.jp/search?p=${searchQuery}&n=1`;
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(yahooUrl)}`;
    
    const res = await fetchWithTimeout(proxyUrl, 8000);
    if (!res.ok) throw new Error('Yahoo!取得失敗');
    const data = await res.json();
    const html = data.contents;

    // 商品名を抽出
    const name = extractProductNameFromYahoo(html, code);
    if (!name) return null;

    // 商品画像を抽出
    const imageUrl = extractProductImageFromYahoo(html);

    return { name, imageUrl, dept: detectDepartment(name), fromCache: false };
  } catch (e) {
    console.warn('Yahoo!取得失敗:', e.message);
    return null;
  }
}

function extractProductNameFromYahoo(html, code) {
  if (!html) return null;
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  
  // Yahoo!ショッピングの商品名セレクタ候補
  const selectors = [
    '[class*="ProductTitle"]',
    '[class*="product-name"]',
    '[class*="itemName"]',
    'h1[class*="name"]',
    '.SearchResultItem__title',
    '[data-cl-params*="item"]',
  ];
  
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (el) {
      const text = cleanProductName(el.textContent, code);
      if (text && text.length > 3) return text;
    }
  }

  // OGタイトルから取得を試みる
  const ogTitle = doc.querySelector('meta[property="og:title"]');
  if (ogTitle) {
    const title = ogTitle.getAttribute('content');
    const cleaned = cleanProductName(title, code);
    if (cleaned && cleaned.length > 3) return cleaned;
  }

  // titleタグ
  const titleEl = doc.querySelector('title');
  if (titleEl) {
    const cleaned = cleanProductName(titleEl.textContent, code);
    if (cleaned && cleaned.length > 3) return cleaned;
  }

  return null;
}

function extractProductImageFromYahoo(html) {
  if (!html) return '';
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  
  // OG画像
  const ogImg = doc.querySelector('meta[property="og:image"]');
  if (ogImg) return ogImg.getAttribute('content') || '';
  
  // 商品画像
  const imgSelectors = [
    '[class*="ProductImage"] img',
    '[class*="product-image"] img',
    '[class*="itemImage"] img',
    '.SearchResultItem img',
  ];
  for (const sel of imgSelectors) {
    const img = doc.querySelector(sel);
    if (img) return img.src || img.getAttribute('data-src') || '';
  }
  
  return '';
}

// ノイズ除去・商品名クリーニング
function cleanProductName(raw, code) {
  if (!raw) return '';
  let name = raw.trim();
  
  // ノイズパターン除去
  const noisePatterns = [
    /Yahoo!ショッピング.*/gi,
    /楽天市場.*/gi,
    /Amazon.*/gi,
    /の商品をすべて見る.*/gi,
    /ショッピング検索.*/gi,
    /\| .*/g,
    /- .*/g,
    /\d+件/g,
    /検索結果.*/gi,
    /カテゴリ.*/gi,
    /ランキング.*/gi,
  ];
  
  for (const pat of noisePatterns) {
    name = name.replace(pat, '').trim();
  }
  
  // コード番号自体が入っていたら除去
  if (code) name = name.replace(new RegExp(code, 'g'), '').trim();
  
  // 空白圧縮
  name = name.replace(/\s+/g, ' ').trim();
  
  // 短すぎる or 長すぎる場合は不採用
  if (name.length < 2 || name.length > 100) return '';
  
  return name;
}

// Open Food Facts（国際バーコードDB）
async function fetchOpenFoodFacts(code) {
  try {
    const url = `https://world.openfoodfacts.org/api/v0/product/${code}.json`;
    const res = await fetchWithTimeout(url, 6000);
    if (!res.ok) throw new Error('OFF取得失敗');
    const data = await res.json();
    
    if (data.status !== 1 || !data.product) return null;
    
    const product = data.product;
    const name = product.product_name_ja || product.product_name || '';
    if (!name) return null;
    
    const imageUrl = product.image_front_url || product.image_url || '';
    
    return { name: cleanProductName(name, code) || name, imageUrl, dept: detectDepartment(name), fromCache: false };
  } catch {
    return null;
  }
}

// タイムアウト付きfetch
function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

// =========================================================
// バーコードスキャナー
// =========================================================
async function initScanner() {
  if (!window.ZXing) {
    showAlert('バーコードスキャナーライブラリの読み込みに失敗しました。ページを再読み込みしてください。');
    return;
  }
  codeReader = new ZXing.BrowserMultiFormatReader();
  
  try {
    const devices = await ZXing.BrowserCodeReader.listVideoInputDevices();
    availableCameras = devices;
    
    if (devices.length === 0) {
      showAlert('カメラが見つかりません。カメラのアクセス許可を確認してください。');
      return;
    }
    
    // 背面カメラを優先
    const backCamera = devices.find(d => 
      d.label.toLowerCase().includes('back') || 
      d.label.toLowerCase().includes('rear') ||
      d.label.toLowerCase().includes('environment') ||
      d.label.includes('背面')
    );
    currentCameraIndex = backCamera ? devices.indexOf(backCamera) : devices.length - 1;
    
    await startScanning();
  } catch (e) {
    console.error('カメラ初期化エラー:', e);
    showAlert('カメラへのアクセスが拒否されました。ブラウザの設定でカメラを許可してください。');
  }
}

async function startScanning() {
  if (!codeReader || availableCameras.length === 0) return;
  
  const video = document.getElementById('scanner-video');
  const placeholder = document.getElementById('camera-placeholder');
  const overlay = document.querySelector('.scan-overlay');
  const startBtn = document.getElementById('start-scan-btn');
  const stopBtn = document.getElementById('stop-scan-btn');
  const switchBtn = document.getElementById('switch-camera-btn');
  
  try {
    const deviceId = availableCameras[currentCameraIndex]?.deviceId;
    
    await codeReader.decodeFromVideoDevice(deviceId, 'scanner-video', (result, err) => {
      if (result) {
        const code = result.getText();
        handleScannedCode(code);
      }
    });
    
    video.classList.add('active');
    placeholder.style.display = 'none';
    overlay.classList.add('active');
    startBtn.style.display = 'none';
    stopBtn.style.display = '';
    if (availableCameras.length > 1) switchBtn.style.display = '';
    scannerActive = true;
    
  } catch (e) {
    console.error('スキャン開始エラー:', e);
    showAlert('カメラの起動に失敗しました: ' + e.message);
  }
}

function stopScanning() {
  if (codeReader) {
    codeReader.reset();
  }
  const video = document.getElementById('scanner-video');
  const placeholder = document.getElementById('camera-placeholder');
  const overlay = document.querySelector('.scan-overlay');
  const startBtn = document.getElementById('start-scan-btn');
  const stopBtn = document.getElementById('stop-scan-btn');
  const switchBtn = document.getElementById('switch-camera-btn');
  
  video.classList.remove('active');
  placeholder.style.display = '';
  overlay.classList.remove('active');
  startBtn.style.display = '';
  stopBtn.style.display = 'none';
  switchBtn.style.display = 'none';
  scannerActive = false;
}

async function switchCamera() {
  stopScanning();
  currentCameraIndex = (currentCameraIndex + 1) % availableCameras.length;
  await startScanning();
}

// バーコード読み取り成功時の処理
let lastScannedCode = '';
let lastScanTime = 0;

async function handleScannedCode(code) {
  // 重複スキャン防止（同じコードを2秒以内に再スキャンしない）
  const now = Date.now();
  if (code === lastScannedCode && now - lastScanTime < 2000) return;
  lastScannedCode = code;
  lastScanTime = now;

  // バリデーション：7桁または13桁の数字
  if (!/^\d{7}$|^\d{13}$/.test(code)) return;

  // 在庫無チェック
  const cached = getCachedProduct(code);
  if (outOfStockItems.includes(code)) {
    showScanFlash(`⚠️ 在庫無登録済: ${cached?.name || code}`, 'warning');
    playBeep('warning');
    return;
  }

  playBeep('success');
  showScanFlash(`スキャン: ${code}`);
  
  // 結果エリアを表示
  showScanResultArea(code);
  await lookupProduct(code);
}

// 商品情報を検索・表示
async function lookupProduct(code) {
  const resultArea = document.getElementById('scan-result-area');
  const knownBadge = document.getElementById('known-badge');
  const loadingIndicator = document.getElementById('loading-indicator');
  const resultName = document.getElementById('result-name');
  const resultImg = document.getElementById('result-img');
  const resultDept = document.getElementById('result-dept');
  const codeLabel = document.getElementById('result-code-label');

  resultArea.style.display = '';
  codeLabel.textContent = `コード: ${code}`;
  resultName.textContent = '取得中...';
  resultImg.src = '';
  knownBadge.style.display = 'none';

  // キャッシュチェック
  const cached = getCachedProduct(code);
  if (cached) {
    displayProductResult(cached, code);
    knownBadge.style.display = '';
    loadingIndicator.style.display = 'none';
    return;
  }

  loadingIndicator.style.display = '';
  
  const info = await fetchProductInfo(code);
  
  loadingIndicator.style.display = 'none';
  
  if (info) {
    displayProductResult(info, code);
    // キャッシュに保存
    if (info.name && !info.name.startsWith('コード:')) {
      setCachedProduct(code, { name: info.name, imageUrl: info.imageUrl, dept: info.dept });
      addToScanHistory(code, { name: info.name, imageUrl: info.imageUrl, dept: info.dept });
    }
  }
  
  updateCacheCountDisplay();
}

function displayProductResult(info, code) {
  const resultName = document.getElementById('result-name');
  const resultImg = document.getElementById('result-img');
  const resultDept = document.getElementById('result-dept');

  resultName.textContent = info.name || `コード: ${code}`;
  resultImg.src = info.imageUrl || '';
  resultDept.textContent = deptLabel(info.dept || 'other');
  resultDept.className = `result-dept ${info.dept || 'other'}`;
  
  currentScannedProduct = { code, name: info.name, imageUrl: info.imageUrl, dept: info.dept };
  document.getElementById('result-qty').value = 1;
}

function showScanResultArea(code) {
  document.getElementById('scan-result-area').style.display = '';
  document.getElementById('result-code-label').textContent = `コード: ${code}`;
  document.getElementById('result-name').textContent = '商品情報を取得中...';
  document.getElementById('result-img').src = '';
  document.getElementById('result-dept').textContent = '';
}

// =========================================================
// スキャン結果からタスクへ追加
// =========================================================
function addScannedProductToTask() {
  const qty = parseInt(document.getElementById('result-qty').value) || 1;
  const { code, name, imageUrl, dept } = currentScannedProduct;
  
  if (!name || name.startsWith('コード:')) {
    showAlert('商品名を取得できていません。手動で確認してください。');
    return;
  }

  for (let i = 0; i < qty; i++) {
    tasks.push({
      id: code,
      name,
      imageUrl,
      category: dept === 'daily' ? '日配' : dept === 'snack' ? '菓子' : 'その他',
      location: 'スキャン',
      status: 'new',
      taskUid: Date.now() + Math.random(),
      isScanned: true,
    });
  }
  
  if (!taskCounts[code]) taskCounts[code] = 0;
  taskCounts[code] += qty;
  
  saveTasks();
  renderTasks();
  
  showScanFlash(`✅ タスクに追加 ×${qty}`);
}

// 在庫無として登録
function markScannedAsOutOfStock() {
  const { code, name } = currentScannedProduct;
  if (!code) return;
  
  if (!outOfStockItems.includes(code)) {
    outOfStockItems.push(code);
    localStorage.setItem('outOfStockItems', JSON.stringify(outOfStockItems));
  }
  
  // タスクから除去
  tasks = tasks.filter(t => t.id !== code);
  saveTasks();
  renderTasks();
  renderProducts();
  
  showScanFlash(`❌ 在庫無登録: ${name || code}`, 'danger');
}

// =========================================================
// タスクカウント管理
// =========================================================
function updateTaskCounts() {
  taskCounts = {};
  tasks.forEach(t => {
    if (!taskCounts[t.id]) taskCounts[t.id] = 0;
    taskCounts[t.id]++;
  });
}

// =========================================================
// 商品リスト描画
// =========================================================
function renderProducts() {
  updateTaskCounts();
  const list = document.getElementById('product-list');
  list.innerHTML = '';

  const grouped = {};
  const locationOrder = [];
  const isPaperTab = currentTab === 'paper';
  const customPaperOrder = ['キッチン用品', 'レジ前', 'トイレ用品'];
  const keyword = (window.searchKeyword || '').toLowerCase();

  products.forEach(prod => {
    if (!grouped[prod.location]) {
      grouped[prod.location] = [];
      locationOrder.push(prod.location);
    }
    grouped[prod.location].push(prod);
  });

  let orderList = locationOrder;
  if (isPaperTab) {
    orderList = customPaperOrder.filter(l => locationOrder.includes(l))
      .concat(locationOrder.filter(l => !customPaperOrder.includes(l)));
  }

  orderList.forEach(location => {
    const filtered = grouped[location].filter(p => !keyword || p.name.toLowerCase().includes(keyword));
    if (!filtered.length) return;

    const heading = document.createElement('h2');
    heading.className = 'location-heading';
    heading.textContent = location;
    list.appendChild(heading);

    const gridDiv = document.createElement('div');
    gridDiv.className = 'product-grid';

    filtered.forEach(prod => {
      const card = document.createElement('div');
      card.className = 'product-card';
      card.setAttribute('data-id', prod.id);
      
      // 部門カラーバー
      const dept = detectDepartment(prod.name);
      card.classList.add(`dept-${dept}`);
      
      if (outOfStockItems.includes(prod.id)) card.classList.add('out-of-stock');

      const count = taskCounts[prod.id] || 0;
      let boxHtml = '';
      if (currentTab === 'drinks') {
        boxHtml = `<div class="product-box">追加数: ${count}</div>`;
      } else {
        const possible = Number(prod.Count) || 0;
        boxHtml = `<div class="product-box">${count}/${possible}</div>`;
      }

      card.innerHTML = `
        <img src="${prod.imageUrl}" alt="${prod.name}" onerror="this.src='data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'80\' height=\'80\'><rect fill=\'%23374151\' width=\'80\' height=\'80\' rx=\'8\'/><text x=\'40\' y=\'45\' text-anchor=\'middle\' fill=\'%236B7280\' font-size=\'28\'>📦</text></svg>'">
        <div class="product-name">${prod.name}</div>
        ${boxHtml}
      `;

      // 長押しGoogle検索
      let longPressTimer = null;
      let isLongPress = false;
      const imgElem = card.querySelector('img');
      const startLongPress = () => {
        if (outOfStockItems.includes(prod.id)) return;
        isLongPress = false;
        longPressTimer = setTimeout(() => {
          isLongPress = true;
          window.open('https://www.google.com/search?q=' + encodeURIComponent(prod.name), '_blank');
        }, 2000);
      };
      const cancelLongPress = () => clearTimeout(longPressTimer);
      imgElem.addEventListener('mousedown', startLongPress);
      imgElem.addEventListener('mouseup', cancelLongPress);
      imgElem.addEventListener('mouseleave', cancelLongPress);
      imgElem.addEventListener('touchstart', startLongPress, { passive: true });
      imgElem.addEventListener('touchend', cancelLongPress);

      card.onclick = () => {
        if (outOfStockItems.includes(prod.id)) {
          card.classList.add('out-stock-warning');
          setTimeout(() => card.classList.remove('out-stock-warning'), 3000);
          return;
        }
        if (isLongPress) { isLongPress = false; return; }
        addTask(prod);
        card.classList.add('touch-highlight');
        setTimeout(() => card.classList.remove('touch-highlight'), 350);
      };

      gridDiv.appendChild(card);
    });
    list.appendChild(gridDiv);
  });
}

// =========================================================
// タスク操作
// =========================================================
function addTask(product) {
  tasks.push({ ...product, status: 'new', taskUid: Date.now() + Math.random() });
  if (!taskCounts[product.id]) taskCounts[product.id] = 0;
  taskCounts[product.id]++;
  saveTasks();
  renderTasks();
  renderProducts();
}

function deleteTask(taskUid) {
  const idx = tasks.findIndex(t => t.taskUid === taskUid);
  if (idx !== -1) {
    const id = tasks[idx].id;
    tasks.splice(idx, 1);
    if (taskCounts[id]) { taskCounts[id]--; if (taskCounts[id] <= 0) delete taskCounts[id]; }
    saveTasks(); renderTasks(); renderProducts();
  }
}

function saveTasks()  { localStorage.setItem('tasks', JSON.stringify(tasks)); }
function loadTasks()  { const t = localStorage.getItem('tasks'); tasks = t ? JSON.parse(t) : []; }

// =========================================================
// タスクリスト描画
// =========================================================
function renderTasks() {
  const area = document.getElementById('task-list');
  area.innerHTML = '';

  const normal = [], notCarried = [], carried = [];
  tasks.forEach(t => {
    if (currentTab !== 'paper' && window.searchKeyword && !t.name.toLowerCase().includes(window.searchKeyword)) return;
    if (currentTab === 'paper' && window.paperCategoryFilter && t.category !== window.paperCategoryFilter) return;
    if (t.status === 'carried') carried.push(t);
    else if (t.status === 'not-carried') notCarried.push(t);
    else normal.push(t);
  });

  const drinkOrder = CATEGORY_ORDER_DRINKS;
  const paperOrder = CATEGORY_ORDER_PAPER;

  // ---- 飲料タブ ----
  if (currentTab === 'drinks') {
    // スキャン商品（カテゴリ未定）
    const scanned = normal.filter(t => t.isScanned);
    if (scanned.length > 0) {
      const catDiv = document.createElement('div');
      catDiv.className = 'task-category';
      catDiv.innerHTML = `<div class="task-category-title">📷 スキャン商品</div>`;
      scanned.forEach(task => catDiv.appendChild(createTaskItem(task)));
      area.appendChild(catDiv);
    }

    // カテゴリ別
    drinkOrder.forEach(cat => {
      const items = normal.filter(t => t.category === cat && !t.isScanned);
      if (!items.length) return;
      const catDiv = document.createElement('div');
      catDiv.className = 'task-category';
      catDiv.innerHTML = `<div class="task-category-title">${cat}</div>`;
      items.forEach(task => catDiv.appendChild(createTaskItem(task)));
      area.appendChild(catDiv);
    });
  }

  // ---- 紙タブ ----
  if (currentTab === 'paper') {
    const ids = Array.from(new Set(tasks.map(t => t.id)));
    const filteredIds = ids.filter(id => {
      const prod = products.find(p => p.id === id);
      if (!prod) return false;
      if (window.paperCategoryFilter && prod.category !== window.paperCategoryFilter) return false;
      return true;
    });
    filteredIds.forEach(id => {
      const prod = products.find(p => p.id === id);
      if (!prod) return;
      const total = taskCounts[id] || tasks.filter(t => t.id === id).length;
      const carriedCount = tasks.filter(t => t.id === id && t.status === 'carried').length;
      if (carriedCount >= total && total > 0) return;
      const item = createPaperTaskItem(id, prod, total, carriedCount);
      area.appendChild(item);
    });
  }

  // ---- 未運搬 ----
  if (notCarried.length > 0) {
    const notDiv = document.createElement('div');
    notDiv.className = 'out-stock-list';
    notDiv.innerHTML = '<div class="out-stock-title">未運搬商品</div>';
    const order = currentTab === 'drinks' ? drinkOrder : paperOrder;
    order.forEach(cat => {
      notCarried.filter(t => t.category === cat).forEach(task => notDiv.appendChild(createNotCarriedItem(task)));
    });
    notCarried.filter(t => !order.includes(t.category)).forEach(task => notDiv.appendChild(createNotCarriedItem(task)));
    area.appendChild(notDiv);
  }

  // ---- 在庫無（飲料のみ）----
  if (currentTab === 'drinks') {
    const uniqueOut = Array.from(new Set(outOfStockItems));
    if (uniqueOut.length > 0) {
      const outDiv = document.createElement('div');
      outDiv.className = 'out-stock-list';
      outDiv.innerHTML = '<div class="out-stock-title">在庫無商品</div>';
      uniqueOut.forEach(id => {
        const prod = products.find(p => p.id === id);
        // スキャン商品の場合はキャッシュから名前を取得
        const cached = getCachedProduct(id);
        const name = prod?.name || cached?.name || `コード: ${id}`;
        const imageUrl = prod?.imageUrl || cached?.imageUrl || '';
        
        const item = document.createElement('div');
        item.className = 'out-stock-item';
        item.innerHTML = `
          <img class="task-img" src="${imageUrl}" alt="img" onerror="this.src='data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'50\' height=\'50\'><rect fill=\'%23374151\' width=\'50\' height=\'50\'/></svg>'">
          <span class="task-name">${name}</span>`;
        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'restore-btn';
        restoreBtn.textContent = '戻す';
        restoreBtn.style.cssText = 'background:#3B82F6;color:#fff;border:none;border-radius:8px;padding:0.4rem 0.8rem;cursor:pointer;font-size:0.8rem;font-weight:700;font-family:inherit;';
        restoreBtn.onclick = () => {
          outOfStockItems = outOfStockItems.filter(x => x !== id);
          localStorage.setItem('outOfStockItems', JSON.stringify(outOfStockItems));
          const rc = outOfStockCounts[id] || 1;
          const rsArr = outOfStockRestoreStatus[id] || [];
          delete outOfStockCounts[id]; delete outOfStockRestoreStatus[id];
          localStorage.setItem('outOfStockCounts', JSON.stringify(outOfStockCounts));
          localStorage.setItem('outOfStockRestoreStatus', JSON.stringify(outOfStockRestoreStatus));
          if (prod) {
            for (let i = 0; i < rc; i++) {
              tasks.push({ ...prod, status: rsArr[i] || 'new', taskUid: Date.now() + Math.random() });
            }
          }
          saveTasks(); renderTasks(); renderProducts();
        };
        item.appendChild(restoreBtn);
        outDiv.appendChild(item);
      });
      area.appendChild(outDiv);
    }
  }

  // ---- 運搬済 ----
  if (carried.length > 0) {
    const carriedDiv = document.createElement('div');
    carriedDiv.className = 'out-stock-list';
    carriedDiv.innerHTML = '<div class="out-stock-title carried">✅ 運搬済商品</div>';
    const grouped = {};
    carried.forEach(t => { if (!grouped[t.category]) grouped[t.category] = []; grouped[t.category].push(t); });
    const order = currentTab === 'drinks' ? drinkOrder : paperOrder;
    const allCats = [...order, ...Object.keys(grouped).filter(c => !order.includes(c))];
    allCats.forEach(cat => {
      if (!grouped[cat]) return;
      grouped[cat].forEach(task => {
        const item = document.createElement('div');
        item.className = 'out-stock-item carried';
        item.innerHTML = `
          <img class="task-img" src="${task.imageUrl}" alt="img" onerror="this.src=''">
          <span class="task-name">${task.name}</span>`;
        const btns = document.createElement('div');
        btns.className = 'carried-task-buttons';
        const delBtn = document.createElement('button');
        delBtn.className = 'delete-btn';
        delBtn.textContent = '削除';
        delBtn.style.cssText = 'background:#ef4444;color:#fff;border:none;border-radius:8px;padding:0.4rem 0.7rem;cursor:pointer;font-size:0.8rem;font-weight:700;font-family:inherit;';
        delBtn.onclick = () => { tasks = tasks.filter(t2 => t2.taskUid !== task.taskUid); saveTasks(); renderTasks(); };
        const backBtn = document.createElement('button');
        backBtn.className = 'not-carried-btn';
        backBtn.textContent = '戻す';
        backBtn.style.cssText = 'background:#f59e0b;color:#fff;border:none;border-radius:8px;padding:0.4rem 0.7rem;cursor:pointer;font-size:0.8rem;font-weight:700;font-family:inherit;';
        backBtn.onclick = () => { task.status = 'new'; saveTasks(); renderTasks(); };
        btns.appendChild(delBtn); btns.appendChild(backBtn);
        item.appendChild(btns);
        carriedDiv.appendChild(item);
      });
    });
    area.appendChild(carriedDiv);
  }
}

function createTaskItem(task) {
  const item = document.createElement('div');
  item.className = 'task-item';
  item.innerHTML = `
    <div class="task-item-content">
      <img class="task-img" src="${task.imageUrl}" alt="img" onerror="this.src=''">
      <div>
        <div class="task-name">${task.name}</div>
        ${task.isScanned ? '<div class="task-qty-badge">📷 スキャン</div>' : ''}
      </div>
    </div>
    <div class="task-buttons">
      <button class="carried-btn">運搬済</button>
      <button class="not-carried-btn">未運搬</button>
      <button class="delete-btn">削除</button>
    </div>`;
  item.querySelector('.carried-btn').onclick = () => { task.status = 'carried'; saveTasks(); renderTasks(); };
  item.querySelector('.not-carried-btn').onclick = () => { task.status = 'not-carried'; saveTasks(); renderTasks(); };
  item.querySelector('.delete-btn').onclick = () => { deleteTask(task.taskUid); };
  return item;
}

function createPaperTaskItem(id, prod, total, carriedCount) {
  const item = document.createElement('div');
  item.className = 'task-item';
  item.innerHTML = `
    <div class="task-item-content">
      <img class="task-img" src="${prod.imageUrl}" alt="img" onerror="this.src=''">
      <div>
        <div class="task-name">${prod.name}</div>
        <div class="task-qty-badge">${carriedCount}/${total} 運搬済</div>
      </div>
    </div>`;
  const btnWrap = document.createElement('div');
  btnWrap.className = 'task-buttons';
  const carried = document.createElement('button');
  carried.className = 'carried-btn'; carried.textContent = '運搬済';
  carried.onclick = () => {
    const target = tasks.find(t => t.id === id && t.status !== 'carried');
    if (target) { target.status = 'carried'; saveTasks(); renderTasks(); }
  };
  const del = document.createElement('button');
  del.className = 'delete-btn'; del.textContent = '削除';
  del.onclick = () => { tasks = tasks.filter(t => t.id !== id); taskCounts[id] = 0; saveTasks(); renderTasks(); renderProducts(); };
  btnWrap.appendChild(carried); btnWrap.appendChild(del);
  item.appendChild(btnWrap);
  return item;
}

function createNotCarriedItem(task) {
  const item = document.createElement('div');
  item.className = 'task-item not-carried';
  item.innerHTML = `
    <div class="task-item-content">
      <img class="task-img" src="${task.imageUrl}" alt="img" onerror="this.src=''">
      <div class="task-name">${task.name}</div>
    </div>
    <div class="task-buttons">
      <button class="carried-btn">運搬済</button>
      <button class="not-carried-btn">在庫無</button>
      <button class="delete-btn">削除</button>
    </div>`;
  item.querySelector('.carried-btn').onclick = () => { task.status = 'carried'; saveTasks(); renderTasks(); };
  item.querySelector('.not-carried-btn').onclick = () => {
    if (!outOfStockItems.includes(task.id)) {
      outOfStockItems.push(task.id);
      const sameTasks = tasks.filter(t => t.id === task.id);
      outOfStockCounts[task.id] = sameTasks.length;
      outOfStockRestoreStatus[task.id] = sameTasks.map(t => t.status);
      localStorage.setItem('outOfStockItems', JSON.stringify(outOfStockItems));
      localStorage.setItem('outOfStockCounts', JSON.stringify(outOfStockCounts));
      localStorage.setItem('outOfStockRestoreStatus', JSON.stringify(outOfStockRestoreStatus));
    }
    tasks = tasks.filter(t => t.id !== task.id);
    saveTasks(); renderProducts(); renderTasks();
  };
  item.querySelector('.delete-btn').onclick = () => { deleteTask(task.taskUid); };
  return item;
}

// =========================================================
// UI ユーティリティ
// =========================================================
function showScanFlash(text, type = 'success') {
  const flash = document.getElementById('scan-flash');
  const flashText = document.getElementById('scan-flash-text');
  const content = flash.querySelector('.scan-flash-content');
  flashText.textContent = text;
  
  if (type === 'warning') {
    content.style.background = 'rgba(245,158,11,0.95)';
  } else if (type === 'danger') {
    content.style.background = 'rgba(239,68,68,0.95)';
  } else {
    content.style.background = 'rgba(34,197,94,0.95)';
  }
  
  flash.style.display = '';
  setTimeout(() => { flash.style.display = 'none'; }, 2000);
}

function showAlert(msg) {
  // シンプルなアラート（後でToast通知に改良可）
  alert(msg);
}

function updateCacheCountDisplay() {
  const cache = getProductCache();
  const count = Object.keys(cache).length;
  const el = document.getElementById('cache-count');
  if (el) el.textContent = `${count}件`;
}

// ビープ音
function playBeep(type = 'success') {
  const soundEnabled = document.getElementById('sound-toggle')?.checked ?? true;
  if (!soundEnabled) return;
  
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    if (type === 'warning') {
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.setValueAtTime(330, ctx.currentTime + 0.1);
    } else {
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.05);
    }
    
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.2);
  } catch {}
}

// タブ切り替え
function setTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  
  // スキャナーセクション
  const scannerSection = document.getElementById('scanner-section');
  const productList = document.getElementById('product-list');
  const searchArea = document.getElementById('search-area');
  const paperBtns = document.getElementById('paper-cat-buttons');
  const searchBox = document.getElementById('search-box');
  
  if (tab === 'scanner') {
    scannerSection.style.display = '';
    productList.style.display = 'none';
    document.getElementById('task-list').style.display = 'none';
    searchArea.style.display = 'none';
    document.getElementById('subtab-products').classList.add('active');
    document.getElementById('subtab-tasks').classList.remove('active');
    renderScanHistory();
    updateCacheCountDisplay();
  } else {
    scannerSection.style.display = 'none';
    searchArea.style.display = '';
    if (tab === 'paper') {
      paperBtns.style.display = '';
      searchBox.style.display = 'none';
    } else {
      paperBtns.style.display = 'none';
      searchBox.style.display = '';
    }
    // サブタブの現在状態を確認して表示を切り替え
    const subtaskActive = document.getElementById('subtab-tasks').classList.contains('active');
    productList.style.display = subtaskActive ? 'none' : '';
    document.getElementById('task-list').style.display = subtaskActive ? '' : 'none';
    
    loadProducts(tab);
  }
}

// スキャン履歴描画
function renderScanHistory() {
  const list = document.getElementById('scan-history-list');
  const history = getScanHistory();
  list.innerHTML = '';
  
  if (history.length === 0) {
    list.innerHTML = '<p style="color:var(--text3);font-size:0.9rem;text-align:center;padding:1rem;">まだスキャン履歴がありません</p>';
    return;
  }
  
  history.slice(0, 10).forEach(item => {
    const el = document.createElement('div');
    el.className = 'history-item';
    el.innerHTML = `
      <img class="history-img" src="${item.imageUrl || ''}" alt="img" onerror="this.src=''">
      <div class="history-info">
        <div class="history-name">${item.name}</div>
        <div class="history-code">${item.code}</div>
      </div>
      <button class="history-add-btn">追加</button>`;
    el.querySelector('.history-add-btn').onclick = (e) => {
      e.stopPropagation();
      // タスクに追加
      tasks.push({
        id: item.code, name: item.name, imageUrl: item.imageUrl,
        category: item.dept === 'daily' ? '日配' : item.dept === 'snack' ? '菓子' : 'その他',
        location: 'スキャン', status: 'new',
        taskUid: Date.now() + Math.random(), isScanned: true,
      });
      if (!taskCounts[item.code]) taskCounts[item.code] = 0;
      taskCounts[item.code]++;
      saveTasks(); renderTasks();
      showScanFlash(`✅ 追加: ${item.name}`);
    };
    el.onclick = () => {
      // 再検索
      currentScannedProduct = { code: item.code, name: item.name, imageUrl: item.imageUrl, dept: item.dept };
      showScanResultArea(item.code);
      displayProductResult(item, item.code);
      document.getElementById('known-badge').style.display = '';
    };
    list.appendChild(el);
  });
}

// =========================================================
// DOMContentLoaded - 初期化
// =========================================================
document.addEventListener('DOMContentLoaded', () => {

  // ---- ダークモード初期化 ----
  const themeToggle = document.getElementById('theme-toggle');
  const savedTheme = localStorage.getItem('themeMode');
  // デフォルトはダーク
  if (savedTheme === 'light') {
    document.body.classList.add('light-mode');
    themeToggle.checked = true;
  }
  themeToggle.addEventListener('change', () => {
    if (themeToggle.checked) {
      document.body.classList.add('light-mode');
      localStorage.setItem('themeMode', 'light');
    } else {
      document.body.classList.remove('light-mode');
      localStorage.setItem('themeMode', 'dark');
    }
  });

  // ---- スキャン音設定 ----
  const soundToggle = document.getElementById('sound-toggle');
  soundToggle.checked = localStorage.getItem('soundEnabled') !== 'false';
  soundToggle.addEventListener('change', () => {
    localStorage.setItem('soundEnabled', soundToggle.checked);
  });

  // ---- タブ ----
  document.getElementById('tab-scanner').onclick = () => setTab('scanner');
  document.getElementById('tab-drinks').onclick  = () => setTab('drinks');
  document.getElementById('tab-paper').onclick   = () => setTab('paper');

  // ---- サブタブ ----
  document.getElementById('subtab-products').onclick = () => {
    document.getElementById('product-list').style.display = '';
    document.getElementById('task-list').style.display = 'none';
    document.getElementById('subtab-products').classList.add('active');
    document.getElementById('subtab-tasks').classList.remove('active');
    if (currentTab === 'paper') {
      document.getElementById('paper-cat-buttons').style.display = '';
      document.getElementById('search-box').style.display = 'none';
    }
  };
  document.getElementById('subtab-tasks').onclick = () => {
    document.getElementById('product-list').style.display = 'none';
    document.getElementById('task-list').style.display = '';
    document.getElementById('subtab-products').classList.remove('active');
    document.getElementById('subtab-tasks').classList.add('active');
    if (currentTab === 'paper') {
      document.getElementById('paper-cat-buttons').style.display = '';
      document.getElementById('search-box').style.display = 'none';
    }
    renderTasks();
  };

  // ---- 紙カテゴリボタン ----
  document.querySelectorAll('.paper-cat-btn').forEach(b => {
    b.addEventListener('click', e => {
      const cat = e.currentTarget.getAttribute('data-cat');
      window.paperCategoryFilter = cat === 'all' ? null : cat;
      document.querySelectorAll('.paper-cat-btn').forEach(x => x.classList.remove('active'));
      e.currentTarget.classList.add('active');
      renderTasks();
    });
  });

  // ---- 検索ボックス ----
  const searchBox = document.getElementById('search-box');
  searchBox.addEventListener('input', e => {
    window.searchKeyword = e.target.value.trim().toLowerCase();
    renderProducts();
    renderTasks();
  });

  // ---- 設定ボタン ----
  document.getElementById('settings-btn').onclick = () => {
    updateCacheCountDisplay();
    document.getElementById('settings-modal').style.display = 'flex';
  };
  document.getElementById('close-settings').onclick = () => {
    document.getElementById('settings-modal').style.display = 'none';
  };
  // 背景クリックで閉じる
  document.getElementById('settings-modal').onclick = (e) => {
    if (e.target === document.getElementById('settings-modal')) {
      document.getElementById('settings-modal').style.display = 'none';
    }
  };

  // ---- チャットサポート ----
  document.getElementById('chatbot-btn').onclick = () => {
    document.getElementById('settings-modal').style.display = 'none';
    document.getElementById('product-list').style.display = 'none';
    document.getElementById('task-list').style.display = 'none';
    document.getElementById('scanner-section').style.display = 'none';
    document.getElementById('chatbot-area').style.display = '';
    document.querySelectorAll('.tab, .subtab').forEach(t => t.classList.remove('active'));
  };
  document.getElementById('close-chatbot-btn').onclick = () => {
    document.getElementById('chatbot-area').style.display = 'none';
    setTab(currentTab);
  };

  // ---- タスクリセット ----
  document.getElementById('reset-btn').onclick = () => {
    if (!confirm('タスクと在庫無リストをリセットしますか？')) return;
    localStorage.removeItem('tasks');
    localStorage.removeItem('outOfStockItems');
    localStorage.removeItem('outOfStockCounts');
    localStorage.removeItem('outOfStockRestoreStatus');
    tasks = []; outOfStockItems = []; outOfStockCounts = {}; outOfStockRestoreStatus = {};
    renderProducts(); renderTasks();
    document.getElementById('settings-modal').style.display = 'none';
  };

  // ---- キャッシュ削除 ----
  document.getElementById('clear-cache-btn').onclick = () => {
    if (!confirm('商品情報キャッシュとスキャン履歴を削除しますか？')) return;
    localStorage.removeItem('productCache');
    localStorage.removeItem('scanHistory');
    localStorage.removeItem('codeMapping');
    updateCacheCountDisplay();
    renderScanHistory();
    document.getElementById('settings-modal').style.display = 'none';
    showScanFlash('キャッシュを削除しました', 'warning');
  };

  // ---- スキャナーコントロール ----
  document.getElementById('start-scan-btn').onclick = () => initScanner();
  document.getElementById('stop-scan-btn').onclick  = () => stopScanning();
  document.getElementById('switch-camera-btn').onclick = () => switchCamera();

  // ---- タスクに追加・在庫無ボタン ----
  document.getElementById('add-to-task-btn').onclick = () => addScannedProductToTask();
  document.getElementById('mark-outofstock-btn').onclick = () => markScannedAsOutOfStock();

  // ---- 数量 +/- ----
  document.getElementById('qty-plus').onclick = () => {
    const el = document.getElementById('result-qty');
    el.value = Math.min(99, parseInt(el.value) + 1);
  };
  document.getElementById('qty-minus').onclick = () => {
    const el = document.getElementById('result-qty');
    el.value = Math.max(1, parseInt(el.value) - 1);
  };

  // ---- 手動コード入力 ----
  document.getElementById('manual-search-btn').onclick = () => {
    const code = document.getElementById('manual-code-input').value.trim().replace(/\D/g, '');
    if (!/^\d{7}$|^\d{13}$/.test(code)) {
      showAlert('7桁（POPコード）または13桁（JANコード）を入力してください');
      return;
    }
    document.getElementById('manual-code-input').value = '';
    handleScannedCode(code);
  };
  document.getElementById('manual-code-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('manual-search-btn').click();
  });

  // ---- 写真撮影（結果カードのカメラボタン）----
  document.getElementById('result-photo-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      document.getElementById('result-img').src = dataUrl;
      currentScannedProduct.imageUrl = dataUrl;
      // キャッシュも更新
      if (currentScannedProduct.code) {
        const cached = getCachedProduct(currentScannedProduct.code) || {};
        setCachedProduct(currentScannedProduct.code, { ...cached, imageUrl: dataUrl });
      }
    };
    reader.readAsDataURL(file);
  });

  // ---- スクロールトップ ----
  window.addEventListener('scroll', () => {
    const btn = document.getElementById('scrollTopBtn');
    if (window.scrollY > 200) {
      btn.classList.add('show');
    } else {
      btn.classList.remove('show');
    }
  });
  document.getElementById('scrollTopBtn').onclick = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ---- 初期データ読み込み ----
  loadProducts(currentTab);
  loadTasks();
  renderTasks();
  updateCacheCountDisplay();
});
