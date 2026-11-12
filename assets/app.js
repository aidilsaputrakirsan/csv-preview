/* CSV Preview — semuanya berjalan di browser, tidak ada data yang dikirim keluar. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 50;
  const LONG_AVG = 70;   // rata-rata panjang teks yang dianggap "kolom catatan"

  const state = {
    name: '',
    headers: [],
    rows: [],          // array of arrays (string)
    types: [],         // 'number' | 'date' | 'text'
    long: [],          // boolean per kolom: teks panjang (catatan/deskripsi)
    nums: [],          // array of arrays (number|null), sejajar dengan rows
    hidden: new Set(),
    view: [],          // indeks baris hasil filter+sort
    sort: { col: -1, dir: 1 },
    query: '',
    page: 0,
    wrap: false,       // mode "Teks penuh"
    sheetAt: -1,       // posisi baris yang dibuka di panel detail (indeks dalam view)
    rowNos: null,      // nomor baris asli di Excel per baris data (null = CSV: baris ke-r+2)
    rawNums: null,     // angka asli dari sel Excel (lebih presisi dari teks tampilannya)
    book: null,        // workbook Excel yang sedang dibuka: { name, sheets, current }
  };

  const rowNo = (r) => (state.rowNos ? state.rowNos[r] : r + 2);

  /* ===================== CSV parsing ===================== */

  function detectDelimiter(sample) {
    const cands = [',', ';', '\t', '|'];
    let best = ',', bestScore = -1;
    for (const d of cands) {
      const rows = parseCSV(sample, d).slice(0, 20);
      if (!rows.length) continue;
      const counts = rows.map((r) => r.length).sort((a, b) => a - b);
      const mode = counts[Math.floor(counts.length / 2)];
      if (mode < 2) continue;
      const consistent = counts.filter((c) => c === mode).length / counts.length;
      const score = mode * consistent;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  /** Parser RFC 4180: mendukung tanda kutip, kutip ganda dalam field, dan newline dalam field. */
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

  /* ===================== inferensi tipe ===================== */

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
    const { headers, rows, rawNums } = state;
    // Sel angka dari Excel sudah punya nilai asli; teks hanya diparse kalau tidak ada.
    const numAt = (r, c) => rawNums?.[r]?.[c] ?? toNumber(rows[r][c]);
    state.types = headers.map(() => 'text');
    state.long = headers.map(() => false);
    state.nums = rows.map(() => new Array(headers.length).fill(null));

    for (let c = 0; c < headers.length; c++) {
      let filled = 0, numeric = 0, dates = 0, chars = 0, longest = 0;
      const limit = Math.min(rows.length, 500);
      for (let r = 0; r < limit; r++) {
        const v = (rows[r][c] ?? '').trim();
        if (!v) continue;
        filled++;
        chars += v.length;
        if (v.length > longest) longest = v.length;
        if (numAt(r, c) !== null) numeric++;
        else if (DATE_RE.test(v)) dates++;
      }
      if (filled && numeric / filled >= 0.85) state.types[c] = 'number';
      else if (filled && dates / filled >= 0.85) state.types[c] = 'date';
      else if (filled && (chars / filled > LONG_AVG || longest > 160)) state.long[c] = true;

      if (state.types[c] === 'number') {
        for (let r = 0; r < rows.length; r++) state.nums[r][c] = numAt(r, c);
      }
    }
  }

  /* ===================== muat data ===================== */

  /** Muat teks CSV. */
  function load(text, name) {
    text = text.replace(/^﻿/, '');
    const delim = detectDelimiter(text.slice(0, 64 * 1024));
    const rows = parseCSV(text, delim).filter((r) => r.length > 1 || (r[0] ?? '').trim() !== '');
    if (!rows.length) return toast('Berkas kosong atau tidak bisa dibaca.');
    state.book = null;
    show(name, rows, { meta: `pemisah "${delim === '\t' ? 'Tab' : delim}"` });
  }

  /**
   * Tampilkan tabel. `rows[0]` adalah judul kolom. Dipakai bersama oleh CSV dan Excel,
   * sehingga semua fitur (cari, urut, statistik, grafik, unduh) berlaku untuk keduanya.
   */
  function show(name, rows, { meta = '', rowNos = null, raw = null, tab = 'table' } = {}) {
    const headers = rows[0].map((h, i) => (h || '').trim() || `Kolom ${i + 1}`);
    rows = rows.slice(1);
    const width = headers.length;
    for (const r of rows) { while (r.length < width) r.push(''); if (r.length > width) r.length = width; }

    Object.assign(state, {
      name, headers, rows, rowNos, rawNums: raw,
      hidden: new Set(), sort: { col: -1, dir: 1 }, query: '', page: 0, sheetAt: -1,
    });
    inferTypes();
    state.rawNums = null; // sudah disalin ke state.nums

    $('search').value = '';
    $('fileName').textContent = name;
    $('fileStats').textContent = `${fmtInt(rows.length)} baris · ${width} kolom` + (meta ? ` · ${meta}` : '');
    $('landing').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('btnNew').classList.remove('hidden');
    renderWsBar();
    buildColToggles();
    buildChartControls();
    applyFilter();
    switchTab(tab);
    window.scrollTo({ top: 0 });
  }

  const EXCEL_EXT = /\.(xlsx|xlsm|xlsb|xls|ods|fods)$/i;

  async function readFile(file) {
    if (!file) return;
    let buf;
    try { buf = await file.arrayBuffer(); } catch { return toast('Gagal membaca berkas.'); }
    // Kenali Excel dari ekstensi, atau dari isi berkas (ZIP = .xlsx/.ods, OLE = .xls lama)
    // supaya berkas yang salah nama tetap terbuka dengan benar.
    const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    const zip = b[0] === 0x50 && b[1] === 0x4b;
    const ole = b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
    if (EXCEL_EXT.test(file.name) || zip || ole) return openExcel(buf, file.name);
    load(new TextDecoder('utf-8').decode(buf), file.name);
  }

  /* ===================== Excel ===================== */

  // Pustaka SheetJS (~930 KB) baru diunduh saat pertama kali membuka Excel,
  // jadi pengguna CSV tidak ikut menanggung ukurannya.
  let XLSX = null, xlsxLoading = null;
  function loadXLSX() {
    if (XLSX) return Promise.resolve(XLSX);
    return (xlsxLoading ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'assets/vendor/xlsx.full.min.js';
      s.onload = () => { XLSX = window.XLSX; resolve(XLSX); };
      s.onerror = () => { xlsxLoading = null; s.remove(); reject(new Error('lib')); };
      document.head.appendChild(s);
    }));
  }

  async function openExcel(buf, name) {
    setBusy(`Membuka ${name}…`);
    try {
      await loadXLSX();
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r))); // beri waktu indikator tampil
      const wb = XLSX.read(buf, { type: 'array', cellNF: true });
      const date1904 = !!wb.Workbook?.WBProps?.date1904;
      const sheets = [];
      wb.SheetNames.forEach((n, i) => {
        const hidden = wb.Workbook?.Sheets?.[i]?.Hidden || 0;
        if (hidden === 2) return; // "very hidden": memang tidak untuk dilihat pengguna
        const data = parseSheet(wb.Sheets[n], date1904);
        sheets.push({ name: n, hidden: hidden === 1, data, header: data ? data.header : 0 });
      });
      const usable = sheets.filter((s) => s.data);
      if (!usable.length) return toast('Tidak ada data di berkas Excel ini — semua lembarnya kosong.');
      // buka lembar yang terakhir aktif saat berkas disimpan, kalau berisi
      const active = wb.SheetNames[wb.Workbook?.WBView?.[0]?.activeTab ?? 0];
      const first = usable.find((s) => s.name === active) || usable[0];
      state.book = { name, sheets, current: first };
      showSheet(first, 'table');
      if (usable.length > 1) toast(`Berkas ini punya ${usable.length} lembar — pilih lewat tombol “Lembar”.`);
    } catch (err) {
      const msg = String(err?.message || '');
      toast(msg === 'lib' ? 'Gagal memuat pembaca Excel. Periksa koneksi internet, lalu coba lagi.'
        : /password|encrypt/i.test(msg) ? 'Berkas ini dikunci kata sandi. Buka di Excel, hapus sandinya, lalu coba lagi.'
        : 'Berkas Excel tidak bisa dibaca. Pastikan formatnya .xlsx, .xls, atau .ods.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Ubah satu worksheet jadi grid teks. Hanya area yang berisi yang diambil (baris/kolom kosong di
   * pinggir terbuang), sel gabungan (merge) diisi nilai sel induknya, dan baris kosong dilewati
   * sambil tetap mencatat nomor baris aslinya di Excel.
   */
  function parseSheet(ws, date1904) {
    if (!ws) return null;
    const cells = [];
    let minR = Infinity, maxR = -1, minC = Infinity, maxC = -1;
    const put = (r, c, cell) => {
      const text = cellText(cell, date1904);
      if (!text.trim()) return;
      cells.push([r, c, text, cellNum(cell)]);
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      if (c < minC) minC = c; if (c > maxC) maxC = c;
    };
    for (const addr in ws) {
      if (addr[0] === '!') continue;
      const { r, c } = XLSX.utils.decode_cell(addr);
      put(r, c, ws[addr]);
    }
    for (const m of ws['!merges'] || []) {
      const top = ws[XLSX.utils.encode_cell(m.s)];
      if (!top || (m.e.r - m.s.r + 1) * (m.e.c - m.s.c + 1) > 5000) continue;
      for (let r = m.s.r; r <= m.e.r; r++)
        for (let c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) put(r, c, top);
    }
    if (!cells.length) return null;

    const W = maxC - minC + 1;
    const grid = Array.from({ length: maxR - minR + 1 }, () => new Array(W).fill(''));
    const nums = new Array(grid.length).fill(null);
    for (const [r, c, text, n] of cells) {
      grid[r - minR][c - minC] = text;
      if (n !== null) (nums[r - minR] ||= new Array(W).fill(null))[c - minC] = n;
    }
    const rows = [], rowNos = [], raw = [];
    grid.forEach((row, i) => {
      if (row.every((v) => v === '')) return;
      rows.push(row); rowNos.push(minR + i + 1); raw.push(nums[i]);
    });
    return { rows, rowNos, raw, header: guessHeader(rows) };
  }

  /** Teks sel seperti yang terlihat di Excel; tanggal dijadikan YYYY-MM-DD supaya bisa diurutkan. */
  function cellText(cell, date1904) {
    if (!cell || cell.v == null) return '';
    if (cell.t === 's') return String(cell.v);
    if (cell.t === 'n') {
      if (cell.z && XLSX.SSF.is_date(cell.z)) return excelDate(cell.v, date1904);
      // format "General" menampilkan angka panjang (NIK, no. HP) sebagai 1,23E+15 — tampilkan utuh
      if ((!cell.z || cell.z === 'General') && Number.isInteger(cell.v)) return String(cell.v);
    }
    return String(cell.w ?? cell.v).trim();
  }

  /** Angka asli sel (bukan tanggal). Persentase disamakan dengan tampilannya: 15% → 15. */
  function cellNum(cell) {
    if (!cell || cell.t !== 'n' || typeof cell.v !== 'number') return null;
    if (cell.z && XLSX.SSF.is_date(cell.z)) return null;
    return /%\s*$/.test(cell.w || '') ? cell.v * 100 : cell.v;
  }

  function excelDate(v, date1904) {
    const d = XLSX.SSF.parse_date_code(v, { date1904 });
    if (!d) return String(v);
    const p = (n) => String(n).padStart(2, '0');
    const time = d.H || d.M || d.S ? `${p(d.H)}:${p(d.M)}${d.S ? ':' + p(d.S) : ''}` : '';
    if (v < 1) return time || '00:00'; // sel berisi jam saja
    return `${d.y}-${p(d.m)}-${p(d.d)}${time ? ' ' + time : ''}`;
  }

  /**
   * Tebak baris judul kolom. Lembar Excel sering diawali judul laporan ("Rekap Penjualan 2025")
   * yang hanya mengisi satu sel; judul kolom yang sebenarnya adalah baris pertama yang terisi penuh.
   */
  function guessHeader(rows) {
    // hitung nilai yang BERBEDA: judul yang di-merge selebar tabel tetap terhitung satu
    const filled = rows.slice(0, 20).map((r) => new Set(r.filter((v) => v !== '')).size);
    const need = Math.max(2, Math.ceil(Math.max(...filled) * 0.6));
    const i = filled.findIndex((n) => n >= need);
    return i < 0 ? 0 : Math.min(i, 14);
  }

  /** Potong data lembar mulai dari baris judul kolom; buang kolom yang seluruhnya kosong. */
  function sliceSheet(data, h) {
    const rows = data.rows.slice(h);
    const keep = rows[0].map((_, c) => c).filter((c) => rows.some((r) => r[c] !== ''));
    return {
      rows: rows.map((r) => keep.map((c) => r[c])),
      raw: data.raw.slice(h + 1).map((n) => (n ? keep.map((c) => n[c]) : null)),
      rowNos: data.rowNos.slice(h + 1),
    };
  }

  function showSheet(s, tab) {
    state.book.current = s;
    const { rows, rowNos, raw } = sliceSheet(s.data, s.header);
    const skipped = s.header ? ` · judul kolom di baris ${s.data.rowNos[s.header]}` : '';
    show(state.book.name, rows, { rowNos, raw, tab, meta: `lembar “${s.name}”${skipped}` });
  }

  /** Bilah lembar kerja + pilihan baris judul kolom (hanya untuk Excel). */
  function renderWsBar() {
    const bar = $('wsBar');
    const book = state.book;
    bar.classList.toggle('hidden', !book);
    if (!book) return;

    const list = $('wsList');
    list.replaceChildren(...book.sheets.map((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ws-tab';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(s === book.current));
      btn.disabled = !s.data;
      const n = s.data ? Math.max(0, s.data.rows.length - s.header - 1) : 0;
      btn.title = s.data ? `${s.name}${s.hidden ? ' (lembar tersembunyi)' : ''} — ${fmtInt(n)} baris` : `${s.name} — kosong`;
      btn.innerHTML = `<b>${esc(s.name)}</b><small>${s.data ? fmtInt(n) : 'kosong'}</small>` +
        (s.hidden ? '<small class="ws-hid">tersembunyi</small>' : '');
      btn.addEventListener('click', () => { if (s !== book.current) showSheet(s, currentTab()); });
      return btn;
    }));
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    const s = book.current, sel = $('wsHeader');
    sel.innerHTML = s.data.rows.slice(0, 15).map((row, i) => {
      const peek = row.filter((v) => v !== '').slice(0, 3).join(' · ');
      const label = `Baris ${s.data.rowNos[i]} — ${peek.length > 42 ? peek.slice(0, 41) + '…' : peek}`;
      return `<option value="${i}">${esc(label)}</option>`;
    }).join('');
    sel.value = String(s.header);
  }

  const currentTab = () => document.querySelector('.tab.active')?.dataset.tab || 'table';

  /** Indikator "sedang membuka" di kotak unggah. */
  let dropHTML = null;
  function setBusy(msg) {
    const drop = $('drop'), line = drop.querySelector('.drop-line');
    if (msg) {
      dropHTML ??= line.innerHTML;
      line.textContent = msg;
    } else if (dropHTML !== null) {
      line.innerHTML = dropHTML; dropHTML = null;
    }
    drop.classList.toggle('busy', !!msg);
    drop.setAttribute('aria-busy', String(!!msg));
  }

  /* ===================== filter + urut ===================== */

  const visibleCols = () => state.headers.map((_, i) => i).filter((i) => !state.hidden.has(i));

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

  /* ===================== render: tabel ===================== */

  function renderTable() {
    const cols = visibleCols();
    const total = state.view.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const start = state.page * PAGE_SIZE;
    const slice = state.view.slice(start, start + PAGE_SIZE);
    const q = state.query.trim();

    // --- kepala tabel
    const tr = document.createElement('tr');
    for (const c of cols) {
      const th = document.createElement('th');
      const sorted = state.sort.col === c;
      th.className = (sorted ? 'sorted ' : '') + (state.long[c] ? 'col-long' : '');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML =
        `<span>${esc(state.headers[c])}</span>` +
        `<span class="th-type">${state.types[c] === 'number' ? '123' : state.types[c] === 'date' ? 'tgl' : 'abc'}</span>` +
        `<span class="sort-ind">${sorted ? (state.sort.dir === 1 ? '▲' : '▼') : '◆'}</span>`;
      btn.addEventListener('click', () => {
        if (state.sort.col === c) state.sort.dir = state.sort.dir === 1 ? -1 : 1;
        else state.sort = { col: c, dir: 1 };
        applyFilter();
      });
      th.appendChild(btn);
      tr.appendChild(th);
    }
    $('thead').replaceChildren(tr);

    // --- badan tabel (desktop) + kartu (layar sempit); CSS memilih yang tampil
    const tFrag = document.createDocumentFragment(), cFrag = document.createDocumentFragment();

    slice.forEach((r, k) => {
      const row = state.rows[r];
      const at = start + k;
      const tr2 = document.createElement('tr');
      tr2.addEventListener('click', () => openSheet(at));

      const card = document.createElement('div');
      card.className = 'card';
      card.addEventListener('click', () => openSheet(at));
      const idx = document.createElement('div');
      idx.className = 'card-idx';
      idx.textContent = `BARIS ${fmtInt(rowNo(r))}`;
      card.appendChild(idx);
      let cardHasLong = false;

      for (const c of cols) {
        const raw = row[c] ?? '';
        const isNum = state.types[c] === 'number' && state.nums[r][c] !== null;
        const isLong = state.long[c];
        if (isLong && raw) cardHasLong = true;

        const td = document.createElement('td');
        td.className = [isNum ? 'num' : '', isLong ? 'long col-long' : '', raw ? '' : 'nil'].filter(Boolean).join(' ');
        if (!isLong) td.title = raw;
        td.innerHTML = raw
          ? (isLong ? `<span class="clamp">${highlight(raw, q)}</span>` : highlight(raw, q))
          : '—';
        tr2.appendChild(td);

        const dl = document.createElement('dl');
        dl.className = 'card-row';
        const dt = document.createElement('dt');
        dt.textContent = state.headers[c];
        const dd = document.createElement('dd');
        dd.className = [isNum ? 'num' : '', isLong ? 'long' : '', raw ? '' : 'nil'].filter(Boolean).join(' ');
        dd.innerHTML = raw ? highlight(raw, q) : '—';
        dl.append(dt, dd);
        card.appendChild(dl);
      }
      if (cardHasLong) {
        const more = document.createElement('div');
        more.className = 'card-more';
        more.textContent = 'Baca selengkapnya →';
        card.appendChild(more);
      }
      tFrag.appendChild(tr2);
      cFrag.appendChild(card);
    });

    $('tbody').replaceChildren(tFrag);
    $('cards').replaceChildren(cFrag);

    $('empty').classList.toggle('hidden', total > 0);
    $('pageInfo').textContent = total
      ? `${fmtInt(start + 1)}–${fmtInt(Math.min(start + PAGE_SIZE, total))} dari ${fmtInt(total)} baris` +
        (state.query ? ` · disaring dari ${fmtInt(state.rows.length)}` : '')
      : '0 baris';
    $('prev').disabled = state.page === 0;
    $('next').disabled = state.page >= pages - 1;
  }

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ESC_MAP[m]);

  /** Menandai semua kemunculan kata kunci (aman: cocokkan pada teks mentah, escape per potongan). */
  function highlight(text, q) {
    if (!q) return esc(text);
    const hay = text.toLowerCase(), needle = q.toLowerCase();
    let out = '', from = 0, i = hay.indexOf(needle);
    if (i < 0) return esc(text);
    while (i > -1) {
      out += esc(text.slice(from, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>';
      from = i + q.length;
      i = hay.indexOf(needle, from);
    }
    return out + esc(text.slice(from));
  }

  /* ===================== panel detail baris ===================== */

  function openSheet(at) {
    if (at < 0 || at >= state.view.length) return;
    state.sheetAt = at;
    const r = state.view[at];
    const row = state.rows[r];
    $('sheetTitle').textContent = `Baris ${fmtInt(rowNo(r))} · ${fmtInt(at + 1)} dari ${fmtInt(state.view.length)}`;

    const frag = document.createDocumentFragment();
    for (const c of visibleCols()) {
      const raw = row[c] ?? '';
      const dt = document.createElement('dt');
      dt.textContent = state.headers[c];
      const dd = document.createElement('dd');
      const isNum = state.types[c] === 'number' && state.nums[r][c] !== null;
      dd.className = raw ? (isNum ? 'num' : '') : 'nil';
      dd.innerHTML = raw ? highlight(raw, state.query.trim()) : 'kosong';
      frag.append(dt, dd);
    }
    $('sheetBody').replaceChildren(frag);
    $('sheetBody').scrollTop = 0;
    $('sheetPrev').disabled = at === 0;
    $('sheetNext').disabled = at >= state.view.length - 1;
    $('sheet').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeSheet() {
    $('sheet').classList.add('hidden');
    document.body.style.overflow = '';
  }

  function moveSheet(step) {
    const next = state.sheetAt + step;
    if (next < 0 || next >= state.view.length) return;
    // ikut pindah halaman kalau perlu, supaya tabel di belakang tetap sinkron
    const page = Math.floor(next / PAGE_SIZE);
    if (page !== state.page) { state.page = page; renderTable(); }
    openSheet(next);
  }

  /* ===================== render: kolom ===================== */

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
      const label = type === 'number' ? 'angka' : type === 'date' ? 'tanggal' : state.long[c] ? 'teks panjang' : 'teks';

      const card = document.createElement('div');
      card.className = 'stat-card';
      let html =
        `<div class="stat-head"><h3>${esc(h)}</h3><span class="pill ${type === 'number' ? 'num' : ''}">${label}</span></div>` +
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
            `<span>Total</span><span>${fmtNum(sum)}</span></div>` + histogram(nums);
        } else html += '</div>';
      } else if (state.long[c]) {
        const lens = filled.map((v) => v.length);
        const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
        html +=
          `<span>Panjang rata-rata</span><span>${fmtNum(Math.round(avg))} huruf</span>` +
          `<span>Terpanjang</span><span>${fmtInt(Math.max(0, ...lens))} huruf</span></div>` +
          (filled.length ? `<p class="chart-note">Contoh: “${esc(filled[0].slice(0, 120))}${filled[0].length > 120 ? '…' : ''}”</p>` : '');
      } else {
        html += '</div>' + topValues(filled);
      }
      card.innerHTML = html;
      grid.appendChild(card);
    });
  }

  function histogram(sorted) {
    const min = sorted[0], max = sorted[sorted.length - 1];
    const bins = new Array(24).fill(0);
    if (max === min) bins[0] = sorted.length;
    else for (const v of sorted) bins[Math.min(23, Math.floor((v - min) / (max - min) * 24))]++;
    const peak = Math.max(...bins) || 1;
    return `<div class="spark" title="Sebaran nilai">` +
      bins.map((b) => `<i style="height:${Math.round(b / peak * 100)}%"></i>`).join('') + `</div>`;
  }

  function topValues(filled) {
    const counts = new Map();
    for (const v of filled) counts.set(v, (counts.get(v) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (!top.length) return '';
    const peak = top[0][1];
    return `<div class="bars">` + top.map(([v, n]) =>
      `<div><div class="bar-label"><b title="${esc(v)}">${esc(v)}</b><span>${fmtInt(n)}</span></div>` +
      `<div class="bar-track"><div class="bar-fill" style="width:${Math.round(n / peak * 100)}%"></div></div></div>`
    ).join('') + `</div>`;
  }

  /* ===================== render: grafik ===================== */

  function buildChartControls() {
    const x = $('chartX'), y = $('chartY');
    // kolom teks panjang tidak berguna sebagai sumbu X
    const xCols = state.headers.map((h, i) => [h, i]).filter(([, i]) => !state.long[i]);
    x.innerHTML = (xCols.length ? xCols : state.headers.map((h, i) => [h, i]))
      .map(([h, i]) => `<option value="${i}">${esc(h)}</option>`).join('');
    const numCols = state.headers.map((h, i) => [h, i]).filter(([, i]) => state.types[i] === 'number');
    y.innerHTML = numCols.length
      ? numCols.map(([h, i]) => `<option value="${i}">${esc(h)}</option>`).join('')
      : '<option value="-1">(tidak ada kolom angka)</option>';

    const firstCat = state.headers.findIndex((_, i) => state.types[i] !== 'number' && !state.long[i]);
    if (firstCat >= 0) x.value = String(firstCat);
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
      box.innerHTML = '<p class="chart-note">Tidak ada kolom angka untuk diagregasi. Pilih agregasi “Banyak baris”.</p>';
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

    if (state.types[xc] === 'number' || state.types[xc] === 'date') {
      data.sort((a, b) => a[0].localeCompare(b[0], 'id', { numeric: true }));
    } else if (data.length > 25) {
      data.sort((a, b) => b[1] - a[1]);
    }
    let note = '';
    if (data.length > 25) {
      data = data.slice(0, 25);
      note = `<p class="chart-note">Menampilkan 25 kelompok teratas dari ${fmtInt(groups.size)}.</p>`;
    }
    if (!data.length) { box.innerHTML = '<p class="chart-note">Tidak ada data untuk ditampilkan.</p>'; return; }

    box.innerHTML = svgChart(data, type) + note;
  }

  function svgChart(data, type) {
    const W = Math.max(560, data.length * 46), H = 340;
    const m = { t: 14, r: 14, b: 76, l: 66 };
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
           `<text class="axis-text" x="${m.l - 9}" y="${y + 3.5}" text-anchor="end">${esc(fmtNum(v))}</text>`;
    }
    if (type === 'bar') {
      const bw = Math.min(42, step * 0.62);
      data.forEach(([k, v], i) => {
        const cx = m.l + step * (i + 0.5), y0 = yScale(0), y1 = yScale(v);
        s += `<rect class="mark" x="${cx - bw / 2}" y="${Math.min(y0, y1)}" width="${bw}" height="${Math.max(1, Math.abs(y1 - y0))}">` +
             `<title>${esc(k)}: ${esc(fmtNum(v))}</title></rect>`;
      });
    } else {
      const pts = data.map(([, v], i) => `${m.l + step * (i + 0.5)},${yScale(v)}`);
      s += `<polyline class="line" points="${pts.join(' ')}"/>`;
      data.forEach(([k, v], i) => {
        s += `<circle class="dot" cx="${m.l + step * (i + 0.5)}" cy="${yScale(v)}" r="3"><title>${esc(k)}: ${esc(fmtNum(v))}</title></circle>`;
      });
    }
    data.forEach(([k], i) => {
      const cx = m.l + step * (i + 0.5), y = H - m.b + 16;
      const label = k.length > 16 ? k.slice(0, 15) + '…' : k;
      s += `<text class="axis-text" x="${cx}" y="${y}" text-anchor="end" transform="rotate(-38 ${cx} ${y})">${esc(label)}</text>`;
    });
    return s + '</svg>';
  }

  /* ===================== ekspor ===================== */

  const csvQuote = (v) => /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

  function currentCSV() {
    const cols = visibleCols();
    const lines = [cols.map((c) => csvQuote(state.headers[c])).join(',')];
    for (const r of state.view) lines.push(cols.map((c) => csvQuote(state.rows[r][c] ?? '')).join(','));
    return lines.join('\r\n');
  }

  function currentJSON() {
    const cols = visibleCols();
    return JSON.stringify(state.view.map((r) => {
      const o = {};
      for (const c of cols) {
        o[state.headers[c]] = state.types[c] === 'number' ? state.nums[r][c] : (state.rows[r][c] ?? '');
      }
      return o;
    }), null, 2);
  }

  /** Unduh hasil filter sebagai .xlsx; kolom angka disimpan sebagai angka sungguhan. */
  async function exportXLSX(base) {
    try { await loadXLSX(); } catch { return toast('Gagal memuat penulis Excel. Periksa koneksi internet.'); }
    const cols = visibleCols();
    const aoa = [cols.map((c) => state.headers[c])];
    for (const r of state.view) {
      aoa.push(cols.map((c) => (state.types[c] === 'number' && state.nums[r][c] !== null)
        ? state.nums[r][c] : (state.rows[r][c] ?? '')));
    }
    const wb = XLSX.utils.book_new();
    const sheetName = (state.book?.current.name || 'Data').replace(/[[\]:*?/\\]/g, '').slice(0, 31) || 'Data';
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
    XLSX.writeFile(wb, base + '-preview.xlsx');
    toast('Excel diunduh.');
  }

  function download(text, filename, mime) {
    const url = URL.createObjectURL(new Blob(['﻿' + text], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const copy = (text, ok) =>
    navigator.clipboard.writeText(text).then(() => toast(ok), () => toast('Browser menolak akses papan klip.'));

  /* ===================== utilitas ===================== */

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

  /* ===================== event ===================== */

  $('wsHeader').addEventListener('change', (e) => {
    const s = state.book?.current;
    if (!s) return;
    s.header = Number(e.target.value);
    showSheet(s, currentTab());
    toast(`Judul kolom diambil dari baris ${s.data.rowNos[s.header]}.`);
  });

  const drop = $('drop');
  drop.addEventListener('click', () => { if (!drop.classList.contains('busy')) $('file').click(); });
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); }
  });
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

  const scrollTableTop = () => $('tableWrap').scrollTo({ top: 0 });
  $('prev').addEventListener('click', () => { if (state.page > 0) { state.page--; renderTable(); scrollTableTop(); } });
  $('next').addEventListener('click', () => {
    if ((state.page + 1) * PAGE_SIZE < state.view.length) { state.page++; renderTable(); scrollTableTop(); }
  });

  $('btnWrap').addEventListener('click', () => {
    state.wrap = !state.wrap;
    $('tableWrap').classList.toggle('wrap', state.wrap);
    $('btnWrap').setAttribute('aria-pressed', String(state.wrap));
  });

  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => switchTab(t.dataset.tab));
  for (const s of ['chartX', 'chartY', 'chartAgg', 'chartType']) $(s).addEventListener('change', renderChart);

  // panel detail
  $('sheetPrev').addEventListener('click', () => moveSheet(-1));
  $('sheetNext').addEventListener('click', () => moveSheet(1));
  $('sheetCopy').addEventListener('click', () => {
    const r = state.view[state.sheetAt];
    if (r === undefined) return;
    const cols = visibleCols();
    copy(cols.map((c) => `${state.headers[c]}: ${state.rows[r][c] ?? ''}`).join('\n'), 'Baris disalin.');
  });
  $('sheet').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
  document.addEventListener('keydown', (e) => {
    if ($('sheet').classList.contains('hidden')) return;
    if (e.key === 'Escape') closeSheet();
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSheet(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSheet(-1); }
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-export]');
    if (btn) {
      let base = state.name.replace(/\.[^.]+$/, '') || 'data';
      // workbook berlembar banyak: sertakan nama lembar supaya hasil unduhan tidak tertukar
      if (state.book && state.book.sheets.length > 1) base += '-' + state.book.current.name.replace(/[\\/:*?"<>|]/g, '');
      if (btn.dataset.export === 'xlsx') exportXLSX(base);
      if (btn.dataset.export === 'csv') { download(currentCSV(), base + '-preview.csv', 'text/csv'); toast('CSV diunduh.'); }
      if (btn.dataset.export === 'json') { download(currentJSON(), base + '-preview.json', 'application/json'); toast('JSON diunduh.'); }
      if (btn.dataset.export === 'copy') copy(currentCSV(), 'Disalin ke papan klip.');
    }
    for (const d of document.querySelectorAll('.menu[open]')) if (!d.contains(e.target)) d.open = false;
  });

  /* ===================== data contoh ===================== */

  const SAMPLE = `tanggal,kota,produk,kategori,unit,harga_satuan,total,catatan
2025-01-05,Bandung,Kopi Arabika,Minuman,12,85000,1020000,"Pesanan kafe langganan di Dago. Minta giling kasar untuk tubruk, dan pengiriman pagi sebelum jam 9 karena toko buka jam 10. Sudah dikonfirmasi lewat WhatsApp oleh pemiliknya."
2025-01-06,Jakarta,Teh Melati,Minuman,30,25000,750000,"Stok reguler bulanan."
2025-01-08,Surabaya,Kopi Robusta,Minuman,18,62000,1116000,"Ada keluhan kemasan penyok pada pengiriman sebelumnya, kali ini dobel bubble wrap. Pelanggan minta foto paket sebelum dikirim sebagai bukti kondisi barang."
2025-01-11,Bandung,Roti Gandum,Makanan,42,18000,756000,
2025-01-14,Medan,Kopi Arabika,Minuman,9,85000,765000,"Pengiriman lewat kargo udara, estimasi dua hari."
2025-01-17,Jakarta,Cokelat Bar,Makanan,55,32000,1760000,"Untuk hampers Imlek. Perlu kartu ucapan terpisah dan pita merah; desain kartu dikirim pelanggan menyusul paling lambat H-3 sebelum tanggal kirim yang diminta."
2025-01-19,Yogyakarta,Teh Melati,Minuman,21,25000,525000,"Titip di warung depan kalau rumah kosong."
2025-01-22,Surabaya,Roti Gandum,Makanan,38,18000,684000,
2025-01-25,Bandung,Cokelat Bar,Makanan,27,32000,864000,"Suhu pengiriman dijaga, jangan sampai kena matahari langsung."
2025-01-28,Medan,Teh Melati,Minuman,44,25000,1100000,"Pembayaran tempo 14 hari sesuai kesepakatan awal tahun. Faktur dikirim ke email bagian keuangan, bukan ke pemilik toko, supaya tidak terlewat seperti bulan lalu."
2025-02-02,Jakarta,Kopi Arabika,Minuman,33,85000,2805000,"Order terbesar bulan ini."
2025-02-05,Yogyakarta,Roti Gandum,Makanan,16,18000,288000,
2025-02-09,Surabaya,Cokelat Bar,Makanan,61,32000,1952000,"Permintaan label kedaluwarsa dicetak ulang dengan format tanggal Indonesia."
2025-02-12,Bandung,Kopi Robusta,Minuman,24,62000,1488000,"Pelanggan baru dari rekomendasi kafe Dago; minta sampel dua varian lain untuk dicoba sebelum memutuskan langganan bulanan."
2025-02-15,Medan,Roti Gandum,Makanan,,18000,,"Jumlah unit belum dikonfirmasi, menunggu balasan pelanggan."
2025-02-18,Jakarta,Teh Melati,Minuman,52,25000,1300000,
2025-02-21,Yogyakarta,Kopi Arabika,Minuman,14,85000,1190000,"Kirim bersamaan dengan pesanan roti minggu depan agar hemat ongkir."
2025-02-24,Surabaya,Kopi Robusta,Minuman,29,62000,1798000,"Minta struk fisik dimasukkan ke dalam paket."
2025-02-27,Bandung,Teh Melati,Minuman,37,25000,925000,
2025-03-03,Medan,Cokelat Bar,Makanan,48,32000,1536000,"Rencana restock rutin tiap awal bulan; kalau stok kosong boleh diganti varian dark 70% dengan harga yang sama."`;
})();
