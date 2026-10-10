/**
 * Claridad — Worker API (Cloudflare Workers, ES modules)
 *
 * Sirve /api/* consultando D1 (env.DB) y hace fallback a env.ASSETS para el
 * frontend estático. Todo el acceso es con SQL parametrizado.
 *
 * Integridad (POC → validación de demanda):
 * - Entradas validadas con listas permitidas y límites de longitud.
 * - Errores públicos genéricos + id de correlación; los detalles solo en logs.
 * - CORS restringido: se refleja solo el Host del sitio servido (self) o
 *   orígenes de desarrollo permitidos; nunca `*` en rutas con datos personales.
 * - Estado de fuentes persistible (PATCH /api/sources/:slug) y experimento A/B
 *   con asignación por cookie + eventos server-side en D1.
 */

const JSON_CT = "application/json";
const DEV_ORIGINS = new Set([
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);
const SESSION_ACTIONS = new Set(["comprendido", "guardado", "terminado"]);
const URGENCIA_VALUES = new Set(["todas", "moderada", "severa"]);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CONSENT_VERSION = "v1-demo";
const VARIANT_COOKIE = "claridad_variant";
const VISITOR_COOKIE = "claridad_vid";
const VARIANT_RE = /^[AB]$/;
const FUNNEL_EVENTS = new Set(["cta_clicked", "form_started"]);

/** Headers CORS para el Origin de la petición (self o dev permitido), o ninguno. */
function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  if (DEV_ORIGINS.has(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true",
    };
  }
  const u = new URL(request.url);
  const self = `${u.protocol}//${u.host}`;
  if (origin === self) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true",
    };
  }
  return null;
}

function json(data, status = 200, extraHeaders = null, request = null) {
  const headers = { "Content-Type": JSON_CT };
  if (request) {
    const cors = corsHeaders(request);
    if (cors) Object.assign(headers, cors);
  }
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}

/** Id de correlación público para errores: rastrealable en logs, sin internals. */
function newCorrelationId() {
  return `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function errorResponse(request, status, message, err) {
  const cid = newCorrelationId();
  if (err) {
    console.error(`[claridad] ${cid}`, err && err.stack || err);
  }
  return json({ error: message, correlation_id: cid }, status, null, request);
}

function isValidHHMM(v) { return typeof v === "string" && HHMM.test(v); }

async function allSources(env) {
  const s = await env.DB.prepare(`SELECT * FROM sources ORDER BY active DESC, name`).all();
  const stats = await env.DB.prepare(
    `SELECT source_id, COUNT(*) AS citado FROM topic_sources GROUP BY source_id`
  ).all();
  const cited = Object.fromEntries(stats.results.map(r => [r.source_id, r.citado]));
  return s.results.map(r => ({ ...r, cited_in_topics: cited[r.id] || 0 }));
}

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);

    if (request.method === "OPTIONS") {
      const cors = corsHeaders(request);
      if (!cors) return new Response(null, { status: 204 });
      return new Response(null, { status: 204, headers: cors });
    }

    if (!pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      switch (true) {
        case pathname === "/api/health":
          return json({
            ok: true,
            service: "claridad",
            edition: "poc",
            db: await env.DB.prepare("SELECT COUNT(*) AS n FROM sources").first().then(r => r.n > 0),
          }, 200, null, request);

        case pathname === "/api/sources": {
          const cors = corsHeaders(request);
          if (request.method === "GET") {
            return json({ sources: await allSources(env) }, 200, cors, request);
          }
          return errorResponse(request, 405, "método no permitido");
        }

        // PATCH /api/sources/:slug  body: {"active": boolean}
        case /^\/api\/sources\/[\w-]+$/.test(pathname) && request.method === "PATCH": {
          if (!corsHeaders(request)) return errorResponse(request, 403, "origen no permitido");
          const slug = decodeURIComponent(pathname.split("/").pop());
          let body;
          try { body = await request.json(); } catch { return errorResponse(request, 400, "cuerpo JSON inválido"); }
          if (!body || typeof body !== "object" || typeof body.active !== "boolean") {
            return errorResponse(request, 400, "se requiere {\"active\": boolean}");
          }
          const id = await env.DB.prepare(`SELECT id FROM sources WHERE slug = ?1`).bind(slug).first();
          if (!id) return errorResponse(request, 404, "fuente no encontrada");
          await env.DB.prepare(`UPDATE sources SET active = ?1 WHERE id = ?2`).bind(body.active ? 1 : 0, id.id).run();
          return json({ ok: true, slug, active: body.active }, 200, null, request);
        }

        case pathname === "/api/topics": {
          const topics = await env.DB.prepare(
            `SELECT id, slug, title, summary, status, edition, priority,
                    dedup_count, sources_count, deadline
               FROM topics ORDER BY priority DESC`
          ).all();
          return json({ topics: topics.results }, 200, null, request);
        }

        case /^\/api\/topics\/[\w-]+$/.test(pathname): {
          const slug = decodeURIComponent(pathname.split("/").pop());
          const topic = await env.DB.prepare(`SELECT * FROM topics WHERE slug = ?1`).bind(slug).first();
          if (!topic) return errorResponse(request, 404, "tema no encontrado");
          const [facts, sources] = await Promise.all([
            env.DB.prepare(
              `SELECT kind, label, detail, verification, confidence
                 FROM topic_facts WHERE topic_id = ?1 ORDER BY confidence DESC, id`
            ).bind(topic.id).all(),
            env.DB.prepare(
              `SELECT s.slug, s.name, ts.reference, ts.note
                 FROM topic_sources ts JOIN sources s ON s.id = ts.source_id
                WHERE ts.topic_id = ?1 ORDER BY ts.reference`
            ).bind(topic.id).all(),
          ]);
          return json({ topic, facts: facts.results, sources: sources.results }, 200, null, request);
        }

        case pathname === "/api/rules" && request.method === "POST": {
          if (!corsHeaders(request)) return errorResponse(request, 403, "origen no permitido");
          // Acepta query ?text= (compatibilidad POC) y body JSON {text}.
          let text = searchParams.get("text") || "";
          const b = await request.json().catch(() => null);
          if (b && typeof b.text === "string") text = b.text;
          const parsed = parseRule(text);
          if (!parsed) return errorResponse(request, 400, "instrucción vacía");
          if (text.length > 500) return errorResponse(request, 400, "instrucción demasiado larga (máx 500)");
          await env.DB.prepare(
            `INSERT INTO rules (raw_text, action, target, expires_at) VALUES (?1, ?2, ?3, ?4)`
          ).bind(parsed.raw, parsed.action, parsed.target, parsed.expires).run();
          return json({ ok: true, parsed: { ...parsed, heuristic: true } }, 201, null, request);
        }

        case pathname === "/api/rules" && request.method === "GET": {
          const rs = await env.DB.prepare(`SELECT * FROM rules ORDER BY created_at DESC LIMIT 50`).all();
          return json({ rules: rs.results }, 200, null, request);
        }

        case pathname === "/api/sessions" && request.method === "POST": {
          if (!corsHeaders(request)) return errorResponse(request, 403, "origen no permitido");
          const topicId = Number(searchParams.get("topic")) || 0;
          const action = searchParams.get("action") || "comprendido";
          if (!topicId) return errorResponse(request, 400, "tema requerido");
          if (!SESSION_ACTIONS.has(action)) {
            return errorResponse(request, 400, "acción no permitida (permitidas: comprendido, guardado, terminado)");
          }
          const exists = await env.DB.prepare(`SELECT 1 AS ok FROM topics WHERE id = ?1`).bind(topicId).first();
          if (!exists) return errorResponse(request, 404, "tema no encontrado");
          await env.DB.prepare(`INSERT INTO reading_sessions (topic_id, action) VALUES (?1, ?2)`)
            .bind(topicId, action).run();
          return json({ ok: true }, 201, null, request);
        }

        case pathname === "/api/focus" && request.method === "GET": {
          const focus = await env.DB.prepare(`SELECT * FROM focus_settings WHERE id = 1`).first();
          return json({ focus }, 200, null, request);
        }

        case pathname === "/api/focus" && request.method === "PATCH": {
          if (!corsHeaders(request)) return errorResponse(request, 403, "origen no permitido");
          const p = searchParams;
          const quietStart = p.get("quiet_start");
          const quietEnd = p.get("quiet_end");
          const urgencia = p.get("urgencia");
          const pausa = p.get("pausa_reflexiva");
          const sinOpinion = p.get("modo_sin_opinion");
          if (quietStart !== null && !isValidHHMM(quietStart)) return errorResponse(request, 400, "quiet_start inválido (HH:MM)");
          if (quietEnd !== null && !isValidHHMM(quietEnd)) return errorResponse(request, 400, "quiet_end inválido (HH:MM)");
          if (urgencia !== null && !URGENCIA_VALUES.has(urgencia)) return errorResponse(request, 400, "urgencia inválida");
          const parseBool = (v) => {
            if (v === null) return null;
            if (v === "true" || v === "1") return 1;
            if (v === "false" || v === "0") return 0;
            return NaN;
          };
          const pausaVal = parseBool(pausa);
          const sinOpVal = parseBool(sinOpinion);
          if (Number.isNaN(pausaVal) || Number.isNaN(sinOpVal)) {
            return errorResponse(request, 400, "flags deben ser true|false (o 1|0)");
          }
          await env.DB.prepare(
            `UPDATE focus_settings
                SET quiet_start = COALESCE(?1, quiet_start),
                    quiet_end   = COALESCE(?2, quiet_end),
                    urgencia    = COALESCE(?3, urgencia),
                    pausa_reflexiva = COALESCE(?4, pausa_reflexiva),
                    modo_sin_opinion = COALESCE(?5, modo_sin_opinion)
              WHERE id = 1`
          ).bind(quietStart, quietEnd, urgencia, pausaVal, sinOpVal).run();
          const focus = await env.DB.prepare(`SELECT * FROM focus_settings WHERE id = 1`).first();
          return json({ focus }, 200, null, request);
        }

        // ---------- Experimento A/B (landing de demanda, Semana 3) ----------

        // POST /api/experiment/visit
        // Asigna variante de forma reproducible y persiste el evento de visita
        // server-side. La cookie ancla al visitante a una variante durante el
        // experimento. NO se acepta forzar variante desde el cliente: la ruta
        // rechaza ?variant= explícitamente y registra variant_assignment_error.
        case pathname === "/api/experiment/visit" && request.method === "POST": {
          return await handleVisit(request, env, searchParams);
        }

        // GET /api/experiment/me — variante asignada + id de visitante (server-side source of truth)
        case pathname === "/api/experiment/me" && request.method === "GET": {
          const { vid, variant } = await ensureAssignment(request, env, searchParams);
          return cookieJsonResponse(request, { visitor_id: vid, variant }, assignmentCookies(vid, variant));
        }

        // POST /api/experiment/event  body: {event: 'cta_clicked'|'form_started'}
        // Eventos de embudo generados en el cliente, con lista permitida.
        case pathname === "/api/experiment/event" && request.method === "POST": {
          if (!corsHeaders(request)) return errorResponse(request, 403, "origen no permitido");
          let body;
          try { body = await request.json(); } catch { return errorResponse(request, 400, "cuerpo JSON inválido"); }
          const ev = body && body.event;
          if (!FUNNEL_EVENTS.has(ev)) return errorResponse(request, 400, "evento no permitido");
          const { vid, variant } = await ensureAssignment(request, env, null);
          if (!(await rateLimited(env, `event:${vid}`, 30, 300))) {
            await logEvent(env, vid, variant, ev, {});
          }
          return json({ ok: true }, 201, null, request);
        }

        // POST /api/experiment/reserve  body: {email, consent} — una sola vez por email/visitante.
        case pathname === "/api/experiment/reserve" && request.method === "POST": {
          if (!corsHeaders(request)) return errorResponse(request, 403, "origen no permitido");
          let body;
          try { body = await request.json(); } catch { return errorResponse(request, 400, "cuerpo JSON inválido"); }
          if (!body || typeof body !== "object") return errorResponse(request, 400, "cuerpo JSON inválido");
          const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
          if (!email) return errorResponse(request, 400, "email requerido");
          if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
            return errorResponse(request, 400, "email inválido");
          }
          if (body.consent !== true) {
            return errorResponse(request, 400, "consentimiento explícito requerido (consent=true)");
          }

          // Tasa por email + por IP: evita doble envío y abuso básico.
          const ip = request.headers.get("CF-Connecting-IP") || "local";
          if (await rateLimited(env, `reserve:${email}`, 3, 300) ||
              await rateLimited(env, `reserve-ip:${ip}`, 15, 300)) {
            return errorResponse(request, 429, "demasiadas solicitudes; intenta más tarde");
          }

          const { vid, variant } = await ensureAssignment(request, env, null);
          if (!variant) return errorResponse(request, 400, "falta asignación de variante");

          // Duplicado: mismo email ya reservó → devolver su variante sin reinsertar.
          const dup = await env.DB.prepare(
            `SELECT id, variant FROM experiment_reservations WHERE email = ?1`
          ).bind(email).first();
          if (dup) {
            return json({ ok: true, duplicate: true, variant: dup.variant, reservation_id: dup.id }, 200, null, request);
          }
          const r = await env.DB.prepare(
            `INSERT INTO experiment_reservations (email, variant, visitor_id, consent_version)
             VALUES (?1, ?2, ?3, ?4)`
          ).bind(email, variant, vid, CONSENT_VERSION).run();
          await logEvent(env, vid, variant, "reserve_completed", { reservation_id: r.meta.last_row_id });
          return json({ ok: true, duplicate: false, variant, reservation_id: r.meta.last_row_id }, 201, null, request);
        }

        // GET /api/experiment/metrics — embudo por variante (agregado, sin PII).
        // P0: solo accesible cuando hay token de administrador configurado, y
        // siempre lo exige. Si EXPERIMENT_ADMIN_TOKEN está configurado y falta
        // o no coincide → 403 sin exponer detalles.
        case pathname === "/api/experiment/metrics" && request.method === "GET": {
          if (!corsHeaders(request)) return errorResponse(request, 403, "origen no permitido");
          const admin = request.headers.get("X-Experiment-Admin");
          if (!env.EXPERIMENT_ADMIN_TOKEN) {
            return errorResponse(request, 403, "métricas no disponibles");
          }
          if (admin !== env.EXPERIMENT_ADMIN_TOKEN) {
            return errorResponse(request, 403, "token requerido");
          }
          const m = await env.DB.prepare(
            `WITH visits AS (
               SELECT visitor_id, MAX(variant) AS variant,
                      MAX(CASE WHEN event = 'visit' THEN 1 ELSE 0 END) AS visited,
                      MAX(CASE WHEN event = 'cta_clicked' THEN 1 ELSE 0 END) AS clicked,
                      MAX(CASE WHEN event = 'form_started' THEN 1 ELSE 0 END) AS form_started,
                      MAX(CASE WHEN event = 'reserve_completed' THEN 1 ELSE 0 END) AS reserved
                 FROM experiment_events GROUP BY visitor_id
             )
             SELECT variant,
                    COUNT(*) AS visitors,
                    SUM(visited) AS visits,
                    SUM(clicked) AS cta_clicked,
                    SUM(form_started) AS form_started,
                    SUM(reserved) AS reserved
               FROM visits GROUP BY variant ORDER BY variant`
          ).all();
          const rows = m.results.map(r => ({
            variant: r.variant,
            visitors: r.visitors || 0,
            visits: r.visits || 0,
            cta_clicked: r.cta_clicked || 0,
            form_started: r.form_started || 0,
            reserved: r.reserved || 0,
            conversion: r.visitors ? +(r.reserved / r.visitors * 100).toFixed(1) : 0,
          }));
          const funnelMeta = {
            metric: "tasa de reserva por visitante único",
            note: "no declarar ganadora con muestra insuficiente; resultado puede ser inconcluso",
          };
          return json({ metrics: rows, primary: funnelMeta }, 200, null, request);
        }

        // ---------- Pipeline de contenido real (v1.0) ----------
        // POST /api/content/ingest — recibe contenido estructurado desde fuera del
        // Worker (CI/curator/scraper) y lo persiste para procesamiento controlado:
        // deducción por título+fuente, enriquecimiento básico, asociación a fuentes.
        // Protegido por PIPELINE_TOKEN (server-to-server, sin datos personales).
        // El token se exige siempre que esté configurado, independientemente del Origin.
        // Cuerpo: { items: [ { external_id, source_slug, source_name,
        //   source_category, source_rigor?, title, summary?, link?, published_at?,
        //   raw? } ... ] }
        case pathname === "/api/content/ingest" && request.method === "POST": {
          if (env.PIPELINE_TOKEN) {
            if (request.headers.get("X-Pipeline-Token") !== env.PIPELINE_TOKEN) {
              return errorResponse(request, 403, "no autorizado");
            }
          } else if (!corsHeaders(request)) {
            return errorResponse(request, 403, "origen no permitido");
          }
          let body;
          try { body = await request.json(); } catch { return errorResponse(request, 400, "cuerpo JSON inválido"); }
          if (!body || typeof body !== "object" || !Array.isArray(body.items)) {
            return errorResponse(request, 400, "se requiere { items: [...] }");
          }
          if (body.items.length > 200) return errorResponse(request, 400, "demasiados items (máx 200)");
          const results = [];
          for (const item of body.items) {
            const r = await ingestItem(env, item);
            results.push(r);
          }
          const ok = results.filter(r => r.status === "ok").length;
          const dup = results.filter(r => r.status === "duplicate").length;
          const err = results.filter(r => r.status === "error").length;
          return json({ ingested: results, summary: { ok, duplicate: dup, error: err } }, 201, null, request);
        }

        // GET /api/content/pending — items pendientes de procesado (para revisión).
        // Igual que ingest: protegido por PIPELINE_TOKEN cuando está configurado.
        case pathname === "/api/content/pending" && request.method === "GET": {
          if (env.PIPELINE_TOKEN) {
            if (request.headers.get("X-Pipeline-Token") !== env.PIPELINE_TOKEN) {
              return errorResponse(request, 403, "no autorizado");
            }
          } else if (!corsHeaders(request)) {
            return errorResponse(request, 403, "origen no permitido");
          }
          const pending = await env.DB.prepare(
            `SELECT id, external_id, source_slug, source_name, title, summary, link, published_at, status, note, created_at
               FROM content_ingest WHERE status = 'pendiente' ORDER BY created_at LIMIT 100`
          ).all();
          return json({ pending: pending.results }, 200, null, request);
        }

        // POST /api/content/process/:id — procesa un item pendiente: deduplica,
        // crea/updates topic+facts+sources, marca como procesado.
        // Protegido por PIPELINE_TOKEN cuando está configurado.
        case /^\/api\/content\/process\/[\w-]+$/.test(pathname) && request.method === "POST": {
          if (env.PIPELINE_TOKEN) {
            if (request.headers.get("X-Pipeline-Token") !== env.PIPELINE_TOKEN) {
              return errorResponse(request, 403, "no autorizado");
            }
          } else if (!corsHeaders(request)) {
            return errorResponse(request, 403, "origen no permitido");
          }
          const id = decodeURIComponent(pathname.split("/").pop());
          const row = await env.DB.prepare(`SELECT * FROM content_ingest WHERE id = ?1`).bind(id).first();
          if (!row) return errorResponse(request, 404, "item no encontrado");
          if (row.status !== "pendiente") return errorResponse(request, 409, "item ya procesado o descartado");
          const processed = await processIngestItem(env, row);
          return json({ processed }, 200, null, request);
        }

        default:
          return errorResponse(request, 404, "ruta no encontrada");
    }
    } catch (err) {
      return errorResponse(request, 500, "error interno", err);
    }
  },
};

/** Post/Get del funnel por evento, reutilizado por la landing y la reserva. */
async function logEvent(env, vid, variant, event, extra = {}) {
  await env.DB.prepare(
    `INSERT INTO experiment_events (visitor_id, variant, event, metadata)
     VALUES (?1, ?2, ?3, ?4)`
  ).bind(vid, variant, event, extra && Object.keys(extra).length ? JSON.stringify(extra) : null).run();
}

/** Registra un intento de asignación de variante no permitido (auditoría P0).
 * `variant` debe ser 'A' o 'B' (la variante que se intentó forzar o la del
 * visitante, según corresponda) para cumplir el CHECK de experiment_events.
 */
async function logVariantAssignmentError(env, vid, variant, reason, extra = {}) {
  await logEvent(env, vid || "v_unknown", variant, "variant_assignment_error", { reason, ...extra });
}

/** Respuesta JSON con Set-Cookie (una por cookie) + CORS correcto. */
function cookieJsonResponse(request, data, cookies, status = 200) {
  const headers = new Headers({ "Content-Type": JSON_CT });
  const cors = corsHeaders(request);
  if (cors) for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  for (const c of cookies) headers.append("Set-Cookie", toSetCookie(c));
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}

function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > -1 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

function assignmentCookies(vid, variant) {
  const attrs = "; Path=/; Max-Age=180*24*3600; SameSite=Lax";
  return [
    { name: VISITOR_COOKIE, value: vid, attrs },
    { name: VARIANT_COOKIE, value: variant || "A", attrs },
  ];
}

function toSetCookie(c) {
  return `${c.name}=${c.value}${c.attrs}`;
}

/** Garantiza visitor_id + variante, reutilizando cookies si son válidas.
 * NOTA: las rutas que llaman a esta función son responsables de aplicar la
 * política de forzado de variante. Por defecto, ?variant= se IGNORA aquí (no
 * se usa para cambiar la variante), para que cada endpoint pueda decidir su
 * política sin contaminar el experimento.
 */
async function ensureAssignment(request, env, searchParams) {
  const forced = searchParams?.get("variant");
  // Se recoge para auditoría, pero NO se aplica como variante aquí.
  const forcedPresent = forced && VARIANT_RE.test(forced);
  let vid = getCookie(request, VISITOR_COOKIE);
  let variant = getCookie(request, VARIANT_COOKIE);
  let stale = false;
  if (vid && !/^v_[\w-]{8,64}$/.test(vid)) { vid = null; stale = true; }
  if (variant && !VARIANT_RE.test(variant)) { variant = null; stale = true; }
  // IMPORTANTE: no aplicar forced aquí; cada endpoint aplica su política.
  if (vid && variant) return { vid, variant, stale, forcedPresent };

  if (!vid) vid = `v_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  if (!variant) {
    // Asignación reproducible: hash del visitor_id → A/B 50/50.
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(vid));
    const byte = new Uint8Array(buf)[0];
    variant = byte < 128 ? "A" : "B";
  }
  // Persistir la asignación server-side para el funnel + auditoría.
  await logEvent(env, vid, variant, "variant_assigned", { forced: false });
  return { vid, variant, stale, forcedPresent };
}

/** POST /api/experiment/visit: registra visita y devuelve variante + cookies.
 * Política P0: es idempotente y rechaza cualquier intento de forzar la variante
 * por parte del cliente (query ?variant=, cabeceras inventadas, etc.). Cuando se
 * detecta un intento, se registra variant_assignment_error y se devuelve 403.
 */
async function handleVisit(request, env, searchParams) {
  if (!corsHeaders(request)) return errorResponse(request, 403, "origen no permitido");

  // P0: rechazar forzado de variante desde el cliente.
  const forcedParam = searchParams?.get("variant");
  if (forcedParam && VARIANT_RE.test(forcedParam)) {
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    // Usamos la variante forzada como variante registrada (es 'A' o 'B') y
    // el visitante existente si lo tiene, o un id de sonda anónimo.
    const vid = getCookie(request, VISITOR_COOKIE) || `v_${ip}_forced_probe`;
    await logVariantAssignmentError(env, vid, forcedParam, "forced_variant_rejected", {
      ua: (request.headers.get("User-Agent") || "").slice(0, 120),
    });
    return errorResponse(request, 403, "no se acepta forzar la variante");
  }

  const { vid, variant, stale } = await ensureAssignment(request, env, null);
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  if (await rateLimited(env, `visit-ip:${ip}`, 60, 60)) {
    return errorResponse(request, 429, "demasiadas visitas; intenta más tarde");
  }
  if (!stale) {
    await logEvent(env, vid, variant, "visit", { ua: (request.headers.get("User-Agent") || "").slice(0, 120) });
  }
  const setCookieHeaders = assignmentCookies(vid, variant).map(toSetCookie);
  const headers = new Headers({ "Content-Type": JSON_CT });
  const cors = corsHeaders(request);
  if (cors) Object.assign(headers, cors);
  for (const sc of setCookieHeaders) headers.append("Set-Cookie", sc);
  return new Response(JSON.stringify({ ok: true, visitor_id: vid, variant }, null, 2), { status: 200, headers });
}

/** Rate limit simple con D1 (para POC/experimento; KV/DO en producción real). */
async function rateLimited(env, key, max, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`DELETE FROM rate_limit WHERE window_start < ?1`).bind(now - windowSec).run();
  const row = await env.DB.prepare(
    `SELECT count, window_start FROM rate_limit WHERE key = ?1 AND window_start >= ?2`
  ).bind(key, now - windowSec).first();
  if (!row) {
    await env.DB.prepare(
      `INSERT INTO rate_limit (key, window_start, count) VALUES (?1, ?2, 1)
         ON CONFLICT(key) DO UPDATE SET count = count + 1`
    ).bind(key, now).run();
  } else {
    await env.DB.prepare(
      `UPDATE rate_limit SET count = count + 1 WHERE key = ?1 AND window_start = ?2`
    ).bind(key, row.window_start).run();
  }
  const current = (row ? row.count : 0) + 1;
  return current > max;
}

/** Genera un slug ASCII a partir de un título: lowercase, sin acentos,
 * sin caracteres no alfanuméricos salvo guiones, truncado a 80 caracteres.
 * Las colisiones se resuelven con un sufijo numérico cuando sea necesario.
 */
function slugify(title, existing) {
  const base = title
    .normalize("NFD").replace(/\p{Mn}/gu, "")           // quitar acentos
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")                       // dejar solo letras, dígitos, espacios, guiones
    .replace(/\s+/g, "-").replace(/-+/g, "-").trim()    // espacios → guiones, colapsar
    .slice(0, 80);
  if (!base) return " tema-" + Date.now().toString(36);
  const set = new Set(existing || []);
  let candidate = base;
  let i = 1;
  while (set.has(candidate)) {
    candidate = base.slice(0, 75 - String(i).length) + "-" + i;
    i++;
  }
  return candidate;
}

/** Persiste un item de ingesta (o lo marca como duplicado si ya existe). */
async function ingestItem(env, item) {
  if (!item || typeof item !== "object") return { status: "error", reason: "item inválido" };
  const external_id = typeof item.external_id === "string" ? item.external_id.trim() : "";
  if (!external_id) return { status: "error", reason: "external_id requerido" };
  const source_slug = typeof item.source_slug === "string" ? item.source_slug.trim() : "";
  if (!source_slug) return { status: "error", reason: "source_slug requerido" };
  const source_name = typeof item.source_name === "string" ? item.source_name.trim() : "";
  if (!source_name) return { status: "error", reason: "source_name requerido" };
  const source_category = typeof item.source_category === "string" ? item.source_category.trim() : "";
  if (!source_category || !new Set(["agencia", "fact-check", "primaria", "contextual"]).has(source_category)) {
    return { status: "error", reason: "source_category inválida" };
  }
  const title = typeof item.title === "string" ? item.title.trim() : "";
  if (!title) return { status: "error", reason: "title requerido" };
  const source_rigor = typeof item.source_rigor === "number" ? Math.max(0, Math.min(100, item.source_rigor)) : 90;

  // Asegurar que la fuente existe (la crea con rigor declarado si no está).
  const src = await env.DB.prepare(`SELECT id, slug, active, rigor FROM sources WHERE slug = ?1`).bind(source_slug).first();
  if (!src) {
    try {
      await env.DB.prepare(`INSERT INTO sources (slug, name, category, description, active, rigor) VALUES (?1, ?2, ?3, ?4, 1, ?5)`)
        .bind(source_slug, source_name, source_category, `Fuente añadida por pipeline de contenido ${new Date().toISOString().slice(0, 10)}`, source_rigor).run();
    } catch (e) {
      // Colisión de slug concurrente: re-leer.
      const src2 = await env.DB.prepare(`SELECT id, slug, active, rigor FROM sources WHERE slug = ?1`).bind(source_slug).first();
      if (!src2) return { status: "error", reason: "no se pudo crear la fuente" };
    }
  }

  // Duplicado: mism external_id already ingested.
  const existing = await env.DB.prepare(`SELECT id, status FROM content_ingest WHERE external_id = ?1`).bind(external_id).first();
  if (existing) {
    return { status: "duplicate", existing_id: existing.id, existing_status: existing.status };
  }

  const r = await env.DB.prepare(`INSERT INTO content_ingest (external_id, source_slug, source_name, source_category, source_rigor, title, summary, link, published_at, raw)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
    .bind(external_id, source_slug, source_name, source_category, source_rigor, title, item.summary || null, item.link || null, item.published_at || null, item.raw || null).run();
  return { status: "ok", id: r.meta.last_row_id };
}

/** Procesa un item pendiente de content_ingest: deduplica contra temas existentes
 * por título+fuente, crea o actualiza el tema, añade facts y sources, y marca
 * el item como procesado. Es el núcleo del pipeline de contenido real.
 */
async function processIngestItem(env, item) {
  // Filtrar ítems genéricos: el sumario diario del BOE no es un tema legible.
  if (/^sumario/i.test(item.title || "")) {
    await env.DB.prepare(`UPDATE content_ingest SET status = 'descartado', note = 'item genérico: sumario del diario' WHERE id = ?1`).bind(item.id).run();
    return { skipped: true, reason: "item genérico (sumario): descartado" };
  }

  // Deduplicación: buscar tema existente con título similar + misma fuente.
  const existing = await env.DB.prepare(
    `SELECT t.id, t.slug, t.title
       FROM topics t
       JOIN topic_sources ts ON ts.topic_id = t.id
       JOIN sources s ON s.id = ts.source_id
      WHERE s.slug = ?1 AND t.title = ?2`
  ).bind(item.source_slug, item.title).first();

  let topicId, topicSlug;
  if (existing) {
    topicId = existing.id;
    topicSlug = existing.slug;
  } else {
    // Generar slug único.
    const existingSlugs = await env.DB.prepare(`SELECT slug FROM topics`).all();
    const slug = slugify(item.title, existingSlugs.results.map(r => r.slug));
    const summary = item.summary || item.title;
    const now = new Date().toISOString().slice(0, 10);
    const tr = await env.DB.prepare(
      `INSERT INTO topics (slug, title, summary, status, edition, priority, deadline, created_at) VALUES (?1, ?2, ?3, 'nuevo', 'matutina', 50, ?4, ?5)`
    ).bind(slug, item.title, summary, item.published_at ? item.published_at.slice(0, 10) : null, now).run();
    topicId = tr.meta.last_row_id;
    topicSlug = slug;
  }

  // Asegurar la relación topic_sources (la fuente ya existe por ingestItem).
  const src = await env.DB.prepare(`SELECT id FROM sources WHERE slug = ?1`).bind(item.source_slug).first();
  await env.DB.prepare(`INSERT OR IGNORE INTO topic_sources (topic_id, source_id, reference, note) VALUES (?1, ?2, ?3, ?4)`)
    .bind(topicId, src.id, `ingest-${item.external_id}`, item.source_name).run();

  // Si el item trae un summary, registrar como hecho de tipo 'hecho'.
  if (item.summary && item.summary !== item.title) {
    await env.DB.prepare(
      `INSERT INTO topic_facts (topic_id, kind, label, detail, verification, confidence) VALUES (?1, 'hecho', 'Resumen de la fuente', ?2, ?3, ?4)`
    ).bind(topicId, item.summary, `Fuente: ${item.source_name} (${item.source_category})`, confidenceForCategory(item.source_category)).run();
  }

  // Marcar item como procesado.
  await env.DB.prepare(`UPDATE content_ingest SET status = 'procesado' WHERE id = ?1`).bind(item.id).run();

  return { topic_id: topicId, topic_slug: topicSlug, source_slug: item.source_slug };
}

/** Nivel de confianza básico derivado de la categoría de la fuente (enriquecimiento
 * simple, sin verificación de primaria real; la UI siempre debe etiquetar como demo
 * hasta que haya verificación humana).
 */
function confidenceForCategory(category) {
  return category === "primaria" ? "alta" : category === "fact-check" ? "alta" : category === "agencia" ? "media" : "media";
}

/** Parser mínimo de reglas en lenguaje natural (POC, sin IA externa). */
function parseRule(text) {
  const t = (text || "").trim();
  if (!t) return null;
  if (t.length > 500) return null;
  const lower = t.toLowerCase();
  const action = lower.includes("silenc") ? "silenciar"
    : lower.includes("avísame") || lower.includes("avisame") || lower.includes("enfatiz") ? "enfatizar"
    : "reprogramar";
  let target = "";
  const m = lower.match(/temas? ([\wáéíóúñü\s]+?)(?:\s+hasta|\s+desde|,|$)/);
  if (m) target = m[1].trim();
  if (!target && action === "silenciar" && lower.includes(" electorales")) target = "electorales";
  const when = t.match(/hasta el (\w+)/i);
  const expires = when ? `hasta ${when[1]}` : null;
  return { raw: t, action, target, expires, explain: `Regla «${action}» sobre «${target || "entrada general"}»` };
}
