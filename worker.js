/**
 * Claridad — Worker API (Cloudflare Workers, ES modules)
 *
 * Sirve /api/* consultando D1 (env.DB) y hace fallback a env.ASSETS para el
 * frontend estático. Todo el acceso es con SQL parametrizado.
 */

const CORS = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: CORS });

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);

    if (!pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      const body = pathname === "/api/rules" && request.method === "POST"
        ? await parseRule(searchParams.get("text") || "")
        : null;

      switch (true) {
        case pathname === "/api/health":
          return json({
            ok: true,
            service: "claridad",
            edition: "poc",
            db: await env.DB.prepare("SELECT COUNT(*) AS n FROM sources").first().then(r => r.n > 0),
          });

        case pathname === "/api/sources":
          return json({ sources: await allSources(env) });

        case pathname === "/api/topics": {
          const topics = await env.DB.prepare(
            `SELECT id, slug, title, summary, status, edition, priority,
                    dedup_count, sources_count, deadline
               FROM topics ORDER BY priority DESC`
          ).all();
          return json({ topics: topics.results });
        }

        case /^\/api\/topics\/[\w-]+$/.test(pathname): {
          const slug = pathname.split("/").pop();
          const topic = await env.DB.prepare(`SELECT * FROM topics WHERE slug = ?1`).bind(slug).first();
          if (!topic) return json({ error: "tema no encontrado" }, 404);
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
          return json({ topic, facts: facts.results, sources: sources.results });
        }

        case pathname === "/api/rules" && request.method === "POST": {
          if (!body) return json({ error: "instrucción vacía" }, 400);
          await env.DB.prepare(
            `INSERT INTO rules (raw_text, action, target, expires_at) VALUES (?1, ?2, ?3, ?4)`
          ).bind(body.raw, body.action, body.target, body.expires).run();
          return json({ ok: true, parsed: body }, 201);
        }

        case pathname === "/api/rules" && request.method === "GET": {
          const rs = await env.DB.prepare(`SELECT * FROM rules ORDER BY created_at DESC LIMIT 50`).all();
          return json({ rules: rs.results });
        }

        case pathname === "/api/sessions" && request.method === "POST": {
          const topicId = Number(searchParams.get("topic")) || 0;
          const action = searchParams.get("action") || "comprendido";
          if (!topicId) return json({ error: "tema requerido" }, 400);
          await env.DB.prepare(`INSERT INTO reading_sessions (topic_id, action) VALUES (?1, ?2)`)
            .bind(topicId, action).run();
          return json({ ok: true }, 201);
        }

        case pathname === "/api/focus" && request.method === "GET":
          return json({ focus: await env.DB.prepare(`SELECT * FROM focus_settings WHERE id = 1`).first() });

        case pathname === "/api/focus" && request.method === "PATCH": {
          const p = searchParams;
          await env.DB.prepare(
            `UPDATE focus_settings
                SET quiet_start = COALESCE(?2, quiet_start),
                    quiet_end   = COALESCE(?3, quiet_end),
                    urgencia    = COALESCE(?4, urgencia),
                    pausa_reflexiva = COALESCE(?5, pausa_reflexiva),
                    modo_sin_opinion = COALESCE(?6, modo_sin_opinion)
              WHERE id = 1`
          ).bind(p.get("quiet_start"), p.get("quiet_end"), p.get("urgencia"),
                 p.get("pausa_reflexiva"), p.get("modo_sin_opinion")).run();
          return json({ focus: await env.DB.prepare(`SELECT * FROM focus_settings WHERE id = 1`).first() });
        }

        default:
          return json({ error: "ruta no encontrada" }, 404);
      }
    } catch (err) {
      return json({ error: String(err && err.stack || err) }, 500);
    }
  },
};

async function allSources(env) {
  const s = await env.DB.prepare(`SELECT * FROM sources ORDER BY active DESC, name`).all();
  const stats = await env.DB.prepare(
    `SELECT source_id, COUNT(*) AS citado FROM topic_sources GROUP BY source_id`
  ).all();
  const cited = Object.fromEntries(stats.results.map(r => [r.source_id, r.citado]));
  return s.results.map(r => ({ ...r, cited_in_topics: cited[r.id] || 0 }));
}

/** Parser mínimo de reglas en lenguaje natural (POC, sin IA externa). */
function parseRule(text) {
  const t = text.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  const action = lower.includes("silenc") ? "silenciar"
    : lower.includes("avísame") || lower.includes("avisame") || lower.includes("enfatiz") ? "enfatizar"
    : "reprogramar";

  let target = "";
  const m = lower.match(/temas? ([\wáéíóúñü\s]+?)(?:\s+hasta|\s+desde|,|$)/);
  if (m) target = m[1].trim();
  if (!target && action === "silenciar" && lower.includes(" electorales")) target = "electorales";

  const when = t.match(/hasta el (\w+ explode)/i) || t.match(/hasta el (\w+)/i);
  const expires = when ? `hasta ${when[1]}` : null;
  return { raw: t, action, target, expires, explain: `Regla «${action}» sobre «${target || "entrada general"}»` };
}
