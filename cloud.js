import { supabaseUrl, supabasePublishableKey } from './config.js';

const sessionKey = 'festival-admin-session:' + supabaseUrl;
let tabSession = null;

const claimErrors = {
  INVALID_PRIZE: '请选择当前奖次的奖品。',
  INVALID_NAME: '请输入姓名，最多 80 个字符。',
  INVALID_ADDRESS: '请输入校内地址，最多 160 个字符。',
  INVALID_WECHAT: '请输入联系微信，最多 80 个字符。',
  INVALID_REQUEST: '这次登记的编号无效，请重新登记。',
  REQUEST_CONFLICT: '这次登记的编号已使用，请重新登记。',
};

function errorWithCode(code, message) {
  return Object.assign(new Error(message), { code });
}

function saveSession(session) {
  tabSession = session;
  try {
    if (session) sessionStorage.setItem(sessionKey, JSON.stringify(session));
    else sessionStorage.removeItem(sessionKey);
  } catch { /* 当前标签页仍可在内存中保留会话。 */ }
}

function currentSession() {
  if (!tabSession) {
    try { tabSession = JSON.parse(sessionStorage.getItem(sessionKey)); } catch {}
  }
  if (tabSession?.accessToken && tabSession.expiresAt > Date.now()) return tabSession;
  saveSession(null);
  return null;
}

function projectUrl() {
  let url;
  try { url = new URL(supabaseUrl); } catch {}
  const loopback = url && (url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname));
  if (!url || url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) ||
      !/^sb_publishable_[a-zA-Z0-9_-]+$/.test(supabasePublishableKey)) {
    throw new Error('数据服务尚未配置，请联系活动负责人。');
  }
  return url.href.replace(/\/+$/, '');
}

async function request(path, body, token) {
  const endpoint = projectUrl() + path;
  const headers = { apikey: supabasePublishableKey, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  try {
    return await fetch(endpoint, {
      method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store',
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('暂时无法连接数据服务，请检查网络后重试。');
  }
}

export async function cloudSubmit({ requestId, name, campusAddress, wechat, tierId, prizeId, confirmationToken }) {
  const response = await request('/rest/v1/rpc/festival_submit_claim', {
    p_request_id: requestId, p_name: name, p_campus_address: campusAddress,
    p_wechat: wechat, p_tier_id: tierId, p_prize_id: prizeId, p_confirmation_token: confirmationToken || null,
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    if (response.status === 409 && detail.code === 'DUPLICATE_NAME' &&
        typeof detail.confirmationToken === 'string' && Number.isInteger(detail.matchCount) && detail.matchCount > 0) {
      throw Object.assign(errorWithCode('DUPLICATE_NAME', '你已经提交过一次，是否覆盖？'), {
        confirmationToken: detail.confirmationToken, matchCount: detail.matchCount,
      });
    }
    if (Object.hasOwn(claimErrors, detail.message)) throw errorWithCode(detail.message, claimErrors[detail.message]);
    throw new Error('暂时无法提交，请稍后重试。');
  }
}

export async function cloudLogin(account, password) {
  const response = await request('/auth/v1/token?grant_type=password', { email: account.trim(), password });
  if (response.status === 429) throw new Error('登录尝试过于频繁，请稍后重试。');
  if (response.status >= 400 && response.status < 500) {
    throw errorWithCode('UNAUTHORIZED', '账号或密码不正确。');
  }
  if (!response.ok) throw new Error('登录服务暂时不可用，请稍后重试。');
  const data = await response.json();
  if (typeof data.access_token !== 'string' || !(Number(data.expires_in) > 0)) {
    throw new Error('登录服务返回异常，请稍后重试。');
  }
  saveSession({ accessToken: data.access_token, expiresAt: Date.now() + Number(data.expires_in) * 1000 });
}

export async function cloudLogout() {
  const session = currentSession();
  saveSession(null);
  if (session) {
    const result = await request('/auth/v1/logout?scope=local', {}, session.accessToken);
    if (!result.ok && result.status !== 401 && result.status !== 403) {
      throw new Error('本机已退出，服务端暂时无法确认退出状态。');
    }
  }
}

export async function cloudStats() {
  projectUrl();
  const session = currentSession();
  if (!session) throw errorWithCode('UNAUTHORIZED', '请先登录管理员账号。');
  const result = await request('/rest/v1/rpc/festival_admin_stats', {}, session.accessToken);
  if (result.status === 401 || result.status === 403) {
    if (tabSession === session) saveSession(null);
    if (result.status === 403) throw errorWithCode('FORBIDDEN', '此账号没有管理员权限。');
    throw errorWithCode('UNAUTHORIZED', '登录已过期，请重新登录。');
  }
  if (!result.ok) throw new Error('统计暂时无法读取，请稍后重试。');
  const data = await result.json();
  if (!Array.isArray(data?.records)) throw new Error('统计数据格式异常，请联系活动负责人。');
  return data;
}
