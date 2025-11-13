document.body.style.display = "block";

// 👉 URL del backend en Render
const API_BASE = "https://raypay-backend.onrender.com";
const LOGIN_URL = `${API_BASE}/api/auth/login`;

const btn = document.getElementById("btnLogin");
const errorMsg = document.getElementById("errorMsg");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
// 🔚 Botón de cerrar sesión
const logoutBtn = document.getElementById("btnLogout");
if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    localStorage.removeItem("raypay_token");
    localStorage.removeItem("raypay_user");
    window.location.href = "login.html";
  });
}

btn.addEventListener("click", handleLogin);

function showError(message) {
  errorMsg.innerText = message;
  errorMsg.style.display = "block";
}

async function handleLogin() {
  errorMsg.style.display = "none";

  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();

  if (!email || !password) {
    showError("Completa todos los campos");
    return;
  }

  btn.disabled = true;
  btn.innerText = "Ingresando...";

  try {
    console.log("Enviando login a:", LOGIN_URL);

    const res = await fetch(LOGIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json().catch(() => ({}));
    console.log("Respuesta login:", res.status, data);

    if (!res.ok) {
      // Mensajes bonitos según el status
      if (res.status === 401 || res.status === 404) {
        showError("Email o contraseña incorrectos");
      } else {
        showError(data.error || "Error al iniciar sesión");
      }
      return;
    }

    // ✅ Guardar token y usuario
    localStorage.setItem("raypay_token", data.token);
    localStorage.setItem("raypay_user", JSON.stringify(data.user));

    // 🔁 Redirigir al POS
    window.location.href = "index.html";
  } catch (err) {
    console.error("Error login:", err);
    showError("No se puede conectar al servidor");
  } finally {
    btn.disabled = false;
    btn.innerText = "Ingresar";
  }
}
