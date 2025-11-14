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
const currentUser = JSON.parse(localStorage.getItem("raypay_user") || "{}");
const merchantWallet = currentUser.wallet || null;
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
    statusEl.style.marginTop = "16px";
    statusEl.style.textAlign = "center";
    statusEl.style.color = "#e5e7eb";
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
      showPaymentStatus(
        `✅ Pago confirmado ${
          data.savedToDatabase ? "(guardado en BD)" : "(desde cache)"
        } (${String(data.signature).slice(0, 8)}.)`
      );
      qrContainer.classList.add("confirmed");
      ding.play();
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
  if (!data || !data.data || data.data.length === 0) {
    historyContainer.innerHTML = `
      <p style='color: #fbbf24; padding: 20px;'>
        ⚠️ No hay transacciones ${currentFilter !== "all" ? "de " + currentFilter : ""}
      </p>
    `;
    return;
  }

  const transactions = data.data;
  const totals = data.totals || { SOL: 0, USDC: 0 };

  let html = `
    <!-- Filtros -->
    <div style="
      display: flex;
      gap: 10px;
      justify-content: center;
      margin-bottom: 15px;
      flex-wrap: wrap;
    ">
      <button onclick="filterTransactions('all')" style="
        padding: 8px 16px;
        border-radius: 8px;
        border: 2px solid ${currentFilter === "all" ? "#c084fc" : "#3b0764"};
        background: ${currentFilter === "all" ? "#6d28d9" : "transparent"};
        color: #fff;
        cursor: pointer;
        font-size: 0.9rem;
        transition: all 0.3s;
      ">
        📊 Todos (${data.total})
      </button>
      <button onclick="filterTransactions('USDC')" style="
        padding: 8px 16px;
        border-radius: 8px;
        border: 2px solid ${currentFilter === "USDC" ? "#c084fc" : "#3b0764"};
        background: ${currentFilter === "USDC" ? "#6d28d9" : "transparent"};
        color: #fff;
        cursor: pointer;
        font-size: 0.9rem;
        transition: all 0.3s;
      ">
        💵 USDC (${totals.USDC.toFixed(2)})
      </button>
      <button onclick="filterTransactions('SOL')" style="
        padding: 8px 16px;
        border-radius: 8px;
        border: 2px solid ${currentFilter === "SOL" ? "#c084fc" : "#3b0764"};
        background: ${currentFilter === "SOL" ? "#6d28d9" : "transparent"};
        color: #fff;
        cursor: pointer;
        font-size: 0.9rem;
        transition: all 0.3s;
      ">
        ⚡ SOL (${totals.SOL.toFixed(5)})
      </button>
    </div>

    <div style="overflow-x:auto;">
      <table style="
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
        color: #e5e7eb;
        background: rgba(15, 6, 38, 0.9);
        border-radius: 12px;
        overflow: hidden;
      ">
        <thead>
          <tr style="background: rgba(88, 28, 135, 0.95);">
            <th style="padding: 10px;">Fecha</th>
            <th style="padding: 10px;">Token</th>
            <th style="padding: 10px;">Monto</th>
            <th style="padding: 10px;">Pagador</th>
            <th style="padding: 10px;">Fee</th>
            <th style="padding: 10px;">Estado</th>
          </tr>
        </thead>
        <tbody>
  `;

  transactions.forEach((tx) => {
    const shortPayer =
      tx.payer && tx.payer.length > 10
        ? `${tx.payer.slice(0, 4)}...${tx.payer.slice(-4)}`
        : tx.payer || "N/A";
    html += `
      <tr style="border-top: 1px solid rgba(55, 65, 81, 0.6);">
        <td style="padding: 8px 10px;">
          <div>${tx.date}</div>
          <div style="font-size: 0.8rem; color:#9ca3af;">${tx.time}</div>
        </td>
        <td style="padding: 8px 10px;">${tx.token}</td>
        <td style="padding: 8px 10px;">${tx.amount}</td>
        <td style="padding: 8px 10px;">${shortPayer}</td>
        <td style="padding: 8px 10px;">${tx.fee}</td>
        <td style="padding: 8px 10px;">
          <span style="
            padding: 4px 8px;
            border-radius: 999px;
            background: ${
              tx.status === "success" ? "#16a34a33" : "#facc1533"
            };
            color: ${tx.status === "success" ? "#bbf7d0" : "#fed7aa"};
            font-size: 0.8rem;
          ">
            ${tx.status === "success" ? "Completo" : tx.status}
          </span>
        </td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>
    <div style="margin-top: 15px; text-align: center; color: #9ca3af; font-size: 0.85rem;">
      ✅ Datos obtenidos desde MongoDB Cloud
    </div>
  `;

  historyContainer.innerHTML = html;
}

// 🔄 Función global para filtrar
window.filterTransactions = async (filter) => {
  currentFilter = filter;
  await loadTransactions(filter);
};

// 🔥 Cargar transacciones
async function loadTransactions(filter = "all") {
  historyContainer.innerHTML =
    "<p style='color:#aaa; padding: 20px;'>🔄 Cargando desde MongoDB.</p>";

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
      <div style="padding: 20px; background: #1e0038; border-radius: 8px; margin-top: 15px;">
        <p style='color: #f87171; font-size: 1.1rem;'>
          ❌ Error cargando transacciones
        </p>
        <p style='color: #9ca3af; font-size: 0.9rem; margin-top: 10px;'>
          ${result.error || "Error desconocido"}
        </p>
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
    advCopy.textContent = "📋 Dirección copiada ✅";
    setTimeout(() => {
      advCopy.textContent = "📋 Copiar dirección";
    }, 1500);
  });
});

// Cerrar sesión
advLogout.addEventListener("click", () => {
  localStorage.removeItem("raypay_token");
  localStorage.removeItem("raypay_user");
  window.location.href = "login.html";
});

historyContainer.style.marginBottom = "40px";
document.body.style.display = "block";
