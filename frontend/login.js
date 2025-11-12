const API_URL = "https://raypay-backend.onrender.com"; 
// si usas Render, cambia arriba por:
// const API_URL = "https://tu-backend.onrender.com/api/auth/login";

const btn = document.getElementById("btnLogin");
const errorMsg = document.getElementById("errorMsg");

btn.addEventListener("click", login);

async function login() {
  errorMsg.style.display = "none";

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value.trim();

  if (!email || !password) {
    showError("Completa todos los campos");
    return;
  }

  btn.disabled = true;
  btn.innerText = "Ingresando...";

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || "Error al iniciar sesión");
      return;
    }

    // ✔ Guardamos el token
    localStorage.setItem("raypay_token", data.token);
    localStorage.setItem("raypay_user", JSON.stringify(data.user));

    // ✔ Redirigimos al POS
    window.location.href = "index.html";

  } catch (e) {
    showError("Error conectando con el servidor");
  } finally {
    btn.disabled = false;
    btn.innerText = "Ingresar";
  }
}

function showError(msg) {
  errorMsg.innerText = msg;
  errorMsg.style.display = "block";
}
