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

// === Utilidad fetch robusta ===
async function safeJsonFetch(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const msg = text || `HTTP ${res.status}`;
    throw new Error(`Request failed: ${msg}`);
  }
  try {
    return await res.json();
  } catch {
    const text = await (async () => {
      try { return await res.text(); } catch { return ""; }
    })();
    throw new Error(`Respuesta no-JSON del backend: ${text.slice(0, 200)}`);
  }
}

// === Helper: intenta una URL ===
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
      showPaymentStatus(`✅ Pago confirmado (${String(data.signature).slice(0, 8)}...)`);
      qrContainer.classList.add("confirmed");
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
        ? `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`
        : walletAddress;

    walletAddressEl.textContent = `Recibir en: ${shortAddr}`;
    document.getElementById("walletInfo").style.display = "block";

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

// === 📜 HISTORIAL DE TRANSACCIONES (UI MEJORADA) ===
const btnHistory = document.getElementById("btnHistory");
const btnDownload = document.getElementById("btnDownload");
const historyContainer = document.getElementById("historyContainer");

// 🎨 Helper: pintar tabla responsive
function renderHistoryTable(history) {
  let html = `
    <div style="
      width: 100%; 
      overflow-x: auto; 
      margin-top: 15px;
      border-radius: 8px;
      background: #1e0038;
      padding: 10px;
      box-sizing: border-box;
    ">
      <table style="
        width: 100%; 
        min-width: 500px;
        border-collapse: collapse;
        font-size: 0.85rem;
      ">
        <thead>
          <tr style="background: #3b0764; color: #fff;">
            <th style="padding: 10px 8px; text-align: left; white-space: nowrap;">Hash</th>
            <th style="padding: 10px 8px; text-align: right;">Monto</th>
            <th style="padding: 10px 8px; text-align: center;">Token</th>
            <th style="padding: 10px 8px; text-align: center; white-space: nowrap;">Fecha</th>
            <th style="padding: 10px 8px; text-align: center; white-space: nowrap;">Hora</th>
          </tr>
        </thead>
        <tbody>
  `;
  
  history.forEach((tx, index) => {
    const hash = tx.signature || tx.txHash || "";
    const bgColor = index % 2 === 0 ? "#1e0038" : "#2a0048";
    
    html += `
      <tr style="
        background: ${bgColor}; 
        color: #c084fc;
        transition: background 0.2s;
      " 
      onmouseover="this.style.background='#3b0764'" 
      onmouseout="this.style.background='${bgColor}'">
        <td style="padding: 8px; font-family: monospace; font-size: 0.8rem;">
          ${hash ? hash.slice(0, 8) + "..." : "N/A"}
        </td>
        <td style="padding: 8px; text-align: right; font-weight: 600;">
          ${tx.amount ?? "-"}
        </td>
        <td style="padding: 8px; text-align: center;">
          <span style="
            background: ${tx.token === 'SOL' ? '#14f195' : '#c084fc'};
            color: #0a0018;
            padding: 2px 8px;
            border-radius: 4px;
            font-weight: 600;
            font-size: 0.75rem;
          ">${tx.token ?? "?"}</span>
        </td>
        <td style="padding: 8px; text-align: center; font-size: 0.8rem;">
          ${tx.date ?? "?"}
        </td>
        <td style="padding: 8px; text-align: center; font-size: 0.8rem;">
          ${tx.time ?? "?"}
        </td>
      </tr>
    `;
  });
  
  html += `
        </tbody>
      </table>
    </div>
  `;
  
  historyContainer.innerHTML = html;
}

btnHistory.addEventListener("click", async () => {
  historyContainer.innerHTML = "<p style='color:#aaa; padding: 20px;'>🔄 Cargando historial...</p>";

  let history = [];

  // 1️⃣ Intentar archivo local primero
  let r1 = await tryJson(`${API_URL}/history`);
  if (r1.ok && Array.isArray(r1.data) && r1.data.length > 0) {
    history = r1.data;
    console.log("✅ Historial cargado desde archivo local");
  }

  // 2️⃣ Si está vacío, consultar blockchain
  if (history.length === 0) {
    console.log("⏳ Consultando blockchain...");
    historyContainer.innerHTML = `
      <p style='color: #c084fc; padding: 20px;'>
        ⏳ Consultando blockchain...<br>
        <span style='font-size: 0.85rem; color: #9ca3af;'>(puede tardar 10-20 segundos)</span>
      </p>
    `;
    
    let r2 = await tryJson(`${API_URL}/wallet-history?limit=20`);
    
    if (r2.ok && Array.isArray(r2.data?.data) && r2.data.data.length > 0) {
      history = r2.data.data.map((r) => ({
        txHash: r.txHash,
        amount: r.amount,
        token: r.token,
        date: r.blockTime ? new Date(r.blockTime).toLocaleDateString() : "",
        time: r.blockTime ? new Date(r.blockTime).toLocaleTimeString() : "",
      }));
      console.log("✅ Historial cargado desde blockchain");
    }
  }

  if (history.length > 0) {
    renderHistoryTable(history);
  } else {
    historyContainer.innerHTML = `
      <div style="
        padding: 20px; 
        background: #1e0038; 
        border-radius: 8px; 
        margin-top: 15px;
        text-align: left;
      ">
        <p style='color: #fbbf24; font-size: 1.1rem; margin-bottom: 15px;'>
          ⚠️ No hay transacciones disponibles
        </p>
        <div style='color: #9ca3af; font-size: 0.9rem; line-height: 1.6;'>
          <strong style='color: #c084fc;'>Posibles razones:</strong><br>
          • El servidor se reinició (Render gratuito borra datos)<br>
          • No hay pagos confirmados aún<br>
          • El RPC está saturado (error 429)<br><br>
          
          <strong style='color: #60a5fa;'>💡 Solución:</strong><br>
          Usar MongoDB Atlas para guardar datos permanentemente
        </div>
      </div>
    `;
  }
});

// Descargar CSV
btnDownload.addEventListener("click", () => {
  window.open(`${API_URL}/history/download`, "_blank");
});

historyContainer.style.marginBottom = "40px";