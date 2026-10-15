// Botón "Imprimir" de la etiqueta de envío (el CSP no permite onclick en el HTML).
document.querySelector('[data-print]')?.addEventListener('click', () => window.print());
