// BookViewer の「聞く」画面：BookPlayer の本（<書名>.book.zip。中に book.json と音声と対応データが入っている）を、
// 音声に合わせて、読んでいる文を明るくしながら聞く。BookPlayer（D:\Claude Code\audiobook\webplayer）の再生画面を移したもの
// app.js のあとに読みこむ。app.js の $、openZip、loadJson、saveJson、PDFJS_WORKER、CMAP_URL、FONT_URL、errText を使う
'use strict';
(() => {
  const RUBY_ROOM = 0.6;        // 光らせる所を、ふりがなの側へどれだけ広げるか（文字の太さに対して）
  const BROWSE_SECONDS = 10;    // ページをめくって見ているとき、何秒さわらなければ読んでいる所にもどるか
  const settings = Object.assign({ speed: '1.0', volume: 100, hl: 'dim', spread: 'auto' }, loadJson('bv_listen_settings', {}));
  const saveSettings = () => saveJson('bv_listen_settings', settings);
  const view = $('listen'), audio = $('lsAudio');

  // BookPlayer の本かどうか（book.json の format で見分ける）。ちがえば null
  async function bookManifest(zip) {
    const e = zip.entries.find((x) => x.name === 'book.json');
    if (!e) return null;
    try {
      const m = JSON.parse(await (await zip.blob(e, 'application/json')).text());
      return m && m.format === 'bookplayer-book' && Array.isArray(m.tracks) && m.tracks.length && m.pdf ? m : null;
    } catch (err) { return null; }
  }
  // 名前で中のファイルを取り出せるようにする
  function named(zip) {
    const map = new Map(zip.entries.map((e) => [e.name, e]));
    return {
      has: (n) => map.has(n),
      async blob(n, type) { const e = map.get(n); if (!e) throw new Error('本の中に ' + n + ' がありません'); return zip.blob(e, type); },
      async json(n) { return JSON.parse(await (await this.blob(n, 'application/json')).text()); },
    };
  }

  const S = {
    open: false, item: null, zip: null, manifest: null, pdf: null, pdfTask: null, track: -1, sync: null, items: [], vertical: true,
    cur: -1, curChar: -1, view: { start: -1, count: 1 }, browsing: false, browseAt: 0, url: null, raf: 0, lastSave: 0, renderToken: 0, coverUrl: null,
  };
  const posKey = () => 'bv_listen_' + S.item.id;

  function stopAll() {
    try { audio.pause(); } catch (e) { }
    if (S.url) { URL.revokeObjectURL(S.url); S.url = null; }
    audio.removeAttribute('src');
    cancelAnimationFrame(S.raf);
  }

  // 開く（app.js の openItem から呼ぶ）。zip は openZip したもの、m は book.json の中身
  async function openListen(item, zip, m) {
    S.open = true; S.item = item; S.zip = named(zip); S.manifest = m;
    history.pushState({ listen: 1 }, '');
    $('library').hidden = true; $('setView').hidden = true; view.hidden = false;
    document.body.classList.toggle('lsfull', !!settings.full);
    $('lsTitle').textContent = (m.title || item.title) + (m.author ? '　' + m.author : '');
    $('lsPages').innerHTML = ''; $('lsLine').textContent = '';
    const ld = $('lsLoading'); ld.hidden = false;
    const t0 = Date.now();
    const tick = setInterval(() => { ld.textContent = '読みこんでいます…（' + Math.round((Date.now() - t0) / 1000) + '秒）'; }, 500);
    try {
      const sel = $('lsTrack'); sel.innerHTML = '';
      m.tracks.forEach((t, i) => { const o = document.createElement('option'); o.value = i; o.textContent = (t.title || ('曲 ' + (i + 1))) + (t.sync ? '' : '（対応データなし）'); sel.append(o); });
      if (typeof pdfjsLib === 'undefined') throw new Error('PDF を読む部品がまだありません。一度ネットにつないでから開いてください');
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      const pdfBlob = await S.zip.blob(m.pdf, 'application/pdf');
      const range = new pdfjsLib.PDFDataRangeTransport(pdfBlob.size, null);
      range.requestDataRange = (begin, end) => { pdfBlob.slice(begin, end).arrayBuffer().then((b) => range.onDataRange(begin, new Uint8Array(b))); };
      S.pdfTask = pdfjsLib.getDocument({ range, length: pdfBlob.size, disableAutoFetch: true, disableStream: true, rangeChunkSize: 262144,
        cMapUrl: CMAP_URL, cMapPacked: true, standardFontDataUrl: FONT_URL });
      const pdf = await S.pdfTask.promise;
      if (!S.open || S.item !== item) { S.pdfTask.destroy(); return; }
      S.pdf = pdf;
      if (m.cover && S.zip.has(m.cover)) { try { S.coverUrl = URL.createObjectURL(await S.zip.blob(m.cover, 'image/jpeg')); } catch (e) { } }
      ld.hidden = true;
      const st = loadJson(posKey(), { track: 0, pos: 0 });
      await loadTrack(Math.min(st.track || 0, m.tracks.length - 1), st.pos || 0);
    } catch (e) {
      alert('開けませんでした：' + errText(e));
      history.back();
    } finally { clearInterval(tick); ld.textContent = '読みこんでいます…'; }
  }
  function closeListen() {
    if (!S.open) return;
    savePos(true);
    S.open = false; S.renderToken++;
    stopAll();
    if (S.pdfTask) { try { S.pdfTask.destroy(); } catch (e) { } }
    S.pdf = null; S.pdfTask = null; S.sync = null; S.items = []; S.track = -1;
    if (S.coverUrl) { URL.revokeObjectURL(S.coverUrl); S.coverUrl = null; }
    $('lsPages').innerHTML = '';
    $('lsMenu').hidden = true;
    document.body.classList.remove('lsfull');
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => { });
    view.hidden = true;
  }

  async function loadTrack(i, pos) {
    stopAll();
    S.track = i; $('lsTrack').value = i;
    const t = S.manifest.tracks[i];
    S.sync = null; S.items = []; S.cur = -1; S.curChar = -1; S.view = { start: -1, count: 1 }; S.browsing = false;
    if (t.sync && S.zip.has(t.sync)) {
      S.sync = await S.zip.json(t.sync);
      S.items = S.sync.items || [];
      let v = 0, h = 0;
      for (const it of S.items) for (const r of it.rects || []) { if (r[4] - r[2] > r[3] - r[1]) v++; else h++; }
      S.vertical = v >= h;
    } else S.vertical = true;
    $('lsPages').style.direction = S.vertical ? 'rtl' : 'ltr';
    // 右とじ（縦書き）の本は、位置のつまみも右から左へ。下のボタンも左右を逆に
    $('lsSeek').style.direction = S.vertical ? 'rtl' : 'ltr';
    view.querySelector('.seekrow').style.flexDirection = S.vertical ? 'row-reverse' : 'row';
    view.querySelector('.ctrl').style.flexDirection = S.vertical ? 'row-reverse' : 'row';
    $('lsPrevS').textContent = S.vertical ? '⏭' : '⏮';
    $('lsNextS').textContent = S.vertical ? '⏮' : '⏭';
    S.url = URL.createObjectURL(await S.zip.blob(t.audio, 'audio/mpeg'));
    audio.src = S.url;
    audio.playbackRate = parseFloat(settings.speed);
    audio.volume = settings.volume / 100;
    await new Promise((ok) => { audio.addEventListener('loadedmetadata', ok, { once: true }); setTimeout(ok, 4000); });
    try { audio.currentTime = pos; } catch (e) { }
    setPlayIcon();
    setMediaSession();
    if (!S.sync) { $('lsLine').textContent = 'この曲には対応データがありません。音だけ再生します。'; showPage(0); }
    update(true, pos);
    updateTime();
  }

  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  }
  let seeking = false;
  function updateTime() {
    const d = audio.duration || 0, p = audio.currentTime || 0;
    $('lsTime').textContent = fmt(p) + ' / ' + fmt(d);
    if (!seeking && d > 0) $('lsSeek').value = Math.round(1000 * p / d);
  }
  function savePos(force) {
    if (!S.item || S.track < 0) return;
    const now = Date.now();
    if (!force && now - S.lastSave < 5000) return;
    S.lastSave = now;
    saveJson(posKey(), { track: S.track, pos: Math.round((audio.currentTime || 0) * 10) / 10, t: now });
  }

  function findItem(t) {
    const a = S.items; if (!a.length) return -1;
    let lo = 0, hi = a.length - 1, ans = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (a[mid].start <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  function findChar(it, t) {
    const cs = it.chars; if (!cs || !cs.length) return -1;
    let lo = 0, hi = cs.length - 1, ans = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (cs[mid][5] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  // 読んでいる文字のページ（なければ文のページ。見出しなど、ページにない文は次の文のページ）
  function pageAt(i, j) {
    const it = S.items[i];
    let pg = j >= 0 ? it.chars[j][0] : it.page;
    for (let k = i + 1; pg == null && k < Math.min(S.items.length, i + 4); k++) if (S.items[k].page != null) pg = S.items[k].page;
    return pg;
  }
  // いまの時刻の文に色を付け、読んでいる文字のページが見えていなければめくる
  function update(force, at) {
    if (!S.sync) return;
    if (S.browsing) {
      if (!force && (Date.now() - S.browseAt) / 1000 < BROWSE_SECONDS) return;
      S.browsing = false; force = true;
    }
    const t = at != null ? at : audio.currentTime;
    const i = findItem(t); if (i < 0) return;
    const it = S.items[i], j = findChar(it, t);
    if (i === S.cur && j === S.curChar && !force) return;
    const same = i === S.cur;
    S.cur = i; S.curChar = j;
    if (!same || force) $('lsLine').textContent = it.text || '';
    const pg = pageAt(i, j);
    if (pg != null && !shown(pg)) showPage(pg);
    else if (!same || force) drawOverlays();
  }

  // ---------------- ページを出す ----------------
  function spreadCount() {
    const st = $('lsStage');
    return settings.spread === 'auto' && st.clientWidth > st.clientHeight * 1.15 ? 2 : 1;
  }
  const shown = (pg) => pg >= S.view.start && pg < S.view.start + S.view.count;
  function showPage(pg, browsing) {
    const n = spreadCount();
    const total = S.pdf ? S.pdf.numPages : 0;
    if (pg < 0 || pg >= total) return;
    S.view = { start: n === 2 ? pg - (pg % 2) : pg, count: n };
    if (browsing) { S.browsing = true; S.browseAt = Date.now(); }
    renderView();
  }
  function movePage(step) {
    if (!S.pdf || S.view.start < 0) return;
    const to = S.view.start + step * S.view.count;
    if (to < 0 || to >= S.pdf.numPages) return;
    showPage(to, true);
  }
  async function renderView() {
    const token = ++S.renderToken;
    const box = $('lsPages'), st = $('lsStage');
    const n = S.view.count, dpr = window.devicePixelRatio || 1;
    const W = st.clientWidth / n, H = st.clientHeight;
    const els = [];
    for (let k = 0; k < n; k++) {
      const pn = S.view.start + k;
      if (pn >= S.pdf.numPages) break;
      const page = await S.pdf.getPage(pn + 1);
      if (token !== S.renderToken) return;
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(W / vp1.width, H / vp1.height);
      let s = scale * dpr;
      const px = vp1.width * vp1.height * s * s;
      if (px > MAX_CANVAS_PIXELS) s *= Math.sqrt(MAX_CANVAS_PIXELS / px);  // iPad で落ちないように
      const vp = page.getViewport({ scale: s });
      const el = document.createElement('div'); el.className = 'lpage';
      el.style.width = Math.floor(vp1.width * scale) + 'px'; el.style.height = Math.floor(vp1.height * scale) + 'px';
      const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      c.style.width = el.style.width; c.style.height = el.style.height;
      const o = document.createElement('canvas'); o.width = c.width; o.height = c.height; o.style.width = c.style.width; o.style.height = c.style.height;
      el.append(c, o);
      el.dataset.pn = pn;
      el._scale = s; el._css = scale; el._overlay = o;
      els.push({ el, page, vp, c });
    }
    if (token !== S.renderToken) return;
    box.innerHTML = '';
    for (const x of els) box.append(x.el);
    drawOverlays();
    const nums = els.map((x) => +x.el.dataset.pn + 1);
    $('lsPageInfo').textContent = (nums.length > 1 ? nums.join('・') : nums[0]) + ' / ' + S.pdf.numPages + ' ページ' + (S.browsing ? '（見ているだけ）' : '');
    for (const x of els) {
      try { await x.page.render({ canvasContext: x.c.getContext('2d'), viewport: x.vp }).promise; } catch (e) { }
      if (token !== S.renderToken) return;
    }
  }
  function drawOverlays() {
    const dpr = window.devicePixelRatio || 1;
    for (const el of $('lsPages').children) {
      const o = el._overlay, g = o.getContext('2d');
      g.clearRect(0, 0, o.width, o.height);
      if (S.cur < 0 || !S.items[S.cur]) continue;
      const pn = +el.dataset.pn, k = el._scale, pad = 3 * dpr;
      const boxes = [];
      for (const r of S.items[S.cur].rects || []) {
        if (r[0] !== pn) continue;
        let x = r[1] * k - pad, y = r[2] * k - pad, w = (r[3] - r[1]) * k + 2 * pad, h = (r[4] - r[2]) * k + 2 * pad;
        // ふりがなの所まで広げる：縦書きは行の右、横書きは行の上
        if (h > w) w += (w - 2 * pad) * RUBY_ROOM; else { const ex = (h - 2 * pad) * RUBY_ROOM; y -= ex; h += ex; }
        boxes.push([x, y, w, h]);
      }
      // 2ページ出しているとき、読んでいる文のないほうのページも、まわりと同じように暗くする
      if (!boxes.length) {
        if (settings.hl === 'dim' || settings.hl === 'dimpen') { g.fillStyle = 'rgba(30,35,45,0.43)'; g.fillRect(0, 0, o.width, o.height); }
        continue;
      }
      const dim = () => {
        g.beginPath(); g.rect(0, 0, o.width, o.height);
        for (const b of boxes) g.rect(b[0], b[1], b[2], b[3]);
        g.fillStyle = 'rgba(30,35,45,0.43)'; g.fill('evenodd');
      };
      if (settings.hl === 'dim') dim();
      else if (settings.hl === 'dimpen') { dim(); g.fillStyle = 'rgba(255,230,0,0.27)'; for (const b of boxes) g.fillRect(...b); }
      else if (settings.hl === 'line') {
        const th = 4 * dpr; g.fillStyle = 'rgba(255,214,0,0.51)';
        for (const b of boxes) {
          if (b[3] > b[2]) g.fillRect(b[0] + pad - th - dpr, b[1] + pad, th, b[3] - 2 * pad);
          else g.fillRect(b[0] + pad, b[1] + b[3] - pad + dpr, b[2] - 2 * pad, th);
        }
      } else {
        g.fillStyle = 'rgba(255,214,0,0.35)'; g.strokeStyle = 'rgba(245,158,11,0.8)'; g.lineWidth = 1.5 * dpr;
        for (const b of boxes) { g.fillRect(...b); g.strokeRect(...b); }
      }
    }
  }

  // ---------------- 操作 ----------------
  function setPlayIcon() { $('lsPlay').textContent = $('lsFullPlay').textContent = audio.paused ? '▶' : '⏸'; }
  // 本文だけを大きく出す（上と下の帯をかくす）。できる端末では、ブラウザの枠も消して画面いっぱいにする
  function setFull(on) {
    document.body.classList.toggle('lsfull', on);
    const de = document.documentElement;
    try {
      if (on && !document.fullscreenElement && !document.webkitFullscreenElement) {
        const r = de.requestFullscreen ? de.requestFullscreen() : (de.webkitRequestFullscreen ? de.webkitRequestFullscreen() : null);
        if (r && r.catch) r.catch(() => { });
      } else if (!on && (document.fullscreenElement || document.webkitFullscreenElement)) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      }
    } catch (e) { }
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  }
  $('lsFull').onclick = () => { settings.full = true; saveSettings(); setFull(true); };
  $('lsFullExit').onclick = () => { settings.full = false; saveSettings(); setFull(false); };
  $('lsFullPlay').onclick = () => togglePlay();
  const onFsChange = () => {
    if (S.open && !document.fullscreenElement && !document.webkitFullscreenElement && document.body.classList.contains('lsfull')) { settings.full = false; saveSettings(); setFull(false); }
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  function togglePlay() {
    if (!S.url) return;
    if (audio.paused) { audio.play().catch(() => { }); if (S.browsing) update(true); } else audio.pause();
  }
  function seekTo(s) {
    const d = audio.duration || 0;
    s = Math.max(0, d > 0 ? Math.min(s, d - 0.2) : s);
    audio.currentTime = s;
    update(true, s); updateTime(); savePos(true);
  }
  const posNow = () => audio.currentTime || 0;
  $('lsPlay').onclick = togglePlay;
  $('lsBack15').onclick = () => seekTo(posNow() - 15);
  $('lsFwd30').onclick = () => seekTo(posNow() + 30);
  $('lsPrevS').onclick = () => {
    if (!S.sync) return seekTo(posNow() - 5);
    const i = findItem(posNow());
    if (i >= 0 && posNow() - S.items[i].start > 2) seekTo(S.items[i].start); else if (i > 0) seekTo(S.items[i - 1].start);
  };
  $('lsNextS').onclick = () => {
    if (!S.sync) return seekTo(posNow() + 5);
    const i = findItem(posNow());
    if (i + 1 < S.items.length) seekTo(S.items[i + 1].start);
  };
  $('lsSeek').addEventListener('input', () => { seeking = true; const d = audio.duration || 0; $('lsTime').textContent = fmt(d * $('lsSeek').value / 1000) + ' / ' + fmt(d); });
  $('lsSeek').addEventListener('change', () => { seeking = false; seekTo((audio.duration || 0) * $('lsSeek').value / 1000); });
  $('lsTrack').onchange = () => { savePos(true); loadTrack(+$('lsTrack').value, 0); };
  $('lsBack').onclick = () => history.back();
  // 縦書きの本は、左が次のページ
  $('lsNavPrev').onclick = () => movePage(S.vertical ? 1 : -1);
  $('lsNavNext').onclick = () => movePage(S.vertical ? -1 : 1);

  audio.addEventListener('play', () => { setPlayIcon(); loop(); });
  audio.addEventListener('pause', () => { setPlayIcon(); savePos(true); cancelAnimationFrame(S.raf); });
  audio.addEventListener('timeupdate', () => { if (!S.open) return; updateTime(); savePos(false); if (audio.paused) update(false); });
  audio.addEventListener('ended', () => {
    // 章ごとの曲は、次の章へ続けて進む
    const t = S.manifest && S.manifest.tracks;
    if (S.open && t && t[S.track].kind === 'chapter' && S.track + 1 < t.length && t[S.track + 1].kind === 'chapter') loadTrack(S.track + 1, 0).then(() => audio.play().catch(() => { }));
  });
  function loop() {
    cancelAnimationFrame(S.raf);
    const step = () => { if (audio.paused || !S.open) return; update(false); updateTime(); S.raf = requestAnimationFrame(step); };
    S.raf = requestAnimationFrame(step);
  }

  // ページをタップ：その文から再生。左右にはらう：ページをめくる
  let down = null;
  const stageEl = $('lsStage');
  stageEl.addEventListener('pointerdown', (e) => { if (e.target.closest('.lnav') || e.target.closest('#lsFullCtrl')) return; down = { x: e.clientX, y: e.clientY }; });
  stageEl.addEventListener('pointerup', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y; down = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { movePage((dx > 0) === S.vertical ? 1 : -1); return; }  // 縦書き：右へはらうと次のページ
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
    const el = e.target.closest('.lpage'); if (!el || !S.sync) return;
    const rc = el.getBoundingClientRect();
    const px = (e.clientX - rc.left) / el._css, py = (e.clientY - rc.top) / el._css, pn = +el.dataset.pn;
    let best = -1, bestD = Infinity;
    S.items.forEach((it, i) => {
      for (const r of it.rects || []) {
        if (r[0] !== pn) continue;
        const d = Math.max(0, r[1] - px, px - r[3]) + Math.max(0, r[2] - py, py - r[4]);
        if (d < bestD) { bestD = d; best = i; }
      }
    });
    if (best >= 0 && bestD < 12) { S.browsing = false; seekTo(S.items[best].start); if (audio.paused) audio.play().catch(() => { }); }
  });
  stageEl.addEventListener('pointercancel', () => { down = null; });
  // キーボード（Windows、iPad のキーボード）
  document.addEventListener('keydown', (e) => {
    if (!S.open || e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    if (!$('lsMenu').hidden) { if (e.key === 'Escape') $('lsMenu').hidden = true; return; }
    if (e.key === ' ') togglePlay();
    else if (e.key === 'ArrowLeft') $(S.vertical ? 'lsNextS' : 'lsPrevS').click();
    else if (e.key === 'ArrowRight') $(S.vertical ? 'lsPrevS' : 'lsNextS').click();
    else if (e.key === 'PageDown') movePage(1);
    else if (e.key === 'PageUp') movePage(-1);
    else if (e.key === 'Escape') { if (document.body.classList.contains('lsfull')) { settings.full = false; saveSettings(); setFull(false); } else history.back(); }
    else return;
    e.preventDefault();
  });
  let rsz = 0;
  // 向きや大きさが変わったら出し直す（見ているだけのときはそのページ、そうでなければ読んでいる所のページ）
  window.addEventListener('resize', () => {
    clearTimeout(rsz);
    rsz = setTimeout(() => {
      if (!S.open || !S.pdf || S.view.start < 0) return;
      const pg = !S.browsing && S.cur >= 0 ? pageAt(S.cur, S.curChar) : S.view.start;
      showPage(pg != null ? pg : S.view.start, S.browsing);
    }, 200);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.open) savePos(true); });

  // 設定
  $('lsMenuBtn').onclick = () => { $('lsMenu').hidden = false; };
  $('lsMenuClose').onclick = () => { $('lsMenu').hidden = true; };
  $('lsMenu').addEventListener('click', (e) => { if (e.target.id === 'lsMenu') $('lsMenu').hidden = true; });
  $('lsSpeed').value = settings.speed; $('lsVol').value = settings.volume; $('lsVolN').textContent = settings.volume + '%';
  $('lsHl').value = settings.hl; $('lsSpread').value = settings.spread;
  $('lsSpeed').onchange = () => { settings.speed = $('lsSpeed').value; audio.playbackRate = parseFloat(settings.speed); saveSettings(); };
  $('lsVol').oninput = () => { settings.volume = +$('lsVol').value; audio.volume = settings.volume / 100; $('lsVolN').textContent = settings.volume + '%'; saveSettings(); };
  $('lsHl').onchange = () => { settings.hl = $('lsHl').value; saveSettings(); drawOverlays(); };
  $('lsSpread').onchange = () => { settings.spread = $('lsSpread').value; saveSettings(); if (S.view.start >= 0) showPage(S.view.start); };
  const isApple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('lsVolNote').hidden = !isApple;

  // 画面を消したときやロック画面の操作
  function setMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const t = S.manifest.tracks[S.track];
    const art = S.coverUrl ? [{ src: S.coverUrl, sizes: '512x512', type: 'image/jpeg' }] : [];
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: t.title || '', artist: S.manifest.author || '', album: S.manifest.title || S.item.title, artwork: art }); } catch (e) { }
    const h = {
      play: () => audio.play(), pause: () => audio.pause(),
      seekbackward: () => seekTo(posNow() - 15), seekforward: () => seekTo(posNow() + 30),
      previoustrack: () => $('lsPrevS').click(), nexttrack: () => $('lsNextS').click(),
    };
    for (const k in h) { try { navigator.mediaSession.setActionHandler(k, h[k]); } catch (e) { } }
  }

  // 本棚に出す「続きから」の文
  function listenProgress(item, tracks) {
    const st = loadJson('bv_listen_' + item.id, null);
    if (!st) return '未聴';
    return (tracks && tracks[st.track] ? tracks[st.track] + ' の ' : '') + fmt(st.pos) + ' から';
  }

  window.LISTEN = { bookManifest, open: openListen, close: closeListen, isOpen: () => S.open, progress: listenProgress };
})();
