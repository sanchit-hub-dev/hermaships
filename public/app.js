// ================================================================
// CONFIGURATION
// ================================================================
const BACKEND_API_URL = '/api';
let OFFLINE_MODE = localStorage.getItem('vmms_offline_mode') === 'true';
let OFFLINE_MANUAL = localStorage.getItem('vmms_offline_manual') === 'true';

// ── Google OAuth (for direct Drive upload only) ──────────────────
// Step 1: Go to https://console.cloud.google.com
// Step 2: Create a project → APIs & Services → Enable "Google Drive API"
// Step 3: OAuth consent screen → External → add your email as test user
// Step 4: Credentials → Create OAuth Client ID → Web application
//         Authorised JS origins: http://localhost:3000  AND  https://yourdomain.com
//         If you use 127.0.0.1, add http://127.0.0.1:3000 too.
// Step 5: Paste the Client ID below
const GOOGLE_CLIENT_ID = "351482844740-79taqtutogfvl4jbbk9ls5bm24srhljd.apps.googleusercontent.com";

// ── The root Drive folder where all vessel files are stored ──────
// This is the ROOT_FOLDER_ID already in your Apps Script backend
const DRIVE_ROOT_FOLDER_ID = "1rrRPGMrPIPc9nACkBDiQaq7w1T5JpVkX";

// ── OAuth token (obtained silently at login, used only for uploads) ──
let _driveToken = null;
let _driveTokenExpiry = 0;
let _driveTokenLoading = false;
let _driveClient = null;
const _driveFolderCache = new Map();
const _driveFolderCreating = new Map();

// ================================================================
// GOOGLE OAUTH — silent token for Drive uploads only
// The user never sees a Google popup. We preload the GIS script
// on startup and request auth inside a click gesture.
// ================================================================
function loadGoogleIdentityScript(){
  return new Promise(resolve=>{
    if(window.google && window.google.accounts){ resolve(); return; }
    if(_driveTokenLoading){
      const check = setInterval(()=>{
        if(window.google && window.google.accounts){ clearInterval(check); if(timeout) clearTimeout(timeout); resolve(); }
      }, 50);
      const timeout = setTimeout(()=>{ clearInterval(check); resolve(); }, 3000);
      return;
    }
    _driveTokenLoading = true;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => { _driveTokenLoading = false; resolve(); };
    s.onerror = () => { _driveTokenLoading = false; resolve(); };
    document.head.appendChild(s);
  });
}

function getDriveClient(){
  if(_driveClient) return _driveClient;
  if(!window.google || !window.google.accounts) return null;
  _driveClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/drive.file',
    callback: response => {
      if(response.error){
        console.error('OAuth error:', response.error);
        _driveClient._lastError = response.error;
        return;
      }
      _driveToken = response.access_token;
      _driveTokenExpiry = Date.now() + (response.expires_in * 1000);
      console.log('✓ OAuth token obtained');
    }
  });
  return _driveClient;
}

function getGoogleOAuthOriginHint(){
  const origin = window.location.origin || 'unknown origin';
  console.log('Google OAuth origin:', origin);
  if(origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')){
    console.warn('Ensure the OAuth client Authorized JavaScript origin includes:', origin);
  }
  return origin;
}

async function ensureDriveToken(forceConsent = false){
  if(_driveToken && Date.now() < _driveTokenExpiry - 120000) return _driveToken;
  await loadGoogleIdentityScript();
  const client = getDriveClient();
  if(!client) throw new Error('GOOGLE_IDENTITY_LOAD_FAILED');

  return new Promise((resolve, reject) => {
    let timeout = null;
    let settled = false;
    const finishReject = (err) => {
      if(settled) return;
      settled = true;
      if(timeout) clearTimeout(timeout);
      reject(err);
    };
    const finishResolve = (token) => {
      if(settled) return;
      settled = true;
      if(timeout) clearTimeout(timeout);
      resolve(token);
    };
    const callback = response => {
      if(response.error){
        console.error('OAuth error:', response.error);
        if(/origin_mismatch/i.test(response.error)){
          finishReject(new Error('DOMAIN_NOT_CONFIGURED'));
        } else if(/access_denied/i.test(response.error)){
          finishReject(new Error('GOOGLE_ACCESS_DENIED'));
        } else {
          finishReject(new Error(response.error));
        }
        return;
      }
      _driveToken = response.access_token;
      _driveTokenExpiry = Date.now() + (response.expires_in * 1000);
      console.log('✓ OAuth token obtained');
      finishResolve(_driveToken);
    };

    client.callback = callback;
    try {
      if(forceConsent){
        client.requestAccessToken({ prompt: 'consent' });
      } else {
        client.requestAccessToken({ prompt: '' });
      }
    } catch(err){
      finishReject(err);
      return;
    }

    // Do not report timeout as a Google Cloud/domain setup problem.
    // On Render free instances or slow browsers, auth can take longer than 5 seconds.
    timeout = setTimeout(() => {
      finishReject(new Error('GOOGLE_AUTH_TIMEOUT'));
    }, 20000);
  });
}

// ================================================================
// DRIVE UPLOAD — resumable upload, no size limit
// Flow:
//  1. Find or create folder path: ROOT / VesselName / FolderName
//  2. POST to Drive resumable upload API → get an upload session URL
//  3. PUT the raw file bytes to that URL in one shot
//     (for >5 MB files Drive recommends chunks, but single PUT
//      works up to the browser memory limit — typically 500 MB+)
// ================================================================
const DRIVE_FOLDER_APPPROPERTY_KEY = 'vmms_folder_key';

async function driveGetOrCreateFolder(token, parentId, name){
  const cacheKey = `${parentId}::${name}`;
  if(_driveFolderCache.has(cacheKey)){
    return _driveFolderCache.get(cacheKey);
  }

  // If another request is already creating this folder, wait for it
  if(_driveFolderCreating.has(cacheKey)){
    return await _driveFolderCreating.get(cacheKey);
  }

  let resolveCreating;
  let rejectCreating;
  const creatingPromise = new Promise((resolve, reject) => {
    resolveCreating = resolve;
    rejectCreating = reject;
  });
  _driveFolderCreating.set(cacheKey, creatingPromise);

  const propertyQuery = encodeURIComponent(`appProperties has { key='${DRIVE_FOLDER_APPPROPERTY_KEY}' and value='${cacheKey}' }`);
  const fallbackQuery = encodeURIComponent(
    `'${parentId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );

  console.log('Drive: searching for folder by appProperty', name, parentId);
  const searchByPropertyUrl = `https://www.googleapis.com/drive/v3/files?q=${propertyQuery}&fields=files(id,name)&pageSize=10`;
  let search = await fetchWithTimeout(searchByPropertyUrl, { headers:{ Authorization:'Bearer '+token } }, 15000);
  let data = await search.json();
  if(data.files && data.files.length > 0){
    _driveFolderCache.set(cacheKey, data.files[0].id);
    _driveFolderCreating.delete(cacheKey);
    resolveCreating(data.files[0].id);
    return await creatingPromise;
  }

  console.log('Drive: searching for folder by name', name, parentId);
  const searchByNameUrl = `https://www.googleapis.com/drive/v3/files?q=${fallbackQuery}&fields=files(id,name)&pageSize=10`;
  search = await fetchWithTimeout(searchByNameUrl, { headers:{ Authorization:'Bearer '+token } }, 15000);
  data = await search.json();
  if(data.files && data.files.length > 0){
    _driveFolderCache.set(cacheKey, data.files[0].id);
    _driveFolderCreating.delete(cacheKey);
    resolveCreating(data.files[0].id);
    return await creatingPromise;
  }

  // Guard creation with a promise so concurrent callers wait for the same result
  (async ()=>{
    try {
      console.log('Drive: creating folder', name, parentId, 'with appProperty', cacheKey);
      const create = await fetchWithTimeout('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers:{ Authorization:'Bearer '+token, 'Content-Type':'application/json' },
        body: JSON.stringify({
          name,
          mimeType: 'application/vnd.google-apps.folder',
          parents:  [parentId],
          appProperties: {
            [DRIVE_FOLDER_APPPROPERTY_KEY]: cacheKey
          }
        })
      }, 15000);
      const folder = await create.json();

      // After create, re-check by appProperty to avoid duplicate folder returns
      try{
        const recheck = await fetchWithTimeout(searchByPropertyUrl, { headers:{ Authorization:'Bearer '+token } }, 15000);
        const redata = await recheck.json();
        const finalId = (redata.files && redata.files.length>0) ? redata.files[0].id : (folder && folder.id ? folder.id : null);
        if(finalId) _driveFolderCache.set(cacheKey, finalId);
        resolveCreating(finalId);
      }catch(err){
        if(folder && folder.id){ _driveFolderCache.set(cacheKey, folder.id); resolveCreating(folder.id); }
        else rejectCreating(err);
      }
    } catch(err) {
      rejectCreating(err);
    } finally {
      _driveFolderCreating.delete(cacheKey);
    }
  })();

  return await creatingPromise;
}
window.driveGetOrCreateFolder = driveGetOrCreateFolder;
console.log('app.js loaded: drive helper attached', typeof window.driveGetOrCreateFolder, typeof window.testDriveFolderConcurrency);

// DEBUG/TEST HELPERS — only used for local concurrency validation
window.testDriveFolderConcurrency = async function(){
  const fakeToken = 'FAKE_TOKEN_FOR_CONCURRENCY_TEST';
  const parentId  = 'FAKE_PARENT';
  const name      = 'CONCURRENCY_TEST_FOLDER';
  let createCalls = 0;
  const originalFetch = window.fetch;

  window.fetch = async function(url, options = {}){
    const lowUrl = String(url || '');
    if(lowUrl.startsWith('https://www.googleapis.com/drive/v3/files?q=')){
      return {
        ok: true,
        json: async ()=>({files: []})
      };
    }
    if(lowUrl === 'https://www.googleapis.com/drive/v3/files' && options.method === 'POST'){
      createCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 100));
      return {
        ok: true,
        json: async ()=>({id: 'TEST_FOLDER_ID'})
      };
    }
    return originalFetch.apply(this, [url, options]);
  };

  try {
    const tasks = [
      driveGetOrCreateFolder(fakeToken, parentId, name),
      driveGetOrCreateFolder(fakeToken, parentId, name),
      driveGetOrCreateFolder(fakeToken, parentId, name)
    ];
    const results = await Promise.all(tasks);
    return {
      results,
      createCalls,
      cacheSize: _driveFolderCache.size,
      creatingSize: _driveFolderCreating.size
    };
  } finally {
    window.fetch = originalFetch;
    _driveFolderCreating.clear();
    _driveFolderCache.clear();
  }
};

function promisePool(tasks, limit){
  return new Promise((resolve, reject) => {
    const results = Array(tasks.length);
    let started = 0;
    let completed = 0;
    let running = 0;

    const next = () => {
      while(running < limit && started < tasks.length){
        const index = started++;
        running += 1;
        tasks[index]().then(value => {
          results[index] = { status:'fulfilled', value };
        }).catch(error => {
          results[index] = { status:'rejected', reason:error };
        }).finally(() => {
          running -= 1;
          completed += 1;
          if(completed === tasks.length){
            resolve(results);
          } else {
            next();
          }
        });
      }
      if(tasks.length === 0){
        resolve(results);
      }
    };
    next();
  });
}

async function driveUploadFile(file, vesselName, folderName){
  // 1. Get a valid OAuth token (force consent if needed)
  let token;
  try {
    token = await ensureDriveToken();
  } catch(err) {
    if(err.message === 'DOMAIN_NOT_CONFIGURED') throw err;
    // Retry once with explicit consent for popup/interaction/timeout cases.
    token = await ensureDriveToken(true);
  }

  if(!token){
    throw new Error('GOOGLE_AUTH_TOKEN_MISSING');
  }

  // 2. Build folder path in Drive: ROOT → Vessel → Folder
  const vesselFolderId = await driveGetOrCreateFolder(token, DRIVE_ROOT_FOLDER_ID, vesselName);
  const targetFolderId = await driveGetOrCreateFolder(token, vesselFolderId, folderName);

  // 3. Start a resumable upload session
  console.log('Drive: initiating upload session for', file.name, 'size', file.size);
  const initRes = await fetchWithTimeout(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
    {
      method:  'POST',
      headers:{
        Authorization:   'Bearer '+token,
        'Content-Type':  'application/json',
        'X-Upload-Content-Type':   file.type || 'application/pdf',
        'X-Upload-Content-Length': file.size
      },
      body: JSON.stringify({
        name:    file.name,
        parents: [targetFolderId]
      })
    },
    20000
  );
  if(!initRes.ok){
    const err = await initRes.text().catch(()=>'<no-body>');
    console.error('Drive session error init:', err);
    throw new Error('Drive session error: '+err);
  }

  // 4. The Location header is the resumable upload URL
  const uploadUrl = initRes.headers.get('Location');
  if(!uploadUrl) throw new Error('No upload URL returned by Drive');

  // 5. PUT the raw file — no base64, no size limit from Apps Script
  // 5. PUT the raw file — allow a longer timeout for large files
  console.log('Drive: uploading file to uploadUrl (may take a while)...');
  // Use XHR for the PUT so we get progress events and avoid browser restrictions
  function uploadWithXhr(url, file, timeout){
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      try{
        xhr.setRequestHeader('Content-Type', file.type || 'application/pdf');
      }catch(e){ /* some headers may be restricted */ }
      xhr.timeout = timeout;
      xhr.upload.onprogress = (e) => {
        if(e.lengthComputable){
          const pct = Math.round((e.loaded / e.total) * 100);
          console.log('Upload progress:', pct+'%');
        }
      };
      xhr.onload = () => {
        if(xhr.status >= 200 && xhr.status < 300){
          try{ resolve(JSON.parse(xhr.responseText)); } catch(e){ resolve(xhr.responseText); }
        } else {
          reject(new Error('Drive upload XHR failed: '+xhr.status+' '+xhr.statusText+' '+xhr.responseText));
        }
      };
      xhr.onerror = () => reject(new Error('Drive upload XHR network error'));
      xhr.ontimeout = () => reject(new Error('REQUEST_TIMEOUT'));
      xhr.send(file);
    });
  }

  // uploadWithXhr resolves with either a parsed JSON object or a string body.
  const uploadResult = await uploadWithXhr(uploadUrl, file, 300000);
  let driveFile = null;
  if(typeof uploadResult === 'string'){
    try{ driveFile = JSON.parse(uploadResult); }catch(e){ driveFile = null; }
  } else {
    driveFile = uploadResult;
  }
  if(!driveFile || !driveFile.id){
    console.error('Drive upload failed: invalid response', uploadResult);
    throw new Error('Drive upload failed: invalid response');
  }

  // 6. Make the file viewable by anyone with the link
  await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${driveFile.id}/permissions`, {
    method:  'POST',
    headers:{ Authorization:'Bearer '+token, 'Content-Type':'application/json' },
    body:    JSON.stringify({ role:'reader', type:'anyone' })
  }, 15000);

  return driveFile.id;
}

// Convert a data URL (base64) to a File object usable by Drive upload
function dataUrlToFile(dataUrl, filename){
  const parts = dataUrl.split(',');
  const meta = parts[0] || '';
  const base64 = parts[1] || '';
  const m = meta.match(/:(.*?);/);
  const mime = m ? m[1] : 'application/octet-stream';
  const binary = atob(base64);
  const len = binary.length;
  const u8 = new Uint8Array(len);
  for(let i=0;i<len;i++) u8[i] = binary.charCodeAt(i);
  try{ return new File([u8], filename, {type:mime}); }
  catch(e){
    // Fallback for older browsers that may not support File constructor
    const blob = new Blob([u8], {type:mime});
    blob.name = filename;
    return blob;
  }
}

// Migrate inline base64 vessel images (data: URLs) to Drive-hosted links.
// This will upload images to Drive under ROOT / <VesselName> / Images
async function migrateInlineImages(){
  if(!confirm('Migrate inline base64 vessel images to Google Drive? This may show a Google sign-in prompt. Continue?')) return;
  setSyncUI('fleet','syncing'); setSyncUI('app','syncing');
  let migrated = 0;
  for(const v of vessels){
    if(!v || !v.imageUrl) continue;
    const url = String(v.imageUrl||'');
    if(!url.startsWith('data:image/')) continue;
    try{
      const ext = (url.match(/data:image\/(png|jpeg|jpg|webp)/i)||[])[1] || 'jpg';
      const filename = (v.name||'vessel').replace(/\s+/g,'_') + '_img.'+ext;
      const file = dataUrlToFile(url, filename);
      // Upload to Drive under vessel name / Images
      const driveId = await driveUploadFile(file, v.name || 'Vessel', 'Images');
      if(driveId){
        v.imageUrl = `https://drive.google.com/uc?export=view&id=${driveId}`;
        migrated++;
      }
    }catch(err){
      console.error('Image migration failed for', v.name, err);
      toast('Image migration failed for '+(v.name||'unknown'),'warn');
    }
  }
  if(migrated) await saveVessels();
  setSyncUI('fleet','synced'); setSyncUI('app','synced');
  renderFleet();
  toast('Image migration complete: '+migrated+' images uploaded');
}

// ================================================================
// API LAYER
// ================================================================
// Helper: fetch with optional timeout (uses AbortController)
async function fetchWithTimeout(url, options = {}, timeout = 30000){
  const controller = new AbortController();
  let timer = null;
  if(timeout > 0){
    timer = setTimeout(()=>{ controller.abort(); }, timeout);
  }
  options.signal = controller.signal;
  try{
    return await fetch(url, options);
  }catch(err){
    if(err && err.name === 'AbortError'){
      throw new Error('REQUEST_TIMEOUT');
    }
    throw err;
  }finally{
    if(timer) clearTimeout(timer);
  }
}

async function deleteDriveFileById(driveId){
  if(!driveId) return false;
  const token = await ensureDriveToken();
  const res = await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveId)}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + token }
  }, 30000);
  if(!res.ok && res.status !== 204){
    const text = await res.text().catch(()=> '');
    throw new Error(`Drive delete failed: ${res.status} ${text}`);
  }
  return true;
}

async function deleteTrackedFile(file){
  if(!file) return;
  const driveIds = [file.driveFileId, file.excelDriveFileId].filter(Boolean);
  for(const driveId of driveIds){
    try {
      await deleteDriveFileById(driveId);
    } catch(err) {
      console.warn('Drive cleanup failed for', file.name, err);
    }
  }
  files = files.filter(f => f.key !== file.key);
}

async function api(action, payload={}){
  try {
    console.log('API request', action);
    const res = await fetchWithTimeout(BACKEND_API_URL, {
      method:   'POST',
      headers:  {'Content-Type':'application/json;charset=utf-8'},
      body:     JSON.stringify({action, ...payload}),
      redirect: 'follow'
    }, 20000);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch(_) {
      console.error('API non-JSON response ['+action+']:', text.slice(0,300));
      return {ok:false, error:'Server returned non-JSON. Check deployment settings.'};
    }
  } catch(err) {
    console.error('API error ['+action+']:', err);
    if(err.message === 'REQUEST_TIMEOUT') return {ok:false, error:'Request timed out'};
    return {ok:false, error:err.message||'Network error'};
  }
}

// ================================================================
// SESSION — stored in sessionStorage only (cleared on tab close)
// ================================================================
let currentUser = null;
function saveSession(u){ sessionStorage.setItem('vmms_session', JSON.stringify(u)); }
function loadSession(){ try{ const s=sessionStorage.getItem('vmms_session'); return s?JSON.parse(s):null; }catch{ return null; } }
function clearSession(){ sessionStorage.removeItem('vmms_session'); }

// Role permission helpers
// Admin = full control. User = view/download only.
function isAdminUser(){
  return !!(currentUser && String(currentUser.role || '').toLowerCase() === 'admin');
}
function canManageLibrary(){
  return isAdminUser();
}

// ================================================================
// AUTH SYSTEM
// ================================================================
async function doLogin(){
  const u = document.getElementById('loginUser').value.trim().toLowerCase();
  const p = document.getElementById('loginPass').value;
  if(!u||!p){ showAuthErr('Enter username and password'); return; }
  setAuthBusy(true);
  const r = await api('login', {username:u, password:p});
  setAuthBusy(false);
  if(!r.ok){ showAuthErr(r.error||'Invalid credentials'); return; }
  currentUser = {u, name:r.name, role:r.role};
  saveSession(currentUser);
  toast('Welcome, '+r.name+'!');
  launchApp();
}

async function doRegister(){
  showAuthErr('Registration is disabled. Please use the approved login credentials.');
}

async function doLogout(){
  clearSession();
  currentUser = null;
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('splash').style.display = 'none';
  document.getElementById('fleetScreen').style.display = 'none';
  document.getElementById('app').style.display = 'none';
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  showAuthErr('');
}

function showAuthErr(m){ document.getElementById('authErr').textContent = m; }
function setAuthBusy(on){
  const loginBtn = document.getElementById('loginBtn');
  const regBtn = document.getElementById('regBtn');
  if (loginBtn) loginBtn.disabled = on;
  if (regBtn) regBtn.disabled = on;
  // FIX: use a separate loading indicator, not the error field
  if(on) showAuthErr('');
}
function switchTab(t){
  document.getElementById('loginForm').style.display = '';
  const loginTab = document.getElementById('loginTab');
  if (loginTab) loginTab.classList.add('active');
  showAuthErr('');
}

function toggleOfflineMode(){
  OFFLINE_MODE = !OFFLINE_MODE;
  localStorage.setItem('vmms_offline_mode', OFFLINE_MODE ? 'true' : 'false');
  // mark manual toggles so auto-restore doesn't flip user-chosen offline state
  if(OFFLINE_MODE){
    OFFLINE_MANUAL = true;
    localStorage.setItem('vmms_offline_manual','true');
  } else {
    OFFLINE_MANUAL = false;
    localStorage.removeItem('vmms_offline_manual');
  }
  updateOfflineModeUI();

  if(OFFLINE_MODE){
    toast('Offline mode enabled. Working with cached data only.','info');
    console.log('✓ Offline mode enabled');
  } else {
    toast('Online mode enabled. Backend sync will resume.','info');
    console.log('✓ Offline mode disabled');
    if(currentUser){
      loadGoogleIdentityScript();
      refreshShared().catch(err => console.error('Refresh after online toggle failed:', err));
    }
  }
}

async function isBackendReachable(){
  try {
    const r = await api('getAllData');
    return r.ok && Array.isArray(r.vessels) && Array.isArray(r.folders) && Array.isArray(r.files);
  } catch(err){
    return false;
  }
}

async function restoreOnlineModeIfPossible(){
  if(!OFFLINE_MODE) return;
  // do not auto-restore if the user explicitly set offline mode
  if(OFFLINE_MANUAL) return;
  const reachable = await isBackendReachable();
  if(!reachable) return;

  OFFLINE_MODE = false;
  localStorage.setItem('vmms_offline_mode', 'false');
  updateOfflineModeUI();
  toast('Connection restored — online mode resumed.','info');
  await refreshShared();
}

function launchApp(){
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('splashUserName').textContent  = currentUser.name;
  document.getElementById('splash').style.display = 'flex';
  document.getElementById('fleetUserName').textContent   = currentUser.name;
  document.getElementById('fleetUserRole').textContent   = currentUser.role;
  document.getElementById('statUser').textContent        = currentUser.name;
  updateRoleUI();
}

function updateRoleUI(){
  const canEdit = canManageLibrary();
  const addFolderBtn = document.getElementById('addFolderTopBtn');
  if(addFolderBtn) addFolderBtn.style.display = canEdit ? '' : 'none';
  const afBar = document.getElementById('afBar');
  if(afBar && !canEdit) afBar.classList.remove('show');
}

// ================================================================
// SHARED DATA STATE
// ================================================================
let vessels = [];
let folders = [];
let files   = [];
let activeVesselId = null;
let activeId = null;
let searchQ  = '';
let lastFleetRefresh = 0;

const DEFAULT_FOLDERS = [
  "1. MAIN PROPULSION SYSTEM & SHAFTING",
  "2. POWER GENERATION SYSTEM",
  "3. COMPRESSED AIR SYSTEM",
  "4. EMERGENCY POWER GENERATION SYSTEM",
  "5. ER PUMPS & PUMPING",
  "6. POLLUTION CONTROL EQUIPMENT",
  "7. STEERING GEAR SYSTEM",
  "8. AIR CONDITIONING & VENTILATION SYSTEM",
  "9. CARGO PUMPING SYSTEM",
  "10. DECK MACHINERY & CRANE",
  "11. NAVIGATION & COMMUNICATION EQUIPMENT",
];

function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

function sanitizeCssUrl(url){
  try {
    return encodeURI(String(url||'').trim()).replace(/"/g,'%22').replace(/'/g,'%27');
  } catch {
    return '';
  }
}

function normalizeSearchText(value){
  return String(value||'').normalize('NFKC').trim().toLowerCase();
}

function encodeHTML(value){
  return String(value||'')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setSyncUI(scope, state){
  const dot = document.getElementById(scope+'SyncDot');
  const txt = document.getElementById(scope+'SyncText');
  if(!dot||!txt) return;
  dot.className = 'sync-dot '+state;
  txt.textContent = state==='syncing' ? 'Syncing…' : state==='synced' ? 'Synced' : 'Offline';
}

function updateOfflineModeUI(){
  const indicator = document.getElementById('offlineModeIndicator');
  if(indicator){
    indicator.textContent = OFFLINE_MODE ? 'OFFLINE' : 'ONLINE';
    indicator.style.opacity = OFFLINE_MODE ? '1' : '0.75';
    indicator.style.color = OFFLINE_MODE ? '#ffb86c' : '#8ff';
  }
  if(OFFLINE_MODE){
    setSyncUI('fleet','offline');
    setSyncUI('app','offline');
  }
}

async function saveVessels(){
  if(OFFLINE_MODE){ console.log('⚠️  Offline mode - skipping backend save'); return; }
  setSyncUI('fleet','syncing'); setSyncUI('app','syncing');
  try {
    const r = await api('saveVessels', {vessels});
    if(!r.ok) throw new Error(r.error || 'Save failed');
    console.log('✓ Vessels saved:', vessels.length);
    saveCachedData();
  } catch(err){
    console.error('✗ Vessels save failed:', err);
    toast('Error saving vessels: '+err.message,'err');
    setSyncUI('fleet','offline'); setSyncUI('app','offline');
    return;
  }
  setSyncUI('fleet','synced'); setSyncUI('app','synced');
}
async function saveFolders(){
  if(OFFLINE_MODE){ console.log('⚠️  Offline mode - skipping backend save'); return; }
  setSyncUI('app','syncing');
  try {
    const r = await api('saveFolders', {folders});
    if(!r.ok) throw new Error(r.error || 'Save failed');
    console.log('✓ Folders saved:', folders.length);
    saveCachedData();
  } catch(err){
    console.error('✗ Folders save failed:', err);
    toast('Error saving folders: '+err.message,'err');
    setSyncUI('app','offline');
    return;
  }
  setSyncUI('app','synced');
}

function isValidArray(value){
  return Array.isArray(value);
}

function saveCachedData(){
  try {
    const cache = {
      timestamp: Date.now(),
      vessels: vessels || [],
      folders: folders || [],
      files: files || []
    };
    localStorage.setItem('vmms_cache', JSON.stringify(cache));
  } catch(err){
    console.warn('Failed to save local cache:', err);
  }
}

function loadCachedData(){
  try {
    const raw = localStorage.getItem('vmms_cache');
    if(!raw) return false;
    const cache = JSON.parse(raw);
    if(!cache) return false;
    if(isValidArray(cache.vessels) && isValidArray(cache.folders) && isValidArray(cache.files)){
      vessels = cache.vessels;
      folders = cache.folders;
      files   = cache.files;
      console.log('✓ Restored cached data:', {v:vessels.length,f:folders.length,files:files.length});
      return true;
    }
  } catch(err){
    console.warn('Failed to load local cache:', err);
  }
  return false;
}

async function saveFileMeta(changedFiles){
  setSyncUI('app','syncing');
  const source = Array.isArray(changedFiles) ? changedFiles : files;
  const seen = new Set();
  const meta = source.filter(f=>{
    const key = f.vesselId+'::'+f.folderId+'::'+f.name;
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(f=>({
    key: f.key,
    folderId: f.folderId,
    vesselId: f.vesselId,
    name: f.name,
    size: f.size,
    by: f.by,
    at: f.at,
    driveFileId: f.driveFileId||'',
    excelDriveFileId: f.excelDriveFileId||''
  }));
  
  console.log('Saving '+meta.length+' file metadata entries to backend...');
  
  try {
    const r = await api('saveFileMeta', {files:meta});
    if(!r.ok) throw new Error(r.error || 'Save failed');
    console.log('✓ Files saved to backend:', meta.length);
    saveCachedData();
    console.log('✓ Files cached locally:', files.length);
  } catch(err){
    console.error('❌ Files save failed:', err.message);
    toast('Error saving files: '+err.message,'err');
    setSyncUI('app','offline');
    return;
  }
  setSyncUI('app','synced');
}

async function refreshShared(){
  if(OFFLINE_MODE){
    console.log('🔆 Offline mode enabled - using cached data only');
    setSyncUI('fleet','synced'); setSyncUI('app','synced');
    if(!vessels.length && !folders.length && !files.length){
      loadCachedData();
    }
    return;
  }
  setSyncUI('fleet','syncing'); setSyncUI('app','syncing');
  try {
    const r = await api('getAllData');
    if(!r.ok) throw new Error(r.error || 'Sync failed');
    
    const before = {v:vessels.length, f:folders.length, files:files.length};
    const hasBackendArrays = isValidArray(r.vessels) && isValidArray(r.folders) && isValidArray(r.files);
    
    if(!hasBackendArrays){
      console.warn('❌ Backend returned non-array data. Keeping local state.');
      toast('Warning: backend sync incomplete, keeping local manuals.','warn');
      setSyncUI('fleet','synced'); setSyncUI('app','synced');
      return;
    }
    
    // Detect if backend is returning empty when we have data
    const isBackendEmpty = r.vessels.length === 0 && r.folders.length === 0 && r.files.length === 0;
    const haveLocalData = vessels.length > 0 || folders.length > 0 || files.length > 0;
    
    if(isBackendEmpty && haveLocalData){
      console.warn('⚠️  Backend returned all empty arrays, but we have local data. Preserving cache.');
      toast('Backend temporarily unavailable. Showing cached manuals.','warn');
      saveCachedData();
      setSyncUI('fleet','synced'); setSyncUI('app','synced');
      return;
    }
    
    // Normal sync: update from backend
    vessels = r.vessels;
    folders = r.folders;
    files   = r.files;
    lastFleetRefresh = Date.now();
    saveCachedData();
    
    console.log('✓ Data synced from backend:', {before, after:{v:vessels.length,f:folders.length,files:files.length}});
  } catch(err){
    console.error('❌ Data refresh failed:', err.message);
    toast('Error syncing data. Using cached manuals if available.','err');
    setSyncUI('fleet','offline'); setSyncUI('app','offline');
    
    // Try to load from cache to recover
    if(!vessels.length && !folders.length && !files.length){
      if(loadCachedData()){
        toast('Recovered data from local cache.','info');
        setSyncUI('fleet','synced'); setSyncUI('app','synced');
      }
    }
    return;
  }
  setSyncUI('fleet','synced'); setSyncUI('app','synced');
}

async function refreshFleetDataIfStale(){
  const now = Date.now();
  if(now - lastFleetRefresh > 10000){
    await refreshShared();
  }
}

// ================================================================
// BOOT
// ================================================================
async function boot(){
  getGoogleOAuthOriginHint();
  const sess = loadSession();
  if(sess){
    currentUser = sess;
    launchApp();
    updateOfflineModeUI();
    console.log('Loading data for user:', sess.u);
    // Preload Google Identity Services for upload auth.
    if(!OFFLINE_MODE){
      loadGoogleIdentityScript();
    }
    // Try to load cached data first before backend sync
    const hasCached = loadCachedData();
    if(hasCached){
      console.log('✓ Loaded cached data on startup');
      renderFleet();
    }
    if(!OFFLINE_MODE){
      await loadAllData();
    } else {
      console.log('🔆 Offline mode enabled - skipping backend sync');
      await restoreOnlineModeIfPossible();
    }
    
    // Auto-refresh data when page regains focus (only if not offline)
    window.addEventListener('focus', async ()=>{
      if(!OFFLINE_MODE){
        console.log('Page focused - refreshing data...');
        await refreshShared();
        if(document.getElementById('fleetScreen').style.display !== 'none'){
          renderFleet();
        }
      } else {
        await restoreOnlineModeIfPossible();
      }
    });
    return;
  }
  document.getElementById('authScreen').style.display = 'flex';
}

async function loadAllData(){
  try {
    await refreshShared();
  } catch(err) {
    console.error('Failed to load all data:', err);
    if(!vessels.length && !folders.length && !files.length){
      loadCachedData();
    }
  }
}

// ================================================================
// FLEET SCREEN
// ================================================================
async function enterFleet(){
  document.getElementById('splash').style.display = 'none';
  document.getElementById('app').style.display    = 'none';
  await refreshShared();
  const fleetScreen = document.getElementById('fleetScreen');
  fleetScreen.style.display = 'flex';
  fleetScreen.classList.remove('fleet-pop-enter');
  void fleetScreen.offsetWidth;
  fleetScreen.classList.add('fleet-pop-enter');
  renderFleet();
}

async function filterFleet(val){
  const raw = typeof val === 'string' ? val : (document.getElementById('fleetSearch')?.value || '');
  const q = normalizeSearchText(raw);
  console.log('fleet search trigger', {raw, q, vessels: vessels.length, folders: folders.length, files: files.length});
  await refreshFleetDataIfStale();
  renderFleet(q);
}

function renderFleet(searchQuery=''){
  const grid = document.getElementById('vesselGrid');
  const q    = normalizeSearchText(searchQuery || document.getElementById('fleetSearch')?.value || '');
  const matchingVessels = vessels.filter(v=>{
    if(!q) return true;
    const nameMatch = normalizeSearchText(v.name).includes(q);
    const imoMatch  = normalizeSearchText(v.imo).includes(q);
    const flagMatch = normalizeSearchText(v.flag).includes(q);
    const typeMatch = normalizeSearchText(v.type).includes(q);
    const folderMatch = folders.some(f=>f.vesselId===v.id && normalizeSearchText(f.name).includes(q));
    const fileMatch   = files.some(f=>{
      const belongsToVessel = f.vesselId===v.id || folders.some(ff=>ff.id===f.folderId && ff.vesselId===v.id);
      const fileText = normalizeSearchText((f.name || '') + ' ' + (f.key || '') + ' ' + (f.driveFileId || '') + ' ' + (f.folderId || ''));
      const match = belongsToVessel && fileText.includes(q);
      if(match){
        console.log('fleet search file match', {query:q, vessel:v.name, file:f.name, fileText, belongsToVessel});
      }
      return match;
    });
    return nameMatch || imoMatch || flagMatch || typeMatch || folderMatch || fileMatch;
  });

  document.getElementById('fleetVesselCount').textContent = matchingVessels.length;
  document.getElementById('fleetCountBadge').textContent  = matchingVessels.length+' Vessel'+(matchingVessels.length!==1?'s':'');
  const info = document.getElementById('fleetSearchInfo');
  if(info){
    const query = q || '(none)';
    const names = matchingVessels.map(v=>v.name).join(', ') || 'none';
    info.textContent = `Query: ${query}  ·  Matched: ${names}`;
  }
  const searchPanel = document.getElementById('fleetSearchPanel');
  const searchFiles = document.getElementById('fleetSearchFiles');
  const matchedFiles = q ? files.filter(f=>{
    const belongsToVessel = vessels.some(v=>v.id===f.vesselId) || folders.some(ff=>ff.id===f.folderId);
    const fileText = normalizeSearchText((f.name || '') + ' ' + (f.key || '') + ' ' + (f.driveFileId || ''));
    return belongsToVessel && fileText.includes(q);
  }) : [];
  if(searchPanel && searchFiles){
    if(matchedFiles.length){
      searchPanel.style.display = 'grid';
      searchFiles.innerHTML = matchedFiles.map(f=>{
        const vesselName = (vessels.find(v=>v.id===f.vesselId) || {}).name || 'Unknown Vessel';
        const folderName = (folders.find(ff=>ff.id===f.folderId) || {}).name || 'General';
        return `<div class="fleet-search-file" data-drive="${f.driveFileId||''}" data-excel="${f.excelDriveFileId||''}" data-name="${encodeHTML(f.name||'')}" data-vessel="${encodeHTML(vesselName)}" data-url="${f.driveFileId ? 'https://drive.google.com/file/d/'+f.driveFileId+'/preview' : ''}">
          <div class="fleet-search-file-name">${encodeHTML(f.name||'Untitled PDF')}</div>
          <div class="fleet-search-file-meta"><span class="fleet-search-file-vessel">${encodeHTML(vesselName)}</span> · ${encodeHTML(folderName)}</div>
        </div>`;
      }).join('');
      searchFiles.querySelectorAll('.fleet-search-file').forEach(el=>{
        el.onclick = ()=>{
          const url = el.dataset.url;
          const name = el.dataset.name;
          if(url){ openPdfViewer(url, name); }
          else{ toast('PDF link not available','warn'); }
        };
      });
    } else {
      searchPanel.style.display = q ? 'grid' : 'none';
      searchFiles.innerHTML = q ? '<div class="fleet-search-file"><div class="fleet-search-file-name">No matching PDFs found.</div></div>' : '';
    }
  }
  grid.innerHTML = '';
  const canEdit = canManageLibrary();
  matchingVessels.forEach(v=>{
    const vfiles   = files.filter(f=>f.vesselId===v.id);
    const vfolders = folders.filter(f=>f.vesselId===v.id);
    const tc = 'vc-type-'+v.type;
    const tl = {tanker:'Tanker',bulk:'Bulk Carrier',cargo:'General Cargo',tug:'Tug / Workboat',barge:'Barge'}[v.type]||v.type;
    const rawImageUrl = v.imageUrl ? String(v.imageUrl).trim() : '';
    const imageUrl = sanitizeCssUrl(rawImageUrl);
    const imageBlock = imageUrl
      ? `<div class="vc-img-bg" style="background-image:url('${imageUrl}')"></div>`
      : `<div class="vc-img-placeholder">
          <svg class="vc-ship-svg" width="260" height="80" viewBox="0 0 260 80" fill="none">
            <rect x="10" y="40" width="220" height="22" rx="2" fill="#00f5ff" opacity=".4"/>
            <rect x="25" y="26" width="140" height="16" rx="1" fill="#00f5ff" opacity=".3"/>
            <rect x="50" y="16" width="60" height="12" rx="1" fill="#00f5ff" opacity=".25"/>
            <rect x="80" y="8" width="20" height="10" rx="1" fill="#00f5ff" opacity=".2"/>
            <polygon points="230,40 250,51 230,62" fill="#00f5ff" opacity=".3"/>
            <rect x="170" y="28" width="10" height="14" fill="#00f5ff" opacity=".2"/>
            <rect x="185" y="30" width="8" height="12" fill="#00f5ff" opacity=".2"/>
          </svg>
        </div>`;
    const c  = document.createElement('div');
    c.className = 'vessel-card';
    c.innerHTML = `<div class="vc-img">
      ${imageBlock}
      <div class="vc-img-overlay"></div>
      <div class="vc-imo">IMO: ${v.imo||'—'}</div>
      <div class="vc-type-badge ${tc}">${tl}</div>
    </div>
    <div class="vc-info">
      <div>
        <div class="vc-name">${v.name}</div>
        <div class="vc-sub" style="margin-top:4px">${v.flag||''}</div>
      </div>
      <div class="vc-meta">
        ${v.year?`<span class="vc-tag">Built: ${v.year}</span>`:''}
        <span class="vc-tag">${vfolders.length} Folder${vfolders.length!==1?'s':''}</span>
        <span class="vc-tag">${vfiles.length} Doc${vfiles.length!==1?'s':''}</span>
      </div>
      <div class="vc-footer">
        <div class="vc-docs-count"><i class="ti ti-files" style="font-size:13px"></i><span>${vfiles.length}</span> Manual${vfiles.length!==1?'s':''}</div>
        ${canEdit?`<button class="vc-share-btn" data-id="${v.id}"><i class="ti ti-link"></i> Share</button>`:''}
        ${canEdit?`<button class="vc-edit-btn" data-id="${v.id}"><i class="ti ti-pencil"></i> Edit</button>`:''}
        ${canEdit?`<button class="vc-del-btn" data-id="${v.id}"><i class="ti ti-trash"></i> Delete</button>`:''}
        <div class="vc-enter-btn">Open Manuals <i class="ti ti-arrow-right"></i></div>
      </div>
    </div>`;
    c.onclick = ()=>enterVessel(v.id);
    const sb = c.querySelector('.vc-share-btn');
    if(sb) sb.addEventListener('click', e=>{ e.stopPropagation(); createVesselShareLink(v.id); });
    const eb = c.querySelector('.vc-edit-btn');
    if(eb) eb.addEventListener('click', e=>{ e.stopPropagation(); openEditVessel(v.id); });
    const db = c.querySelector('.vc-del-btn');
    if(db) db.addEventListener('click', e=>{ e.stopPropagation(); deleteVessel(v.id, v.name); });
    grid.appendChild(c);
  });
  if(matchingVessels.length === 0){
    grid.innerHTML = '<div class="vessel-empty">No vessels match your search.</div>';
  }
  if(canEdit){
    const ac = document.createElement('div');
    ac.className = 'vessel-card-add';
    ac.innerHTML = '<i class="ti ti-ship"></i><div class="vessel-card-add-lbl">Register New Vessel</div>';
    ac.onclick = openAddVessel;
    grid.appendChild(ac);
  }
}


async function createVesselShareLink(vesselId){
  if(!canManageLibrary()){ toast('Share link is admin-only.','warn'); return; }
  const vessel = vessels.find(v=>v.id===vesselId);
  if(!vessel){ toast('Vessel not found','err'); return; }
  try{
    const r = await api('createVesselShareLink', {
      vesselId,
      createdBy: currentUser ? currentUser.name : ''
    });
    if(!r.ok){ toast(r.error || 'Failed to create share link','err'); return; }
    const url = r.url;
    if(navigator.clipboard && window.isSecureContext){
      await navigator.clipboard.writeText(url);
      toast('Client vessel link copied to clipboard');
    } else {
      window.prompt('Copy client vessel link:', url);
      toast('Client vessel link created');
    }
  }catch(err){
    console.error('Share link error:', err);
    toast('Share link failed: '+(err.message||err),'err');
  }
}

function goFleet(){ closePdfViewer(); closeVesselSwitcher(); document.getElementById('app').style.display='none'; enterFleet(); }
function goHome(){ closePdfViewer(); closeVesselSwitcher(); document.getElementById('app').style.display='none'; document.getElementById('fleetScreen').style.display='none'; document.getElementById('splash').style.display='flex'; }

function toggleVesselSwitcher(event){
  event.stopPropagation();
  const dd = document.getElementById('vesselSwitcher');
  if(!dd) return;
  const open = dd.classList.toggle('open');
  if(open){ renderVesselSwitcher(); }
}

function renderVesselSwitcher(){
  const list = document.getElementById('vesselSwitcherList');
  if(!list) return;
  const activeIdLocal = activeVesselId;
  const otherVessels = vessels.slice().sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''), undefined, {numeric:true, sensitivity:'base'}));
  list.innerHTML = otherVessels.map(v=>{
    const activeClass = v.id===activeIdLocal ? ' active' : '';
    return `<div class="vessel-switcher-item${activeClass}" data-id="${encodeHTML(v.id)}">
      <div class="vessel-switcher-item-name">${encodeHTML(v.name||'Unnamed Vessel')}</div>
      <div class="vessel-switcher-item-meta">${v.id===activeIdLocal?'Current':'Switch'}</div>
    </div>`;
  }).join('');
  list.querySelectorAll('.vessel-switcher-item').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const vesselId = el.dataset.id;
      if(vesselId && vesselId!==activeIdLocal){
        enterVessel(vesselId);
      }
      closeVesselSwitcher();
    });
  });
}

function closeVesselSwitcher(){
  const dd = document.getElementById('vesselSwitcher');
  if(dd) dd.classList.remove('open');
}

document.addEventListener('click', function(e){
  const container = document.querySelector('.vessel-switcher-container');
  const dd = document.getElementById('vesselSwitcher');
  if(!dd || !dd.classList.contains('open')) return;
  if(container && !container.contains(e.target)){
    closeVesselSwitcher();
  }
});

// ================================================================
// VESSEL MODAL
// ================================================================
function openAddVessel(){
  if(!canManageLibrary()){ toast('Vessel registration is admin-only.','warn'); return; }
  document.getElementById('avm-edit-id').value = '';
  document.getElementById('avm-title').innerHTML = '<i class="ti ti-ship"></i>Register New Vessel';
  document.getElementById('avm-submit-btn').innerHTML = '<i class="ti ti-plus" style="margin-right:4px"></i>Register Vessel';
  document.getElementById('addVesselModal').classList.add('open');
  setTimeout(()=>document.getElementById('avm-name').focus(), 50);
}

async function deleteVessel(id, name){
  if(!canManageLibrary()){ toast('Delete is admin-only.','warn'); return; }
  if(!confirm('Delete vessel "'+name+'" and all its folders and files? This cannot be undone.')) return;
  const vesselFiles = files.filter(f=>f.vesselId===id);
  for(const f of vesselFiles){
    await deleteTrackedFile(f);
  }
  vessels = vessels.filter(v=>v.id!==id);
  folders = folders.filter(f=>f.vesselId!==id);
  files   = files.filter(f=>f.vesselId!==id);
  await saveVessels();
  await saveFolders();
  await saveFileMeta();
  renderFleet();
  toast('Vessel deleted: '+name);
}

function openEditVessel(id){
  if(!canManageLibrary()){ toast('Vessel editing is admin-only.','warn'); return; }
  const v = vessels.find(x=>x.id===id);
  if(!v) return;
  document.getElementById('avm-edit-id').value = id;
  document.getElementById('avm-title').innerHTML = '<i class="ti ti-pencil"></i>Edit Vessel';
  document.getElementById('avm-submit-btn').innerHTML = '<i class="ti ti-check" style="margin-right:4px"></i>Save Changes';
  document.getElementById('avm-name').value  = v.name  || '';
  document.getElementById('avm-imo').value   = v.imo   || '';
  document.getElementById('avm-type').value  = v.type  || 'tanker';
  document.getElementById('avm-flag').value  = v.flag  || '';
  document.getElementById('avm-year').value  = v.year  || '';
  document.getElementById('avm-image').value = v.imageUrl || '';
  setTimeout(()=>updateImagePreview(v.imageUrl || ''), 50);
  document.getElementById('addVesselModal').classList.add('open');
  setTimeout(()=>document.getElementById('avm-name').focus(), 50);
}

function closeAddVessel(){
  document.getElementById('addVesselModal').classList.remove('open');
  document.getElementById('avm-edit-id').value = '';
  ['avm-name','avm-imo','avm-flag','avm-year','avm-image'].forEach(id=>{ const el = document.getElementById(id); if(el) el.value=''; });
  const preview = document.getElementById('avm-image-preview'); if(preview) preview.innerHTML = 'Paste an image URL to preview it here.';
}

function updateImagePreview(url){
  const preview = document.getElementById('avm-image-preview');
  if(!preview) return;
  const clean = String(url||'').trim();
  if(!clean){ preview.innerHTML = 'Paste an image URL to preview it here.'; return; }
  preview.innerHTML = `<img src="${clean}" alt="Vessel image preview" onerror="this.parentNode.innerHTML='Unable to load image. Check the URL.'">`;
}

async function confirmAddVessel(){
  if(!canManageLibrary()){ toast('Vessel changes are admin-only.','warn'); return; }
  const id      = document.getElementById('avm-edit-id').value;
  const name    = document.getElementById('avm-name').value.trim();
  const imo     = document.getElementById('avm-imo').value.trim();
  const type    = document.getElementById('avm-type').value;
  const flag    = document.getElementById('avm-flag').value.trim();
  const year    = document.getElementById('avm-year').value.trim();
  const imageUrl= document.getElementById('avm-image').value.trim();
  if(!name){ toast('Vessel name is required','warn'); return; }
  if(id){
    const vessel = vessels.find(x=>x.id===id);
    if(!vessel){ toast('Vessel not found','warn'); return; }
    vessel.name     = name;
    vessel.imo      = imo;
    vessel.type     = type;
    vessel.flag     = flag;
    vessel.year     = year;
    vessel.imageUrl = imageUrl;
    toast('Vessel updated');
  } else {
    vessels.push({
      id:   'v_'+uid(),
      name,
      imo,
      type,
      flag,
      year,
      imageUrl
    });
    toast('Vessel registered');
  }
  await saveVessels();
  closeAddVessel();
  renderFleet();
}

async function handleFiles(fileList){
  if(!canManageLibrary()){ toast('User access is view/download only. Upload is admin-only.','warn'); return; }
  if(OFFLINE_MODE){ toast('Cannot upload in offline mode. Go online to upload files.','warn'); return; }
  if(!activeId){ toast('Select a folder first','warn'); return; }
  const validFiles = Array.from(fileList).filter(file => {
    const lname = (file.name || '').toLowerCase();
    return lname.endsWith('.pdf') || lname.endsWith('.xls') || lname.endsWith('.xlsx');
  });
  if(validFiles.length === 0){ toast('No PDF or Excel files selected.','warn'); return; }

  const vessel = vessels.find(v=>v.id===activeVesselId);
  const folder = folders.find(f=>f.id===activeId);
  const vesselName = vessel ? vessel.name : 'Unknown Vessel';
  const folderName = folder ? folder.name : 'General';
  const newFilesMeta = [];

  toast('Uploading '+validFiles.length+' files to Drive…','');
  setSyncUI('app','syncing');

  const tasks = validFiles.map(file => async () => {
    const name = file.name || '';
    const size = file.size>1048576 ? (file.size/1048576).toFixed(1)+' MB' : Math.round(file.size/1024)+' KB';
    const key  = activeVesselId+'::'+activeId+'::'+name.replace(/\s/g,'_')+'::'+Date.now()+'::'+Math.random().toString(36).slice(2,5);

    try {
      console.log('🔄 Starting upload:', {file: name, vessel: vesselName, folder: folderName});
      const driveFileId = await driveUploadFile(file, vesselName, folderName);
      console.log('✓ Upload to Drive complete:', {driveFileId});

      const meta = {
        key,
        folderId:    activeId,
        vesselId:    activeVesselId,
        name,
        size,
        by:          currentUser.name,
        at:          Date.now()
      };
      if(name.toLowerCase().endsWith('.pdf')){
        meta.driveFileId = driveFileId;
      } else {
        meta.excelDriveFileId = driveFileId;
      }

      const idx = files.findIndex(f=>f.key===key);
      if(idx >= 0){ files[idx] = meta; }
      else { files.push(meta); }
      newFilesMeta.push(meta);
      return { success: true, name };
    } catch(err) {
      console.error('❌ Upload error:', err);
      if(err && err.message && err.message.toLowerCase().includes('token')){
        _driveToken = null; _driveTokenExpiry = 0;
      }
      return { success: false, name, error: err };
    }
  });

  const results = await promisePool(tasks, 2);
  const succeeded = results.filter(r => r.status === 'fulfilled' && r.value && r.value.success);
  const failed = results.filter(r => r.status === 'rejected' || (r.status==='fulfilled' && r.value && !r.value.success));

  failed.forEach(item => {
    const err = item.status === 'rejected' ? item.reason : item.value.error;
    const name = item.status === 'rejected' ? 'unknown file' : item.value.name;
    const errMsg = err && err.message ? err.message : String(err);
    if(errMsg === 'DOMAIN_NOT_CONFIGURED' || /origin_mismatch/i.test(errMsg)){
      const origin = window.location.origin || 'unknown origin';
      toast('Domain not configured in Google Cloud. Authorize this origin: '+origin,'error');
    } else if(errMsg === 'GOOGLE_AUTH_TIMEOUT' || /timed out|timeout/i.test(errMsg)){
      toast('Google authorization timed out. Please allow popups, wait a few seconds, and try again.','warn');
    } else if(errMsg === 'GOOGLE_IDENTITY_LOAD_FAILED'){
      toast('Google Identity service did not load. Check internet/ad blocker and try again.','warn');
    } else if(errMsg === 'GOOGLE_ACCESS_DENIED' || /access_denied/i.test(errMsg)){
      toast('Google Drive permission was denied. Please allow access to upload files.','warn');
    } else if(/popup|blocked/i.test(errMsg)){
      toast('Google auth popup blocked. Allow popups in browser settings.','warn');
    } else if(/interaction_required|consent_required/i.test(errMsg)){
      toast('Google authorization required. Click upload again and allow access.','warn');
    } else {
      console.error('File upload failed:', name, errMsg);
      toast('Upload failed for '+name+': '+errMsg,'warn');
    }
  });

  if(newFilesMeta.length){
    await saveFileMeta(newFilesMeta);
    await refreshShared();
    const currentFolderFiles = filesOf(activeId);
    console.log('✅ Post-upload folder metadata count:', currentFolderFiles.length, { folderName, folderId: activeId, folderFiles: currentFolderFiles.map(f=>({name:f.name,key:f.key,driveFileId:f.driveFileId})) });
    renderSidebar();
    renderMain();
    toast(newFilesMeta.length+' file'+(newFilesMeta.length>1?'s':'')+' uploaded ✓');
    setSyncUI('app','synced');
  } else {
    setSyncUI('app','offline');
  }
}

// ================================================================
// ENTER VESSEL
// ================================================================
async function enterVessel(vesselId){
  await refreshShared();
  activeVesselId = vesselId;
  const v  = vessels.find(x=>x.id===vesselId);
  document.getElementById('fleetScreen').style.display = 'none';
  document.getElementById('app').style.display         = 'flex';
  document.getElementById('activeVesselName').textContent = v ? v.name : 'Vessel';
  document.getElementById('statVessel').textContent       = v ? v.name : '—';
  document.getElementById('statFlag').textContent         = v ? v.flag || '—' : '—';
  document.getElementById('statIMO').textContent          = v ? v.imo || '—' : '—';
  document.getElementById('statType').textContent         = v ? ({
    tanker: 'Tanker',
    bulk: 'Bulk Carrier',
    cargo: 'General Cargo',
    tug: 'Tug / Workboat',
    barge: 'Barge'
  }[v.type] || v.type || '—') : '—';
  document.getElementById('statYear').textContent         = v ? v.year || '—' : '—';
  document.getElementById('statUser').textContent         = currentUser.name;
  activeId = null;
  searchQ  = '';
  document.getElementById('searchBox').value = '';
  renderSidebar();
  const vfolders = folders.filter(f=>f.vesselId===activeVesselId);
  if(vfolders.length){
    const firstWithFiles = vfolders.find(f=>filesOf(f.id).length>0);
    selectFolder(firstWithFiles ? firstWithFiles.id : vfolders[0].id);
  }
}

// ================================================================
// SIDEBAR
// ================================================================
function gf(id){ return folders.find(f=>f.id===id); }
function folderPath(id){
  const path = [];
  let current = gf(id);
  while(current){
    path.unshift(current.name);
    current = current.parentId ? gf(current.parentId) : null;
  }
  return path;
}
function filesOf(fid){
  const direct = files.filter(f=>f.folderId===fid);
  const childIds = folders.filter(f=>f.parentId===fid).map(f=>f.id);
  const nested = files.filter(f=>childIds.includes(f.folderId));
  return [...direct, ...nested];
}
function vesselFolders(){ return folders.filter(f=>f.vesselId===activeVesselId); }

function updateStats(){
  const vf     = vesselFolders();
  const allFolderIds = vf.map(f=>f.id);
  const vfiles = files.filter(f=>allFolderIds.includes(f.folderId));
  document.getElementById('statF').textContent    = vf.length;
  document.getElementById('statM').textContent    = vfiles.length;
  document.getElementById('sbCount').textContent  = vf.filter(f=>!f.parentId).length;
}

const expandedFolders = new Set();
function renderSidebar(){
  updateRoleUI();
  const list = document.getElementById('folderList');
  const q    = searchQ.toLowerCase();
  list.innerHTML = '';
  const vf    = vesselFolders();
  const roots = vf.filter(f=>!f.parentId);
  roots.forEach(f=>{
    const children = vf.filter(c=>c.parentId===f.id);
    const ffiles   = filesOf(f.id);
    const allF     = [...ffiles, ...children.flatMap(c=>filesOf(c.id))];
    const match    = !q || f.name.toLowerCase().includes(q) || allF.some(x=>x.name.toLowerCase().includes(q));
    if(!match) return;
    const isEx = expandedFolders.has(f.id) || !!q;
    const nm   = f.name.match(/^(\d+)\./);
    const num  = nm ? nm[1] : '';
    const d    = document.createElement('div');
    d.className = 'fi'+(f.id===activeId?' active':'');
    d.innerHTML = `
      <span class="fi-num">${num}</span>
      <i class="ti ti-folder${isEx&&children.length?'-open':''}"></i>
      <span class="fi-nm" title="${f.name}">${f.name.replace(/^\d+\.\s*/,'')}</span>
      <span class="fi-ct">${ffiles.length}</span>
      ${children.length?`<span class="fi-expand" data-fid="${f.id}"><i class="ti ti-chevron-${isEx?'down':'right'}"></i></span>`:''}
      ${canManageLibrary()?`<button class="fi-addsub" data-pid="${f.id}" title="Add Sub-folder"><i class="ti ti-folder-plus"></i></button>`:''}`;
    d.querySelector('.fi-nm').onclick = ()=>selectFolder(f.id);
    d.querySelector('.fi-ct').onclick = ()=>selectFolder(f.id);
    const ex = d.querySelector('.fi-expand');
    if(ex) ex.onclick = e=>{ e.stopPropagation(); toggleExpand(f.id); };
    const addSubBtn = d.querySelector('.fi-addsub');
    if(addSubBtn) addSubBtn.onclick = e=>{ e.stopPropagation(); openAddSubFolder(f.id); };
    list.appendChild(d);
    if((isEx||q) && children.length){
      children.forEach(c=>{
        const cf = filesOf(c.id);
        const cm = !q || c.name.toLowerCase().includes(q) || cf.some(x=>x.name.toLowerCase().includes(q));
        if(!cm) return;
        const cd = document.createElement('div');
        cd.className = 'fi fi-sub'+(c.id===activeId?' active':'');
        cd.innerHTML = `<span class="fi-sub-indent"></span><i class="ti ti-folder"></i><span class="fi-nm" title="${c.name}">${c.name}</span><span class="fi-ct">${cf.length}</span>`;
        cd.onclick = ()=>selectFolder(c.id);
        list.appendChild(cd);
      });
    }
  });
  updateStats();
}
function toggleExpand(fid){ if(expandedFolders.has(fid)) expandedFolders.delete(fid); else expandedFolders.add(fid); renderSidebar(); }

let _subPid = null;
function openAddSubFolder(pid){
  if(!canManageLibrary()){ toast('Sub-folder creation is admin-only.','warn'); return; }
  _subPid = pid;
  const bar = document.getElementById('afBar');
  document.getElementById('afInp').value       = '';
  document.getElementById('afInp').placeholder = 'Sub-folder name…';
  document.getElementById('afLabel').textContent = '+ SUB-FOLDER';
  bar.classList.add('show');
  expandedFolders.add(pid);
  setTimeout(()=>document.getElementById('afInp').focus(), 40);
}

// ================================================================
// MAIN PANEL
// ================================================================
function renderMain(){
  const mw = document.getElementById('mainWrap');
  const f  = gf(activeId);
  if(!f){ mw.innerHTML='<div class="nofolder"><i class="ti ti-folders"></i><div class="nofolder-title">Select a System Folder</div><div class="nofolder-sub">Choose from the panel on the left</div></div>'; return; }
  
  const canEdit = canManageLibrary();
  const q       = searchQ.toLowerCase();
  const ffiles  = filesOf(activeId);
  const shown   = q ? ffiles.filter(x=>x.name.toLowerCase().includes(q)) : ffiles;
  
  console.log('📍 renderMain called for folder:', f.name);
  console.log('📊 filesOf returned:', ffiles.length, 'files');
  console.log('🔍 After search filter (q="'+q+'"):', shown.length, 'files');
  
  const pathParts = folderPath(activeId);
  const breadcrumb = `${vessels.find(v=>v.id===activeVesselId)?.name || 'Unknown Vessel'} > ${pathParts.join(' > ')}`;
  mw.innerHTML = `<div class="ph">
    <div style="flex:1;min-width:100px" id="titleArea">
      <div class="pbreadcrumb" id="breadcrumbArea">${encodeHTML(breadcrumb)}</div>
      <div class="ptitle" id="panelTitle">${f.name}</div>
    </div>
    <span class="psub">${shown.length} DOC${shown.length!==1?'S':''}</span>
    ${canEdit?`<button class="pbtn" onclick="startRename()"><i class="ti ti-pencil"></i> Rename</button>`:''}
    ${canEdit?`<button class="pbtn danger" onclick="deleteFolder()"><i class="ti ti-trash"></i> Delete</button>`:''}
  </div>
  ${canEdit?`<div class="dz" id="dz">
    <div style="position:relative;pointer-events:none">
      <i class="ti ti-cloud-upload dz-ico"></i>
      <div class="dz-txt">Drag &amp; drop PDF files here &nbsp;&#xb7;&nbsp; <em>click to browse</em></div>
      <div class="dz-hint">PDF metadata synced to all users instantly</div>
    </div>
    <input type="file" id="fp" accept=".pdf,application/pdf,.xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple>
  </div>`:``}
  <div class="fscroll"><div id="filesList"></div></div>`;
  const dz = document.getElementById('dz');
  const fp = document.getElementById('fp');

  if(dz && fp){
    // Click to open file dialog after auth is available.
    dz.addEventListener('click', () => {
      if(!canEdit) return;
      // Start loading Google Identity script in background; don't block UI
      loadGoogleIdentityScript().catch(err=>console.warn('Could not preload Google auth script:', err));
      fp.click();
    });

    dz.addEventListener('dragenter', e=>{ e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragover',  e=>{ e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', e=>{ if(!dz.contains(e.relatedTarget)) dz.classList.remove('over'); });
    dz.addEventListener('drop',      e=>{ e.preventDefault(); dz.classList.remove('over'); handleFiles(e.dataTransfer.files); });
    fp.addEventListener('change',    e=>{ handleFiles(e.target.files); e.target.value=''; });
  }
  renderFilesList(shown);
}

function renderFilesList(shown){
  const el = document.getElementById('filesList');
  if(!el) return;
  
  console.log('🎨 renderFilesList called with:', shown.length, 'files');
  console.log('📋 Files shown:', shown.map(f=>({name: f.name, folderId: f.folderId, driveFileId: f.driveFileId})));

  const canEdit = canManageLibrary();

  if(!shown || shown.length===0){ 
    console.log('📌 No files to display');
    el.innerHTML = canEdit
      ? '<div class="empty"><i class="ti ti-file-off"></i><p>No documents — drop PDFs above</p></div>'
      : '<div class="empty"><i class="ti ti-file-off"></i><p>No documents available in this folder.</p></div>'; 
    return; 
  }
  let html = `<table class="ft"><thead><tr>
    <th style="width:36px"></th><th>Document</th>
    <th style="width:100px">Uploaded By</th>
    <th style="text-align:right;width:80px">Size</th>
    ${canEdit?'<th style="width:40px"></th>':''}
  </tr></thead><tbody>`;
  shown.forEach(file=>{
    html += `<tr class="fr" data-key="${file.key}" data-drive="${file.driveFileId||''}" data-excel="${file.excelDriveFileId||''}">
      <td class="td-ico"><i class="ti ti-file-type-pdf"></i></td>
      <td class="td-nm">${file.name}<span class="td-hint">&#x2197; open</span></td>
      <td class="td-who">${file.by||'—'}</td>
      <td class="td-sz">${file.size}</td>
      ${canEdit?`<td class="td-dl"><button class="dlbtn" data-del="${file.key}" data-drive="${file.driveFileId||''}" title="Remove"><i class="ti ti-trash"></i></button></td>`:''}
    </tr>`;
  });
  html += '</tbody></table>';
  el.innerHTML = html;
  console.log('✓ Rendered', shown.length, 'files in table');
  
  el.querySelectorAll('tr.fr').forEach(tr=>{
    tr.onclick = async e=>{
      if(e.target.closest('.dlbtn')) return;
      const driveId = tr.dataset.drive;
      const meta    = files.find(f=>f.key===tr.dataset.key);
      if(!driveId){ toast('No Drive file linked. Re-upload to view.','warn'); return; }
      const url = `https://drive.google.com/file/d/${driveId}/preview`;
      openPdfViewer(url, meta ? meta.name : 'Document');
    };
  });
  el.querySelectorAll('.dlbtn').forEach(btn=>{
    btn.onclick = async e=>{
      e.stopPropagation();
      const key = btn.dataset.del;
      setSyncUI('app','syncing');
      const fileToRemove = files.find(f=>f.key===key);
      if(fileToRemove){
        await deleteTrackedFile(fileToRemove);
      } else {
        files = files.filter(f=>f.key!==key);
      }
      await saveFileMeta();
      setSyncUI('app','synced');
      renderSidebar(); renderMain();
      toast('File removed');
    };
  });
}

function openExcelApp(excelId){
  if(!excelId) return toast('Excel not available for this document','warn');
  // Prefer exporting Google Sheets to .xlsx if it's a Sheets file
  const exportUrl = 'https://docs.google.com/spreadsheets/d/'+encodeURIComponent(excelId)+'/export?format=xlsx';
  const downloadUrl = 'https://drive.google.com/uc?export=download&id='+encodeURIComponent(excelId);
  // Try opening the direct Drive download URL in desktop Excel first (works for native Excel files).
  try{
    const proto = 'ms-excel:ofe|u|'+downloadUrl;
    const a = document.createElement('a'); a.href = proto; a.style.display='none'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    // If the protocol handler isn't available, after a short delay open export URL (for Sheets) as fallback.
    setTimeout(()=>{ window.open(exportUrl, '_blank'); }, 900);
  }catch(err){
    console.warn('Protocol open failed, falling back to download/export', err);
    // Final fallback: open download URL in new tab so user can download and open manually.
    window.open(downloadUrl, '_blank');
  }
}

function selectFolder(id){ activeId=id; renderSidebar(); renderMain(); }
function onSearch(val){ searchQ=val; renderSidebar(); if(activeId) renderMain(); }

function startRename(){
  if(!canManageLibrary()){ toast('Rename is admin-only.','warn'); return; }
  const f = gf(activeId); if(!f) return;
  const ta = document.getElementById('titleArea');
  ta.innerHTML = `<input class="rn-inp" id="rnInp" value="${f.name}" onkeydown="rnKey(event)" onblur="commitRename()">`;
  const inp = document.getElementById('rnInp'); inp.focus(); inp.select();
}
function rnKey(e){ if(e.key==='Enter') document.getElementById('rnInp').blur(); if(e.key==='Escape') renderMain(); }
async function commitRename(){
  if(!canManageLibrary()){ renderMain(); return; }
  const inp = document.getElementById('rnInp'); if(!inp) return;
  const f   = gf(activeId);
  if(f && inp.value.trim()){ f.name = inp.value.trim().toUpperCase(); await saveFolders(); }
  renderSidebar(); renderMain(); toast('Folder renamed');
}

async function deleteFolder(){
  if(!canManageLibrary()){ toast('Delete is admin-only.','warn'); return; }
  if(!activeId) return;
  const toIds = [activeId, ...folders.filter(f=>f.parentId===activeId).map(f=>f.id)];
  for(const fid of toIds){
    const toDel = filesOf(fid);
    for(const f of toDel){
      await deleteTrackedFile(f);
    }
    files   = files.filter(f=>f.folderId!==fid);
    folders = folders.filter(f=>f.id!==fid);
  }
  await saveFolders(); await saveFileMeta();
  const vfolders = vesselFolders();
  activeId = vfolders.length ? vfolders[0].id : null;
  renderSidebar();
  if(activeId) renderMain();
  else document.getElementById('mainWrap').innerHTML='<div class="nofolder"><i class="ti ti-folders"></i><div class="nofolder-title">Select a System Folder</div><div class="nofolder-sub">Choose from the panel on the left</div></div>';
  toast('Folder deleted');
}

function toggleAddFolder(){
  if(!canManageLibrary()){ toast('Folder creation is admin-only.','warn'); return; }
  _subPid = null;
  const bar  = document.getElementById('afBar');
  const show = !bar.classList.contains('show');
  bar.classList.toggle('show', show);
  if(show){
    document.getElementById('afInp').placeholder       = 'Folder name…';
    document.getElementById('afLabel').textContent     = '+ FOLDER';
    setTimeout(()=>document.getElementById('afInp').focus(), 40);
  }
}
function afKey(e){ if(e.key==='Enter') confirmAdd(); if(e.key==='Escape'){ toggleAddFolder(); _subPid=null; } }
async function confirmAdd(){
  if(!canManageLibrary()){ toast('Folder creation is admin-only.','warn'); return; }
  const val = document.getElementById('afInp').value.trim().toUpperCase();
  if(!val) return;
  const obj = {id:'f_'+uid(), name:val, vesselId:activeVesselId, createdBy:currentUser.u, createdAt:Date.now()};
  if(_subPid) obj.parentId = _subPid;
  folders.push(obj);
  await saveFolders();
  document.getElementById('afInp').value = '';
  document.getElementById('afBar').classList.remove('show');
  _subPid = null;
  activeId = obj.id;
  renderSidebar();
  renderMain();
  toast('Folder added');
}

// ================================================================
// TOAST
// ================================================================
function toast(msg, type=''){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show'+(type?' '+type:'');
  clearTimeout(t._t);
  t._t = setTimeout(()=>t.classList.remove('show'), 2800);
}

// ================================================================
// PDF VIEWER
// ================================================================
let _pvUrl = null;
let _pdfDoc = null;
let _pdfPageNum = 1;
let _pdfPageCount = 0;
let _pdfScale = 1.25;
let _pdfFindQuery = '';
let _pdfFindResults = [];
let _pdfFindIndex = -1;

function normalizePdfUrl(url){
  const raw = String(url||'').trim();
  const match = raw.match(/(?:file\/d\/|open\?id=|id=)([a-zA-Z0-9_-]{10,})/);
  if(match){
    return 'https://drive.google.com/uc?export=download&id='+match[1];
  }
  return raw;
}

async function getPdfArrayBuffer(url){
  // Attempt to fetch PDF from network first. If network fails or we're offline,
  // fall back to a locally cached copy in IndexedDB (if available).
  // For Google Drive links, normalize to the uc?export=download form.
  const driveMatch = String(url||'').match(/(?:file\/d\/|open\?id=|id=)([a-zA-Z0-9_-]{10,})/);
  const normalizedUrl = driveMatch ? ('https://drive.google.com/uc?export=download&id='+driveMatch[1]) : url;

  // Try network fetch when online and offline mode is not forced
  if(!OFFLINE_MODE){
    try{
      const res = await fetchWithTimeout(normalizedUrl, { credentials: 'include' }, 30000);
      if(res.ok){
        const buf = await res.arrayBuffer();
        // Cache successful fetch for offline use
        try{ await savePdfToCache(normalizedUrl, buf); } catch(e){ console.warn('PDF cache save failed', e); }
        return buf;
      }
      throw new Error('Network fetch failed: '+res.status);
    } catch(err){
      console.warn('Network PDF fetch failed, trying cache:', err.message || err);
    }
  }

  // If we reach here, either OFFLINE_MODE is enabled or network fetch failed.
  // Try to read from cache.
  try{
    const cached = await getPdfFromCache(normalizedUrl);
    if(cached){
      console.log('Loaded PDF from cache for', normalizedUrl);
      // Show offline banner when serving cached PDF
      document.getElementById('pvOfflineBanner').style.display = 'flex';
      return cached;
    }
  } catch(e){ console.warn('PDF cache read failed', e); }

  // Final fallback: attempt network fetch without caching
  const finalRes = await fetchWithTimeout(normalizedUrl, { credentials: 'include' }, 30000);
  if(!finalRes.ok) throw new Error('PDF fetch failed: '+finalRes.status);
  return await finalRes.arrayBuffer();
}

// -------------------------
// IndexedDB PDF cache utils
// -------------------------
const PDF_CACHE_DB = 'vmms_pdf_cache_v1';
const PDF_CACHE_STORE = 'pdfs';

function openPdfCacheDb(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PDF_CACHE_DB, 1);
    req.onupgradeneeded = function(e){
      const db = e.target.result;
      if(!db.objectStoreNames.contains(PDF_CACHE_STORE)){
        db.createObjectStore(PDF_CACHE_STORE, { keyPath: 'url' });
      }
    };
    req.onsuccess = function(e){ resolve(e.target.result); };
    req.onerror = function(e){ reject(e.target.error || new Error('IndexedDB open failed')); };
  });
}

async function savePdfToCache(url, arrayBuffer){
  try{
    const db = await openPdfCacheDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PDF_CACHE_STORE, 'readwrite');
      const store = tx.objectStore(PDF_CACHE_STORE);
      const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
      const entry = { url, blob, at: Date.now() };
      const req = store.put(entry);
      req.onsuccess = () => { resolve(true); };
      req.onerror = (e) => { reject(e.target.error || new Error('Save failed')); };
    });
  }catch(err){ console.warn('savePdfToCache error', err); }
}

async function getPdfFromCache(url){
  try{
    const db = await openPdfCacheDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PDF_CACHE_STORE, 'readonly');
      const store = tx.objectStore(PDF_CACHE_STORE);
      const req = store.get(url);
      req.onsuccess = function(e){
        const rec = e.target.result;
        if(!rec || !rec.blob){ resolve(null); return; }
        const reader = new FileReader();
        reader.onload = function(){ resolve(reader.result); };
        reader.onerror = function(err){ reject(err); };
        reader.readAsArrayBuffer(rec.blob);
      };
      req.onerror = function(e){ reject(e.target.error || new Error('IndexedDB read failed')); };
    });
  }catch(err){ console.warn('getPdfFromCache error', err); return null; }
}

async function openPdfViewer(url, name){
  _pvUrl = url;
  _pdfFindQuery = '';
  _pdfFindResults = [];
  _pdfFindIndex = -1;
  document.getElementById('pvTitle').textContent    = name || 'Document';
  document.getElementById('pvSearch').value         = '';
  document.getElementById('pvSearchInfo').textContent = '';
  // reset offline banner each time we open
  try{ document.getElementById('pvOfflineBanner').style.display = 'none'; }catch(e){}
  document.getElementById('pdfOverlay').classList.add('open');
  try {
    await loadPdf(normalizePdfUrl(url));
    // If we successfully loaded from network and not in forced offline, hide banner
    if(!OFFLINE_MODE){ try{ document.getElementById('pvOfflineBanner').style.display = 'none'; }catch(e){} }
  } catch(err){
    console.error('PDF open error', err);
    toast('Unable to load PDF inside app; opening in new tab','warn');
    closePdfViewer();
    window.open(url, '_blank');
  }
}

function closePdfViewer(){
  document.getElementById('pdfOverlay').classList.remove('open');
  if(_pdfDoc){ _pdfDoc.destroy(); _pdfDoc = null; }
  const canvas = document.getElementById('pdfCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  _pvUrl = null;
  _pdfPageNum = 1;
  _pdfPageCount = 0;
  _pdfFindQuery = '';
  _pdfFindResults = [];
  _pdfFindIndex = -1;
  document.getElementById('pvSearch').value          = '';
  document.getElementById('pvSearchInfo').textContent = '';
  document.getElementById('pdfPageIndicator').textContent = 'Page 0 / 0';
}

async function loadPdf(url){
  const data = await getPdfArrayBuffer(url);
  const loadingTask = pdfjsLib.getDocument({ data });
  _pdfDoc = await loadingTask.promise;
  _pdfPageCount = _pdfDoc.numPages;
  _pdfPageNum = 1;
  _pdfFindQuery = '';
  _pdfFindResults = [];
  _pdfFindIndex = -1;
  await renderPdfPage(_pdfPageNum);
}

async function renderPdfPage(pageNum){
  if(!_pdfDoc) return;
  const page = await _pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: _pdfScale });
  const canvas = document.getElementById('pdfCanvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  document.getElementById('pdfPageIndicator').textContent = `Page ${pageNum} / ${_pdfPageCount}`;
}

async function pvSearchText(val){
  if(!_pdfDoc) return;
  const query = String(val||'').trim().toLowerCase();
  if(!query){
    _pdfFindQuery = '';
    _pdfFindResults = [];
    _pdfFindIndex = -1;
    document.getElementById('pvSearchInfo').textContent = '';
    return;
  }
  if(query !== _pdfFindQuery){
    _pdfFindQuery = query;
    _pdfFindResults = [];
    _pdfFindIndex = -1;
    document.getElementById('pvSearchInfo').textContent = 'Searching...';
    for(let i = 1; i <= _pdfPageCount; i++){
      const page = await _pdfDoc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map(item=>item.str).join(' ').toLowerCase();
      if(text.includes(query)){
        _pdfFindResults.push(i);
      }
    }
    if(_pdfFindResults.length === 0){
      document.getElementById('pvSearchInfo').textContent = 'No matches';
      return;
    }
    _pdfFindIndex = 0;
  }
  if(_pdfFindResults.length){
    _pdfPageNum = _pdfFindResults[_pdfFindIndex];
    await renderPdfPage(_pdfPageNum);
    document.getElementById('pvSearchInfo').textContent = `Match ${_pdfFindIndex + 1} / ${_pdfFindResults.length} on page ${_pdfPageNum}`;
  }
}

async function pvNext(){
  if(!_pdfDoc || !_pdfFindResults.length) return;
  _pdfFindIndex = Math.min(_pdfFindIndex + 1, _pdfFindResults.length - 1);
  _pdfPageNum = _pdfFindResults[_pdfFindIndex];
  await renderPdfPage(_pdfPageNum);
  document.getElementById('pvSearchInfo').textContent = `Match ${_pdfFindIndex + 1} / ${_pdfFindResults.length} on page ${_pdfPageNum}`;
}

async function pvPrev(){
  if(!_pdfDoc || !_pdfFindResults.length) return;
  _pdfFindIndex = Math.max(_pdfFindIndex - 1, 0);
  _pdfPageNum = _pdfFindResults[_pdfFindIndex];
  await renderPdfPage(_pdfPageNum);
  document.getElementById('pvSearchInfo').textContent = `Match ${_pdfFindIndex + 1} / ${_pdfFindResults.length} on page ${_pdfPageNum}`;
}

function pvSearchKey(e){
  if(e.key==='Enter'){
    e.preventDefault();
    pvSearchText(document.getElementById('pvSearch').value);
  }
  if(e.key==='Escape') closePdfViewer();
}

function downloadCurrentPdf(){
  if(!_pvUrl){ toast('No document selected','warn'); return; }
  const match = _pvUrl.match(/(?:\/d\/|id=)([a-zA-Z0-9_-]{10,})/);
  const driveId = match ? match[1] : null;
  if(!driveId){
    toast('Unable to determine Drive file ID','warn');
    return;
  }
  const dlUrl = 'https://drive.google.com/uc?export=download&id='+encodeURIComponent(driveId);
  const anchor = document.createElement('a');
  anchor.href = dlUrl;
  anchor.setAttribute('download', `${driveId}.pdf`);
  anchor.target = '_blank';
  anchor.rel = 'noreferrer noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

// ================================================================
// INIT
// ================================================================
boot();
document.getElementById('addVesselModal').addEventListener('click', function(e){ if(e.target===this) closeAddVessel(); });
document.getElementById('pvDownloadBtn')?.addEventListener('click', downloadCurrentPdf);
document.getElementById('pvPrevBtn')?.addEventListener('click', pvPrev);
document.getElementById('pvNextBtn')?.addEventListener('click', pvNext);
document.getElementById('pvZoomIn')?.addEventListener('click', () => { _pdfScale += 0.1; renderPdfPage(_pdfPageNum); });
document.getElementById('pvZoomOut')?.addEventListener('click', () => { _pdfScale = Math.max(0.5, _pdfScale - 0.1); renderPdfPage(_pdfPageNum); });
document.getElementById('pvZoomReset')?.addEventListener('click', () => { _pdfScale = 1.25; renderPdfPage(_pdfPageNum); });
document.getElementById('pdfOverlay')?.addEventListener('click', function(e){ if(e.target===this) closePdfViewer(); });
