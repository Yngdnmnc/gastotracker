// Google Apps Script — Copia este código en script.google.com
// Desplegalo como "Web App" (cualquiera puede acceder).
// Vincula una Google Sheet antes de desplegar.

// ─── Configuración ───────────────────────────────────────
var SHEET_NAME = "Gastos"; // nombre de la hoja dentro del spreadsheet

// ─── Alertas de límite mensual ───────────────────────────
// Cambiá estos valores a tu gusto. Se envía UN email por mes
// cuando el total acumulado supera el umbral configurado.
var ALERTAS = {
  emails: ["ragustinmontesdeoc@gmail.com", "dannaalle11@gmail.com"],
  limites: {
    "UY$": 8000,     // límite mensual en pesos uruguayos
    "USD": 70         // límite mensual en dólares
  },
  // Porcentaje del límite para la alerta (0.8 = 80%)
  umbral: 0.8
};

function getOrCreateSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    // Encabezados
    sheet.appendRow([
      "ID",
      "Fecha",
      "Monto",
      "Moneda",
      "Comercio",
      "Persona",
      "Origen",
      "Notas",
      "Sincronizado"
    ]);
    sheet.getRange(1, 1, 1, 9).setFontWeight("bold");
  }
  return sheet;
}

// ─── POST: recibir gastos desde la app ───────────────────
function doPost(e) {
  try {
    var sheet = getOrCreateSheet();
    var data = JSON.parse(e.postData.contents);

    // Soporte para envío individual o batch
    var rows = data.batch ? data.batch : [data];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];

      // Evitar duplicados por ID
      if (row.id && isDuplicate(sheet, row.id)) {
        continue;
      }

      var fecha = row.date ? new Date(row.date) : new Date();

      sheet.appendRow([
        row.id || "",
        Utilities.formatDate(fecha, Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm"),
        parseFloat(row.amount) || 0,
        row.currency || "UY$",
        row.merchant || "",
        row.source || "",
        row.origin || "",
        row.notes || "",
        new Date() // timestamp de sincronización
      ]);
    }

    // Verificar límites y enviar alerta si corresponde
    checkMonthlyLimits(sheet);

    return ContentService.createTextOutput(
      JSON.stringify({ status: "ok", rows: rows.length })
    ).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ status: "error", message: err.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// ─── GET: leer gastos (opcional, para sync futuro) ───────
function doGet(e) {
  try {
    var sheet = getOrCreateSheet();
    var data = sheet.getDataRange().getValues();
    var headers = data[0];
    var result = [];

    for (var i = 1; i < data.length; i++) {
      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        obj[headers[j]] = data[i][j];
      }
      result.push(obj);
    }

    return ContentService.createTextOutput(
      JSON.stringify({ status: "ok", data: result })
    ).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ status: "error", message: err.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// ─── Helpers ─────────────────────────────────────────────
function isDuplicate(sheet, id) {
  if (!id) return false;
  var ids = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return true;
  }
  return false;
}

// ─── Alerta de límite mensual ────────────────────────────
// Usa PropertiesService para recordar si ya se envió la alerta
// este mes para cada moneda, así no spamea.

function checkMonthlyLimits(sheet) {
  if (!ALERTAS.emails || ALERTAS.emails.length === 0) return;

  var now = new Date();
  var mesActual = (now.getMonth() + 1);
  var anioActual = now.getFullYear();
  var mesKey = anioActual + "-" + mesActual;

  // Calcular totales del mes actual
  var data = sheet.getDataRange().getValues();
  var totales = {};

  for (var i = 1; i < data.length; i++) {
    var fechaStr = data[i][1]; // columna Fecha (dd/MM/yyyy HH:mm)
    var monto = parseFloat(data[i][2]) || 0;
    var moneda = data[i][3] || "UY$";

    // Parsear fecha
    var fecha = parseFechaSheet(fechaStr);
    if (!fecha) continue;

    if (fecha.getMonth() + 1 === mesActual && fecha.getFullYear() === anioActual) {
      totales[moneda] = (totales[moneda] || 0) + monto;
    }
  }

  // Revisar cada moneda contra su límite
  var props = PropertiesService.getScriptProperties();

  for (var moneda in ALERTAS.limites) {
    var limite = ALERTAS.limites[moneda];
    var total = totales[moneda] || 0;
    var umbralMonto = limite * ALERTAS.umbral;
    var alertKey = "alerta_" + moneda + "_" + mesKey;

    // ¿Ya se mandó esta alerta este mes?
    if (props.getProperty(alertKey)) continue;

    if (total >= umbralMonto) {
      var pct = Math.round((total / limite) * 100);
      var asunto = "⚠️ GastoTracker: " + pct + "% del límite en " + moneda;
      var cuerpo =
        "Hola,\n\n" +
        "Ya gastaste " + moneda + " " + formatNum(total) +
        " de tu límite mensual de " + moneda + " " + formatNum(limite) +
        " (" + pct + "%).\n\n";

      if (total >= limite) {
        asunto = "🚨 GastoTracker: ¡Superaste el límite en " + moneda + "!";
        cuerpo += "⚠️ YA SUPERASTE EL LÍMITE DEL MES.\n\n";
      } else {
        cuerpo += "Estás llegando al límite del mes.\n\n";
      }

      cuerpo += "Mes: " + mesKey + "\n" +
        "Total acumulado: " + moneda + " " + formatNum(total) + "\n" +
        "Límite configurado: " + moneda + " " + formatNum(limite) + "\n\n" +
        "— GastoTracker";

      MailApp.sendEmail(ALERTAS.emails.join(","), asunto, cuerpo);
      props.setProperty(alertKey, "sent");
    }
  }
}

function parseFechaSheet(val) {
  if (val instanceof Date) return val;
  if (typeof val !== "string") return null;
  // Formato: dd/MM/yyyy HH:mm
  var parts = val.split(" ");
  var dmy = parts[0].split("/");
  if (dmy.length < 3) return null;
  return new Date(parseInt(dmy[2]), parseInt(dmy[1]) - 1, parseInt(dmy[0]));
}

function formatNum(n) {
  return n.toLocaleString("es-UY", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ─── Setup inicial (ejecutar una vez manualmente) ────────
function setup() {
  getOrCreateSheet();
  Logger.log("Hoja '" + SHEET_NAME + "' lista.");
}
