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
  const repairBtn = document.getElementById('repair-btn');
  const updateBtn = document.getElementById('update-btn');
  const exportBtn = document.getElementById('export-logs');
  const recoveryNote = document.getElementById('recovery-note');
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

  // "Copy error details": the whole message the panel shows, plus where the logs are, so a
  // user can paste it into a support message instead of photographing the screen.
  const logPathEl = document.getElementById('error-logpath');
  const copyDetailsBtn = document.getElementById('copy-details');
  if (copyDetailsBtn) {
    copyDetailsBtn.addEventListener('click', async () => {
      const text = [
        detailEl && detailEl.textContent,
        logPathEl && !logPathEl.hidden ? logPathEl.textContent : '',
      ].filter(Boolean).join('\n\n');
      try {
        await api.copyToClipboard(text);
        copyDetailsBtn.textContent = 'Copied';
        setTimeout(() => { copyDetailsBtn.textContent = 'Copy error details'; }, 1500);
      } catch {
        /* ignore copy failures */
      }
    });
  }
  const openLogsBtn = document.getElementById('open-logs');
  if (openLogsBtn && api.openLogsFolder) {
    openLogsBtn.addEventListener('click', () => { api.openLogsFolder().catch(() => {}); });
  }

  // "Share with us": main builds the zip and opens the user's mail client; we only report back
  // which file to attach, since a mailto: link cannot carry the attachment itself.
  const shareBtn = document.getElementById('share-logs');
  const shareStatus = document.getElementById('share-status');
  const shareIdle = shareStatus ? shareStatus.textContent : '';
  if (shareBtn && api.shareLogs) {
    shareBtn.addEventListener('click', async () => {
      shareBtn.disabled = true;
      shareBtn.textContent = 'Preparing…';
      try {
        const r = await api.shareLogs(detailEl ? detailEl.textContent : '');
        if (shareStatus) {
          shareStatus.className = 'error-share-note ' + (r && r.ok ? 'ok' : 'fail');
          shareStatus.textContent = r && r.ok
            ? `Your email app is opening a message to ${r.to}. Attach this file (it is highlighted in your file manager): ${r.zipPath}`
            : `Couldn’t prepare the logs${r && r.error ? `: ${r.error}` : ''}. Use “Open logs folder” and attach the newest files by hand.`;
        }
      } catch (e) {
        if (shareStatus) {
          shareStatus.className = 'error-share-note fail';
          shareStatus.textContent = `Couldn’t prepare the logs: ${e && e.message ? e.message : e}`;
        }
      } finally {
        shareBtn.disabled = false;
        shareBtn.textContent = 'Share with us';
      }
    });
  }
  // A new error re-arms the note (a retry that fails again shows the default text).
  const resetShareNote = () => { if (shareStatus) { shareStatus.className = 'error-share-note'; shareStatus.textContent = shareIdle; } };

  // "Export logs": the same zip as "Share with us", saved where the user chooses (no mail client needed).
  if (exportBtn && api.exportLogs) {
    exportBtn.addEventListener('click', async () => {
      exportBtn.disabled = true;
      exportBtn.textContent = 'Exporting…';
      try {
        const r = await api.exportLogs(detailEl ? detailEl.textContent : '');
        if (shareStatus && !(r && r.canceled)) {
          shareStatus.className = 'error-share-note ' + (r && r.ok ? 'ok' : 'fail');
          shareStatus.textContent = r && r.ok
            ? `Logs saved to ${r.zipPath}. Send that file to the FlowPad team.`
            : `Couldn’t export the logs${r && r.error ? `: ${r.error}` : ''}. Use “Open logs folder” and copy the newest files by hand.`;
        }
      } catch (e) {
        if (shareStatus) { shareStatus.className = 'error-share-note fail'; shareStatus.textContent = `Couldn’t export the logs: ${e && e.message ? e.message : e}`; }
      } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = 'Export logs';
      }
    });
  }

  // "Update FlowPad to X": the desktop updater downloads and verifies the release, then the app restarts
  // into the installer. Main streams the download into the status line.
  if (updateBtn && api.updateDesktopRecovery) {
    updateBtn.addEventListener('click', () => {
      if (overlay) overlay.classList.remove('visible');
      if (spinner) spinner.style.display = '';
      if (statusEl) statusEl.textContent = 'Downloading the FlowPad update';
      api.updateDesktopRecovery();
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

  // Repair: the user's explicit go-ahead for the runtime repair. Back to the loading view; main
  // streams each step ("downloading Python 3.11.9 from python.org — 40%") into the status line.
  if (repairBtn && api.repairRuntime) {
    repairBtn.addEventListener('click', () => {
      if (overlay) overlay.classList.remove('visible');
      if (spinner) spinner.style.display = '';
      if (statusEl) statusEl.textContent = 'Repairing the FlowPad runtime';
      api.repairRuntime();
    });
  }

  api.onStartupError((data) => {
    if (!data) return;
    if (detailEl) detailEl.textContent = data.detail || '';
    resetShareNote();
    if (logPathEl) {
      logPathEl.hidden = !data.logPath;
      logPathEl.textContent = data.logPath ? `Logs: ${data.logPath}` : '';
    }
    if (upgradeEl) upgradeEl.textContent = data.upgradeCommand || '';
    if (diagnoseEl) diagnoseEl.textContent = data.diagnoseCommand || '';
    if (retryBtn) { retryBtn.hidden = !data.retryable; retryBtn.textContent = data.retryLabel || 'Retry'; }
    if (repairBtn) repairBtn.hidden = !data.repairable;
    if (updateBtn) { updateBtn.hidden = !data.updateVersion; updateBtn.textContent = data.updateVersion ? `Update FlowPad to ${data.updateVersion}` : 'Update FlowPad'; }
    if (exportBtn) exportBtn.hidden = !data.exportable;
    if (recoveryNote) { recoveryNote.hidden = !data.retryWarning; recoveryNote.textContent = data.retryWarning || ''; }
    document.querySelectorAll('.error-step').forEach((el) => { el.hidden = !!data.policyBlocked; });
    if (overlay) overlay.classList.add('visible');
    // Stop the spinner/status from animating behind the overlay.
    if (spinner) spinner.style.display = 'none';
  });
})();
