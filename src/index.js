const FLOWS = {
  verificar_ruc: 'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/d404ad4b46dd4868a0ac28d09ffe0a0f/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=E4aB_yIFWw5zuisDBfPGyQ7JfZUb0YMzPajUMEZCFA0',
  registrar:     'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/4a59933c3dd442078b22db95ce8a6aa7/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=DNNNEfIlxHXc21YJIsjzhxx2Qa4IxCh_SkOuRR31ndw',
  enviar_otp:    'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/f2eb93ddbf044f7789ae8fa80518f549/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=PETK1l9jaK285bmPL18JpNof0wx313_h4jvRIUnkK6k',
  verificar_otp: 'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/be4d3dc86fee423ca46acef1e9846cf1/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=n4IRLz3NSael_eU0Qb2uNdhB2PBHJu8Oki0m_B4ki2w',
  subir_docs:    'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/9c54e9442b334e5daa0dce62e191ecf6/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=chFNo9cGEY9CcS1CdE_rHZ8l0zXe9WdT4MEFNkGIySs',
  // ← Agrega aquí la URL real de tu flow de crear carpetas cuando la tengas
  crear_carpetas: 'PENDIENTE',
};

// ← Pon tu API Key de Anthropic aquí
const ANTHROPIC_API_KEY = 'sk-ant-PENDIENTE';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Solo POST' }), { status: 405, headers: CORS });
  }

  const path = new URL(request.url).pathname.replace(/^\/+|\/+$/g, '');

  // ── Ruta especial: consulta SUNAT ──────────────────────────
  if (path === 'sunat_ruc') {
    try {
      const body = await request.json();
      const ruc   = (body.ruc   || '').replace(/\D/g, '').slice(0, 11);
      const token = body.token  || '';

      if (ruc.length !== 11) {
        return new Response(JSON.stringify({ error: 'RUC inválido' }), { status: 400, headers: CORS });
      }

      const headers = token ? { 'Authorization': 'Bearer ' + token } : {};

      // Intento 1: apis.net.pe v2
      try {
        const r = await fetch(`https://api.apis.net.pe/v2/sunat/ruc?numero=${ruc}`, { headers });
        if (r.ok) {
          const d = await r.json();
          if (d && (d.razonSocial || d.nombre)) {
            return new Response(JSON.stringify(d), { status: 200, headers: CORS });
          }
        }
      } catch(e) {}

      // Intento 2: apis.net.pe v1
      try {
        const r = await fetch(`https://api.apis.net.pe/v1/ruc?numero=${ruc}`, { headers });
        if (r.ok) {
          const d = await r.json();
          if (d && (d.razonSocial || d.nombre)) {
            return new Response(JSON.stringify(d), { status: 200, headers: CORS });
          }
        }
      } catch(e) {}

      // Intento 3: apiperu.dev (fallback gratuito)
      try {
        const r = await fetch(`https://api.apiperu.dev/api/ruc/${ruc}`);
        if (r.ok) {
          const d = await r.json();
          if (d && d.data) {
            return new Response(JSON.stringify({
              razonSocial: d.data.nombre_o_razon_social || d.data.razonSocial || '',
              estado:      d.data.estado_del_contribuyente || d.data.estado || '',
              condicion:   d.data.condicion_de_domicilio  || d.data.condicion || '',
              direccion:   d.data.direccion               || d.data.domicilioFiscal || '',
            }), { status: 200, headers: CORS });
          }
        }
      } catch(e) {}

      return new Response(JSON.stringify({ error: 'RUC no encontrado en SUNAT' }), { status: 404, headers: CORS });

    } catch(err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
    }
  }

  // ── Ruta especial: listar proveedores desde Google Sheet ──
  if (path === 'listar') {
    try {
      const body     = await request.json().catch(() => ({}));
      const analista = body.analista || 'TODOS';
      const sheetUrl = 'https://script.google.com/macros/s/AKfycbw_Fwj-pT-2NBB0w87h0dp2od9vWa4jMglXC773ThwqbrTsf3IRij-tx4amd4_RrF4eKg/exec'
        + '?action=listar&analista=' + encodeURIComponent(analista);
      const res  = await fetch(sheetUrl, { redirect: 'follow' });
      const data = await res.json();
      return new Response(JSON.stringify(data), { status: 200, headers: CORS });
    } catch(err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers: CORS });
    }
  }

  // ── Ruta: POST al Google Sheet (aprobar, rechazar, notas, AI) ──
  if (path === 'sheet') {
    try {
      const body = await request.text();
      const SHEET_URL = 'https://script.google.com/macros/s/AKfycbw_Fwj-pT-2NBB0w87h0dp2od9vWa4jMglXC773ThwqbrTsf3IRij-tx4amd4_RrF4eKg/exec';
      const res  = await fetch(SHEET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'follow',
        body
      });
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = { ok: true }; }
      return new Response(JSON.stringify(data), { status: 200, headers: CORS });
    } catch(err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers: CORS });
    }
  }

  // ── Ruta: analizar documento con Claude IA ────────────────
  if (path === 'analizar_doc') {
    try {
      const body  = await request.json();
      const b64   = body.b64   || '';   // PDF en base64
      const docId = body.docId || '';

      const PROMPT = `Eres un asistente de revisión de documentos para una empresa de logística en Perú.
Analiza el documento PDF y extrae la información en formato JSON puro, sin texto adicional ni backticks.
Devuelve SOLO un objeto JSON con los campos que encuentres:
{
  "tipo_documento": "nombre del documento detectado",
  "estado": "estado o condición encontrada (ACTIVO, VIGENTE, VENCIDO, etc.)",
  "condicion": "habido/no habido u otra condición si aplica",
  "vencimiento": "fecha en formato YYYY-MM-DD o vacío si no aplica",
  "titular": "nombre del titular o representante legal si aparece",
  "domicilio": "dirección fiscal si aparece",
  "empresa": "nombre de empresa si aparece",
  "referencia": "número de referencia o expediente si aplica",
  "observaciones": "cualquier alerta importante"
}
Solo incluye los campos que realmente encuentres. No inventes datos.`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
              { type: 'text', text: PROMPT }
            ]
          }]
        })
      });

      if (!res.ok) {
        const err = await res.text();
        return new Response(JSON.stringify({ ok: false, error: 'Claude API: ' + err }), { status: 200, headers: CORS });
      }

      const data   = await res.json();
      const texto  = data.content?.find(b => b.type === 'text')?.text || '{}';
      const clean  = texto.replace(/```json|```/g, '').trim();
      let resultado = {};
      try { resultado = JSON.parse(clean); } catch(e) { resultado = { observaciones: texto }; }

      return new Response(JSON.stringify({ ok: true, resultado }), { status: 200, headers: CORS });

    } catch(err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers: CORS });
    }
  }

  // ── Ruta: crear carpetas via Power Automate ───────────────
  if (path === 'crear_carpetas') {
    if (FLOWS.crear_carpetas === 'PENDIENTE') {
      return new Response(JSON.stringify({ ok: false, error: 'URL del flow de carpetas no configurada aún' }), { status: 200, headers: CORS });
    }
    try {
      const body = await request.text();
      const res  = await fetch(FLOWS.crear_carpetas, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body
      });
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = { ok: true }; }
      return new Response(JSON.stringify(data), { status: 200, headers: CORS });
    } catch(err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers: CORS });
    }
  }

  // ── Rutas de Power Automate ────────────────────────────────
  const flowUrl = FLOWS[path];
  if (!flowUrl) {
    return new Response(
      JSON.stringify({ error: 'Ruta desconocida: ' + path }),
      { status: 404, headers: CORS }
    );
  }

  try {
    const body = await request.text();
    const res  = await fetch(flowUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    body,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { ok: true }; }
    return new Response(JSON.stringify(data), { status: 200, headers: CORS });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: CORS }
    );
  }
}
