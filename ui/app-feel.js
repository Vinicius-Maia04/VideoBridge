'use strict';
/**
 * Faz a página se comportar como um aplicativo, não como uma aba de navegador:
 * sem o menu do botão direito ("Voltar / Atualizar / Salvar como…"), sem atalhos de navegador (recarregar, imprimir,
 * salvar, código-fonte, DevTools, zoom) e sem arrastar imagens. Campos de texto continuam com o menu de copiar/colar.
 */
window.installAppFeel = (doc = document) => {
  const editable = (t) => !!(t && t.closest && t.closest('input,textarea,select,pre,.selectable,[contenteditable="true"]'));
  doc.addEventListener('contextmenu', (e) => { if (!editable(e.target)) e.preventDefault(); });
  doc.addEventListener('keydown', (e) => {
    const k = String(e.key || '').toLowerCase(), c = e.ctrlKey || e.metaKey;
    const browserKey = ['f5', 'f7', 'f12'].includes(k)
      || (c && ['r', 'p', 's', 'u', 'g', 'f', 'o', 'j', 'l', '+', '-', '=', '0'].includes(k))
      || (c && e.shiftKey && ['i', 'j', 'r'].includes(k))
      || (e.altKey && (k === 'arrowleft' || k === 'arrowright'));
    if (browserKey) e.preventDefault();
  }, true);
  doc.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false }); // sem zoom de navegador
  doc.addEventListener('dragstart', (e) => { if (!editable(e.target)) e.preventDefault(); });
};
window.installAppFeel();
