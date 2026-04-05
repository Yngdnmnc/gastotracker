/* ═══════════════════════════════════════════════
   GastoTracker — Local Storage (IndexedDB)
   ═══════════════════════════════════════════════ */

const Store = (() => {
  const DB_NAME = 'gastotracker';
  const DB_VERSION = 1;
  const STORE_NAME = 'charges';
  const SETTINGS_KEY = 'gastotracker_settings';

  let db = null;

  // ─── Init IndexedDB ───

  function init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('date', 'date', { unique: false });
          store.createIndex('synced', 'synced', { unique: false });
          store.createIndex('source', 'source', { unique: false });
        }
      };

      request.onsuccess = (e) => {
        db = e.target.result;
        resolve();
      };

      request.onerror = (e) => {
        reject(e.target.error);
      };
    });
  }

  // ─── CRUD ───

  function add(charge) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).add(charge);
      tx.oncomplete = () => resolve(charge);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  function update(charge) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(charge);
      tx.oncomplete = () => resolve(charge);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  function remove(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  function getAll() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => {
        // Sort by date descending
        const charges = request.result.sort((a, b) =>
          new Date(b.date) - new Date(a.date)
        );
        resolve(charges);
      };
      request.onerror = (e) => reject(e.target.error);
    });
  }

  function clearAll() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // ─── Filtered queries ───

  async function getByMonth(year, month) {
    const all = await getAll();
    return all.filter((c) => {
      const d = new Date(c.date);
      return d.getFullYear() === year && d.getMonth() === month;
    });
  }

  async function getUnsynced() {
    const all = await getAll();
    return all.filter((c) => !c.synced);
  }

  async function markSynced(ids) {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    for (const id of ids) {
      const request = store.get(id);
      request.onsuccess = () => {
        const charge = request.result;
        if (charge) {
          charge.synced = true;
          store.put(charge);
        }
      };
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // ─── Totals ───

  async function totals(year, month) {
    const charges = await getByMonth(year, month);
    const result = { 'UY$': 0, 'USD': 0 };
    for (const c of charges) {
      if (result[c.currency] !== undefined) {
        result[c.currency] += c.amount;
      }
    }
    return result;
  }

  async function stats() {
    const all = await getAll();
    return {
      total: all.length,
      synced: all.filter((c) => c.synced).length,
      pending: all.filter((c) => !c.synced).length,
    };
  }

  // ─── Settings (localStorage, simple key-value) ───

  function getSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveSetting(key, value) {
    const settings = getSettings();
    settings[key] = value;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function getSheetsURL() {
    return getSettings().sheetsURL || '';
  }

  function setSheetsURL(url) {
    saveSetting('sheetsURL', url);
  }

  // ─── Identity ───

  function getIdentity() {
    return getSettings().identity || '';
  }

  function setIdentity(name) {
    saveSetting('identity', name);
  }

  // ─── Duplicate detection ───
  // Same amount + merchant (case-insensitive) + same date (day) within the same week

  async function isDuplicate(charge) {
    const all = await getAll();
    const chargeDate = new Date(charge.date);
    const weekStart = new Date(chargeDate);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const chargeDayStr = chargeDate.toISOString().slice(0, 10);
    const merchantLower = (charge.merchant || '').toLowerCase().trim();

    return all.some((c) => {
      const d = new Date(c.date);
      if (d < weekStart || d >= weekEnd) return false;
      const dayStr = d.toISOString().slice(0, 10);
      if (dayStr !== chargeDayStr) return false;
      if (Math.abs(c.amount - charge.amount) > 0.01) return false;
      if ((c.merchant || '').toLowerCase().trim() !== merchantLower) return false;
      return true;
    });
  }

  // ─── Import from Sheets (merge by ID) ───

  async function importCharges(charges) {
    const existing = await getAll();
    const existingIds = new Set(existing.map((c) => c.id));
    let imported = 0;

    for (const c of charges) {
      if (!c.id || existingIds.has(c.id)) continue;
      if (!c.merchant && !c.amount) continue;
      await add(c);
      imported++;
    }

    return imported;
  }

  // ─── UUID ───

  function uuid() {
    return crypto.randomUUID();
  }

  return {
    init, add, update, remove, getAll, clearAll,
    getByMonth, getUnsynced, markSynced,
    totals, stats,
    getSheetsURL, setSheetsURL,
    getIdentity, setIdentity, isDuplicate,
    importCharges, uuid,
  };
})();
