const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// 文字正規化模組：把數字/金額/百分比轉成中文唸法（含料號批號保護）
const { normalizeText } = require('./normalize.js');

// 編碼偵測與轉碼：台灣辦公室常見的 .txt 可能是 Big5/ANSI，
// 若一律當 UTF-8 讀會變亂碼，這裡用 chardet 偵測、iconv-lite 轉碼。
let chardet = null;
let iconv = null;
try {
    chardet = require('chardet');
    iconv = require('iconv-lite');
} catch (e) {
    console.warn('⚠️  未偵測到 chardet / iconv-lite 套件，將只支援 UTF-8 檔案。');
    console.warn('   請執行 "npm install chardet iconv-lite" 來啟用自動編碼偵測。');
}

const app = express();
// PaaS 平台（Render/Railway 等）會用環境變數指定埠號，本機則預設 3000
const PORT = process.env.PORT || 3000;

// 只接受純文字檔（已不再支援 PDF）
const ALLOWED_EXTENSIONS = ['.txt'];

// 設置中間件
app.use(express.json());

// --- 後台身分驗證（HTTP Basic Auth）---
// 對外公開時，避免任何人都能上傳檔案或竄改破音字字典。
// 密碼由環境變數 ADMIN_PASSWORD 指定（帳號固定為 admin，可自行改）。
// 若未設定 ADMIN_PASSWORD（例如純內網使用），驗證會自動停用、行為與原本相同。
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

function requireAdmin(req, res, next) {
    // 未設定密碼 → 不啟用驗證（相容內網部署）
    if (!ADMIN_PASSWORD) return next();

    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
        const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
        const idx = decoded.indexOf(':');
        const user = decoded.slice(0, idx);
        const pass = decoded.slice(idx + 1);
        if (user === ADMIN_USER && pass === ADMIN_PASSWORD) {
            return next();
        }
    }
    res.set('WWW-Authenticate', 'Basic realm="Warehouse TTS Admin"');
    return res.status(401).send('需要授權才能存取後台（Authorization required）');
}

// 上傳頁（index.html）公開，任何人有網址即可上傳；宣讀頁（listen.html）也公開。
// 根路徑 / 改寫成 /index.html，交給下方的 express.static 統一處理
// （不自己 sendFile，避免某些環境下絕對路徑定位出現 ENOENT）。
app.get('/', (req, res, next) => {
    req.url = '/index.html';
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// 確保上傳暫存資料夾存在，避免 multer 因目錄不存在而報錯
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
const upload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 10 * 1024 * 1024 } // 限制單檔最大 10MB，避免超大檔案拖垮伺服器
});

// 字典檔案路徑 (自動建立)
const DICT_PATH = path.join(__dirname, 'dict.json');
if (!fs.existsSync(DICT_PATH)) {
    fs.writeFileSync(DICT_PATH, JSON.stringify({
        "WMS": "倉儲管理系統",

        // --- 破音字範例：詞語規則跟單字規則寫的先後順序沒關係，
        // 系統會自動依字數長短排序，詞語一律優先於單字，不用擔心順序 ---

        // 「行」的預設讀音（單字，沒有比對到下面任何詞語時才會套用）
        "行": "形",
        // 「行」在特定詞語裡讀音不同，額外列出詞語規則來覆蓋單字規則
        "銀行": "銀航",
        "行走": "形走",
        "旅行": "旅刑",

        // 「重」的破音字範例
        "重量": "仲量",
        "重複": "蟲復",

        // 「都」的破音字範例（讀 ㄉㄡ dou1 vs ㄉㄨ du1）
        "都是": "兜是",
        "首都": "首督",

        // 「長」的破音字範例（讀 ㄓㄤˇ zhǎng vs ㄔㄤˊ cháng）
        // 「長官」要讀 ㄓㄤˇ，用替身字「掌」來讓語音引擎唸對
        "長官": "掌官"
    }, null, 2), 'utf-8');
}

// --- 檔案資料持久化 ---
// 原本 fileDatabase 只存在記憶體，伺服器一重啟所有分享連結就會全部失效。
// 這裡改成寫入 JSON 檔案，重啟後可以自動讀回，連結不會失效。
const FILEDB_PATH = path.join(__dirname, 'filedb.json');
const FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 檔案保留 7 天，超過自動清除，可依需求調整

let fileDatabase = {};

function loadFileDatabase() {
    try {
        if (fs.existsSync(FILEDB_PATH)) {
            const raw = fs.readFileSync(FILEDB_PATH, 'utf-8');
            fileDatabase = JSON.parse(raw);
        }
    } catch (e) {
        console.error('讀取 filedb.json 失敗，將以空資料庫啟動：', e.message);
        fileDatabase = {};
    }
}

// 非同步寫入，避免每次上傳都用 writeFileSync 阻塞主執行緒。
// 以「先寫暫存檔再 rename」的方式做原子寫入，避免寫到一半當機導致 JSON 損毀。
let saveQueue = Promise.resolve();
function saveFileDatabase() {
    saveQueue = saveQueue.then(async () => {
        const tmpPath = FILEDB_PATH + '.tmp';
        try {
            await fsp.writeFile(tmpPath, JSON.stringify(fileDatabase, null, 2), 'utf-8');
            await fsp.rename(tmpPath, FILEDB_PATH);
        } catch (e) {
            console.error('寫入 filedb.json 失敗：', e.message);
        }
    });
    return saveQueue;
}

// 產生不可預測且不會撞號的檔案 ID（取代原本用 Date.now() 的做法）。
// createdAt 另外記錄建立時間，供過期清除判斷用。
function generateFileId() {
    let id;
    do {
        id = crypto.randomBytes(9).toString('base64url'); // 12 字元、URL 安全
    } while (fileDatabase[id]);
    return id;
}

// 清除過期檔案。改用每筆記錄的 createdAt 判斷存活時間，
// 並相容舊資料（舊的 ID 是時間戳記字串，沒有 createdAt 時退回用 ID 當時間）。
function cleanupExpiredFiles() {
    const now = Date.now();
    let removedCount = 0;
    for (const id in fileDatabase) {
        const createdAt = fileDatabase[id].createdAt || Number(id) || 0;
        if (now - createdAt > FILE_TTL_MS) {
            delete fileDatabase[id];
            removedCount++;
        }
    }
    if (removedCount > 0) {
        console.log(`🧹 已清除 ${removedCount} 筆過期檔案`);
        saveFileDatabase();
    }
}

// 啟動時先載入舊資料，並立即清一次過期資料
loadFileDatabase();
cleanupExpiredFiles();

// 之後每小時自動檢查一次過期檔案
setInterval(cleanupExpiredFiles, 60 * 60 * 1000);

// --- 破音字庫 API 路由 ---

// 1. 獲取字典
app.get('/api/dict', requireAdmin, (req, res) => {
    try {
        const dictData = fs.readFileSync(DICT_PATH, 'utf-8');
        res.json({ success: true, dict: JSON.parse(dictData) });
    } catch (e) {
        res.status(500).json({ success: false, message: "讀取字典失敗" });
    }
});

// 2. 更新字典
app.post('/api/dict', requireAdmin, (req, res) => {
    try {
        const { dict } = req.body;
        if (!dict || typeof dict !== 'object') {
            return res.status(400).json({ success: false, message: "字典格式錯誤" });
        }
        fs.writeFileSync(DICT_PATH, JSON.stringify(dict, null, 2), 'utf-8');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: "儲存字典失敗" });
    }
});

// --- 檔案處理輔助函式 ---
function escapeRegex(str) {
    // 避免字典 key 若含正規表示式特殊字元（. * + ? 等）導致替換錯誤或程式出錯
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 讀取文字檔並自動處理編碼：優先偵測，偵測不到或無套件時退回 UTF-8。
function readTextFileWithEncoding(filePath) {
    const buffer = fs.readFileSync(filePath);
    if (chardet && iconv) {
        let encoding = chardet.detect(buffer) || 'UTF-8';
        // Big5 常被偵測成 windows-1252/ISO-8859 等，統一嘗試以 Big5 解，
        // 但若偵測結果本來就是 UTF-8 / ASCII 就照用。
        const normalized = encoding.toLowerCase();
        if (normalized.includes('utf-8') || normalized.includes('ascii')) {
            encoding = 'utf-8';
        } else if (!iconv.encodingExists(encoding)) {
            encoding = 'big5'; // 台灣環境最常見的非 UTF-8 編碼
        }
        try {
            return iconv.decode(buffer, encoding);
        } catch (e) {
            return buffer.toString('utf-8');
        }
    }
    return buffer.toString('utf-8');
}

// 破音字判別核心邏輯：
// 1. 先將字典的 key（詞語／單字）依「字數長到短」排序
// 2. 組成單一個正規表示式，一次掃描整段文字
// 3. 因為正規表示式的「或」(|) 是依序嘗試，較長的詞語會比單一字優先比對到，
//    一旦某個位置被較長的詞語匹配走，該範圍內的字就不會再被單一字規則覆蓋，
//    這樣才能正確做到「詞境優先於單字」的破音字判別（例如「銀行」要比單獨的「行」優先套用）
function applyDictionary(text, dict) {
    const keys = Object.keys(dict);
    if (keys.length === 0) return text;

    const sortedKeys = keys.sort((a, b) => b.length - a.length);
    const pattern = sortedKeys.map(escapeRegex).join('|');
    const regex = new RegExp(pattern, 'g');

    return text.replace(regex, (matched) => dict[matched]);
}

// --- 檔案上傳與轉換 API ---
app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: '請上傳檔案' });
    }

    const filePath = req.file.path;

    // 副檔名白名單檢查：非允許類型一律拒絕，並清掉暫存檔。
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
        return res.status(400).json({
            success: false,
            message: `僅支援 ${ALLOWED_EXTENSIONS.join('、')} 檔案，請重新選擇`
        });
    }

    try {
        // 讀取文字（自動偵測 Big5 / UTF-8）
        const rawText = readTextFileWithEncoding(filePath);

        // 刪除上傳的暫存實體檔案
        try { fs.unlinkSync(filePath); } catch (e) {}

        // 格式化開頭，確保符合前端的第一行特別樣式（這份是「顯示用」文字，字面保持原樣）
        let displayText = rawText;
        if (!displayText.trim().startsWith("AI宣讀")) {
            displayText = `AI宣讀：${req.file.originalname}\n` + displayText;
        }

        // 破音字字典只套用在「朗讀用」文字上，畫面上的文字（displayText）完全不變，
        // 這樣使用者看到的還是正確字面，只有語音合成時會用替換過讀音的版本
        // 朗讀用文字的處理分兩步（顯示用 displayText 完全不動）：
        // 1) 文字正規化：數字/金額/百分比轉中文唸法，料號批號等「碼」自動保留
        // 2) 破音字字典：對正規化後的文字做讀音替換（含數字轉出的中文字，如「重」）
        const dictData = JSON.parse(fs.readFileSync(DICT_PATH, 'utf-8'));
        const normalizedText = normalizeText(displayText);
        const speechText = applyDictionary(normalizedText, dictData);

        // 產生不可預測的隨機 ID 並存入資料庫（記憶體 + 磁碟）
        const fileId = generateFileId();
        fileDatabase[fileId] = {
            title: req.file.originalname.replace(/\.[^/.]+$/, ""), // 去除副檔名
            text: displayText,        // 顯示用（原始字面）
            speechText: speechText,   // 朗讀用（破音字替換過）
            createdAt: Date.now()     // 供過期清除判斷
        };
        saveFileDatabase(); // 非同步寫入磁碟，伺服器重啟後這筆資料還會在

        // 回傳給前端
        res.json({
            success: true,
            shareLink: `/listen.html?id=${fileId}`,
            text: displayText,
            speechText: speechText
        });

    } catch (error) {
        console.error(error);
        try { fs.unlinkSync(filePath); } catch (e) {}
        res.status(500).json({ success: false, message: '伺服器處理檔案失敗' });
    }
});

// --- 取得指定 ID 檔案內容 API (供 listen.html 呼叫) ---
app.get('/api/meeting/:id', (req, res) => {
    const fileId = req.params.id;
    const fileData = fileDatabase[fileId];

    if (fileData) {
        res.json({
            success: true,
            title: fileData.title,
            text: fileData.text,
            speechText: fileData.speechText || fileData.text // 相容舊資料（尚未有 speechText 欄位時退回原文字）
        });
    } else {
        res.status(404).json({ success: false, message: '找不到該檔案或已過期' });
    }
});

// 啟動伺服器
app.listen(PORT, () => {
    console.log(`🚀 倉儲部AI語音系統後端已成功啟動！`);
    console.log(`👉 後台管理網址：http://localhost:${PORT}/index.html`);
    console.log(`📦 目前已有 ${Object.keys(fileDatabase).length} 筆檔案資料`);
    if (ADMIN_PASSWORD) {
        console.log(`🔒 後台身分驗證：已啟用（帳號 ${ADMIN_USER}）`);
    } else {
        console.log(`⚠️  後台身分驗證：未啟用（未設定 ADMIN_PASSWORD）。對外公開前請務必設定！`);
    }
});
