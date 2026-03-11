// content.js
// Отвечает за мини-UI на странице ChatGPT:
// - показывает статус перехвата
// - отображает кнопку "Скачать напрямую"
// - умеет скачать файл через fetch(..., { credentials: 'include' })
// - умеет открыть прямую ссылку в новой вкладке

const ROOT_ID = 'chatgpt-direct-download-extension-root';
let latestDownloadUrl = null;

function createRoot() {
  let root = document.getElementById(ROOT_ID);
  if (root) {
    return root;
  }

  root = document.createElement('div');
  root.id = ROOT_ID;
  root.style.position = 'fixed';
  root.style.right = '16px';
  root.style.bottom = '16px';
  root.style.zIndex = '2147483647';
  root.style.width = '360px';
  root.style.maxWidth = 'calc(100vw - 32px)';
  root.style.background = 'rgba(20, 20, 20, 0.96)';
  root.style.color = '#fff';
  root.style.border = '1px solid rgba(255,255,255,0.12)';
  root.style.borderRadius = '14px';
  root.style.boxShadow = '0 12px 30px rgba(0,0,0,0.35)';
  root.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
  root.style.fontSize = '13px';
  root.style.lineHeight = '1.45';
  root.style.padding = '12px';

  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;">
      <strong style="font-size:14px;">ChatGPT Direct Download</strong>
      <button id="cgpt-dd-minimize" style="background:transparent;color:#bbb;border:none;cursor:pointer;font-size:12px;">Скрыть</button>
    </div>

    <div id="cgpt-dd-body">
      <div id="cgpt-dd-status" style="margin-bottom:10px;color:#d1d5db;">
        Инициализация…
      </div>

      <div id="cgpt-dd-url" style="display:none;margin-bottom:10px;word-break:break-all;background:rgba(255,255,255,0.06);padding:8px;border-radius:10px;color:#93c5fd;"></div>

      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        <button id="cgpt-dd-download" style="display:none;padding:8px 12px;border-radius:10px;border:none;cursor:pointer;background:#22c55e;color:#111;font-weight:600;">Скачать напрямую</button>
        <button id="cgpt-dd-open" style="display:none;padding:8px 12px;border-radius:10px;border:none;cursor:pointer;background:#60a5fa;color:#111;font-weight:600;">Открыть URL</button>
        <button id="cgpt-dd-copy" style="display:none;padding:8px 12px;border-radius:10px;border:none;cursor:pointer;background:#f59e0b;color:#111;font-weight:600;">Копировать URL</button>
      </div>
    </div>
  `;

  document.documentElement.appendChild(root);

  const minimizeBtn = root.querySelector('#cgpt-dd-minimize');
  const body = root.querySelector('#cgpt-dd-body');

  minimizeBtn.addEventListener('click', () => {
    const hidden = body.style.display === 'none';
    body.style.display = hidden ? 'block' : 'none';
    minimizeBtn.textContent = hidden ? 'Скрыть' : 'Показать';
  });

  root.querySelector('#cgpt-dd-download').addEventListener('click', async () => {
    if (!latestDownloadUrl) {
      return;
    }

    try {
      setStatus('Скачивание файла через fetch(credentials: include)…');
      await downloadByFetch(latestDownloadUrl);
      setStatus('Файл успешно скачан.');
    } catch (error) {
      console.error('[ChatGPT Direct Download] download error:', error);
      setStatus(`Ошибка скачивания: ${error?.message || String(error)}`);
    }
  });

  root.querySelector('#cgpt-dd-open').addEventListener('click', () => {
    if (!latestDownloadUrl) {
      return;
    }

    window.open(latestDownloadUrl, '_blank', 'noopener,noreferrer');
  });

  root.querySelector('#cgpt-dd-copy').addEventListener('click', async () => {
    if (!latestDownloadUrl) {
      return;
    }

    await navigator.clipboard.writeText(latestDownloadUrl);
    setStatus('Ссылка скопирована в буфер обмена.');
  });

  return root;
}

function setStatus(text) {
  const root = createRoot();
  root.querySelector('#cgpt-dd-status').textContent = text;
}

function setUrl(url) {
  const root = createRoot();
  latestDownloadUrl = url;

  const urlBox = root.querySelector('#cgpt-dd-url');
  urlBox.style.display = 'block';
  urlBox.textContent = url;

  root.querySelector('#cgpt-dd-download').style.display = 'inline-block';
  root.querySelector('#cgpt-dd-open').style.display = 'inline-block';
  root.querySelector('#cgpt-dd-copy').style.display = 'inline-block';
}

function getFilenameFromContentDisposition(contentDisposition) {
  if (!contentDisposition) {
    return null;
  }

  const utf8Match = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const plainMatch = contentDisposition.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (plainMatch?.[1]) {
    return plainMatch[1];
  }

  return null;
}

function guessFilenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const lastPart = parsed.pathname.split('/').filter(Boolean).pop();
    return lastPart || `chatgpt-file-${Date.now()}`;
  } catch {
    return `chatgpt-file-${Date.now()}`;
  }
}

async function downloadByFetch(url) {
  // ВАЖНО: credentials: 'include' — как просил пользователь.
  // Так cookies авторизации ChatGPT поедут вместе с запросом.
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentDisposition = response.headers.get('content-disposition');
  const filename = getFilenameFromContentDisposition(contentDisposition) || guessFilenameFromUrl(url);
  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);

  try {
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
  }
}

async function restoreStateFromBackground() {
  createRoot();
  setStatus('Подключаюсь к background…');

  const response = await chrome.runtime.sendMessage({
    type: 'GET_TAB_STATE'
  });

  if (!response?.ok) {
    setStatus('Не удалось получить состояние расширения.');
    return;
  }

  const state = response.state;
  if (state?.status) {
    setStatus(state.status);
  }

  if (state?.lastDownloadUrl) {
    setUrl(state.lastDownloadUrl);
    console.log('[ChatGPT Direct Download] download_url:', state.lastDownloadUrl);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'DOWNLOAD_URL_CAPTURED') {
    const downloadUrl = message.payload?.downloadUrl;

    if (downloadUrl) {
      console.log('[ChatGPT Direct Download] download_url:', downloadUrl);
      setStatus('Ссылка получена. Можно скачивать напрямую.');
      setUrl(downloadUrl);
    }
  }

  if (message?.type === 'FORCE_START_DOWNLOAD') {
    const downloadUrl = message.payload?.downloadUrl;

    if (downloadUrl) {
      setUrl(downloadUrl);
      downloadByFetch(downloadUrl)
        .then(() => setStatus('Файл успешно скачан.'))
        .catch((error) => {
          console.error('[ChatGPT Direct Download] forced download error:', error);
          setStatus(`Ошибка скачивания: ${error?.message || String(error)}`);
        });
    }
  }

  if (message?.type === 'DEBUGGER_DETACHED') {
    setStatus(message.payload?.message || 'Debugger отключён.');
  }
});

restoreStateFromBackground().catch((error) => {
  console.error('[ChatGPT Direct Download] init error:', error);
  setStatus(`Ошибка инициализации: ${error?.message || String(error)}`);
});
