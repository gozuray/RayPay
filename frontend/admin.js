// frontend/admin.js
const API = "https://raypay-backend.onrender.com/admin";

// Leemos usuario y token del localStorage
const user = JSON.parse(localStorage.getItem("raypay_user"));
const token = localStorage.getItem("raypay_token");

// Si no hay usuario o no es admin → bloquear pantalla
if (!user || user.role !== "admin") {
  document.body.innerHTML = "<h2>No autorizado</h2>";
  throw new Error("No autorizado");
}

// Referencias al DOM
const tableContainer = document.getElementById("merchantsTable");
const keysContainer = document.getElementById("keysTable");
const destinationMerchantSelect = document.getElementById(
  "destinationMerchantSelect"
);
const destinationWalletInput = document.getElementById(
  "destinationWalletInput"
);
const destinationStatus = document.getElementById("destinationStatus");
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modalTitle");
const formUsername = document.getElementById("formUsername");
const formWallet = document.getElementById("formWallet");
const formPassword = document.getElementById("formPassword");
const formWalletMode = document.getElementById("formWalletMode");
const manualWalletWrapper = document.getElementById("manualWalletWrapper");
const saveBtn = document.getElementById("saveBtn");

// Guardamos el ID del merchant que estamos editando
let editingID = null;
let merchantsCache = [];

function toggleWalletInput() {
  if (formWalletMode.value === "manual") {
    manualWalletWrapper.classList.add("visible");
  } else {
    manualWalletWrapper.classList.remove("visible");
    formWallet.value = "";
  }
}

formWalletMode.addEventListener("change", toggleWalletInput);

function formatBalance(value, decimals = 4) {
  const num = Number(value ?? 0);
  return num.toLocaleString("es-ES", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

function setDestinationStatus(message, isError = false) {
  if (!destinationStatus) return;
  destinationStatus.textContent = message || "";
  destinationStatus.style.color = isError ? "#ff8a8a" : "#7af0d2";
}

function syncDestinationWalletInput() {
  if (!destinationMerchantSelect || !destinationWalletInput) return;
  const targetId = destinationMerchantSelect.value;
  const merchant = merchantsCache.find((m) => m._id === targetId);
  destinationWalletInput.value = merchant?.destinationWallet ?? "";
  if (merchant) {
    setDestinationStatus(
      merchant.destinationWallet
        ? `Destino actual: ${merchant.destinationWallet}`
        : "Sin destino configurado"
    );
  }
}

function updateDestinationForm(preserveId) {
  if (!destinationMerchantSelect || !destinationWalletInput) return;

  if (!merchantsCache.length) {
    destinationMerchantSelect.innerHTML =
      '<option value="">No hay merchants disponibles</option>';
    destinationMerchantSelect.disabled = true;
    destinationWalletInput.disabled = true;
    destinationWalletInput.value = "";
    setDestinationStatus("Aún no hay merchants para configurar");
    return;
  }

  destinationMerchantSelect.disabled = false;
  destinationWalletInput.disabled = false;

  const options = merchantsCache
    .map(
      (merchant) =>
        `<option value="${merchant._id}">${merchant.username}</option>`
    )
    .join("");

  destinationMerchantSelect.innerHTML = options;

  const desiredId =
    preserveId && merchantsCache.some((m) => m._id === preserveId)
      ? preserveId
      : merchantsCache[0]._id;

  destinationMerchantSelect.value = desiredId;
  syncDestinationWalletInput();
}

if (destinationMerchantSelect) {
  destinationMerchantSelect.addEventListener("change", syncDestinationWalletInput);
}

// =====================
//  Cargar merchants
// =====================
async function loadMerchants() {
  const previousSelection = destinationMerchantSelect?.value || "";
  try {
    const res = await fetch(`${API}/merchants`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await res.json();
    console.log("Merchants:", res.status, data);

    if (!res.ok) {
      tableContainer.innerHTML = `<p style="color:#fca5a5">Error: ${
        data.error || "No se pudo cargar"
      }</p>`;
      return;
    }

    const merchants = data.merchants || [];
    merchantsCache = merchants;

    if (!merchants.length) {
      tableContainer.innerHTML =
        '<p style="color:#b689ff">No hay merchants registrados aún.</p>';
      updateDestinationForm(previousSelection);
      return;
    }

    let html = `
      <table class="table">
        <tr>
          <th>Usuario</th>
          <th>Wallet</th>
          <th>Saldo disponible</th>
          <th>Acciones</th>
        </tr>
    `;

    merchants.forEach((m) => {
      const solBalance = formatBalance(m.balances?.sol ?? 0, 4);
      const usdcBalance = formatBalance(m.balances?.usdc ?? 0, 2);
      const destination = m.destinationWallet ?? "";
      const disableClaim = !destination;
      const claimTitle = disableClaim
        ? "Configura una wallet destino para habilitar claim"
        : `Enviar fondos a ${destination}`;

      html += `
        <tr>
          <td>${m.username ?? "undefined"}</td>
          <td>${m.wallet ?? "-"}</td>
          <td>
            <div class="balance-pill">
              <span><strong>SOL:</strong> ${solBalance}</span>
              <span><strong>USDC:</strong> ${usdcBalance}</span>
            </div>
          </td>
          <td>
            <div class="table-actions">
              <button class="btn-edit"
                      onclick="openEditModal('${m._id}', '${
        m.username ?? ""
      }', '${m.wallet ?? ""}')">
                Editar
              </button>
              <button class="btn-delete"
                      onclick="deleteMerchant('${m._id}')">
                Eliminar
              </button>
              <button class="btn-claim"
                      title="${claimTitle}"
                      ${disableClaim ? "disabled" : ""}
                      onclick="triggerClaim('${m._id}')">
                Claim
              </button>
            </div>
          </td>
        </tr>
      `;
    });

    html += "</table>";
    tableContainer.innerHTML = html;
    updateDestinationForm(previousSelection);
  } catch (e) {
    console.error("loadMerchants error:", e);
    tableContainer.innerHTML =
      `<p style="color:#fca5a5">Error de conexión al backend</p>`;
  }
}

// =====================
//  Private keys
// =====================
async function loadPrivateKeys() {
  try {
    const res = await fetch(`${API}/keys`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await res.json();

    if (!res.ok) {
      keysContainer.innerHTML = `<p style="color:#fca5a5">Error: ${
        data.error || "No se pudo cargar"
      }</p>`;
      return;
    }

    if (!data.keys.length) {
      keysContainer.innerHTML =
        '<p style="color:#b689ff">No hay wallets creadas automáticamente aún.</p>';
      return;
    }

    let html = `
      <table class="table">
        <tr>
          <th>Merchant</th>
          <th>Wallet address</th>
          <th>Private key (base64)</th>
          <th>Creado</th>
        </tr>
    `;

    data.keys.forEach((key) => {
      const createdAt = key.createdAt
        ? new Date(key.createdAt).toLocaleString()
        : "-";
      html += `
        <tr>
          <td>${key.merchantUsername ?? "-"}</td>
          <td>${key.walletAddress ?? "-"}</td>
          <td><code>${key.privateKey ?? "-"}</code></td>
          <td>${createdAt}</td>
        </tr>
      `;
    });

    html += "</table>";
    keysContainer.innerHTML = html;
  } catch (e) {
    console.error("loadPrivateKeys error:", e);
    keysContainer.innerHTML =
      `<p style="color:#fca5a5">Error de conexión al cargar las llaves</p>`;
  }
}

// Cargamos al entrar
loadMerchants();
loadPrivateKeys();

// =====================
//  MODAL: crear / editar
// =====================
function openCreateModal() {
  editingID = null;
  modalTitle.innerText = "Crear nuevo merchant";
  formUsername.value = "";
  formPassword.value = "";
  formWalletMode.disabled = false;
  formWalletMode.value = "auto";
  toggleWalletInput();
  modal.style.display = "flex";
  saveBtn.onclick = createMerchant;
}

function openEditModal(id, username, wallet) {
  editingID = id;
  modalTitle.innerText = "Editar merchant";
  formUsername.value = username;
  formWallet.value = wallet;
  formPassword.value = "";
  formWalletMode.value = "manual";
  formWalletMode.disabled = true;
  toggleWalletInput();
  modal.style.display = "flex";
  saveBtn.onclick = saveEdit;
}

function closeModal() {
  modal.style.display = "none";
  formWalletMode.disabled = false;
}

// Cerrar modal si clicas fuera
window.onclick = (e) => {
  if (e.target === modal) closeModal();
};

// =====================
//  Crear merchant
// =====================
async function createMerchant() {
  const body = {
    username: formUsername.value.trim(),
    password: formPassword.value.trim(),
    walletMode: formWalletMode.value,
  };

  if (body.walletMode === "manual") {
    body.wallet = formWallet.value.trim();
  }

  if (!body.username || !body.password) {
    alert("Completa usuario y contraseña");
    return;
  }

  if (body.walletMode === "manual" && !body.wallet) {
    alert("Ingresa la wallet para el modo manual");
    return;
  }

  const res = await fetch(`${API}/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Error al crear merchant");
    return;
  }

  if (data.wallet?.address) {
    alert(
      `Wallet creada automáticamente:\n${data.wallet.address}\n\nPrivate key (guárdala en un lugar seguro):\n${data.wallet.privateKey}`
    );
  }

  closeModal();
  loadMerchants();
  loadPrivateKeys();
}

// =====================
//  Guardar edición
// =====================
async function saveEdit() {
  const body = {
    username: formUsername.value.trim(),
    wallet: formWallet.value.trim(),
  };

  if (formPassword.value.trim()) {
    body.password = formPassword.value.trim();
  }

  const res = await fetch(`${API}/merchant/${editingID}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Error al editar merchant");
  }

  closeModal();
  loadMerchants();
  loadPrivateKeys();
}

// =====================
//  Eliminar merchant
// =====================
async function deleteMerchant(id) {
  if (!confirm("¿Eliminar merchant?")) return;

  try {
    const res = await fetch(`${API}/merchant/${id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      console.warn("Respuesta no JSON en DELETE:", e);
    }

    console.log("DELETE /admin/merchant:", res.status, data);

    if (!res.ok) {
      alert(data.error || "Error al eliminar merchant");
      return;
    }

    // Recargar lista
    loadMerchants();
    loadPrivateKeys();
  } catch (e) {
    console.error("deleteMerchant error:", e);
    alert("Error de conexión al borrar merchant");
  }
}

// =====================
//  Refrescar merchants
// =====================
function refreshMerchants() {
  loadMerchants();
  loadPrivateKeys();
}

// =====================
//  Guardar wallet de destino
// =====================
async function saveDestinationWallet() {
  if (!destinationMerchantSelect || !destinationWalletInput) return;
  const merchantId = destinationMerchantSelect.value;
  if (!merchantId) {
    setDestinationStatus("Selecciona un merchant primero", true);
    return;
  }

  const wallet = destinationWalletInput.value.trim();
  if (!wallet && !confirm("¿Deseas dejar sin wallet de destino este merchant?")) {
    return;
  }

  try {
    const res = await fetch(`${API}/merchant/${merchantId}/destination`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ destinationWallet: wallet }),
    });

    const data = await res.json();
    if (!res.ok) {
      setDestinationStatus(data.error || "Error al guardar destino", true);
      return;
    }

    await loadMerchants();
    const message = data.destinationWallet
      ? `Destino actualizado: ${data.destinationWallet}`
      : "Destino eliminado. Claim deshabilitado.";
    setDestinationStatus(message, false);
  } catch (error) {
    console.error("saveDestinationWallet error:", error);
    setDestinationStatus("Error de conexión al guardar destino", true);
  }
}

// =====================
//  Ejecutar claim
// =====================
async function triggerClaim(merchantId) {
  const merchant = merchantsCache.find((m) => m._id === merchantId);
  if (!merchant) {
    alert("Merchant no encontrado en memoria");
    return;
  }

  if (!merchant.destinationWallet) {
    alert("Configura una wallet de destino antes de usar Claim");
    return;
  }

  const claimTokenInput = prompt(
    "Ingresa el token a reclamar (SOL o USDC)",
    "SOL"
  );
  if (!claimTokenInput) return;

  const normalized = claimTokenInput.toUpperCase() === "USDC" ? "USDC" : "SOL";
  const confirmMessage = `Vas a reclamar el saldo disponible en ${normalized} de ${
    merchant.username || "merchant"
  } hacia ${merchant.destinationWallet}.`;

  if (!confirm(confirmMessage)) return;

  try {
    const res = await fetch(`${API}/merchant/${merchantId}/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ token: normalized }),
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Error al ejecutar claim");
      return;
    }

    alert(
      `Claim ejecutado correctamente.\nToken: ${data.token}\nMonto transferido: ${data.amount}\nTx: ${data.signature}`
    );
    loadMerchants();
  } catch (error) {
    console.error("triggerClaim error:", error);
    alert("Error de conexión al ejecutar claim");
  }
}

// =====================
//  Logout admin
// =====================
function logout() {
  localStorage.clear(); // Borramos usuario + token
  window.location.href = "login.html";
}

// =====================
//  Exportar funciones al window
// =====================
window.openCreateModal = openCreateModal;
window.openEditModal = openEditModal;
window.deleteMerchant = deleteMerchant;
window.closeModal = closeModal;
window.logout = logout;
window.refreshMerchants = refreshMerchants;
window.triggerClaim = triggerClaim;
window.saveDestinationWallet = saveDestinationWallet;
