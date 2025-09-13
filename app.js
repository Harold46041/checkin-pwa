
const DB_NAME = 'checkin-db-v1';
const STORE_EVENTS = 'events';
const STORE_GUESTS = 'guests';

let db;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_EVENTS)) {
        d.createObjectStore(STORE_EVENTS, { keyPath: 'id' });
      }
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
  sigDialog: document.getElementById('sigDialog'),
  sigCanvas: document.getElementById('sigCanvas'),
  sigSave: document.getElementById('sigSave'),
  sigClear: document.getElementById('sigClear'),
  sigClose: document.getElementById('sigClose'),
  qrDialog: document.getElementById('qrDialog'),
  qrVideo: document.getElementById('qrVideo'),
  qrClose: document.getElementById('qrClose'),
  qrStatus: document.getElementById('qrStatus'),
};

let sigCtx, drawing = false, sigForGuestId = null;

function initSignaturePad() {
  sigCtx = els.sigCanvas.getContext('2d');
  sigCtx.fillStyle = '#fff';
  sigCtx.fillRect(0,0,els.sigCanvas.width, els.sigCanvas.height);
  sigCtx.lineWidth = 2.5;
  sigCtx.lineCap = 'round';
  sigCtx.strokeStyle = '#000';
  const pos = e => {
    const rect = els.sigCanvas.getBoundingClientRect();
    if (e.touches && e.touches[0]) e = e.touches[0];
    return { x: (e.clientX - rect.left) * (els.sigCanvas.width/rect.width),
             y: (e.clientY - rect.top) * (els.sigCanvas.height/rect.height) };
  };
  const start = e => { drawing = true; const p = pos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y); e.preventDefault(); };
  const move = e => { if (!drawing) return; const p = pos(e); sigCtx.lineTo(p.x, p.y); sigCtx.stroke(); e.preventDefault(); };
  const end = () => { drawing = false; };
  els.sigCanvas.addEventListener('pointerdown', start);
  els.sigCanvas.addEventListener('pointermove', move);
  els.sigCanvas.addEventListener('pointerup', end);
  els.sigCanvas.addEventListener('pointerleave', end);
  els.sigCanvas.addEventListener('touchstart', start, {passive:false});
  els.sigCanvas.addEventListener('touchmove', move, {passive:false});
  els.sigCanvas.addEventListener('touchend', end);
  els.sigClear.addEventListener('click', () => {
    sigCtx.fillStyle='#fff'; sigCtx.fillRect(0,0,els.sigCanvas.width, els.sigCanvas.height);
  });
  els.sigSave.addEventListener('click', async () => {
    if (!sigForGuestId) return;
    els.sigCanvas.toBlob(async (blob) => {
      const dataUrl = await blobToDataURL(blob);
      const guest = await getGuest(sigForGuestId);
      guest.signature = dataUrl;
      await putGuest(guest);
      els.sigDialog.close();
      render();
    });
  });
  els.sigClose.addEventListener('click', ()=> els.sigDialog.close());
}
function openSignature(guestId) {
  sigForGuestId = guestId;
  sigCtx.fillStyle='#fff'; sigCtx.fillRect(0,0,els.sigCanvas.width, els.sigCanvas.height);
  els.sigDialog.showModal();
}

// QR scanning
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
      guest = await findGuestBy((g)=> {
        return (g.name||'').toLowerCase().includes(s) || (g.email||'').toLowerCase().includes(s) || (g.id||'').toLowerCase().includes(s);
      });
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

// Data ops
async function listEvents() {
  return new Promise((resolve, reject) => {
    const req = tx(STORE_EVENTS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function putEvent(ev) {
  return new Promise((resolve, reject) => {
    tx(STORE_EVENTS, 'readwrite').put(ev).onsuccess = () => resolve(ev);
  });
}
async function getGuestsByEvent(eventId) {
  return new Promise((resolve, reject) => {
    const idx = tx(STORE_GUESTS).index('by_event');
    const req = idx.getAll(eventId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function getGuest(id) {
  return new Promise((resolve,reject)=>{
    const req = tx(STORE_GUESTS).get(id);
    req.onsuccess = ()=> resolve(req.result || null);
    req.onerror = ()=> reject(req.error);
  });
}
async function putGuest(g) {
  return new Promise((resolve, reject)=>{
    tx(STORE_GUESTS,'readwrite').put(g).onsuccess=()=>resolve(g);
  });
}
async function bulkPutGuests(guests) {
  return new Promise((resolve, reject)=>{
    const store = tx(STORE_GUESTS,'readwrite');
    let count = 0;
    guests.forEach(g=>{
      const r = store.put(g);
      r.onsuccess = ()=> { if (++count===guests.length) resolve(); };
    });
  });
}
async function findGuestBy(predicate) {
  const all = await getGuestsByEvent(state.eventId);
  return all.find(predicate) || null;
}
async function toggleCheckin(guestId, force=true) {
  const g = await getGuest(guestId);
  if (!g) return;
  g.checkedIn = force ? true : !g.checkedIn;
  g.checkInTime = g.checkedIn ? (new Date()).toISOString() : null;
  await putGuest(g);
  render();
}

// CSV
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
async function importCSV(file, eventName) {
  const text = await file.text();
  const rows = parseCSV(text);
  if (rows.length === 0) return;
  const headers = rows[0].map(h => h.trim().toLowerCase());
  const idx = {
    name: headers.indexOf('name'),
    email: headers.indexOf('email'),
    phone: headers.indexOf('phone'),
    id: headers.indexOf('id')
  };
  const eventId = uid();
  const ev = { id: eventId, name: eventName || (file.name.replace(/\.csv$/i,'')), createdAt: new Date().toISOString() };
  await putEvent(ev);

  const guests = [];
  for (let i=1;i<rows.length;i++) {
    const r = rows[i];
    if (!r || r.length===0) continue;
    const g = {
      id: (idx.id>=0 && r[idx.id]) ? r[idx.id] : uid(),
      eventId,
      name: idx.name>=0 ? r[idx.name] : '',
      email: idx.email>=0 ? r[idx.email] : '',
      phone: idx.phone>=0 ? r[idx.phone] : '',
      checkedIn: false,
      checkInTime: null,
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
  for (const g of guests) {
    rows.push([g.id, g.name, g.email, g.phone, g.checkedIn ? 'yes':'no', g.checkInTime || '', g.signature || '']);
  }
  const csv = toCSV(rows);
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(ev?.name||'event')}-checkins.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Render
async function render() {
  if (!state.eventId) {
    els.list.innerHTML = '<div class="meta">Create or select an event to begin.</div>';
    els.totalCount.textContent = '0';
    els.checkedCount.textContent = '0';
    els.remainingCount.textContent = '0';
    return;
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
    const card = document.createElement('div');
    card.className = 'card';
    const left = document.createElement('div');
    const title = document.createElement('div');
    title.innerHTML = `<strong>${g.name || '(No name)'}</strong> ${g.checkedIn ? '<span class="badge">Checked-In</span>' : '<span class="badge gray">Not checked</span>'}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [g.email, g.phone, g.checkInTime ? new Date(g.checkInTime).toLocaleString() : ''].filter(Boolean).join(' · ');
    left.appendChild(title);
    left.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const btn = document.createElement('button');
    btn.className = 'checkin' + (g.checkedIn ? ' uncheck' : '');
    btn.textContent = g.checkedIn ? 'Undo' : 'Check In';
    btn.addEventListener('click', () => toggleCheckin(g.id, !g.checkedIn));
    const sigBtn = document.createElement('button');
    sigBtn.className = 'btn ghost';
    sigBtn.textContent = g.signature ? 'Re-sign' : 'Sign';
    sigBtn.addEventListener('click', () => { openSignature(g.id); });

    actions.appendChild(sigBtn);
    actions.appendChild(btn);

    card.appendChild(left);
    card.appendChild(actions);
    els.list.appendChild(card);
  }
}

// Events/UI
async function refreshEventsSelect(selectId=null) {
  const events = await listEvents();
  els.eventSelect.innerHTML = '';
  for (const ev of events) {
    const opt = document.createElement('option');
    opt.value = ev.id; opt.textContent = ev.name;
    els.eventSelect.appendChild(opt);
  }
  if (events.length && !state.eventId) state.eventId = events[0].id;
  if (selectId) state.eventId = selectId;
  els.eventSelect.value = state.eventId || '';
}
async function onNewEvent() {
  const name = prompt('Name of the event?');
  if (!name) return;
  const ev = { id: uid(), name, createdAt: new Date().toISOString() };
  await putEvent(ev);
  await refreshEventsSelect(ev.id);
  render();
}
els.newEventBtn.addEventListener('click', onNewEvent);
els.eventSelect.addEventListener('change', (e)=> { state.eventId = e.target.value; render(); });

els.importCsvInput.addEventListener('change', async (e)=>{
  const file = e.target.files?.[0];
  if (!file) return;
  const name = prompt('Name this event (optional):', file.name.replace(/\.csv$/i,''));
  await importCSV(file, name);
  e.target.value = '';
});
els.exportCsvBtn.addEventListener('click', exportCSV);
els.search.addEventListener('input', (e)=> { state.search = e.target.value; render(); });
els.clearSearchBtn.addEventListener('click', ()=> { els.search.value=''; state.search=''; render(); });
els.showNotCheckedBtn.addEventListener('click', ()=>{
  state.filterNotChecked = !state.filterNotChecked;
  els.showNotCheckedBtn.textContent = state.filterNotChecked ? 'Filter: All' : 'Filter: Not Checked-In';
  render();
});
els.scanQrBtn.addEventListener('click', ()=> openQr());

openDB().then(async ()=>{
  await refreshEventsSelect();
  initSignaturePad();
  render();
});

function blobToDataURL(blob) {
  return new Promise((resolve)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(r.result);
    r.readAsDataURL(blob);
  });
}
