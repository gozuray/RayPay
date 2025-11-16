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

// Cache local del saldo disponible
let availableBalances = { USDC: 0, SOL: 0 };
let cachedAvailableBalance = { token: "USDC", amount: 0 };
let balanceTokenChoice = "USDC";

// 🌐 URL del backend
const API_URL =
  new URLSearchParams(location.search).get("api") ||
  "https://raypay-backend.onrender.com";

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
      currentReference = null;
    }
  } catch (err) {
    console.warn("Error consultando estado:", err);
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

  const totals = lastHistoryData?.totals || {};

  const completed = getCompletedCashouts().filter(
    (item) => item.merchant === merchantName
  );

  const completedUsdc = completed
    .filter((c) => c.token === "USDC")
    .reduce((sum, c) => sum + Number(c.amount || 0), 0);

  const completedSol = completed
    .filter((c) => c.token === "SOL")
    .reduce((sum, c) => sum + Number(c.amount || 0), 0);

  const remainingUsdc = Math.max(Number(totals.USDC || 0) - completedUsdc, 0);
  const remainingSol = Math.max(Number(totals.SOL || 0) - completedSol, 0);

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

// Inicializar saldo
computeAvailableBalance();
