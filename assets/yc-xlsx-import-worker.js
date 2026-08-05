/* YiCapital disposable Excel parser boundary. No session, DOM or network. */
'use strict';

importScripts('vendor/xlsx-js-style-1.2.0/xlsx.min.js');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 256;
const MAX_SHEET_ROWS = 1100;
const MAX_SHEET_COLUMNS = 64;
const MAX_TOTAL_INPUT_ROWS = 1200;
const MAX_CELL_TEXT = 512 * 1024;
const MAX_TOTAL_TEXT = 4 * 1024 * 1024;
const EVENT_SHEETS = Object.freeze([
  'ETF Stock Buy Record',
  'ETF Stock Sell Record',
  'ETF Stock Dividend Record',
  'Corporate Action Record',
  'Liability Record',
  'Capital Record',
  'Fund Action Record',
]);
const DERIVED_SHEETS = Object.freeze([
  'Asset Position Record',
  'Liability Statement',
  'Cash Flow Statement',
  'NAV Statement',
]);
const SYNC_SHEET = '_YiSync';
const RETURNED_SHEETS = new Set([...EVENT_SHEETS, SYNC_SHEET]);
const ALLOWED_SHEETS = new Set([...EVENT_SHEETS, ...DERIVED_SHEETS, SYNC_SHEET]);

// The parser library is loaded before these capabilities are removed. The
// untrusted workbook is parsed only after this worker has no outbound channel
// other than its validated response to the parent page.
const denyNetwork = () => Promise.reject(new Error('network disabled in Excel parser'));
for (const [name, value] of [
  ['fetch', denyNetwork],
  ['XMLHttpRequest', undefined],
  ['WebSocket', undefined],
  ['EventSource', undefined],
  ['BroadcastChannel', undefined],
  ['indexedDB', undefined],
  ['caches', undefined],
  ['importScripts', undefined],
]) {
  try {
    Object.defineProperty(self, name, { value, configurable: false, writable: false });
  } catch (_) {
    try { self[name] = value; } catch (_) { /* best-effort capability removal */ }
  }
}

function fail(message) {
  throw new Error(message);
}

function findEndOfCentralDirectory(view) {
  const lower = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= lower; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

function unsafeArchiveName(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  return !normalized || normalized.startsWith('/') ||
    normalized.split('/').includes('..') ||
    lower.includes('vbaproject.bin') ||
    lower.startsWith('xl/macrosheets/') ||
    lower.startsWith('xl/dialogsheets/') ||
    lower.startsWith('xl/embeddings/') ||
    lower.startsWith('xl/oleobjects/') ||
    lower.startsWith('xl/externallinks/') ||
    lower.startsWith('customui/');
}

function preflightZip(buffer) {
  if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength ||
      buffer.byteLength > MAX_FILE_BYTES) {
    fail('Excel 文件大小不符合 8 MB 安全邊界。');
  }
  const view = new DataView(buffer);
  const end = findEndOfCentralDirectory(view);
  if (end < 0) fail('文件不是有效的非加密 .xlsx ZIP。');
  const disk = view.getUint16(end + 4, true);
  const directoryDisk = view.getUint16(end + 6, true);
  const diskEntries = view.getUint16(end + 8, true);
  const entryCount = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (disk || directoryDisk || diskEntries !== entryCount ||
      entryCount === 0xffff || directorySize === 0xffffffff ||
      directoryOffset === 0xffffffff) {
    fail('不接受多磁碟或 ZIP64 Excel。');
  }
  if (!entryCount || entryCount > MAX_ARCHIVE_ENTRIES ||
      directoryOffset + directorySize > buffer.byteLength) {
    fail('Excel ZIP 目錄超出安全邊界。');
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let cursor = directoryOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.byteLength || view.getUint32(cursor, true) !== 0x02014b50) {
      fail('Excel ZIP 目錄損壞。');
    }
    const flags = view.getUint16(cursor + 8, true);
    const compression = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > buffer.byteLength || (flags & 1) !== 0 ||
        ![0, 8].includes(compression) || compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff || uncompressedSize > MAX_ENTRY_BYTES) {
      fail('Excel ZIP 含加密、未知壓縮或過大內容。');
    }
    const name = decoder.decode(new Uint8Array(buffer, cursor + 46, nameLength));
    if (unsafeArchiveName(name)) fail('Excel 含宏、外部連結、嵌入物件或不安全路徑。');
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ARCHIVE_BYTES) fail('Excel 解壓後超出 64 MB 安全邊界。');
    cursor = next;
  }
  if (cursor > directoryOffset + directorySize) fail('Excel ZIP 目錄長度無效。');
}

function safeMatrix(sheet, sheetName) {
  const reference = sheet && sheet['!ref'];
  if (!reference) return [];
  let range;
  try { range = XLSX.utils.decode_range(reference); } catch (_) {
    fail(`${sheetName} 的資料範圍無效。`);
  }
  const rowCount = range.e.r - range.s.r + 1;
  const columnCount = range.e.c - range.s.c + 1;
  if (rowCount > MAX_SHEET_ROWS || columnCount > MAX_SHEET_COLUMNS) {
    fail(`${sheetName} 超出 ${MAX_SHEET_ROWS} 行／${MAX_SHEET_COLUMNS} 欄安全邊界。`);
  }
  const formulaCells = Object.keys(sheet)
    .filter(address => address[0] !== '!' && sheet[address] && sheet[address].f)
    .slice(0, 5);
  if (formulaCells.length) {
    fail(`事件 sheet 不接受公式：${formulaCells.map(cell => `${sheetName}!${cell}`).join(', ')}`);
  }
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
}

function sanitizeMatrices(matrices) {
  let totalRows = 0;
  let totalText = 0;
  for (const [sheetName, rows] of Object.entries(matrices)) {
    if (!Array.isArray(rows)) fail(`${sheetName} 解析結果無效。`);
    if (EVENT_SHEETS.includes(sheetName)) totalRows += rows.length;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length > MAX_SHEET_COLUMNS) {
        fail(`${sheetName} 行資料無效。`);
      }
      for (let index = 0; index < row.length; index += 1) {
        const value = row[index];
        if (value == null || ['number', 'boolean'].includes(typeof value)) continue;
        if (typeof value !== 'string') fail(`${sheetName} 含不支援的儲存格類型。`);
        if (value.length > MAX_CELL_TEXT) fail(`${sheetName} 含過大的儲存格文字。`);
        totalText += value.length;
        if (totalText > MAX_TOTAL_TEXT) fail('Excel 文字內容超出 4 MB 安全邊界。');
      }
    }
  }
  if (totalRows > MAX_TOTAL_INPUT_ROWS) {
    fail(`7 張事件 sheet 合計超出 ${MAX_TOTAL_INPUT_ROWS} 行解析邊界。`);
  }
}

self.onmessage = event => {
  try {
    const message = event && event.data;
    if (!message || message.type !== 'PARSE_YICAPITAL_XLSX') fail('Excel 解析請求無效。');
    preflightZip(message.buffer);
    const workbook = XLSX.read(message.buffer, {
      type: 'array',
      cellDates: false,
      cellStyles: false,
      bookVBA: false,
      WTF: false,
    });
    const sheetNames = Array.isArray(workbook.SheetNames) ? workbook.SheetNames.slice() : [];
    if (!sheetNames.length || sheetNames.length > 16 ||
        sheetNames.some(name => !ALLOWED_SHEETS.has(name))) {
      fail('Excel sheet 名稱或數量不符合 YiCapital 11-sheet 合同。');
    }
    const sheets = {};
    for (const name of sheetNames) {
      if (!RETURNED_SHEETS.has(name)) continue;
      sheets[name] = safeMatrix(workbook.Sheets[name], name);
    }
    sanitizeMatrices(sheets);
    self.postMessage({ ok: true, sheetNames, sheets });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: String(error && error.message || 'Excel 隔離解析失敗。').slice(0, 500),
    });
  }
};
