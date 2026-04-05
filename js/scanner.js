/* ═══════════════════════════════════════════════
   GastoTracker — Screenshot Scanner (OCR)
   Uses Tesseract.js to read Mercado Pago screenshots
   ═══════════════════════════════════════════════ */

const Scanner = (() => {

  // ─── Known Mercado Pago labels to skip when searching for merchant ───

  const SKIP_PATTERNS = [
    /visa\s*cr[eé]dit/i,
    /mastercard/i,
    /visa\s*d[eé]bit/i,
    /pago\s+en\s+tienda/i,
    /^compra$/i,
    /^transferencia$/i,
    /pago\s+de\s+servicio/i,
    /^recarga$/i,
    /devoluci[oó]n/i,
    /^\d{1,2}:\d{2}\s*hs?\.?$/i,
    /pagos?\s+y\s+compras?/i,
    /^ventas?$/i,
    /^filtros?$/i,
    /^buscar$/i,
    /^actividad$/i,
    /^inicio$/i,
    /notificacion/i,
    /^m[aá]s$/i,
    /^\d{1,2}:\d{2}$/,
    /^Q\s/,
  ];

  function isSkipLabel(text) {
    const t = text.trim();
    if (t.length <= 2) return true;
    return SKIP_PATTERNS.some((re) => re.test(t));
  }

  // ─── Check if entire OCR text mentions "visa" (global check) ───

  function textHasVisa(fullText) {
    return /visa/i.test(fullText);
  }

  // ─── Run OCR on an image element or blob URL ───

  async function recognize(imageSource, onProgress) {
    const worker = await Tesseract.createWorker('spa', 1, {
      logger: (info) => {
        if (info.status === 'recognizing text' && onProgress) {
          onProgress(Math.round(info.progress * 100));
        }
      },
    });

    const { data } = await worker.recognize(imageSource);
    await worker.terminate();
    return data.text;
  }

  // ─── Parse Mercado Pago OCR text into charges ───

  const monthMap = {
    'ene': 0, 'feb': 1, 'mar': 2, 'abr': 3, 'may': 4, 'jun': 5,
    'jul': 6, 'ago': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dic': 11,
    'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3, 'mayo': 4, 'junio': 5,
    'julio': 6, 'agosto': 7, 'septiembre': 8, 'octubre': 9, 'noviembre': 10, 'diciembre': 11,
  };

  // Match amounts: -$824,50  -$1.462  -$ 2.212,75
  const amountRegex = /[-—–]\s*\$\s*([\d.,]+)/;
  const dateRegex = /^(\d{1,2})\s*(?:de\s+)?(\w{3,})\s*\.?$/i;
  const todayRegex = /^hoy$/i;
  const yesterdayRegex = /^ayer$/i;
  const timeRegex = /\d{1,2}:\d{2}\s*hs?\.?/i;

  function isDateLine(text) {
    const t = text.trim();
    if (todayRegex.test(t) || yesterdayRegex.test(t)) return true;
    const m = t.match(/^(\d{1,2})\s*(?:de\s+)?(\w{3,})\s*\.?$/i);
    if (m) {
      const monthStr = m[2].toLowerCase().replace('.', '');
      return monthMap[monthStr] !== undefined;
    }
    return false;
  }

  function parseDateFromLine(text) {
    const t = text.trim();
    if (todayRegex.test(t)) {
      const d = new Date(); d.setHours(12, 0, 0, 0); return d;
    }
    if (yesterdayRegex.test(t)) {
      const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(12, 0, 0, 0); return d;
    }
    const m = t.match(/(\d{1,2})\s*(?:de\s+)?(\w{3,})/i);
    if (m) {
      const day = parseInt(m[1]);
      const monthStr = m[2].toLowerCase().replace('.', '');
      const idx = monthMap[monthStr];
      if (idx !== undefined && day >= 1 && day <= 31) {
        const now = new Date();
        const d = new Date(now.getFullYear(), idx, day, 12, 0, 0);
        if (d > now) d.setFullYear(now.getFullYear() - 1);
        return d;
      }
    }
    return null;
  }

  function parseTransactions(ocrText) {
    const lines = ocrText.split('\n').map((l) => l.trim()).filter(Boolean);
    const transactions = [];

    // If OCR text contains "visa" anywhere, it's a Visa crédito view.
    // If not, include all transactions anyway (OCR might have missed it).
    // The user filters the screenshots they upload.

    let currentDate = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Track date headers (e.g., "4 de abril", "30 de marzo")
      if (isDateLine(line)) {
        currentDate = parseDateFromLine(line);
        continue;
      }

      // Look for amount patterns (must have a negative sign = expense)
      const amountMatch = line.match(amountRegex);
      if (!amountMatch) continue;

      const amount = parseAmount(amountMatch[1]);
      if (!amount || amount <= 0) continue;

      // Determine currency
      const isUSD = /US\$|U\$S|USD/i.test(line);
      const currency = isUSD ? 'USD' : 'UY$';

      // ── Extract merchant ──
      let merchant = null;
      let txDate = currentDate;

      // CASE 1: Merchant is on the SAME line, before the $ sign
      // e.g., "Frog -$824,50" or "Mercado Libre -$ 2.212,75"
      const dollarIdx = line.indexOf('$');
      if (dollarIdx > 2) {
        let prefix = line.substring(0, dollarIdx).trim();
        // Remove trailing dash/negative
        prefix = prefix.replace(/[-—–\s]+$/, '').trim();
        if (prefix.length > 1 && !isSkipLabel(prefix) && !/^\d+$/.test(prefix)) {
          merchant = cleanMerchant(prefix);
        }
      }

      // CASE 2: Look backwards through previous lines
      if (!merchant) {
        for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
          const prev = lines[j].trim();

          // Stop if we hit another amount (different transaction)
          if (amountRegex.test(prev)) break;

          // Stop if we hit a time from previous transaction
          if (timeRegex.test(prev) && prev.length < 12) break;

          // If it's a date header, grab it if needed and stop
          if (isDateLine(prev)) {
            if (!txDate) txDate = parseDateFromLine(prev);
            break;
          }

          // Skip known labels
          if (isSkipLabel(prev)) continue;

          // This should be the merchant name
          if (prev.length > 1 && !/^\d+$/.test(prev)) {
            merchant = cleanMerchant(prev);
            break;
          }
        }
      }

      // CASE 3: Also check the line immediately ABOVE for date if we haven't set one
      if (!txDate) {
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          if (isDateLine(lines[j])) {
            txDate = parseDateFromLine(lines[j]);
            break;
          }
        }
      }

      if (merchant && amount) {
        transactions.push({
          merchant: merchant,
          amount: amount,
          currency: currency,
          date: txDate || new Date(),
        });
      }
    }

    // Deduplicate results from the same scan
    const unique = [];
    const seen = new Set();
    for (const t of transactions) {
      const key = `${t.merchant.toLowerCase()}|${t.amount}|${t.date.toISOString().slice(0, 10)}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(t);
      }
    }

    return unique;
  }

  // ─── Helpers ───

  function parseAmount(raw) {
    let cleaned = raw.trim();
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');

    if (lastComma > lastDot) {
      // Latin: 1.234,56 → 1234.56
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else if (lastDot >= 0 && lastComma < 0) {
      // Only dots, no comma — check if dot is thousands separator
      // "1.462" (3 digits after dot) → 1462 (thousands)
      // "824.50" (2 digits after dot) → 824.50 (decimal)
      const afterLastDot = cleaned.substring(lastDot + 1);
      if (/^\d{3}$/.test(afterLastDot)) {
        // Dot followed by exactly 3 digits = thousands separator
        cleaned = cleaned.replace(/\./g, '');
      }
      // Otherwise leave as decimal
    } else if (lastDot > lastComma) {
      // US format: 1,234.56
      cleaned = cleaned.replace(/,/g, '');
    } else if (lastComma >= 0 && lastDot < 0) {
      // Only commas
      const parts = cleaned.split(',');
      if (parts.length === 2 && parts[1].length <= 2) {
        cleaned = cleaned.replace(',', '.');
      } else {
        cleaned = cleaned.replace(/,/g, '');
      }
    }

    const num = parseFloat(cleaned);
    return isNaN(num) ? null : Math.abs(num);
  }

  function cleanMerchant(text) {
    return text
      .replace(/^[-•·▪►»@]\s*/, '')
      .replace(/\s*[-•·▪►»]\s*$/, '')
      .replace(/^\d+[.\s]/, '')
      .trim();
  }

  // ─── Main entry: scan image and return parsed transactions ───

  async function scan(imageSource, onProgress) {
    const text = await recognize(imageSource, onProgress);
    const transactions = parseTransactions(text);
    return { text, transactions };
  }

  return { scan, parseTransactions, parseAmount };
})();
