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
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modalTitle");
const formUsername = document.getElementById("formUsername");
const formWallet = document.getElementById("formWallet");
const formPassword = document.getElementById("formPassword");
const saveBtn = document.getElementById("saveBtn");

// Guardamos el ID del merchant que estamos editando
let editingID = null;

// =====================
//  Cargar merchants
// =====================
async function loadMerchants() {
  try {
    const res = await fetch(`${API}/merchants`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await res.json();
    console.log("Merchants:", res.status, data);

    if (!res.ok) {
      tableContainer.innerHTML =
        `<p style="color:#fca5a5">Error: ${data.error || "No se pudo cargar"}</p>`;
      return;
    }

    let html = `
      <table class="table">
        <tr>
          <th>Usuario</th>
          <th>Wallet</th>
          <th>Acciones</th>
        </tr>
    `;

    data.merchants.forEach((m) => {
      html += `
        <tr>
          <td>${m.username ?? "undefined"}</td>
          <td>${m.wallet ?? "-"}</td>
          <td>
            <button class="btn-edit"
                    onclick="openEditModal('${m._id}', '${m.username ?? ""}', '${m.wallet ?? ""}')">
              Editar
            </button>
            <button class="btn-delete"
                    onclick="deleteMerchant('${m._id}')">
              Eliminar
            </button>
          </td>
        </tr>
      `;
    });

    html += "</table>";
    tableContainer.innerHTML = html;
  } catch (e) {
    console.error("loadMerchants error:", e);
    tableContainer.innerHTML =
      `<p style="color:#fca5a5">Error de conexión al backend</p>`;
  }
}

// Cargamos al entrar
loadMerchants();

// =====================
//  MODAL: crear / editar
// =====================
function openCreateModal() {
  editingID = null;
  modalTitle.innerText = "Crear nuevo merchant";
  formUsername.value = "";
  formWallet.value = "";
  formPassword.value = "";
  modal.style.display = "flex";
  saveBtn.onclick = createMerchant;
}

function openEditModal(id, username, wallet) {
  editingID = id;
  modalTitle.innerText = "Editar merchant";
  formUsername.value = username;
  formWallet.value = wallet;
  formPassword.value = "";
  modal.style.display = "flex";
  saveBtn.onclick = saveEdit;
}

function closeModal() {
  modal.style.display = "none";
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
    wallet: formWallet.value.trim(),
    password: formPassword.value.trim(),
  };

  if (!body.username || !body.wallet || !body.password) {
    alert("Completa usuario, wallet y contraseña");
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
  }

  closeModal();
  loadMerchants();
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
  } catch (e) {
    console.error("deleteMerchant error:", e);
    alert("Error de conexión al borrar merchant");
  }
}


// =====================
//  Logout admin
// =====================
function logout() {
  localStorage.clear();          // Borramos usuario + token
  window.location.href = "login.html";
}

// =====================
//  Exportar funciones al window
//  (para que los onclick del HTML funcionen)
// =====================
window.openCreateModal = openCreateModal;
window.openEditModal = openEditModal;
window.deleteMerchant = deleteMerchant;
window.closeModal = closeModal;
window.logout = logout;
