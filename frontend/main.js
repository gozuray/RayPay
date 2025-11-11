// === Elementos principales ===
const btn = document.getElementById("btnGenerate");
const amountInput = document.getElementById("amount");
const qrContainer = document.getElementById("qrcode");
const walletAddressEl = document.getElementById("walletAddress");
const btnCopy = document.getElementById("btnCopy");
const tokenSelect = document.getElementById("token");
const toggleAdvanced = document.getElementById("toggleAdvanced");
const advanced = document.getElementById("advanced");

let checkInterval = null;
let currentReference = null;

// 🌐 URL del backend (permite override con ?api=https://mi-backend)
const API_URL =
  new URLSearchParams(location.search).get("api") ||
  "https://raypaybackend.onrender.com";

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

// Evita que el foco “consuma” el primer clic
toggleAdvanced.addEventListener("mousedown", (e) => e.preventDefault());

// === Función auxiliar: recorta decimales según token ===
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
    statusEl = document.createElement("div");
    statusEl.id = "status";
    statusEl.style.marginTop = "20px";
    statusEl.style.fontSize = "1.2rem";
    statusEl.style.fontWeight = "600";
    statusEl.style.textAlign = "center";
    statusEl.style.transition = "all 0.3s ease";
    qrContainer.parentNode.insertBefore(statusEl, qrContainer.nextSibling);
  }

  if (msg.startsWith("✅")) {
    statusEl.style.color = "#14f195";
    statusEl.style.textShadow = "0 0 10px #14f195";
  } else {
    statusEl.style.color = "#c084fc";
    statusEl.style.textShadow = "none";
  }

  statusEl.textContent = msg;
}

// === Utilidad fetch robusta con error legible ===
async function safeJsonFetch(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const msg = text || `HTTP ${res.status}`;
    throw new Error(`Request failed: ${msg}`);
  }
  // intenta parsear json; si no es json válido lanza
  try {
    return await res.json();
  } catch (e) {
    const text = await (async () => {
      try { return await res.text(); } catch { return ""; }
    })();
    throw new Error(`Respuesta no-JSON del backend: ${text.slice(0, 200)}`);
  }
}

// === Consultar estado del pago (polling) ===
async function checkPaymentStatus(reference) {
  if (!reference) return;
  try {
    const data = await safeJsonFetch(`${API_URL}/confirm/${reference}`);
    if (data.status === "pagado") {
      showPaymentStatus(`✅ Pago confirmado (${String(data.signature).slice(0, 8)}...)`);
      qrContainer.classList.add("confirmed"); // 💚 cambia niebla a verde
      ding.play();
      clearInterval(checkInterval);
      checkInterval = null;
      currentReference = null;
    } else if (data.status === "pendiente") {
      console.log("⏳ Aún pendiente...");
    }
  } catch (err) {
    console.warn("Error consultando estado:", err);
  }
}

// === Generar QR y crear nuevo pago ===
btn.addEventListener("click", async () => {
  // Reiniciar estado anterior
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  currentReference = null;
  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.remove();
  qrContainer.innerHTML = "";
  walletAddressEl.textContent = "";
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
    const data = await safeJsonFetch(`${API_URL}/create-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: fixedAmount,
        token,
        restaurant: "Restaurante Lisboa",
      }),
    });

    if (!data.solana_url) {
      alert("Error: el backend no devolvió el link de pago.");
      return;
    }

    // === Generar QR con suavizado ===
    const qrSize = 320;
    new QRCode(qrContainer, {
      text: data.solana_url,
      width: qrSize,
      height: qrSize,
      colorDark: "#c084fc",
      colorLight: "#0a0018",
      correctLevel: QRCode.CorrectLevel.M,
    });

    // === Efecto de neblina alrededor del QR ===
    qrContainer.classList.remove("confirmed");
    qrContainer.classList.add("qr-glow");

    // 🔧 Mejora visual del QR
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

    // === Mostrar dirección resumida ===
    const match = data.solana_url.match(/^solana:([^?]+)/);
    const walletAddress = match ? match[1] : "desconocida";
    const shortAddr =
      walletAddress.length > 10
        ? `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`
        : walletAddress;

    walletAddressEl.textContent = `Recibir en: ${shortAddr}`;
    document.getElementById("walletInfo").style.display = "block";

    // === Copiar dirección ===
    btnCopy.onclick = () => {
      navigator.clipboard.writeText(walletAddress).then(() => {
        btnCopy.textContent = "Copiado ✅";
        btnCopy.style.backgroundColor = "#16a34a";
        btnCopy.style.transform = "scale(1.03)";
        setTimeout(() => {
          btnCopy.textContent = "Copiar dirección";
          btnCopy.style.backgroundColor = "#6d28d9";
          btnCopy.style.transform = "scale(1)";
        }, 1500);
      });
    };

    console.log("✅ QR generado:", data.solana_url);
    showPaymentStatus("⏳ Esperando pago en la red Solana...");

    currentReference = data.reference;
    checkInterval = setInterval(() => {
      checkPaymentStatus(currentReference);
    }, 10000);
  } catch (err) {
    console.error("Error generando QR:", err);
    alert(`❌ No se pudo conectar al backend.\n\n${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Generar QR";
  }
});

// === 📜 HISTORIAL DE TRANSACCIONES ===
const btnHistory = document.getElementById("btnHistory");
const btnDownload = document.getElementById("btnDownload");
const historyContainer = document.getElementById("historyContainer");

// helper: pintar tabla
function renderHistoryTable(history) {
  let html = `
    <table style="width:100%; border-collapse:collapse; margin-top:15px;">
      <tr style="background:#3b0764; color:#fff;">
        <th style="padding:8px;">Hash</th>
        <th style="padding:8px;">Monto</th>
        <th style="padding:8px;">Token</th>
        <th style="padding:8px;">Fecha</th>
        <th style="padding:8px;">Hora</th>
      </tr>
  `;
  history.forEach((tx) => {
    const hash = tx.signature || tx.txHash || "";
    html += `
      <tr style="background:#1e0038; color:#c084fc;">
        <td style="padding:6px;">${hash ? hash.slice(0, 8) + "..." : "N/A"}</td>
        <td style="padding:6px;">${tx.amount ?? "-"}</td>
        <td style="padding:6px;">${tx.token ?? "?"}</td>
        <td style="padding:6px;">${tx.date ?? "?"}</td>
        <td style="padding:6px;">${tx.time ?? "?"}</td>
      </tr>
    `;
  });
  html += "</table>";
  historyContainer.innerHTML = html;
}

btnHistory.addEventListener("click", async () => {
  historyContainer.innerHTML = "<p style='color:#aaa'>Cargando historial...</p>";
  try {
    // 1) Preferimos /rebuild-history (usa referencias del QR)
    let json = await safeJsonFetch(`${API_URL}/rebuild-history`);
    let history = json?.data || [];

    // 2) Si vacío, intentamos /history (persistido local)
    if (!Array.isArray(history) || history.length === 0) {
      json = await safeJsonFetch(`${API_URL}/history`);
      if (Array.isArray(json) && json.length > 0) {
        history = json;
      }
    }

    // 3) Si aún vacío, probamos on-chain sin refs: /wallet-history
    if (!Array.isArray(history) || history.length === 0) {
      json = await safeJsonFetch(`${API_URL}/wallet-history?limit=100`);
      if (Array.isArray(json?.data) && json.data.length > 0) {
        history = json.data.map((r) => ({
          txHash: r.txHash,
          amount: r.amount,
          token: r.token,
          date: r.blockTime ? new Date(r.blockTime).toLocaleDateString() : "",
          time: r.blockTime ? new Date(r.blockTime).toLocaleTimeString() : "",
        }));
      }
    }

    if (!Array.isArray(history) || history.length === 0) {
      historyContainer.innerHTML =
        "<p style='color:#aaa'>No hay transacciones registradas todavía.</p>";
      return;
    }

    renderHistoryTable(history);
  } catch (err) {
    console.error("Error obteniendo historial:", err);
    historyContainer.innerHTML =
      `<p style='color:#f87171'>❌ Error al cargar historial:<br>${err.message}</p>`;
  }
});

// Descargar historial CSV
btnDownload.addEventListener("click", () => {
  window.open(`${API_URL}/history/download`, "_blank");
});

historyContainer.style.marginBottom = "40px";
