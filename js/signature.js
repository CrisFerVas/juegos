// Firma con el dedo (o el ratón). Devuelve { blob, name } o null si se cancela.

import { modal, toast } from './ui.js';

export function captureSignature({ defaultName = '' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    let drawn = false;
    const { el } = modal({
      title: 'Firmar',
      sheet: true,
      body: `
        <label class="field"><span>Nombre de quien firma *</span><input id="sig-name" name="name" required value="${defaultName.replace(/"/g, '&quot;')}" /></label>
        <div class="sig-pad"><canvas id="sig-canvas" aria-label="Zona de firma"></canvas><span class="sig-line">Firma aquí</span></div>
        <div class="row-gap"><button type="button" class="btn btn-sm" id="sig-clear">Borrar firma</button></div>`,
      submitLabel: 'Guardar firma',
      onSubmit: async (v) => {
        if (!drawn) {
          toast('Dibuja la firma en el recuadro', 'error');
          return false;
        }
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        result = { blob, name: v.name.trim() };
      },
    });
    const canvas = el.querySelector('#sig-canvas');
    const g = canvas.getContext('2d');
    const setup = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.lineWidth = 2.4;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = '#0f172a';
    };
    requestAnimationFrame(setup);
    let last = null;
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      last = pos(e);
      g.beginPath();
      g.arc(last[0], last[1], 1.2, 0, Math.PI * 2);
      g.fillStyle = '#0f172a';
      g.fill();
      drawn = true;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!last) return;
      const p = pos(e);
      g.beginPath();
      g.moveTo(...last);
      g.lineTo(...p);
      g.stroke();
      last = p;
    });
    const end = () => (last = null);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    el.querySelector('#sig-clear').onclick = () => {
      g.clearRect(0, 0, canvas.width, canvas.height);
      drawn = false;
    };
    const obs = new MutationObserver(() => {
      if (!el.isConnected) {
        obs.disconnect();
        resolve(result);
      }
    });
    obs.observe(document.getElementById('modal-root'), { childList: true });
  });
}
