// ============================================================
// 文字正規化模組 (text normalization)
// 目的：把阿拉伯數字、金額、百分比轉成正確的中文唸法，
//       讓語音引擎（含 Web Speech / 雲端 TTS）唸得自然正確。
//
// 設計原則：
// 1. 只轉「數量語境」的數字，絕不動「編碼語境」的數字。
//    料號 / 批號 / 型號（如 A-1203-B、SKU-0087、B12）是「碼」，
//    唸成「一千兩百零三」會完全錯誤，必須原樣保留（可另交給字典逐字母處理）。
// 2. 正規化只作用在「朗讀用文字」，畫面顯示文字完全不動。
// 3. 與破音字字典分工：本模組先做數字轉換，字典後做讀音替換。
// ============================================================

// 中文數字基本對照
const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const SMALL_UNITS = ['', '十', '百', '千'];
const BIG_UNITS = ['', '萬', '億', '兆'];

// 整數轉中文（支援到兆，涵蓋一般商務金額）
// 逐位掃描：對每一位數字，依「整串中的絕對位置」決定單位（個十百千/萬億兆），
// 並用單一的 needZero 旗標統一處理所有補零情況，避免分段旗標的邊界漏洞。
function integerToChinese(numStr) {
    numStr = numStr.replace(/^0+/, '') || '0';
    if (numStr === '0') return DIGITS[0];

    const len = numStr.length;
    const digits = numStr.split('').map(Number);
    let result = '';
    let needZero = false; // 是否有待補的「零」（遇到非零數字時才真正補上）

    for (let i = 0; i < len; i++) {
        const d = digits[i];
        const pos = len - 1 - i;         // 從個位起算的位置
        const smallPos = pos % 4;        // 個十百千 (0~3)
        const bigPos = Math.floor(pos / 4); // 萬億兆段 (0=個級,1=萬,2=億,3=兆)

        if (d === 0) {
            // 逢零先記下，等下一個非零數字時再補「零」（連續多個零只補一次）
            needZero = true;
        } else {
            if (needZero && result !== '') {
                result += DIGITS[0];
            }
            needZero = false;
            // 「一十」在最高位時唸「十」（如 15 → 十五，非「一十五」）
            if (!(d === 1 && smallPos === 1 && i === 0)) {
                result += DIGITS[d];
            }
            result += SMALL_UNITS[smallPos];
        }

        // 到達每一段（萬/億/兆）的個位時，若該整段有值才補大單位
        if (smallPos === 0 && bigPos > 0) {
            // 檢查這一段（4 位）是否有非零值
            const segStart = Math.max(0, i - 3);
            const segHasValue = digits.slice(segStart, i + 1).some(x => x !== 0);
            if (segHasValue) {
                result += BIG_UNITS[bigPos];
                // 若此段末位（個位）就是非零，緊接的下一段不需補零；
                // 但若此段末位為零（如 ...萬 後面接更低位的零跳空），仍保留 needZero
                if (d !== 0) needZero = false;
            }
        }
    }

    return result;
}

// 小數轉中文（小數點後逐位唸，如 15.5 → 十五點五）
function decimalToChinese(numStr) {
    const [intPart, decPart] = numStr.split('.');
    let result = integerToChinese(intPart);
    if (decPart !== undefined && decPart.length > 0) {
        result += '點' + decPart.split('').map(d => DIGITS[Number(d)]).join('');
    }
    return result;
}

// 判斷某個數字所在位置是否屬於「編碼語境」，若是則不轉換。
// 規則：數字緊鄰英文字母或連字號（前或後），視為料號/批號/型號等碼。
function isCodeContext(fullText, matchStart, matchEnd) {
    const before = fullText.slice(Math.max(0, matchStart - 1), matchStart);
    const after = fullText.slice(matchEnd, matchEnd + 1);
    const codeChar = /[A-Za-z\-_/]/;
    return codeChar.test(before) || codeChar.test(after);
}

// 主函式：正規化數字、金額、百分比
function normalizeNumbers(text) {
    // 1) 百分比：先處理，避免 % 前的數字被一般數字規則吃掉
    //    如 25% → 百分之二十五、12.5% → 百分之十二點五
    text = text.replace(/(\d+(?:\.\d+)?)%/g, (m, num, offset) => {
        if (isCodeContext(text, offset, offset + m.length)) return m;
        return '百分之' + decimalToChinese(num);
    });

    // 2) 金額：帶千分位逗號的數字，如 3,500 → 三千五百；1,250,000 → 一百二十五萬
    text = text.replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?/g, (m, offset) => {
        if (isCodeContext(text, offset, offset + m.length)) return m;
        const clean = m.replace(/,/g, '');
        return decimalToChinese(clean);
    });

    // 3) 一般數字（整數或小數），如 15.5 → 十五點五、3500 → 三千五百
    //    注意：這一步最後做，且嚴格排除編碼語境
    text = text.replace(/\d+(?:\.\d+)?/g, (m, offset) => {
        if (isCodeContext(text, offset, offset + m.length)) return m;
        // 長數字（連續 6 位以上的整數）幾乎都是編號、單號、電話而非數量，
        // 逐位唸較安全（如訂單 20240715 → 二零二四零七一五），避免唸成天文數字。
        if (/^\d+$/.test(m) && m.length >= 6) {
            return m.split('').map(d => DIGITS[Number(d)]).join('');
        }
        return decimalToChinese(m);
    });

    return text;
}

// 對外主入口
function normalizeText(text) {
    return normalizeNumbers(text);
}

module.exports = { normalizeText, integerToChinese, decimalToChinese };
