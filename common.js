// Shared JS across the Warehouse suite. Loaded by every app except
// Movies (fully self-contained by design — see its own header comment)
// and, for the DOM-coupled UI helpers below, Pantry (its own filter/
// autocomplete UI differs enough to keep separate).
//
// This is the single most important file for avoiding the "fix it in one
// app, forget the other eleven" trap: if a function's body is identical
// across 3+ apps, it belongs here, not copy-pasted. When you fix a bug in
// one of these functions, that fix reaches every app on the next deploy
// with zero extra work — that's the whole point of this file existing.
// Conversely, if you're about to paste a new helper into more than one
// app, stop and put it here first.
//
// Extracted 2026-08-30 (storage adapter, resizeImage) and expanded
// 2026-09 after a full duplication audit turned up ~20 more functions
// that were byte-identical across anywhere from 3 to 12 files: escapeHtml,
// fmtDate, safeUrl, normalizeAutofillUrl, linkOrText, resizeDataUrl,
// entryPhotos, closeForm/closeLightbox/closePhotoZoom/openPhotoZoom,
// openFromHash, setLoadError, allProducers, buildLinkedSelect,
// refreshProducerOptions, setupAutocomplete, starsHtml, setStars, the $
// shorthand, and checkMfaStatus. Several of these had already drifted
// into inconsistent (sometimes buggy) per-file copies before being
// unified here — see individual comments below for specifics.
//
// Deliberately NOT extracted: each app's own auth-gate DOM rendering
// (applyAuthGating/renderAuthControl) — two of twelve apps (Music,
// Pantry) gate extra page-specific UI elements the other ten don't have,
// so those two keep their own local versions; the other ten are
// identical to each other but are page-render code, not pure logic, and
// were judged lower-value to force through this file. Pantry also keeps
// its own autocomplete UI (setupAutocomplete here is the 8-app
// collection-page version only) and its own escaping helper (esc(),
// same idea as escapeHtml but a different implementation predating this
// file — not worth the churn to rename every call site for no behavior
// change). Movies is entirely separate: its own inline stylesheet, its
// own copies of everything below. If Movies ever gets migrated onto this
// shared architecture, all of this becomes directly reusable as-is.

const SUPABASE_URL = 'https://psbdjeyianlhfkgwwsvt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_fmEJD4dXEZF0elMTqgfhIg_nH-dCQn_';

const localStorageAdapter = {
  async get(key){
    const v = localStorage.getItem(key);
    if(v === null) throw new Error('not found');
    return {key, value: v};
  },
  async set(key, value){
    localStorage.setItem(key, value);
    return {key, value};
  },
  async delete(key){
    localStorage.removeItem(key);
    return {key, deleted: true};
  },
  async list(prefix){
    const keys = Object.keys(localStorage).filter(k => !prefix || k.startsWith(prefix));
    return {keys};
  }
};

let supabaseClient = null;
let supabaseInitError = null;

function makeSupabaseAdapter(){
  if(typeof window === 'undefined' || !window.supabase || !window.supabase.createClient){
    supabaseInitError = "Couldn't load the Supabase library (blocked by an ad blocker/network filter, or a connectivity issue) — showing this browser's local copy only. Entries saved from other devices won't appear until this loads successfully.";
    console.error('Warehouse:', supabaseInitError);
    return null;
  }
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  const client = supabaseClient;
  return {
    async get(key){
      const { data, error } = await client.from('kv_store').select('value').eq('key', key).maybeSingle();
      if(error) throw error;
      if(!data) throw new Error('not found');
      // keep a local mirror so the app still works offline
      try{ localStorage.setItem(key, data.value); }catch(e){}
      return {key, value: data.value};
    },
    async set(key, value){
      const { error } = await client.from('kv_store').upsert({ key, value, updated_at: new Date().toISOString() });
      if(error) throw error;
      try{ localStorage.setItem(key, value); }catch(e){}
      return {key, value};
    },
    async delete(key){
      const { error } = await client.from('kv_store').delete().eq('key', key);
      if(error) throw error;
      try{ localStorage.removeItem(key); }catch(e){}
      return {key, deleted: true};
    },
    async list(prefix){
      let query = client.from('kv_store').select('key');
      if(prefix) query = query.like('key', prefix + '%');
      const { data, error } = await query;
      if(error) throw error;
      return { keys: (data||[]).map(r => r.key) };
    },
    // Fetches every key+value under a prefix in ONE request, instead of
    // list() + a get() per key. With hundreds of entries, one-request-per-
    // entry means hundreds of sequential round trips before the page can
    // render anything — this is what was making load slow. Every app's
    // loadEntries() already guards with `if(storage.listWithValues)` and
    // falls back to the slow path otherwise, so this was silently never
    // being used by any app on this shared adapter until it was added
    // here — they'd all been running the one-request-per-entry path.
    async listWithValues(prefix){
      let query = client.from('kv_store').select('key,value');
      if(prefix) query = query.like('key', prefix + '%');
      const { data, error } = await query;
      if(error) throw error;
      const items = data || [];
      try{
        for(const row of items) localStorage.setItem(row.key, row.value);
      }catch(e){ /* localStorage full/unavailable — safe to skip */ }
      return { items: items.map(r => ({ key: r.key, value: r.value })) };
    }
  };
}

// Priority: Claude artifact storage > Supabase > localStorage
const storage = (typeof window !== 'undefined' && window.storage)
  ? window.storage
  : (makeSupabaseAdapter() || localStorageAdapter);

// Checks whether the current session has satisfied any enrolled MFA
// factor. Shared verbatim across every app — references currentUser and
// mfaSatisfied, which each app declares itself as page-level `let`s;
// this works because classic <script> tags on one page share a single
// global lexical environment, so this function (defined here, before
// each page's own script runs) still resolves those identifiers
// correctly once it's actually called, which only happens after the
// page's own script has already declared them.
async function checkMfaStatus(){
  if(!currentUser || !supabaseClient){ mfaSatisfied = true; return; }
  const { data, error } = await supabaseClient.auth.mfa.getAuthenticatorAssuranceLevel();
  mfaSatisfied = error ? true : (data.currentLevel === data.nextLevel);
}

const $ = (id) => document.getElementById(id);

function fmtDate(d){
  if(!d) return '';
  const dt = new Date(d + 'T00:00:00');
  if(isNaN(dt)) return d;
  return dt.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
}

function safeUrl(u){
  if(!u) return null;
  const s = u.trim();
  if(/^https?:\/\//i.test(s)) return s;
  return null;
}

function normalizeAutofillUrl(u){
  u = (u || '').trim();
  if(!u) return u;
  if(!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function linkOrText(text, url){
  const t = escapeHtml(text || '');
  if(!t) return '';
  const href = safeUrl(url);
  return href
    ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${t}</a>`
    : t;
}

function resizeDataUrl(dataUrl, maxDim, quality){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if(w > h && w > maxDim){ h = Math.round(h * maxDim/w); w = maxDim; }
      else if(h >= w && h > maxDim){ w = Math.round(w * maxDim/h); h = maxDim; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function entryPhotos(e){
  if(e.photos && e.photos.length) return e.photos;
  if(e.photo) return [e.photo];
  return [];
}

function closeForm(){
  $('ticket').classList.remove('open');
  resetForm();
}

function closeLightbox(){
  $('lightbox').classList.remove('open');
  currentLightboxId = null;
}

function closePhotoZoom(){
  $('photoZoom').classList.remove('open');
  $('photoZoomImg').src = '';
}

function openPhotoZoom(src){
  $('photoZoomImg').src = src;
  $('photoZoom').classList.add('open');
}

function openFromHash(){
  const id = location.hash.replace(/^#/, '');
  if(id && entries.some(e => e.id === id)){
    openLightbox(id);
    document.querySelector(`.entry[data-id="${id}"]`)?.scrollIntoView({behavior:'smooth', block:'center'});
  }
}

function setLoadError(message){
  const el = document.getElementById('loadErrorState');
  if(!el) return;
  if(message){
    el.style.display = 'block';
    el.querySelector('.msg').textContent = message;
  }else{
    el.style.display = 'none';
  }
}

function allProducers(){
  return [...new Set(entries.map(e=>e.producer).filter(Boolean))].sort();
}

function buildLinkedSelect(selectEl, options, currentId, currentLabel, newLabel){
  selectEl.innerHTML = '';
  const blankOpt = document.createElement('option');
  blankOpt.value = '';
  blankOpt.textContent = '\u2014';
  selectEl.appendChild(blankOpt);
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = newLabel;
  selectEl.appendChild(newOpt);
  let matched = false;
  options.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.name;
    if(o.id && o.id === currentId){ opt.selected = true; matched = true; }
    selectEl.appendChild(opt);
  });
  if(currentId && !matched){
    const opt = document.createElement('option');
    opt.value = currentId;
    opt.textContent = '(' + (currentLabel || 'linked entry') + ' not in list)';
    opt.selected = true;
    selectEl.appendChild(opt);
  }
}

function refreshProducerOptions(){
  const el = $('f-producer-options');
  if(el) el.dataset.options = JSON.stringify(allProducers());
}

function setupAutocomplete(inputId, listId){
  const input = $(inputId);
  const list = $(listId);

  function optionsFor(){
    try{ return JSON.parse(list.dataset.options || '[]'); }catch(e){ return []; }
  }
  function renderList(opts){
    if(opts.length === 0){ list.classList.remove('open'); list.innerHTML=''; return; }
    list.innerHTML = opts.map(o=>`<div data-val="${escapeHtml(o)}">${escapeHtml(o)}</div>`).join('');
    list.classList.add('open');
  }
  function showAll(){
    renderList(optionsFor());
    input.select();
  }
  function showFiltered(){
    const q = input.value.trim().toLowerCase();
    renderList(optionsFor().filter(o => !q || o.toLowerCase().includes(q)));
  }
  function hide(){ list.classList.remove('open'); }

  input.addEventListener('focus', showAll);
  input.addEventListener('input', showFiltered);
  input.addEventListener('blur', ()=> setTimeout(hide, 150));
  list.addEventListener('mousedown', (e)=>{
    const opt = e.target.closest('[data-val]');
    if(!opt) return;
    input.value = opt.dataset.val;
    hide();
  });
}

function starsHtml(n){
  let s = '';
  for(let i=1;i<=5;i++) s += i<=n ? '★' : '☆';
  return s;
}

function setStars(n){
  currentStars = n;
  document.querySelectorAll('#f-stars span').forEach(s=>{
    s.classList.toggle('on', parseInt(s.dataset.v) <= n);
  });
}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

// Resizes/compresses an uploaded photo before storing it as base64 (or,
// as of the Pantry Storage migration, before uploading the bytes to
// Supabase Storage). Each app calls this with its own maxDim/quality --
// e.g. Restaurants uses 640/0.6, Pantry uses 1200/0.75 for full-size --
// so the shared function stays generic.
function resizeImage(file, maxDim, quality){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if(w > h && w > maxDim){ h = Math.round(h * maxDim/w); w = maxDim; }
        else if(h >= w && h > maxDim){ w = Math.round(w * maxDim/h); h = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
