// background.js
// MV3 service worker.
// Основная логика:
// 1) Автоматически подключаемся к вкладке ChatGPT через chrome.debugger.
// 2) Включаем CDP-домен Network.
// 3) Ищем ответы на запросы, URL которых содержит download?message_id.
// 4) После завершения загрузки читаем тело ответа через Network.getResponseBody.
// 5) Извлекаем поле download_url, сохраняем состояние и уведомляем content/popup.

const DEBUGGER_VERSION = '1.3';
const CHATGPT_URL_RE = /^https:\/\/chatgpt\.com\//i;
const DOWNLOAD_REQUEST_RE = /download\?message_id=/i;
const STORAGE_KEY_PREFIX = 'tab:';

// Состояние по вкладкам. pendingRequests не кладём в storage, оно нужно только в памяти.
const tabRuntimeState = new Map();

function getRuntimeState(tabId) {
  if (!tabRuntimeState.has(tabId)) {
    tabRuntimeState.set(tabId, {
      pendingRequests: new Map(),
      attached: false,
      lastDownloadUrl: null,
      lastRequestUrl: null,
      lastError: null,
      status: 'Ожидание подключения…',
      lastCapturedAt: null,
      pageUrl: null
    });
  }

  return tabRuntimeState.get(tabId);
}

function getStorageKey(tabId) {
  return `${STORAGE_KEY_PREFIX}${tabId}`;
}

function isChatGPTUrl(url = '') {
  return CHATGPT_URL_RE.test(url);
}

function sanitizeStateForStorage(tabId) {
  const state = getRuntimeState(tabId);

  return {
    tabId,
    attached: Boolean(state.attached),
    lastDownloadUrl: state.lastDownloadUrl || null,
    lastRequestUrl: state.lastRequestUrl || null,
    lastError: state.lastError || null,
    status: state.status || '',
    lastCapturedAt: state.lastCapturedAt || null,
    pageUrl: state.pageUrl || null
  };
}

async function persistState(tabId) {
  await chrome.storage.local.set({
    [getStorageKey(tabId)]: sanitizeStateForStorage(tabId)
  });
}

async function updateState(tabId, patch = {}) {
  const state = getRuntimeState(tabId);
  Object.assign(state, patch);
  await persistState(tabId);
}

async function clearState(tabId) {
  tabRuntimeState.delete(tabId);
  await chrome.storage.local.remove(getStorageKey(tabId));
}

function formatDetachReason(reason) {
  if (reason === 'target_closed') {
    return 'Вкладка закрыта или цель отладки исчезла.';
  }

  if (reason === 'canceled_by_user') {
    return 'Отладка отключена. Обычно это происходит, когда открывают DevTools для этой вкладки.';
  }

  return `Отладка отключена: ${reason}`;
}

function decodePossiblyBase64Body(body, base64Encoded) {
  if (!base64Encoded) {
    return body;
  }

  return atob(body);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function notifyTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Content script мог ещё не загрузиться / вкладка могла смениться.
  }
}

async function captureDownloadUrlFromResponse(tabId, requestId, requestUrl) {
  const debuggee = { tabId };

  try {
    const result = await chrome.debugger.sendCommand(debuggee, 'Network.getResponseBody', {
      requestId
    });

    const rawBody = decodePossiblyBase64Body(result?.body || '', Boolean(result?.base64Encoded));
    const json = safeJsonParse(rawBody);

    if (!json || typeof json.download_url !== 'string' || !json.download_url) {
      await updateState(tabId, {
        status: 'Ответ найден, но download_url в JSON не обнаружен.',
        lastError: 'В теле ответа нет поля download_url.',
        lastRequestUrl: requestUrl
      });
      return;
    }

    const downloadUrl = json.download_url;

    // Требование пользователя: вывести ссылку в console.log.
    console.log('[ChatGPT Direct Download] download_url:', downloadUrl);

    const now = new Date().toISOString();
    await updateState(tabId, {
      lastDownloadUrl: downloadUrl,
      lastRequestUrl: requestUrl,
      lastError: null,
      lastCapturedAt: now,
      status: 'Ссылка успешно извлечена.'
    });

    await notifyTab(tabId, {
      type: 'DOWNLOAD_URL_CAPTURED',
      payload: {
        downloadUrl,
        requestUrl,
        capturedAt: now
      }
    });
  } catch (error) {
    await updateState(tabId, {
      status: 'Не удалось прочитать тело ответа через Network.getResponseBody.',
      lastError: error?.message || String(error),
      lastRequestUrl: requestUrl
    });
  }
}

async function attachDebuggerToTab(tabId) {
  let tab;

  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }

  if (!tab?.id || !isChatGPTUrl(tab.url)) {
    return;
  }

  const state = getRuntimeState(tabId);
  state.pageUrl = tab.url;

  if (state.attached) {
    await persistState(tabId);
    return;
  }

  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);

    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
      maxTotalBufferSize: 1024 * 1024 * 10,
      maxResourceBufferSize: 1024 * 1024 * 2
    });

    state.attached = true;
    state.lastError = null;
    state.status = 'Подключено. Ожидаю запрос download?message_id…';
    state.pageUrl = tab.url;
    state.pendingRequests.clear();

    await persistState(tabId);
  } catch (error) {
    state.attached = false;
    state.status = 'Не удалось подключить debugger.';
    state.lastError = error?.message || String(error);
    await persistState(tabId);
  }
}

async function detachDebuggerFromTab(tabId, reasonText = 'Отключено вручную.') {
  const state = getRuntimeState(tabId);

  try {
    if (state.attached) {
      await chrome.debugger.detach({ tabId });
    }
  } catch {
    // Игнорируем: вкладка уже могла закрыться или debugger уже снят.
  }

  state.attached = false;
  state.pendingRequests.clear();
  state.status = reasonText;
  await persistState(tabId);
}

async function ensureChatGPTTabAttached(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);

    if (!tab?.id) {
      return;
    }

    if (isChatGPTUrl(tab.url)) {
      await attachDebuggerToTab(tabId);
    } else {
      await detachDebuggerFromTab(tabId, 'Вкладка ушла с chatgpt.com, debugger отключён.');
      await clearState(tabId);
    }
  } catch {
    // Вкладка недоступна — ничего не делаем.
  }
}

async function bootstrapExistingTabs() {
  const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
  await Promise.all(tabs.map((tab) => attachDebuggerToTab(tab.id)));
}

chrome.runtime.onInstalled.addListener(() => {
  bootstrapExistingTabs().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  bootstrapExistingTabs().catch(console.error);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (typeof changeInfo.url === 'string') {
    ensureChatGPTTabAttached(tabId).catch(console.error);
    return;
  }

  if (changeInfo.status === 'complete' && tab?.url) {
    ensureChatGPTTabAttached(tabId).catch(console.error);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await ensureChatGPTTabAttached(tabId).catch(console.error);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabRuntimeState.delete(tabId);
  chrome.storage.local.remove(getStorageKey(tabId)).catch(() => {});
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
  const tabId = source.tabId;
  if (typeof tabId !== 'number') {
    return;
  }

  const state = getRuntimeState(tabId);
  state.attached = false;
  state.pendingRequests.clear();
  state.status = formatDetachReason(reason);
  state.lastError = formatDetachReason(reason);
  await persistState(tabId);

  await notifyTab(tabId, {
    type: 'DEBUGGER_DETACHED',
    payload: {
      reason,
      message: formatDetachReason(reason)
    }
  });
});

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  if (typeof tabId !== 'number') {
    return;
  }

  const state = getRuntimeState(tabId);

  if (method === 'Network.responseReceived') {
    const requestId = params?.requestId;
    const responseUrl = params?.response?.url || '';

    if (requestId && DOWNLOAD_REQUEST_RE.test(responseUrl)) {
      state.pendingRequests.set(requestId, {
        requestUrl: responseUrl
      });

      await updateState(tabId, {
        status: 'Найден download?message_id. Ожидаю завершение ответа…',
        lastError: null,
        lastRequestUrl: responseUrl
      });
    }

    return;
  }

  if (method === 'Network.loadingFinished') {
    const requestId = params?.requestId;
    if (!requestId) {
      return;
    }

    const pending = state.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    state.pendingRequests.delete(requestId);
    await captureDownloadUrlFromResponse(tabId, requestId, pending.requestUrl);
    return;
  }

  if (method === 'Network.loadingFailed') {
    const requestId = params?.requestId;
    if (!requestId) {
      return;
    }

    const pending = state.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    state.pendingRequests.delete(requestId);
    await updateState(tabId, {
      status: 'Целевой download-запрос завершился с ошибкой.',
      lastError: params?.errorText || 'Network.loadingFailed',
      lastRequestUrl: pending.requestUrl
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'GET_TAB_STATE') {
      const tabId = message.tabId ?? sender.tab?.id;
      if (typeof tabId !== 'number') {
        sendResponse({ ok: false, error: 'tabId not found' });
        return;
      }

      const state = sanitizeStateForStorage(tabId);
      sendResponse({ ok: true, state });
      return;
    }

    if (message?.type === 'ATTACH_DEBUGGER') {
      const tabId = message.tabId;
      await attachDebuggerToTab(tabId);
      sendResponse({ ok: true, state: sanitizeStateForStorage(tabId) });
      return;
    }

    if (message?.type === 'DETACH_DEBUGGER') {
      const tabId = message.tabId;
      await detachDebuggerFromTab(tabId, 'Debugger отключён вручную.');
      sendResponse({ ok: true, state: sanitizeStateForStorage(tabId) });
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message type' });
  })().catch((error) => {
    sendResponse({ ok: false, error: error?.message || String(error) });
  });

  return true;
});
