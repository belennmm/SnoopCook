'use strict';
/**
 * FOR THE WEB PAGE
 * 
 * BOOSTRAP HELPERS 
 */


/**
 * PRELOAD
 * 
 * loading will be end after document is loaded
 */

const preloader = document.querySelector("[data-preaload]");

window.addEventListener("load", function () {
  preloader.classList.add("loaded");
  document.body.classList.add("loaded");
});



/**
 * add event listener on multiple elements
 */

const addEventOnElements = function (elements, eventType, callback) {
  for (let i = 0, len = elements.length; i < len; i++) {
    elements[i].addEventListener(eventType, callback);
  }
}



/**
 * NAVBAR
 */

const navbar = document.querySelector("[data-navbar]");
const navTogglers = document.querySelectorAll("[data-nav-toggler]");
const overlay = document.querySelector("[data-overlay]");

const toggleNavbar = function () {
  navbar.classList.toggle("active");
  overlay.classList.toggle("active");
  document.body.classList.toggle("nav-active");
}

addEventOnElements(navTogglers, "click", toggleNavbar);



/**
 * HEADER & BACK TOP BTN
 */

const header = document.querySelector("[data-header]");
const backTopBtn = document.querySelector("[data-back-top-btn]");

let lastScrollPos = 0;

const hideHeader = function () {
  const isScrollBottom = lastScrollPos < window.scrollY;
  if (isScrollBottom) {
    header.classList.add("hide");
  } else {
    header.classList.remove("hide");
  }

  lastScrollPos = window.scrollY;
}

window.addEventListener("scroll", function () {
  if (window.scrollY >= 50) {
    header.classList.add("active");
    backTopBtn.classList.add("active");
    hideHeader();
  } else {
    header.classList.remove("active");
    backTopBtn.classList.remove("active");
  }
});



/**
 * HERO SLIDER
 */

const heroSlider = document.querySelector("[data-hero-slider]");
const heroSliderItems = document.querySelectorAll("[data-hero-slider-item]");
const heroSliderPrevBtn = document.querySelector("[data-prev-btn]");
const heroSliderNextBtn = document.querySelector("[data-next-btn]");

let currentSlidePos = 0;
let lastActiveSliderItem = heroSliderItems[0];

const updateSliderPos = function () {
  lastActiveSliderItem.classList.remove("active");
  heroSliderItems[currentSlidePos].classList.add("active");
  lastActiveSliderItem = heroSliderItems[currentSlidePos];
}

const slideNext = function () {
  if (currentSlidePos >= heroSliderItems.length - 1) {
    currentSlidePos = 0;
  } else {
    currentSlidePos++;
  }

  updateSliderPos();
}

heroSliderNextBtn.addEventListener("click", slideNext);

const slidePrev = function () {
  if (currentSlidePos <= 0) {
    currentSlidePos = heroSliderItems.length - 1;
  } else {
    currentSlidePos--;
  }

  updateSliderPos();
}

heroSliderPrevBtn.addEventListener("click", slidePrev);

/**
 * auto slide
 */

let autoSlideInterval;

const autoSlide = function () {
  autoSlideInterval = setInterval(function () {
    slideNext();
  }, 7000);
}

addEventOnElements([heroSliderNextBtn, heroSliderPrevBtn], "mouseover", function () {
  clearInterval(autoSlideInterval);
});

addEventOnElements([heroSliderNextBtn, heroSliderPrevBtn], "mouseout", autoSlide);

window.addEventListener("load", autoSlide);



/**
 * PARALLAX EFFECT
 */

const parallaxItems = document.querySelectorAll("[data-parallax-item]");

let x, y;

window.addEventListener("mousemove", function (event) {

  x = (event.clientX / window.innerWidth * 10) - 5;
  y = (event.clientY / window.innerHeight * 10) - 5;

  // reverse the number eg. 20 -> -20, -5 -> 5
  x = x - (x * 2);
  y = y - (y * 2);

  for (let i = 0, len = parallaxItems.length; i < len; i++) {
    x = x * Number(parallaxItems[i].dataset.parallaxSpeed);
    y = y * Number(parallaxItems[i].dataset.parallaxSpeed);
    parallaxItems[i].style.transform = `translate3d(${x}px, ${y}px, 0px)`;
  }

});

// probar conexión
document.getElementById('btnPing')?.addEventListener('click', async () => {
  try {
    const r = await fetch('http://localhost:3000/api/ping');
    const data = await r.json();
    if (data.ok) {
      alert('✅ ¡Todo bien! La conexión a PostgreSQL es exitosa\nHora del servidor: ' + data.now);
    } else {
      alert('Error al conectar a PostgreSQL:', err.message);
    }
  } catch (e) {
    alert('Error al conectar a PostgreSQL:', err.message);
    console.error(e);
  }
});

// ---- 
// ---- AUTH ----
const API = 'http://localhost:3000';
const isMainPage = !!document.getElementById('login-card'); // solo existe en snoop-menu

function el(id){ return document.getElementById(id); }

function setAuthUI({ logged, nombre_usuario = '', rol = '' }) {
  const btnLogin  = el('btn-login');
  const btnLogout = el('btn-logout');
  const status    = el('login-status');

 
  if (isMainPage) {
    if (btnLogin)  btnLogin.style.display  = 'inline-flex';
    if (btnLogout) btnLogout.style.display = 'none';
    if (status)    status.textContent = logged ? `Sesión: ${nombre_usuario} (${rol})` : '';
    return;
  }

  // en las otras páginas ( o bueno los paneles) sí cambia  por sesión
  if (logged) {
    if (btnLogin)  btnLogin.style.display  = 'none';
    if (btnLogout) btnLogout.style.display = 'inline-flex';
    if (status)    status.textContent = `Sesión: ${nombre_usuario} (${rol})`;
  } else {
    if (btnLogin)  btnLogin.style.display  = 'inline-flex';
    if (btnLogout) btnLogout.style.display = 'none';
    if (status)    status.textContent = '';
  }
}

function getToken(){ return localStorage.getItem('token'); }
function saveSession({ token, rol, nombre_usuario }){
  localStorage.setItem('token', token);
  localStorage.setItem('rol', rol);
  localStorage.setItem('nombre_usuario', nombre_usuario);
  setAuthUI({ logged: true, rol, nombre_usuario });
}
function clearSession(){
  localStorage.removeItem('token');
  localStorage.removeItem('rol');
  localStorage.removeItem('nombre_usuario');
  setAuthUI({ logged: false });
}

//  inicial
setAuthUI({
  logged: !!getToken(),
  rol: localStorage.getItem('rol') || '',
  nombre_usuario: localStorage.getItem('nombre_usuario') || ''
});

// login →  redirige por rol
el('btn-login')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const usuario = el('login-usuario')?.value.trim();
  const pass    = el('login-pass')?.value;
  if (!usuario || !pass) return alert('Ingrese usuario y contraseña');

  const res = await fetch(`${API}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre_usuario: usuario, pass })
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Credenciales inválidas');

  saveSession(data);
  window.location.href = (data.rol === 'gerente') ? './gerente.html' : './empleado.html';
});

// logout 
el('btn-logout')?.addEventListener('click', (e) => {
  e.preventDefault();
  clearSession();
  window.location.href = './snoop-menu.html#login';
});
