document.addEventListener('DOMContentLoaded', async () => {
  const serverStatusEl = document.getElementById('server-status');
  const tabStatusEl = document.getElementById('tab-status');
  const sessionRowEl = document.getElementById('session-row');
  const sessionStatusEl = document.getElementById('session-status');
  const serverUrlInput = document.getElementById('server-url');
  const pairingCodeInput = document.getElementById('pairing-code');
  const pairBtn = document.getElementById('pair-btn');
  const disconnectBtn = document.getElementById('disconnect-btn');
  const unpairedActions = document.getElementById('unpaired-actions');
  const pairedActions = document.getElementById('paired-actions');
  const msgEl = document.getElementById('msg');

  function showMessage(text, isError = false) {
    msgEl.textContent = text;
    msgEl.style.color = isError ? '#ef4444' : '#22c55e';
    setTimeout(() => {
      msgEl.textContent = '';
    }, 4000);
  }

  // Load saved config
  const data = await chrome.storage.local.get(['serverUrl']);
  if (data.serverUrl) {
    serverUrlInput.value = data.serverUrl;
  }

  function updateStatus() {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        serverStatusEl.innerHTML = '<span class="dot dot-red"></span>Offline';
        tabStatusEl.innerHTML = '<span class="dot dot-red"></span>Unknown';
        sessionRowEl.style.display = 'none';
        unpairedActions.style.display = 'block';
        pairedActions.style.display = 'none';
        return;
      }

      if (res.connected) {
        serverStatusEl.innerHTML = '<span class="dot dot-green"></span>Connected';
        sessionStatusEl.textContent = res.sessionToken || 'Active';
        sessionRowEl.style.display = 'flex';
        unpairedActions.style.display = 'none';
        pairedActions.style.display = 'block';
      } else {
        serverStatusEl.innerHTML = '<span class="dot dot-red"></span>Disconnected';
        sessionRowEl.style.display = 'none';
        unpairedActions.style.display = 'block';
        pairedActions.style.display = 'none';
      }

      if (res.hasChatGptTab) {
        tabStatusEl.innerHTML = '<span class="dot dot-green"></span>Ready';
      } else {
        tabStatusEl.innerHTML = '<span class="dot dot-red"></span>No Tab Open';
      }
    });
  }

  serverUrlInput.addEventListener('change', async () => {
    const url = serverUrlInput.value.trim().replace(/\/$/, '');
    await chrome.storage.local.set({ serverUrl: url });
    showMessage('Server URL updated');
    updateStatus();
  });

  pairBtn.addEventListener('click', async () => {
    const url = serverUrlInput.value.trim().replace(/\/$/, '');
    await chrome.storage.local.set({ serverUrl: url });
    const code = pairingCodeInput.value.trim();

    pairBtn.disabled = true;
    pairBtn.textContent = 'Pairing...';

    chrome.runtime.sendMessage({ type: 'PAIR_WITH_CODE', code }, (res) => {
      pairBtn.disabled = false;
      pairBtn.textContent = 'Pair Extension';
      if (chrome.runtime.lastError || !res || !res.ok) {
        showMessage(res?.error || 'Pairing failed. Is OmniRoute running?', true);
      } else {
        showMessage('Successfully paired with OmniRoute!');
        pairingCodeInput.value = '';
        updateStatus();
      }
    });
  });

  disconnectBtn.addEventListener('click', () => {
    disconnectBtn.disabled = true;
    chrome.runtime.sendMessage({ type: 'RESET_SESSION' }, () => {
      disconnectBtn.disabled = false;
      showMessage('Disconnected from OmniRoute');
      updateStatus();
    });
  });

  updateStatus();
  setInterval(updateStatus, 2000);
});
