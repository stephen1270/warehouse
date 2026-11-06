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

// Applies the toolbar's #search box as a case-insensitive substring
// filter over `entries`. `haystackFn(entry)` returns the array of fields
// to search for that app — each app knows its own relevant fields (name,
// producer, region, a cross-linked restaurant/bakery name, etc.), so this
// stays generic. Returns { query, rawQuery, filtered } so the caller's
// render() can still handle its own count text, empty states, and sort —
// those legitimately differ per app and aren't worth forcing through here.
function applySearchFilter(entries, haystackFn){
  const rawQuery = ($('search').value || '').trim();
  const query = rawQuery.toLowerCase();
  const filtered = query ? entries.filter(e => {
    const haystack = haystackFn(e).filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(query);
  }) : entries;
  return { query, rawQuery, filtered };
}

// Reads a `q` query-string param — set by index.html's voice/text search,
// which routes a phrase like "wines from France" to wine.html?q=France —
// and pre-fills it into this app's search box (id "search" by default;
// pass an explicit id for apps like Music/Movies whose search box is
// named "filterSearch" instead). Call once, right before render(), in
// loadEntries()'s success path(s); render() still does the actual
// filtering, this just seeds the box so the page arrives already
// filtered instead of needing a second type.
function applyIncomingSearchQuery(inputId){
  try{
    const q = new URLSearchParams(location.search).get('q');
    const el = document.getElementById(inputId || 'search');
    if(q && el) el.value = q;
  }catch(e){ /* ignore */ }
}

// ---------------------------------------------------------------------------
// Store chrome: masthead, department navigation, department header details,
// and footer. Injected on every page that loads this file (plus index.html),
// so the whole suite reads as one house.
//
// Three ideas run through it:
//   - One mark per department (after Milton Glaser's "text plus one
//     coloured icon"): each department has a single flat emblem in its
//     signature colour, used in the header, the home page and the footer.
//   - The hand (after Cy Twombly's scrawled, written marks): a pencil
//     line draws itself under each department title, and the collector's
//     marginal notes are set in a pencil hand.
//   - Roles (after Cindy Sherman's staged personas): in each department
//     the collector plays a part (the Monger, the Cellarman...), named in
//     the header and on the home page's cast list.
//
// Styles live here rather than in style.css because Pantry keeps its own
// stylesheet and still gets the masthead and footer. Also tags
// <body data-dept="..."> so style.css can apply the department's colour.
// ---------------------------------------------------------------------------
const WAREHOUSE_DEPTS = {
  'pantry':      { name:'Pantry',      color:'#5e6b3a', role:'the Provisioner',  line:'Staples, oils, vinegars and the good salt.' },
  'tinned-fish': { name:'Tinned Fish', color:'#24606e', role:'the Conservero',   line:'Six hundred tins, priced, sourced and tasted.' },
  'cheese':      { name:'Cheese',      color:'#93661c', role:'the Monger',       line:'Wheels, wedges and rinds, and who made them.' },
  'charcuterie': { name:'Charcuterie', color:'#8c2f27', role:'the Curer',        line:'Salumi, terrines and the cutting board.' },
  'bread':       { name:'Bread',       color:'#85582b', role:'the Early Riser',  line:'Loaves and levains, crust and crumb.' },
  'pastry':      { name:'Pastry',      color:'#a0553b', role:'the Sweet Tooth',  line:'Croissants, danishes and tarts.' },
  'pie':         { name:'Pie',         color:'#7d2e4f', role:'the Second Slice', line:'Fruit, cream and savory pies.' },
  'bakeries':    { name:'Bakeries',    color:'#6e5236', role:'the Regular',      line:'Every bakery visited, and what came home.' },
  'wine':        { name:'Wine',        color:'#6b1f2e', role:'the Cellarman',    line:'Bottles opened, and what they were opened with.' },
  'beer':        { name:'Beer',        color:'#8a6a12', role:'the Taproom Sage', line:'Cans and bottles, style and strength.' },
  'spirits':     { name:'Spirits',     color:'#8a3a1e', role:'the Night Barman', line:'Aperitifs, digestifs and the bar cart.' },
  'restaurants': { name:'Restaurants', color:'#2f4b3a', role:'the Regular',      line:'Tables kept: dishes, bottles and notes from meals out.' },
  'music':       { name:'Music',       color:'#3e3a6b', role:'the Archivist',    line:'Vinyl and CDs, graded and priced.' },
  'movies':      { name:'Movies',      color:'#1f3b57', role:'the Projectionist',line:'DVDs and Blu-rays, by genre and director.' },
};

const WAREHOUSE_FLOORS = [
  { floor:'The Larder',    keys:['pantry','tinned-fish','cheese','charcuterie'] },
  { floor:'The Bakehouse', keys:['bread','pastry','pie','bakeries'] },
  { floor:'The Cellar',    keys:['wine','beer','spirits'] },
  { floor:'The Table',     keys:['restaurants'] },
  { floor:'The Library',   keys:['music','movies'] },
];

// Department emblems: flat, one colour (currentColor) on a 64-unit grid,
// with paper-coloured cut-outs. Original drawings.
const WAREHOUSE_EMBLEMS = {
  'pantry': '<rect x="18" y="10" width="28" height="8" rx="2"/><path d="M16 22h32v28a6 6 0 0 1-6 6H22a6 6 0 0 1-6-6z"/><rect x="22" y="32" width="20" height="12" fill="var(--wh-cut,#fbf8f2)"/>',
  'tinned-fish': '<rect x="6" y="16" width="52" height="32" rx="16"/><path d="M17 32c6-7 17-8 26-3l6-4-1.5 7 1.5 7-6-4c-9 5-20 4-26-3z" fill="var(--wh-cut,#fbf8f2)"/><circle cx="23" cy="31" r="1.6"/>',
  'cheese': '<path d="M6 46 L40 14 L58 30 V50 H6 Z"/><circle cx="22" cy="40" r="4" fill="var(--wh-cut,#fbf8f2)"/><circle cx="38" cy="33" r="3" fill="var(--wh-cut,#fbf8f2)"/><circle cx="47" cy="43" r="2.4" fill="var(--wh-cut,#fbf8f2)"/>',
  'charcuterie': '<rect x="8" y="22" width="48" height="20" rx="10"/><path d="M6 24l4 2M6 40l4-2M58 24l-4 2M58 40l-4-2" stroke="currentColor" stroke-width="2"/><circle cx="20" cy="30" r="2" fill="var(--wh-cut,#fbf8f2)"/><circle cx="31" cy="35" r="2.4" fill="var(--wh-cut,#fbf8f2)"/><circle cx="43" cy="29" r="1.8" fill="var(--wh-cut,#fbf8f2)"/><circle cx="46" cy="36" r="1.4" fill="var(--wh-cut,#fbf8f2)"/>',
  'bread': '<path d="M6 44c0-16 12-26 26-26s26 10 26 26v4H6z"/><path d="M20 26l6 10M30 22l6 12M41 25l5 9" stroke="var(--wh-cut,#fbf8f2)" stroke-width="2.6" stroke-linecap="round"/>',
  'pastry': '<path d="M6 40c4-14 16-22 26-22s22 8 26 22c-6-3-11-3-14 0-3-5-8-7-12-7s-9 2-12 7c-3-3-8-3-14 0z"/><path d="M26 26l2 9M38 26l-2 9" stroke="var(--wh-cut,#fbf8f2)" stroke-width="2.2" stroke-linecap="round"/>',
  'pie': '<path d="M32 12 L56 50 H8 Z"/><path d="M8 50 Q32 58 56 50" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M20 40h24M26 30h12" stroke="var(--wh-cut,#fbf8f2)" stroke-width="2.4" stroke-linecap="round"/>',
  'bakeries': '<rect x="12" y="30" width="40" height="24"/><path d="M8 14h48l-4 14H12z"/><path d="M8 28a5 5 0 0 0 10 0a5 5 0 0 0 10 0a5 5 0 0 0 10 0a5 5 0 0 0 10 0a5 5 0 0 0 8 0" /><rect x="27" y="38" width="10" height="16" fill="var(--wh-cut,#fbf8f2)"/>',
  'wine': '<path d="M27 6h10v14c0 4 7 7 7 16v20a3 3 0 0 1-3 3H23a3 3 0 0 1-3-3V36c0-9 7-12 7-16z"/><rect x="22" y="36" width="20" height="12" fill="var(--wh-cut,#fbf8f2)"/>',
  'beer': '<path d="M16 16h32l-4 40H20z"/><path d="M14 18c0-6 6-8 10-6 2-4 10-4 12 0 4-2 12 0 12 6z"/><path d="M26 28v20M38 28v20" stroke="var(--wh-cut,#fbf8f2)" stroke-width="2" stroke-linecap="round"/>',
  'spirits': '<path d="M10 14h44c0 14-10 20-20 21v13h10v4H20v-4h10V35C20 34 10 28 10 14z"/><circle cx="40" cy="20" r="3" fill="var(--wh-cut,#fbf8f2)"/>',
  'restaurants': '<circle cx="32" cy="34" r="20"/><circle cx="32" cy="34" r="12" fill="var(--wh-cut,#fbf8f2)"/><path d="M6 10v14a4 4 0 0 0 4 4v26M10 10v12M14 10v14a4 4 0 0 1-4 4" stroke="currentColor" stroke-width="2" fill="none"/><path d="M56 10c-4 2-5 8-5 14h5v30" stroke="currentColor" stroke-width="2" fill="none"/>',
  'music': '<circle cx="32" cy="32" r="26"/><circle cx="32" cy="32" r="9" fill="var(--wh-cut,#fbf8f2)"/><circle cx="32" cy="32" r="2"/><path d="M14 32a18 18 0 0 1 18-18" stroke="var(--wh-cut,#fbf8f2)" stroke-width="1.2" fill="none" opacity=".6"/>',
  'movies': '<rect x="8" y="10" width="48" height="44"/><rect x="18" y="18" width="28" height="28" fill="var(--wh-cut,#fbf8f2)"/><g fill="var(--wh-cut,#fbf8f2)"><rect x="10.5" y="14" width="4" height="5"/><rect x="10.5" y="25" width="4" height="5"/><rect x="10.5" y="36" width="4" height="5"/><rect x="10.5" y="46" width="4" height="5"/><rect x="49.5" y="14" width="4" height="5"/><rect x="49.5" y="25" width="4" height="5"/><rect x="49.5" y="36" width="4" height="5"/><rect x="49.5" y="46" width="4" height="5"/></g>',
};

function warehouseEmblem(key, cls){
  const d = WAREHOUSE_DEPTS[key];
  if(!d || !WAREHOUSE_EMBLEMS[key]) return '';
  return `<svg class="${cls || 'wh-emblem'}" viewBox="0 0 64 64" style="color:${d.color}" fill="currentColor" aria-hidden="true">${WAREHOUSE_EMBLEMS[key]}</svg>`;
}

// A hand-drawn pencil line: loops like a handwriting exercise, drawn with
// a little seeded wobble so each department's line is its own but stable.
function warehouseScrawl(seedText, width){
  let seed = 0; for(const ch of (seedText || 'w')) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const W = width || 320, loops = Math.max(5, Math.round(W / 34));
  let x = 4, y = 22, d = `M${x} ${y}`;
  for(let i = 0; i < loops; i++){
    const step = (W - 8) / loops, h = 9 + rnd() * 9, lean = 3 + rnd() * 4;
    const x1 = x + step * .55, x2 = x + step * .15, x3 = x + step;
    d += ` C${(x + step*.35).toFixed(1)} ${(y - 2).toFixed(1)} ${(x1 + lean).toFixed(1)} ${(y - h).toFixed(1)} ${(x1).toFixed(1)} ${(y - h + 1).toFixed(1)}`;
    d += ` S${(x2).toFixed(1)} ${(y + 2).toFixed(1)} ${(x3).toFixed(1)} ${(y + (rnd() - .5) * 3).toFixed(1)}`;
    x = x3; y = 22 + (rnd() - .5) * 4;
  }
  return `<svg class="wh-scrawl" viewBox="0 0 ${W} 32" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" pathLength="1"/></svg>`;
}

function warehouseCurrentDept(){
  return (location.pathname.split('/').pop() || 'index.html').replace(/\.html?$/, '') || 'index';
}

function installWarehouseChrome(){
  if(typeof document === 'undefined' || document.querySelector('.wh-mast')) return;
  const dept = warehouseCurrentDept();
  const info = WAREHOUSE_DEPTS[dept];
  document.body.dataset.dept = dept;

  const css = `
  .wh-mast{font-family:'Instrument Sans','Helvetica Neue',Helvetica,Arial,sans-serif;color:#1d1a16;background:#fbf8f2;
    border-bottom:1px solid rgba(29,26,22,.14);position:relative;z-index:30;}
  .wh-mast-top{max-width:1180px;margin:0 auto;padding:18px 24px 14px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:16px;}
  .wh-ear{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#6f665b;white-space:nowrap;}
  .wh-ear.r{text-align:right;}
  .wh-word{font-family:'Cormorant Garamond','Cormorant Infant',Georgia,serif;font-weight:500;font-size:19px;letter-spacing:.46em;
    text-transform:uppercase;text-decoration:none;color:#1d1a16;padding-left:.46em;white-space:nowrap;}
  .wh-word:hover{opacity:.7;}
  .wh-nav{max-width:1180px;margin:0 auto;display:flex;justify-content:center;gap:2px;overflow-x:auto;scrollbar-width:none;
    padding:0 18px;-webkit-mask-image:linear-gradient(90deg,transparent,#000 18px,#000 calc(100% - 18px),transparent);
    mask-image:linear-gradient(90deg,transparent,#000 18px,#000 calc(100% - 18px),transparent);}
  .wh-nav::-webkit-scrollbar{display:none;}
  .wh-nav a{flex:none;font-size:10.5px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;text-decoration:none;
    color:#6f665b;padding:10px 11px 12px;position:relative;transition:color .2s;}
  .wh-nav a:hover{color:#1d1a16;}
  .wh-nav a.on{color:#1d1a16;}
  .wh-nav a.on::after{content:"";position:absolute;left:11px;right:11px;bottom:0;height:2px;background:var(--wh-dept,#1d1a16);}
  .wh-nav .sep{flex:none;width:1px;background:rgba(29,26,22,.14);margin:12px 6px 14px;}
  @media (max-width:980px){ .wh-nav{justify-content:flex-start;} }
  @media (max-width:640px){ .wh-ear{display:none;} .wh-mast-top{grid-template-columns:1fr;justify-items:center;padding:16px 18px 8px;} .wh-word{font-size:17px;} }

  .wh-acct{font:inherit;font-size:10px;font-weight:500;letter-spacing:.2em;text-transform:uppercase;color:#6f665b;background:none;border:none;
    cursor:pointer;padding:6px 0;justify-self:end;white-space:nowrap;}
  .wh-acct:hover, .wh-acct[aria-expanded="true"]{color:#1d1a16;}
  .wh-acct::after{content:"";display:inline-block;width:6px;height:6px;border-right:1px solid currentColor;border-bottom:1px solid currentColor;
    transform:rotate(45deg);margin:0 0 3px 8px;transition:transform .25s;}
  .wh-acct[aria-expanded="true"]::after{transform:rotate(-135deg);margin-bottom:0;}
  .wh-drawer{display:grid;grid-template-rows:0fr;transition:grid-template-rows .35s cubic-bezier(.2,.7,.2,1);border-top:1px solid transparent;}
  .wh-drawer.open{grid-template-rows:1fr;border-top-color:rgba(29,26,22,.1);}
  .wh-drawer > div{overflow:hidden;}
  .wh-drawer-in{max-width:1180px;margin:0 auto;padding:16px 24px 18px;display:flex;justify-content:center;gap:12px;flex-wrap:wrap;}
  .wh-drawer .auth-control{margin:0 !important;justify-content:center;}
  @media (max-width:640px){ .wh-acct{position:absolute;right:16px;top:20px;font-size:9.5px;} .wh-mast{position:relative;} }

  /* department header additions */
  .wh-emblem-hd{display:block;width:58px;height:58px;margin:26px auto 0;animation:wh-pop .8s cubic-bezier(.2,.7,.2,1) both .1s;}
  .wh-title{position:relative;display:inline-block;}
  .wh-scrawl{position:absolute;left:-4%;width:108%;bottom:-.16em;height:.34em;overflow:visible;pointer-events:none;}
  .wh-scrawl path{fill:none;stroke:var(--wh-dept,#1d1a16);stroke-width:1.6;stroke-linecap:round;opacity:.75;
    stroke-dasharray:1;stroke-dashoffset:1;animation:wh-draw 1.6s cubic-bezier(.6,.1,.3,1) forwards .45s;vector-effect:non-scaling-stroke;}
  .wh-hand{font-family:'Reenie Beanie','Bradley Hand','Segoe Print',cursive;font-weight:400;font-style:normal;color:var(--wh-dept,#1d1a16);
    letter-spacing:0;text-transform:none;line-height:1;}
  .wh-title .wh-hand{position:absolute;right:-.2em;top:-.32em;font-size:clamp(20px,2.6vw,28px);transform:rotate(-6deg);white-space:nowrap;
    animation:wh-fadein .8s ease both 1.4s;}
  .wh-role{font-family:'Instrument Sans',sans-serif;font-size:10.5px;font-weight:500;letter-spacing:.2em;text-transform:uppercase;color:#6f665b;margin-top:18px;}
  .wh-role em{font-family:'Cormorant Garamond',Georgia,serif;font-size:17px;letter-spacing:0;text-transform:none;color:#1d1a16;}
  @media (max-width:640px){ .wh-title .wh-hand{top:-.55em;right:-.1em;} }
  @keyframes wh-draw{to{stroke-dashoffset:0;}}
  @keyframes wh-pop{from{opacity:0;transform:scale(.6) rotate(-8deg);}to{opacity:1;transform:none;}}
  @keyframes wh-fadein{from{opacity:0;}to{opacity:1;}}
  @media (prefers-reduced-motion:reduce){ .wh-scrawl path{animation:none;stroke-dashoffset:0;} .wh-emblem-hd,.wh-title .wh-hand{animation:none;} }

  .wh-foot{font-family:'Instrument Sans','Helvetica Neue',Helvetica,Arial,sans-serif;background:#1d1a16;color:#e9e2d4;margin-top:56px;}
  .wh-foot-in{max-width:1180px;margin:0 auto;padding:72px 24px 40px;}
  .wh-foot .wh-word{color:#fbf8f2;font-size:22px;}
  .wh-foot-tag{font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-size:22px;color:#b9ae9c;margin:12px 0 52px;}
  .wh-floors{display:grid;grid-template-columns:repeat(5,1fr);gap:32px 24px;}
  .wh-floors h4{margin:0 0 16px;font-size:10px;font-weight:500;letter-spacing:.2em;text-transform:uppercase;color:#8f8576;}
  .wh-floors a{display:flex;align-items:center;gap:10px;color:#e9e2d4;text-decoration:none;font-family:'Cormorant Garamond',Georgia,serif;font-size:21px;line-height:1.6;}
  .wh-floors a svg{width:18px;height:18px;flex:none;--wh-cut:#1d1a16;opacity:.9;}
  .wh-floors a:hover{color:#fff;font-style:italic;}
  .wh-colophon{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:64px;padding-top:20px;
    border-top:1px solid rgba(233,226,212,.15);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#8f8576;}
  .wh-colophon .wh-hand{font-size:22px;color:#b9ae9c;}
  @media (max-width:760px){ .wh-floors{grid-template-columns:repeat(2,1fr);} .wh-foot-in{padding:52px 22px 32px;} }
  `;
  const style = document.createElement('style');
  style.id = 'wh-chrome-css';
  style.textContent = css;
  document.head.appendChild(style);
  if(info) document.body.style.setProperty('--wh-dept', info.color);

  // Masthead + department navigation
  const links = WAREHOUSE_FLOORS.map((f, i) =>
    (i ? '<span class="sep" aria-hidden="true"></span>' : '') +
    f.keys.map(k => `<a href="${k}.html"${k === dept ? ' class="on" aria-current="page"' : ''}>${WAREHOUSE_DEPTS[k].name}</a>`).join('')
  ).join('');
  const mast = document.createElement('div');
  mast.className = 'wh-mast';
  mast.innerHTML = `
    <div class="wh-mast-top">
      <span class="wh-ear">Brooklyn, New York</span>
      <a class="wh-word" href="index.html">Warehouse</a>
      <span class="wh-ear r">A collection of collections</span>
    </div>
    <nav class="wh-nav" aria-label="Departments">${links}</nav>
    <div class="wh-drawer" id="whDrawer"><div><div class="wh-drawer-in"></div></div></div>`;
  document.body.insertBefore(mast, document.body.firstChild);

  // Account: the sign-in form moves out of the department header into a
  // drawer under the masthead, opened from a quiet "Sign in" link, the
  // way a shop keeps its back office out of the window display. The
  // app's own code still finds #authControl by id and renders into it.
  const auth = document.getElementById('authControl');
  if(auth){
    const drawer = mast.querySelector('#whDrawer'), inner = drawer.querySelector('.wh-drawer-in');
    inner.appendChild(auth);
    const enroll = document.getElementById('mfaEnrollWrap');
    if(enroll) inner.appendChild(enroll);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'wh-acct'; btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'whDrawer');
    const ear = mast.querySelector('.wh-ear.r');
    ear.replaceWith(btn);
    const setOpen = (open) => { drawer.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open)); };
    btn.addEventListener('click', () => setOpen(!drawer.classList.contains('open')));
    const sync = () => {
      const signedIn = !!auth.querySelector('#signOutBtn');
      const needsCode = !!auth.querySelector('#mfaChallengeForm');
      btn.textContent = needsCode ? 'Verify sign-in' : signedIn ? 'Account' : 'Sign in';
      if(needsCode) setOpen(true);
      if(auth.querySelector('.auth-error') && auth.querySelector('.auth-error').textContent) setOpen(true);
    };
    sync();
    new MutationObserver(sync).observe(auth, { childList:true, subtree:true, characterData:true });
  }
  const on = mast.querySelector('.wh-nav a.on');
  if(on){ const nav = mast.querySelector('.wh-nav'); nav.scrollLeft = on.offsetLeft - nav.clientWidth / 2 + on.clientWidth / 2; }

  // Department header: floor + number in the kicker, the emblem, the pencil
  // line and role note on the title, and the role line under the subtitle.
  const header = info && document.querySelector('.wrap > header');
  const h1 = header && header.querySelector('h1');
  if(header && h1 && !h1.querySelector('.wh-title')){
    const order = WAREHOUSE_FLOORS.flatMap(f => f.keys);
    const floor = WAREHOUSE_FLOORS.find(f => f.keys.includes(dept));
    const kicker = header.querySelector('.kicker');
    if(kicker) kicker.innerHTML = `<a href="index.html">No. ${String(order.indexOf(dept) + 1).padStart(2, '0')} &middot; ${floor.floor}</a>`;
    h1.insertAdjacentHTML('beforebegin', warehouseEmblem(dept, 'wh-emblem-hd'));
    h1.innerHTML = `<span class="wh-title">${h1.innerHTML}${warehouseScrawl(dept, 360)}<span class="wh-hand" hidden></span></span>`;
    // The pencil note in the margin is the collector's running tally, read
    // from the page's own count line ("384 records…" -> "384 kept").
    const hand = h1.querySelector('.wh-hand');
    const countEl = document.getElementById('count') || document.getElementById('tally') || document.querySelector('.toolbar .count, .count');
    const tally = () => {
      const m = countEl && (countEl.textContent || '').replace(/,/g, '').match(/(\d+)\s*(?:of\s*(\d+))?/);
      if(!m) return;
      const n = m[2] || m[1];
      hand.textContent = n + ' kept';
      hand.hidden = false;
    };
    if(countEl){ tally(); new MutationObserver(tally).observe(countEl, { childList:true, characterData:true, subtree:true }); }
    const sub = header.querySelector('.sub');
    const roleLine = `<div class="wh-role">In which the collector plays <em>${info.role}</em></div>`;
    if(sub) sub.insertAdjacentHTML('afterend', roleLine); else h1.insertAdjacentHTML('afterend', roleLine);
  }

  // Footer
  const foot = document.createElement('footer');
  foot.className = 'wh-foot';
  foot.innerHTML = `
    <div class="wh-foot-in">
      <a class="wh-word" href="index.html">Warehouse</a>
      <div class="wh-foot-tag">Everything worth keeping, kept well.</div>
      <div class="wh-floors">${WAREHOUSE_FLOORS.map(f => `<div><h4>${f.floor}</h4>${f.keys.map(k => `<a href="${k}.html">${warehouseEmblem(k, '')}${WAREHOUSE_DEPTS[k].name}</a>`).join('')}</div>`).join('')}</div>
      <div class="wh-colophon"><span>Brooklyn, New York</span><span class="wh-hand">open to browse, kept by the owner</span></div>
    </div>`;
  document.body.appendChild(foot);
}

if(typeof document !== 'undefined'){
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installWarehouseChrome);
  else installWarehouseChrome();
}
