// assets/js/auth.js
const API = 'http://localhost:3000';

export function getSession() {
  return {
    token: localStorage.getItem('token'),
    rol: localStorage.getItem('rol'),
    nombre_usuario: localStorage.getItem('nombre_usuario'),
  };
}

export function clearSession() {
  localStorage.removeItem('token');
  localStorage.removeItem('rol');
  localStorage.removeItem('nombre_usuario');
}

export function requireRole(roles = []) {
  const s = getSession();
  if (!s.token) {
    window.location.href = './snoop-menu.html#login';
    return false;
  }
  if (roles.length && !roles.includes(s.rol)) {
    alert('No autorizado');
    window.location.href = './snoop-menu.html';
    return false;
  }
  return true;
}

export async function apiFetch(path, options = {}) {
  const s = getSession();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (s.token) headers.Authorization = `Bearer ${s.token}`;
  const res = await fetch(`${API}${path}`, { ...options, headers });
  if (!res.ok) throw await res.json().catch(() => ({ error: 'Error' }));
  return res.json();
}
