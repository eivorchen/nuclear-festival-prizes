import { tiers } from './catalog.js?v=20261122-prize-remark';
import {
  findEligibility, getAdminStats, importLegacyClaims, legacyCount, localMode,
  loginAdmin, logoutAdmin, submitClaim,
} from './data.js?v=20261123-reopened';

const byId = id => document.getElementById(id);
const picker = byId('picker');
const success = byId('success');
const prizeNoteInput = byId('prize-note');
const lookupButton = byId('lookup-name');
const statusLine = byId('eligibility-status');
const fields = [
  { key: 'name', input: byId('claim-name'), error: byId('name-error'), label: '获奖人姓名' },
  { key: 'phone', input: byId('claim-phone'), error: byId('phone-error'), label: '联系电话' },
  { key: 'campusAddress', input: byId('claim-address'), error: byId('address-error'), label: '校内地址' },
  { key: 'wechat', input: byId('claim-wechat'), error: byId('wechat-error'), label: '联系微信' },
];
const nameField = fields[0];
const allPrizes = tiers.flatMap(tier => tier.prizes);
const tiersById = new Map(tiers.map(tier => [tier.id, tier]));
const attemptKey = localMode ? 'festival-unconfirmed-claim' : 'festival-unconfirmed-claim-cloud';
let eligibility;
let lookupTimer;
let lookupGeneration = 0;
let selection;
let prizeNoteOwner;
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

function setFieldError(field, message) {
  showError(field.error, message);
  if (message) field.input.setAttribute('aria-invalid', 'true');
  else field.input.removeAttribute('aria-invalid');
}

function claimDetails(status) {
  const details = Object.fromEntries(fields.map(field => [field.key, field.input.value.trim()]));
  if (status === 'waived') details.campusAddress = '';
  return details;
}

function validPhone(value) {
  let digits = value.replace(/[０-９＋]/g, character =>
    character === '＋' ? '+' : String.fromCharCode(character.charCodeAt(0) - 0xfee0)
  ).replace(/[\s()（）.．‐‑‒–—−-]/g, '');
  if (/^(?:\+86|0086)1[3-9][0-9]{9}$/.test(digits)) digits = digits.slice(-11);
  return /^\+?[0-9]{7,15}$/.test(digits);
}

function checkDetails(status) {
  const details = claimDetails(status);
  if (eligibility?.name !== details.name) return false;
  let firstInvalid;
  for (const field of fields.slice(1)) {
    const required = field.key === 'phone' || status === 'claimed';
    const missing = required && !details[field.key];
    const badPhone = field.key === 'phone' && !missing && !validPhone(details.phone);
    const message = missing ? '请填写' + field.label + '。' : badPhone ? '请输入有效的联系电话。' : '';
    setFieldError(field, message);
    if (message && !firstInvalid) firstInvalid = field.input;
  }
  firstInvalid?.focus();
  return !firstInvalid;
}

function clearEligibility() {
  clearTimeout(lookupTimer);
  ++lookupGeneration;
  eligibility = undefined;
  byId('eligible-actions').hidden = true;
  byId('tiers').replaceChildren();
  statusLine.textContent = '';
  lookupButton.disabled = false;
}

function renderEligibleTiers() {
  const buttons = eligibility.eligibleTierIds.map(id => {
    const tier = tiersById.get(id);
    const button = el('button', 'tier-button');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog');
    const medal = el('span', 'medal ' + tier.id);
    medal.setAttribute('aria-hidden', 'true');
    medal.append(el('span', 'coin'));
    const label = el('span', 'tier-label');
    const note = id === eligibility.awardTierId ? '原奖次' : '降级选择';
    label.append(el('strong', '', tier.name), el('small', '', note));
    button.append(medal, label, el('span', 'chevron'));
    button.addEventListener('click', () => {
      if (checkDetails('claimed')) openPicker(tier);
    });
    return button;
  });
  byId('tiers').replaceChildren(...buttons);
  byId('eligible-actions').hidden = false;
}

async function lookupEligibility() {
  const name = nameField.input.value.trim();
  if (!name) {
    clearEligibility();
    setFieldError(nameField, '请填写获奖人姓名。');
    nameField.input.focus();
    return;
  }
  if (lookupButton.disabled || eligibility?.name === name) return;

  clearEligibility();
  setFieldError(nameField, '');
  const generation = lookupGeneration;
  lookupButton.disabled = true;
  statusLine.textContent = '正在核对获奖名单…';
  try {
    const result = await findEligibility(name);
    if (generation !== lookupGeneration) return;
    if (!result) {
      statusLine.textContent = '';
      setFieldError(nameField, '名单中未找到该姓名，请核对后重试。');
      return;
    }
    const award = tiersById.get(result.awardTierId);
    if (!award || !Array.isArray(result.eligibleTierIds) ||
        !result.eligibleTierIds.length || !result.eligibleTierIds.every(id => tiersById.has(id))) {
      throw new Error('暂时无法读取奖项，请联系活动负责人。');
    }
    eligibility = { ...result, name };
    statusLine.textContent = '已匹配' + award.name;
    renderEligibleTiers();
  } catch (error) {
    if (generation !== lookupGeneration) return;
    statusLine.textContent = '';
    setFieldError(nameField, error.message);
  } finally {
    if (generation === lookupGeneration) lookupButton.disabled = false;
  }
}

nameField.input.addEventListener('input', event => {
  clearEligibility();
  setFieldError(nameField, '');
  if (!event.isComposing && nameField.input.value.trim().length >= 2) {
    lookupTimer = setTimeout(lookupEligibility, 450);
  }
});
nameField.input.addEventListener('compositionend', () => {
  clearTimeout(lookupTimer);
  if (nameField.input.value.trim().length >= 2) lookupTimer = setTimeout(lookupEligibility, 450);
});
byId('eligibility-form').addEventListener('submit', event => {
  event.preventDefault();
  clearTimeout(lookupTimer);
  lookupEligibility();
});

for (const [index, field] of fields.entries()) {
  if (!index) continue;
  field.input.addEventListener('input', () => setFieldError(field, ''));
  field.input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    const nextField = fields[index + 1];
    (nextField?.input ?? byId('tiers').firstElementChild)?.focus();
  });
}

function draftSelection() {
  return {
    ...claimDetails(selection.status),
    status: selection.status,
    tierId: selection.tier.id,
    prizeId: selection.prize?.id ?? null,
    prizeNote: selection.status === 'claimed' ? prizeNoteInput.value.trim() : '',
  };
}

function matchesAttempt(draft) {
  return pendingAttempt && Object.keys(draft).every(key => draft[key] === pendingAttempt[key]);
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function rememberAttempt(attempt) {
  pendingAttempt = attempt;
  try {
    if (attempt) sessionStorage.setItem(attemptKey, JSON.stringify(attempt));
    else sessionStorage.removeItem(attemptKey);
  } catch { /* In-memory retries still share the request ID. */ }
}

function showPanel(panel) {
  byId('selection-panel').hidden = panel !== 'selection';
  byId('waiver-panel').hidden = panel !== 'waiver';
  byId('duplicate-panel').hidden = panel !== 'duplicate';
  picker.setAttribute('aria-labelledby', (panel === 'selection' ? 'picker' : panel) + '-title');
  if (panel === 'selection') picker.removeAttribute('aria-describedby');
  else picker.setAttribute('aria-describedby', panel + '-description');
}

function showSelection() {
  overwriteToken = null;
  showPanel(selection.status === 'waived' ? 'waiver' : 'selection');
}

function askToOverwrite(error, previousConfirmation) {
  overwriteToken = error.confirmationToken;
  const intro = previousConfirmation ? '上一次确认已失效，请重新确认。' : '';
  const current = error.matchCount > 1 ? '这个姓名已有 ' + error.matchCount + ' 条登记。' : '你已经提交过一次。';
  const result = selection.status === 'waived'
    ? '确认后将登记为已放弃。'
    : '确认后将以本次填写的领取信息和所选奖品为准。';
  byId('duplicate-description').textContent = intro + current + result;
  showPanel('duplicate');
}

function openPicker(tier, restoredNote) {
  const noteOwner = eligibility.name + '\n' + tier.id;
  if (restoredNote !== undefined) prizeNoteInput.value = restoredNote;
  else if (prizeNoteOwner !== noteOwner) prizeNoteInput.value = '';
  prizeNoteOwner = noteOwner;
  selection = { tier, status: 'claimed' };
  showSelection();
  byId('picker-title').textContent = '选择' + tier.name + '奖品';
  byId('picker-recipient').textContent = '获奖人　' + eligibility.name;
  showError(byId('submit-error'));
  const options = byId('prize-options');
  options.replaceChildren();
  for (const prize of tier.prizes) {
    const option = el('label', 'option');
    const img = el('img');
    img.alt = '';
    img.src = prize.image;
    const text = el('strong', 'option-text', prize.name);
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'prize';
    radio.value = prize.id;
    if (matchesAttempt({ ...draftSelection(), prizeId: prize.id })) {
      selection.prize = prize;
      radio.checked = true;
    }
    radio.addEventListener('change', () => {
      selection.prize = prize;
      byId('confirm').disabled = false;
      byId('picker-status').textContent = '';
      showError(byId('submit-error'));
    });
    option.append(img, text, radio);
    options.append(option);
  }
  byId('confirm').disabled = !selection.prize;
  byId('picker-status').textContent = selection.prize ? '上次提交结果待确认，请再次提交。' : '';
  picker.showModal();
}

function openWaiver() {
  selection = { status: 'waived', tier: tiersById.get(eligibility.awardTierId) };
  showSelection();
  byId('waiver-description').textContent = matchesAttempt(draftSelection())
    ? '上次提交结果待确认，请再次确认放弃。'
    : '提交后将登记为已放弃。';
  showError(byId('waiver-error'));
  picker.showModal();
  byId('cancel-waiver').focus();
}

byId('waive-prize').addEventListener('click', () => {
  if (checkDetails('waived')) openWaiver();
});
byId('picker-close').addEventListener('click', () => picker.close());
byId('cancel-waiver').addEventListener('click', () => picker.close());

function cancelOverwrite() {
  showSelection();
  rememberAttempt(null);
  byId('picker-status').textContent = '';
  if (selection.status === 'waived') picker.close();
  else byId('confirm').focus();
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
byId('confirm-waiver').addEventListener('click', () => sendSelection());

async function sendSelection(confirmationToken) {
  if (submitting || (selection.status === 'claimed' && !selection.prize)) return;
  const waived = selection.status === 'waived';
  const draft = draftSelection();
  submitting = true;
  const action = byId(confirmationToken ? 'confirm-overwrite' : waived ? 'confirm-waiver' : 'confirm');
  const actionText = action.textContent;
  const controls = ['confirm', 'confirm-waiver', 'cancel-waiver', 'confirm-overwrite', 'cancel-overwrite', 'picker-close', 'prize-options', 'prize-note'].map(byId);
  controls.forEach(control => { control.disabled = true; });
  action.textContent = '提交中…';
  byId('picker-status').textContent = '';
  const submitError = byId(waived ? 'waiver-error' : 'submit-error');
  showError(submitError);
  try {
    const attempt = matchesAttempt(draft) ? pendingAttempt : { requestId: createRequestId(), ...draft };
    rememberAttempt(attempt);
    // Restoring a pending request never restores an overwrite confirmation.
    await submitClaim(confirmationToken ? { ...attempt, confirmationToken } : attempt);
    rememberAttempt(null);
    byId('success-title').textContent = waived ? '已登记放弃奖品' : confirmationToken ? '登记已更新' : '登记成功';
    byId('receipt-name').textContent = attempt.name + '　' + selection.tier.name;
    byId('receipt-prize').hidden = waived;
    byId('receipt-prize').textContent = selection.prize?.name ?? '';
    picker.close();
    fields.forEach(field => {
      field.input.value = '';
      setFieldError(field, '');
    });
    prizeNoteInput.value = '';
    prizeNoteOwner = undefined;
    clearEligibility();
    success.showModal();
  } catch (error) {
    if (error.code === 'DUPLICATE_NAME' && typeof error.confirmationToken === 'string' && error.confirmationToken) {
      askToOverwrite(error, Boolean(confirmationToken));
    } else {
      showSelection();
      const contactMismatch = ['CONTACT_MISMATCH', 'LEGACY_CONTACT_MISMATCH'].includes(error.code);
      const guidance = contactMismatch ? '请返回登记页核对后重试。' : '';
      showError(submitError, error.message + guidance);
      if (['REQUEST_CONFLICT', 'INVALID_REQUEST'].includes(error.code)) rememberAttempt(null);
    }
  } finally {
    submitting = false;
    action.textContent = actionText;
    controls.forEach(control => { control.disabled = false; });
    if (picker.open) byId(overwriteToken ? 'cancel-overwrite' : waived ? 'confirm-waiver' : 'confirm').focus();
  }
}

byId('next').addEventListener('click', () => success.close());
success.addEventListener('close', () => {
  if (!byId('register-view').hidden) nameField.input.focus({ preventScroll: true });
});

function renderSummary(records) {
  const counts = new Map(allPrizes.map(prize => [prize.id, 0]));
  for (const record of records) {
    if (record.status !== 'waived' && counts.has(record.prizeId)) {
      counts.set(record.prizeId, counts.get(record.prizeId) + 1);
    }
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const waived = records.filter(record => record.status === 'waived').length;
  byId('order-total').textContent = '需采购 ' + total + ' 份' + (waived ? ' · 已放弃 ' + waived + ' 人' : '');
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
  const titles = ['姓名', '联系电话', '校内地址', '联系微信', '获奖奖次', '所选奖次', '奖品', '奖品规格备注', '状态', '登记时间'];
  for (const title of titles) {
    const th = el('th', '', title);
    th.scope = 'col';
    header.append(th);
  }
  const body = table.createTBody();
  for (const record of records) {
    const row = body.insertRow();
    const tier = tiersById.get(record.tierId);
    const award = tiersById.get(record.awardTierId);
    const prize = tier?.prizes.find(item => item.id === record.prizeId);
    const waived = record.status === 'waived';
    const cells = [
      record.name, record.phone, record.campusAddress, record.wechat, award?.name,
      waived ? '' : tier?.name, waived ? '' : prize?.name,
      waived ? '' : record.prizeNote, waived ? '已放弃' : '已登记领取',
      displayTime.format(new Date(record.createdAt)),
    ];
    for (const value of cells) row.insertCell().textContent = value || '—';
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

async function restoreAttempt() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(attemptKey));
    const tier = tiersById.get(saved?.tierId);
    const validChoice = saved?.status === 'waived'
      ? saved.prizeId === null
      : saved?.status === 'claimed' && tier?.prizes.some(prize => prize.id === saved.prizeId);
    if (!tier || !validChoice || !saved.name || !saved.phone || byId('register-view').hidden) return;
    saved.prizeNote = typeof saved.prizeNote === 'string' ? saved.prizeNote : '';
    pendingAttempt = saved;
    fields.forEach(field => { field.input.value = saved[field.key] || ''; });
    await lookupEligibility();
    if (pendingAttempt !== saved || byId('register-view').hidden || !eligibility ||
        !eligibility.eligibleTierIds.includes(tier.id) || eligibility.name !== saved.name) return;
    if (saved.status === 'waived' && eligibility.awardTierId === tier.id &&
        matchesAttempt({ ...claimDetails('waived'), status: 'waived', tierId: tier.id, prizeId: null, prizeNote: '' })) {
      openWaiver();
    }
    if (saved.status === 'claimed' &&
        matchesAttempt({ ...claimDetails('claimed'), status: 'claimed', tierId: tier.id, prizeId: saved.prizeId, prizeNote: saved.prizeNote })) {
      openPicker(tier, saved.prizeNote);
    }
  } catch { /* The form also works without session storage. */ }
}

restoreAttempt();
