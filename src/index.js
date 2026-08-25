/**
 * ════════════════════════════════════════════════════════════════
 *  PORTAL BETA — Cloudflare Worker v2.0
 *  URL: https://portalbeta.betayazmingps.workers.dev
 *
 *  MEJORAS v2.0:
 *    ✅ Caché de /listar (60 seg en KV — evita llamar Sheets en cada visita)
 *    ✅ Rate limiting en /enviar_otp (máx 3 OTPs por email cada 10 min)
 *    ✅ /subir_docs responde inmediato (fire-and-forget, no bloquea al usuario)
 *    ✅ /notificar con reintento automático (3 intentos antes de fallar)
 *    ✅ /sheet con retry (3 intentos con backoff exponencial)
 *
 *  VARIABLES DE ENTORNO (Cloudflare → Ajustes → Variables y Secretos):
 *    ANTHROPIC_API_KEY   → sk-ant-...
 *    ANALISTAS_JSON      → {"NORTE":{"pass":"..."},...}
 *    RESEND_API_KEY      → re_...  (opcional)
 *    EMAIL_FROM          → Portal Beta <noreply@betaagroindustrial.com>
 *    OTP_STORE           → KV Namespace binding
 * ════════════════════════════════════════════════════════════════
 */

const FLOWS = {
  verificar_ruc:  'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/d404ad4b46dd4868a0ac28d09ffe0a0f/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=E4aB_yIFWw5zuisDBfPGyQ7JfZUb0YMzPajUMEZCFA0',
  registrar:      'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/1e3f6e1392b94114b1043c46d7ef9457/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=uFn4ZxYV5zhpK__chBgkOSlELJBo1ZwClMWkdulujv4',
  notificar:      'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/1e3f6e1392b94114b1043c46d7ef9457/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=uFn4ZxYV5zhpK__chBgkOSlELJBo1ZwClMWkdulujv4',
  subir_solicitud: 'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/8d80774c31d447c78285eca11ff35b6d/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=L3xNLDMVL931k3hM6C5vr2HcERzBnzRvdCGSrUCDUQk',
  enviar_otp:     'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/1c54e0b04c02472e9bf12b3d5178991f/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=0AGZNDg042ZaeupocYn-OKgDLZEg8LIz3nvBu-eBkE0',
  verificar_otp:  'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/be4d3dc86fee423ca46acef1e9846cf1/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=n4IRLz3NSael_eU0Qb2uNdhB2PBHJu8Oki0m_B4ki2w',
  subir_docs:     'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/85ac7787b26e4b3fb69ddb35ab808e73/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=01yjHllYz61knBWikJE7kD4l0ibwkMzWFOwWFAnlS2M',
  crear_carpetas: 'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/0551ca704ec54eeba3e74688050ec1b2/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=U120mc4DgsEBm5HF-k4UbVrMQBru0wLS11tGnID0htk',
};

const GSHEET_URL = 'https://script.google.com/macros/s/AKfycbxJugvYb3C_GA_TQuehnrk0U_G5_ckCbbF5emKWhDmgrVal6tuaQHtx733VNKZzGxSuGQ/exec';

// Modelo de Claude para validación de documentos
// Haiku 4.5: ~5x más barato que Sonnet, ideal para validar docs estándar (~$12/año vs $60/año en 200 proveedores)
const MODELO_IA = 'claude-sonnet-4-6';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST')   return resp({ error: 'Solo POST' }, 405);

    const path = new URL(request.url).pathname.replace(/^\/+|\/+$/g, '');
    let body = {}, rawBody = '';
    try { rawBody = await request.text(); body = JSON.parse(rawBody); } catch {}

    try {

      // ══════════════════════════════════════════════════════════
      //  🔐 LOGIN ANALISTA
      //  Valida credenciales sin exponer contraseñas en el frontend
      // ══════════════════════════════════════════════════════════
      if (path === 'login_analista') {
        const { analista, pass } = body;
        if (!analista || !pass) return resp({ ok: false, error: 'Datos incompletos' }, 400);

        let auth = {};
        try { auth = JSON.parse(env.ANALISTAS_JSON || '{}'); } catch {}

        const entrada = auth[analista];
        if (!entrada || entrada.pass !== pass)
          return resp({ ok: false, error: 'Contraseña incorrecta.' }, 401);

        return resp({ ok: true, nombre: entrada.nombre || analista, esAdmin: analista === 'ADMIN' });
      }

      // ══════════════════════════════════════════════════════════
      //  🤖 ANALIZAR DOCUMENTO con Claude
      //  Proxy seguro: API key vive en env.ANTHROPIC_API_KEY
      // ══════════════════════════════════════════════════════════
      if (path === 'analizar_doc') {
        const { docName, mediaType, isImg, data: b64, prompt, modo } = body;
        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) return resp({ ok: false, error: 'ANTHROPIC_API_KEY no configurado' }, 500);

        const aiHeaders = {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        };

        // ─── PROMPT SYSTEM ───
        const SYSTEM_COMPLETO = `Eres un validador de documentos para Complejo Agroindustrial Beta (Perú, sector transporte y agroindustria).

Tu tarea: validar si el documento subido corresponde al campo solicitado, si es legible, y extraer datos clave.

DISTINCIONES IMPORTANTES (NO confundas):
- "DNI conductor" = SOLO documento nacional de identidad peruano (carnet azul/celeste con foto + datos personales). NO licencia de conducir.
- "Licencia de conducir" = brevete (tarjeta de plástico que dice "LICENCIA DE CONDUCIR" y categoría A1/A2/etc.). NO es DNI.
- "Foto del conductor" = retrato/selfie/foto de UNA PERSONA. Acepta cualquier imagen donde se vea una persona claramente, sin importar fondo o calidad.
- "Foto del proveedor" = foto del representante o logo de la empresa. Acepta retratos, fotos casuales, fotos de logos.
- "Foto exterior de la unidad" = imagen de un VEHÍCULO visto desde afuera (camioneta, bus, auto, etc.)
- "Foto interior de la unidad" = imagen del interior del vehículo (asientos, tablero, etc.)

REGLA CLAVE PARA FOTOS:
Si el campo pide una FOTO (de persona o vehículo), sé MUY FLEXIBLE:
- Acepta cualquier imagen que muestre lo solicitado
- NO rechaces por calidad, encuadre o fondo
- valido=true si se ve una persona (para foto persona) o vehículo (para foto unidad)
- Las fotos NO tienen "datos" para extraer, deja titular/numero/vencimiento en null

Sé flexible con nombres equivalentes:
- "Vigencia poder" = poder vigente, partida registral SUNARP
- "Brochure" = dossier, presentación corporativa
- "SCTR" = póliza/certificado/constancia del seguro complementario
- "EMO" = examen médico ocupacional, aptitud médica, certificado médico
- "Antecedentes" = certificado oficial INPE/Poder Judicial/Policía
- "Récord MTC" = certificado del MTC sobre conducción
- "Tarjeta de propiedad" = tarjeta de identificación vehicular SUNARP

Responde SOLO con JSON puro (sin markdown, sin texto extra):
{
  "valido": true/false,
  "nitido": true/false,
  "motivo": "texto corto",
  "datos": {
    "titular": "nombre persona o empresa, o null",
    "numero": "n° doc/placa/RUC/licencia, o null",
    "vencimiento": "YYYY-MM-DD o null",
    "emision": "YYYY-MM-DD o null",
    "observacion": "dato relevante o null"
  }
}

Reglas:
- valido=true si corresponde al campo (acepta variantes razonables)
- nitido=false SOLO si está MUY borroso, oscuro o cortado (las fotos siempre son nitido=true si se distingue lo principal)
- motivo válido: "Documento verificado"
- motivo inválido: di brevemente qué se esperaba vs lo recibido
- NO inventes datos. Si no ves un campo claramente, pon null
- Fechas en formato YYYY-MM-DD estricto`;

        const SYSTEM_SIMPLE = `Eres un validador de documentos para Complejo Agroindustrial Beta (Perú).
Responde SOLO con JSON: {"valido":true/false,"motivo":"breve","nitido":true/false}

DISTINCIONES IMPORTANTES:
- "DNI" = SOLO documento nacional de identidad. NO confundir con licencia de conducir.
- "Licencia de conducir" = brevete con categoría. NO es DNI.
- "Foto" = ACEPTAR cualquier imagen que muestre lo solicitado (persona o vehículo). Ser muy flexible.

Reglas:
- valido=true si corresponde al campo (sé flexible)
- nitido=false solo si MUY borroso (fotos casi siempre nitido=true)
- Acepta variantes: SCTR/seguro complementario, EMO/aptitud médica, brochure/dossier`;

        // Modo regularización: solo texto (sin archivo)
        if (modo === 'regularizacion' && prompt) {
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST', headers: aiHeaders,
            body: JSON.stringify({
              model: MODELO_IA,
              max_tokens: 800,
              messages: [{ role: 'user', content: prompt }]
            }),
          });
          const d = await r.json();
          const texto = d.content?.find(c => c.type === 'text')?.text;
          if (!texto && d.error) return resp({ ok: false, error_claude: d.error });
          return resp({ ok: true, texto: texto || '{}' });
        }

        if (!b64 || !mediaType) return resp({ ok: false, error: 'Faltan datos del archivo' }, 400);

        // ── Mensaje del usuario: solo el archivo + el campo solicitado ──
        const parteArchivo = isImg
          ? { type: 'image',    source: { type: 'base64', media_type: mediaType, data: b64 } }
          : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };

        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers: aiHeaders,
          body: JSON.stringify({
            model:    MODELO_IA,
            max_tokens: modo === 'simple' ? 200 : 600,
            system: modo === 'simple' ? SYSTEM_SIMPLE : SYSTEM_COMPLETO,
            messages: [{
              role: 'user',
              content: [
                parteArchivo,
                { type: 'text', text: `Campo solicitado: "${docName || 'Documento'}"` }
              ]
            }],
          }),
        });
        if (!r.ok) return resp({ ok: false, error: 'Claude error: ' + await r.text() }, 500);
        const d = await r.json();
        return resp({
          ok: true,
          texto: d.content?.find(c => c.type === 'text')?.text || '{}',
        });
      }

      // ══════════════════════════════════════════════════════════
      //  📧 ENVIAR OTP
      //  MEJORA: Rate limiting — máx 3 OTPs por email cada 10 min
      // ══════════════════════════════════════════════════════════
      if (path === 'enviar_otp') {
        const { ruc, email, contacto } = body;
        if (!ruc || !email) return resp({ ok: false, error: 'RUC y email requeridos' }, 400);

        // ── Rate limiting ──────────────────────────────────────
        if (env.OTP_STORE) {
          const rlKey   = `rl:${email}`;
          const rlRaw   = await env.OTP_STORE.get(rlKey);
          const rl      = rlRaw ? JSON.parse(rlRaw) : { count: 0, since: Date.now() };
          const elapsed = Date.now() - rl.since;

          if (elapsed < 10 * 60 * 1000 && rl.count >= 3) {
            const restante = Math.ceil((10 * 60 * 1000 - elapsed) / 60000);
            return resp({ ok: false, error: `Demasiados intentos. Espera ${restante} minuto(s) e inténtalo de nuevo.` }, 429);
          }

          // Reiniciar contador si ya pasaron 10 min
          const nuevoRl = elapsed >= 10 * 60 * 1000
            ? { count: 1, since: Date.now() }
            : { count: rl.count + 1, since: rl.since };
          await env.OTP_STORE.put(rlKey, JSON.stringify(nuevoRl), { expirationTtl: 600 });
        }

        // ── Generar y guardar OTP ──────────────────────────────
        const otp    = String(Math.floor(100000 + Math.random() * 900000));
        const expiry = Date.now() + 10 * 60 * 1000;
        if (env.OTP_STORE) {
          await env.OTP_STORE.put(`${ruc}:${email}`, JSON.stringify({ otp, expiry }), { expirationTtl: 600 });
        }

        // ── Enviar por Power Automate ──────────────────────────
        try {
          await fetch(FLOWS.enviar_otp, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ruc, email, contacto, otp }),
          });
        } catch(e) { console.warn('Flow OTP falló:', e.message); }

        return resp({ ok: true });
      }

      // ══════════════════════════════════════════════════════════
      //  ✅ VERIFICAR OTP
      // ══════════════════════════════════════════════════════════
      if (path === 'verificar_otp') {
        const { ruc, email, otp } = body;
        if (!ruc || !email || !otp) return resp({ ok: false, error: 'Datos incompletos' }, 400);

        if (!env.OTP_STORE) {
          // Sin KV: delegar al Flow original
          const r    = await fetch(FLOWS.verificar_otp, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawBody });
          const text = await r.text();
          try { return resp(JSON.parse(text)); } catch { return resp({ ok: true, valido: true }); }
        }

        const claveKV = `${ruc}:${email}`;
        const stored = await env.OTP_STORE.get(claveKV);
        if (!stored) return resp({ ok: true, valido: false, error: 'OTP expirado o no encontrado' });

        const { otp: otpGuardado, expiry } = JSON.parse(stored);
        if (Date.now() > expiry) {
          await env.OTP_STORE.delete(claveKV);
          return resp({ ok: true, valido: false, error: 'OTP expirado' });
        }
        if (String(otp) !== String(otpGuardado)) return resp({ ok: true, valido: false, error: 'OTP incorrecto' });

        await env.OTP_STORE.delete(claveKV);
        return resp({ ok: true, valido: true });
      }

      // ══════════════════════════════════════════════════════════
      //  🔍 SUNAT RUC — 3 fuentes con fallback automático
      // ══════════════════════════════════════════════════════════
      if (path === 'sunat_ruc') {
        const ruc   = (body.ruc || '').replace(/\D/g, '').slice(0, 11);
        const token = body.token || '';
        if (ruc.length !== 11) return resp({ error: 'RUC inválido' }, 400);

        // Usar token del env (secret en Cloudflare) — si el frontend manda uno se ignora
        const apiToken = env.APIS_NET_PE_TOKEN || token || '';
        const authH = apiToken ? { Authorization: 'Bearer ' + apiToken } : {};
        const apiperuToken = env.APIPERU_DEV_TOKEN || '7028e830e49e91e3fd635f3505062cf9e4429d4906c571c7615d02070884a741';
        const errores = [];

        for (const url of [
          `https://api.apis.net.pe/v2/sunat/ruc?numero=${ruc}`,
          `https://api.apis.net.pe/v1/ruc?numero=${ruc}`,
        ]) {
          try {
            const r = await fetch(url, { headers: authH });
            if (r.ok) {
              const d = await r.json();
              if (d && (d.razonSocial || d.nombre)) return resp(d);
              errores.push(url+': respuesta sin datos');
            } else {
              errores.push(url+': HTTP '+r.status+' '+(await r.text()).slice(0,150));
            }
          } catch(e) { errores.push(url+': '+e.message); }
        }

        // Fallback (apiperu.dev, requiere Bearer token)
        try {
          const url = `https://api.apiperu.dev/api/ruc/${ruc}`;
          const r = await fetch(url, { headers: { Authorization: 'Bearer ' + apiperuToken, Accept: 'application/json' } });
          if (r.ok) {
            const d = await r.json();
            if (d?.data) return resp({
              razonSocial: d.data.nombre_o_razon_social || '',
              estado:      d.data.estado_del_contribuyente || '',
              condicion:   d.data.condicion_de_domicilio  || '',
              direccion:   d.data.direccion               || '',
            });
            errores.push(url+': respuesta sin datos');
          } else {
            errores.push(url+': HTTP '+r.status+' '+(await r.text()).slice(0,150));
          }
        } catch(e) { errores.push('apiperu.dev: '+e.message); }

        return resp({ error: 'RUC no encontrado en SUNAT', detalle: errores }, 404);
      }

      // ══════════════════════════════════════════════════════════
      //  🔍 RENIEC DNI — 3 fuentes con fallback automático
      //  (mismo patrón que sunat_ruc, agregado para Control Documentario)
      // ══════════════════════════════════════════════════════════
      if (path === 'sunat_dni') {
        const dni = (body.dni || '').replace(/\D/g, '').slice(0, 8);
        if (dni.length !== 8) return resp({ error: 'DNI inválido' }, 400);

        const apiToken = env.APIS_NET_PE_TOKEN || body.token || '';
        const authH = apiToken ? { Authorization: 'Bearer ' + apiToken } : {};
        const apiperuToken = env.APIPERU_DEV_TOKEN || '7028e830e49e91e3fd635f3505062cf9e4429d4906c571c7615d02070884a741';
        const errores = [];

        for (const url of [
          `https://api.apis.net.pe/v2/reniec/dni?numero=${dni}`,
          `https://api.apis.net.pe/v1/dni?numero=${dni}`,
        ]) {
          try {
            const r = await fetch(url, { headers: authH });
            if (r.ok) {
              const d = await r.json();
              if (d && (d.nombres || d.nombre_completo)) return resp(d);
              errores.push(url+': respuesta sin datos');
            } else {
              errores.push(url+': HTTP '+r.status+' '+(await r.text()).slice(0,150));
            }
          } catch(e) { errores.push(url+': '+e.message); }
        }

        // Fallback (apiperu.dev, requiere Bearer token)
        try {
          const url = `https://api.apiperu.dev/api/dni/${dni}`;
          const r = await fetch(url, { headers: { Authorization: 'Bearer ' + apiperuToken, Accept: 'application/json' } });
          if (r.ok) {
            const d = await r.json();
            if (d?.data) return resp({
              nombres:          d.data.nombres              || '',
              apellidoPaterno:  d.data.apellido_paterno      || '',
              apellidoMaterno:  d.data.apellido_materno      || '',
              nombre_completo:  d.data.nombre_completo       || '',
            });
            errores.push(url+': respuesta sin datos');
          } else {
            errores.push(url+': HTTP '+r.status+' '+(await r.text()).slice(0,150));
          }
        } catch(e) { errores.push('apiperu.dev: '+e.message); }

        return resp({ error: 'DNI no encontrado en RENIEC', detalle: errores }, 404);
      }

      // ══════════════════════════════════════════════════════════
      //  🧪 CONSULTADATOS.COM — endpoints de PRUEBA (Plan Standard + Maestro)
      //  Solo para comparar contra json.pe / apis.net.pe / apiperu.dev.
      //  No reemplazan sunat_ruc / sunat_dni todavía — son rutas nuevas.
      //  Token: env.CONSULTADATOS_TOKEN (recomendado moverlo a Cloudflare Secrets)
      // ══════════════════════════════════════════════════════════
      const CD_TOKEN = env.CONSULTADATOS_TOKEN || 'tr_aa92e6e2822c1c71809a3f95dfd01a48';

      async function consultaCD(url) {
        const r = await fetch(url, { headers: { Authorization: 'Bearer ' + CD_TOKEN, Accept: 'application/json' } });
        const text = await r.text();
        let d = {};
        try { d = JSON.parse(text); } catch {}
        return { ok: r.ok, status: r.status, data: d, raw: text };
      }

      // 🆔 DNI — ConsultaDatos (prueba)
      if (path === 'consulta_dni_cd') {
        const dni = (body.dni || '').replace(/\D/g, '').slice(0, 8);
        if (dni.length !== 8) return resp({ ok: false, error: 'DNI inválido' }, 400);
        try {
          const { ok, status, data, raw } = await consultaCD(`https://api2.consultadatos.com/api/dni/${dni}`);
          if (ok && data.NOMBRES) return resp({ ok: true, ...data });
          if (status === 402 || status === 403) return resp({ ok: false, error: 'Créditos agotados o plan insuficiente', http: status }, 402);
          return resp({ ok: false, error: data.message || 'DNI no encontrado', http: status, raw: raw.slice(0,200) }, 404);
        } catch(e) { return resp({ ok: false, error: 'Error: ' + e.message }, 500); }
      }

      // 🏢 RUC — ConsultaDatos (prueba)
      if (path === 'consulta_ruc_cd') {
        const ruc = (body.ruc || '').replace(/\D/g, '').slice(0, 11);
        if (ruc.length !== 11) return resp({ ok: false, error: 'RUC inválido' }, 400);
        try {
          const { ok, status, data, raw } = await consultaCD(`https://api2.consultadatos.com/api/ruc/${ruc}`);
          if (ok && data.success && data.data) return resp({ ok: true, ...data.data });
          if (status === 402 || status === 403) return resp({ ok: false, error: 'Créditos agotados o plan insuficiente', http: status }, 402);
          return resp({ ok: false, error: data.message || 'RUC no encontrado', http: status, raw: raw.slice(0,200) }, 404);
        } catch(e) { return resp({ ok: false, error: 'Error: ' + e.message }, 500); }
      }

      // 🪪 LICENCIA DE CONDUCIR — ConsultaDatos (prueba, por DNI)
      if (path === 'consulta_licencia') {
        const dni = (body.dni || '').replace(/\D/g, '').slice(0, 8);
        if (dni.length !== 8) return resp({ ok: false, error: 'DNI inválido' }, 400);
        try {
          const { ok, status, data, raw } = await consultaCD(`https://api2.consultadatos.com/api/licencia/${dni}`);
          if (ok && data.success && data.data) return resp({ ok: true, ...data.data });
          if (status === 402 || status === 403) return resp({ ok: false, error: 'Créditos agotados o plan insuficiente', http: status }, 402);
          return resp({ ok: false, error: data.message || 'Licencia no encontrada', http: status, raw: raw.slice(0,200) }, 404);
        } catch(e) { return resp({ ok: false, error: 'Error: ' + e.message }, 500); }
      }

      // 🛡️ SOAT — ConsultaDatos (prueba, por placa)
      if (path === 'consulta_soat') {
        const placa = (body.placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
        if (!placa) return resp({ ok: false, error: 'Placa inválida' }, 400);
        try {
          const { ok, status, data, raw } = await consultaCD(`https://api2.consultadatos.com/api/placa/soat/${placa}`);
          if (ok && data.data) return resp({ ok: true, ...data.data });
          if (status === 402 || status === 403) return resp({ ok: false, error: 'Créditos agotados o plan insuficiente', http: status }, 402);
          return resp({ ok: false, error: data.message || 'SOAT no encontrado', http: status, raw: raw.slice(0,200) }, 404);
        } catch(e) { return resp({ ok: false, error: 'Error: ' + e.message }, 500); }
      }

      // 🚗 REVISIÓN TÉCNICA (CITV) — ConsultaDatos (prueba, requiere Plan Maestro)
      if (path === 'consulta_citv') {
        const placa = (body.placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
        if (!placa) return resp({ ok: false, error: 'Placa inválida' }, 400);
        try {
          const { ok, status, data, raw } = await consultaCD(`https://api2.consultadatos.com/api/placa/citv/${placa}`);
          if (ok && data.success && data.data) return resp({ ok: true, ...data.data });
          if (status === 402 || status === 403) return resp({ ok: false, error: 'Este token no tiene el Plan Maestro habilitado para CITV', http: status }, 402);
          return resp({ ok: false, error: data.message || 'No se encontró revisión técnica para esta placa', http: status, raw: raw.slice(0,200) }, 404);
        } catch(e) { return resp({ ok: false, error: 'Error: ' + e.message }, 500); }
      }

      // ══════════════════════════════════════════════════════════
      //  🔎 RUC EXISTE — verifica si un RUC ya está registrado
      //  Usado en registro.html para evitar duplicados
      // ══════════════════════════════════════════════════════════
      if (path === 'ruc_existe') {
        const { ruc } = body;
        if (!ruc) return resp({ ok: false, error: 'RUC requerido' }, 400);

        const sheetUrl = GSHEET_URL + '?action=listar&analista=TODOS';
        const res      = await fetch(sheetUrl, { redirect: 'follow' });
        const data     = await res.json();
        const prov     = (data.proveedores || []).find(p => String(p.ruc) === String(ruc));

        if (!prov) return resp({ ok: true, existe: false });
        return resp({ ok: true, existe: true, estado: prov.estado || 'pendiente', razonSocial: prov.razonSocial });
      }

      // ══════════════════════════════════════════════════════════
      //  📨 NOTIFICAR ANALISTA — avisa cuando llega un nuevo registro
      // ══════════════════════════════════════════════════════════
      if (path === 'notificar_analista') {
        const { analista, ruc, razonSocial, categoria, email_proveedor } = body;

        // Leer emails de analistas desde env (secret ANALISTAS_EMAILS_JSON)
        // Formato: {"NORTE":"norte@beta.com","SUR":"sur@beta.com","ADMIN":"admin@beta.com"}
        let emailsMap = {};
        try { emailsMap = JSON.parse(env.ANALISTAS_EMAILS_JSON || '{}'); } catch {}
        const email_analista = emailsMap[analista] || '';
        if (!email_analista) return resp({ ok: true, skipped: `sin email para analista ${analista}` });

        const asunto  = `📋 Nuevo proveedor registrado — ${razonSocial}`;
        const htmlMsg = `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#F0EDF8;border-radius:16px;overflow:hidden;border:1px solid #D4CBE8">
            <div style="background:#5212A0;padding:1.5rem 2rem;border-bottom:3px solid #5BAD1E">
              <span style="font-size:28px;font-weight:800;color:#fff">bet<span style="color:#79CC38">a</span></span>
              <p style="color:rgba(255,255,255,.65);font-size:11px;margin-top:3px">Panel Analista</p>
            </div>
            <div style="padding:2rem">
              <p style="font-size:15px;color:#1C0840;font-weight:700;margin-bottom:1rem">Hola, ${analista} 👋</p>
              <p style="font-size:13px;color:#5C4880;line-height:1.7;margin-bottom:1rem">
                Un nuevo proveedor completó su registro y está esperando tu revisión:
              </p>
              <div style="background:#EDE5FF;border-left:4px solid #5212A0;border-radius:8px;padding:1rem 1.25rem;margin-bottom:1.25rem;font-size:13px;color:#1C0840">
                🏢 <strong>${razonSocial}</strong><br>
                🪪 RUC: <code>${ruc}</code><br>
                📂 Categoría: ${categoria || '—'}<br>
                📧 Correo: ${email_proveedor || '—'}
              </div>
              <div style="text-align:center;margin:1.5rem 0">
                <a href="${env.LINK_PANEL || 'https://betayazmingps-max.github.io/PORTAL_BETA/preview.html'}" style="background:#5212A0;color:#fff;padding:14px 32px;border-radius:12px;font-weight:800;font-size:14px;text-decoration:none;display:inline-block">Ir al Panel de Analista →</a>
              </div>
              <p style="font-size:12px;color:#9B89B8">Ingresa al panel para revisar los documentos y tomar una decisión.</p>
            </div>
            <div style="background:#1C0840;padding:1rem 2rem;text-align:center">
              <p style="color:rgba(255,255,255,.55);font-size:10.5px;margin:0 0 3px">✦ Desarrollado por Ing. Yazmin Atuncar</p>
            <p style="color:rgba(255,255,255,.3);font-size:9px;margin:0">TI · Portal Proveedores v4.0 · Complejo Agroindustrial Beta S.A.</p>
            </div>
          </div>`;

        if (env.RESEND_API_KEY) {
          for (let i = 1; i <= 3; i++) {
            try {
              const r = await fetch('https://api.resend.com/emails', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
                body:    JSON.stringify({ from: env.EMAIL_FROM || 'Portal Beta <noreply@betaagroindustrial.com>', to: [email_analista], subject: asunto, html: htmlMsg }),
              });
              if (r.ok) return resp({ ok: true });
              if (i < 3) await sleep(1000 * i);
            } catch { if (i < 3) await sleep(1000 * i); }
          }
        }
        // Sin Resend → enviar via Flow NotificarProveedor de Power Automate
        try {
          await fetchConTimeout(FLOWS.notificar, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ email: email_analista, asunto, htmlEmail: htmlMsg }),
          }, 15000);
          return resp({ ok: true });
        } catch(e) {
          console.warn('notificar_analista Flow error:', e.message);
          return resp({ ok: true, skipped: 'no se pudo notificar' });
        }
      }

      // ══════════════════════════════════════════════════════════
      //  🔍 VERIFICAR PROVEEDOR (login de ingresar.html)
      //  Solo devuelve datos del proveedor buscado — no expone la lista completa
      // ══════════════════════════════════════════════════════════
      if (path === 'verificar_proveedor') {
        const { ruc, email } = body;
        if (!ruc || !email) return resp({ ok: false, error: 'RUC y email requeridos' }, 400);

        const sheetUrl = GSHEET_URL + '?action=listar&analista=TODOS';
        const res      = await fetch(sheetUrl, { redirect: 'follow' });
        const data     = await res.json();
        const proveedores = data.proveedores || [];

        const prov = proveedores.find(p =>
          String(p.ruc) === String(ruc) &&
          String(p.email).toLowerCase() === String(email).toLowerCase()
        );

        if (!prov) return resp({ ok: false, error: 'RUC o correo no encontrado.\nVerifica tus datos o contáctate con tu analista.' }, 404);

        // Solo devolver los campos necesarios — nunca la lista completa
        return resp({
          ok: true,
          proveedor: {
            ruc:                 prov.ruc,
            razonSocial:         prov.razonSocial,
            carpeta:             prov.carpeta     || '',
            analista:            prov.analista    || '',
            categoria:           prov.categoria   || '',
            estado:              prov.estado      || 'pendiente',
            docs_obligatorios:   prov.docs_obligatorios   || [],
            docs_personalizados: prov.docs_personalizados || [],
          }
        });
      }

      // ══════════════════════════════════════════════════════════
      //  📋 LISTAR PROVEEDORES
      //  MEJORA: Caché de 60 segundos en KV — evita llamar Sheets en cada visita
      // ══════════════════════════════════════════════════════════
      if (path === 'listar') {
        const analista  = body.analista || 'TODOS';
        const cacheKey  = `cache:listar:${analista}`;

        // ── Leer caché ─────────────────────────────────────────
        if (env.OTP_STORE) {
          const cached = await env.OTP_STORE.get(cacheKey);
          if (cached) {
            console.log('Cache hit para listar:', analista);
            return resp(JSON.parse(cached));
          }
        }

        // ── Llamar Google Sheets ───────────────────────────────
        const sheetUrl = GSHEET_URL + '?action=listar&analista=' + encodeURIComponent(analista);
        const res      = await fetch(sheetUrl, { redirect: 'follow' });
        const data     = await res.json();

        // ── Guardar en caché 60 segundos ──────────────────────
        if (env.OTP_STORE && data.ok) {
          await env.OTP_STORE.put(cacheKey, JSON.stringify(data), { expirationTtl: 60 });
        }

        return resp(data);
      }

      // ══════════════════════════════════════════════════════════
      //  💾 ACTUALIZAR SHEET
      //  MEJORA: 3 reintentos con backoff exponencial (1s, 2s, 4s)
      // ══════════════════════════════════════════════════════════
      if (path === 'sheet') {
        // Invalidar caché de listar cuando se actualiza algo
        if (env.OTP_STORE && body.analista) {
          await env.OTP_STORE.delete(`cache:listar:${body.analista}`);
          await env.OTP_STORE.delete('cache:listar:TODOS');
        }

        let ultimoError = '';
        for (let intento = 1; intento <= 3; intento++) {
          try {
            const r = await fetchConTimeout(GSHEET_URL, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    rawBody,
            }, 15000);
            let data;
            try { data = await r.json(); } catch { data = { ok: true }; }
            return resp(data);
          } catch(e) {
            ultimoError = e.message;
            if (intento < 3) await sleep(1000 * Math.pow(2, intento - 1)); // 1s, 2s
          }
        }
        return resp({ ok: false, error: 'Google Sheets no respondió después de 3 intentos: ' + ultimoError }, 500);
      }

      // ══════════════════════════════════════════════════════════
      //  🔔 NOTIFICAR PROVEEDOR
      //  MEJORA: 3 intentos automáticos antes de fallar
      // ══════════════════════════════════════════════════════════
      if (path === 'notificar') {
        const { email, contacto, razonSocial, ruc, mensaje, motivo, tipo } = body;
        if (!email) return resp({ ok: false, error: 'Email requerido' }, 400);

        // Link de ingreso por defecto (si el frontend no lo manda)
        const linkIngresar = body.linkIngresar || 'https://betayazmingps-max.github.io/PORTAL_BETA/ingresar.html';

        const esAprobacion = tipo === 'aprobacion';
        const colorBorde   = esAprobacion ? '#5BAD1E' : '#E02020';
        const asunto       = esAprobacion
          ? '✅ Tu solicitud fue aprobada — Portal Proveedores Beta'
          : '📋 Actualización sobre tu solicitud — Portal Proveedores Beta';

        const cuerpoHtml = esAprobacion
          ? `<p style="font-size:15px;color:#1C0840;font-weight:600">Hola, <strong>${contacto || razonSocial}</strong> 👋</p>
             <p style="font-size:13px;color:#5C4880;line-height:1.7;margin:1rem 0">Tu empresa <strong>${razonSocial}</strong> (RUC: <code>${ruc}</code>) ha sido <strong style="color:#5BAD1E">APROBADA</strong> como proveedor de <strong>Complejo Agroindustrial Beta</strong>.</p>
             ${mensaje ? `<div style="background:#EDE5FF;border-left:4px solid #5212A0;border-radius:8px;padding:.875rem 1rem;margin-bottom:1rem;font-size:13px">💬 <strong>Mensaje del analista:</strong> ${mensaje}</div>` : ''}
             <div style="text-align:center;margin:2rem 0"><a href="${linkIngresar || '#'}" style="background:#5212A0;color:#fff;padding:14px 32px;border-radius:12px;font-weight:800;font-size:14px;text-decoration:none;display:inline-block">Acceder al Portal →</a></div>
             <p style="font-size:12px;color:#9B89B8">Usa tu RUC y este correo para ingresar.</p>`
          : `<p style="font-size:15px;color:#1C0840;font-weight:600">Hola, <strong>${contacto || razonSocial}</strong>,</p>
             <p style="font-size:13px;color:#5C4880;line-height:1.7;margin:1rem 0">La solicitud de <strong>${razonSocial}</strong> (RUC: <code>${ruc}</code>) no ha podido ser aprobada en esta oportunidad.</p>
             ${motivo ? `<div style="background:#FEE8E8;border:1.5px solid #E02020;border-radius:10px;padding:1rem;margin-bottom:1rem;font-size:13px;color:#E02020"><strong>Motivo:</strong> ${motivo}</div>` : ''}
             <p style="font-size:13px;color:#5C4880">Contáctate con tu analista para más información.</p>`;

        const htmlEmail = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#F0EDF8;border-radius:16px;overflow:hidden;border:1px solid #D4CBE8">
          <div style="background:#5212A0;padding:1.5rem 2rem;border-bottom:3px solid ${colorBorde}">
            <span style="font-size:28px;font-weight:800;color:#fff">bet<span style="color:#79CC38">a</span></span>
            <p style="color:rgba(255,255,255,.65);font-size:11px;margin-top:3px">complejo agroindustrial</p>
          </div>
          <div style="padding:2rem">${cuerpoHtml}</div>
          <div style="background:#1C0840;padding:1rem 2rem;text-align:center">
            <p style="color:rgba(255,255,255,.55);font-size:10.5px;margin:0 0 3px">✦ Desarrollado por Ing. Yazmin Atuncar</p>
            <p style="color:rgba(255,255,255,.3);font-size:9px;margin:0">TI · Portal Proveedores v4.0 · Complejo Agroindustrial Beta S.A.</p>
          </div>
        </div>`;

        // ── Opción A: Resend (con 3 reintentos) ───────────────
        if (env.RESEND_API_KEY) {
          for (let i = 1; i <= 3; i++) {
            try {
              const r = await fetchConTimeout('https://api.resend.com/emails', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
                body:    JSON.stringify({ from: env.EMAIL_FROM || 'Portal Beta <noreply@betaagroindustrial.com>', to: [email], subject: asunto, html: htmlEmail }),
              }, 10000);
              if (r.ok) return resp({ ok: true });
              if (i < 3) await sleep(1000 * i);
            } catch(e) { if (i < 3) await sleep(1000 * i); }
          }
        }

        // ── Opción B: Power Automate (Flow NotificarProveedor) ──
        for (let i = 1; i <= 3; i++) {
          try {
            await fetchConTimeout(FLOWS.notificar, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ email, asunto, htmlEmail }),
            }, 15000);
            return resp({ ok: true });
          } catch(e) {
            if (i === 3) return resp({ ok: false, error: 'No se pudo enviar la notificación después de 3 intentos' }, 500);
            await sleep(1000 * i);
          }
        }
      }

      // ══════════════════════════════════════════════════════════
      //  📤 SUBIR SOLICITUD (registro de proveedor → Solicitudes_Proveedores)
      //  Endpoint dedicado al Flow nuevo SubirSolicitud (no toca docs aprobados)
      // ══════════════════════════════════════════════════════════
      if (path === 'subir_solicitud') {
        const flowUrl = FLOWS.subir_solicitud;
        if (!flowUrl) return resp({ ok: false, error: 'Flow SubirSolicitud no configurado' }, 500);

        // Fire-and-forget: respondemos inmediato, el Flow sigue en segundo plano
        const promesa = fetch(flowUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    rawBody,
        }).catch(e => console.warn('subir_solicitud error:', e.message));

        ctx.waitUntil(promesa);
        return resp({ ok: true });
      }

      // ══════════════════════════════════════════════════════════
      //  📤 SUBIR DOCS
      //  MEJORA: Responde inmediato al usuario (fire-and-forget)
      //  El Flow sigue ejecutándose en segundo plano
      // ══════════════════════════════════════════════════════════
      if (path === 'subir_docs') {
        const flowUrl = FLOWS.subir_docs;

        // Disparar el Flow sin esperar respuesta (no bloquea al usuario)
        const promesaFlow = fetch(flowUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    rawBody,
        }).catch(e => console.warn('subir_docs Flow error:', e.message));

        // waitUntil permite que el Flow siga corriendo aunque ya respondamos
        ctx.waitUntil(promesaFlow);

        // Responder inmediatamente al frontend
        return resp({ ok: true, mensaje: 'Documentos enviados a SharePoint' });
      }

      // ══════════════════════════════════════════════════════════
      //  📁 CREAR CARPETAS — con 3 reintentos
      // ══════════════════════════════════════════════════════════
      if (path === 'crear_carpetas') {
        const { flowUrl: customUrl, ...payload } = body;
        const targetUrl = customUrl || FLOWS.crear_carpetas;

        for (let i = 1; i <= 3; i++) {
          try {
            const r = await fetchConTimeout(targetUrl, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify(payload),
            }, 30000);
            if (r.status === 202 || r.ok) return resp({ ok: true });
            if (i < 3) await sleep(2000 * i);
          } catch(e) {
            if (e.name === 'AbortError') return resp({ ok: true }); // timeout = flow aceptó
            if (i === 3) return resp({ ok: false, error: e.message }, 500);
            await sleep(2000 * i);
          }
        }
      }

      // ══════════════════════════════════════════════════════════
      //  🔀 OTROS FLOWS (proxy genérico)
      // ══════════════════════════════════════════════════════════
      const flowUrl = FLOWS[path];
      if (flowUrl) {
        const r    = await fetch(flowUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawBody });
        const text = await r.text();
        try { return resp(JSON.parse(text)); } catch { return resp({ ok: true }); }
      }

      return resp({ error: 'Ruta desconocida: /' + path }, 404);

    } catch(err) {
      console.error('Worker error en /' + path + ':', err);
      return resp({ ok: false, error: 'Error interno: ' + err.message }, 500);
    }
  }
};

// ── Helpers ──────────────────────────────────────────────────────

function resp(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// fetch con timeout usando AbortController
async function fetchConTimeout(url, options = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(tid);
    return r;
  } catch(e) {
    clearTimeout(tid);
    throw e;
  }
}
