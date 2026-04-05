/* ═══════════════════════════════════════════════
   GastoTracker — Google Sheets Sync
   ═══════════════════════════════════════════════ */

const Sheets = (() => {

  // ─── Upload a single charge ───

  async function upload(charge) {
    const url = Store.getSheetsURL();
    if (!url) throw new Error('No se configuró la URL de Google Sheets');

    const payload = {
      id: charge.id,
      date: charge.date,
      amount: charge.amount,
      currency: charge.currency,
      merchant: charge.merchant,
      source: charge.source,
      origin: charge.origin,
      notes: charge.notes,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Error del servidor: ${response.status}`);
    }

    return response.json();
  }

  // ─── Batch upload ───

  async function uploadBatch(charges) {
    const url = Store.getSheetsURL();
    if (!url) throw new Error('No se configuró la URL de Google Sheets');

    const rows = charges.map((c) => ({
      id: c.id,
      date: c.date,
      amount: c.amount,
      currency: c.currency,
      merchant: c.merchant,
      source: c.source,
      origin: c.origin,
      notes: c.notes,
    }));

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ batch: rows }),
    });

    if (!response.ok) {
      throw new Error(`Error del servidor: ${response.status}`);
    }

    return response.json();
  }

  // ─── Sync all unsynced ───

  async function syncAll() {
    const pending = await Store.getUnsynced();
    if (pending.length === 0) return 0;

    await uploadBatch(pending);

    const ids = pending.map((c) => c.id);
    await Store.markSynced(ids);

    return pending.length;
  }

  // ─── Upload and mark synced ───

  async function uploadAndMark(charge) {
    try {
      await upload(charge);
      await Store.markSynced([charge.id]);
      return true;
    } catch {
      // Will sync later
      return false;
    }
  }

  // ─── Download all charges from Sheets ───

  async function download() {
    const url = Store.getSheetsURL();
    if (!url) throw new Error('No se configuró la URL de Google Sheets');

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Error del servidor: ${response.status}`);
    }

    const json = await response.json();
    if (json.status !== 'ok' || !Array.isArray(json.data)) {
      throw new Error('Respuesta inesperada del servidor');
    }

    // Convert Sheets rows to charge objects
    return json.data.map((row) => ({
      id: row['ID'] || Store.uuid(),
      date: parseSheetDate(row['Fecha']),
      amount: parseFloat(row['Monto']) || 0,
      currency: row['Moneda'] || 'UY$',
      merchant: row['Comercio'] || '',
      source: row['Persona'] || '',
      origin: row['Origen'] || 'Mercado Pago',
      notes: row['Notas'] || '',
      synced: true,
    }));
  }

  function parseSheetDate(val) {
    if (!val) return new Date().toISOString();
    if (val instanceof Date) return val.toISOString();
    // Format from Sheets: "dd/MM/yyyy HH:mm"
    const parts = String(val).split(' ');
    const dmy = parts[0].split('/');
    if (dmy.length >= 3) {
      const hm = parts[1] ? parts[1].split(':') : [12, 0];
      const d = new Date(parseInt(dmy[2]), parseInt(dmy[1]) - 1, parseInt(dmy[0]),
        parseInt(hm[0]) || 12, parseInt(hm[1]) || 0);
      return d.toISOString();
    }
    // Try native parse as fallback
    const d = new Date(val);
    return isNaN(d) ? new Date().toISOString() : d.toISOString();
  }

  return { upload, uploadBatch, syncAll, uploadAndMark, download };
})();
