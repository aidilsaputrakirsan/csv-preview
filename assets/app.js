/* CSV Preview — semuanya berjalan di browser, tidak ada data yang dikirim keluar. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 50;

  const state = {
    name: '',
    headers: [],
    rows: [],          // array of arrays (string)
    types: [],         // 'number' | 'date' | 'text'
    nums: [],          // array of arrays (number|null) sejajar dengan rows
    hidden: new Set(),
    view: [],          // indeks baris hasil filter+sort
    sort: { col: -1, dir: 1 },
    query: '',
    page: 0,
  };

  /* ===================== CSV parsing ===================== */

  function detectDelimiter(sample) {
    const cands = [',', ';', '\t', '|'];
    let best = ',', bestScore = -1;
    for (const d of cands) {
      // hitung konsistensi jumlah kolom pada beberapa baris pertama
      const rows = parseCSV(sample, d).slice(0, 20);
      if (!rows.length) continue;
      const counts = rows.map((r) => r.length);
      const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)];
      if (mode < 2) continue;
      const consistent = counts.filter((c) => c === mode).length / counts.length;
      const score = mode * consistent;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  /** Parser RFC4180: mendukung tanda kutip, kutip ganda di dalam field, dan newline dalam field. */
  function parseCSV(text, delim) {
    const rows = [];
    let row = [], field = '', quoted = false, i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && field === '') { quoted = true; i++; continue; }
      if (c === delim) { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  /* ===================== type inference ===================== */

  const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/;

  /** Mengembalikan angka, atau null jika teks bukan angka. */
  function toNumber(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (!s) return null;
    s = s.replace(/^[-+]?\s*(rp|idr|usd|[$€£¥])\s*/i, (m) => (/^[-+]/.test(m) ? m[0] : ''))
         .replace(/\s*%$/, '').replace(/\s/g, '');
    if (!/^[-+]?[\d.,]+$/.test(s)) return null;
    const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
      // pemisah desimal = yang muncul paling akhir
      s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (lastComma > -1) {
      // "1,234" -> ribuan; "12,5" -> desimal
      s = /^[-+]?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
    } else if (/^[-+]?\d{1,3}(\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, ''); // "85.000" -> ribuan gaya Indonesia
    }
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  }

  function inferTypes() {
    const { headers, rows } = state;
    state.types = headers.map(() => 'text');
    state.nums = rows.map(() => new Array(headers.length).fill(null));

    for (let c = 0; c < headers.length; c++) {
      let filled = 0, numeric = 0, dates = 0;
      const limit = Math.min(rows.length, 500);
      for (let r = 0; r < limit; r++) {
        const v = (rows[r][c] ?? '').trim();
        if (!v) continue;
        filled++;
        if (toNumber(v) !== null) numeric++;
        else if (DATE_RE.test(v)) dates++;
      }
      if (filled && numeric / filled >= 0.85) state.types[c] = 'number';
      else if (filled && dates / filled >= 0.85) state.types[c] = 'date';
      if (state.types[c] === 'number') {
        for (let r = 0; r < rows.length; r++) state.nums[r][c] = toNumber(rows[r][c]);
      }
    }
  }

  /* ===================== load ===================== */

  function load(text, name) {
    text = text.replace(/^﻿/, '');
    const delim = detectDelimiter(text.slice(0, 64 * 1024));
    let rows = parseCSV(text, delim).filter((r) => r.length > 1 || (r[0] ?? '').trim() !== '');
    if (!rows.length) return toast('File kosong atau tidak bisa dibaca.');

    const headers = rows[0].map((h, i) => (h || '').trim() || `Kolom ${i + 1}`);
    rows = rows.slice(1);
    const width = headers.length;
    for (const r of rows) { while (r.length < width) r.push(''); if (r.length > width) r.length = width; }

    Object.assign(state, {
      name, headers, rows, hidden: new Set(), sort: { col: -1, dir: 1 }, query: '', page: 0,
    });
    inferTypes();

    $('search').value = '';
    $('fileName').textContent = name;
    $('fileStats').textContent =
      `${fmtInt(rows.length)} baris · ${width} kolom · pemisah "${delim === '\t' ? 'Tab' : delim}"`;
    $('landing').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('btnNew').classList.remove('hidden');
    buildColToggles();
    buildChartControls();
    applyFilter();
    switchTab('table');
    window.scrollTo({ top: 0 });
  }

  function readFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => toast('Gagal membaca file.');
    reader.onload = () => load(String(reader.result), file.name);
    reader.readAsText(file, 'utf-8');
  }

  /* ===================== filter + sort ===================== */

  function applyFilter() {
    const q = state.query.trim().toLowerCase();
    const cols = visibleCols();
    const view = [];
    for (let r = 0; r < state.rows.length; r++) {
      if (!q) { view.push(r); continue; }
      const row = state.rows[r];
      for (const c of cols) {
        if ((row[c] ?? '').toLowerCase().includes(q)) { view.push(r); break; }
      }
    }
    const { col, dir } = state.sort;
    if (col >= 0) {
      const isNum = state.types[col] === 'number';
      view.sort((a, b) => {
        if (isNum) {
          const x = state.nums[a][col], y = state.nums[b][col];
          if (x === null && y === null) return 0;
          if (x === null) return 1;
          if (y === null) return -1;
          return (x - y) * dir;
        }
        const x = state.rows[a][col] ?? '', y = state.rows[b][col] ?? '';
        if (!x && !y) return 0;
        if (!x) return 1;
        if (!y) return -1;
        return x.localeCompare(y, 'id', { numeric: true, sensitivity: 'base' }) * dir;
      });
    }
    state.view = view;
    state.page = Math.min(state.page, Math.max(0, Math.ceil(view.length / PAGE_SIZE) - 1));
    renderTable();
  }

  const visibleCols = () => state.headers.map((_, i) => i).filter((i) => !state.hidden.has(i));

  /* ===================== render: table ===================== */

  function renderTable() {
    const cols = visibleCols();
    const total = state.view.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const start = state.page * PAGE_SIZE;
    const slice = state.view.slice(start, start + PAGE_SIZE);

    // header
    const thead = $('thead');
    thead.innerHTML = '';
    const tr = document.createElement('tr');
    for (const c of cols) {
      const th = document.createElement('th');
      const sorted = state.sort.col === c;
      if (sorted) th.className = 'sorted';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML =
        `<span>${esc(state.headers[c])}</span>` +
        `<span class="th-type">${state.types[c] === 'number' ? '123' : state.types[c] === 'date' ? 'tgl' : 'abc'}</span>` +
        `<span class="sort-ind">${sorted ? (state.sort.dir === 1 ? '▲' : '▼') : '↕'}</span>`;
      btn.addEventListener('click', () => {
        if (state.sort.col === c) state.sort.dir = state.sort.dir === 1 ? -1 : 1;
        else state.sort = { col: c, dir: 1 };
        applyFilter();
      });
      th.appendChild(btn);
      tr.appendChild(th);
    }
    thead.appendChild(tr);

    // body (desktop) + cards (mobile) — dibangun sekaligus, CSS memilih yang tampil
    const tbody = $('tbody'), cards = $('cards');
    const tFrag = document.createDocumentFragment(), cFrag = document.createDocumentFragment();
    const q = state.query.trim();

    for (const r of slice) {
      const row = state.rows[r];
      const tr2 = document.createElement('tr');
      const card = document.createElement('div');
      card.className = 'card';
      const idx = document.createElement('div');
      idx.className = 'card-idx';
      idx.textContent = `BARIS ${fmtInt(r + 2)}`;
      card.appendChild(idx);

      for (const c of cols) {
        const raw = row[c] ?? '';
        const isNum = state.types[c] === 'number' && state.nums[r][c] !== null;
        const td = document.createElement('td');
        if (isNum) td.className = 'num';
        else if (!raw) td.className = 'empty-cell';
        td.title = raw;
        td.innerHTML = raw ? highlight(raw, q) : '—';
        tr2.appendChild(td);

        const dl = document.createElement('dl');
        dl.className = 'card-row';
        const dt = document.createElement('dt');
        dt.textContent = state.headers[c];
        const dd = document.createElement('dd');
        if (isNum) dd.className = 'num';
        dd.innerHTML = raw ? highlight(raw, q) : '<span class="muted">—</span>';
        dl.append(dt, dd);
        card.appendChild(dl);
      }
      tFrag.appendChild(tr2);
      cFrag.appendChild(card);
    }
    tbody.replaceChildren(tFrag);
    cards.replaceChildren(cFrag);

    $('empty').classList.toggle('hidden', total > 0);
    $('pageInfo').textContent = total
      ? `${fmtInt(start + 1)}–${fmtInt(Math.min(start + PAGE_SIZE, total))} dari ${fmtInt(total)} baris` +
        (state.query ? ` (difilter dari ${fmtInt(state.rows.length)})` : '')
      : '0 baris';
    $('prev').disabled = state.page === 0;
    $('next').disabled = state.page >= pages - 1;
  }

  function highlight(text, q) {
    const s = esc(text);
    if (!q) return s;
    const i = s.toLowerCase().indexOf(esc(q).toLowerCase());
    if (i < 0) return s;
    const len = esc(q).length;
    return s.slice(0, i) + '<mark>' + s.slice(i, i + len) + '</mark>' + s.slice(i + len);
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

  /* ===================== render: stats ===================== */

  function renderStats() {
    const grid = $('statGrid');
    grid.innerHTML = '';
    const rows = state.rows;

    state.headers.forEach((h, c) => {
      const values = rows.map((r) => (r[c] ?? '').trim());
      const filled = values.filter((v) => v !== '');
      const missing = values.length - filled.length;
      const uniq = new Set(filled).size;
      const type = state.types[c];

      const card = document.createElement('div');
      card.className = 'stat-card';
      const pill = type === 'number' ? 'num' : '';
      const label = type === 'number' ? 'angka' : type === 'date' ? 'tanggal' : 'teks';
      let html =
        `<div class="stat-head"><h3>${esc(h)}</h3><span class="pill ${pill}">${label}</span></div>` +
        `<div class="kv">` +
        `<span>Terisi</span><span>${fmtInt(filled.length)}</span>` +
        `<span>Kosong</span><span>${fmtInt(missing)}${values.length ? ` (${Math.round(missing / values.length * 100)}%)` : ''}</span>` +
        `<span>Nilai unik</span><span>${fmtInt(uniq)}</span>`;

      if (type === 'number') {
        const nums = rows.map((_, r) => state.nums[r][c]).filter((v) => v !== null).sort((a, b) => a - b);
        if (nums.length) {
          const sum = nums.reduce((a, b) => a + b, 0);
          const med = nums.length % 2 ? nums[(nums.length - 1) / 2] : (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2;
          html +=
            `<span>Minimum</span><span>${fmtNum(nums[0])}</span>` +
            `<span>Maksimum</span><span>${fmtNum(nums[nums.length - 1])}</span>` +
            `<span>Rata-rata</span><span>${fmtNum(sum / nums.length)}</span>` +
            `<span>Median</span><span>${fmtNum(med)}</span>` +
            `<span>Total</span><span>${fmtNum(sum)}</span></div>`;
          html += histogram(nums);
        } else html += '</div>';
      } else {
        html += '</div>' + topValues(filled);
      }
      card.innerHTML = html;
      grid.appendChild(card);
    });
  }

  function histogram(sorted) {
    const min = sorted[0], max = sorted[sorted.length - 1];
    const bins = new Array(20).fill(0);
    if (max === min) bins[0] = sorted.length;
    else for (const v of sorted) bins[Math.min(19, Math.floor((v - min) / (max - min) * 20))]++;
    const peak = Math.max(...bins) || 1;
    return `<div class="spark" title="Distribusi nilai">` +
      bins.map((b) => `<i style="height:${Math.round(b / peak * 100)}%"></i>`).join('') + `</div>`;
  }

  function topValues(filled) {
    const counts = new Map();
    for (const v of filled) counts.set(v, (counts.get(v) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (!top.length) return '';
    const peak = top[0][1];
    return `<div class="bars">` + top.map(([v, n]) =>
      `<div class="bar-row"><div class="bar-label"><b title="${esc(v)}">${esc(v)}</b><span class="muted">${fmtInt(n)}</span></div>` +
      `<div class="bar-track"><div class="bar-fill" style="width:${Math.round(n / peak * 100)}%"></div></div></div>`
    ).join('') + `</div>`;
  }

  /* ===================== render: chart ===================== */

  function buildChartControls() {
    const x = $('chartX'), y = $('chartY');
    x.innerHTML = state.headers.map((h, i) => `<option value="${i}">${esc(h)}</option>`).join('');
    const numCols = state.headers.map((h, i) => [h, i]).filter(([, i]) => state.types[i] === 'number');
    y.innerHTML = numCols.length
      ? numCols.map(([h, i]) => `<option value="${i}">${esc(h)}</option>`).join('')
      : '<option value="-1">(tidak ada kolom angka)</option>';

    const firstCat = state.headers.findIndex((_, i) => state.types[i] !== 'number');
    x.value = String(firstCat >= 0 ? firstCat : 0);
    if (!numCols.length) $('chartAgg').value = 'count';
  }

  function renderChart() {
    const box = $('chartBox');
    const xc = Number($('chartX').value);
    const yc = Number($('chartY').value);
    const agg = $('chartAgg').value;
    const type = $('chartType').value;
    if (!state.headers.length || Number.isNaN(xc)) return;
    if (agg !== 'count' && yc < 0) {
      box.innerHTML = '<p class="muted">Tidak ada kolom angka untuk diagregasi. Pilih agregasi "Banyak baris".</p>';
      return;
    }

    const groups = new Map();
    for (const r of state.view) {
      const key = (state.rows[r][xc] ?? '').trim() || '(kosong)';
      const g = groups.get(key) || { n: 0, sum: 0, min: Infinity, max: -Infinity };
      g.n++;
      if (yc >= 0) {
        const v = state.nums[r][yc];
        if (v !== null) { g.sum += v; g.min = Math.min(g.min, v); g.max = Math.max(g.max, v); }
      }
      groups.set(key, g);
    }
    let data = [...groups.entries()].map(([k, g]) => [k, ({
      sum: g.sum, avg: g.n ? g.sum / g.n : 0, count: g.n,
      min: g.min === Infinity ? 0 : g.min, max: g.max === -Infinity ? 0 : g.max,
    })[agg]]);

    if (state.types[xc] === 'number' || state.types[xc] === 'date') data.sort((a, b) => a[0].localeCompare(b[0], 'id', { numeric: true }));
    else if (data.length > 25) data.sort((a, b) => b[1] - a[1]);
    let note = '';
    if (data.length > 25) { data = data.slice(0, 25); note = `<p class="muted" style="margin:10px 0 0;font-size:12.5px">Menampilkan 25 kelompok teratas dari ${fmtInt(groups.size)}.</p>`; }
    if (!data.length) { box.innerHTML = '<p class="muted">Tidak ada data untuk ditampilkan.</p>'; return; }

    box.innerHTML = svgChart(data, type) + note;
  }

  function svgChart(data, type) {
    const W = Math.max(560, data.length * 46), H = 340;
    const m = { t: 16, r: 16, b: 74, l: 62 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const vals = data.map((d) => d[1]);
    let max = Math.max(0, ...vals), min = Math.min(0, ...vals);
    if (max === min) max = min + 1;
    const yScale = (v) => m.t + ih - ((v - min) / (max - min)) * ih;
    const step = iw / data.length;

    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMinYMid meet" style="min-width:${W}px">`;
    for (let i = 0; i <= 4; i++) {
      const v = min + (max - min) * (i / 4), y = yScale(v);
      s += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}"/>` +
           `<text class="axis-text" x="${m.l - 8}" y="${y + 4}" text-anchor="end">${esc(fmtNum(v))}</text>`;
    }
    if (type === 'bar') {
      const bw = Math.min(46, step * 0.66);
      data.forEach(([k, v], i) => {
        const cx = m.l + step * (i + 0.5);
        const y0 = yScale(0), y1 = yScale(v);
        s += `<rect class="mark" x="${cx - bw / 2}" y="${Math.min(y0, y1)}" width="${bw}" height="${Math.max(1, Math.abs(y1 - y0))}" rx="4">` +
             `<title>${esc(k)}: ${esc(fmtNum(v))}</title></rect>`;
      });
    } else {
      const pts = data.map(([, v], i) => `${m.l + step * (i + 0.5)},${yScale(v)}`);
      s += `<polyline class="line" points="${pts.join(' ')}"/>`;
      data.forEach(([k, v], i) => {
        s += `<circle class="dot" cx="${m.l + step * (i + 0.5)}" cy="${yScale(v)}" r="3.5"><title>${esc(k)}: ${esc(fmtNum(v))}</title></circle>`;
      });
    }
    data.forEach(([k], i) => {
      const cx = m.l + step * (i + 0.5);
      const label = k.length > 16 ? k.slice(0, 15) + '…' : k;
      s += `<text class="axis-text" x="${cx}" y="${H - m.b + 18}" text-anchor="end" transform="rotate(-38 ${cx} ${H - m.b + 18})">${esc(label)}</text>`;
    });
    return s + '</svg>';
  }

  /* ===================== export ===================== */

  function currentCSV() {
    const cols = visibleCols();
    const q = (v) => /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const lines = [cols.map((c) => q(state.headers[c])).join(',')];
    for (const r of state.view) lines.push(cols.map((c) => q(state.rows[r][c] ?? '')).join(','));
    return lines.join('\r\n');
  }

  function currentJSON() {
    const cols = visibleCols();
    return JSON.stringify(state.view.map((r) => {
      const o = {};
      for (const c of cols) {
        const raw = state.rows[r][c] ?? '';
        o[state.headers[c]] = state.types[c] === 'number' ? state.nums[r][c] : raw;
      }
      return o;
    }), null, 2);
  }

  function download(text, filename, mime) {
    const url = URL.createObjectURL(new Blob(['﻿' + text], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ===================== helpers ===================== */

  const fmtInt = (n) => new Intl.NumberFormat('id-ID').format(n);
  const fmtNum = (n) => Number.isInteger(n)
    ? fmtInt(n)
    : new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(n);

  let toastTimer;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function switchTab(name) {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
    for (const p of ['table', 'stats', 'chart']) $('panel-' + p).classList.toggle('hidden', p !== name);
    if (name === 'stats') renderStats();
    if (name === 'chart') renderChart();
  }

  function buildColToggles() {
    const box = $('colToggles');
    box.innerHTML = '';
    state.headers.forEach((h, i) => {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.addEventListener('change', () => {
        if (cb.checked) state.hidden.delete(i);
        else if (visibleCols().length > 1) state.hidden.add(i);
        else { cb.checked = true; toast('Minimal satu kolom harus tampil.'); return; }
        applyFilter();
      });
      label.append(cb, document.createTextNode(h));
      box.appendChild(label);
    });
  }

  /* ===================== events ===================== */

  const drop = $('drop');
  drop.addEventListener('click', () => $('file').click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
  $('file').addEventListener('change', (e) => readFile(e.target.files[0]));

  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => readFile(e.dataTransfer.files[0]));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('btnSample').addEventListener('click', () => load(SAMPLE, 'contoh-penjualan.csv'));
  $('btnPaste').addEventListener('click', () => {
    $('pasteWrap').classList.toggle('hidden');
    if (!$('pasteWrap').classList.contains('hidden')) $('pasteArea').focus();
  });
  $('btnPasteGo').addEventListener('click', () => {
    const t = $('pasteArea').value.trim();
    t ? load(t, 'tempelan.csv') : toast('Tempel dulu teks CSV-nya.');
  });
  $('btnNew').addEventListener('click', () => {
    $('app').classList.add('hidden');
    $('landing').classList.remove('hidden');
    $('btnNew').classList.add('hidden');
    $('file').value = '';
    window.scrollTo({ top: 0 });
  });

  let searchTimer;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = e.target.value; state.page = 0; applyFilter(); }, 180);
  });
  $('prev').addEventListener('click', () => { if (state.page > 0) { state.page--; renderTable(); scrollTop(); } });
  $('next').addEventListener('click', () => {
    if ((state.page + 1) * PAGE_SIZE < state.view.length) { state.page++; renderTable(); scrollTop(); }
  });
  const scrollTop = () => $('tableWrap').scrollTo({ top: 0 });

  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => switchTab(t.dataset.tab));
  for (const s of ['chartX', 'chartY', 'chartAgg', 'chartType']) $(s).addEventListener('change', renderChart);

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-export]');
    if (btn) {
      const base = state.name.replace(/\.[^.]+$/, '');
      if (btn.dataset.export === 'csv') { download(currentCSV(), base + '-preview.csv', 'text/csv'); toast('CSV diunduh.'); }
      if (btn.dataset.export === 'json') { download(currentJSON(), base + '-preview.json', 'application/json'); toast('JSON diunduh.'); }
      if (btn.dataset.export === 'copy') {
        navigator.clipboard.writeText(currentCSV()).then(() => toast('Disalin ke clipboard.'), () => toast('Browser menolak akses clipboard.'));
      }
    }
    // tutup menu dropdown saat klik di luar
    for (const d of document.querySelectorAll('.menu[open]')) if (!d.contains(e.target)) d.open = false;
  });

  // tema
  const btnTheme = $('btnTheme');
  const saved = localStorage.getItem('csvpreview-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  const paintThemeIcon = () => {
    const t = document.documentElement.dataset.theme;
    btnTheme.querySelector('[data-theme-icon]').textContent = t === 'dark' ? '☾' : t === 'light' ? '☀' : '◐';
  };
  paintThemeIcon();
  btnTheme.addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(document.documentElement.dataset.theme || 'auto') + 1) % 3];
    document.documentElement.dataset.theme = next;
    localStorage.setItem('csvpreview-theme', next);
    paintThemeIcon();
  });

  window.addEventListener('resize', () => { /* kartu & tabel sudah dirender keduanya */ });

  /* ===================== sample ===================== */

  const SAMPLE = `tanggal,kota,produk,kategori,unit,harga_satuan,total
2025-01-05,Bandung,Kopi Arabika,Minuman,12,85000,1020000
2025-01-06,Jakarta,Teh Melati,Minuman,30,25000,750000
2025-01-08,Surabaya,Kopi Robusta,Minuman,18,62000,1116000
2025-01-11,Bandung,Roti Gandum,Makanan,42,18000,756000
2025-01-14,Medan,Kopi Arabika,Minuman,9,85000,765000
2025-01-17,Jakarta,Cokelat Bar,Makanan,55,32000,1760000
2025-01-19,Yogyakarta,Teh Melati,Minuman,21,25000,525000
2025-01-22,Surabaya,Roti Gandum,Makanan,38,18000,684000
2025-01-25,Bandung,Cokelat Bar,Makanan,27,32000,864000
2025-01-28,Medan,Teh Melati,Minuman,44,25000,1100000
2025-02-02,Jakarta,Kopi Arabika,Minuman,33,85000,2805000
2025-02-05,Yogyakarta,Roti Gandum,Makanan,16,18000,288000
2025-02-09,Surabaya,Cokelat Bar,Makanan,61,32000,1952000
2025-02-12,Bandung,Kopi Robusta,Minuman,24,62000,1488000
2025-02-15,Medan,Roti Gandum,Makanan,,18000,
2025-02-18,Jakarta,Teh Melati,Minuman,52,25000,1300000
2025-02-21,Yogyakarta,Kopi Arabika,Minuman,14,85000,1190000
2025-02-24,Surabaya,Kopi Robusta,Minuman,29,62000,1798000
2025-02-27,Bandung,Teh Melati,Minuman,37,25000,925000
2025-03-03,Medan,Cokelat Bar,Makanan,48,32000,1536000`;
})();
