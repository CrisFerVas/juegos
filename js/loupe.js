// Lupa para dibujar con el dedo: muestra ampliada la zona que tapa el dedo, con una cruz en el punto
// exacto del trazo. Se coloca encima del dedo (o a un lado si no cabe) y no recibe toques.
// Contenido: la misma imagen del plano/foto y las anotaciones en vivo mediante <use> de SVG
// (referencias a los grupos de la capa de anotaciones, así se ve también el trazo que se está haciendo).

const SVGNS = 'http://www.w3.org/2000/svg';
const SIZE = 132; // diámetro en px de pantalla
const ZOOM = 2.5; // aumento respecto a lo que se ve en pantalla
const GAP = 70; // distancia del centro de la lupa al dedo
let seq = 0;

/**
 * @param img   imagen base (se usa su src)
 * @param svg   capa de anotaciones (svg.markups, con viewBox en píxeles del plano)
 * @param W, H  tamaño del plano/foto en píxeles
 * @param bounds () => DOMRect de la zona de dibujo (para no salirse)
 * @param getHires () => lienzo nítido del PDF de la zona visible (opcional), para que la lupa no se vea borrosa
 */
export function createLoupe({ img, svg, W, H, bounds, getHires = () => null }) {
  // Identificadores para poder referenciar los grupos de anotaciones con <use>
  const groups = [...svg.children].filter((g) => g.tagName.toLowerCase() === 'g' && !g.classList.contains('markups-sel'));
  const refs = groups.map((g) => g.id || (g.id = `loupe-g${++seq}`));

  const el = document.createElement('div');
  el.className = 'loupe hidden';
  el.setAttribute('aria-hidden', 'true');
  const inner = document.createElement('div');
  inner.className = 'loupe-inner';
  Object.assign(inner.style, { width: `${W}px`, height: `${H}px` });
  const pic = document.createElement('img');
  pic.alt = '';
  pic.draggable = false;
  const layer = document.createElementNS(SVGNS, 'svg');
  layer.setAttribute('viewBox', `0 0 ${W} ${H}`);
  layer.setAttribute('class', 'loupe-svg');
  for (const id of refs) {
    const use = document.createElementNS(SVGNS, 'use');
    use.setAttribute('href', `#${id}`);
    layer.appendChild(use);
  }
  const sharp = document.createElement('canvas'); // copia del lienzo nítido del PDF
  sharp.className = 'loupe-sharp';
  let sharpFrom = null;
  inner.append(pic, sharp, layer);
  el.append(inner);
  el.insertAdjacentHTML('beforeend', '<span class="loupe-cross"></span>');
  document.body.appendChild(el);

  return {
    /** Muestra la lupa para el dedo en (cx, cy) de pantalla, sobre el punto (px, py) del plano en píxeles. */
    show(cx, cy, px, py, screenScale) {
      if (!pic.getAttribute('src')) pic.src = img.currentSrc || img.src;
      const hi = getHires();
      if (hi !== sharpFrom) {
        sharpFrom = hi;
        if (hi?.width) {
          sharp.width = hi.width;
          sharp.height = hi.height;
          sharp.getContext('2d').drawImage(hi, 0, 0);
          Object.assign(sharp.style, { display: 'block', left: hi.style.left, top: hi.style.top, width: hi.style.width, height: hi.style.height });
        } else sharp.style.display = 'none';
      }
      const s = screenScale * ZOOM;
      inner.style.transform = `translate(${SIZE / 2 - px * s}px, ${SIZE / 2 - py * s}px) scale(${s})`;
      // Posición: encima del dedo; si no cabe, a un lado
      const r = bounds?.() || { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      let x = cx, y = cy - GAP - SIZE / 2;
      if (y - SIZE / 2 < r.top + 4) {
        y = Math.max(r.top + SIZE / 2 + 4, cy - SIZE / 2);
        x = cx + (cx < (r.left + r.right) / 2 ? 1 : -1) * (GAP + SIZE / 2);
      }
      x = Math.min(r.right - SIZE / 2 - 4, Math.max(r.left + SIZE / 2 + 4, x));
      el.style.left = `${x - SIZE / 2}px`;
      el.style.top = `${y - SIZE / 2}px`;
      el.classList.remove('hidden');
    },
    hide() {
      el.classList.add('hidden');
    },
    destroy() {
      el.remove();
    },
  };
}
