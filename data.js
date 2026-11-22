import {
  cloudEligibility, cloudLogin, cloudLogout, cloudSaveNote, cloudStats, cloudSubmit, fetchJsonWithTimeout,
} from './cloud.js?v=20261122-notes';

const loopback = location.hostname === 'localhost' || location.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(location.hostname);
export const localMode = loopback && new URLSearchParams(location.search).get('backend') !== 'cloud';

async function localRequest(path, payload) {
  let response;
  try {
    response = await fetchJsonWithTimeout('./api/' + path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new Error('暂时无法连接本地服务，请稍后重试。');
  }
  if (!response.headers.get('content-type')?.includes('application/json') || response.data === undefined) {
    throw new Error('请通过本地登记服务打开页面。');
  }
  const data = response.data;
  if (!response.ok) {
    const error = Object.assign(new Error(data.message || '操作未完成，请重试。'), { code: data.code });
    if (data.code === 'DUPLICATE_NAME') {
      error.confirmationToken = data.confirmationToken;
      error.matchCount = data.matchCount;
    }
    throw error;
  }
  return data;
}

export function submitClaim(claim) {
  return localMode ? localRequest('claims', claim) : cloudSubmit(claim);
}

export function findEligibility(name) {
  return localMode ? localRequest('eligibility', { name }) : cloudEligibility(name);
}

export function loginAdmin(account, password) {
  return localMode ? localRequest('admin/login', { account, password }) : cloudLogin(account, password);
}

export function logoutAdmin() {
  return localMode ? localRequest('admin/logout', {}) : cloudLogout();
}

export function getAdminStats() {
  return localMode ? localRequest('admin/claims') : cloudStats();
}

export function saveAdminNote(details) {
  return localMode ? localRequest('admin/notes', details) : cloudSaveNote(details);
}

// The first preview stored registrations in this browser. Only the signed-in
// admin's import action moves them into the protected local server.
async function openLegacyDatabase() {
  if (!localMode || !window.indexedDB) return null;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('nuclear-festival-prizes-v1');
    let absent = false;
    request.onupgradeneeded = event => {
      if (event.oldVersion === 0) {
        absent = true;
        request.transaction.abort();
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => absent ? resolve(null) : reject(new Error('无法读取浏览器中的旧登记记录。'));
  });
}

async function legacyStore(mode, action) {
  const db = await openLegacyDatabase();
  if (!db) return;
  try {
    if (!db.objectStoreNames.contains('claims')) return;
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('claims', mode);
      const req = action(tx.objectStore('claims'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onabort = () => reject(new Error('无法更新浏览器中的旧登记记录，请重试。'));
    });
  } finally {
    db.close();
  }
}

export async function legacyCount() {
  return (await legacyStore('readonly', store => store.count())) || 0;
}

export async function importLegacyClaims() {
  const records = await legacyStore('readonly', store => store.getAll());
  if (!records?.length) return;
  await localRequest('admin/import', { records });
  // Records in the old store are immutable. Clear only the successfully copied
  // IDs so that a different tab's newer entries remain available for import.
  await legacyStore('readwrite', store => {
    for (const record of records) store.delete(record.requestId);
  });
}
