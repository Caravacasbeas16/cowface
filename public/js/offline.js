// Pantalla sin conexión: "Reintentar" vuelve a la página donde estaba; y si vuelve el internet, recarga sola.
const retry = document.querySelector('[data-retry]');
retry.addEventListener('click', (e) => { e.preventDefault(); window.location.reload(); });
window.addEventListener('online', () => window.location.reload());
