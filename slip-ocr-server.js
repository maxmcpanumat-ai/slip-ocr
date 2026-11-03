// =====================================================================
// 🧾 Slip OCR Server — เซิร์ฟเวอร์อ่านข้อความในรูปสลิป (ฟรี · Tesseract)
// ใช้คู่กับบอตหลัก: บอตส่งรูปสลิปมา -> ตอบข้อความที่อ่านได้กลับไป
// ตั้งค่าใน Render → Environment:
//   OCR_SECRET = รหัสลับ (ตั้งเอง ยาว ๆ) ต้องตรงกับที่ใส่ในหน้าตั้งค่าตรวจสลิปของบอต
// =====================================================================
const express = require('express');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { createWorker } = require('tesseract.js');

const PORT = process.env.PORT || 3000;
const OCR_SECRET = String(process.env.OCR_SECRET || '');
const LANGS = (process.env.OCR_LANGS || 'tha+eng').split('+').map(s => s.trim()).filter(Boolean);
const MAX_QUEUE = Number(process.env.OCR_MAX_QUEUE) || 20;
const MAX_BYTES = 10 * 1024 * 1024;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '15mb' }));

// ---------- Tesseract worker (โหลดครั้งเดียว ใช้ซ้ำ) ----------
let workerP = null;
let workerReadyAt = 0;
function getWorker() {
  if (!workerP) {
    const t0 = Date.now();
    const opts = { cachePath: process.env.TESS_CACHE || path.join(os.tmpdir(), 'tess-cache') };
    if (process.env.TESS_LANG_PATH) opts.langPath = process.env.TESS_LANG_PATH;
    workerP = (async () => {
      const w = await createWorker(LANGS, 1, opts);
      await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
      workerReadyAt = Date.now();
      console.log('✅ [OCR] พร้อมใช้งาน (' + LANGS.join('+') + ') ใน ' + (Date.now() - t0) + ' ms');
      return w;
    })().catch(e => { workerP = null; console.error('❌ [OCR] โหลด Tesseract ไม่สำเร็จ:', e.message || e); throw e; });
  }
  return workerP;
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

// เช็กว่าเซิร์ฟเวอร์ตื่นอยู่ (ไม่ต้องใช้รหัส)
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// สถานะ (ต้องใช้รหัส) — บอตใช้ปุ่ม "ทดสอบการเชื่อมต่อ"
app.get('/status', (req, res) => {
  if (!keyOk(req)) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  res.json({ success: true, ready: !!workerReadyAt, langs: LANGS, queue: pending, memMB: Math.round(process.memoryUsage().rss / 1048576), uptimeSec: Math.round(process.uptime()) });
});

// อ่านข้อความในรูป: body = { image: "<base64>" }
app.post('/ocr', async (req, res) => {
  if (!keyOk(req)) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  const b64 = String((req.body && req.body.image) || '').replace(/^data:image\/\w+;base64,/, '');
  if (!b64) return res.status(400).json({ success: false, error: 'NO_IMAGE' });
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_BYTES) return res.status(413).json({ success: false, error: 'FILE_TOO_LARGE' });
  if (!imageType(buf)) return res.status(415).json({ success: false, error: 'IMAGE_FORMAT_UNSUPPORTED' });
  if (pending >= MAX_QUEUE) return res.status(503).json({ success: false, error: 'BUSY' });
  const t0 = Date.now();
  try {
    const out = await runQueued(async () => {
      const w = await getWorker();
      const { data } = await w.recognize(buf);
      return { text: String(data.text || ''), confidence: Math.round(Number(data.confidence) || 0) };
    });
    const ms = Date.now() - t0;
    console.log('🧾 [OCR] อ่านรูป ' + Math.round(buf.length / 1024) + ' KB ใน ' + ms + ' ms (ความมั่นใจ ' + out.confidence + '%)');
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
  getWorker().catch(() => {}); // โหลดภาษาไว้ก่อน รูปแรกจะได้ไม่ช้า
  // ☕ ปลุกตัวเองทุก 10 นาที (Render ฟรีหลับเมื่อไม่มีคนเรียก 15 นาที) · ปิดได้ด้วย KEEP_AWAKE=0
  const selfUrl = String(process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (selfUrl && process.env.KEEP_AWAKE !== '0') {
    setInterval(() => {
      fetch(selfUrl + '/healthz').catch(e => console.error('⚠️ [Keep-awake] ปลุกตัวเองไม่สำเร็จ:', e.message));
    }, 10 * 60 * 1000);
    console.log('☕ [Keep-awake] ปลุกตัวเองทุก 10 นาที: ' + selfUrl);
  }
});