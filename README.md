# Claridad — POC

**Coordinador de atención personal**: un briefing diario, deduplicado y trazable. Menos ruido, más claridad — tu atención sigue siendo tuya.

> Estado: **POC técnica** (Semana 0 del plan de validación de 6 semanas). Implementa el punto de entrada B del estudio de oportunidad: *Briefing personal*, antes del MVP concierge.

## Qué demuestra esta POC

| Hipótesis | Cómo la ejerce la POC |
|---|---|
| **A. Una sola lógica de prioridad** | Cada tema llega con un `status` único: `atención` / `novedad` / `fondo` — independiente de la fuente. |
| **B. Detectar repeticiones** | `dedup_count` por tema: "9 artículos redundantes condensados" en la tarjeta. |
| **C. Saber cuándo revisar** | Horario de entrega sereno + ventana de silencio (Atención), sin push. |
| **D. Confiar en el filtrado** | Cada hecho muestra `confidence` y `verification`; nada se oculta sin trazabilidad. |
| **E. Menos configuración** | Reglas en lenguaje natural (`POST /api/rules?text=...`) en lugar de filtros manuales. |
| **F. Privacidad** | Solo fuentes públicas/primarias en esta fase; sin comunicaciones privadas, sin anuncios. |

## Stack

- **Cloudflare Worker** (`worker.js`) — API HTTP, sin dependencias externas.
- **D1 (SQLite)** (`schema.sql`, `seed.sql`) — fuentes, temas, hechos, trazabilidad, reglas, sesiones.
- **Frontend estático** (`public/`) — 5 pantallas vanilla JS + Tailwind CDN, tokens M3 compartidos.

## Cómo ejecutarlo

```bash
npm install
npm run db:reset:local   # crear tablas + datos demo
npm run dev              # http://localhost:8787
```

## API

| Ruta | Método | Descripción |
|---|---|---|
| `/api/health` | GET | Estado del servicio y de D1 |
| `/api/sources` | GET | Fuentes con rigor y nº de citas |
| `/api/topics` | GET | Temas del día, ordenados por prioridad |
| `/api/topics/:slug` | GET | Ficha completa: hechos + fuentes primarias |
| `/api/rules?text=...` | POST | Regla en lenguaje natural (parser mínimo) |
| `/api/rules` | GET | Reglas registradas |
| `/api/sessions?topic=ID&action=...` | POST | Registro de lectura (métrica de utilidad) |
| `/api/focus` | GET / PATCH | Ventana de silencio, umbral de urgencia |

## Próximos pasos (según el plan de validación)

1. **Semana 1–2** — usar esta POC como apoyo visual en entrevistas, no como demo comercial.
2. **Semana 3** — página de presentación con las dos promesas ("menos interrupciones" / "entiende lo importante en menos tiempo").
3. **Semana 4** — MVP concierge: sincronizar los temas de esta BD con la curación manual real, no al revés.
4. **Automatizar** solo si las semanas 1–3 validan frecuencia del problema e interés.

## Nada en esta POC

- Acceso a notificaciones, correos o mensajería privada (son los obstáculos de permisos descritos en la investigación; no se asumen).
- Login de usuarios: la POC es de un solo usuario de demo para simplificar el ciclo de test.
- IA real de resumen: los temas se cargan curados a mano (`seed.sql`); el parser de reglas es heurístico.
