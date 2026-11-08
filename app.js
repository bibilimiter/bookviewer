// BookViewer：漫画（JPEG の入った ZIP）と小説（PDF）を読む。Windows・Android・iPad のブラウザで動く（PWA）
'use strict';

const APP_VERSION = 'v7';  // 画面を直したら、sw.js の VERSION といっしょに上げる

const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
// 日本語の文字の読み方の表（CMap）と標準の字の形。これがないと、日本語の PDF から文字を取り出せないことがある
const CMAP_URL = new URL('cmaps/', location.href).href;
const FONT_URL = new URL('standard_fonts/', location.href).href;
const $ = (id) => document.getElementById(id);
const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const BOOK_RE = /\.(zip|cbz|pdf)$/i;
const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
const THUMB_W = 280;              // 本棚の表紙の幅（画素）
const MAX_CANVAS_PIXELS = 8e6;    // PDF の1ページを絵にするときの画素数の上限（iPad で落ちないように）
const KEEP_BEFORE = 3, KEEP_AFTER = 5;  // 今のページの前後、何ページ分を取り出したまま持っておくか（ほかは手放す）
const kindOf = (name) => (/\.pdf$/i.test(name) ? 'pdf' : 'zip');
const baseName = (name) => name.replace(/^.*\//, '').replace(/\.(zip|cbz|pdf)$/i, '');
const errText = (e) => (e && e.message ? e.message : String(e));

// ---------------- しまっておく所（IndexedDB と localStorage） ----------------
// books：取りこんだ本の情報 / files：取りこんだ本の中身 / covers：表紙の小さな絵とページ数 / meta：選んだフォルダ
const DB_NAME = 'bookviewer', STORES = ['books', 'files', 'covers', 'meta', 'texts'];  // texts：PDF から取り出した文字（検索用）
let dbP = null;
function openDb() {
  if (!dbP) dbP = new Promise((ok, ng) => {
    const r = indexedDB.open(DB_NAME, 2);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ng(r.error);
  });
  return dbP;
}
async function dbDo(store, mode, fn) {
  const db = await openDb();
  return new Promise((ok, ng) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => ok(req && req.result);
    tx.onerror = () => ng(tx.error);
    tx.onabort = () => ng(tx.error || new Error('しまえませんでした'));
  });
}
const dbGet = (s, k) => dbDo(s, 'readonly', (o) => o.get(k));
const dbPut = (s, k, v) => dbDo(s, 'readwrite', (o) => o.put(v, k));
const dbDel = (s, k) => dbDo(s, 'readwrite', (o) => o.delete(k));
const dbAll = (s) => dbDo(s, 'readonly', (o) => o.getAll());
const dbKeys = (s) => dbDo(s, 'readonly', (o) => o.getAllKeys());

function loadJson(key, def) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
function saveJson(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { } }
function removeKey(key) { try { localStorage.removeItem(key); } catch (e) { } }
// 本ごとに覚えること：bv_pos_<id> = 読んだ位置 { p: ページ（0から）, n: 全ページ数, t: 最後に開いた時刻 }
//                   bv_view_<id> = 見せ方 { dir: 'rtl'（右開き）|'ltr'（左開き）, spread: 'auto'|'single'|'double', shift: 見開きを1ページずらすか }

// ---------------- ZIP を読む（全部を一度に広げず、ページごとに取り出す） ----------------
async function readBytes(blob, start, end) { return new Uint8Array(await blob.slice(start, end).arrayBuffer()); }
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
let sjisDec = null; try { sjisDec = new TextDecoder('shift_jis'); } catch (e) { }
function decodeName(bytes, flags) {
  if (flags & 0x800) return new TextDecoder().decode(bytes);           // UTF-8 の印がある
  try { return utf8Strict.decode(bytes); } catch (e) { }                 // 印はないが UTF-8 として読める
  return sjisDec ? sjisDec.decode(bytes) : new TextDecoder().decode(bytes); // Windows で作った ZIP（Shift_JIS）
}
async function openZip(blob) {
  const size = blob.size;
  const tailLen = Math.min(size, 65557);
  const tail = await readBytes(blob, size - tailLen, size);
  const dv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('ZIP ではないようです');
  let n = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
  if (n === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) {  // 4GB をこえる ZIP（ZIP64）
    const li = eocd - 20;
    if (li >= 0 && dv.getUint32(li, true) === 0x07064b50) {
      const off = Number(dv.getBigUint64(li + 8, true));
      const z = new DataView((await readBytes(blob, off, off + 56)).buffer);
      if (z.getUint32(0, true) === 0x06064b50) {
        n = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true));
      }
    }
  }
  const cd = await readBytes(blob, cdOff, cdOff + cdSize);
  const cv = new DataView(cd.buffer);
  const entries = [];
  let p = 0;
  for (let k = 0; k < n && p + 46 <= cd.length; k++) {
    if (cv.getUint32(p, true) !== 0x02014b50) break;
    const flags = cv.getUint16(p + 8, true), method = cv.getUint16(p + 10, true);
    let csize = cv.getUint32(p + 20, true), usize = cv.getUint32(p + 24, true);
    const nl = cv.getUint16(p + 28, true), el = cv.getUint16(p + 30, true), cl = cv.getUint16(p + 32, true);
    let lho = cv.getUint32(p + 42, true);
    const name = decodeName(cd.subarray(p + 46, p + 46 + nl), flags);
    if (usize === 0xFFFFFFFF || csize === 0xFFFFFFFF || lho === 0xFFFFFFFF) {  // ZIP64 の追加情報
      let q = p + 46 + nl; const qe = q + el;
      while (q + 4 <= qe) {
        const id = cv.getUint16(q, true), len = cv.getUint16(q + 2, true);
        if (id === 1) {
          let r = q + 4;
          if (usize === 0xFFFFFFFF) { usize = Number(cv.getBigUint64(r, true)); r += 8; }
          if (csize === 0xFFFFFFFF) { csize = Number(cv.getBigUint64(r, true)); r += 8; }
          if (lho === 0xFFFFFFFF) { lho = Number(cv.getBigUint64(r, true)); r += 8; }
          break;
        }
        q += 4 + len;
      }
    }
    if (!name.endsWith('/')) entries.push({ name, method, csize, usize, lho, flags });
    p += 46 + nl + el + cl;
  }
  return {
    entries,
    // 1つのファイルだけを取り出す（ほかのページには手をつけない）
    async blob(e, type) {
      if (e.flags & 1) throw new Error('パスワードのかかった ZIP には対応していません');
      const lh = await readBytes(blob, e.lho, e.lho + 30);
      const lv = new DataView(lh.buffer);
      if (lv.getUint32(0, true) !== 0x04034b50) throw new Error('ZIP がこわれているようです');
      const start = e.lho + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
      const raw = blob.slice(start, start + e.csize, type || '');
      if (e.method === 0) return raw;
      if (e.method === 8 && typeof DecompressionStream !== 'undefined') {
        const s = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Blob([await new Response(s).arrayBuffer()], { type: type || '' });
      }
      throw new Error('この ZIP の縮め方には対応していません（' + e.method + '）');
    },
  };
}
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' };
const mimeOf = (name) => MIME[(name.split('.').pop() || '').toLowerCase()] || '';

function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.draggable = false;
  return new Promise((ok, ng) => {
    img.onload = () => ok({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); ng(new Error('画像が読めませんでした')); };
    img.src = url;
  });
}

// ---------------- 本の中身を読む部品（漫画＝ZIP、小説＝PDF） ----------------
// どちらも count（ページ数）、load(i)（i ページ目を用意する）、place(ページ, 幅, 高さ, 拡大率)（その大きさで見せる用意）、close() を持つ
const hiddenName = (name) => /(^|\/)(__MACOSX\/|\.)/.test(name);
const byName = (a, b) => collator.compare(a.name, b.name);
// ZIP の中の画像（ページ）を、名前の順に
const zipPages = (zip) => zip.entries.filter((e) => IMG_RE.test(e.name) && !hiddenName(e.name)).sort(byName);
// ZIP の中に入っている巻ごとの ZIP・PDF（画像が1枚もないときだけ「何巻かのまとめ」とみなす）
function zipVolumes(zip) {
  if (zipPages(zip).length) return null;
  const v = zip.entries.filter((e) => BOOK_RE.test(e.name) && !hiddenName(e.name)).sort(byName);
  return v.length ? v : null;
}
async function zipSource(blob) {
  const zip = await openZip(blob);
  const pages = zipPages(zip);
  if (!pages.length) throw new Error('ZIP の中に画像がありません');
  return {
    count: pages.length,
    async load(i) {
      let r;
      try { r = await loadImage(await zip.blob(pages[i], mimeOf(pages[i].name))); }
      catch (e) { throw new Error((i + 1) + ' ページ目：' + errText(e)); }
      return { w: r.img.naturalWidth || 1, h: r.img.naturalHeight || 1, el: r.img, free() { URL.revokeObjectURL(r.url); r.img.removeAttribute('src'); } };
    },
    async place() { },
    close() { },
    async thumb() { return makeThumb((await loadImage(await zip.blob(pages[0], mimeOf(pages[0].name))))); },
  };
}

async function pdfSource(blob) {
  if (typeof pdfjsLib === 'undefined') throw new Error('PDF を読む部品がまだありません。一度ネットにつないでから開いてください');
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  // PDF は丸ごと読まずに、出すページに要る所だけをそのつど読む（大きい PDF でもすぐ開ける）
  const range = new pdfjsLib.PDFDataRangeTransport(blob.size, null);
  range.requestDataRange = (begin, end) => {
    blob.slice(begin, end).arrayBuffer().then((b) => range.onDataRange(begin, new Uint8Array(b)));
  };
  const task = pdfjsLib.getDocument({ range, length: blob.size, disableAutoFetch: true, disableStream: true, rangeChunkSize: 262144,
    cMapUrl: CMAP_URL, cMapPacked: true, standardFontDataUrl: FONT_URL });
  const pdf = await task.promise;
  const src = {
    count: pdf.numPages,
    async load(i) {
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      const c = document.createElement('canvas');
      return { w: vp.width, h: vp.height, el: c, page, scale: 0, job: null,
        free() { if (this.job) this.job.cancel(); c.width = c.height = 0; page.cleanup(); } };
    },
    // 見せる大きさに合わせて、ちょうどよい細かさで絵にする（拡大したときは細かく描きなおす）
    async place(pg, cssW, cssH, zoom) {
      const dpr = window.devicePixelRatio || 1;
      let s = (cssW / pg.w) * dpr * Math.max(1, Math.min(zoom || 1, 3));
      const px = pg.w * pg.h * s * s;
      if (px > MAX_CANVAS_PIXELS) s *= Math.sqrt(MAX_CANVAS_PIXELS / px);
      if (pg.scale && Math.abs(pg.scale - s) / s < 0.15) return;
      if (pg.job) { pg.job.cancel(); pg.job = null; }
      const vp = pg.page.getViewport({ scale: s });
      const tmp = document.createElement('canvas');
      tmp.width = Math.ceil(vp.width); tmp.height = Math.ceil(vp.height);
      const job = pg.page.render({ canvasContext: tmp.getContext('2d'), viewport: vp });
      pg.job = job;
      try { await job.promise; }
      catch (e) { tmp.width = tmp.height = 0; if (e && e.name === 'RenderingCancelledException') return; throw e; }
      if (pg.job === job) pg.job = null;
      if (src.query) {  // 検索した言葉に色を付ける
        try { await drawMarks(pg, vp, tmp.getContext('2d'), src.query); } catch (e) { }
        if (pg.job) { tmp.width = tmp.height = 0; return; }
      }
      pg.el.width = tmp.width; pg.el.height = tmp.height;
      pg.el.getContext('2d').drawImage(tmp, 0, 0);
      tmp.width = tmp.height = 0;
      pg.scale = s;
    },
    close() { task.destroy(); },
    query: '',
    // i ページ目の文字（検索用）
    async text(i) {
      const page = await pdf.getPage(i + 1);
      const tc = await page.getTextContent();
      page.cleanup();
      return tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join('');
    },
    async thumb() {
      const page = await pdf.getPage(1);
      const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: THUMB_W / vp0.width });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      const b = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.8));
      c.width = c.height = 0; page.cleanup();
      return b;
    },
  };
  return src;
}
const openSource = (blob, kind) => (kind === 'pdf' ? pdfSource(blob) : zipSource(blob));

// 表紙用の小さな絵を作る
async function makeThumb({ img, url }) {
  try {
    const w = THUMB_W, h = Math.max(1, Math.round((img.naturalHeight * w) / (img.naturalWidth || 1)));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    const b = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.8));
    c.width = c.height = 0;
    return b;
  } finally { URL.revokeObjectURL(url); img.removeAttribute('src'); }
}
// 本1冊から、表紙の絵とページ数を作る
async function makeCover(blob, kind) {
  if (kind === 'zip') {
    const zip = await openZip(blob);
    const vols = zipVolumes(zip);
    if (vols) {  // 何巻かのまとめ：1巻目の表紙を使う
      const c = await makeCover(await zip.blob(vols[0], ''), kindOf(vols[0].name));
      return { blob: c.blob, n: vols.length, set: true };
    }
  }
  const src = await openSource(blob, kind);
  try { return { blob: await src.thumb(), n: src.count }; }
  finally { src.close(); }
}

// ---------------- 本のフォルダ（Windows：選んだフォルダを直接読む） ----------------
const DIR = { handle: null, items: [] };
const canPickDir = 'showDirectoryPicker' in window;

async function walkDir(h, path, out) {
  for await (const [name, child] of h.entries()) {
    if (name.startsWith('.')) continue;
    if (child.kind === 'directory') await walkDir(child, path + name + '/', out);
    else if (BOOK_RE.test(name)) out.push({ id: 'dir:' + path + name, src: 'dir', title: baseName(name), folder: path, kind: kindOf(name), handle: child });
  }
  return out;
}
function dirBar(text, ask) {
  $('dirBar').hidden = !text; $('dirText').textContent = text || ''; $('dirAllow').hidden = !ask;
}
async function scanDir() {
  const h = DIR.handle;
  dirBar('📁「' + h.name + '」の中を見ています…', false);
  try {
    DIR.items = await walkDir(h, '', []);
    dirBar('📁「' + h.name + '」：' + DIR.items.length + ' 冊', false);
  } catch (e) {
    DIR.items = [];
    dirBar('📁「' + h.name + '」が読めませんでした（' + errText(e) + '）。「フォルダを選ぶ」で選びなおしてください', false);
  }
  await showLibrary();
}
async function initDir() {
  if (!canPickDir) return;
  $('pickDir').hidden = false;
  let h = null;
  try { h = await dbGet('meta', 'dir'); } catch (e) { }
  if (!h) return;
  DIR.handle = h;
  $('pickDir').textContent = '📁 フォルダを変える';
  let p = 'prompt';
  try { p = await h.queryPermission({ mode: 'read' }); } catch (e) { }
  if (p === 'granted') await scanDir();
  else dirBar('📁「' + h.name + '」の本を出すには、「読みこむ」を押して読むのを許してください', true);
}
$('pickDir').onclick = async () => {
  let h;
  try { h = await window.showDirectoryPicker({ id: 'bookviewer', mode: 'read' }); } catch (e) { return; }  // 選ぶのをやめた
  DIR.handle = h;
  await dbPut('meta', 'dir', h);
  $('pickDir').textContent = '📁 フォルダを変える';
  await scanDir();
};
$('dirAllow').onclick = async () => {
  let p = 'denied';
  try { p = await DIR.handle.requestPermission({ mode: 'read' }); } catch (e) { }
  if (p === 'granted') await scanDir();
};

// ---------------- 本棚 ----------------
const libUrls = [];
let coverQueue = [], coverBusy = false;

async function getBookFile(item) {
  if (item.parent) {  // まとめの中の1巻：外の ZIP から、その巻だけを取り出す（縮めずに入れてあれば、写さずにそのまま読む）
    const zip = await openZip(await getBookFile(item.parent));
    const e = zip.entries.find((x) => x.name === item.entry);
    if (!e) throw new Error('「' + item.title + '」が見つかりません');
    return zip.blob(e, item.kind === 'pdf' ? 'application/pdf' : 'application/zip');
  }
  if (item.src === 'dir') return item.handle.getFile();
  const f = await dbGet('files', item.id);
  if (!f) throw new Error('本の中身が見つかりません。取りこみなおしてください');
  return f;
}
function progressOf(item, n) {
  const pos = loadJson('bv_pos_' + item.id, null);
  const total = (pos && pos.n) || n || 0;
  if (!pos || pos.p == null) return { text: total ? total + ' ページ・未読' : '未読', ratio: 0 };
  if (total && pos.p >= total - 2) return { text: '読み終わり', ratio: 1 };
  return { text: (pos.p + 1) + ' / ' + (total || '?') + ' ページ', ratio: total ? (pos.p + 1) / total : 0 };
}

async function showLibrary() {
  libUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  coverQueue = [];
  let local = [];
  try { local = await dbAll('books'); } catch (e) { }
  const items = [...DIR.items, ...local];
  const t = (it) => (loadJson('bv_pos_' + it.id, {}).t || 0);
  items.sort((a, b) => (t(b) - t(a)) || collator.compare((a.folder || '') + a.title, (b.folder || '') + b.title));
  const box = $('books'); box.innerHTML = '';
  const hint = $('libHint');
  if (!items.length && !hint.dataset.busy) {
    hint.hidden = false;
    hint.innerHTML = canPickDir
      ? '「📁 フォルダを選ぶ」で、本（漫画の ZIP・小説の PDF）が入ったフォルダを選んでください。次からはそのフォルダを直接読みます。<br>「＋ 本を取りこむ」で、本をこのブラウザの中にしまうこともできます。'
      : '「＋ 本を取りこむ」で、漫画（JPEG の入った ZIP）や小説（PDF）を選んでください。<br>本はこの端末の中にしまうので、次からはネットなしで読めます。';
  } else if (!hint.dataset.busy) hint.hidden = true;

  renderCards(box, items);
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const e = await navigator.storage.estimate();
      $('storage').textContent = 'このブラウザの中で使っている量：' + Math.round((e.usage || 0) / 1048576) + ' MB' +
        (e.quota ? '（使える量の目安：' + Math.round((e.quota / 1073741824) * 10) / 10 + ' GB）' : '');
    } catch (e) { }
  }
}
// 本の札を並べる（本棚と、巻の一覧で使う）
function renderCards(box, items) {
  for (const it of items) {
    const el = document.createElement('div'); el.className = 'book';
    el.title = (it.folder || '') + it.title;
    const label = it.kind === 'pdf' ? 'PDF' : '漫画';
    const cv = document.createElement('div'); cv.className = 'cv'; cv.textContent = label;
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = label;
    const bar = document.createElement('div'); bar.className = 'bar2'; const fill = document.createElement('i'); bar.append(fill);
    const ti = document.createElement('div'); ti.className = 't'; ti.textContent = it.title;
    const p = document.createElement('div'); p.className = 'p';
    const pt = document.createElement('span'); p.append(pt);
    const setProg = (c) => {
      if (c && c.set) {  // 何巻かのまとめ
        tag.textContent = '全' + c.n + '巻';
        const last = loadJson('bv_pos_' + it.id, null);
        pt.textContent = '全' + c.n + '巻' + (last && last.vol ? '・' + baseName(last.vol) + ' を読んでいます' : '');
        fill.style.width = '0';
        return;
      }
      const g = progressOf(it, c ? c.n : 0); pt.textContent = g.text; fill.style.width = Math.round(g.ratio * 100) + '%';
    };
    setProg(null);
    if (it.src === 'local' && !it.parent) {
      const del = document.createElement('button'); del.className = 'btn del'; del.textContent = '消す';
      del.onclick = async (ev) => {
        ev.stopPropagation();
        if (!confirm('「' + it.title + '」をこの端末から消しますか？\n（取りこむ前のもとのファイルは消えません）')) return;
        await dbDel('files', it.id); await dbDel('covers', it.id); await dbDel('books', it.id);
        // まとめの中の巻の表紙と、読んだ位置も消す
        try { for (const k of await dbKeys('covers')) if (String(k).startsWith(it.id + '#')) await dbDel('covers', k); } catch (e) { }
        try {
          for (const k of Object.keys(localStorage)) {
            if (k === 'bv_pos_' + it.id || k === 'bv_view_' + it.id || k.startsWith('bv_pos_' + it.id + '#') || k.startsWith('bv_view_' + it.id + '#')) removeKey(k);
          }
        } catch (e) { }
        showLibrary();
      };
      p.append(del);
    }
    // まとめの中で、いま読んでいる巻に目印を付ける
    const cur = it.parent && (loadJson('bv_pos_' + it.parent.id, {}) || {}).vol === it.entry;
    let mark = null;
    if (cur) { el.classList.add('current'); mark = document.createElement('span'); mark.className = 'mark'; mark.textContent = '▶ 読んでいる'; cv.append(mark); }
    el.append(cv, ti, p);
    el.onclick = () => openItem(it);
    box.append(el);
    const showCover = (c) => {
      if (!c || !c.blob) return;
      const u = URL.createObjectURL(c.blob); libUrls.push(u);
      const img = document.createElement('img'); img.alt = ''; img.src = u;
      cv.textContent = ''; cv.append(img, tag, bar); if (mark) cv.append(mark); setProg(c);
    };
    dbGet('covers', it.id).then((c) => {
      showCover(c);
      // フォルダの本は、ファイルが変わっていたら表紙を作りなおす。表紙のない本は作る
      if (!c || it.src === 'dir') { coverQueue.push({ it, cached: c, showCover }); runCoverQueue(); }
    }).catch(() => { });
  }
}

// ---------------- 何巻かのまとめ（ZIP の中に、巻ごとの ZIP が入っているもの） ----------------
const SET = { item: null, vols: [], open: false };
// 本を押したとき：まとめなら巻の一覧を、ふつうの本なら読む画面を出す
async function openItem(it) {
  if (it.kind === 'zip' && !it.parent) {
    let vols = null;
    try { vols = zipVolumes(await openZip(await getBookFile(it))); } catch (e) { }
    if (vols) { showSet(it, vols); return; }
  }
  openBook(it);
}
function showSet(it, vols) {
  SET.item = it; SET.open = true;
  SET.vols = vols.map((e) => ({ id: it.id + '#' + e.name, title: baseName(e.name), entry: e.name, kind: kindOf(e.name),
    parent: it, src: it.src, handle: it.handle }));
  history.pushState({ set: 1 }, '');
  $('library').hidden = true; $('setView').hidden = false;
  window.scrollTo(0, 0);
  renderSet();
}
function renderSet() {
  libUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  coverQueue = [];
  $('setTitle').textContent = SET.item.title + '（全' + SET.vols.length + '巻）';
  const box = $('vols'); box.innerHTML = '';
  renderCards(box, SET.vols);
  const cur = box.querySelector('.book.current');
  if (cur) cur.scrollIntoView({ block: 'center' });
}
function closeSet() {
  SET.open = false;
  $('setView').hidden = true; $('library').hidden = false;
  showLibrary();
}
$('setBack').onclick = () => history.back();
// 表紙は1冊ずつ順に作る（いっぺんに作るとメモリが足りなくなる）
async function runCoverQueue() {
  if (coverBusy) return;
  coverBusy = true;
  while (coverQueue.length) {
    const job = coverQueue.shift();
    try {
      const f = await getBookFile(job.it);
      const stamp = f.size + ':' + (f.lastModified || 0);
      if (job.cached && (job.it.src !== 'dir' || job.cached.stamp === stamp)) continue;
      const c = await makeCover(f, job.it.kind);
      c.stamp = stamp;
      await dbPut('covers', job.it.id, c);
      job.showCover(c);
    } catch (e) { console.warn('表紙を作れませんでした', job.it.title, e); }
  }
  coverBusy = false;
}

// 本を取りこむ（Android・iPad 用。Windows でも使える）
$('fileInput').addEventListener('change', async (ev) => {
  const files = [...ev.target.files]; ev.target.value = '';
  if (!files.length) return;
  const hint = $('libHint'); hint.hidden = false; hint.dataset.busy = '1';
  const bad = [];
  let done = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    hint.textContent = '取りこんでいます（' + (i + 1) + ' / ' + files.length + '）：' + f.name + '（' + Math.round(f.size / 1048576) + ' MB）';
    if (!BOOK_RE.test(f.name)) { bad.push(f.name + '：ZIP か PDF ではありません'); continue; }
    const kind = kindOf(f.name), id = 'local:' + f.name + ':' + f.size;
    try {
      const cover = await makeCover(f, kind);
      // 中身をこの端末の中に写す（もとのファイルが動いても読めるように）
      try { await dbPut('files', id, f); }
      catch (e) {
        if (e && e.name === 'QuotaExceededError') throw e;
        await dbPut('files', id, new Blob([await f.arrayBuffer()], { type: f.type }));
      }
      cover.stamp = f.size + ':' + (f.lastModified || 0);
      await dbPut('covers', id, cover);
      await dbPut('books', id, { id, src: 'local', title: baseName(f.name), kind, size: f.size, added: Date.now() });
      done++;
    } catch (e) {
      bad.push(f.name + '：' + (e && e.name === 'QuotaExceededError' ? '端末の空きが足りません' : errText(e)));
    }
  }
  if (done && navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) { } }
  delete hint.dataset.busy; hint.textContent = '';
  await showLibrary();
  if (bad.length) alert('取りこめなかった本があります：\n' + bad.join('\n'));
});

// ---------------- 読む画面 ----------------
const R = { item: null, src: null, cache: new Map(), pos: 0, view: [], opt: null, token: 0, z: 1, tx: 0, ty: 0, open: false };
const stage = $('stage'), pagesEl = $('pages'), reader = $('reader');

function isSpread() {
  return R.opt.spread === 'double' || (R.opt.spread === 'auto' && stage.clientWidth > stage.clientHeight * 1.05);
}
// i ページ目を含む見開きの、最初のページ
function startOf(i) {
  i = Math.max(0, Math.min(R.src.count - 1, i));
  if (!isSpread()) return i;
  if (R.opt.shift) return i === 0 ? 0 : i - ((i - 1) % 2);
  return i - (i % 2);
}
function viewAt(s) {
  if (!isSpread() || (R.opt.shift && s === 0)) return [s];
  return [s, s + 1].filter((i) => i < R.src.count);
}
function getPage(i) {
  if (!R.cache.has(i)) {
    const src = R.src;
    const p = src.load(i);
    p.catch(() => { if (R.cache.get(i) === p) R.cache.delete(i); });
    R.cache.set(i, p);
  }
  return R.cache.get(i);
}
function freePage(i) {
  const p = R.cache.get(i); R.cache.delete(i);
  if (p) p.then((pg) => pg.free()).catch(() => { });
}
// 並べたときの大きさ（見開きは高さをそろえて、画面に収まるように）
function sizesFor(pgs) {
  const W = stage.clientWidth, H = stage.clientHeight;
  const rsum = pgs.reduce((a, pg) => a + pg.w / pg.h, 0);
  const h = Math.min(H, W / rsum);
  return pgs.map((pg) => ({ w: (h * pg.w) / pg.h, h }));
}

async function show(s, keepZoom) {
  if (!R.src) return;
  s = startOf(s);
  const tok = ++R.token;
  R.pos = s; R.view = viewAt(s);
  updateBars();
  // 検索で飛んでいる間は、読んでいた位置を上書きしない（「元のページへ」で戻れるように）
  if (R.back == null) saveJson('bv_pos_' + R.item.id, { p: s, n: R.src.count, t: Date.now() });
  updateChip();
  const spin = setTimeout(() => { if (tok === R.token) $('loading').hidden = false; }, 250);
  try {
    const pgs = await Promise.all(R.view.map(getPage));
    if (tok !== R.token) return;
    const sz = sizesFor(pgs);
    await Promise.all(pgs.map((pg, k) => R.src.place(pg, sz[k].w, sz[k].h, keepZoom ? R.z : 1)));
    if (tok !== R.token) return;
    pgs.forEach((pg, k) => { pg.el.style.width = sz[k].w + 'px'; pg.el.style.height = sz[k].h + 'px'; });
    pagesEl.replaceChildren(...pgs.map((pg) => pg.el));
    if (!keepZoom) resetZoom();
  } catch (e) {
    if (tok === R.token) toast('読めませんでした：' + errText(e), 4000);
  } finally {
    clearTimeout(spin);
    if (tok === R.token) $('loading').hidden = true;
  }
  if (tok !== R.token) return;
  // 前後のページを先に用意しておき、遠いページは手放す（メモリを使いすぎないように）
  for (const i of [...R.cache.keys()]) if (i < s - KEEP_BEFORE || i > s + KEEP_AFTER) freePage(i);
  prepare(s + R.view.length, tok);
  if (s > 0) viewAt(startOf(s - 1)).forEach(getPage);
}
async function prepare(s, tok) {
  if (s >= R.src.count) return;
  try {
    const pgs = await Promise.all(viewAt(s).map(getPage));
    if (tok !== R.token) return;
    const sz = sizesFor(pgs);
    await Promise.all(pgs.map((pg, k) => R.src.place(pg, sz[k].w, sz[k].h, 1)));
  } catch (e) { }
}
let nextVolAsk = 0;
function next() {
  if (R.pos + R.view.length < R.src.count) { show(R.pos + R.view.length); return; }
  const nv = nextVolume();
  if (!nv) { toast('最後のページです'); return; }
  // 最後のページで、もう一度めくると次の巻へ（うっかり進まないように）
  if (Date.now() - nextVolAsk < 3000) { nextVolAsk = 0; switchVolume(nv); return; }
  nextVolAsk = Date.now();
  toast('最後のページです。もう一度めくると「' + nv.title + '」へ', 3000);
}
function nextVolume() {
  if (!R.item || !R.item.parent || !SET.open) return null;
  const i = SET.vols.findIndex((v) => v.id === R.item.id);
  return i >= 0 && i + 1 < SET.vols.length ? SET.vols[i + 1] : null;
}
function releaseBook() {
  R.token++;
  for (const i of [...R.cache.keys()]) freePage(i);
  if (R.src) { try { R.src.close(); } catch (e) { } }
  R.src = null;
}
function switchVolume(v) { releaseBook(); openBook(v, true); }
function prev() {
  if (R.pos > 0) show(R.pos - 1);
  else toast('最初のページです');
}
// 画面の左右どちら側を押したか（右開きの本は、左が「次」）
function turn(side) {
  const forward = R.opt.dir === 'rtl' ? side === 'left' : side === 'right';
  forward ? next() : prev();
  setUi(false);
}

function updateBars() {
  const o = R.opt, n = R.src.count;
  $('dirBtn').textContent = o.dir === 'rtl' ? '右開き' : '左開き';
  $('spreadBtn').textContent = { auto: '見開き：自動', single: '1ページ', double: '見開き' }[o.spread];
  $('shiftBtn').classList.toggle('on', !!o.shift);
  $('shiftBtn').disabled = !isSpread();
  pagesEl.classList.toggle('rtl', o.dir === 'rtl');
  const sl = $('slider');
  sl.max = n; sl.value = R.pos + 1; sl.classList.toggle('rtl', o.dir === 'rtl');
  $('pageNo').textContent = pageLabel(R.view) + ' / ' + n;
}
const pageLabel = (v) => (v.length > 1 ? (v[0] + 1) + '-' + (v[v.length - 1] + 1) : String(v[0] + 1));
function saveOpt() { saveJson('bv_view_' + R.item.id, R.opt); }
function setUi(on) { reader.classList.toggle('hideui', !on); }
function toggleUi() { setUi(reader.classList.contains('hideui')); }

let toastTimer = 0;
function toast(msg, ms) {
  const el = $('loading'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; el.textContent = '読みこんでいます…'; }, ms || 1200);
}

async function openBook(item, noPush) {
  R.open = true; R.item = item; R.back = null;
  R.opt = Object.assign({ dir: 'rtl', spread: 'auto', shift: item.kind === 'zip' }, loadJson('bv_view_' + item.id, {}));
  $('library').hidden = true; reader.hidden = false; setUi(true);
  $('title').textContent = item.parent ? item.parent.title + '／' + item.title : item.title;
  $('searchBtn').hidden = item.kind !== 'pdf'; $('searchBtn').classList.remove('on');
  closeSearch(); $('searchInput').value = ''; $('searchList').innerHTML = ''; $('searchStatus').textContent = '';
  pagesEl.replaceChildren();
  $('loading').textContent = '読みこんでいます…'; $('loading').hidden = false;
  if (!noPush) history.pushState({ reader: 1 }, '');
  if (item.parent) saveJson('bv_pos_' + item.parent.id, { vol: item.entry, t: Date.now() });  // まとめの中で、どの巻を読んでいるか
  $('setView').hidden = true;
  const tok = ++R.token;
  try {
    const f = await getBookFile(item);
    R.stamp = f.size + ':' + (f.lastModified || 0);
    const src = await openSource(f, item.kind);
    if (tok !== R.token || !R.open) { src.close(); return; }
    R.src = src;
  } catch (e) {
    $('loading').hidden = true;
    alert('開けませんでした：' + errText(e));
    history.back();
    return;
  }
  const pos = loadJson('bv_pos_' + item.id, null);
  await show(pos && pos.p < R.src.count ? pos.p : 0);
}
function closeReader() {
  if (!R.open) return;
  R.open = false; R.back = null;
  closeSearch(); updateChip();
  releaseBook();
  pagesEl.replaceChildren();
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => { });
  reader.hidden = true; $('loading').hidden = true;
  if (pendingReload) { location.reload(); return; }
  if (SET.open) { $('setView').hidden = false; renderSet(); }
  else { $('library').hidden = false; showLibrary(); }
}
window.addEventListener('popstate', () => {
  if (R.open) closeReader();
  else if (SET.open) closeSet();
});
$('back').onclick = () => history.back();

$('dirBtn').onclick = () => { R.opt.dir = R.opt.dir === 'rtl' ? 'ltr' : 'rtl'; saveOpt(); updateBars(); };
$('spreadBtn').onclick = () => {
  R.opt.spread = { auto: 'single', single: 'double', double: 'auto' }[R.opt.spread]; saveOpt(); show(R.pos);
};
$('shiftBtn').onclick = () => { R.opt.shift = !R.opt.shift; saveOpt(); show(R.pos + (R.opt.shift ? 1 : 0)); };
$('slider').addEventListener('input', () => { $('pageNo').textContent = $('slider').value + ' / ' + R.src.count; });
$('slider').addEventListener('change', () => show(+$('slider').value - 1));
if (document.documentElement.requestFullscreen) {
  $('fullBtn').hidden = false;
  $('fullBtn').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
    else document.documentElement.requestFullscreen().catch(() => { });
  };
}
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (R.open && R.src) show(R.pos); }, 150);
});

// ---------------- PDF の中の文字で探す ----------------
// 比べるときは、全角／半角のちがいと空白・改行を無視する
const norm = (t) => t.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
// ページの中で、言葉が見つかった所（文字のかたまりごとに、はじからはじまでの割合）
function findMarks(items, q) {
  let stream = ''; const map = [];
  items.forEach((it, k) => {
    const chars = [...(it.str || '')];
    chars.forEach((ch, c) => { const n = norm(ch); for (let u = 0; u < n.length; u++) { stream += n[u]; map.push({ k, c, len: chars.length }); } });
  });
  const out = [];
  for (let at = stream.indexOf(q); at >= 0 && q; at = stream.indexOf(q, at + q.length)) {
    const parts = {};
    for (const m of map.slice(at, at + q.length)) {
      const g = parts[m.k] || (parts[m.k] = { k: m.k, c0: m.c, c1: m.c, len: m.len });
      g.c0 = Math.min(g.c0, m.c); g.c1 = Math.max(g.c1, m.c);
    }
    for (const g of Object.values(parts)) out.push({ it: items[g.k], f0: g.c0 / g.len, f1: (g.c1 + 1) / g.len });
  }
  return out;
}
async function drawMarks(pg, vp, ctx, q) {
  if (!pg.items) pg.items = (await pg.page.getTextContent()).items;
  const marks = findMarks(pg.items, q);
  if (!marks.length) return;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = 'rgba(255, 196, 0, 0.75)';
  for (const m of marks) {
    const [a, b, c, d, e, f] = m.it.transform;
    const la = Math.hypot(a, b) || 1, lc = Math.hypot(c, d) || 1;
    const w = m.it.width, h = m.it.height || lc;
    // 字の並ぶ向き（a,b）と、字の上の向き（c,d）から、四すみを出す（縦書きでも横書きでも）
    const pts = [[w * m.f0, -0.25 * h], [w * m.f1, -0.25 * h], [w * m.f1, h], [w * m.f0, h]]
      .map(([sx, ty]) => vp.convertToViewportPoint(e + (a / la) * sx + (c / lc) * ty, f + (b / la) * sx + (d / lc) * ty));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    ctx.fillRect(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  }
  ctx.restore();
}

const SR = { tok: 0, hits: [], q: '' };
function openSearch() {
  $('searchPanel').hidden = false;
  setTimeout(() => $('searchInput').focus(), 50);
}
function closeSearch() { SR.tok++; $('searchPanel').hidden = true; }
// 本の全ページの文字を用意する（一度取り出したら端末にしまっておき、次からはすぐ使う）
async function bookTexts(tok) {
  const id = R.item.id, stamp = R.stamp;
  let rec = null;
  try { rec = await dbGet('texts', id); } catch (e) { }
  if (rec && rec.stamp === stamp && rec.pages && rec.pages.length === R.src.count) return rec.pages;
  const src = R.src, pages = [];
  for (let i = 0; i < src.count; i++) {
    if (tok !== SR.tok || src !== R.src) return null;
    $('searchStatus').textContent = '本の文字を読みこんでいます（' + (i + 1) + ' / ' + src.count + ' ページ）…　はじめの1回だけです';
    try { pages.push(await src.text(i)); } catch (e) { pages.push(''); }
  }
  try { await dbPut('texts', id, { stamp, pages }); } catch (e) { }
  return pages;
}
async function runSearch() {
  const raw = $('searchInput').value.trim(), q = norm(raw);
  const tok = ++SR.tok;
  const list = $('searchList'); list.innerHTML = '';
  if (!q) { setQuery(''); $('searchStatus').textContent = ''; return; }
  const pages = await bookTexts(tok);
  if (!pages || tok !== SR.tok) return;
  const hits = [];
  let empty = 0;
  pages.forEach((t, i) => {
    const n = norm(t);
    if (!n) empty++;
    for (let at = n.indexOf(q); at >= 0; at = n.indexOf(q, at + q.length)) {
      hits.push({ p: i, before: n.slice(Math.max(0, at - 18), at), word: n.substr(at, q.length), after: n.substr(at + q.length, 18) });
      if (hits.length >= 1000) break;
    }
  });
  SR.hits = hits; SR.q = q;
  $('searchStatus').textContent = hits.length ? '「' + raw + '」が ' + hits.length + (hits.length >= 1000 ? ' 件以上' : ' 件') + '見つかりました'
    : (empty === pages.length ? 'この PDF には文字が入っていないようです（画像だけの PDF は探せません）' : '「' + raw + '」は見つかりませんでした');
  for (const h of hits) {
    const li = document.createElement('button'); li.className = 'hit';
    const pn = document.createElement('span'); pn.className = 'hp'; pn.textContent = (h.p + 1) + ' ページ';
    const tx = document.createElement('span'); tx.className = 'ht';
    const mk = document.createElement('mark'); mk.textContent = h.word;
    tx.append('…' + h.before, mk, h.after + '…');
    li.append(pn, tx);
    li.onclick = () => {
      if (R.back == null) R.back = R.pos;  // 飛ぶ前に読んでいたページを覚えておく
      setQuery(q); closeSearch(); setUi(false); show(h.p);
    };
    list.append(li);
  }
  setQuery(q);
}
// 色を付ける言葉を変えたら、いま出ているページを描きなおす
function setQuery(q) {
  if (!R.src || R.item.kind !== 'pdf' || R.src.query === q) return;
  R.src.query = q;
  for (const p of R.cache.values()) p.then((pg) => { pg.scale = 0; }).catch(() => { });
  $('searchBtn').classList.toggle('on', !!q);
  updateChip();
  Promise.resolve().then(() => show(R.pos, true));
}
$('searchBtn').onclick = openSearch;
$('searchClose').onclick = closeSearch;
$('searchGo').onclick = runSearch;
// 検索をやめる。goBack なら、検索で飛ぶ前に読んでいたページへもどる。そうでなければ、いまのページから読む
function endSearch(goBack) {
  $('searchInput').value = ''; SR.tok++; $('searchList').innerHTML = ''; $('searchStatus').textContent = '';
  const back = R.back; R.back = null;
  setQuery('');
  if (goBack && back != null && back !== R.pos) show(back, false);
  else if (R.src) show(R.pos, true);  // いまのページを、読んでいる位置としてしまう
  closeSearch(); updateChip();
}
// 画面の下の小さな札：検索中であることと、もどるボタン
function updateChip() {
  const chip = $('searchChip');
  const q = R.src && R.src.query, back = R.back;
  chip.hidden = !R.open || (!q && back == null);
  if (chip.hidden) return;
  $('chipText').textContent = '🔍「' + ($('searchInput').value.trim() || q || '') + '」';
  $('chipBack').hidden = back == null;
  $('chipBack').textContent = '↩ 元のページ（' + ((back || 0) + 1) + '）へ';
  $('chipHere').hidden = back == null;
  $('chipClear').hidden = back != null;
}
$('searchClear').onclick = () => endSearch(true);
$('chipBack').onclick = () => endSearch(true);
$('chipHere').onclick = () => endSearch(false);
$('chipClear').onclick = () => endSearch(false);
$('searchInput').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
  else if (e.key === 'Escape') closeSearch();
});

// ---------------- 拡大と、指での操作 ----------------
function applyZoom() { pagesEl.style.transform = 'translate(' + R.tx + 'px,' + R.ty + 'px) scale(' + R.z + ')'; }
function clampPan() {
  const W = stage.clientWidth, H = stage.clientHeight;
  R.tx = Math.min(0, Math.max(W - W * R.z, R.tx));
  R.ty = Math.min(0, Math.max(H - H * R.z, R.ty));
}
function resetZoom() { R.z = 1; R.tx = 0; R.ty = 0; applyZoom(); }
// (cx, cy) の所を動かさずに、拡大率を z にする
function zoomAt(z, cx, cy) {
  z = Math.max(1, Math.min(6, z));
  const px = (cx - R.tx) / R.z, py = (cy - R.ty) / R.z;
  R.z = z; R.tx = cx - z * px; R.ty = cy - z * py;
  clampPan(); applyZoom();
}
let sharpTimer = 0;
// 拡大し終わったら、PDF は細かく描きなおす
function sharpen() {
  clearTimeout(sharpTimer);
  sharpTimer = setTimeout(async () => {
    if (!R.src || R.item.kind !== 'pdf') return;
    const tok = R.token;
    const pgs = await Promise.all(R.view.map(getPage));
    if (tok !== R.token) return;
    const sz = sizesFor(pgs);
    pgs.forEach((pg, k) => R.src.place(pg, sz[k].w, sz[k].h, R.z));
  }, 200);
}

const ptrs = new Map();
let gest = null, lastTap = null, tapTimer = 0;
const rel = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
function pinchInfo() {
  const [a, b] = [...ptrs.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}
stage.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  try { stage.setPointerCapture(e.pointerId); } catch (er) { }
  ptrs.set(e.pointerId, rel(e));
  if (ptrs.size === 1) {
    const p = rel(e);
    gest = { type: 'one', x0: p.x, y0: p.y, t0: Date.now(), tx0: R.tx, ty0: R.ty, moved: false };
  } else if (ptrs.size === 2) {
    const pi = pinchInfo();
    gest = { type: 'pinch', d0: pi.d, z0: R.z, m0: pi.m, tx0: R.tx, ty0: R.ty };
  }
});
stage.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId) || !gest) return;
  ptrs.set(e.pointerId, rel(e));
  if (gest.type === 'pinch' && ptrs.size >= 2) {
    const pi = pinchInfo();
    const z = Math.max(1, Math.min(6, (gest.z0 * pi.d) / gest.d0));
    const px = (gest.m0.x - gest.tx0) / gest.z0, py = (gest.m0.y - gest.ty0) / gest.z0;
    R.z = z; R.tx = pi.m.x - z * px; R.ty = pi.m.y - z * py;
    clampPan(); applyZoom();
  } else if (gest.type === 'one') {
    const p = rel(e), dx = p.x - gest.x0, dy = p.y - gest.y0;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) gest.moved = true;
    if (R.z > 1) { R.tx = gest.tx0 + dx; R.ty = gest.ty0 + dy; clampPan(); applyZoom(); }
  }
});
function endPointer(e, cancelled) {
  if (!ptrs.has(e.pointerId)) return;
  const p = rel(e);
  ptrs.delete(e.pointerId);
  if (!gest) return;
  if (gest.type === 'pinch') {
    if (ptrs.size === 1) {  // 1本だけ残ったら、そのまま動かせるように
      const q = [...ptrs.values()][0];
      gest = { type: 'one', x0: q.x, y0: q.y, t0: 0, tx0: R.tx, ty0: R.ty, moved: true };
    } else if (ptrs.size === 0) {
      gest = null;
      if (R.z < 1.05) resetZoom(); else sharpen();
    }
    return;
  }
  if (ptrs.size > 0) return;
  const g = gest; gest = null;
  if (cancelled) return;
  const dx = p.x - g.x0, dy = p.y - g.y0, dt = Date.now() - g.t0;
  if (!g.moved && dt < 500) { onTap(p.x, p.y); return; }
  if (R.z === 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) turn(dx > 0 ? 'left' : 'right');
}
stage.addEventListener('pointerup', (e) => endPointer(e, false));
stage.addEventListener('pointercancel', (e) => endPointer(e, true));

// タップ：左右のはしでページをめくる。まん中で上下のボタンを出す／しまう。2回すばやく押すと拡大／もとにもどす
function onTap(x, y) {
  const W = stage.clientWidth, now = Date.now();
  const zone = x < W * 0.3 ? 'left' : x > W * 0.7 ? 'right' : 'center';
  const dbl = lastTap && now - lastTap.t < 300 && Math.hypot(x - lastTap.x, y - lastTap.y) < 40;
  clearTimeout(tapTimer);
  if (R.z > 1) {
    if (dbl) { lastTap = null; resetZoom(); return; }
    lastTap = { t: now, x, y };
    tapTimer = setTimeout(() => { lastTap = null; if (zone === 'center') toggleUi(); }, 300);
    return;
  }
  if (zone !== 'center') { lastTap = null; turn(zone); return; }
  if (dbl) { lastTap = null; zoomAt(2.5, x, y); sharpen(); return; }
  lastTap = { t: now, x, y };
  tapTimer = setTimeout(() => { lastTap = null; toggleUi(); }, 300);
}

// マウスのホイール：回すとページをめくる。Ctrl を押しながらで拡大
let wheelAt = 0;
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = rel(e);
  if (e.ctrlKey) { zoomAt(R.z * Math.exp(-e.deltaY * 0.01), p.x, p.y); if (R.z === 1) resetZoom(); else sharpen(); return; }
  if (R.z > 1) { R.tx -= e.deltaX; R.ty -= e.deltaY; clampPan(); applyZoom(); return; }
  const now = Date.now();
  if (now - wheelAt < 250 || Math.abs(e.deltaY) < 4) return;
  wheelAt = now;
  e.deltaY > 0 ? next() : prev();
}, { passive: false });

// キーボード（Windows）
document.addEventListener('keydown', (e) => {
  if (!R.open || !R.src || e.altKey || e.metaKey) return;
  if (!$('searchPanel').hidden) { if (e.key === 'Escape') { closeSearch(); e.preventDefault(); } return; }
  if (R.item.kind === 'pdf' && ((e.ctrlKey && e.key === 'f') || e.key === '/')) { e.preventDefault(); openSearch(); return; }
  const k = e.key;
  if (k === 'ArrowLeft') turn('left');
  else if (k === 'ArrowRight') turn('right');
  else if (k === 'ArrowDown' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) next();
  else if (k === 'ArrowUp' || k === 'PageUp' || (k === ' ' && e.shiftKey)) prev();
  else if (k === 'Home') show(0);
  else if (k === 'End') show(R.src.count - 1);
  else if (k === '+' || k === ';') { zoomAt(R.z * 1.25, stage.clientWidth / 2, stage.clientHeight / 2); sharpen(); }
  else if (k === '-') { zoomAt(R.z / 1.25, stage.clientWidth / 2, stage.clientHeight / 2); if (R.z === 1) resetZoom(); }
  else if (k === '0') resetZoom();
  else if (k === 'Escape') { if (R.z > 1) resetZoom(); else if (!document.fullscreenElement) history.back(); }
  else return;
  e.preventDefault();
});
// iPad の Safari が画面全体を拡大しないように
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ---------------- はじめに ----------------
// 新しい版が届いたら入れかえる（読んでいる最中なら、本棚にもどったときに）
let pendingReload = false;
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // アプリを開きなおしたとき（ホーム画面から戻ったときも）に、新しい版がないかたしかめる
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => { }); });
  }).catch(() => { });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || pendingReload) return;
    pendingReload = true;
    if (R.open) toast('新しい版が届きました。本棚にもどると入れかわります', 3000);
    else location.reload();
  });
}
$('ver').textContent = 'BookViewer ' + APP_VERSION;
(async () => {
  await initDir();
  if (!DIR.items.length) await showLibrary();
})();
