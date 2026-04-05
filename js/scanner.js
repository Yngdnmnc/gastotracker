/* ═══════════════════════════════════════════════
   GastoTracker — Screenshot Scanner (OCR)
   Uses Tesseract.js to read Mercado Pago screenshots
   ═══════════════════════════════════════════════ */

const Scanner = (() => {

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
  //
  // Mercado Pago screenshots typically show transactions like:
  //   "Supermercado Tata"
  //   "28 mar"  or  "28 de mar"  or "28 mar."  or "Ayer" / "Hoy"
  //   "-$ 1.234"  or  "- $ 1.234,56"  or  "$1234"
  //
  // Sometimes they appear as:
  //   Merchant name
  //   Date text
  //   Amount with negative sign and $ symbol
  //
  // The parser looks for amount patterns and works backwards to find
  // the merchant and date.

  function parseTransactions(ocrText) {
    const lines = ocrText.split('\n').map((l) => l.trim()).filter(Boolean);
    const transactions = [];

    // Regex for amounts: captures negative amounts with $ sign
    // Matches:  -$ 1.234   - $ 500   -$1.234,56   $ -500   -$ 1,234.56
    const amountRegex = /[-—–]?\s*\$\s*[-—–]?\s*([\d.,]+)/;

    // Regex for dates: "28 mar", "3 de abr", "28 mar.", "02 abr", "Hoy", "Ayer"
    const monthMap = {
      'ene': 0, 'feb': 1, 'mar': 2, 'abr': 3, 'may': 4, 'jun': 5,
      'jul': 6, 'ago': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dic': 11,
      'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3, 'mayo': 4, 'junio': 5,
      'julio': 6, 'agosto': 7, 'septiembre': 8, 'octubre': 9, 'noviembre': 10, 'diciembre': 11,
    };
    const dateRegex = /(\d{1,2})\s*(?:de\s+)?(\w{3,})\s*\.?/i;
    const todayRegex = /^hoy$/i;
    const yesterdayRegex = /^ayer$/i;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const amountMatch = line.match(amountRegex);
      if (!amountMatch) continue;

      const amount = parseAmount(amountMatch[1]);
      if (!amount || amount <= 0) continue;

      // Determine currency — if line contains "US$" or "U$S" or "USD" it's dollars
      const isUSD = /US\$|U\$S|USD/i.test(line);
      const currency = isUSD ? 'USD' : 'UY$';

      // Look backwards for date and merchant
      let dateStr = null;
      let parsedDate = null;
      let merchant = null;

      // Search the previous lines (up to 4) for a date and merchant
      for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
        const prev = lines[j];
        
        if (!dateStr) {
          if (todayRegex.test(prev)) {
            parsedDate = new Date();
            parsedDate.setHours(12, 0, 0, 0);
            dateStr = prev;
            continue;
          }
          if (yesterdayRegex.test(prev)) {
            parsedDate = new Date();
            parsedDate.setDate(parsedDate.getDate() - 1);
            parsedDate.setHours(12, 0, 0, 0);
            dateStr = prev;
            continue;
          }
          const dm = prev.match(dateRegex);
          if (dm) {
            const day = parseInt(dm[1]);
            const monthStr = dm[2].toLowerCase().replace('.', '');
            const monthIdx = monthMap[monthStr];
            if (monthIdx !== undefined && day >= 1 && day <= 31) {
              const now = new Date();
              let year = now.getFullYear();
              parsedDate = new Date(year, monthIdx, day, 12, 0, 0);
              // If the date is in the future, it's probably last year
              if (parsedDate > now) {
                parsedDate.setFullYear(year - 1);
              }
              dateStr = prev;
              continue;
            }
          }
        }

        // If we haven't found a merchant yet, and this line doesn't look
        // like an amount or a purely numeric/date line, it's likely the merchant
        if (!merchant && !amountRegex.test(prev) && prev.length > 1) {
          // Skip lines that are just dates or very short
          const looksLikeDate = todayRegex.test(prev) || yesterdayRegex.test(prev) || 
            (prev.match(dateRegex) && prev.length < 20);
          if (!looksLikeDate) {
            merchant = cleanMerchant(prev);
          }
        }
      }

      // Also check the line right after the amount for a date
      if (!parsedDate && i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        const dm = nextLine.match(dateRegex);
        if (dm) {
          const day = parseInt(dm[1]);
          const monthStr = dm[2].toLowerCase().replace('.', '');
          const monthIdx = monthMap[monthStr];
          if (monthIdx !== undefined) {
            const now = new Date();
            parsedDate = new Date(now.getFullYear(), monthIdx, day, 12, 0, 0);
            if (parsedDate > now) parsedDate.setFullYear(now.getFullYear() - 1);
          }
        }
      }

      if (merchant && amount) {
        transactions.push({
          merchant: merchant,
          amount: amount,
          currency: currency,
          date: parsedDate || new Date(),
          dateText: dateStr || '',
        });
      }
    }

    // Deduplicate results from the same scan (same amount + merchant)
    const unique = [];
    const seen = new Set();
    for (const t of transactions) {
      const key = `${t.merchant.toLowerCase()}|${t.amount}|${t.date.toISOString().slice(0,10)}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(t);
      }
    }

    return unique;
  }

  // ─── Alternative top-down parser ───
  // Mercado Pago transaction lists often have a repeating pattern:
  //   [merchant]  [date]  [amount]
  // This parser tries to detect that pattern

  function parseTransactionsAlt(ocrText) {
    const lines = ocrText.split('\n').map((l) => l.trim()).filter(Boolean);
    const transactions = [];
    const amountRegex = /[-—–]?\s*\$\s*[-—–]?\s*([\d.,]+)/;
    
    let currentMerchant = null;
    let currentDate = null;

    for (const line of lines) {
      // Try to detect amount
      const amountMatch = line.match(amountRegex);
      
      if (amountMatch) {
        const amount = parseAmount(amountMatch[1]);
        if (amount && amount > 0 && currentMerchant) {
          const isUSD = /US\$|U\$S|USD/i.test(line);
          transactions.push({
            merchant: currentMerchant,
            amount: amount,
            currency: isUSD ? 'USD' : 'UY$',
            date: currentDate || new Date(),
            dateText: '',
          });
          currentMerchant = null;
          currentDate = null;
        }
      } else {
        // Try to detect date
        const maybeDate = tryParseDate(line);
        if (maybeDate) {
          currentDate = maybeDate;
        } else if (line.length > 2 && !/^\d+$/.test(line)) {
          // Looks like a merchant name
          currentMerchant = cleanMerchant(line);
        }
      }
    }

    return transactions;
  }

  function tryParseDate(text) {
    const monthMap = {
      'ene': 0, 'feb': 1, 'mar': 2, 'abr': 3, 'may': 4, 'jun': 5,
      'jul': 6, 'ago': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dic': 11,
    };
    if (/^hoy$/i.test(text)) {
      const d = new Date(); d.setHours(12,0,0,0); return d;
    }
    if (/^ayer$/i.test(text)) {
      const d = new Date(); d.setDate(d.getDate()-1); d.setHours(12,0,0,0); return d;
    }
    const m = text.match(/(\d{1,2})\s*(?:de\s+)?(\w{3,})/i);
    if (m) {
      const day = parseInt(m[1]);
      const monthStr = m[2].toLowerCase().replace('.','');
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

  // ─── Helpers ───

  function parseAmount(raw) {
    let cleaned = raw.trim();
    // Handle format: "1.234,56" (Latin) vs "1,234.56" (US)
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    
    if (lastComma > lastDot) {
      // Latin: 1.234,56 → 1234.56
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else if (lastDot > lastComma) {
      // Could be US (1,234.56) or just thousands dots (1.234)
      cleaned = cleaned.replace(/,/g, '');
    } else if (lastComma >= 0 && lastDot < 0) {
      // Only commas — if last part has <=2 digits it's decimal
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
    // Remove common prefixes/suffixes from OCR noise
    return text
      .replace(/^[-•·▪►»]\s*/, '')
      .replace(/\s*[-•·▪►»]\s*$/, '')
      .replace(/^\d+[.\s]/, '')
      .trim();
  }

  // ─── Main entry: scan image and return parsed transactions ───

  async function scan(imageSource, onProgress) {
    const text = await recognize(imageSource, onProgress);
    
    // Try both parsers and pick the one with more results
    const results1 = parseTransactions(text);
    const results2 = parseTransactionsAlt(text);
    const results = results1.length >= results2.length ? results1 : results2;
    
    return { text, transactions: results };
  }

  return { scan, parseTransactions, parseAmount };
})();
