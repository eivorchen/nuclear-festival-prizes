import { tiers } from './catalog.js';
import { getAdminStats, importLegacyClaims, legacyCount, localMode, loginAdmin, logoutAdmin, submitClaim } from './data.js';

const byId = id => document.getElementById(id);
const picker = byId('picker');
const success = byId('success');
const fields = [
  { key: 'name', input: byId('claim-name'), error: byId('name-error'), label: '领取人姓名' },
  { key: 'campusAddress', input: byId('claim-address'), error: byId('address-error'), label: '校内地址' },
  { key: 'wechat', input: byId('claim-wechat'), error: byId('wechat-error'), label: '联系微信' },
];
const allPrizes = tiers.flatMap(tier => tier.prizes);
const attemptKey = localMode ? 'festival-unconfirmed-claim' : 'festival-unconfirmed-claim-cloud';
let currentTier;
let selectedPrize;
let pendingAttempt;
let overwriteToken = null;
let submitting = false;
let statsLoad = 0;

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function showError(element, message = '') {
  element.textContent = message;
  element.hidden = !message;
}

function claimDetails() {
  return Object.fromEntries(fields.map(field => [field.key, field.input.value.trim()]));
}

function checkDetails() {
  let invalid;
  for (const field of fields) {
    const missing = !field.input.value.trim();
    showError(field.error, missing ? '请填写' + field.label + '。' : '');
    field.input.setAttribute('aria-invalid', String(missing));
    if (missing && !invalid) invalid = field.input;
  }
  invalid?.focus();
  return !invalid;
}

for (const field of fields) {
  field.input.addEventListener('input', () => {
    showError(field.error);
    field.input.removeAttribute('aria-invalid');
  });
  field.input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    const nextField = fields[fields.indexOf(field) + 1];
    (nextField?.input ?? byId('tiers').firstElementChild).focus();
  });
}

for (const tier of tiers) {
  const button = el('button', 'tier-button');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  const medal = el('span', 'medal ' + tier.id);
  medal.setAttribute('aria-hidden', 'true');
  medal.append(el('span', 'coin'));
  const label = el('span', 'tier-label');
  label.append(el('strong', '', tier.name), el('small', '', tier.prizes.length + ' 款奖品'));
  button.append(medal, label, el('span', 'chevron'));
  button.addEventListener('click', () => { if (checkDetails()) openPicker(tier); });
  byId('tiers').append(button);
}

function matchesAttempt(prizeId) {
  const details = claimDetails();
  return pendingAttempt?.prizeId === prizeId && pendingAttempt.tierId === currentTier?.id &&
    fields.every(field => pendingAttempt[field.key] === details[field.key]);
}

function rememberAttempt(attempt) {
  pendingAttempt = attempt;
  try {
    if (attempt) sessionStorage.setItem(attemptKey, JSON.stringify(attempt));
    else sessionStorage.removeItem(attemptKey);
  } catch { /* In-memory retries still share the request ID. */ }
}

function showPrizeOptions() {
  overwriteToken = null;
  byId('duplicate-panel').hidden = true;
  byId('selection-panel').hidden = false;
  picker.setAttribute('aria-labelledby', 'picker-title');
  picker.removeAttribute('aria-describedby');
}

function askToOverwrite(error, previousConfirmation) {
  overwriteToken = error.confirmationToken;
  const intro = previousConfirmation ? '上一次确认已失效，请重新确认。' : '';
  const description = error.matchCount > 1
    ? '这个姓名已有 ' + error.matchCount + ' 条登记。确认后将合并为一条，以本次选择的奖品、校内地址和联系微信为准。'
    : '你已经提交过一次。确认后，原登记的奖品、校内地址和联系微信将更新为本次填写的内容。';
  byId('duplicate-description').textContent = intro + description;
  byId('selection-panel').hidden = true;
  byId('duplicate-panel').hidden = false;
  picker.setAttribute('aria-labelledby', 'duplicate-title');
  picker.setAttribute('aria-describedby', 'duplicate-description');
}

function openPicker(tier) {
  showPrizeOptions();
  currentTier = tier;
  selectedPrize = null;
  byId('picker-title').textContent = '选择' + tier.name + '奖品';
  byId('picker-recipient').textContent = '领取人　' + fields[0].input.value.trim();
  showError(byId('submit-error'));
  picker.showModal();
  const options = byId('prize-options');
  options.replaceChildren();
  for (const prize of tier.prizes) {
    const option = el('label', 'option');
    const img = el('img');
    img.alt = '';
    img.src = prize.image;
    const text = el('span', 'option-text');
    text.append(el('strong', '', prize.name), el('small', '', prize.detail));
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'prize';
    radio.value = prize.id;
    if (matchesAttempt(prize.id)) {
      selectedPrize = prize;
      radio.checked = true;
    }
    radio.addEventListener('change', () => {
      selectedPrize = prize;
      byId('confirm').disabled = false;
      byId('picker-status').textContent = '';
      showError(byId('submit-error'));
    });
    option.append(img, text, radio);
    options.append(option);
  }
  byId('confirm').disabled = !selectedPrize;
  byId('picker-status').textContent = selectedPrize ? '上次提交结果待确认，请再次提交。' : '';
}

byId('picker-close').addEventListener('click', () => picker.close());
function cancelOverwrite() {
  showPrizeOptions();
  rememberAttempt(null);
  byId('picker-status').textContent = '';
  byId('confirm').focus();
}
picker.addEventListener('cancel', event => {
  if (submitting || overwriteToken) event.preventDefault();
  if (!submitting && overwriteToken) cancelOverwrite();
});
byId('cancel-overwrite').addEventListener('click', cancelOverwrite);
byId('confirm-overwrite').addEventListener('click', () => {
  if (overwriteToken) sendSelection(overwriteToken);
});
byId('prize-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!overwriteToken) sendSelection();
});

async function sendSelection(confirmationToken) {
  if (submitting || !selectedPrize) return;
  const prize = selectedPrize;
  const tier = currentTier;
  const attempt = matchesAttempt(prize.id) ? pendingAttempt : {
    requestId: crypto.randomUUID(), ...claimDetails(), tierId: tier.id, prizeId: prize.id,
  };
  rememberAttempt(attempt);
  submitting = true;
  byId('confirm').disabled = true;
  const action = byId(confirmationToken ? 'confirm-overwrite' : 'confirm');
  action.textContent = '提交中…';
  byId('confirm-overwrite').disabled = true;
  byId('cancel-overwrite').disabled = true;
  byId('picker-close').disabled = true;
  byId('prize-options').disabled = true;
  byId('picker-status').textContent = '';
  showError(byId('submit-error'));
  try {
    // Persist only the request ID and form values. A page reload must never
    // submit a replacement without the user's explicit confirmation.
    await submitClaim(confirmationToken ? { ...attempt, confirmationToken } : attempt);
    rememberAttempt(null);
    byId('success-title').textContent = confirmationToken ? '登记已更新' : '登记成功';
    byId('receipt-name').textContent = attempt.name + '　' + tier.name;
    byId('receipt-prize').textContent = prize.name;
    picker.close();
    fields.forEach(field => { field.input.value = ''; });
    success.showModal();
  } catch (error) {
    if (error.code === 'DUPLICATE_NAME' && typeof error.confirmationToken === 'string' && error.confirmationToken) {
      askToOverwrite(error, Boolean(confirmationToken));
    } else {
      showPrizeOptions();
      showError(byId('submit-error'), error.message);
      if (['REQUEST_CONFLICT', 'INVALID_REQUEST'].includes(error.code)) rememberAttempt(null);
    }
  } finally {
    submitting = false;
    byId('confirm').disabled = false;
    byId('confirm').textContent = '确认提交';
    byId('confirm-overwrite').textContent = '确认覆盖';
    byId('confirm-overwrite').disabled = false;
    byId('cancel-overwrite').disabled = false;
    byId('picker-close').disabled = false;
    byId('prize-options').disabled = false;
    if (picker.open) byId(overwriteToken ? 'cancel-overwrite' : 'confirm').focus();
  }
}
byId('next').addEventListener('click', () => success.close());
success.addEventListener('close', () => {
  if (!byId('register-view').hidden) fields[0].input.focus({ preventScroll: true });
});

function renderSummary(records) {
  const counts = new Map(allPrizes.map(prize => [prize.id, 0]));
  for (const record of records) counts.set(record.prizeId, (counts.get(record.prizeId) || 0) + 1);
  byId('order-total').textContent = '共登记 ' + records.length + ' 份';
  byId('summary').replaceChildren(...tiers.map(tier => {
    const group = el('div', 'summary-group');
    group.append(el('h3', '', tier.name));
    for (const prize of tier.prizes) {
      const row = el('div', 'summary-row');
      row.append(el('span', '', prize.name), el('strong', '', counts.get(prize.id) + ' 份'));
      group.append(row);
    }
    return group;
  }));
}

const displayTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function renderLedger(records) {
  byId('ledger-section').hidden = false;
  const ledger = byId('ledger');
  ledger.replaceChildren();
  if (!records.length) {
    ledger.append(el('p', 'empty', '暂无登记记录'));
    return;
  }
  const table = el('table');
  table.setAttribute('aria-label', '登记明细');
  const header = table.createTHead().insertRow();
  for (const title of ['姓名', '校内地址', '联系微信', '奖次', '奖品', '登记时间']) {
    const th = el('th', '', title);
    th.scope = 'col';
    header.append(th);
  }
  const body = table.createTBody();
  for (const record of records) {
    const row = body.insertRow();
    const tier = tiers.find(item => item.id === record.tierId);
    const prize = tier?.prizes.find(item => item.id === record.prizeId);
    for (const value of [record.name, record.campusAddress || '—', record.wechat || '—', tier?.name, prize?.name, displayTime.format(new Date(record.createdAt))]) {
      row.insertCell().textContent = value;
    }
  }
  ledger.append(table);
}

const adminLogin = byId('admin-login');
const passwordInput = byId('admin-password');
byId('admin-account').placeholder = localMode ? '请输入管理员账号' : '请输入管理员邮箱';

function clearStats() {
  ++statsLoad;
  byId('stats-body').hidden = true;
  byId('admin-actions').hidden = true;
  byId('legacy-box').hidden = true;
  byId('stats-retry').hidden = true;
  byId('stats-status').textContent = '';
  byId('order-total').textContent = '';
  byId('ledger').replaceChildren();
  byId('summary').replaceChildren();
}

function showLogin(message = '') {
  clearStats();
  adminLogin.hidden = false;
  showError(byId('login-error'), message);
}

async function refreshStats() {
  clearStats();
  const generation = statsLoad;
  adminLogin.hidden = true;
  byId('stats-status').textContent = '正在读取统计…';
  try {
    const { records } = await getAdminStats();
    if (generation !== statsLoad) return;
    renderSummary(records);
    renderLedger(records);
    byId('admin-actions').hidden = false;
    byId('stats-body').hidden = false;
    byId('stats-status').textContent = '';
    if (localMode) {
      try {
        const count = await legacyCount();
        if (generation !== statsLoad) return;
        byId('legacy-box').hidden = !count;
        if (count) byId('legacy-info').textContent = '此浏览器有 ' + count + ' 条旧记录。导入后将计入统计，并清除浏览器中的旧副本。';
      } catch (error) {
        if (generation === statsLoad) byId('stats-status').textContent = error.message;
      }
    }
  } catch (error) {
    if (generation !== statsLoad) return;
    if (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN') {
      showLogin(error.code === 'FORBIDDEN' ? error.message : '');
    } else {
      byId('stats-status').textContent = error.message;
      byId('stats-retry').hidden = false;
    }
  }
}

adminLogin.addEventListener('submit', async event => {
  event.preventDefault();
  const button = byId('login-submit');
  if (button.disabled) return;
  button.disabled = true;
  showError(byId('login-error'));
  try {
    await loginAdmin(byId('admin-account').value.trim(), passwordInput.value);
    passwordInput.value = '';
    if (!byId('stats-view').hidden) await refreshStats();
  } catch (error) {
    showError(byId('login-error'), error.message);
  } finally {
    button.disabled = false;
  }
});

byId('legacy-import').addEventListener('click', async () => {
  const button = byId('legacy-import');
  button.disabled = true;
  try {
    await importLegacyClaims();
    if (!byId('stats-view').hidden) await refreshStats();
  } catch (error) {
    if (error.code === 'UNAUTHORIZED') showLogin('请重新登录后导入。');
    else byId('stats-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

const logoutChannel = localMode && 'BroadcastChannel' in window ? new BroadcastChannel('festival-admin-logout') : null;
logoutChannel?.addEventListener('message', () => {
  if (!byId('stats-view').hidden) showLogin();
});
byId('logout').addEventListener('click', async () => {
  const button = byId('logout');
  button.disabled = true;
  clearStats();
  try {
    await logoutAdmin();
    logoutChannel?.postMessage('logout');
    showLogin();
  } catch (error) {
    byId('stats-status').textContent = '未能确认退出，请重试。' + error.message;
    byId('admin-actions').hidden = false;
  } finally {
    button.disabled = false;
  }
});

function showView() {
  const stats = location.hash === '#stats';
  byId('register-view').hidden = stats;
  byId('stats-view').hidden = !stats;
  byId('nav-' + (stats ? 'stats' : 'register')).setAttribute('aria-current', 'page');
  byId('nav-' + (stats ? 'register' : 'stats')).removeAttribute('aria-current');
  document.title = (stats ? '领取统计' : '奖品领取登记') + ' · 核能文化节';
  if (stats) refreshStats();
  else {
    clearStats();
    adminLogin.reset();
    adminLogin.hidden = true;
  }
}
byId('refresh').addEventListener('click', refreshStats);
byId('stats-retry').addEventListener('click', refreshStats);
window.addEventListener('pagehide', clearStats);
window.addEventListener('pageshow', event => { if (event.persisted) showView(); });
document.addEventListener('visibilitychange', () => {
  if (byId('stats-view').hidden || !adminLogin.hidden) return;
  if (document.hidden) clearStats();
  else refreshStats();
});
window.addEventListener('hashchange', showView);
showView();

try {
  const saved = JSON.parse(sessionStorage.getItem(attemptKey));
  const tier = tiers.find(item => item.id === saved?.tierId);
  if (tier?.prizes.some(prize => prize.id === saved.prizeId) &&
      fields.every(field => typeof saved[field.key] === 'string' && saved[field.key].trim())) {
    pendingAttempt = saved;
    if (!byId('register-view').hidden) {
      fields.forEach(field => { field.input.value = saved[field.key]; });
      openPicker(tier);
    }
  }
} catch { /* The form also works without session storage. */ }
