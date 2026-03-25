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

  let logsData = [];
  let activeTab = 0;

  function renderTabs() {
    tabs.innerHTML = '';
    logsData.forEach((log, i) => {
      const tab = document.createElement('button');
      tab.className = 'logs-tab' + (i === activeTab ? ' active' : '');
      tab.textContent = log.name;
      tab.addEventListener('click', () => {
        activeTab = i;
        renderTabs();
        content.textContent = logsData[i].content || 'No logs available';
      });
      tabs.appendChild(tab);
    });
  }

  btn.addEventListener('click', async () => {
    if (panel.classList.contains('visible')) {
      panel.classList.remove('visible');
      document.body.classList.remove('logs-open');
      btn.textContent = 'Show Logs';
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
      content.textContent = logsData[0].content || 'No logs available';
      panel.classList.add('visible');
      document.body.classList.add('logs-open');
      btn.textContent = 'Hide Logs';
      // Scroll to bottom
      content.scrollTop = content.scrollHeight;
    } catch {
      btn.textContent = 'Show Logs';
    }
  });

  closeBtn.addEventListener('click', () => {
    panel.classList.remove('visible');
    document.body.classList.remove('logs-open');
    btn.textContent = 'Show Logs';
  });
})();
