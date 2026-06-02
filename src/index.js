/**
 * ════════════════════════════════════════════════════════════════
 *  PORTAL BETA — Cloudflare Worker
 *  URL: https://portalbeta.betayazmingps.workers.dev
 *
 *  VARIABLES DE ENTORNO (configurar en Cloudflare Dashboard → Workers → Settings → Variables):
 *    ANTHROPIC_API_KEY   → sk-ant-...            (para /analizar_doc)
 *    ANALISTAS_JSON      → {"NORTE":{"pass":"...","nombre":"NORTE"},...}  (para /login_analista)
 *    RESEND_API_KEY      → re_...                (para /notificar)
 *    EMAIL_FROM          → Portal Beta <noreply@betaagroindustrial.com>
 *    OTP_STORE           → KV Namespace binding  (para /enviar_otp y /verificar_otp)
 * ════════════════════════════════════════════════════════════════
 */

// ── URLs de Power Automate (rutas simples que solo hacen proxy) ─
const FLOWS = {
  verificar_ruc:  'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/d404ad4b46dd4868a0ac28d09ffe0a0f/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=E4aB_yIFWw5zuisDBfPGyQ7JfZUb0YMzPajUMEZCFA0',
  registrar:      'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/4a59933c3dd442078b22db95ce8a6aa7/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=DNNNEfIlxHXc21YJIsjzhxx2Qa4IxCh_SkOuRR31ndw',
  subir_docs:     'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/9c54e9442b334e5daa0dce62e191ecf6/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=chFNo9cGEY9CcS1CdE_rHZ8l0zXe9WdT4MEFNkGIySs',
  crear_carpetas: 'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/4a59933c3dd442078b22db95ce8a6aa7/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=DNNNEfIlxHXc21YJIsjzhxx2Qa4IxCh_SkOuRR31ndw',
};

// ── URLs fijas ──
const GSHEET_URL = 'https://script.google.com/macros/s/AKfycbw_Fwj-pT-2NBB0w87h0dp2od9vWa4jMglXC773ThwqbrTsf3IRij-tx4amd4_RrF4eKg/exec';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

// ── Usar sintaxis moderna "export default" para acceder a env (KV, secrets) ──
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Solo POST' }), { status: 405, headers: CORS });
    }

    const path = new URL(request.url).pathname.replace(/^\/+|\/+$/g, '');

    // Leer body una sola vez
    let body = {};
    let rawBody = '';
    try {
      rawBody = await request.text();
      body    = JSON.parse(rawBody);
    } catch {}

    try {

      // ══════════════════════════════════════════════════════════
      //  🔐 LOGIN ANALISTA
      //  Valida credenciales sin exponer contraseñas en el frontend
      //  Requiere: env.ANALISTAS_JSON (secret en Cloudflare)
      // ══════════════════════════════════════════════════════════
      if (path === 'login_analista') {
        const { analista, pass } = body;
        if (!analista || !pass) {
          return resp({ ok: false, error: 'Datos incompletos' }, 400);
        }

        // Leer credenciales desde la variable de entorno (nunca visible en el frontend)
        let auth = {};
        try { auth = JSON.parse(env.ANALISTAS_JSON || '{}'); } catch {}

        const entrada = auth[analista];
        if (!entrada || entrada.pass !== pass) {
          return resp({ ok: false, error: 'Contraseña incorrecta.' }, 401);
        }

        return resp({
          ok:      true,
          nombre:  entrada.nombre  || analista,
          esAdmin: analista        === 'ADMIN',
        });
      }

      // ══════════════════════════════════════════════════════════
      //  🤖 ANALIZAR DOCUMENTO con Claude
      //  Proxy seguro: la API key vive en env.ANTHROPIC_API_KEY
      //  Modos:
      //    - "completo"       → validación completa con extracción de datos
      //    - "simple"         → validación rápida (solo valido/nitido/motivo)
      //    - "regularizacion" → análisis de texto (sin archivo, solo prompt)
      // ══════════════════════════════════════════════════════════
      if (path === 'analizar_doc') {
        const { docName, mediaType, isImg, data: b64, prompt, modo } = body;
        const apiKey = env.ANTHROPIC_API_KEY;

        if (!apiKey) return resp({ ok: false, error: 'ANTHROPIC_API_KEY no configurado en el Worker' }, 500);

        const headers = {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        };

        // ── Modo regularización: solo texto, sin archivo ──
        if (modo === 'regularizacion' && prompt) {
          const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST', headers,
            body: JSON.stringify({
              model:      'claude-sonnet-4-20250514',
              max_tokens: 800,
              messages:   [{ role: 'user', content: prompt }],
            }),
          });
          const d     = await claudeResp.json();
          const texto = d.content?.find(c => c.type === 'text')?.text || '{}';
          return resp({ ok: true, texto });
        }

        // ── Modos completo y simple: recibe archivo en base64 ──
        if (!b64 || !mediaType) return resp({ ok: false, error: 'Faltan datos del archivo' }, 400);

        const promptCompleto = `Eres un validador de documentos de una empresa agroindustrial peruana.
El campo solicitado es: "${docName || 'Documento'}"
Analiza el documento y responde ÚNICAMENTE con este JSON (sin texto extra, sin markdown):
{
  "valido": true/false,
  "nitido": true/false,
  "motivo": "texto corto en español",
  "datos": {
    "titular":     "nombre de la persona o empresa en el doc, o null",
    "numero":      "número de documento/placa/licencia/RUC que aparezca, o null",
    "vencimiento": "fecha de vencimiento YYYY-MM-DD si existe, o null",
    "emision":     "fecha de emisión YYYY-MM-DD si existe, o null",
    "observacion": "dato relevante adicional, o null"
  }
}
Reglas:
- valido: true si el documento corresponde al campo solicitado.
- nitido: true si se puede leer bien. false si está borroso o ilegible.
- motivo: "Documento verificado" si válido. Si no, explica brevemente qué se necesita.
- Sé flexible: acepta si tiene relación con el campo. Solo rechaza si es completamente diferente.`;

        const promptSimple = `Campo solicitado: "${docName}". Responde SOLO JSON sin markdown: {"valido":true/false,"motivo":"texto breve","nitido":true/false}`;

        const parteArchivo = isImg
          ? { type: 'image',    source: { type: 'base64', media_type: mediaType, data: b64 } }
          : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };

        const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers,
          body: JSON.stringify({
            model:      'claude-sonnet-4-20250514',
            max_tokens: modo === 'simple' ? 150 : 300,
            messages:   [{ role: 'user', content: [parteArchivo, { type: 'text', text: modo === 'simple' ? promptSimple : promptCompleto }] }],
          }),
        });

        if (!claudeResp.ok) {
          const err = await claudeResp.text();
          return resp({ ok: false, error: 'Claude error: ' + err }, 500);
        }

        const d     = await claudeResp.json();
        const texto = d.content?.find(c => c.type === 'text')?.text || '{}';
        return resp({ ok: true, texto });
      }

      // ══════════════════════════════════════════════════════════
      //  📧 ENVIAR OTP
      //  Genera OTP, lo guarda en KV (env.OTP_STORE) y lo envía
      //  por correo usando Power Automate (que ya tienes configurado)
      // ══════════════════════════════════════════════════════════
      if (path === 'enviar_otp') {
        const { ruc, email, contacto } = body;
        if (!ruc || !email) return resp({ ok: false, error: 'RUC y email requeridos' }, 400);

        // Generar OTP de 6 dígitos
        const otp    = String(Math.floor(100000 + Math.random() * 900000));
        const expiry = Date.now() + 10 * 60 * 1000; // 10 minutos

        // Guardar en KV (TTL: 600 segundos)
        if (env.OTP_STORE) {
          await env.OTP_STORE.put(
            `${ruc}:${email}`,
            JSON.stringify({ otp, expiry }),
            { expirationTtl: 600 }
          );
        } else {
          console.warn('OTP_STORE KV no configurado — el OTP no se guardará');
        }

        // Enviar el OTP por correo a través del Flow de Power Automate ya existente
        const flowUrl = FLOWS.enviar_otp ||
          'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/f2eb93ddbf044f7789ae8fa80518f549/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=PETK1l9jaK285bmPL18JpNof0wx313_h4jvRIUnkK6k';

        try {
          await fetch(flowUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ ruc, email, contacto, otp }),
          });
        } catch(e) {
          console.warn('No se pudo enviar email via Flow:', e.message);
        }

        return resp({ ok: true });
      }

      // ══════════════════════════════════════════════════════════
      //  ✅ VERIFICAR OTP
      //  Lee el OTP guardado en KV y lo compara
      // ══════════════════════════════════════════════════════════
      if (path === 'verificar_otp') {
        const { ruc, email, otp } = body;
        if (!ruc || !email || !otp) return resp({ ok: false, error: 'Datos incompletos' }, 400);

        if (!env.OTP_STORE) {
          // Sin KV: delegar al Flow original (compatibilidad con flujo anterior)
          const flowUrl = FLOWS.verificar_otp;
          const res = await fetch(flowUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ ruc, email, otp }),
          });
          const text = await res.text();
          let data;
          try { data = JSON.parse(text); } catch { data = { ok: true, valido: true }; }
          return resp(data);
        }

        const stored = await env.OTP_STORE.get(`${ruc}:${email}`);
        if (!stored) return resp({ ok: true, valido: false, error: 'OTP expirado o no encontrado' });

        const { otp: otpGuardado, expiry } = JSON.parse(stored);

        if (Date.now() > expiry) {
          await env.OTP_STORE.delete(`${ruc}:${email}`);
          return resp({ ok: true, valido: false, error: 'OTP expirado' });
        }

        if (String(otp) !== String(otpGuardado)) {
          return resp({ ok: true, valido: false, error: 'OTP incorrecto' });
        }

        // OTP correcto → eliminar para evitar reutilización
        await env.OTP_STORE.delete(`${ruc}:${email}`);
        return resp({ ok: true, valido: true });
      }

      // ══════════════════════════════════════════════════════════
      //  🔍 SUNAT RUC (sin cambios, ya funcionaba)
      // ══════════════════════════════════════════════════════════
      if (path === 'sunat_ruc') {
        const ruc   = (body.ruc   || '').replace(/\D/g, '').slice(0, 11);
        const token = body.token  || '';

        if (ruc.length !== 11) return resp({ error: 'RUC inválido' }, 400);

        const authHeaders = token ? { Authorization: 'Bearer ' + token } : {};

        // Intento 1: apis.net.pe v2
        try {
          const r = await fetch(`https://api.apis.net.pe/v2/sunat/ruc?numero=${ruc}`, { headers: authHeaders });
          if (r.ok) {
            const d = await r.json();
            if (d && (d.razonSocial || d.nombre)) return resp(d);
          }
        } catch {}

        // Intento 2: apis.net.pe v1
        try {
          const r = await fetch(`https://api.apis.net.pe/v1/ruc?numero=${ruc}`, { headers: authHeaders });
          if (r.ok) {
            const d = await r.json();
            if (d && (d.razonSocial || d.nombre)) return resp(d);
          }
        } catch {}

        // Intento 3: apiperu.dev (fallback gratuito)
        try {
          const r = await fetch(`https://api.apiperu.dev/api/ruc/${ruc}`);
          if (r.ok) {
            const d = await r.json();
            if (d && d.data) return resp({
              razonSocial: d.data.nombre_o_razon_social || d.data.razonSocial || '',
              estado:      d.data.estado_del_contribuyente || d.data.estado || '',
              condicion:   d.data.condicion_de_domicilio  || d.data.condicion || '',
              direccion:   d.data.direccion               || d.data.domicilioFiscal || '',
            });
          }
        } catch {}

        return resp({ error: 'RUC no encontrado en SUNAT' }, 404);
      }

      // ══════════════════════════════════════════════════════════
      //  📋 LISTAR PROVEEDORES (sin cambios, ya funcionaba)
      // ══════════════════════════════════════════════════════════
      if (path === 'listar') {
        const analista  = body.analista || 'TODOS';
        const sheetUrl  = GSHEET_URL + '?action=listar&analista=' + encodeURIComponent(analista);
        const res       = await fetch(sheetUrl, { redirect: 'follow' });
        const data      = await res.json();
        return resp(data);
      }

      // ══════════════════════════════════════════════════════════
      //  💾 ACTUALIZAR SHEET (aprobar, rechazar, notas, guardarAI)
      //  Llama al Google Apps Script con el body recibido
      // ══════════════════════════════════════════════════════════
      if (path === 'sheet') {
        const res = await fetch(GSHEET_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    rawBody,
        });
        let data;
        try { data = await res.json(); } catch { data = { ok: true }; }
        return resp(data);
      }

      // ══════════════════════════════════════════════════════════
      //  🔔 NOTIFICAR PROVEEDOR por correo
      //  Envía email de aprobación o rechazo via Resend o Flow
      // ══════════════════════════════════════════════════════════
      if (path === 'notificar') {
        const { email, contacto, razonSocial, ruc, mensaje, linkIngresar, motivo, tipo } = body;
        if (!email) return resp({ ok: false, error: 'Email requerido' }, 400);

        const esAprobacion = tipo === 'aprobacion';
        const colorBorde   = esAprobacion ? '#5BAD1E' : '#E02020';
        const asunto       = esAprobacion
          ? '✅ Tu solicitud fue aprobada — Portal Proveedores Beta'
          : '📋 Actualización sobre tu solicitud — Portal Proveedores Beta';

        const cuerpoHtml = esAprobacion
          ? `<p style="font-size:15px;color:#1C0840;font-weight:600">Hola, <strong>${contacto || razonSocial}</strong> 👋</p>
             <p style="font-size:13px;color:#5C4880;line-height:1.7;margin:1rem 0">
               Tu empresa <strong>${razonSocial}</strong> (RUC: <code>${ruc}</code>) ha sido
               <strong style="color:#5BAD1E">APROBADA</strong> como proveedor de
               <strong>Complejo Agroindustrial Beta</strong>.
             </p>
             ${mensaje ? `<div style="background:#EDE5FF;border-left:4px solid #5212A0;border-radius:8px;padding:.875rem 1rem;margin-bottom:1rem;font-size:13px;color:#1C0840">💬 <strong>Mensaje del analista:</strong> ${mensaje}</div>` : ''}
             <div style="text-align:center;margin:2rem 0">
               <a href="${linkIngresar || '#'}" style="background:#5212A0;color:#fff;padding:14px 32px;border-radius:12px;font-weight:800;font-size:14px;text-decoration:none;display:inline-block;letter-spacing:-.01em">
                 Acceder al Portal de Documentos →
               </a>
             </div>
             <p style="font-size:12px;color:#9B89B8">Usa tu <strong>RUC</strong> y este correo para ingresar al portal.</p>`
          : `<p style="font-size:15px;color:#1C0840;font-weight:600">Hola, <strong>${contacto || razonSocial}</strong>,</p>
             <p style="font-size:13px;color:#5C4880;line-height:1.7;margin:1rem 0">
               Lamentamos informarte que la solicitud de <strong>${razonSocial}</strong> (RUC: <code>${ruc}</code>)
               no ha podido ser aprobada en esta oportunidad.
             </p>
             ${motivo ? `<div style="background:#FEE8E8;border:1.5px solid #E02020;border-radius:10px;padding:1rem;margin-bottom:1rem;font-size:13px;color:#E02020"><strong>Motivo del rechazo:</strong> ${motivo}</div>` : ''}
             <p style="font-size:13px;color:#5C4880">Por favor contáctate con tu analista asignado para más información o para regularizar tu situación.</p>`;

        const htmlEmail = `
          <div style="font-family:'Outfit',Arial,sans-serif;max-width:520px;margin:0 auto;background:#F0EDF8;border-radius:16px;overflow:hidden;border:1px solid #D4CBE8">
            <div style="background:#5212A0;padding:1.5rem 2rem;border-bottom:3px solid ${colorBorde}">
              <span style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-.02em">bet<span style="color:#79CC38">a</span></span>
              <p style="color:rgba(255,255,255,.65);font-size:11px;margin-top:3px;letter-spacing:.05em">complejo agroindustrial</p>
            </div>
            <div style="padding:2rem">${cuerpoHtml}</div>
            <div style="background:#1C0840;padding:1rem 2rem;text-align:center">
              <p style="color:rgba(255,255,255,.35);font-size:10px;margin:0">Portal Proveedores v4.0 · Complejo Agroindustrial Beta S.A.</p>
            </div>
          </div>`;

        // Opción A: Enviar via Resend (si está configurado)
        if (env.RESEND_API_KEY) {
          const res = await fetch('https://api.resend.com/emails', {
            method:  'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization:  `Bearer ${env.RESEND_API_KEY}`,
            },
            body: JSON.stringify({
              from:    env.EMAIL_FROM || 'Portal Beta <noreply@betaagroindustrial.com>',
              to:      [email],
              subject: asunto,
              html:    htmlEmail,
            }),
          });
          if (!res.ok) {
            const err = await res.text();
            return resp({ ok: false, error: 'Error Resend: ' + err }, 500);
          }
          return resp({ ok: true });
        }

        // Opción B: Enviar via Power Automate (Flow existente como fallback)
        try {
          await fetch(FLOWS.registrar, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ email, asunto, cuerpo: htmlEmail, tipo, ruc, razonSocial, contacto, mensaje, motivo, linkIngresar }),
          });
          return resp({ ok: true });
        } catch(e) {
          return resp({ ok: false, error: 'No se pudo enviar notificación: ' + e.message }, 500);
        }
      }

      // ══════════════════════════════════════════════════════════
      //  📤 SUBIR DOCS / CREAR CARPETAS → Power Automate (proxy)
      //  Con reintentos automáticos y timeout extendido
      // ══════════════════════════════════════════════════════════
      if (path === 'subir_docs' || path === 'crear_carpetas') {
        const flowUrl = FLOWS[path];
        if (!flowUrl) return resp({ ok: false, error: 'Flow no configurado para: ' + path }, 500);

        const TIMEOUT_MS = path === 'subir_docs' ? 120_000 : 30_000;
        const MAX_INTENTOS = 3;

        for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
          const ctrl = new AbortController();
          const tid  = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
          try {
            const res = await fetch(flowUrl, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    rawBody,
              signal:  ctrl.signal,
            });
            clearTimeout(tid);
            // 202 Accepted = Power Automate aceptó el trigger (OK)
            if (res.status === 202 || res.ok) return resp({ ok: true });
            if (intento < MAX_INTENTOS) { await sleep(2000 * intento); continue; }
            return resp({ ok: false, error: `Flow respondió ${res.status}` }, res.status);
          } catch(e) {
            clearTimeout(tid);
            if (e.name === 'AbortError') return resp({ ok: true }); // timeout = flow aceptó
            if (intento === MAX_INTENTOS) return resp({ ok: false, error: e.message }, 500);
            await sleep(2000 * intento);
          }
        }
      }

      // ══════════════════════════════════════════════════════════
      //  🔀 OTROS FLOWS de Power Automate (proxy genérico)
      // ══════════════════════════════════════════════════════════
      const flowUrl = FLOWS[path];
      if (flowUrl) {
        const res  = await fetch(flowUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    rawBody,
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { ok: true }; }
        return resp(data);
      }

      return resp({ error: 'Ruta desconocida: ' + path }, 404);

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
