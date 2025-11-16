// frontend/main.js

// 🚨 Protección del POS (index.html)
const token = localStorage.getItem("raypay_token");
const rawUser = localStorage.getItem("raypay_user");
let currentUser = null;

if (rawUser) {
  try {
    currentUser = JSON.parse(rawUser);
  } catch (error) {
    console.warn("No se pudo leer raypay_user, limpiando sesión", error);
    localStorage.removeItem("raypay_token");
    localStorage.removeItem("raypay_user");
  }
}

if (!token || !currentUser) {
  window.location.href = "login.html";
} else if (currentUser.role === "admin") {
  window.location.href = "admin.html";
}

// === Usuario logueado ===
const merchantWallet = currentUser?.wallet;
const merchantName = currentUser?.name || "Restaurante";
const merchantUsername = currentUser?.username || merchantName;

// === Elementos principales ===
const btn = document.getElementById("btnGenerate");
const amountInput = document.getElementById("amount");
const qrContainer = document.getElementById("qrcode");
const walletAddressEl = document.getElementById("walletAddress");
const tokenSelect = document.getElementById("token");
const toggleAdvanced = document.getElementById("toggleAdvanced");
const advanced = document.getElementById("advanced");
const historyContainer = document.getElementById("historyContainer");
const qrWrapper = document.getElementById("qrWrapper");
const phoneInput = document.getElementById("phoneNumber");
const countryCodeSelect = document.getElementById("countryCode");
const sendReceiptBtn = document.getElementById("sendReceiptBtn");
const receiptStatus = document.getElementById("receiptStatus");

// Botones dentro de la tuerca
const advCopy = document.getElementById("advCopy");
const advHistory = document.getElementById("advHistory");
const advCopyHistory = document.getElementById("advCopyHistory");
const advBalance = document.getElementById("advBalance");
const advBalancePreview = document.getElementById("advBalancePreview");
const advLogout = document.getElementById("advLogout");
const balanceContainer = document.getElementById("balanceContainer");

let checkInterval = null;
let currentReference = null;
let lastHistoryData = null;
let lastConfirmedPayment = null;

// Cache local del saldo disponible
let availableBalances = { USDC: 0, SOL: 0 };
let cachedAvailableBalance = { token: "USDC", amount: 0 };
let balanceTokenChoice = "USDC";

// 🌐 URL del backend
const API_URL =
  new URLSearchParams(location.search).get("api") ||
  "https://raypay-backend.onrender.com";

const COUNTRY_OPTIONS = [
  { code: "PT", name: "Portugal", dial: "+351" },
  { code: "ES", name: "España", dial: "+34" },
  { code: "AR", name: "Argentina", dial: "+54" },
  { code: "BO", name: "Bolivia", dial: "+591" },
  { code: "BR", name: "Brasil", dial: "+55" },
  { code: "CA", name: "Canadá", dial: "+1" },
  { code: "CL", name: "Chile", dial: "+56" },
  { code: "CO", name: "Colombia", dial: "+57" },
  { code: "CR", name: "Costa Rica", dial: "+506" },
  { code: "CU", name: "Cuba", dial: "+53" },
  { code: "DO", name: "República Dominicana", dial: "+1" },
  { code: "EC", name: "Ecuador", dial: "+593" },
  { code: "SV", name: "El Salvador", dial: "+503" },
  { code: "GT", name: "Guatemala", dial: "+502" },
  { code: "HN", name: "Honduras", dial: "+504" },
  { code: "MX", name: "México", dial: "+52" },
  { code: "NI", name: "Nicaragua", dial: "+505" },
  { code: "PA", name: "Panamá", dial: "+507" },
  { code: "PY", name: "Paraguay", dial: "+595" },
  { code: "PE", name: "Perú", dial: "+51" },
  { code: "PR", name: "Puerto Rico", dial: "+1" },
  { code: "UY", name: "Uruguay", dial: "+598" },
  { code: "VE", name: "Venezuela", dial: "+58" },
  { code: "US", name: "Estados Unidos", dial: "+1" },
  { code: "GB", name: "Reino Unido", dial: "+44" },
  { code: "DE", name: "Alemania", dial: "+49" },
  { code: "FR", name: "Francia", dial: "+33" },
  { code: "IT", name: "Italia", dial: "+39" },
  { code: "NL", name: "Países Bajos", dial: "+31" },
  { code: "BE", name: "Bélgica", dial: "+32" },
  { code: "CH", name: "Suiza", dial: "+41" },
  { code: "SE", name: "Suecia", dial: "+46" },
  { code: "NO", name: "Noruega", dial: "+47" },
  { code: "DK", name: "Dinamarca", dial: "+45" },
  { code: "FI", name: "Finlandia", dial: "+358" },
  { code: "IE", name: "Irlanda", dial: "+353" },
  { code: "IS", name: "Islandia", dial: "+354" },
  { code: "GR", name: "Grecia", dial: "+30" },
  { code: "TR", name: "Turquía", dial: "+90" },
  { code: "RU", name: "Rusia", dial: "+7" },
  { code: "CN", name: "China", dial: "+86" },
  { code: "JP", name: "Japón", dial: "+81" },
  { code: "KR", name: "Corea del Sur", dial: "+82" },
  { code: "IN", name: "India", dial: "+91" },
  { code: "SA", name: "Arabia Saudita", dial: "+966" },
  { code: "AE", name: "Emiratos Árabes Unidos", dial: "+971" },
  { code: "EG", name: "Egipto", dial: "+20" },
  { code: "MA", name: "Marruecos", dial: "+212" },
  { code: "ZA", name: "Sudáfrica", dial: "+27" },
  { code: "NG", name: "Nigeria", dial: "+234" },
  { code: "KE", name: "Kenia", dial: "+254" },
  { code: "AU", name: "Australia", dial: "+61" },
  { code: "NZ", name: "Nueva Zelanda", dial: "+64" },
  { code: "PH", name: "Filipinas", dial: "+63" },
  { code: "TH", name: "Tailandia", dial: "+66" },
  { code: "ID", name: "Indonesia", dial: "+62" },
  { code: "SG", name: "Singapur", dial: "+65" },
  { code: "MY", name: "Malasia", dial: "+60" },
  { code: "VN", name: "Vietnam", dial: "+84" },
  { code: "HK", name: "Hong Kong", dial: "+852" },
  { code: "TW", name: "Taiwán", dial: "+886" },
  { code: "IL", name: "Israel", dial: "+972" },
  { code: "PK", name: "Pakistán", dial: "+92" },
  { code: "BD", name: "Bangladesh", dial: "+880" },
  { code: "LK", name: "Sri Lanka", dial: "+94" },
  { code: "NP", name: "Nepal", dial: "+977" },
  { code: "IR", name: "Irán", dial: "+98" },
  { code: "IQ", name: "Irak", dial: "+964" },
  { code: "QA", name: "Qatar", dial: "+974" },
  { code: "KW", name: "Kuwait", dial: "+965" },
  { code: "OM", name: "Omán", dial: "+968" },
  { code: "JO", name: "Jordania", dial: "+962" },
  { code: "LB", name: "Líbano", dial: "+961" },
  { code: "KR", name: "Corea", dial: "+82" },
  { code: "UA", name: "Ucrania", dial: "+380" },
  { code: "PL", name: "Polonia", dial: "+48" },
  { code: "CZ", name: "Chequia", dial: "+420" },
  { code: "HU", name: "Hungría", dial: "+36" },
  { code: "RO", name: "Rumanía", dial: "+40" },
  { code: "BG", name: "Bulgaria", dial: "+359" },
  { code: "HR", name: "Croacia", dial: "+385" },
  { code: "RS", name: "Serbia", dial: "+381" },
  { code: "SK", name: "Eslovaquia", dial: "+421" },
  { code: "SI", name: "Eslovenia", dial: "+386" },
  { code: "BA", name: "Bosnia y Herzegovina", dial: "+387" },
  { code: "AL", name: "Albania", dial: "+355" },
  { code: "MK", name: "Macedonia del Norte", dial: "+389" },
  { code: "LV", name: "Letonia", dial: "+371" },
  { code: "LT", name: "Lituania", dial: "+370" },
  { code: "EE", name: "Estonia", dial: "+372" },
  { code: "MD", name: "Moldavia", dial: "+373" },
  { code: "BY", name: "Bielorrusia", dial: "+375" },
  { code: "GE", name: "Georgia", dial: "+995" },
  { code: "AM", name: "Armenia", dial: "+374" },
  { code: "AZ", name: "Azerbaiyán", dial: "+994" },
  { code: "KZ", name: "Kazajistán", dial: "+7" },
  { code: "KG", name: "Kirguistán", dial: "+996" },
  { code: "UZ", name: "Uzbekistán", dial: "+998" },
  { code: "TM", name: "Turkmenistán", dial: "+993" },
  { code: "AF", name: "Afganistán", dial: "+93" },
  { code: "MN", name: "Mongolia", dial: "+976" },
  { code: "MM", name: "Myanmar", dial: "+95" },
  { code: "KH", name: "Camboya", dial: "+855" },
  { code: "LA", name: "Laos", dial: "+856" },
  { code: "CM", name: "Camerún", dial: "+237" },
  { code: "GH", name: "Ghana", dial: "+233" },
  { code: "SN", name: "Senegal", dial: "+221" },
  { code: "UG", name: "Uganda", dial: "+256" },
  { code: "TZ", name: "Tanzania", dial: "+255" },
  { code: "ET", name: "Etiopía", dial: "+251" },
  { code: "DZ", name: "Argelia", dial: "+213" },
  { code: "TN", name: "Túnez", dial: "+216" },
  { code: "SD", name: "Sudán", dial: "+249" },
  { code: "AO", name: "Angola", dial: "+244" },
  { code: "MZ", name: "Mozambique", dial: "+258" },
  { code: "ZW", name: "Zimbabue", dial: "+263" },
  { code: "NA", name: "Namibia", dial: "+264" },
  { code: "BW", name: "Botsuana", dial: "+267" },
  { code: "ZM", name: "Zambia", dial: "+260" },
  { code: "MW", name: "Malaui", dial: "+265" },
  { code: "RW", name: "Ruanda", dial: "+250" },
  { code: "CD", name: "Congo (RDC)", dial: "+243" },
  { code: "CG", name: "Congo", dial: "+242" },
  { code: "CI", name: "Costa de Marfil", dial: "+225" },
  { code: "ML", name: "Malí", dial: "+223" },
  { code: "GN", name: "Guinea", dial: "+224" },
  { code: "GM", name: "Gambia", dial: "+220" },
  { code: "BF", name: "Burkina Faso", dial: "+226" },
  { code: "BJ", name: "Benín", dial: "+229" },
  { code: "TG", name: "Togo", dial: "+228" },
  { code: "LR", name: "Liberia", dial: "+231" },
  { code: "SL", name: "Sierra Leona", dial: "+232" },
  { code: "NE", name: "Níger", dial: "+227" },
  { code: "SO", name: "Somalia", dial: "+252" },
  { code: "YE", name: "Yemen", dial: "+967" },
  { code: "SY", name: "Siria", dial: "+963" },
  { code: "PS", name: "Palestina", dial: "+970" },
  { code: "CY", name: "Chipre", dial: "+357" },
  { code: "LU", name: "Luxemburgo", dial: "+352" },
  { code: "AT", name: "Austria", dial: "+43" },
  { code: "MT", name: "Malta", dial: "+356" },
  { code: "LI", name: "Liechtenstein", dial: "+423" },
  { code: "MC", name: "Mónaco", dial: "+377" },
  { code: "AD", name: "Andorra", dial: "+376" },
  { code: "SM", name: "San Marino", dial: "+378" },
  { code: "VA", name: "Vaticano", dial: "+379" },
  { code: "BB", name: "Barbados", dial: "+1" },
  { code: "BS", name: "Bahamas", dial: "+1" },
  { code: "JM", name: "Jamaica", dial: "+1" },
  { code: "TT", name: "Trinidad y Tobago", dial: "+1" },
  { code: "GD", name: "Granada", dial: "+1" },
  { code: "AG", name: "Antigua y Barbuda", dial: "+1" },
  { code: "BB", name: "Barbados", dial: "+1" },
  { code: "DM", name: "Dominica", dial: "+1" },
  { code: "LC", name: "Santa Lucía", dial: "+1" },
  { code: "VC", name: "San Vicente y las Granadinas", dial: "+1" },
  { code: "KN", name: "San Cristóbal y Nieves", dial: "+1" },
  { code: "HT", name: "Haití", dial: "+509" },
  { code: "GL", name: "Groenlandia", dial: "+299" },
  { code: "PF", name: "Polinesia Francesa", dial: "+689" },
  { code: "NC", name: "Nueva Caledonia", dial: "+687" },
  { code: "FJ", name: "Fiyi", dial: "+679" },
  { code: "WS", name: "Samoa", dial: "+685" },
  { code: "TO", name: "Tonga", dial: "+676" },
  { code: "GU", name: "Guam", dial: "+1" },
  { code: "AS", name: "Samoa Americana", dial: "+1" },
  { code: "PR", name: "Puerto Rico", dial: "+1" },
  { code: "KY", name: "Islas Caimán", dial: "+1" },
  { code: "BM", name: "Bermudas", dial: "+1" },
  { code: "IM", name: "Isla de Man", dial: "+44" },
  { code: "GG", name: "Guernsey", dial: "+44" },
  { code: "JE", name: "Jersey", dial: "+44" },
];

// 🎵 Sonido para pago confirmado
const ding = new Audio("assets/sounds/cash-sound.mp3");

// === Mostrar / ocultar configuración avanzada ===
toggleAdvanced.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();

  const isVisible = advanced.classList.contains("visible");
  if (isVisible) {
    advanced.classList.remove("visible");
    toggleAdvanced.classList.remove("rotating");
  } else {
    advanced.classList.add("visible");
    toggleAdvanced.classList.add("rotating");
  }
  advanced.setAttribute(
    "aria-hidden",
    String(!advanced.classList.contains("visible"))
  );
});

toggleAdvanced.addEventListener("mousedown", (e) => e.preventDefault());

// === Función auxiliar: recorta decimales ===
function clampDecimals(valueStr, decimals) {
  let v = (valueStr || "").replace(",", ".").replace(/[^\d.]/g, "");
  const parts = v.split(".");
  if (parts.length > 2) v = parts[0] + "." + parts.slice(1).join("");
  if (parts[1] && parts[1].length > decimals) {
    parts[1] = parts[1].slice(0, decimals);
    v = parts.join(".");
  }
  return v;
}

function getDialFromSelect() {
  const currentCode = countryCodeSelect?.value || "PT";
  return (
    COUNTRY_OPTIONS.find((item) => item.code === currentCode)?.dial ||
    "+351"
  );
}

function ensurePhonePrefix(dialCode) {
  if (!phoneInput) return;
  const digits = phoneInput.value.replace(/\D/g, "");
  const normalizedDial = dialCode.replace(/\D/g, "");

  if (!digits || digits.startsWith(normalizedDial)) {
    phoneInput.value = `${dialCode} `;
    return;
  }

  if (!phoneInput.value.startsWith(dialCode)) {
    phoneInput.value = `${dialCode} ${digits}`;
  }
}

function populateCountrySelect() {
  if (!countryCodeSelect) return;

  countryCodeSelect.innerHTML = COUNTRY_OPTIONS.map(
    ({ code, name, dial }) =>
      `<option value="${code}" data-dial="${dial}">${name} (${dial})</option>`
  ).join("");

  countryCodeSelect.value = "PT";
  ensurePhonePrefix(getDialFromSelect());
}

function buildFullPhoneNumber() {
  const dial = getDialFromSelect();
  const dialDigits = dial.replace(/\D/g, "");
  const rawDigits = (phoneInput?.value || "").replace(/\D/g, "");
  const stripped = rawDigits.startsWith(dialDigits)
    ? rawDigits.slice(dialDigits.length)
    : rawDigits;

  return {
    dial,
    digits: stripped,
    full: stripped ? `${dial}${stripped}` : null,
  };
}

function resetReceiptFlow() {
  lastConfirmedPayment = null;
  if (receiptStatus) {
    receiptStatus.textContent =
      "El recibo se enviará manualmente cuando se confirme el pago.";
  }
  if (sendReceiptBtn) sendReceiptBtn.disabled = true;
  ensurePhonePrefix(getDialFromSelect());
}

// === Limitar input en tiempo real ===
amountInput.addEventListener("input", (e) => {
  const token = tokenSelect ? tokenSelect.value : "USDC";
  const maxDecimals = token === "SOL" ? 5 : 3;

  let value = clampDecimals(e.target.value, maxDecimals);
  const numeric = parseFloat(value);

  if (!isNaN(numeric) && numeric > 1000) value = "1000";
  e.target.value = value;
});

// === Cambiar decimales visibles al cambiar token ===
if (tokenSelect) {
  tokenSelect.addEventListener("change", () => {
    const token = tokenSelect.value;
    const maxDecimals = token === "SOL" ? 5 : 3;
    amountInput.value = clampDecimals(amountInput.value, maxDecimals);
  });
}

// === Mostrar estado de pago ===
function showPaymentStatus(msg) {
  let statusEl = document.getElementById("status");
  if (!statusEl) {
    statusEl = document.createElement("p");
    statusEl.id = "status";
    statusEl.className = "status-text";
    document.getElementById("statusContainer").appendChild(statusEl);
  }
  statusEl.textContent = msg;
}

// === Fetch helpers ===
async function safeJsonFetch(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Error HTTP ${res.status}`);
  }
  return data;
}

async function tryJson(url, options) {
  try {
    const data = await safeJsonFetch(url, options);
    return { ok: true, data };
  } catch (err) {
    console.warn(`Falló ${url}:`, err.message);
    return { ok: false, error: err.message };
  }
}

function updateReceiptStatus(message, disabled = false) {
  if (receiptStatus) receiptStatus.textContent = message;
  if (sendReceiptBtn) sendReceiptBtn.disabled = disabled;
}

// === Consultar estado del pago ===
async function checkPaymentStatus(reference) {
  if (!reference) return;
  try {
    const data = await safeJsonFetch(`${API_URL}/confirm/${reference}`);
    if (data.status === "pagado") {
      const signature = String(data.signature || "");
      const shortSignature = signature ? `${signature.slice(0, 8)}...` : "N/A";
      showPaymentStatus(`✅ Pago confirmado — Hash ${shortSignature}`);
      qrContainer.classList.add("confirmed");
      ding.play();
      clearInterval(checkInterval);
      checkInterval = null;
      lastConfirmedPayment = { reference, signature };
      updateReceiptStatus(
        "Pago confirmado. Envía el recibo con la flecha verde.",
        false
      );
      currentReference = null;

      await loadTransactions(currentFilter, { render: false });
      computeAvailableBalance();
      if (balanceContainer?.innerHTML) {
        renderBalancePanel();
      }
    }
  } catch (err) {
    console.warn("Error consultando estado:", err);
  }
}

async function sendReceiptManually() {
  if (!lastConfirmedPayment?.reference) {
    updateReceiptStatus("Primero confirma un pago para enviar el recibo.", true);
    return;
  }

  const { full, digits } = buildFullPhoneNumber();

  if (!digits || !full) {
    updateReceiptStatus("Ingresa un número válido para WhatsApp.", true);
    return;
  }

  updateReceiptStatus("Enviando recibo por WhatsApp...", true);

  try {
    await safeJsonFetch(`${API_URL}/receipt/${lastConfirmedPayment.reference}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneNumber: full }),
    });

    updateReceiptStatus("Recibo enviado por WhatsApp ✅", false);
  } catch (err) {
    updateReceiptStatus(`Error: ${err.message}`, false);
  }
}

// === Generar QR ===
btn.addEventListener("click", async () => {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  currentReference = null;

  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.remove();

  qrContainer.innerHTML = "";
  walletAddressEl.textContent = "";
  walletAddressEl.dataset.fullAddress = "";
  qrWrapper.classList.remove("visible");
  document.getElementById("walletInfo").style.display = "none";
  resetReceiptFlow();

  const token = tokenSelect ? tokenSelect.value : "USDC";
  const decimals = token === "SOL" ? 5 : 3;

  let raw = amountInput.value.trim();
  raw = clampDecimals(raw, decimals);
  const amount = parseFloat(raw);

  if (isNaN(amount) || amount <= 0) {
    alert("⚠️ Ingresa un monto válido");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Generando QR...";

  try {
    const fixedAmount = amount.toFixed(decimals);

    const body = {
      amount: fixedAmount,
      token,
      restaurant: merchantName,
      merchantWallet: merchantWallet || null,
    };

    const phone = buildFullPhoneNumber();
    if (phone.full) body.phoneNumber = phone.full;

    const data = await safeJsonFetch(`${API_URL}/create-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!data.solana_url) {
      alert("Error: el backend no devolvió el link de pago.");
      return;
    }

    const qrSize = 320;
    new QRCode(qrContainer, {
      text: data.solana_url,
      width: qrSize,
      height: qrSize,
      colorDark: "#c084fc",
      colorLight: "#0a0018",
      correctLevel: QRCode.CorrectLevel.M,
    });

    qrContainer.classList.remove("confirmed");
    qrContainer.classList.add("qr-glow");
    qrWrapper.classList.add("visible");

    // Animación del canvas
    const qrCanvas = qrContainer.querySelector("canvas");
    if (qrCanvas) {
      const ctx = qrCanvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      qrCanvas.style.opacity = "0";
      qrCanvas.style.transform = "scale(0.8)";
      setTimeout(() => {
        qrCanvas.style.transition = "all 0.45s ease";
        qrCanvas.style.opacity = "1";
        qrCanvas.style.transform = "scale(1)";
      }, 50);
    }

    const match = data.solana_url.match(/^solana:([^?]+)/);
    const walletAddress = match ? match[1] : "desconocida";

    const shortAddr =
      walletAddress.length > 10
        ? `${walletAddress.slice(0, 4)}.${walletAddress.slice(-4)}`
        : walletAddress;

    walletAddressEl.textContent = `Recibir en: ${shortAddr}`;
    walletAddressEl.dataset.fullAddress = walletAddress;

    document.getElementById("walletInfo").style.display = "block";

    showPaymentStatus("⏳ Esperando pago en la red Solana...");

    currentReference = data.reference;
    checkInterval = setInterval(() => checkPaymentStatus(currentReference), 8000);
  } catch (err) {
    console.error("Error generando QR:", err);
    alert(`❌ No se pudo conectar al backend.\n\n${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Generar QR";
  }
});

// === HISTORIAL ===

let currentFilter = "all"; // "all", "SOL", "USDC"

function renderHistoryLayout(innerHtml) {
  historyContainer.innerHTML = `
    <div class="history-card">
      <div class="history-header">
        <p class="history-title">Historial de cobros</p>
        <button class="history-close" onclick="hideHistory()" aria-label="Cerrar historial">✕</button>
      </div>
      ${innerHtml}
    </div>
  `;
}

function renderHistoryTable(data) {
  lastHistoryData = data;

  const transactions = data?.data || [];
  const totals = data?.totals || { SOL: 0, USDC: 0 };
  const totalCount = data?.total ?? transactions.length;

  const normalizedTotals = {
    USDC: Number(totals.USDC || 0),
    SOL: Number(totals.SOL || 0),
  };

  const filters = [
    { id: "all", label: `📊 Todos (${totalCount})` },
    { id: "USDC", label: `💵 USDC (${normalizedTotals.USDC.toFixed(2)})` },
    { id: "SOL", label: `⚡ SOL (${normalizedTotals.SOL.toFixed(5)})` },
  ];

  const filterButtons = filters
    .map(
      (filter) => `
        <button class="filter-button ${
          currentFilter === filter.id ? "is-active" : ""
        }" onclick="filterTransactions('${filter.id}')">
          ${filter.label}
        </button>
      `
    )
    .join("");

  let tableSection = "";

  if (!transactions.length) {
    tableSection = `
      <div class="info-block">
        <p class="status-text">
          ⚠️ No hay transacciones ${
            currentFilter !== "all" ? "de " + currentFilter : ""
          }
        </p>
      </div>
    `;
  } else {
    const rows = transactions
      .map((tx) => {
        const shortPayer =
          tx.payer && tx.payer.length > 10
            ? `${tx.payer.slice(0, 4)}...${tx.payer.slice(-4)}`
            : tx.payer || "N/A";

        const pillClass = tx.status === "success" ? "success" : "pending";
        const pillLabel = tx.status === "success" ? "Completo" : tx.status;

        return `
          <tr>
            <td>
              ${tx.date}
              <span class="table-meta">${tx.time}</span>
            </td>
            <td>${tx.token}</td>
            <td>${tx.amount}</td>
            <td>${shortPayer}</td>
            <td>
              <span class="status-pill ${pillClass}">
                ${pillLabel}
              </span>
            </td>
          </tr>
        `;
      })
      .join("");

    tableSection = `
      <div class="table-wrapper">
        <table class="transactions-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Token</th>
              <th>Monto</th>
              <th>Pagador</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  renderHistoryLayout(`
    <div class="filters">${filterButtons}</div>
    ${tableSection}
  `);
}

window.filterTransactions = async (filter) => {
  currentFilter = filter;
  await loadTransactions(filter);
};

async function loadTransactions(filter = "all", options = { render: true }) {
  const shouldRender = options.render !== false;

  if (shouldRender) {
    renderHistoryLayout(
      '<div class="info-block"><p class="status-text">🔄 Cargando historial...</p></div>'
    );
  }

  const tokenParam = filter !== "all" ? `&token=${filter}` : "";
  const walletParam = merchantWallet
    ? `&wallet=${encodeURIComponent(merchantWallet)}`
    : "";
  const url = `${API_URL}/transactions?limit=50${tokenParam}${walletParam}`;

  const result = await tryJson(url);

  if (result.ok && result.data) {
    lastHistoryData = result.data;
    computeAvailableBalance();
    if (shouldRender) {
      renderHistoryTable(result.data);
    }
  } else {
    lastHistoryData = null;
    if (shouldRender) {
      renderHistoryLayout(`
        <div class="info-block">
          <p class="status-text">❌ Error cargando transacciones</p>
          <p class="status-text">${result.error || "Error desconocido"}</p>
        </div>
      `);
    }
    if (advBalancePreview) advBalancePreview.textContent = "--";
  }
}

window.hideHistory = () => {
  historyContainer.innerHTML = "";
};

// === Crear texto para copiar historial ===
function formatHistoryForClipboard(historyData) {
  const transactions = historyData?.data || [];
  const totals = historyData?.totals || {};

  const normalizedTotals = {
    USDC: Number(totals.USDC || 0),
    SOL: Number(totals.SOL || 0),
  };

  const summaryParts = [];
  if (normalizedTotals.USDC)
    summaryParts.push(`USDC ${normalizedTotals.USDC.toFixed(2)}`);
  if (normalizedTotals.SOL)
    summaryParts.push(`SOL ${normalizedTotals.SOL.toFixed(5)}`);

  const lines = transactions.map((tx, index) => {
    const statusLabel = tx.status === "success" ? "OK" : tx.status || "pendiente";
    let payer = tx.payer || "";
    if (payer.length > 10) {
      payer = `${payer.slice(0, 4)}...${payer.slice(-4)}`;
    }
    const payerSuffix = payer ? ` · ${payer}` : "";
    return `${index + 1}. ${tx.date} ${tx.time} | ${tx.token} ${
      tx.amount
    } | ${statusLabel}${payerSuffix}`;
  });

  const summaryLine = summaryParts.length
    ? `Totales: ${summaryParts.join(" | ")}`
    : null;
  const header = `Historial RayPay — ${merchantName}`;

  return [header, summaryLine, ...lines].filter(Boolean).join("\n");
}

// === Saldo y retiros ===

function getStoredJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function getCompletedCashouts() {
  return getStoredJson("raypay_cashout_completed", []);
}

function setCashoutRequests(list) {
  localStorage.setItem("raypay_cashout_requests", JSON.stringify(list));
}

function getCashoutRequests() {
  return getStoredJson("raypay_cashout_requests", []);
}

function computeAvailableBalance() {
  if (!lastHistoryData) {
    // reset total saldo si no hay historial
    availableBalances = { USDC: 0, SOL: 0 };
    cachedAvailableBalance = { token: "USDC", amount: 0 };
    if (advBalancePreview) advBalancePreview.textContent = "--";
    return;
  }

  const totals = lastHistoryData?.availableTotals || lastHistoryData?.totals || {};

  balanceTokenChoice = "USDC";

  const remainingUsdc = Math.max(Number(totals.USDC || 0), 0);
  const remainingSol = Math.max(Number(totals.SOL || 0), 0);

  availableBalances = {
    USDC: remainingUsdc,
    SOL: remainingSol,
  };

  cachedAvailableBalance = {
    token: balanceTokenChoice,
    amount: balanceTokenChoice === "SOL" ? remainingSol : remainingUsdc,
  };

  if (cachedAvailableBalance.amount <= 0 && balanceTokenChoice !== "USDC") {
    cachedAvailableBalance = { token: "USDC", amount: remainingUsdc };
    balanceTokenChoice = "USDC";
  }

  if (advBalancePreview) {
    const symbol = cachedAvailableBalance.token === "SOL" ? "◎" : "＄";
    const decimals = cachedAvailableBalance.token === "SOL" ? 4 : 2;
    advBalancePreview.textContent = `${symbol}${cachedAvailableBalance.amount.toFixed(
      decimals
    )}`;
  }
}

function updateBalanceTokenChoice(token) {
  balanceTokenChoice = token;
  cachedAvailableBalance = {
    token,
    amount: availableBalances[token] || 0,
  };

  if (advBalancePreview) {
    const symbol = token === "SOL" ? "◎" : "＄";
    const decimals = token === "SOL" ? 4 : 2;
    advBalancePreview.textContent = `${symbol}${cachedAvailableBalance.amount.toFixed(
      decimals
    )}`;
  }
}

function markAdminAlert() {
  localStorage.setItem("raypay_cashout_alert", "pending");
}

function sendCashoutRequest(methodLabel) {
  const requests = getCashoutRequests();
  const now = new Date();

  const entry = {
    merchant: merchantName,
    username: merchantUsername,
    wallet: merchantWallet,
    token: cachedAvailableBalance.token,
    amount: Number(cachedAvailableBalance.amount || 0),
    method: methodLabel,
    status: "pendiente",
    requestedAt: now.toISOString(),
  };

  requests.push(entry);
  setCashoutRequests(requests);

  markAdminAlert();

  advBalance.textContent = `Retiro en curso (${methodLabel})`;

  setTimeout(() => {
    advBalance.textContent = "Saldo disponible";
  }, 1800);

  if (balanceContainer) {
    balanceContainer.innerHTML = `
      <div class="history-card balance-card">
        <div class="history-header balance-header">
          <p class="history-title">Solicitud enviada</p>
          <button class="history-close" onclick="hideBalancePanel()" aria-label="Cerrar saldo">✕</button>
        </div>
        <div class="info-block">
          <p class="status-text">Tu solicitud de retiro (${methodLabel}) fue enviada al administrador.</p>
        </div>
      </div>
    `;
  }
}

// === Panel de retiro ===

function hideBalancePanel() {
  if (balanceContainer) balanceContainer.innerHTML = "";
}

function renderBalancePanel() {
  if (!balanceContainer) return;

  const symbol = cachedAvailableBalance.token === "SOL" ? "◎" : "＄";
  const decimals = cachedAvailableBalance.token === "SOL" ? 4 : 2;

  balanceContainer.innerHTML = `
    <div class="history-card balance-card">
      <div class="history-header balance-header">
        <p class="history-title">Saldo disponible</p>
        <div class="balance-controls">
          <div class="token-toggle" role="group" aria-label="Moneda de retiro">
            <button class="token-pill ${
              balanceTokenChoice === "USDC" ? "active" : ""
            }" data-token="USDC">USDC</button>
            <button class="token-pill ${
              balanceTokenChoice === "SOL" ? "active" : ""
            }" data-token="SOL">SOL</button>
          </div>
          <button class="history-close" onclick="hideBalancePanel()" aria-label="Cerrar saldo">✕</button>
        </div>
      </div>
      <div class="balance-summary">
        <p class="balance-amount">${symbol}${cachedAvailableBalance.amount.toFixed(
    decimals
  )}</p>
        <p class="balance-token">Disponible en ${
          cachedAvailableBalance.token
        }</p>
      </div>
      <div class="balance-actions">
        <button class="balance-action" data-method="Banco">🏦 Retiro a cuenta bancaria</button>
        <button class="balance-action" data-method="Efectivo">💵 Retiro en efectivo</button>
      </div>
      <p class="balance-hint">Elige una opción para enviar la solicitud de retiro al administrador.</p>
    </div>
  `;
}

advBalance.addEventListener("click", async (e) => {
  e.preventDefault();
  advanced.classList.remove("visible");
  toggleAdvanced.classList.remove("rotating");

  await loadTransactions(currentFilter, { render: false });
  computeAvailableBalance();
  if (!lastHistoryData) {
    if (balanceContainer) {
      balanceContainer.innerHTML = `
        <div class="history-card balance-card">
          <div class="history-header balance-header">
            <p class="history-title">Saldo disponible</p>
            <button class="history-close" onclick="hideBalancePanel()" aria-label="Cerrar saldo">✕</button>
          </div>
          <div class="info-block">
            <p class="status-text">No pudimos cargar el saldo. Intenta nuevamente.</p>
          </div>
        </div>
      `;
    }
    return;
  }
  hideHistory();
  renderBalancePanel();
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
});

if (balanceContainer) {
  balanceContainer.addEventListener("click", (event) => {
    // Cambiar token (USDC / SOL)
    const tokenBtn = event.target.closest(".token-pill");
    if (tokenBtn) {
      updateBalanceTokenChoice(tokenBtn.dataset.token);
      renderBalancePanel();
      return;
    }

    // Enviar solicitud de retiro
    const btn = event.target.closest(".balance-action");
    if (!btn) return;

    const method = btn.dataset.method;
    sendCashoutRequest(method);
    hideBalancePanel();
  });
}

// === Acciones bajo la tuerca ===

// Copiar historial
advCopyHistory.addEventListener("click", async () => {
  if (!lastHistoryData) {
    await loadTransactions(currentFilter);
  }

  const hasEntries = lastHistoryData?.data?.length;
  if (!hasEntries) {
    advCopyHistory.textContent = "Sin datos para copiar";
    setTimeout(() => {
      advCopyHistory.textContent = "Copiar historial";
    }, 1500);
    return;
  }

  try {
    const formatted = formatHistoryForClipboard(lastHistoryData);
    await navigator.clipboard.writeText(formatted);
    advCopyHistory.textContent = "Historial copiado ✅";
    setTimeout(() => {
      advCopyHistory.textContent = "Copiar historial";
    }, 1500);
  } catch (error) {
    alert("No se pudo copiar el historial.");
  }
});

// Copiar dirección
advCopy.addEventListener("click", () => {
  const fullAddr = walletAddressEl.dataset.fullAddress;
  if (!fullAddr) {
    alert("Primero genera un QR para tener una dirección.");
    return;
  }
  navigator.clipboard.writeText(fullAddr).then(() => {
    advCopy.textContent = "Dirección copiada ✅";
    setTimeout(() => {
      advCopy.textContent = "Copiar dirección";
    }, 1500);
  });
});

// Mostrar historial
advHistory.addEventListener("click", () => {
  advanced.classList.remove("visible");
  toggleAdvanced.classList.remove("rotating");
  hideBalancePanel();
  loadTransactions("all");
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
});

// Logout
advLogout.addEventListener("click", () => {
  localStorage.removeItem("raypay_token");
  localStorage.removeItem("raypay_user");
  window.location.href = "login.html";
});

populateCountrySelect();
if (countryCodeSelect) {
  countryCodeSelect.addEventListener("change", () => {
    ensurePhonePrefix(getDialFromSelect());
  });
}

if (sendReceiptBtn) {
  sendReceiptBtn.addEventListener("click", sendReceiptManually);
  sendReceiptBtn.disabled = true;
}

resetReceiptFlow();

// Inicializar saldo
computeAvailableBalance();
