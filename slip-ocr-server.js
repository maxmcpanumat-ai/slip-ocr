// =====================================================================
// 🧾 Slip OCR Server — เซิร์ฟเวอร์อ่านข้อความในรูปสลิป (ฟรี · Tesseract)
// ใช้คู่กับบอตหลัก: บอตส่งรูปสลิปมา -> ตอบข้อความที่อ่านได้ + QR บนสลิปกลับไป
// ตั้งค่าใน Render → Environment:
//   OCR_SECRET = รหัสลับ (ตั้งเอง ยาว ๆ) ต้องตรงกับที่ใส่ในหน้าตั้งค่าตรวจสลิปของบอต
//   (ไม่บังคับ) KEEP_AWAKE=0 ปิดการปลุกตัวเอง · OCR_ENG_PASS=0 ปิดรอบอ่านตัวเลข/อังกฤษ
// =====================================================================
const express = require('express');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { createWorker } = require('tesseract.js');
let jpeg = null, PNG = null, jsQR = null;
try { jpeg = require('jpeg-js'); PNG = require('pngjs').PNG; } catch (e) { console.warn('⚠️ [OCR] ไม่มี jpeg-js/pngjs -> ไม่ขยายรูปก่อนอ่าน'); }
try { jsQR = require('jsqr'); } catch (e) { console.warn('⚠️ [OCR] ไม่มี jsqr -> ไม่อ่าน QR บนสลิป'); }

const PORT = process.env.PORT || 3000;
const OCR_SECRET = String(process.env.OCR_SECRET || '');
const LANGS = (process.env.OCR_LANGS || 'tha+eng').split('+').map(s => s.trim()).filter(Boolean);
const ENG_PASS = process.env.OCR_ENG_PASS !== '0';
const MAX_QUEUE = Number(process.env.OCR_MAX_QUEUE) || 20;
const MAX_BYTES = 10 * 1024 * 1024;
// แรมเกินค่านี้ (MB) -> ปิดแล้วเปิดตัวอ่านใหม่ คืนแรม (Render ฟรีมีแรม 512 MB)
const RECYCLE_MB = Number(process.env.OCR_RECYCLE_MB) || 330;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '15mb' }));

// ---------- Tesseract (ประหยัดแรม: Render ฟรีมีแรม 512 MB) ----------
// รอบ 1: ไทย+อังกฤษ (ชื่อ / คำว่า จำนวน / วันที่) — เปิดค้างไว้ อ่านได้ทันที
// รอบ 2: อังกฤษอย่างเดียว แบบหาข้อความกระจาย (เลขบัญชี xxx-x-x1234-x / เลขที่รายการ อ่านแม่นกว่า)
//        ใช้เฉพาะเมื่อรอบ 1 อ่านเลขบัญชีไม่ครบ · ปิดตัวอ่านรอบ 1 ก่อน แล้วค่อยเปิดรอบ 2 (ไม่ให้กินแรมพร้อมกัน)
const workerOpts = () => {
  const o = { cachePath: process.env.TESS_CACHE || path.join(os.tmpdir(), 'tess-cache') };
  if (process.env.TESS_LANG_PATH) o.langPath = process.env.TESS_LANG_PATH;
  return o;
};
let mainP = null;
let readyAt = 0;
function getMain() {
  if (!mainP) {
    const t0 = Date.now();
    mainP = (async () => {
      const w = await createWorker(LANGS, 1, workerOpts());
      await w.setParameters({ preserve_interword_spaces: '1' });
      if (!readyAt) console.log('✅ [OCR] พร้อมใช้งาน (' + LANGS.join('+') + (ENG_PASS ? ' + รอบตัวเลข' : '') + ') ใน ' + (Date.now() - t0) + ' ms');
      readyAt = Date.now();
      return w;
    })().catch(e => { mainP = null; console.error('❌ [OCR] โหลด Tesseract ไม่สำเร็จ:', e.message || e); throw e; });
  }
  return mainP;
}
async function closeMain() {
  const p = mainP;
  mainP = null;
  if (p) { try { await (await p).terminate(); } catch (e) {} }
}
async function engPass(img) {
  const w = await createWorker(['eng'], 1, workerOpts());
  try {
    await w.setParameters({ tessedit_pageseg_mode: '11' });
    return String((await w.recognize(img)).data.text || '');
  } finally { try { await w.terminate(); } catch (e) {} }
}
// รอบ 1 อ่านเลขบัญชีที่ปิดบางหลักได้ครบ 2 เลข (ผู้โอน + ผู้รับ) แล้ว -> ไม่ต้องอ่านรอบ 2
function needEngPass(text) {
  const acc = (String(text || '').match(/(?<![A-Za-z0-9])[xX*%\d](?:[xX*%\d\- ]{5,20})[xX*%\d](?![A-Za-z0-9])/g) || [])
    .filter(x => (x.match(/\d/g) || []).length >= 3 && /[xX*%]/.test(x) && x.replace(/[^0-9xX*%]/g, '').length >= 9);
  if (new Set(acc.map(a => a.replace(/[^0-9]/g, ''))).size < 2) return true;
  return !/\d\s?[.,]\s?\d\d(?!\d)/.test(String(text || '')); // ไม่เจอยอดเงิน (x.xx) -> อ่านรอบ 2 ช่วยหายอด
}
async function recycleIfHeavy() {
  const rss = Math.round(process.memoryUsage().rss / 1048576);
  if (rss < RECYCLE_MB) return;
  await closeMain();
  console.log('♻️ [OCR] แรม ' + rss + ' MB เกิน ' + RECYCLE_MB + ' MB -> เปิดตัวอ่านใหม่');
}

// ---------- คิว: อ่านทีละรูป (กันแรมเต็ม) ----------
let chain = Promise.resolve();
let pending = 0;
function runQueued(fn) {
  pending++;
  const p = chain.then(fn, fn).finally(() => { pending--; });
  chain = p.catch(() => {});
  return p;
}

function keyOk(req) {
  if (!OCR_SECRET) return false;
  const got = Buffer.from(String(req.get('x-ocr-key') || ''));
  const want = Buffer.from(OCR_SECRET);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function imageType(buf) {
  if (buf.length < 12) return '';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp';
  return '';
}

function decodeRGBA(buf, type) {
  if (!jpeg || !PNG) return null;
  try {
    if (type === 'jpeg') return jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 300 });
    if (type === 'png') return PNG.sync.read(buf);
  } catch (e) { console.error('⚠️ [OCR] แปลงรูปไม่สำเร็จ:', e.message); }
  return null;
}

// 🔍 เตรียมรูปก่อนอ่าน: ขาวดำ + ขยายรูปเล็ก (สลิปที่ส่งผ่าน Messenger มักถูกย่อ ตัวหนังสือเล็ก อ่านพลาดง่าย)
function prepareImage(src, fallbackBuf) {
  if (!src) return fallbackBuf;
  try {
    const w = src.width, h = src.height, d = src.data;
    const TARGET = Number(process.env.OCR_TARGET_WIDTH) || 1300;
    const scale = Math.min(3, Math.max(1, TARGET / w));
    const W = Math.round(w * scale), H = Math.round(h * scale);
    if (W * H > 6e6) return fallbackBuf;
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    const out = new PNG({ width: W, height: H });
    for (let y = 0; y < H; y++) {
      const fy = Math.min(h - 1, (y + 0.5) / scale - 0.5), y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(h - 1, y0 + 1), ty = Math.max(0, fy - y0);
      for (let x = 0; x < W; x++) {
        const fx = Math.min(w - 1, (x + 0.5) / scale - 0.5), x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(w - 1, x0 + 1), tx = Math.max(0, fx - x0);
        const v = (g[y0 * w + x0] * (1 - tx) + g[y0 * w + x1] * tx) * (1 - ty) + (g[y1 * w + x0] * (1 - tx) + g[y1 * w + x1] * tx) * ty;
        const k = (y * W + x) * 4;
        out.data[k] = out.data[k + 1] = out.data[k + 2] = v; out.data[k + 3] = 255;
      }
    }
    return PNG.sync.write(out);
  } catch (e) { console.error('⚠️ [OCR] เตรียมรูปไม่สำเร็จ ใช้รูปเดิม:', e.message); return fallbackBuf; }
}

// ---------- 📷 QR บนสลิป (เลขที่รายการแม่น 100% · ไม่มียอดเงิน) ----------
function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function parseTlv(str) {
  const out = {};
  let i = 0;
  while (i + 4 <= str.length) {
    const id = str.slice(i, i + 2), len = parseInt(str.slice(i + 2, i + 4), 10);
    if (!/^\d{2}$/.test(id) || !(len >= 0) || i + 4 + len > str.length) return null;
    out[id] = str.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return i === str.length ? out : null;
}
function parseSlipQr(text) {
  const t = String(text || '').trim();
  if (!/^00\d{2}/.test(t) || t.length < 20 || t.length > 200) return null;
  const top = parseTlv(t);
  const sub = top && top['00'] ? parseTlv(top['00']) : null;
  if (!sub || !sub['02'] || !/^[A-Za-z0-9]{8,40}$/.test(sub['02'].trim())) return null;
  return { bank: /^\d{3}$/.test(sub['01'] || '') ? sub['01'] : '', transRef: sub['02'].trim(), crcOk: top['91'] ? crc16(t.slice(0, -4)) === String(top['91']).toUpperCase() : null };
}
function scaleCrop(img, x0, y0, w, h, s) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  w = Math.min(img.width - x0, Math.floor(w)); h = Math.min(img.height - y0, Math.floor(h));
  if (w < 20 || h < 20) return null;
  const W = Math.round(w * s), H = Math.round(h * s);
  if (W * H > 4e6) return null;
  const o = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = y0 + Math.min(h - 1, Math.floor(y / s));
    for (let x = 0; x < W; x++) {
      const sx = x0 + Math.min(w - 1, Math.floor(x / s));
      const si = (sy * img.width + sx) * 4, di = (y * W + x) * 4;
      o[di] = img.data[si]; o[di + 1] = img.data[si + 1]; o[di + 2] = img.data[si + 2]; o[di + 3] = 255;
    }
  }
  return { data: o, width: W, height: H };
}
function findSlipQr(img) {
  if (!jsQR || !img) return null;
  const W = img.width, H = img.height;
  const big = Math.max(W, H);
  const fit = (n) => Math.min(3, Math.max(0.4, n / big));
  const tries = [
    [0, 0, W, H, fit(1400)], [0, 0, W, H, fit(900)],
    [0, H * 0.4, W, H * 0.6, fit(1800)], [W * 0.4, H * 0.4, W * 0.6, H * 0.6, fit(2000)],
    [0, H * 0.5, W * 0.6, H * 0.5, fit(2000)], [0, 0, W, H, fit(2400)]
  ];
  for (const [x, y, w, h, s] of tries) {
    const part = scaleCrop(img, x, y, w, h, s);
    if (!part) continue;
    let code = null;
    try { code = jsQR(part.data, part.width, part.height, { inversionAttempts: 'attemptBoth' }); } catch (e) {}
    const p = code && parseSlipQr(code.data);
    if (p) return p;
  }
  return null;
}

// เช็กว่าเซิร์ฟเวอร์ตื่นอยู่ (ไม่ต้องใช้รหัส)
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// สถานะ (ต้องใช้รหัส) — บอตใช้ปุ่ม "ทดสอบการเชื่อมต่อ"
app.get('/status', (req, res) => {
  if (!keyOk(req)) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  res.json({ success: true, ready: !!readyAt, langs: LANGS.concat(ENG_PASS ? ['eng-digits'] : []), qr: !!jsQR, queue: pending, memMB: Math.round(process.memoryUsage().rss / 1048576), uptimeSec: Math.round(process.uptime()) });
});

// อ่านข้อความในรูป: body = { image: "<base64>" }
// ตอบ: { text (ไทย+อังกฤษ), textEng (รอบตัวเลข), qr: { bank, transRef } | null }
app.post('/ocr', async (req, res) => {
  if (!keyOk(req)) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  const b64 = String((req.body && req.body.image) || '').replace(/^data:image\/\w+;base64,/, '');
  if (!b64) return res.status(400).json({ success: false, error: 'NO_IMAGE' });
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_BYTES) return res.status(413).json({ success: false, error: 'FILE_TOO_LARGE' });
  const type = imageType(buf);
  if (!type) return res.status(415).json({ success: false, error: 'IMAGE_FORMAT_UNSUPPORTED' });
  if (pending >= MAX_QUEUE) return res.status(503).json({ success: false, error: 'BUSY' });
  const t0 = Date.now();
  try {
    const out = await runQueued(async () => {
      let rgba = decodeRGBA(buf, type);
      const qr = findSlipQr(rgba);
      const img = prepareImage(rgba, buf);
      rgba = null;
      const main = await getMain();
      const r1 = await main.recognize(img);
      const text = String(r1.data.text || '');
      let textEng = '';
      if (ENG_PASS && needEngPass(text)) {
        await closeMain(); // คืนแรมของรอบ 1 ก่อน
        try { textEng = await engPass(img); } catch (e) { console.error('⚠️ [OCR] รอบตัวเลขไม่สำเร็จ:', e.message); }
        getMain().catch(() => {}); // เปิดรอบ 1 รอไว้สำหรับรูปถัดไป
      } else {
        await recycleIfHeavy();
      }
      return { text, textEng, qr, confidence: Math.round(Number(r1.data.confidence) || 0) };
    });
    const ms = Date.now() - t0;
    console.log('🧾 [OCR] อ่านรูป ' + Math.round(buf.length / 1024) + ' KB ใน ' + ms + ' ms (ความมั่นใจ ' + out.confidence + '%' + (out.qr ? ' · QR ' + out.qr.transRef : ' · ไม่พบ QR') + ')');
    res.json({ success: true, ...out, ms });
  } catch (e) {
    console.error('❌ [OCR] อ่านไม่สำเร็จ:', e.message || e);
    res.status(500).json({ success: false, error: 'OCR_FAILED', detail: String(e.message || e).slice(0, 200) });
  }
});

process.on('unhandledRejection', (e) => console.error('⚠️ [Unhandled Rejection]', e && e.message || e));
process.on('uncaughtException', (e) => console.error('⚠️ [Uncaught Exception]', e && e.stack || e));

app.listen(PORT, () => {
  console.log('🧾 Slip OCR Server พร้อมที่พอร์ต ' + PORT + (OCR_SECRET ? '' : ' · ⚠️ ยังไม่ได้ตั้ง OCR_SECRET (จะปฏิเสธทุกคำขอ)'));
  getMain().catch(() => {}); // โหลดภาษาไว้ก่อน รูปแรกจะได้ไม่ช้า
  // ☕ ปลุกตัวเองทุก 10 นาที (Render ฟรีหลับเมื่อไม่มีคนเรียก 15 นาที) · ปิดได้ด้วย KEEP_AWAKE=0
  const selfUrl = String(process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (selfUrl && process.env.KEEP_AWAKE !== '0') {
    setInterval(() => {
      fetch(selfUrl + '/healthz').catch(e => console.error('⚠️ [Keep-awake] ปลุกตัวเองไม่สำเร็จ:', e.message));
    }, 10 * 60 * 1000);
    console.log('☕ [Keep-awake] ปลุกตัวเองทุก 10 นาที: ' + selfUrl);
  }
});
