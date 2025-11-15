// frontend/main.js

// 🚨 Protección del POS (index.html)
(function () {
  const token = localStorage.getItem("raypay_token");
  const userStr = localStorage.getItem("raypay_user");

  if (!token || !userStr) {
    window.location.href = "login.html";
    return;
  }
})();

// === Usuario logueado ===
const currentUser = JSON.parse(localStorage.getItem("raypay_user"));
const merchantWallet = currentUser.wallet;
const merchantName = currentUser.name || "Restaurante";

// === Elementos principales ===
const btn = document.getElementById("btnGenerate");
const amountInput = document.getElementById("amount");
const qrContainer = document.getElementById("qrcode");
const walletAddressEl = document.getElementById("walletAddress");
const tokenSelect = document.getElementById("token");
const toggleAdvanced = document.getElementById("toggleAdvanced");
const advanced = document.getElementById("advanced");
const historyContainer = document.getElementById("historyContainer");

// Botones dentro de la tuerca
const advCopy = document.getElementById("advCopy");
const advHistory = document.getElementById("advHistory");
const advDownload = document.getElementById("advDownload");
const advLogout = document.getElementById("advLogout");

let checkInterval = null;
let currentReference = null;

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
  advanced.setAttribute("aria-hidden", String(!advanced.classList.contains("visible")));
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
      const shortSignature = data.signature
        ? `${String(data.signature).slice(0, 8)}…`
        : "";
      showPaymentStatus(`✅ Pago confirmado${shortSignature ? ` (${shortSignature})` : ""}`);
      qrContainer.classList.add("confirmed");
      ding.play();
      clearInterval(checkInterval);
      checkInterval = null;
      currentReference = null;
    } else if (data.status === "fallido") {
      const reason = data.reason || "Transacción rechazada";
      showPaymentStatus(`❌ Pago fallido: ${reason}`);
      qrContainer.classList.remove("confirmed");
      qrContainer.classList.remove("qr-glow");
      clearInterval(checkInterval);
      checkInterval = null;
      currentReference = null;
    } else if (data.status === "pendiente") {
      console.log("⏳ Aún pendiente.");
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
    };

    // 👇 agregamos la wallet del comercio (si existe)
    if (merchantWallet) {
      body.merchantWallet = merchantWallet;
    }

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

    const qrCanvas = qrContainer.querySelector("canvas");
    if (qrCanvas) {
      const ctx = qrCanvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      qrCanvas.style.borderRadius = "12px";
      qrCanvas.style.backgroundColor = "#0a0018";
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

    console.log("✅ QR generado:", data.solana_url);
    showPaymentStatus("⏳ Esperando pago en la red Solana...");

    currentReference = data.reference;
    checkInterval = setInterval(() => {
      checkPaymentStatus(currentReference);
    }, 8000);
  } catch (err) {
    console.error("Error generando QR:", err);
    alert(`❌ No se pudo conectar al backend.\n\n${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Generar QR";
  }
});

// === HISTORIAL DESDE MONGODB ===
let currentFilter = "all"; // "all", "SOL", "USDC"

function renderHistoryTable(data) {
  const transactions = data?.data ?? [];
  const totals = data?.totals || { SOL: 0, USDC: 0 };
  const totalCount = data?.total ?? 0;

  const filters = [
    { id: "all", label: `📊 Todos (${totalCount})` },
    { id: "USDC", label: `💵 USDC (${totals.USDC.toFixed(2)})` },
    { id: "SOL", label: `⚡ SOL (${totals.SOL.toFixed(5)})` },
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

  let tableMarkup = `
    <div class="info-block">
      <p class="status-text">
        ⚠️ No hay transacciones ${
          currentFilter !== "all" ? "de " + currentFilter : "registradas"
        }
      </p>
    </div>
  `;

  if (transactions.length) {
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
            <td>${tx.fee}</td>
            <td>
              <span class="status-pill ${pillClass}">
                ${pillLabel}
              </span>
            </td>
          </tr>
        `;
      })
      .join("");

    tableMarkup = `
      <div class="table-wrapper">
        <table class="transactions-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Token</th>
              <th>Monto</th>
              <th>Pagador</th>
              <th>Fee</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  historyContainer.innerHTML = `
    <div class="filters">${filterButtons}</div>
    ${tableMarkup}
    <p class="history-hint">✅ Datos obtenidos desde MongoDB Cloud</p>
  `;
}

// 🔄 Función global para filtrar
window.filterTransactions = async (filter) => {
  currentFilter = filter;
  await loadTransactions(filter);
};

// 🔥 Cargar transacciones
async function loadTransactions(filter = "all") {
  historyContainer.innerHTML =
    '<div class="info-block"><p class="status-text">🔄 Cargando desde MongoDB...</p></div>';

  const tokenParam = filter !== "all" ? `&token=${filter}` : "";
  const walletParam = merchantWallet
    ? `&wallet=${encodeURIComponent(merchantWallet)}`
    : "";
  const url = `${API_URL}/transactions?limit=50${tokenParam}${walletParam}`;

  const result = await tryJson(url);

  if (result.ok && result.data) {
    renderHistoryTable(result.data);
  } else {
    historyContainer.innerHTML = `
      <div class="info-block">
        <p class="status-text">❌ Error cargando transacciones</p>
        <p class="status-text">${result.error || "Error desconocido"}</p>
      </div>
    `;
  }
}

// === Acciones dentro de la tuerca ===

// Ver historial
advHistory.addEventListener("click", () => {
  advanced.classList.remove("visible");
  toggleAdvanced.classList.remove("rotating");
  loadTransactions("all");
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
});

// Descargar CSV
advDownload.addEventListener("click", () => {
  let url = `${API_URL}/transactions/download`;
  if (merchantWallet) {
    url += `?wallet=${encodeURIComponent(merchantWallet)}`;
  }
  window.open(url, "_blank");
});

// Copiar dirección desde la tuerca
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

// Cerrar sesión
advLogout.addEventListener("click", () => {
  localStorage.removeItem("raypay_token");
  localStorage.removeItem("raypay_user");
  window.location.href = "login.html";
});

