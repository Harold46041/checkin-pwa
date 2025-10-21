
/* Minimal client check-in app with Add/Edit + signature + CSV import/export */
const STORAGE_KEY = 'checkin_clients_v2';

let clients = loadClients();
let filterText = '';

function loadClients(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  }catch(e){
    console.warn('loadClients error', e);
    return [];
  }
}

function saveClients(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clients));
  renderList();
}

function uuid(){ return (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random()); }

/* CSV helpers */
function csvToArray(text){
  // Basic CSV parser for two columns: name, email
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split(',').map(s=>s.trim().toLowerCase().replace(/"/g,''));
  const nameIdx = header.indexOf('name');
  const emailIdx = header.indexOf('email');
  const out = [];
  for(const line of lines){
    const cells = line.split(',');
    const name = (cells[nameIdx] || '').replace(/"/g,'');
    const email = (cells[emailIdx] || '').replace(/"/g,'');
    if(name || email){
      out.push({ id: uuid(), name, email, checkedIn:false, signatureUrl:null });
    }
  }
  return out;
}

function exportCsv(){
  const rows = [['name','email','checkedIn','signatureUrl']];
  clients.forEach(c => rows.push([c.name||'', c.email||'', c.checkedIn ? '1':'0', c.signatureUrl || '']));
  const csv = rows.map(r => r.map(v => '"' + String(v).replaceAll('"','""') + '"').join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'clients_export.csv';
  a.click();
}

/* Rendering */
function renderList(){
  const list = document.getElementById('list');
  list.innerHTML = '';
  let filtered = clients;
  if(filterText){
    const q = filterText.toLowerCase();
    filtered = clients.filter(c => (c.name||'').toLowerCase().includes(q) || (c.email||'').toLowerCase().includes(q));
  }
  filtered.forEach((c, idx) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div>
        <div class="name">${c.name || '(No name)'} ${!c.checkedIn ? '<span class="badges">Not checked</span>' : ''}</div>
        <div class="sub">${c.email || ''}</div>
      </div>
      <div class="actions">
        <button class="btn btn-ghost" data-edit="${idx}">Edit</button>
        <button class="btn" data-sign="${idx}">Sign</button>
        <button class="btn btn-success" data-checkin="${idx}">${c.checkedIn ? 'Undo' : 'Check In'}</button>
      </div>
    `;
    row.querySelector('[data-edit]').onclick = () => openClientModal('edit', idx);
    row.querySelector('[data-sign]').onclick = () => openSignature(idx);
    row.querySelector('[data-checkin]').onclick = () => { c.checkedIn = !c.checkedIn; saveClients(); };
    list.appendChild(row);
  });

  // stats
  document.getElementById('stats-total').textContent = String(clients.length);
  const checked = clients.filter(c=>c.checkedIn).length;
  document.getElementById('stats-checked').textContent = String(checked);
  document.getElementById('stats-remaining').textContent = String(clients.length - checked);
}

/* Modal (Add/Edit) */
let modalMode = 'add';
let editIndex = null;

function openClientModal(mode, index=null){
  modalMode = mode;
  editIndex = index;
  const modal = document.getElementById('client-modal');
  const title = document.getElementById('client-modal-title');
  const nameEl = document.getElementById('client-name');
  const emailEl = document.getElementById('client-email');
  if(mode === 'edit' && index != null){
    title.textContent = 'Edit Client';
    nameEl.value = clients[index].name || '';
    emailEl.value = clients[index].email || '';
  }else{
    title.textContent = 'Add Client';
    nameEl.value = '';
    emailEl.value = '';
  }
  modal.classList.remove('hidden');
}

function closeClientModal(){
  document.getElementById('client-modal').classList.add('hidden');
}

function saveClientModal(){
  const name = document.getElementById('client-name').value.trim();
  const email = document.getElementById('client-email').value.trim();
  if(!name){ alert('Name is required'); return; }

  if(modalMode === 'edit' && editIndex != null){
    clients[editIndex] = {...clients[editIndex], name, email };
  }else{
    clients.unshift({ id: uuid(), name, email, checkedIn:false, signatureUrl:null });
  }
  saveClients();
  closeClientModal();
}

/* Signature */
let sigIdx = null;
let isDrawing = false;
let lastX = 0, lastY = 0;
function openSignature(index){
  sigIdx = index;
  const m = document.getElementById('sig-modal');
  m.classList.remove('hidden');
}

function closeSignature(){
  document.getElementById('sig-modal').classList.add('hidden');
}

function setupSignature(){
  const canvas = document.getElementById('sig-canvas');
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';

  function pos(e){
    const rect = canvas.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    return {x,y};
  }

  function start(e){
    isDrawing = true;
    const p = pos(e); lastX=p.x; lastY=p.y;
  }
  function move(e){
    if(!isDrawing) return;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastX = p.x; lastY = p.y;
  }
  function end(){ isDrawing = false; }

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  canvas.addEventListener('mouseup', end);
  canvas.addEventListener('mouseleave', end);

  canvas.addEventListener('touchstart', (e)=>{ start(e); e.preventDefault(); }, {passive:false});
  canvas.addEventListener('touchmove', (e)=>{ move(e); e.preventDefault(); }, {passive:false});
  canvas.addEventListener('touchend', (e)=>{ end(); e.preventDefault(); }, {passive:false});

  document.getElementById('sig-clear').onclick = () => {
    ctx.clearRect(0,0,canvas.width, canvas.height);
  };
  document.getElementById('sig-save').onclick = () => {
    const dataUrl = canvas.toDataURL('image/png');
    if(sigIdx != null){
      clients[sigIdx].signatureUrl = dataUrl;
      saveClients();
    }
    closeSignature();
    ctx.clearRect(0,0,canvas.width, canvas.height);
  };
}

function setup(){
  // buttons
  document.getElementById('btn-import').onclick = () => document.getElementById('file-input').click();
  document.getElementById('btn-export').onclick = exportCsv;
  document.getElementById('btn-add').onclick = () => openClientModal('add');
  document.getElementById('client-cancel').onclick = closeClientModal;
  document.getElementById('client-save').onclick = saveClientModal;
  document.getElementById('search').addEventListener('input', (e)=>{ filterText = e.target.value; renderList(); });

  document.getElementById('file-input').addEventListener('change', async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const text = await file.text();
    let rows = csvToArray(text);
    // if coming from First Name/Last Name/Email format, convert
    if(rows.length === 0){
      const lines = text.split(/\r?\n/).filter(Boolean);
      if(lines.length > 1){
        const header = lines.shift().split(',').map(s=>s.trim().toLowerCase());
        const f = header.indexOf('first name');
        const l = header.indexOf('last name');
        const eidx = header.indexOf('email');
        if(f>-1 && l>-1){
          rows = lines.map(line => {
            const cells = line.split(',');
            const name = `${cells[f]||''} ${cells[l]||''}`.trim();
            const email = (cells[eidx]||'').trim();
            return { id: uuid(), name, email, checkedIn:false, signatureUrl:null };
          });
        }
      }
    }
    clients = rows;
    saveClients();
    e.target.value = '';
  });

  setupSignature();
  renderList();
}

document.addEventListener('DOMContentLoaded', setup);
