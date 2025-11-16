const API_BASE = "https://raypay-backend.onrender.com";

document.getElementById("btnLogin").addEventListener("click", async () => {
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value.trim();
  const errorMsg = document.getElementById("errorMsg");
  const loginStatus = document.getElementById("loginStatus");
  const btnLogin = document.getElementById("btnLogin");

  if (!username || !password) {
    errorMsg.innerText = "Completa usuario y contraseña";
    errorMsg.style.display = "block";
    return;
  }

  errorMsg.style.display = "none";
  loginStatus.textContent = "Iniciando sesión...";
  loginStatus.style.display = "block";
  btnLogin.disabled = true;
  btnLogin.textContent = "Ingresando...";

  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      errorMsg.innerText = data.error || "Error de login";
      errorMsg.style.display = "block";
      loginStatus.style.display = "none";
      return;
    }

    // Guardar usuario y token
    localStorage.setItem("raypay_user", JSON.stringify(data.user));
    localStorage.setItem("raypay_token", data.token);

    // ADMIN → Panel
    if (data.user.role === "admin") {
      window.location.href = "admin.html";
    } else {
      // Merchant normal → POS
      window.location.href = "index.html";
    }

  } catch (e) {
    errorMsg.innerText = "No se pudo conectar al servidor";
    errorMsg.style.display = "block";
    loginStatus.style.display = "none";
  } finally {
    btnLogin.disabled = false;
    btnLogin.textContent = "Ingresar";
  }
});
