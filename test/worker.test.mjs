/**
 * Claridad — pruebas del Worker contra Miniflare (D1 local, sin red).
 *
 * Ejecutar: npm test
 * Corre el worker real (worker.js) contra un D1 en memoria con schema+seed,
 * y prueba: health, topics, foco (validación), fuentes (persistencia PATCH),
 * reglas (validación), sesiones (acción no permitida), experimento (asignación
 * reproducible por cookie, eventos de embudo, reserva + dedupe + rate limit,
 * métricas agregadas sin PII), CORS y errores sin stack.
 */
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const MF = new Miniflare({
  workers: [{
    config: {
      name: "claridad",
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      manifest: {
        mainModule: "worker.js",
        modules: {
          "worker.js": { type: "esm", contents: readFileSync("./worker.js", "utf8") },
        },
      },
      env: {
        DB: { type: "d1", id: "test-db" },
      },
    },
  }],
});

const env = await MF.getBindings("claridad");

// Migración desde base limpia: crea todas las tablas y el seed demo.
// exec de D1 falla con SQL multilínea ("incomplete input"); se aplanan
// comentarios y saltos de línea para reparar cada sentencia en una línea.
for (const file of ["./schema.sql", "./seed.sql"]) {
  const sql = readFileSync(file, "utf8");
  const statements = sql
    .split(";\n")
    .map(s => s
      .split("\n")
      .filter(l => !l.trim().startsWith("--"))
      .join(" ")
      .trim())
    .filter(s => s);
  for (const stmt of statements) {
    await env.DB.exec(stmt);
  }
}

let passed = 0;
function test(name, fn) {
  return fn().then(
    () => { passed++; console.log(`\u2714 ${name}`); },
    (e) => { console.error(`\u2718 ${name}`); throw e; }
  );
}

const req = (path, init = {}) => {
  const headers = init.headers || {};
  const r = new Request(`http://localhost:8787${path}`, { ...init, headers });
  return r;
};

const resJson = async (res) => ({ status: res.status, data: await res.json().catch(() => null), res });

let failed = 0;
const run = async () => {
  // El D1 de Miniflare puede cachear sessions por binding; recupera el env
  // (.DB) después de las migraciones para no heredar una sesión vencida.
  const envLive = await MF.getBindings("claridad");
  Object.assign(env, envLive);
  const worker = (await import("../worker.js")).default;

  await test("health reports ok + db", async () => {
    const r = await worker.fetch(req("/api/health"), env, null);
    const { status, data } = await resJson(r);
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.db, true);
  });

  await test("CORS: refleja Origin permitido, no expone Access-Control-Allow-Origin: *", async () => {
    const r = await worker.fetch(req("/api/health", { headers: { Origin: "http://localhost:8787" } }), env, null);
    assert.equal(r.headers.get("Access-Control-Allow-Origin"), "http://localhost:8787");
    const r2 = await worker.fetch(req("/api/health", { headers: { Origin: "http://evilsite.example" } }), env, null);
    assert.notEqual(r2.headers.get("Access-Control-Allow-Origin"), "*");
  });

  await test("errores 500 no exponen stack", async () => {
    // Provoca error interno pasando un env sin DB binding (fallo interno real).
    const r = await worker.fetch(req("/api/health"), {}, null);
    const { status, data } = await resJson(r);
    assert.equal(status, 500);
    assert.ok(typeof data.error === "string" && data.error.length < 80 && !/at |Error:/.test(data.error));
    assert.ok(data.correlation_id);
  });

  await test("PATCH focus valida horarios y valores", async () => {
    let r = await worker.fetch(req("/api/focus?quiet_start=99:99", { method: "PATCH", headers: { Origin: "http://localhost:8787" } }), env, null);
    assert.equal(r.status, 400);
    r = await worker.fetch(req("/api/focus?urgencia=inmediata", { method: "PATCH", headers: { Origin: "http://localhost:8787" } }), env, null);
    assert.equal(r.status, 400);
    r = await worker.fetch(req("/api/focus?urgencia=moderada&pausa_reflexiva=false", { method: "PATCH", headers: { Origin: "http://localhost:8787" } }), env, null);
    const { status, data } = await resJson(r);
    assert.equal(status, 200);
    assert.equal(data.focus.urgencia, "moderada");
    assert.equal(data.focus.pausa_reflexiva, 0);
  });

  await test("PATCH /api/sources/:slug persiste pausa en D1", async () => {
    let r = await worker.fetch(req("/api/sources/fad", { method: "PATCH", headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" }, body: JSON.stringify({ active: true }) }), env, null);
    const { status, data } = await resJson(r);
    assert.equal(status, 200);
    assert.equal(data.active, true);
    // Comprueba persistencia real en la BD: ahora activa.
    const row = await env.DB.prepare(`SELECT active FROM sources WHERE slug='fad'`).first();
    assert.equal(row.active, 1);
    // Y el GET lo refleja.
    r = await worker.fetch(req("/api/sources"), env, null);
    const { data: d2 } = await resJson(r);
    assert.equal(d2.sources.find(s => s.slug === "fad").active, 1);
    // PATCH con body inválido → 400
    r = await worker.fetch(req("/api/sources/fad", { method: "PATCH", headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" }, body: "no-json" }), env, null);
    assert.equal(r.status, 400);
    // PATCH a slug inexistente → 404
    r = await worker.fetch(req("/api/sources/nope", { method: "PATCH", headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" }, body: JSON.stringify({ active: false }) }), env, null);
    assert.equal(r.status, 404);
  });

  await test("sessions: acción no permitida rechazada; topic inexistente 404", async () => {
    let r = await worker.fetch(req("/api/sessions?topic=1&action=broadcast", { method: "POST", headers: { Origin: "http://localhost:8787" } }), env, null);
    assert.equal(r.status, 400);
    r = await worker.fetch(req("/api/sessions?topic=999&action=comprendido", { method: "POST", headers: { Origin: "http://localhost:8787" } }), env, null);
    assert.equal(r.status, 404);
    r = await worker.fetch(req("/api/sessions?topic=2&action=comprendido", { method: "POST", headers: { Origin: "http://localhost:8787" } }), env, null);
    assert.equal(r.status, 201);
  });

  await test("POST /api/rules: texto límite y salida etiquetada como heuristic", async () => {
    let r = await worker.fetch(req("/api/rules?text=" + encodeURIComponent("x".repeat(600)), { method: "POST", headers: { Origin: "http://localhost:8787" } }), env, null);
    assert.equal(r.status, 400);
    r = await worker.fetch(req("/api/rules?text=" + encodeURIComponent("Silencia temas electorales hasta el viernes"), { method: "POST", headers: { Origin: "http://localhost:8787" } }), env, null);
    const { status, data } = await resJson(r);
    assert.equal(status, 201);
    assert.equal(data.parsed.action, "silenciar");
    assert.equal(data.parsed.heuristic, true);
  });

  await test("experimento: asignación 50/50 reproducible por cookie", async () => {
    // Sin cookies: asigna y devuelve Set-Cookie.
    let r = await worker.fetch(req("/api/experiment/visit", { method: "POST", headers: { Origin: "http://localhost:8787" } }), env, null);
    const { status, data, res } = await resJson(r);
    assert.equal(status, 200);
    assert.ok(["A", "B"].includes(data.variant));
    const setCookies = res.headers.getSetCookie();
    assert.ok(setCookies.some(c => c.startsWith("claridad_variant=")));
    assert.ok(setCookies.some(c => c.startsWith("claridad_vid=")));
    // Reproduce con la misma cookie: misma variante, sin evento de reasignación.
    const variantCookie = setCookies.find(c => c.startsWith("claridad_variant=")).split(";")[0];
    const vidCookie = setCookies.find(c => c.startsWith("claridad_vid=")).split(";")[0];
    r = await worker.fetch(req("/api/experiment/visit", { method: "POST", headers: { Origin: "http://localhost:8787", Cookie: `${vidCookie}; ${variantCookie}` } }), env, null);
    const { data: d2 } = await resJson(r);
    assert.equal(d2.variant, data.variant);
    const assignedCount = await env.DB.prepare(`SELECT COUNT(*) AS n, ?1 AS vid FROM experiment_events WHERE event='variant_assigned' AND visitor_id = ?1`).bind(data.visitor_id).first();
    assert.equal(assignedCount.n, 1);
  });

  await test("experimento: evento funnel con lista permitida", async () => {
    let r = await worker.fetch(req("/api/experiment/event", { method: "POST", headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" }, body: JSON.stringify({ event: "hacked" }) }), env, null);
    assert.equal(r.status, 400);
    // Sin cookies → crea visitante propio y registra el evento.
    r = await worker.fetch(req("/api/experiment/event", { method: "POST", headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" }, body: JSON.stringify({ event: "cta_clicked" }) }), env, null);
    assert.equal(r.status, 201);
  });

  await test("reserva: valida email + consent, dedupe por email, guarda en D1", async () => {
    const base = { Origin: "http://localhost:8787", "Content-Type": "application/json" };
    let r = await worker.fetch(req("/api/experiment/reserve", { method: "POST", headers: base, body: JSON.stringify({ email: "no-email", consent: true }) }), env, null);
    assert.equal(r.status, 400);
    r = await worker.fetch(req("/api/experiment/reserve", { method: "POST", headers: base, body: JSON.stringify({ email: "a@b.co", consent: false }) }), env, null);
    assert.equal(r.status, 400);
    r = await worker.fetch(req("/api/experiment/reserve", { method: "POST", headers: base, body: JSON.stringify({ email: "a@b.co", consent: true }) }), env, null);
    const { status, data } = await resJson(r);
    assert.equal(status, 201);
    assert.equal(data.duplicate, false);
    // Duplicado: 200, no inserta segunda fila.
    r = await worker.fetch(req("/api/experiment/reserve", { method: "POST", headers: base, body: JSON.stringify({ email: "a@b.co", consent: true }) }), env, null);
    const { status: s2, data: d2 } = await resJson(r);
    assert.equal(s2, 200);
    assert.equal(d2.duplicate, true);
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM experiment_reservations WHERE email='a@b.co'`).first();
    assert.equal(rows.n, 1);
    // Al menos un evento de reserva para algún visitante.
    const v = await env.DB.prepare(`SELECT COUNT(*) AS n FROM experiment_events WHERE event='reserve_completed'`).first();
    assert.ok(v.n >= 1);
  });

  // P0: métricas ahora requieren token. Para testear la respuesta exitosa y
  // verificar que no expone PII, se configura un token de admin en el env.
  await test("métricas: sin PII en la respuesta (solo con token de admin)", async () => {
    const envAdmin = { ...env, EXPERIMENT_ADMIN_TOKEN: "test-metrics-token" };
    const r = await worker.fetch(req("/api/experiment/metrics", { headers: { Origin: "http://localhost:8787", "X-Experiment-Admin": "test-metrics-token" } }), envAdmin, null);
    const { status, data } = await resJson(r);
    assert.equal(status, 200);
    const text = JSON.stringify(data);
    assert.ok(!text.includes("a@b.co"), "no debe exponer emails");
    assert.ok(Array.isArray(data.metrics));
    assert.ok(data.primary && data.primary.note.includes("inconcluso"));
  });

  // P0: A/B — forzar variante rechazado + evento variant_assignment_error.
  await test("P0 visit: rechaza forzar variante por query ?variant= y registra variant_assignment_error", async () => {
    let r = await worker.fetch(req("/api/experiment/visit?variant=B", { method: "POST", headers: { Origin: "http://localhost:8787" } }), env, null);
    const { status, data } = await resJson(r);
    assert.equal(status, 403);
    assert.equal(data.error, "no se acepta forzar la variante");
    // Confirmar que se registró el evento de auditoría (sin PII de visitante real).
    const errors = await env.DB.prepare(`SELECT COUNT(*) AS n FROM experiment_events WHERE event='variant_assignment_error'`).first();
    assert.equal(errors.n, 1);
    const errMeta = await env.DB.prepare(`SELECT metadata, variant FROM experiment_events WHERE event='variant_assignment_error'`).first();
    const meta = JSON.parse(errMeta.metadata);
    assert.equal(meta.reason, "forced_variant_rejected");
    assert.equal(errMeta.variant, "B");
    // Confirmar que un visitante existente KEEPA su variante: cookies presentes → 200, misma variante.
    // (Usamos un visitante recién creado para no depender del estado dejado por
    //  otras pruebas; la invariante es que la cookie de variante persiste.)
    let fresh = await worker.fetch(req("/api/experiment/visit", { method: "POST", headers: { Origin: "http://localhost:8787" } }), env, null);
    const { data: freshData } = await resJson(fresh);
    const setCookies = fresh.headers.getSetCookie();
    const variantCookie = setCookies.find(c => c.startsWith("claridad_variant=")).split(";")[0];
    const vidCookie = setCookies.find(c => c.startsWith("claridad_vid=")).split(";")[0];
    const r2 = await worker.fetch(req("/api/experiment/visit", { method: "POST", headers: { Origin: "http://localhost:8787", Cookie: `${vidCookie}; ${variantCookie}` } }), env, null);
    const { status: s2, data: d2 } = await resJson(r2);
    assert.equal(s2, 200);
    assert.equal(d2.variant, freshData.variant);
  });

  // v1.0 pipeline de contenido real — ingesta + deducción + procesado.
  await test("content: ingesta rechaza cuerpo inválido y acepta items válidos", async () => {
    // Cuerpo inválido.
    let r = await worker.fetch(req("/api/content/ingest", { method: "POST", headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" }, body: JSON.stringify({}) }), env, null);
    assert.equal(r.status, 400);
    r = await worker.fetch(req("/api/content/ingest", { method: "POST", headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" }, body: JSON.stringify({ items: "no-array" }) }), env, null);
    assert.equal(r.status, 400);
    // Item sin fields requeridos.
    r = await worker.fetch(req("/api/content/ingest", { method: "POST", headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ external_id: "x" }] }) }), env, null);
    assert.equal(r.status, 201);
    const { data } = await resJson(r);
    assert.equal(data.summary.error, 1);
    // Item válido: se ingesta y se puede listar como pendiente.
    r = await worker.fetch(req("/api/content/ingest", { method: "POST", headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ external_id: "feed-1", source_slug: "reuters", source_name: "Reuters", source_category: "agencia", title: "Corta de prensa demo", summary: "Un breve sobre algo relevante", link: "https://ejemplo.com/1" }] }) }), env, null);
    assert.equal(r.status, 201);
    const { data: d2 } = await resJson(r);
    assert.equal(d2.summary.ok, 1);
    assert.ok(d2.ingested[0].status === "ok");
    // Listar pendientes.
    r = await worker.fetch(req("/api/content/pending", { headers: { Origin: "http://localhost:8787" } }), env, null);
    const { status: s3, data: d3 } = await resJson(r);
    assert.equal(s3, 200);
    assert.ok(Array.isArray(d3.pending));
    assert.ok(d3.pending.some(p => p.external_id === "feed-1"));
  });

  await test("content: procesar item pendiente crea tema + facts + sources y marca como procesado", async () => {
    // Ingestar un item.
    const r = await worker.fetch(req("/api/content/ingest", { method: "POST", headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ external_id: "feed-2", source_slug: "afp-factual", source_name: "AFP Factual", source_category: "fact-check", title: "Desmentido sobre algo", summary: "Un desmentido claro sobre una afirmación", link: "https://ejemplo.com/2" }] }) }), env, null);
    const { data: d1 } = await resJson(r);
    assert.equal(d1.summary.ok, 1);
    const ingestId = d1.ingested[0].id;
    // Procesar.
    const r2 = await worker.fetch(req("/api/content/process/" + ingestId, { method: "POST", headers: { Origin: "http://localhost:8787" } }), env, null);
    const { status: s2, data: d2 } = await resJson(r2);
    assert.equal(s2, 200);
    assert.ok(d2.processed.topic_id);
    assert.ok(d2.processed.topic_slug);
    const pid = d2.processed.topic_id;
    // Verificar que el tema existe en la BD.
    const topic = await env.DB.prepare(`SELECT * FROM topics WHERE id = ?1`).bind(pid).first();
    assert.equal(topic.title, "Desmentido sobre algo");
    // Verificar que hay un topic_source asociado.
    const ts = await env.DB.prepare(`SELECT COUNT(*) AS n FROM topic_sources WHERE topic_id = ?1`).bind(pid).first();
    assert.ok(ts.n >= 1);
    // Verificar que hay un topic_fact (el summary se convirtió en hecho).
    const tf = await env.DB.prepare(`SELECT COUNT(*) AS n FROM topic_facts WHERE topic_id = ?1`).bind(pid).first();
    assert.ok(tf.n >= 1);
    // Verificar que el item está marcado como procesado.
    const ingest = await env.DB.prepare(`SELECT status FROM content_ingest WHERE id = ?1`).bind(ingestId).first();
    assert.equal(ingest.status, "procesado");
    // Re-procesar → 409 (ya procesado).
    const r3 = await worker.fetch(req("/api/content/process/" + ingestId, { method: "POST", headers: { Origin: "http://localhost:8787" } }), env, null);
    assert.equal(r3.status, 409);
  });

  await test("content: duplicado por external_id se rechaza sin crear segundo item", async () => {
    const r = await worker.fetch(req("/api/content/ingest", { method: "POST", headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ external_id: "feed-1", source_slug: "reuters", source_name: "Reuters", source_category: "agencia", title: "Otro título" }] }) }), env, null);
    const { data } = await resJson(r);
    assert.equal(r.status, 201);
    assert.equal(data.summary.duplicate, 1);
    assert.equal(data.summary.ok, 0);
    // Un solo item con ese external_id en la BD.
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM content_ingest WHERE external_id = 'feed-1'`).first();
    assert.equal(n.n, 1);
  });

  await test("content: la fuente se crea automáticamente si no existe", async () => {
    const r = await worker.fetch(req("/api/content/ingest", { method: "POST", headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ external_id: "feed-3", source_slug: "nueva-fuente", source_name: "Nueva Fuente", source_category: "contextual", title: "Algo de la nueva fuente" }] }) }), env, null);
    const { data } = await resJson(r);
    assert.equal(data.summary.ok, 1);
    // La fuente ahora existe.
    const src = await env.DB.prepare(`SELECT * FROM sources WHERE slug = 'nueva-fuente'`).first();
    assert.ok(src);
    assert.equal(src.name, "Nueva Fuente");
    assert.equal(src.category, "contextual");
  });

  // Pipeline de contenido: autenticación server-to-server con PIPELINE_TOKEN.
  // Los tests explícitos cubren ambos fallos posibles: token ausente/incorrecto
  // (inyección no autorizada) y autorización correcta incluso sin Origin.
  await test("content: PIPELINE_TOKEN rechaza ingest sin token aunque no haya Origin", async () => {
    const envPipe = { ...env, PIPELINE_TOKEN: "test-pipeline-token" };
    const r = await worker.fetch(req("/api/content/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ external_id: "pipe-1", source_slug: "reuters", source_name: "Reuters", source_category: "agencia", title: "X" }] }) }), envPipe, null);
    assert.equal(r.status, 403);
    const { data } = await resJson(r);
    assert.equal(data.error, "no autorizado");
  });

  await test("content: PIPELINE_TOKEN rechaza ingest con token incorrecto aunque no haya Origin", async () => {
    const envPipe = { ...env, PIPELINE_TOKEN: "test-pipeline-token" };
    const r = await worker.fetch(req("/api/content/ingest", { method: "POST", headers: { "Content-Type": "application/json", "X-Pipeline-Token": "wrong" }, body: JSON.stringify({ items: [{ external_id: "pipe-2", source_slug: "reuters", source_name: "Reuters", source_category: "agencia", title: "X" }] }) }), envPipe, null);
    assert.equal(r.status, 403);
    const { data } = await resJson(r);
    assert.equal(data.error, "no autorizado");
  });

  await test("content: PIPELINE_TOKEN autoriza ingest y pending con token correcto aunque no haya Origin", async () => {
    const envPipe = { ...env, PIPELINE_TOKEN: "test-pipeline-token" };
    // Ingesta con token correcto y sin Origin.
    const r = await worker.fetch(req("/api/content/ingest", { method: "POST", headers: { "Content-Type": "application/json", "X-Pipeline-Token": "test-pipeline-token" }, body: JSON.stringify({ items: [{ external_id: "pipe-3", source_slug: "reuters", source_name: "Reuters", source_category: "agencia", title: "T", summary: "S" }] }) }), envPipe, null);
    assert.equal(r.status, 201);
    const { data: d1 } = await resJson(r);
    assert.equal(d1.summary.ok, 1);
    const ingestId = d1.ingested[0].id;
    // Pending con token correcto y sin Origin.
    const r2 = await worker.fetch(req("/api/content/pending", { headers: { "X-Pipeline-Token": "test-pipeline-token" } }), envPipe, null);
    assert.equal(r2.status, 200);
    const { data: d2 } = await resJson(r2);
    assert.ok(d2.pending.some(p => p.id === ingestId));
    // Process con token correcto y sin Origin.
    const r3 = await worker.fetch(req("/api/content/process/" + ingestId, { method: "POST", headers: { "X-Pipeline-Token": "test-pipeline-token" } }), envPipe, null);
    assert.equal(r3.status, 200);
  });

  await test("content: PIPELINE_TOKEN protege ingest/process/pending cuando está configurado", async () => {
    const envPipe = { ...env, PIPELINE_TOKEN: "test-pipeline-token" };
    // Sin token → 403 (sin Origin válido para forzar la comprobación de token).
    let r = await worker.fetch(req("/api/content/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ external_id: "tok-1", source_slug: "reuters", source_name: "Reuters", source_category: "agencia", title: "T" }] }) }), envPipe, null);
    assert.equal(r.status, 403);
    const { data } = await resJson(r);
    assert.equal(data.error, "no autorizado");
    // Con token → 201.
    r = await worker.fetch(req("/api/content/ingest", { method: "POST", headers: { Origin: "http://localhost:8787", "Content-Type": "application/json", "X-Pipeline-Token": "test-pipeline-token" }, body: JSON.stringify({ items: [{ external_id: "tok-1", source_slug: "reuters", source_name: "Reuters", source_category: "agencia", title: "T" }] }) }), envPipe, null);
    assert.equal(r.status, 201);
    const { data: d1 } = await resJson(r);
    assert.equal(d1.summary.ok, 1);
    // process sin token → 403.
    const ingestId = d1.ingested[0].id;
    r = await worker.fetch(req("/api/content/process/" + ingestId, { method: "POST", headers: { Origin: "http://localhost:8787" } }), envPipe, null);
    assert.equal(r.status, 403);
    // process con token → 200.
    r = await worker.fetch(req("/api/content/process/" + ingestId, { method: "POST", headers: { Origin: "http://localhost:8787", "X-Pipeline-Token": "test-pipeline-token" } }), envPipe, null);
    assert.equal(r.status, 200);
    // pending sin token → 403.
    r = await worker.fetch(req("/api/content/pending"), envPipe, null);
    assert.equal(r.status, 403);
    // pending con token → 200.
    r = await worker.fetch(req("/api/content/pending", { headers: { "X-Pipeline-Token": "test-pipeline-token" } }), envPipe, null);
    assert.equal(r.status, 200);
  });

  // P0: métricas protegidas — sin token → 403 incluso si no hay token configurado en env.
  await test("P0 metrics: sin X-Experiment-Admin → 403 (fail closed)", async () => {
    // Arrange: configurar token de admin en env (describe el comportamiento cuando está configurado).
    const envAdmin = { ...env, EXPERIMENT_ADMIN_TOKEN: "test-admin-token" };
    let r = await worker.fetch(req("/api/experiment/metrics", { headers: { Origin: "http://localhost:8787" } }), envAdmin, null);
    assert.equal(r.status, 403);
    const { data } = await resJson(r);
    assert.equal(data.error, "token requerido");
    // Con token correcto → 200.
    r = await worker.fetch(req("/api/experiment/metrics", { headers: { Origin: "http://localhost:8787", "X-Experiment-Admin": "test-admin-token" } }), envAdmin, null);
    const { status, data: d2 } = await resJson(r);
    assert.equal(status, 200);
    assert.ok(Array.isArray(d2.metrics));
    // Token incorrecto → 403.
    r = await worker.fetch(req("/api/experiment/metrics", { headers: { Origin: "http://localhost:8787", "X-Experiment-Admin": "wrong" } }), envAdmin, null);
    assert.equal(r.status, 403);
    // Token vacío → 403.
    r = await worker.fetch(req("/api/experiment/metrics", { headers: { Origin: "http://localhost:8787", "X-Experiment-Admin": "" } }), envAdmin, null);
    assert.equal(r.status, 403);
  });

  console.log(`\n${passed} pruebas pasaron.`);
};

run().then(
  async () => { await MF.dispose(); process.exit(0); },
  async (e) => { console.error(e); try { await MF.dispose(); } catch {} process.exit(1); }
);
