// Loading screen renderer — listens for startup status IPC messages
// and updates the status text element.

if (window.electronAPI && window.electronAPI.onStartupStatus) {
  window.electronAPI.onStartupStatus((message) => {
    const el = document.getElementById('status-text');
    if (el) {
      el.innerHTML = message + '<span class="dots"></span>';
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
