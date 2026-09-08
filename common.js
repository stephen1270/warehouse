// Shared across all 7 warehouse apps (Pantry, Restaurants, Cheese, Wine,
// Spirits, Charcuterie, Music). This file holds only pure logic with no
// DOM coupling -- the storage adapter and image resizer -- so it's safe
// to share verbatim. Each app still owns its own auth-gate rendering and
// page-specific state, since that DOES touch each page's own DOM.
//
// Extracted 2026-08-30 after these blocks were found byte-identical (or
// near enough -- one stray comment difference) across cheese.html,
// wine.html, spirits.html, charcuterie.html, music.html, restaurants.html,
// and pantry.html. Before this, a fix applied to one app (like the photo
// resize dimensions, or the missing-viewport-tag bug) had no way to reach
// the other six except by hand -- this file is that reach.

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
