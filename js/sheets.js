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

  return { upload, uploadBatch, syncAll, uploadAndMark };
})();
