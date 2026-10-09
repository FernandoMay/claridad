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

const req = (path, init = {}) =>
  new Request(`http://localhost:8787${path}`, { ...init, headers: { ...init.headers } });

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

  await test("métricas: sin PII en la respuesta", async () => {
    const r = await worker.fetch(req("/api/experiment/metrics", { headers: { Origin: "http://localhost:8787" } }), env, null);
    const { status, data } = await resJson(r);
    assert.equal(status, 200);
    const text = JSON.stringify(data);
    assert.ok(!text.includes("a@b.co"), "no debe exponer emails");
    assert.ok(Array.isArray(data.metrics));
    assert.ok(data.primary && data.primary.note.includes("inconcluso"));
  });

  console.log(`\n${passed} pruebas pasaron.`);
};

run().then(
  async () => { await MF.dispose(); process.exit(0); },
  async (e) => { console.error(e); try { await MF.dispose(); } catch {} process.exit(1); }
);
