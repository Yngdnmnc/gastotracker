/* ═══════════════════════════════════════════════
   GastoTracker — Main App Logic
   ═══════════════════════════════════════════════ */

(async () => {
  // ─── Service Worker registration ───
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // ─── Init Store ───
  await Store.init();

  // ─── State ───
  let currentMonth = new Date();
  let filterSource = null;
  let searchQuery = '';
  let pendingDeleteId = null;

  // ─── DOM refs ───
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const pages = {
    list: $('#page-list'),
    add: $('#page-add'),
    scan: $('#page-scan'),
    settings: $('#page-settings'),
  };

  // ─── Identity prompt on first launch ───
  if (!Store.getIdentity()) {
    $('#identity-overlay').classList.remove('hidden');
  }

  $$('.identity-pick').forEach((btn) => {
    btn.addEventListener('click', () => {
      Store.setIdentity(btn.dataset.identity);
      $('#identity-overlay').classList.add('hidden');
      refreshIdentityUI();
    });
  });

  function refreshIdentityUI() {
    const id = Store.getIdentity();
    $$('.identity-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.identity === id);
    });
  }

  // ─── Tab Navigation ───

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const pageId = tab.dataset.page;
      $$('.page').forEach((p) => p.classList.remove('active'));
      $(`#${pageId}`).classList.add('active');
      const titles = {
        'page-list': 'Gastos',
        'page-add': 'Nuevo Gasto',
        'page-scan': 'Escanear',
        'page-settings': 'Ajustes',
      };
      $('#header-title').textContent = titles[pageId] || 'Gastos';

      if (pageId === 'page-list') refreshList();
      if (pageId === 'page-settings') { refreshSettings(); refreshIdentityUI(); }
    });
  });

  // ═══════════════════════════════════════════
  // LIST PAGE
  // ═══════════════════════════════════════════

  // Month navigation
  $('#prev-month').addEventListener('click', () => {
    currentMonth.setMonth(currentMonth.getMonth() - 1);
    refreshList();
  });

  $('#next-month').addEventListener('click', () => {
    const next = new Date(currentMonth);
    next.setMonth(next.getMonth() + 1);
    if (next <= new Date()) {
      currentMonth = next;
      refreshList();
    }
  });

  // Filters
  $$('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      filterSource = chip.dataset.filter === 'all' ? null : chip.dataset.filter;
      refreshList();
    });
  });

  // Search
  $('#search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    refreshList();
  });

  // Sync button
  $('#sync-btn').addEventListener('click', async () => {
    if (!Store.getSheetsURL()) {
      alert('Primero configurá la URL de Google Sheets en Ajustes.');
      return;
    }
    try {
      const count = await Sheets.syncAll();
      refreshList();
      refreshSyncBadge();
      alert(count > 0 ? `${count} gastos sincronizados ✓` : 'Todo sincronizado ✓');
    } catch (err) {
      alert('Error al sincronizar: ' + err.message);
    }
  });

  async function refreshList() {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();

    // Month label
    const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    $('#current-month').textContent = `${monthNames[month]} ${year}`;

    // Disable next if current month
    const now = new Date();
    $('#next-month').disabled =
      year === now.getFullYear() && month === now.getMonth();

    // Totals
    const totals = await Store.totals(year, month);
    $('#total-uyu').textContent = formatNumber(totals['UY$']);
    $('#total-usd').textContent = formatNumber(totals['USD']);

    // Charges
    let charges = await Store.getByMonth(year, month);

    if (filterSource) {
      charges = charges.filter((c) => c.source === filterSource);
    }

    if (searchQuery) {
      charges = charges.filter((c) =>
        c.merchant.toLowerCase().includes(searchQuery) ||
        (c.notes && c.notes.toLowerCase().includes(searchQuery))
      );
    }

    const list = $('#charges-list');
    const empty = $('#empty-state');

    if (charges.length === 0) {
      list.classList.add('hidden');
      empty.classList.remove('hidden');
    } else {
      list.classList.remove('hidden');
      empty.classList.add('hidden');
      list.innerHTML = charges.map((c) => chargeHTML(c)).join('');

      // Bind delete buttons
      list.querySelectorAll('.charge-delete').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          pendingDeleteId = btn.dataset.id;
          $('#modal-text').textContent = '¿Borrar este gasto?';
          showModal(async () => {
            await Store.remove(pendingDeleteId);
            pendingDeleteId = null;
            refreshList();
            refreshSyncBadge();
          });
        });
      });
    }

    refreshSyncBadge();
  }

  function chargeHTML(c) {
    const emoji = c.origin === 'Mercado Pago' ? '💳' :
                  c.origin === 'PayPal' ? '🅿️' : '💰';
    const syncIcon = c.synced ? '' : '<span class="unsync-dot">⟳</span>';
    const d = new Date(c.date);
    const dateStr = d.toLocaleDateString('es-UY', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });

    return `
      <div class="charge-item">
        <span class="charge-emoji">${emoji}</span>
        <div class="charge-info">
          <div class="charge-merchant">${escapeHTML(c.merchant)}</div>
          <div class="charge-meta">
            <span>${escapeHTML(c.source)}</span>
            <span>·</span>
            <span>${escapeHTML(c.origin)}</span>
            ${syncIcon}
          </div>
        </div>
        <div class="charge-right">
          <div class="charge-amount">${c.currency} ${formatNumber(c.amount)}</div>
          <div class="charge-date">${dateStr}</div>
        </div>
        <button class="charge-delete" data-id="${c.id}" title="Borrar">✕</button>
      </div>
    `;
  }

  async function refreshSyncBadge() {
    const pending = await Store.getUnsynced();
    const badge = $('#sync-badge');
    if (pending.length > 0) {
      badge.textContent = pending.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // ═══════════════════════════════════════════
  // ADD PAGE
  // ═══════════════════════════════════════════

  let formState = {
    currency: 'UY$',
    source: 'Agustín',
    origin: 'Mercado Pago',
  };

  // Set default datetime
  function setDefaultDate() {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    $('#input-date').value = now.toISOString().slice(0, 16);
  }
  setDefaultDate();

  // Currency toggle
  $$('.currency-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.currency-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      formState.currency = btn.dataset.currency;
      validateForm();
    });
  });

  // Source toggle
  $$('[data-source]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('[data-source]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      formState.source = btn.dataset.source;
    });
  });

  // Origin toggle
  $$('[data-origin]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('[data-origin]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      formState.origin = btn.dataset.origin;
    });
  });

  // Validation
  $('#input-amount').addEventListener('input', validateForm);
  $('#input-merchant').addEventListener('input', validateForm);

  function validateForm() {
    const amount = parseFloat($('#input-amount').value);
    const merchant = $('#input-merchant').value.trim();
    $('#save-btn').disabled = !(amount > 0 && merchant.length > 0);
  }

  // Save
  $('#save-btn').addEventListener('click', async () => {
    const btn = $('#save-btn');
    btn.disabled = true;
    btn.textContent = 'Guardando...';

    const charge = {
      id: Store.uuid(),
      amount: parseFloat($('#input-amount').value),
      date: new Date($('#input-date').value).toISOString(),
      merchant: $('#input-merchant').value.trim(),
      source: formState.source,
      currency: formState.currency,
      origin: formState.origin,
      notes: ($('#input-notes').value || '').trim(),
      synced: false,
    };

    await Store.add(charge);

    // Try sync
    await Sheets.uploadAndMark(charge);

    // Toast
    showToast();

    // Reset form
    $('#input-amount').value = '';
    $('#input-merchant').value = '';
    $('#input-notes').value = '';
    setDefaultDate();
    btn.textContent = 'Guardar Gasto';
    validateForm();

    // Switch to list
    setTimeout(() => {
      $$('.tab')[0].click();
    }, 1200);
  });

  function showToast() {
    const toast = $('#toast');
    toast.classList.remove('hidden');
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.classList.add('hidden'), 300);
    }, 1200);
  }

  // ═══════════════════════════════════════════
  // SETTINGS PAGE
  // ═══════════════════════════════════════════

  // Load saved URL
  $('#input-sheets-url').value = Store.getSheetsURL();

  $('#save-url-btn').addEventListener('click', () => {
    const url = $('#input-sheets-url').value.trim();
    Store.setSheetsURL(url);
    alert(url ? 'URL guardada ✓' : 'URL eliminada');
  });

  $('#force-sync-btn').addEventListener('click', async () => {
    const btn = $('#force-sync-btn');
    btn.disabled = true;
    btn.textContent = 'Sincronizando...';
    try {
      const count = await Sheets.syncAll();
      alert(count > 0 ? `${count} gastos sincronizados ✓` : 'Todo sincronizado ✓');
    } catch (err) {
      alert('Error: ' + err.message);
    }
    btn.disabled = false;
    btn.textContent = 'Sincronizar pendientes';
    refreshSettings();
    refreshSyncBadge();
  });

  $('#clear-btn').addEventListener('click', () => {
    $('#modal-text').textContent = '¿Borrar TODOS los gastos locales?';
    showModal(async () => {
      await Store.clearAll();
      refreshSettings();
      refreshList();
      refreshSyncBadge();
    });
  });

  // Identity settings buttons
  $$('.identity-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      Store.setIdentity(btn.dataset.identity);
      refreshIdentityUI();
    });
  });

  async function refreshSettings() {
    const s = await Store.stats();
    $('#stat-total').textContent = s.total;
    $('#stat-synced').textContent = s.synced;
    $('#stat-pending').textContent = s.pending;
  }

  // ═══════════════════════════════════════════
  // SCANNER PAGE
  // ═══════════════════════════════════════════

  let scanFile = null;
  let scanResults = [];

  // Upload area click
  $('#scan-upload-area').addEventListener('click', () => {
    $('#scan-file-input').click();
  });

  // Drag and drop
  const uploadArea = $('#scan-upload-area');
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });
  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleScanFile(e.dataTransfer.files[0]);
    }
  });

  // File input change
  $('#scan-file-input').addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleScanFile(e.target.files[0]);
    }
  });

  function handleScanFile(file) {
    if (!file.type.startsWith('image/')) return;
    scanFile = file;
    const url = URL.createObjectURL(file);
    $('#scan-preview-img').src = url;
    $('#scan-preview').classList.remove('hidden');
    $('#scan-upload-area').classList.add('hidden');
    $('#scan-btn').disabled = false;
    // Reset previous results
    $('#scan-results').classList.add('hidden');
    $('#scan-progress').classList.add('hidden');
    scanResults = [];
  }

  // Remove image
  $('#scan-remove-img').addEventListener('click', () => {
    resetScanUI();
  });

  function resetScanUI() {
    scanFile = null;
    scanResults = [];
    const img = $('#scan-preview-img');
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = '';
    $('#scan-preview').classList.add('hidden');
    $('#scan-upload-area').classList.remove('hidden');
    $('#scan-btn').disabled = true;
    $('#scan-results').classList.add('hidden');
    $('#scan-progress').classList.add('hidden');
    $('#scan-file-input').value = '';
  }

  // Scan button
  $('#scan-btn').addEventListener('click', async () => {
    if (!scanFile) return;
    const btn = $('#scan-btn');
    btn.disabled = true;
    btn.textContent = 'Escaneando...';

    $('#scan-progress').classList.remove('hidden');
    $('#scan-results').classList.add('hidden');
    $('#scan-progress-fill').style.width = '0%';
    $('#scan-progress-text').textContent = 'Cargando motor OCR...';

    try {
      const imgUrl = URL.createObjectURL(scanFile);
      const { transactions } = await Scanner.scan(imgUrl, (pct) => {
        $('#scan-progress-fill').style.width = pct + '%';
        $('#scan-progress-text').textContent = pct < 100
          ? `Leyendo imagen... ${pct}%`
          : 'Analizando texto...';
      });
      URL.revokeObjectURL(imgUrl);

      scanResults = transactions;
      await renderScanResults(transactions);
    } catch (err) {
      alert('Error al escanear: ' + err.message);
    }

    btn.disabled = false;
    btn.textContent = 'Escanear imagen';
    $('#scan-progress').classList.add('hidden');
  });

  async function renderScanResults(transactions) {
    const list = $('#scan-results-list');
    list.innerHTML = '';

    if (transactions.length === 0) {
      $('#scan-results-title').textContent = 'No se encontraron gastos';
      list.innerHTML = '<p class="hint">Intentá con otra captura de Mercado Pago.</p>';
      $('#scan-results').classList.remove('hidden');
      $('#scan-save-all').classList.add('hidden');
      return;
    }

    $('#scan-results-title').textContent = `${transactions.length} gasto(s) encontrado(s)`;
    $('#scan-save-all').classList.remove('hidden');

    for (let i = 0; i < transactions.length; i++) {
      const t = transactions[i];
      const dup = await Store.isDuplicate({
        amount: t.amount,
        merchant: t.merchant,
        date: t.date.toISOString(),
      });

      const dateStr = t.date.toLocaleDateString('es-UY', {
        day: '2-digit', month: 'short',
      });

      const div = document.createElement('div');
      div.className = 'scan-result-item' + (dup ? ' duplicate' : '');
      div.innerHTML = `
        <input type="checkbox" data-idx="${i}" ${dup ? '' : 'checked'}>
        <div class="scan-result-info">
          <div class="scan-result-merchant">${escapeHTML(t.merchant)}</div>
          <div class="scan-result-meta">${dateStr} · ${t.currency}${dup ? ' · <span class="scan-result-dup-label">Posible duplicado</span>' : ''}</div>
        </div>
        <div class="scan-result-amount">${t.currency} ${formatNumber(t.amount)}</div>
      `;
      list.appendChild(div);
    }

    $('#scan-results').classList.remove('hidden');
  }

  // Save all checked results
  $('#scan-save-all').addEventListener('click', async () => {
    const checkboxes = $$('#scan-results-list input[type="checkbox"]');
    const identity = Store.getIdentity() || 'Agustín';
    let saved = 0;

    const btn = $('#scan-save-all');
    btn.disabled = true;
    btn.textContent = 'Guardando...';

    for (const cb of checkboxes) {
      if (!cb.checked) continue;
      const idx = parseInt(cb.dataset.idx);
      const t = scanResults[idx];
      if (!t) continue;

      const charge = {
        id: Store.uuid(),
        amount: t.amount,
        date: t.date.toISOString(),
        merchant: t.merchant,
        source: identity,
        currency: t.currency,
        origin: 'Mercado Pago',
        notes: '',
        synced: false,
      };

      await Store.add(charge);
      saved++;
    }

    // Single batch sync to avoid duplicate uploads
    if (saved > 0) {
      try { await Sheets.syncAll(); } catch {}

      const toast = $('#scan-toast');
      $('#scan-toast-text').textContent = `¡${saved} gasto(s) importado(s)!`;
      toast.classList.remove('hidden');
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.classList.add('hidden'), 300);
      }, 1500);

      resetScanUI();
      refreshSyncBadge();
    }

    btn.disabled = false;
    btn.textContent = 'Guardar todos';
  });

  // ═══════════════════════════════════════════
  // MODAL
  // ═══════════════════════════════════════════

  let modalCallback = null;

  function showModal(onConfirm) {
    modalCallback = onConfirm;
    $('#modal-overlay').classList.remove('hidden');
  }

  $('#modal-cancel').addEventListener('click', () => {
    $('#modal-overlay').classList.add('hidden');
    modalCallback = null;
  });

  $('#modal-confirm').addEventListener('click', async () => {
    $('#modal-overlay').classList.add('hidden');
    if (modalCallback) {
      await modalCallback();
      modalCallback = null;
    }
  });

  // Close modal on overlay click
  $('#modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('#modal-overlay')) {
      $('#modal-overlay').classList.add('hidden');
      modalCallback = null;
    }
  });

  // ═══════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════

  function formatNumber(n) {
    return n.toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Initial load ───
  refreshList();
  refreshSyncBadge();
})();
