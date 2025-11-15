const API_BASE = "https://raypay-backend.onrender.com";

document.body.style.display = "block";

const btn = document.getElementById("btnLogin");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const errorMsg = document.getElementById("errorMsg");

btn.addEventListener("click", async () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value.trim();

  if (!username || !password) {
    errorMsg.innerText = "Completa usuario y contraseña";
    errorMsg.style.display = "block";
    return;
  }

  btn.disabled = true;
  btn.innerText = "Ingresando...";

  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      errorMsg.innerText = data.error || "Error";
      errorMsg.style.display = "block";
      return;
    }

    // Guardar token y datos
    localStorage.setItem("raypay_token", data.token);
    localStorage.setItem("raypay_user", JSON.stringify(data.user));

    // 🔥 Detectar si es ADMIN
    if (data.user.role === "admin") {
      window.location.href = "admin.html";  // panel administrador
    } else {
      window.location.href = "index.html";  // POS normal
    }

  } catch (err) {
    errorMsg.innerText = "No se pudo conectar al servidor";
    errorMsg.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.innerText = "Ingresando";
  }
});
