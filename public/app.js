/**
 * Claridad — helpers compartidos del frontend (ES module).
 */
export async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export function money(n, cur = "EUR") {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: cur }).format(n);
}

export function qs(sel, root = document) { return root.querySelector(sel); }
export function qsa(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    node.append(c && c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}
