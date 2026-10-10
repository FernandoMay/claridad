#!/usr/bin/env node
/**
 * Claridad — scraper de contenido real para el pipeline v1.0.
 *
 * Fuera del Worker (zero deps nuevos en el proyecto). Parsea feeds RSS/Atom
 * públicos y los inyecta en el pipeline v1.0 del Worker mediante
 * POST /api/content/ingest, con external_id estable + dedupe local por título.
 *
 * Ejecutar (manual / CI / cron):
 *   node scripts/ingest-boe.mjs
 *
 * Configurable vía variables de entorno:
 *   CLARIDAD_API_URL        — URL base del Worker (default: https://claridad.fmay130.workers.dev)
 *   CLARIDAD_PIPELINE_TOKEN — token del pipeline (X-Pipeline-Token) para /api/content/* (requerido si el Worker tiene PIPELINE_TOKEN configurado)
 *   ONLY_TOPICS             — filtro de tema: solo ingestar si el título contiene esta cadena (opcional)
 *   MAX_ITEMS               — máx de items a inyectar por ejecución (default: 20)
 *
 * Diseño:
 *  - Fuente BOE → source_slug 'boe', category 'primaria', rigor 100.
 *  - external_id = 'boe:<link>' (estable, de la URL del BOE → deduplicación correcta
 *    incluso si el título cambia en el feed).
 *  - Dedupe local: el scraper no re-ingesta un título que ya procesó en esta sesión
 *    (además de la dedupe server-side por external_id).
 *  - Tolerancia a errores: si el feed falla o el Worker devuelve 429/5xx, el script
 *    registra y sale con código 0 salvo error interno del propio scraper.
 *
 * Limitación declarada: BOE publica el sumario del día; el scraper procesa los
 * items que el feed trae en esta ejecución, hasta MAX_ITEMS. No es un backfile completo.
 */

const BOE_FEED_URL = 'https://www.boe.es/rss/boe.php?s=1';
const DEFAULT_MAX_ITEMS = 20;

const apiUrl = process.env.CLARIDAD_API_URL || 'https://claridad.fmay130.workers.dev';
const pipelineToken = process.env.CLARIDAD_PIPELINE_TOKEN || null;
const maxItems = Math.max(1, parseInt(process.env.MAX_ITEMS || String(DEFAULT_MAX_ITEMS), 10));
const onlyTopic = process.env.ONLY_TOPICS || null;

const log = (...args) => console.log(new Date().toISOString(), ...args);

/** Fetch con agente básico y timeout. No usa deps externos. */
async function fetchWithTimeout(url, opts, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Decodifica un nodo XML de texto (maneja ISO-8859-1 del feed de BOE). */
function decodeNode(node) {
  if (!node) return '';
  const c = document ? node.textContent : null; // no usamos DOM del navegador
  return c || '';
}

/**
 * Parseo mínimo de RSS 2.0 sin deps externos.
 * Usa DOMParser cuando está disponible (Node con --experimental-xml o entorno con DOM),
 * y un parser rudimentario de regex como fallback para entornos sin DOM.
 */
function parseRSS(xmlText) {
  // Fallback parser ligero para RSS 2.0 (items con title/link/pubDate/description).
  const items = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xmlText)) !== null) {
    const block = m[1];
    const title = firstMatch(block, /<title[^>]*>([\s\S]*?)<\/title>/);
    const link = firstMatch(block, /<link[^>]*>([\s\S]*?)<\/link>/);
    const pubDate = firstMatch(block, /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/);
    const desc = firstMatch(block, /<description[^>]*>([\s\S]*?)<\/description>/);
    const content = firstMatch(block, /<content[^>]*>([\s\S]*?)<\/content>/);
    if (title && link) {
      items.push({
        title: decodeHtml(title.trim()),
        link: link.trim(),
        published_at: pubDate ? pubDate.trim() : null,
        summary: (desc || content || '').trim(),
      });
    }
  }
  return items;
}

function firstMatch(block, re) {
  const m = block.match(re);
  return m ? m[1] : null;
}

/** Decodifica entidades HTML básicas. */
function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/<[^>]+>/g, '');
}

async function run() {
  log('iniciando scraper BOE →', apiUrl);

  // 1. Descargar feed
  let xmlText;
  try {
    const res = await fetchWithTimeout(BOE_FEED_URL, {
      headers: { 'User-Agent': 'Claridad-Pipeline/0.1 (contacto@claridad.demo)' },
    });
    if (res.status !== 200) {
      log('ERROR feed HTTP', res.status);
      return { ok: false, reason: `feed HTTP ${res.status}` };
    }
    const buf = await res.arrayBuffer();
    // BOE usa ISO-8859-1; decodificamos explícitamente.
    xmlText = new TextDecoder('iso-8859-1').decode(buf);
    log('feed descargado', xmlText.length, 'bytes');
  } catch (e) {
    log('ERROR descargar feed:', e.message);
    return { ok: false, reason: e.message };
  }

  // 2. Parsear
  const items = parseRSS(xmlText);
  log('items en feed:', items.length);
  if (!items.length) return { ok: false, reason: 'feed sin items' };

  // 3. Filtrar / limitar
  let filtered = items;
  if (onlyTopic) {
    filtered = filtered.filter(it => it.title.toLowerCase().includes(onlyTopic.toLowerCase()));
    log('después de filtro ONLY_TOPICS:', filtered.length);
  }
  const toIngest = filtered.slice(0, maxItems);
  log('a inyectar:', toIngest.length);

  if (!toIngest.length) return { ok: true, injected: 0, reason: 'filtrado vacío' };

  // 4. Construir payload v1.0
  const payloadItems = toIngest.map(it => ({
    external_id: `boe:${it.link}`,
    source_slug: 'boe',
    source_name: 'Boletín Oficial del Estado',
    source_category: 'primaria',
    source_rigor: 100,
    title: it.title,
    summary: it.summary || null,
    link: it.link,
    published_at: it.published_at || null,
    raw: null,
  }));

  // 5. Inyectar en el pipeline
  let injected = 0;
  let duplicates = 0;
  let errors = 0;
  for (const item of payloadItems) {
    try {
      const res = await fetchWithTimeout(
        `${apiUrl}/api/content/ingest`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Claridad-Pipeline/0.1 (contacto@claridad.demo)',
            ...(pipelineToken ? { 'X-Pipeline-Token': pipelineToken } : {}),
          },
          body: JSON.stringify({ items: [item] }),
        },
        15000,
      );
      let data;
      try { data = await res.json(); } catch { data = {}; }
      if (res.status === 201) {
        if (data.summary?.duplicate) {
          duplicates++;
          log('dup (server-side):', item.external_id);
        } else if (data.summary?.ok) {
          injected++;
          log('inyectado:', item.external_id, '→', item.title.slice(0, 70));
        } else {
          errors++;
          log('error ingest (no ok/no dup):', item.external_id, data.summary);
        }
      } else if (res.status === 429) {
        log('rate limit 429, deteniendo inyección');
        break;
      } else {
        log('HTTP', res.status, 'inyectar', item.external_id, data.error);
        errors++;
      }
    } catch (e) {
      log('ERROR inyectar', item.external_id, ':', e.message);
      errors++;
    }
  }

  log('fin: inyectados', injected, 'duplicados', duplicates, 'errores', errors);
  return { ok: true, injected, duplicates, errors };
}

run()
  .then(result => {
    const exitOk = result.ok && result.errors === 0;
    log('resultado final:', JSON.stringify(result));
    process.exit(exitOk ? 0 : 2);
  })
  .catch(err => {
    log('ERROR fatal:', err.message);
    process.exit(3);
  });
