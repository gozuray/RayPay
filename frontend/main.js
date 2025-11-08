const btn = document.getElementById("btnGenerate");
const amountInput = document.getElementById("amount");
const qrContainer = document.getElementById("qrcode");
const walletAddressEl = document.getElementById("walletAddress");
const btnCopy = document.getElementById("btnCopy");
const tokenSelect = document.getElementById("token");
const toggleAdvanced = document.getElementById("toggleAdvanced");
const advanced = document.getElementById("advanced");

let checkInterval = null; // control del ciclo de verificación
let currentReference = null;

// 🎵 Sonido para pago confirmado
const ding = new Audio(
  "https://actions.google.com/sounds/v1/cartoon/clang_and_wobble.ogg"
);

// Mostrar/ocultar configuración avanzada
toggleAdvanced.addEventListener("click", () => {
  advanced.style.display = advanced.style.display === "none" ? "block" : "none";
});

// Función auxiliar: recorta decimales según token
function clampDecimals(valueStr, decimals) {
  let v = (valueStr || "")
    .replace(",", ".")            // soporta coma
    .replace(/[^\d.]/g, "");      // solo números y punto

  const parts = v.split(".");
  if (parts.length > 2) v = parts[0] + "." + parts.slice(1).join("");

  if (parts[1] && parts[1].length > decimals) {
    parts[1] = parts[1].slice(0, decimals);
    v = parts.join(".");
  }
  return v;
}

// Limitar input en tiempo real: SOL=5, USDC=3
amountInput.addEventListener("input", (e) => {
  const token = tokenSelect ? tokenSelect.value : "USDC";
  const maxDecimals = token === "SOL" ? 5 : 3;

  let value = clampDecimals(e.target.value, maxDecimals);

  // límite superior opcional
  const numeric = parseFloat(value);
  if (!isNaN(numeric) && numeric > 1000) value = "1000";

  e.target.value = value;
});

// Al cambiar el token, revalida el campo para ajustar decimales visibles
if (tokenSelect) {
  tokenSelect.addEventListener("change", () => {
    const token = tokenSelect.value;
    const maxDecimals = token === "SOL" ? 5 : 3;
    amountInput.value = clampDecimals(amountInput.value, maxDecimals);
  });
}

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

// Consultar estado del pago
async function checkPaymentStatus(reference) {
  if (!reference) return;
  try {
    const response = await fetch(`http://127.0.0.1:3000/confirm/${reference}`);
    if (!response.ok) return;

    const data = await response.json();
    if (data.status === "pagado") {
      showPaymentStatus(`✅ Pago confirmado (${data.signature.slice(0, 8)}...)`);
      qrContainer.style.filter = "drop-shadow(0 0 20px #14f195)";
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

// Generar QR y crear nuevo pago
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

  // Normaliza el valor del input a los decimales definidos (sin forzar 2)
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
    const fixedAmount = amount.toFixed(decimals); // ← precisión correcta por token

    const response = await fetch("http://127.0.0.1:3000/create-payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: fixedAmount,
        token,
        restaurant: "Restaurante Lisboa",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Backend error: ${errorText}`);
    }

    const data = await response.json();
    if (!data.solana_url) {
      alert("Error: el backend no devolvió el link de pago.");
      return;
    }

    // Mostrar QR (aumentado y con M para evitar overflow)
    new QRCode(qrContainer, {
      text: data.solana_url,
      width: 320,
      height: 320,
      colorDark: "#c084fc",
      colorLight: "#0a0018",
      correctLevel: QRCode.CorrectLevel.M,
    });

    const match = data.solana_url.match(/^solana:([^?]+)/);
    const walletAddress = match ? match[1] : "desconocida";
    walletAddressEl.textContent = `Recibir en: ${walletAddress}`;
    document.getElementById("walletInfo").style.display = "block";

    btnCopy.onclick = () => {
      navigator.clipboard.writeText(walletAddress).then(() => {
        btnCopy.textContent = "Copiado ✅";
        setTimeout(() => (btnCopy.textContent = "Copiar dirección"), 1500);
      });
    };

    console.log("✅ QR generado:", data.solana_url);

    // Estado inicial
    showPaymentStatus("⏳ Esperando pago en la red Solana...");

    // Iniciar verificación periódica
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
