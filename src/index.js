const FLOWS = {
  verificar_ruc: 'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/d404ad4b46dd4868a0ac28d09ffe0a0f/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=E4aB_yIFWw5zuisDBfPGyQ7JfZUb0YMzPajUMEZCFA0',
  registrar:     'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/4a59933c3dd442078b22db95ce8a6aa7/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=DNNNEfIlxHXc21YJIsjzhxx2Qa4IxCh_SkOuRR31ndw',
  enviar_otp:    'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/f2eb93ddbf044f7789ae8fa80518f549/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=PETK1l9jaK285bmPL18JpNof0wx313_h4jvRIUnkK6k',
  verificar_otp: 'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/be4d3dc86fee423ca46acef1e9846cf1/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=n4IRLz3NSael_eU0Qb2uNdhB2PBHJu8Oki0m_B4ki2w',
  subir_docs:    'https://default6c6f155728364f3ca89e87e334c217.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/419179b11cf744c1ada94f017f9839ad/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=17SUUUfYxOSA0S57MmeiNV1iZn-KD5ukBHVw_7gX15s',
};

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
  const flowUrl = FLOWS[path];

  if (!flowUrl) {
    return new Response(
      JSON.stringify({ error: 'Flow desconocido: ' + path }),
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
