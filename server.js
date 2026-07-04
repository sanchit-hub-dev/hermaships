const path = require('path');
const fs = require('fs');
const dns = require('dns');
const crypto = require('crypto');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { MongoClient, ServerApiVersion } = require('mongodb');

try {
  dns.setServers(['1.1.1.1', '8.8.8.8']);
  console.log('Using public DNS servers for MongoDB SRV resolution');
} catch (err) {
  console.warn('Could not set DNS servers for SRV lookup:', err);
}

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MONGO_URI = process.env.MONGODB_URI || '';
const MONGO_DB_NAME = process.env.MONGODB_DB || 'vmms';

let dbClient = null;
let db = null;
let usersCol = null;
let vesselsCol = null;
let foldersCol = null;
let filesCol = null;
let shareLinksCol = null;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

function sendPublicFile(res, fileName){
  const publicPath = path.join(PUBLIC_DIR, fileName);
  const rootPath = path.join(__dirname, fileName);
  if (fs.existsSync(publicPath)) return res.sendFile(publicPath);
  return res.sendFile(rootPath);
}

// Explicit static asset routes prevent Render/browser MIME issues.
app.get('/app.js', (req, res) => {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  sendPublicFile(res, 'app.js');
});
app.get('/styles.css', (req, res) => {
  res.type('text/css');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  sendPublicFile(res, 'styles.css');
});
app.get('/coral_logo_transparent.png', (req, res) => {
  res.type('image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  sendPublicFile(res, 'coral_logo_transparent.png');
});
app.get('/fix-pdfjs.js', (req, res) => {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  sendPublicFile(res, 'fix-pdfjs.js');
});

app.get('/share.js', (req, res) => {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  sendPublicFile(res, 'share.js');
});
app.get('/share.css', (req, res) => {
  res.type('text/css');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  sendPublicFile(res, 'share.css');
});

app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) res.type('application/javascript');
    if (filePath.endsWith('.css')) res.type('text/css');
  }
}));

app.use(express.static(path.join(__dirname), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) res.type('application/javascript');
    if (filePath.endsWith('.css')) res.type('text/css');
  }
}));

const defaultStore = {
  users: [],
  vessels: [],
  folders: [],
  files: [],
  shareLinks: []
};

async function initializeDb() {
  if (!MONGO_URI) {
    console.warn('No MONGODB_URI provided; falling back to local JSON persistence.');
    return;
  }

  dbClient = new MongoClient(MONGO_URI, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true
    },
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  await dbClient.connect();
  db = dbClient.db(MONGO_DB_NAME);
  usersCol = db.collection('users');
  vesselsCol = db.collection('vessels');
  foldersCol = db.collection('folders');
  filesCol = db.collection('files');
  shareLinksCol = db.collection('shareLinks');

  await usersCol.createIndex({ username: 1 }, { unique: true });
  await vesselsCol.createIndex({ id: 1 }, { unique: true });
  await foldersCol.createIndex({ id: 1 }, { unique: true });
  await filesCol.createIndex({ key: 1 }, { unique: true });
  await shareLinksCol.createIndex({ token: 1 }, { unique: true });
  await shareLinksCol.createIndex({ vessel_id: 1 });

  await seedFixedUsers();
  await syncLocalStoreToMongo();

  console.log('Connected to MongoDB Atlas database:', MONGO_DB_NAME);
}

async function syncLocalStoreToMongo() {
  if (!usersCol || !vesselsCol || !foldersCol || !filesCol || !shareLinksCol) return;

  const local = loadStore();
  const hasAnyData = [local.users, local.vessels, local.folders, local.files, local.shareLinks].some(arr => Array.isArray(arr) && arr.length > 0);
  if (!hasAnyData) return;

  const userOps = [];
  const vesselOps = [];
  const folderOps = [];
  const fileOps = [];
  const shareOps = [];

  if (Array.isArray(local.users) && local.users.length) {
    local.users.forEach(user => {
      userOps.push({
        updateOne: {
          filter: { username: normalizeUsername(user.username) },
          update: { $set: {
            username: normalizeUsername(user.username),
            full_name: user.full_name || user.name || user.username,
            role: user.role || 'user',
            password_hash: user.password_hash || ''
          } },
          upsert: true
        }
      });
    });
  }

  if (Array.isArray(local.vessels) && local.vessels.length) {
    local.vessels.forEach(item => {
      vesselOps.push({
        updateOne: {
          filter: { id: item.id },
          update: { $set: toVesselDoc(item) },
          upsert: true
        }
      });
    });
  }

  if (Array.isArray(local.folders) && local.folders.length) {
    local.folders.forEach(item => {
      folderOps.push({
        updateOne: {
          filter: { id: item.id },
          update: { $set: toFolderDoc(item) },
          upsert: true
        }
      });
    });
  }

  if (Array.isArray(local.files) && local.files.length) {
    local.files.forEach(item => {
      fileOps.push({
        updateOne: {
          filter: { key: item.key },
          update: { $set: toFileDoc(item) },
          upsert: true
        }
      });
    });
  }

  if (Array.isArray(local.shareLinks) && local.shareLinks.length) {
    local.shareLinks.forEach(item => {
      shareOps.push({
        updateOne: {
          filter: { token: item.token },
          update: { $set: {
            id: item.id || ('share_' + crypto.randomBytes(8).toString('hex')),
            vessel_id: item.vessel_id || item.vesselId || '',
            token: item.token,
            allow_download: item.allow_download ?? item.allowDownload ?? 1,
            is_active: item.is_active ?? item.isActive ?? 1,
            created_by: item.created_by || item.createdBy || '',
            created_at: item.created_at || item.createdAt || Date.now(),
            expires_at: item.expires_at || item.expiresAt || ''
          } },
          upsert: true
        }
      });
    });
  }

  const collectionsToWrite = [
    { collection: usersCol, ops: userOps },
    { collection: vesselsCol, ops: vesselOps },
    { collection: foldersCol, ops: folderOps },
    { collection: filesCol, ops: fileOps },
    { collection: shareLinksCol, ops: shareOps }
  ];

  for (const entry of collectionsToWrite) {
    if (!entry.collection || !entry.ops.length) continue;
    const batchSize = 500;
    for (let i = 0; i < entry.ops.length; i += batchSize) {
      await entry.collection.bulkWrite(entry.ops.slice(i, i + batchSize));
    }
  }

  console.log('✓ Local JSON data imported into MongoDB collections');
}

async function seedFixedUsers() {
  if (!usersCol) return;
  const ops = FIXED_USERS.map(user => ({
    updateOne: {
      filter: { username: normalizeUsername(user.username) },
      update: {
        $set: {
          username: normalizeUsername(user.username),
          full_name: user.full_name,
          role: user.role,
          password_hash: bcrypt.hashSync(user.password, 10)
        }
      },
      upsert: true
    }
  }));
  if (ops.length) await usersCol.bulkWrite(ops);
  console.log('✓ Fixed login users seeded into database');
}

function useDb() {
  return !!db;
}

function loadStore() {
  try {
    if (!fs.existsSync(DB_PATH)) return { ...defaultStore };
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      vessels: Array.isArray(parsed.vessels) ? parsed.vessels : [],
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
      files: Array.isArray(parsed.files) ? parsed.files : [],
      shareLinks: Array.isArray(parsed.shareLinks) ? parsed.shareLinks : []
    };
  } catch (err) {
    console.error('Failed to load data store, falling back to empty state', err);
    return { ...defaultStore };
  }
}

function saveStore(store) {
  try {
    const tempPath = DB_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tempPath, DB_PATH);
    return true;
  } catch (err) {
    console.error('Failed to save data store', err);
    return false;
  }
}

let store = loadStore();

function toVesselDoc(item) {
  return {
    id: item.id,
    name: item.name || '',
    imo: item.imo || '',
    type: item.type || '',
    flag: item.flag || '',
    year: item.year || '',
    image_url: item.imageUrl || item.image_url || '',
    created_at: item.created_at || Date.now()
  };
}

function toFolderDoc(item) {
  return {
    id: item.id,
    name: item.name || '',
    vessel_id: item.vesselId || item.vessel_id || '',
    parent_id: item.parentId || item.parent_id || null,
    created_by: item.createdBy || item.created_by || '',
    created_at: item.created_at || Date.now()
  };
}

function toFileDoc(item) {
  return {
    key: item.key,
    folder_id: item.folderId || item.folder_id || '',
    vessel_id: item.vesselId || item.vessel_id || '',
    name: item.name || '',
    size: item.size || '',
    created_by: item.by || item.created_by || '',
    created_at: item.at || item.created_at || Date.now(),
    drive_file_id: item.driveFileId || item.drive_file_id || '',
    excel_drive_file_id: item.excelDriveFileId || item.excel_drive_file_id || ''
  };
}

function mapVesselDoc(doc) {
  return {
    id: doc.id,
    name: doc.name,
    imo: doc.imo,
    type: doc.type,
    flag: doc.flag,
    year: doc.year,
    imageUrl: doc.image_url || '',
    created_at: doc.created_at || Date.now()
  };
}

function mapFolderDoc(doc) {
  return {
    id: doc.id,
    name: doc.name,
    vesselId: doc.vessel_id,
    parentId: doc.parent_id || null,
    createdBy: doc.created_by || '',
    created_at: doc.created_at || Date.now()
  };
}

function mapFileDoc(doc) {
  return {
    key: doc.key,
    folderId: doc.folder_id,
    vesselId: doc.vessel_id,
    name: doc.name,
    size: doc.size,
    by: doc.created_by || '',
    at: doc.created_at || Date.now(),
    driveFileId: doc.drive_file_id || '',
    excelDriveFileId: doc.excel_drive_file_id || ''
  };
}

function sendError(res, message, code = 400) {
  return res.status(code).json({ ok: false, error: message });
}

function sendSuccess(res, data = {}) {
  return res.json({ ok: true, ...data });
}

function validatePayload(body) {
  if (!body || typeof body !== 'object') return false;
  if (typeof body.action !== 'string') return false;
  return true;
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

// Fixed application users. Registration is disabled from backend.

function makeShareToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function normalizeShareLink(doc) {
  return {
    id: doc.id || doc._id || ('share_'+crypto.randomBytes(8).toString('hex')),
    vesselId: doc.vessel_id || doc.vesselId,
    token: doc.token,
    allowDownload: doc.allow_download !== 0 && doc.allowDownload !== false,
    isActive: doc.is_active !== 0 && doc.isActive !== false,
    createdBy: doc.created_by || doc.createdBy || '',
    createdAt: doc.created_at || doc.createdAt || Date.now(),
    expiresAt: doc.expires_at || doc.expiresAt || ''
  };
}

async function findShareByToken(token) {
  if (useDb()) {
    const doc = await shareLinksCol.findOne({ token, is_active: { $ne: 0 } });
    return doc ? normalizeShareLink(doc) : null;
  }
  const row = (store.shareLinks || []).find(x => x.token === token && x.is_active !== 0 && x.isActive !== false);
  return row ? normalizeShareLink(row) : null;
}

async function getPublicShareData(token) {
  const share = await findShareByToken(token);
  if (!share) return null;
  if (share.expiresAt && Date.now() > new Date(share.expiresAt).getTime()) return null;

  if (useDb()) {
    const [vesselDoc, folderDocs, fileDocs] = await Promise.all([
      vesselsCol.findOne({ id: share.vesselId }),
      foldersCol.find({ vessel_id: share.vesselId }).sort({ created_at: 1, id: 1 }).toArray(),
      filesCol.find({ vessel_id: share.vesselId }).sort({ created_at: 1, key: 1 }).toArray()
    ]);
    if (!vesselDoc) return null;
    return {
      vessel: mapVesselDoc(vesselDoc),
      folders: folderDocs.map(mapFolderDoc),
      files: fileDocs.map(mapFileDoc),
      allowDownload: share.allowDownload
    };
  }

  const vessel = (store.vessels || []).find(v => v.id === share.vesselId);
  if (!vessel) return null;
  const folderIds = new Set((store.folders || []).filter(f => (f.vessel_id || f.vesselId) === share.vesselId).map(f => f.id));
  return {
    vessel: {
      id: vessel.id,
      name: vessel.name || '',
      imo: vessel.imo || '',
      type: vessel.type || '',
      flag: vessel.flag || '',
      year: vessel.year || '',
      imageUrl: vessel.image_url || vessel.imageUrl || ''
    },
    folders: (store.folders || []).filter(f => (f.vessel_id || f.vesselId) === share.vesselId).map(f => ({
      id: f.id,
      name: f.name || '',
      vesselId: f.vessel_id || f.vesselId || '',
      parentId: f.parent_id || f.parentId || null,
      createdAt: f.created_at || f.createdAt || Date.now()
    })),
    files: (store.files || []).filter(f => (f.vessel_id || f.vesselId) === share.vesselId || folderIds.has(f.folder_id || f.folderId)).map(f => ({
      key: f.key,
      folderId: f.folder_id || f.folderId || '',
      vesselId: f.vessel_id || f.vesselId || '',
      name: f.name || '',
      size: f.size || '',
      by: f.created_by || f.by || '',
      at: f.created_at || f.at || Date.now(),
      driveFileId: f.drive_file_id || f.driveFileId || '',
      excelDriveFileId: f.excel_drive_file_id || f.excelDriveFileId || ''
    })),
    allowDownload: share.allowDownload
  };
}

const FIXED_USERS = [
  { username: 'Coral', password: 'Coral2026', full_name: 'Coral', role: 'admin' },
  { username: 'herma_shipping', password: 'ABS2026', full_name: 'Herma Shipping', role: 'user' }
];

function getFixedUser(username) {
  return FIXED_USERS.find(u => normalizeUsername(u.username) === normalizeUsername(username));
}

app.post('/api', (req, res) => {
  if (!validatePayload(req.body)) return sendError(res, 'Invalid request payload', 400);

  const { action, ...payload } = req.body;
  switch (action) {
    case 'login':
      return handleLogin(req, res, payload);
    case 'register':
      return handleRegister(req, res, payload);
    case 'getAllData':
      return handleGetAllData(req, res);
    case 'saveVessels':
      return handleSaveVessels(req, res, payload);
    case 'saveFolders':
      return handleSaveFolders(req, res, payload);
    case 'saveFileMeta':
      return handleSaveFileMeta(req, res, payload);
    case 'deleteFile':
      return handleDeleteFile(req, res, payload);
    case 'createVesselShareLink':
      return handleCreateVesselShareLink(req, res, payload);
    default:
      return sendError(res, 'Unknown action: ' + action, 400);
  }
});

async function handleLogin(req, res, payload) {
  const username = normalizeUsername(payload.username);
  const password = String(payload.password || '');
  if (!username || !password) return sendError(res, 'Missing username or password', 400);

  // Authenticate the two approved accounts before checking any database records.
  const fixedUser = getFixedUser(username);
  if (fixedUser) {
    if (password !== fixedUser.password) return sendError(res, 'Invalid credentials', 401);
    return sendSuccess(res, { name: fixedUser.full_name, role: fixedUser.role });
  }

  if (useDb()) {
    const user = await usersCol.findOne({ username });
    if (!user) return sendError(res, 'Invalid credentials', 401);
    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) return sendError(res, 'Invalid credentials', 401);
    return sendSuccess(res, { name: user.full_name, role: user.role });
  }

  const user = store.users.find(u => u.username === username);
  if (!user) return sendError(res, 'Invalid credentials', 401);
  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) return sendError(res, 'Invalid credentials', 401);
  return sendSuccess(res, { name: user.full_name, role: user.role });
}

async function handleRegister(req, res, payload) {
  return sendError(res, 'Registration is disabled. Please use the approved admin or user login.', 403);
}

async function handleGetAllData(req, res) {
  if (useDb()) {
    const [vessels, folders, files] = await Promise.all([
      vesselsCol.find().toArray(),
      foldersCol.find().toArray(),
      filesCol.find().toArray()
    ]);
    return sendSuccess(res, {
      vessels: vessels.map(mapVesselDoc),
      folders: folders.map(mapFolderDoc),
      files: files.map(mapFileDoc)
    });
  }

  return sendSuccess(res, {
    vessels: store.vessels.map(v => ({
      id: v.id,
      name: v.name,
      imo: v.imo,
      type: v.type,
      flag: v.flag,
      year: v.year,
      imageUrl: v.image_url || v.imageUrl || '',
      created_at: v.created_at || Date.now()
    })),
    folders: store.folders.map(f => ({
      id: f.id,
      name: f.name,
      vesselId: f.vessel_id || f.vesselId || '',
      parentId: f.parent_id || f.parentId || null,
      createdBy: f.created_by || f.createdBy || '',
      created_at: f.created_at || Date.now()
    })),
    files: store.files.map(f => ({
      key: f.key,
      folderId: f.folder_id || f.folderId || '',
      vesselId: f.vessel_id || f.vesselId || '',
      name: f.name,
      size: f.size,
      by: f.created_by || f.by || '',
      at: f.created_at || f.at || Date.now(),
      driveFileId: f.drive_file_id || f.driveFileId || '',
      excelDriveFileId: f.excel_drive_file_id || f.excelDriveFileId || ''
    }))
  });
}

async function handleSaveVessels(req, res, payload) {
  if (!Array.isArray(payload.vessels)) return sendError(res, 'Missing vessels payload', 400);

  if (useDb()) {
    const ids = payload.vessels.map(item => item.id).filter(Boolean);
    const ops = payload.vessels.map(item => ({
      updateOne: {
        filter: { id: item.id },
        update: { $set: toVesselDoc(item) },
        upsert: true
      }
    }));
    if (ops.length) await vesselsCol.bulkWrite(ops);
    if (ids.length) {
      await vesselsCol.deleteMany({ id: { $nin: ids } });
    } else {
      await vesselsCol.deleteMany({});
    }
    console.log('✓ Vessels replaced in database:', payload.vessels.length);
    return sendSuccess(res, {});
  }

  store.vessels = payload.vessels.map(item => ({
    id: item.id,
    name: item.name || '',
    imo: item.imo || '',
    type: item.type || '',
    flag: item.flag || '',
    year: item.year || '',
    image_url: item.imageUrl || item.image_url || '',
    created_at: item.created_at || Date.now()
  }));
  saveStore(store);
  return sendSuccess(res, {});
}

async function handleSaveFolders(req, res, payload) {
  if (!Array.isArray(payload.folders)) return sendError(res, 'Missing folders payload', 400);

  if (useDb()) {
    const ids = payload.folders.map(item => item.id).filter(Boolean);
    const ops = payload.folders.map(item => ({
      updateOne: {
        filter: { id: item.id },
        update: { $set: toFolderDoc(item) },
        upsert: true
      }
    }));
    if (ops.length) await foldersCol.bulkWrite(ops);
    if (ids.length) {
      await foldersCol.deleteMany({ id: { $nin: ids } });
    } else {
      await foldersCol.deleteMany({});
    }
    console.log('✓ Folders replaced in database:', payload.folders.length);
    return sendSuccess(res, {});
  }

  store.folders = payload.folders.map(item => ({
    id: item.id,
    name: item.name || '',
    vessel_id: item.vesselId || item.vessel_id || '',
    parent_id: item.parentId || item.parent_id || null,
    created_by: item.createdBy || item.created_by || '',
    created_at: item.created_at || Date.now()
  }));
  saveStore(store);
  return sendSuccess(res, {});
}

async function handleSaveFileMeta(req, res, payload) {
  if (!Array.isArray(payload.files)) return sendError(res, 'Missing files payload', 400);

  if (useDb()) {
    const ops = payload.files.map(item => ({
      updateOne: {
        filter: { key: item.key },
        update: { $set: toFileDoc(item) },
        upsert: true
      }
    }));
    if (ops.length) await filesCol.bulkWrite(ops);
    console.log('✓ File metadata upserted in database:', payload.files.length);
    return sendSuccess(res, {});
  }

  const existing = store.files || [];
  payload.files.forEach(item => {
    const idx = existing.findIndex(f => f.key === item.key);
    const doc = {
      key: item.key,
      folder_id: item.folderId || item.folder_id || '',
      vessel_id: item.vesselId || item.vessel_id || '',
      name: item.name || '',
      size: item.size || '',
      created_by: item.by || item.created_by || '',
      created_at: item.at || item.created_at || Date.now(),
      drive_file_id: item.driveFileId || item.drive_file_id || '',
      excel_drive_file_id: item.excelDriveFileId || item.excel_drive_file_id || ''
    };
    if (idx >= 0) {
      existing[idx] = doc;
    } else {
      existing.push(doc);
    }
  });
  store.files = existing;
  saveStore(store);
  console.log('✓ File metadata upserted in local store:', payload.files.length);
  return sendSuccess(res, {});
}


async function handleCreateVesselShareLink(req, res, payload) {
  const vesselId = String(payload.vesselId || payload.vessel_id || '').trim();
  if (!vesselId) return sendError(res, 'Missing vesselId', 400);

  let vessel = null;
  if (useDb()) vessel = await vesselsCol.findOne({ id: vesselId });
  else vessel = (store.vessels || []).find(v => v.id === vesselId);
  if (!vessel) return sendError(res, 'Vessel not found', 404);

  const token = makeShareToken();
  const doc = {
    id: ('share_'+crypto.randomBytes(8).toString('hex')),
    vessel_id: vesselId,
    token,
    allow_download: payload.allowDownload === false ? 0 : 1,
    is_active: 1,
    created_by: payload.createdBy || payload.user || '',
    created_at: Date.now(),
    expires_at: payload.expiresAt || ''
  };

  if (useDb()) {
    await shareLinksCol.insertOne(doc);
  } else {
    store.shareLinks = store.shareLinks || [];
    store.shareLinks.push(doc);
    saveStore(store);
  }

  return sendSuccess(res, {
    token,
    url: `${getBaseUrl(req)}/share/${token}`
  });
}

async function handleDeleteFile(req, res, payload) {
  const driveFileId = String(payload.driveFileId || '').trim();
  if (!driveFileId) return sendError(res, 'Missing driveFileId', 400);

  if (useDb()) {
    await filesCol.deleteMany({
      $or: [
        { drive_file_id: driveFileId },
        { excel_drive_file_id: driveFileId }
      ]
    });
    return sendSuccess(res, {});
  }

  store.files = store.files.filter(f => {
    const driveId = f.drive_file_id || f.driveFileId || '';
    const excelId = f.excel_drive_file_id || f.excelDriveFileId || '';
    return driveId !== driveFileId && excelId !== driveFileId;
  });
  saveStore(store);
  return sendSuccess(res, {});
}


app.get('/api/share/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const data = await getPublicShareData(token);
    if (!data) return sendError(res, 'Invalid or expired share link', 404);
    return sendSuccess(res, data);
  } catch (err) {
    console.error('Failed to load public share data:', err);
    return sendError(res, 'Failed to load shared vessel', 500);
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, status: 'healthy' });
});

app.get('/share/:token', (req, res) => {
  sendPublicFile(res, 'share.html');
});

// Serve the SPA for the root path.
app.get('/', (req, res) => {
  sendPublicFile(res, 'index.html');
});

function startServer() {
  app.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
  });
}

initializeDb().then(startServer).catch(err => {
  console.error('Failed to initialize MongoDB Atlas connection:', err);
  if (MONGO_URI) {
    console.error('MONGODB_URI is configured, aborting startup until the Atlas connection is fixed.');
    process.exit(1);
  }
  startServer();
});
