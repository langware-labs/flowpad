// Loading screen renderer — listens for startup status IPC messages
// and updates the status text element.

if (window.electronAPI && window.electronAPI.onStartupStatus) {
  window.electronAPI.onStartupStatus((message) => {
    const el = document.getElementById('status-text');
    if (el) {
      // textContent, not innerHTML: the message now carries raw `uv tool
      // install` progress lines, which must render as text, never as markup.
      el.textContent = message;
      const dots = document.createElement('span');
      dots.className = 'dots';
      el.appendChild(dots);
    }
  });
}

// Logs panel
(function () {
  const btn = document.getElementById('show-logs-btn');
  const panel = document.getElementById('logs-panel');
  const tabs = document.getElementById('logs-tabs');
  const content = document.getElementById('logs-content');
  const closeBtn = document.getElementById('logs-close');

  if (!btn || !panel || !window.electronAPI || !window.electronAPI.getStartupLogs) return;

  let logsData = [];   // [{ name, path, content }]
  let activeTab = 0;
  let isOpen = false;

  function showActiveTab() {
    const activeLog = logsData[activeTab];
    content.textContent = (activeLog && activeLog.content) || 'No logs available';
  }

  function renderTabs() {
    tabs.innerHTML = '';
    logsData.forEach((log, i) => {
      const tab = document.createElement('button');
      tab.className = 'logs-tab' + (i === activeTab ? ' active' : '');
      tab.textContent = log.name;
      tab.addEventListener('click', () => {
        activeTab = i;
        renderTabs();
        showActiveTab();
        content.scrollTop = content.scrollHeight;
      });
      tabs.appendChild(tab);
    });
  }

  function openPanel() {
    panel.classList.add('visible');
    document.body.classList.add('logs-open');
    btn.textContent = 'Hide Logs';
    isOpen = true;

    // Start live tailing
    if (window.electronAPI.watchStartupLogs) {
      window.electronAPI.watchStartupLogs();
    }
  }

  function closePanel() {
    panel.classList.remove('visible');
    document.body.classList.remove('logs-open');
    btn.textContent = 'Show Logs';
    isOpen = false;

    // Stop live tailing
    if (window.electronAPI.unwatchStartupLogs) {
      window.electronAPI.unwatchStartupLogs();
    }
  }

  // Listen for live log updates
  if (window.electronAPI.onStartupLogsUpdate) {
    window.electronAPI.onStartupLogsUpdate((updates) => {
      if (!isOpen) return;

      for (const update of updates) {
        const existing = logsData.find((l) => l.name === update.name);
        if (existing) {
          existing.content += update.content;
        } else {
          logsData.push({ name: update.name, content: update.content });
          renderTabs();
        }
      }

      // Update the visible content if the active tab received new data
      if (logsData[activeTab]) {
        const isAtBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 40;
        showActiveTab();
        if (isAtBottom) {
          content.scrollTop = content.scrollHeight;
        }
      }
    });
  }

  btn.addEventListener('click', async () => {
    if (isOpen) {
      closePanel();
      return;
    }

    btn.textContent = 'Loading...';
    try {
      logsData = await window.electronAPI.getStartupLogs();
      if (!logsData.length) {
        logsData = [{ name: 'Logs', content: 'No logs available yet.' }];
      }
      activeTab = 0;
      renderTabs();
      showActiveTab();
      openPanel();
      content.scrollTop = content.scrollHeight;
    } catch {
      btn.textContent = 'Show Logs';
    }
  });

  closeBtn.addEventListener('click', closePanel);
})();

// Startup-timeout recovery panel — shown instead of the native OS error popup
// when the backend fails to come up. Renders the two exact recovery commands,
// each with a copy button, plus a Quit button.
(function () {
  const api = window.electronAPI;
  if (!api || !api.onStartupError) return;

  const overlay = document.getElementById('error-overlay');
  const detailEl = document.getElementById('error-detail');
  const upgradeEl = document.getElementById('upgrade-cmd');
  const diagnoseEl = document.getElementById('diagnose-cmd');
  const quitBtn = document.getElementById('quit-btn');
  const retryBtn = document.getElementById('retry-btn');
  const spinner = document.querySelector('.spinner');
  const statusEl = document.getElementById('status-text');

  function wireCopy(buttonId, getText) {
    const button = document.getElementById(buttonId);
    if (!button) return;
    const label = button.querySelector('.copy-label');
    button.addEventListener('click', async () => {
      try {
        await api.copyToClipboard(getText());
        button.classList.add('copied');
        if (label) label.textContent = 'Copied';
        setTimeout(() => {
          button.classList.remove('copied');
          if (label) label.textContent = 'Copy';
        }, 1500);
      } catch {
        /* ignore copy failures */
      }
    });
  }

  wireCopy('copy-upgrade', () => upgradeEl.textContent);
  wireCopy('copy-diagnose', () => diagnoseEl.textContent);

  if (quitBtn && api.quitApp) {
    quitBtn.addEventListener('click', () => api.quitApp());
  }

  // Retry: back to the loading view, main re-runs the install/start and
  // streams its progress into the status line as on first launch.
  if (retryBtn && api.retryStartup) {
    retryBtn.addEventListener('click', () => {
      if (overlay) overlay.classList.remove('visible');
      if (spinner) spinner.style.display = '';
      if (statusEl) statusEl.textContent = 'Retrying';
      api.retryStartup();
    });
  }

  api.onStartupError((data) => {
    if (!data) return;
    if (detailEl) detailEl.textContent = data.detail || '';
    if (upgradeEl) upgradeEl.textContent = data.upgradeCommand || '';
    if (diagnoseEl) diagnoseEl.textContent = data.diagnoseCommand || '';
    if (retryBtn) retryBtn.hidden = !data.retryable;
    if (overlay) overlay.classList.add('visible');
    // Stop the spinner/status from animating behind the overlay.
    if (spinner) spinner.style.display = 'none';
  });
})();
