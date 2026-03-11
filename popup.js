// popup.js
// UI popup-а:
// - показывает текущее состояние для активной вкладки ChatGPT
// - позволяет вручную подключить/отключить debugger
// - позволяет скопировать URL
// - позволяет открыть прямую ссылку
// - позволяет запустить скачивание через content.js (fetch + credentials: include)

let activeTabId = null;
let activeTabUrl = null;
let currentState = null;

const elements = {
  tabInfo: document.getElementById('tabInfo'),
  status: document.getElementById('status'),
  downloadUrl: document.getElementById('downloadUrl'),
  attachBtn: document.getElementById('attachBtn'),
  detachBtn: document.getElementById('detachBtn'),
  copyBtn: document.getElementById('copyBtn'),
  openBtn: document.getElementById('openBtn'),
  downloadBtn: document.getElementById('downloadBtn')
};

function isChatGPTUrl(url = '') {
  return /^https:\/\/chatgpt\.com\//i.test(url);
}

function renderState() {
  const state = currentState || {};
  const isChatGPT = isChatGPTUrl(activeTabUrl || '');
  const hasUrl = Boolean(state.lastDownloadUrl);

  elements.tabInfo.textContent = activeTabUrl
    ? `Активная вкладка: ${activeTabUrl}`
    : 'Активная вкладка не найдена.';

  if (!isChatGPT) {
    elements.status.textContent = 'Откройте страницу https://chatgpt.com/* и затем снова откройте popup.';
  } else {
    elements.status.textContent = state.status || 'Состояние неизвестно.';
  }

  elements.downloadUrl.value = state.lastDownloadUrl || '';

  elements.attachBtn.disabled = !isChatGPT;
  elements.detachBtn.disabled = !isChatGPT;
  elements.copyBtn.disabled = !hasUrl;
  elements.openBtn.disabled = !hasUrl;
  elements.downloadBtn.disabled = !hasUrl;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function refreshState() {
  const tab = await getActiveTab();
  activeTabId = tab?.id ?? null;
  activeTabUrl = tab?.url ?? null;

  if (typeof activeTabId !== 'number') {
    currentState = null;
    renderState();
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: 'GET_TAB_STATE',
    tabId: activeTabId
  });

  currentState = response?.ok ? response.state : null;
  renderState();
}

async function attachDebugger() {
  if (typeof activeTabId !== 'number') {
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: 'ATTACH_DEBUGGER',
    tabId: activeTabId
  });

  if (!response?.ok) {
    elements.status.textContent = `Ошибка подключения: ${response?.error || 'unknown error'}`;
    return;
  }

  currentState = response.state;
  renderState();
}

async function detachDebugger() {
  if (typeof activeTabId !== 'number') {
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: 'DETACH_DEBUGGER',
    tabId: activeTabId
  });

  if (!response?.ok) {
    elements.status.textContent = `Ошибка отключения: ${response?.error || 'unknown error'}`;
    return;
  }

  currentState = response.state;
  renderState();
}

async function copyUrl() {
  const url = currentState?.lastDownloadUrl;
  if (!url) {
    return;
  }

  await navigator.clipboard.writeText(url);
  elements.status.textContent = 'Ссылка скопирована в буфер обмена.';
}

function openUrl() {
  const url = currentState?.lastDownloadUrl;
  if (!url) {
    return;
  }

  chrome.tabs.create({ url });
}

async function directDownload() {
  const url = currentState?.lastDownloadUrl;
  if (!url || typeof activeTabId !== 'number') {
    return;
  }

  try {
    await chrome.tabs.sendMessage(activeTabId, {
      type: 'DOWNLOAD_URL_CAPTURED',
      payload: { downloadUrl: url }
    });

    await chrome.tabs.sendMessage(activeTabId, {
      type: 'FORCE_START_DOWNLOAD',
      payload: { downloadUrl: url }
    });

    elements.status.textContent = 'Команда на прямое скачивание отправлена во вкладку.';
  } catch (error) {
    elements.status.textContent = `Не удалось начать скачивание: ${error?.message || String(error)}`;
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || typeof activeTabId !== 'number') {
    return;
  }

  const key = `tab:${activeTabId}`;
  if (!changes[key]) {
    return;
  }

  currentState = changes[key].newValue || null;
  renderState();
});

elements.attachBtn.addEventListener('click', () => attachDebugger().catch(console.error));
elements.detachBtn.addEventListener('click', () => detachDebugger().catch(console.error));
elements.copyBtn.addEventListener('click', () => copyUrl().catch(console.error));
elements.openBtn.addEventListener('click', openUrl);
elements.downloadBtn.addEventListener('click', () => directDownload().catch(console.error));

refreshState().catch((error) => {
  elements.status.textContent = `Ошибка инициализации popup: ${error?.message || String(error)}`;
});
