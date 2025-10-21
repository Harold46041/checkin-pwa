
// ===== DB =====
const DB_NAME = 'checkin-db-v1';
const STORE_EVENTS = 'events';
const STORE_GUESTS = 'guests';
let db;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_EVENTS)) d.createObjectStore(STORE_EVENTS, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(STORE_GUESTS)) {
        const s = d.createObjectStore(STORE_GUESTS, { keyPath: 'id' });
        s.createIndex('by_event', 'eventId');
        s.createIndex('by_event_checked', ['eventId','checkedIn']);
      }
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode='readonly') { return db.transaction(store, mode).objectStore(store); }
function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// ===== State/UI refs =====
let state = { eventId: null, filterNotChecked: false, search: '' };
const els = {
  eventSelect: document.getElementById('eventSelect'),
  newEventBtn: document.getElementById('newEventBtn'),
  importCsvInput: document.getElementById('importCsvInput'),
  exportCsvBtn: document.getElementById('exportCsvBtn'),
  scanQrBtn: document.getElementById('scanQrBtn'),
  showNotCheckedBtn: document.getElementById('showNotCheckedBtn'),
  list: document.getElementById('list'),
  search: document.getElementById('searchInput'),
  clearSearchBtn: document.getElementById('clearSearchBtn'),
  totalCount: document.getElementById('totalCount'),
  checkedCount: document.getElementById('checkedCount'),
  remainingCount: document.getElementById('remainingCount'),
  // sig
  sigDialog: document.getElementById('sigDialog'),
  sigCanvas: document.getElementById('sigCanvas'),
  sigSave: document.getElementById('sigSave'),
  sigClear: document.getElementById('sigClear'),
  sigClose: document.getElementById('sigClose'),
  // edit
  editDialog: document.getElementById('editDialog'),
  editName: document.getElementById('editName'),
  editEmail: document.getElementById('editEmail'),
  editPhone: document.getElementById('editPhone'),
  editSave: document.getElementById('editSave'),
  editDelete: document.getElementById('editDelete'),
  editClose: document.getElementById('editClose'),
  // qr
  qrDialog: document.getElementById('qrDialog'),
  qrVideo: document.getElementById('qrVideo'),
  qrClose: document.getElementById('qrClose'),
  qrStatus: document.getElementById('qrStatus'),
};

// ===== Signature pad =====
let sigCtx, drawing = false, sigForGuestId = null;
function initSignaturePad() {
  const scaleCanvas = () => {
    const ratio = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    els.sigCanvas.width = els.sigCanvas.clientWidth * ratio;
    els.sigCanvas.height = els.sigCanvas.clientHeight * ratio;
    sigCtx = els.sigCanvas.getContext('2d');
    sigCtx.scale(ratio, ratio);
    sigCtx.fillStyle = '#fff';
    sigCtx.fillRect(0,0,els.sigCanvas.clientWidth, els.sigCanvas.clientHeight);
    sigCtx.lineWidth = 2.5;
    sigCtx.lineCap = 'round';
    sigCtx.strokeStyle = '#000';
  };
  scaleCanvas();
  window.addEventListener('resize', scaleCanvas);

  const getPos = e => {
    const rect = els.sigCanvas.getBoundingClientRect();
    const pt = e.touches && e.touches[0] ? e.touches[0] : e;
    return { x: pt.clientX - rect.left, y: pt.clientY - rect.top };
  };
  const start = e => { drawing = true; const p = getPos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y); e.preventDefault(); };
  const move = e => { if (!drawing) return; const p = getPos(e); sigCtx.lineTo(p.x, p.y); sigCtx.stroke(); e.preventDefault(); };
  const end = () => { drawing = false; };

  ['pointerdown','mousedown','touchstart'].forEach(evt => els.sigCanvas.addEventListener(evt, start, {passive:false}));
  ['pointermove','mousemove','touchmove'].forEach(evt => els.sigCanvas.addEventListener(evt, move, {passive:false}));
  ['pointerup','mouseup','mouseleave','touchend','touchcancel'].forEach(evt => els.sigCanvas.addEventListener(evt, end));

  els.sigClear.addEventListener('click', () => scaleCanvas());
  els.sigSave.addEventListener('click', async () => {
    if (!sigForGuestId) return;
    els.sigCanvas.toBlob(async blob => {
      const dataUrl = await blobToDataURL(blob);
      const g = await getGuest(sigForGuestId);
      g.signature = dataUrl;
      await putGuest(g);
      els.sigDialog.close();
      render();
    });
  });
  els.sigClose.addEventListener('click', ()=> els.sigDialog.close());
}
function openSignature(guestId) {
  sigForGuestId = guestId;
  // reset clean canvas
  const evt = new Event('resize');
  window.dispatchEvent(evt);
  els.sigDialog.showModal();
}

// ===== QR scanning =====
let mediaStream = null, detector = null, qrTickHandle = null;
async function openQr() {
  els.qrStatus.textContent = 'Point camera at code…';
  els.qrDialog.showModal();
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    els.qrVideo.srcObject = mediaStream;
    await els.qrVideo.play();
    if ('BarcodeDetector' in window) {
      detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      qrDetectLoop();
    } else {
      els.qrStatus.textContent = 'BarcodeDetector not supported. Update iOS or use manual search.';
    }
  } catch (e) {
    els.qrStatus.textContent = 'Camera access denied.';
  }
}
async function qrDetectLoop() {
  const draw = async () => {
    try {
      const codes = await detector.detect(els.qrVideo);
      if (codes && codes[0]) {
        const raw = codes[0].rawValue.trim();
        els.qrStatus.textContent = 'Scanned: ' + raw;
        handleQrPayload(raw);
      }
    } catch (e) {}
    qrTickHandle = requestAnimationFrame(draw);
  };
  draw();
}
function closeQr() {
  if (qrTickHandle) cancelAnimationFrame(qrTickHandle);
  if (mediaStream) mediaStream.getTracks().forEach(t=>t.stop());
  els.qrDialog.close();
}
els.qrClose.addEventListener('click', closeQr);
function handleQrPayload(text) {
  const parts = new URLSearchParams(text);
  const tryId = parts.get('id') || null;
  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const name = parts.get('name') || null;
  const find = async () => {
    let guest = null;
    if (tryId) guest = await getGuest(tryId);
    if (!guest && emailMatch) guest = await findGuestBy((g)=> g.email && g.email.toLowerCase()===emailMatch[0].toLowerCase());
    if (!guest && name) {
      const n = name.toLowerCase();
      guest = await findGuestBy((g)=> (g.name||'').toLowerCase()===n);
    }
    if (!guest) {
      const s = text.toLowerCase();
      guest = await findGuestBy((g)=> (g.name||'').toLowerCase().includes(s) || (g.email||'').toLowerCase().includes(s) || (g.id||'').toLowerCase().includes(s));
    }
    if (guest) {
      await toggleCheckin(guest.id, true);
      els.qrStatus.textContent = `Checked in: ${guest.name||guest.email||guest.id}`;
      setTimeout(()=>closeQr(), 800);
    } else {
      els.qrStatus.textContent = 'No matching guest found for QR.';
    }
  };
  find();
}

// ===== Data ops =====
async function listEvents() { return new Promise((resolve,reject)=>{ const req = tx(STORE_EVENTS).getAll(); req.onsuccess=()=>resolve(req.result||[]); req.onerror=()=>reject(req.error); }); }
async function putEvent(ev) { return new Promise((resolve)=>{ tx(STORE_EVENTS,'readwrite').put(ev).onsuccess=()=>resolve(ev); }); }
async function getGuestsByEvent(eventId) { return new Promise((resolve,reject)=>{ const idx = tx(STORE_GUESTS).index('by_event'); const req = idx.getAll(eventId); req.onsuccess=()=>resolve(req.result||[]); req.onerror=()=>reject(req.error); }); }
async function getGuest(id) { return new Promise((resolve,reject)=>{ const req = tx(STORE_GUESTS).get(id); req.onsuccess=()=>resolve(req.result||null); req.onerror=()=>reject(req.error); }); }
async function putGuest(g) { return new Promise((resolve)=>{ tx(STORE_GUESTS,'readwrite').put(g).onsuccess=()=>resolve(g); }); }
async function bulkPutGuests(arr) { return new Promise((resolve)=>{ const s = tx(STORE_GUESTS,'readwrite'); let n=0; arr.forEach(g=>{ const r=s.put(g); r.onsuccess=()=>{ if (++n===arr.length) resolve(); }; }); }); }
async function findGuestBy(predicate) { const all = await getGuestsByEvent(state.eventId); return all.find(predicate) || null; }
async function toggleCheckin(guestId, force=true) { const g=await getGuest(guestId); if (!g) return; g.checkedIn = force ? true : !g.checkedIn; g.checkInTime = g.checkedIn ? (new Date()).toISOString() : null; await putGuest(g); render(); }

// ===== CSV helpers =====
function norm(s='') { return String(s||'').trim().toLowerCase(); }
function mapHeaders(headers) {
  const idx = {};
  const find = (names) => {
    for (let i=0;i<headers.length;i++) {
      const h = norm(headers[i]);
      if (names.includes(h)) return i;
    }
    return -1;
  };
  idx.id = find(['id','guest id','guestid']);
  idx.name = find(['name','full name','fullname']);
  idx.first = find(['firstname','first name','first','fname','given','givenname']);
  idx.last = find(['lastname','last name','last','lname','surname','family name','familyname']);
  idx.email = find(['email','e-mail','mail']);
  idx.phone = find(['phone','phone number','phonenumber','mobile','cell','cellphone','telephone','tel']);
  idx.checked = find(['checkedin','checked in','attended','present','checked']);
  idx.checktime = find(['checkintime','check in time','timestamp','time']);
  return idx;
}
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const rows = [];
  for (let line of lines) {
    if (line.trim() === '') continue;
    const cells = [];
    let cur = '', inQ = false;
    for (let i=0;i<line.length;i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i+1] === '"') { cur += '"'; i++; }
          else { inQ = false; }
        } else { cur += ch; }
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { cells.push(cur); cur=''; }
        else { cur += ch; }
      }
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}
function toCSV(rows) {
  const esc = (v='') => {
    v = String(v ?? '');
    if (v.includes('"') || v.includes(',') || v.includes('\n')) {
      return '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
  };
  return rows.map(r => r.map(esc).join(',')).join('\n');
}
function truthy(v) {
  const s = norm(v);
  return ['yes','y','true','1','checked','present','attended'].includes(s);
}

async function importCSV(file, eventName) {
  const text = await file.text();
  const rows = parseCSV(text);
  if (rows.length === 0) return;
  const headers = rows[0];
  const map = mapHeaders(headers);

  const eventId = uid();
  const ev = { id: eventId, name: eventName || (file.name.replace(/\.csv$/i,'')), createdAt: new Date().toISOString() };
  await putEvent(ev);

  const guests = [];
  for (let i=1;i<rows.length;i++) {
    const r = rows[i];
    if (!r || r.length===0) continue;
    const id = (map.id>=0 && r[map.id]) ? r[map.id] : uid();
    let name = (map.name>=0 ? r[map.name] : '').trim();
    const first = map.first>=0 ? r[map.first].trim() : '';
    const last  = map.last>=0  ? r[map.last].trim()  : '';
    if (!name && (first || last)) name = (first + ' ' + last).trim();

    const g = {
      id, eventId,
      name,
      email: map.email>=0 ? r[map.email] : '',
      phone: map.phone>=0 ? r[map.phone] : '',
      checkedIn: map.checked>=0 ? truthy(r[map.checked]) : false,
      checkInTime: map.checktime>=0 && r[map.checktime] ? new Date(r[map.checktime]).toISOString() : null,
      signature: null
    };
    guests.push(g);
  }
  await bulkPutGuests(guests);
  await refreshEventsSelect(eventId);
  render();
  alert(`Imported ${guests.length} guests into "${ev.name}".`);
}

async function exportCSV() {
  if (!state.eventId) return;
  const guests = await getGuestsByEvent(state.eventId);
  const evs = await listEvents();
  const ev = evs.find(e => e.id===state.eventId);
  const rows = [['id','name','email','phone','checked_in','check_in_time','signature_data_url']];
  for (const g of guests) rows.push([g.id, g.name, g.email, g.phone, g.checkedIn ? 'yes':'no', g.checkInTime || '', g.signature || '']);
  const csv = toCSV(rows);
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${(ev?.name||'event')}-checkins.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// ===== Render + Edit =====
let editGuestId = null;
async function render() {
  if (!state.eventId) {
    els.list.innerHTML = '<div class="meta">Create or select an event to begin.</div>';
    els.totalCount.textContent = '0'; els.checkedCount.textContent = '0'; els.remainingCount.textContent = '0'; return;
  }
  const guests = await getGuestsByEvent(state.eventId);
  const filtered = guests.filter(g => {
    const s = state.search.trim().toLowerCase();
    const match = !s || (g.name||'').toLowerCase().includes(s) || (g.email||'').toLowerCase().includes(s) || (g.phone||'').toLowerCase().includes(s);
    const chk = !state.filterNotChecked || !g.checkedIn;
    return match && chk;
  });
  const checked = guests.filter(g => g.checkedIn).length;
  els.totalCount.textContent = String(guests.length);
  els.checkedCount.textContent = String(checked);
  els.remainingCount.textContent = String(guests.length - checked);

  els.list.innerHTML = '';
  for (const g of filtered) {
    const card = document.createElement('div'); card.className = 'card';
    const left = document.createElement('div');
    const title = document.createElement('div');
    title.innerHTML = `<strong>${g.name || '(No name)'}</strong> ${g.checkedIn ? '<span class="badge">Checked-In</span>' : '<span class="badge gray">Not checked</span>'}`;
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = [g.email, g.phone, g.checkInTime ? new Date(g.checkInTime).toLocaleString() : ''].filter(Boolean).join(' · ');
    left.appendChild(title); left.appendChild(meta);

    const actions = document.createElement('div'); actions.className = 'actions';
    const btn = document.createElement('button'); btn.className = 'checkin' + (g.checkedIn ? ' uncheck' : ''); btn.textContent = g.checkedIn ? 'Undo' : 'Check In'; btn.addEventListener('click', () => toggleCheckin(g.id, !g.checkedIn));
    const sigBtn = document.createElement('button'); sigBtn.className = 'btn ghost'; sigBtn.textContent = g.signature ? 'Re-sign' : 'Sign'; sigBtn.addEventListener('click', () => openSignature(g.id));
    const editBtn = document.createElement('button'); editBtn.className = 'btn ghost'; editBtn.textContent = 'Edit'; editBtn.addEventListener('click', ()=> openEdit(g.id));
    actions.appendChild(editBtn);
    if (g.signature) {
      const viewBtn = document.createElement('button'); viewBtn.className = 'btn ghost'; viewBtn.textContent = 'View Sig'; viewBtn.addEventListener('click', ()=> window.open(g.signature, '_blank'));
      actions.appendChild(viewBtn);
    }
    actions.appendChild(sigBtn);
    actions.appendChild(btn);

    card.appendChild(left); card.appendChild(actions); els.list.appendChild(card);
  }
}

async function openEdit(id) {
  editGuestId = id;
  const g = await getGuest(id);
  els.editName.value = g.name || '';
  els.editEmail.value = g.email || '';
  els.editPhone.value = g.phone || '';
  els.editDialog.showModal();
}
els.editSave.addEventListener('click', async ()=>{
  if (!editGuestId) return;
  const g = await getGuest(editGuestId);
  g.name = els.editName.value.trim();
  g.email = els.editEmail.value.trim();
  g.phone = els.editPhone.value.trim();
  await putGuest(g);
  els.editDialog.close();
  render();
});
els.editDelete.addEventListener('click', async ()=>{
  if (!editGuestId) return;
  const t = db.transaction(STORE_GUESTS,'readwrite');
  t.objectStore(STORE_GUESTS).delete(editGuestId).onsuccess = ()=>{ els.editDialog.close(); render(); };
});
els.editClose.addEventListener('click', ()=> els.editDialog.close());

// ===== Events/UI =====
async function refreshEventsSelect(selectId=null) {
  const events = await listEvents();
  els.eventSelect.innerHTML = '';
  for (const ev of events) { const opt = document.createElement('option'); opt.value = ev.id; opt.textContent = ev.name; els.eventSelect.appendChild(opt); }
  if (events.length && !state.eventId) state.eventId = events[0].id;
  if (selectId) state.eventId = selectId;
  els.eventSelect.value = state.eventId || '';
}
async function onNewEvent() {
  const name = prompt('Name of the event?'); if (!name) return;
  const ev = { id: uid(), name, createdAt: new Date().toISOString() };
  await putEvent(ev); await refreshEventsSelect(ev.id); render();
}

els.newEventBtn.addEventListener('click', onNewEvent);
els.eventSelect.addEventListener('change', (e)=> { state.eventId = e.target.value; render(); });
els.importCsvInput.addEventListener('change', async (e)=>{
  const file = e.target.files?.[0]; if (!file) return;
  const name = prompt('Name this event (optional):', file.name.replace(/\.csv$/i,''));
  await importCSV(file, name); e.target.value = '';
});
els.exportCsvBtn.addEventListener('click', exportCSV);
els.search.addEventListener('input', (e)=> { state.search = e.target.value; render(); });
els.clearSearchBtn.addEventListener('click', ()=> { els.search.value=''; state.search=''; render(); });
els.showNotCheckedBtn.addEventListener('click', ()=>{ state.filterNotChecked = !state.filterNotChecked; els.showNotCheckedBtn.textContent = state.filterNotChecked ? 'Filter: All' : 'Filter: Not Checked-In'; render(); });
els.scanQrBtn.addEventListener('click', ()=> openQr());

openDB().then(async ()=>{ await refreshEventsSelect(); initSignaturePad(); render(); });

function blobToDataURL(blob) { return new Promise((resolve)=>{ const r = new FileReader(); r.onload = ()=> resolve(r.result); r.readAsDataURL(blob); }); }


// ====== ZIP (store) writer ======
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let i=0;i<256;i++) {
      let c = i;
      for (let j=0;j<8;j++) c = (c & 1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1);
      table[i] = c >>> 0;
    }
  }
  let crc = 0 ^ (-1);
  for (let i=0;i<buf.length;i++) crc = (crc>>>8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ (-1)) >>> 0;
}
function le16(n){ const b=new Uint8Array(2); b[0]=n&255; b[1]=(n>>>8)&255; return b; }
function le32(n){ const b=new Uint8Array(4); b[0]=n&255; b[1]=(n>>>8)&255; b[2]=(n>>>16)&255; b[3]=(n>>>24)&255; return b; }
function textBytes(s){ return new TextEncoder().encode(s); }
async function makeZip(files) {
  // files: [{name, data:Uint8Array}]
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = textBytes(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;

    // Local file header
    const lh = [
      le32(0x04034b50),     // signature
      le16(20),             // version
      le16(0),              // flags
      le16(0),              // method=store
      le16(0), le16(0),     // time, date
      le32(crc),            // CRC-32
      le32(size),           // comp size
      le32(size),           // uncomp size
      le16(nameBytes.length),
      le16(0)               // extra len
    ];
    const header = concatBytes(...lh, nameBytes);
    parts.push(header, f.data);
    const localOffset = offset;
    offset += header.length + size;

    // Central directory header
    const ch = [
      le32(0x02014b50),
      le16(20), le16(20),
      le16(0), le16(0),
      le16(0), le16(0),
      le32(crc), le32(size), le32(size),
      le16(nameBytes.length), le16(0), le16(0),
      le16(0), le16(0), le32(0),
      le32(localOffset)
    ];
    const cent = concatBytes(...ch, nameBytes);
    central.push(cent);
  }

  const centralSize = central.reduce((n, u8) => n + u8.length, 0);
  const centralOffset = offset;
  parts.push(...central);

  // EOCD
  const eocd = concatBytes(
    le32(0x06054b50),
    le16(0), le16(0),
    le16(files.length),
    le16(files.length),
    le32(centralSize),
    le32(centralOffset),
    le16(0) // comment length
  );
  parts.push(eocd);

  return new Blob(parts, {type:'application/zip'});
}
function concatBytes(...arrays) {
  const total = arrays.reduce((n,a)=> n + a.length, 0);
  const out = new Uint8Array(total);
  let o=0; for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}
function dataURLtoUint8(dataURL) {
  const [meta, b64] = dataURL.split(',');
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i=0;i<len;i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function slug(s) {
  return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}

// ====== Export ZIP (CSV+PNGs) ======
async function exportZIP() {
  if (!state.eventId) return;
  const guests = await getGuestsByEvent(state.eventId);
  const evs = await listEvents();
  const ev = evs.find(e => e.id===state.eventId);
  const rows = [['id','name','email','phone','checked_in','check_in_time','signature_file']];
  const files = [];

  for (const g of guests) {
    const baseName = (g.name && slug(g.name)) || 'guest';
    const fname = `${baseName}_${g.id}.png`;
    rows.push([g.id, g.name, g.email, g.phone, g.checkedIn ? 'yes':'no', g.checkInTime || '', g.signature ? `signatures/${fname}` : '']);
    if (g.signature) {
      const png = dataURLtoUint8(g.signature);
      files.push({name: `signatures/${fname}`, data: png});
    }
  }

  // CSV file
  const csv = toCSV(rows);
  const csvBytes = new TextEncoder().encode(csv);
  files.unshift({name: 'checkins.csv', data: csvBytes});

  const zipBlob = await makeZip(files);
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(ev?.name||'event')}-checkins.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}


// Wire up Export ZIP button
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('exportZipBtn');
  if (btn) btn.addEventListener('click', exportZIP);
});
