const fs = require('fs');
const path = require('path');
const FILE_PATH = path.join(__dirname, '..', 'session_data.json');

function _loadDB() {
  if (!fs.existsSync(FILE_PATH)) {
    // Tự động tạo tệp DB rỗng ngay khi khởi động nếu chưa có
    fs.writeFileSync(FILE_PATH, '{}', 'utf8');
    return {};
  }
  
  try {
    return JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function _saveDB(db) {
  try {
    fs.writeFileSync(FILE_PATH, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Lỗi khi lưu session DB:', e.message);
  }
}

function saveMap(key, mapInstance) {
  const db = _loadDB();
  db[key] = Object.fromEntries(mapInstance);
  db[`${key}_timestamp`] = Date.now();
  _saveDB(db);
}

class SessionMap extends Map {
  constructor(key) {
    super();
    this.key = key;
    const db = _loadDB();
    const data = db[key] || {};
    const timestamp = db[`${key}_timestamp`] || 0;
    
    // Xóa session nếu quá 24h
    if (Date.now() - timestamp <= 24 * 60 * 60 * 1000) {
      for (const [k, v] of Object.entries(data)) {
        super.set(k, v);
      }
    }
  }

  set(k, v) {
    super.set(k, v);
    saveMap(this.key, this);
    return this;
  }

  delete(k) {
    const res = super.delete(k);
    saveMap(this.key, this);
    return res;
  }

  clear() {
    super.clear();
    saveMap(this.key, this);
  }
}

module.exports = {
  SessionMap
};
