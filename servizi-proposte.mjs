// ============================================================
// servizi-proposte.mjs: candidati per le schede dei servizi TuttoItalia
// ============================================================
// Per i servizi "in_preparazione" o "lanciato" prende le categorie cercate
// da piu' tempo (fiduciari, dentisti, agenzie...) e chiede a Claude (tool
// web_search) professionisti e attivita' italofoni in Svizzera. Ogni
// candidato finisce in `schede_proposte`: la ricerca propone, una persona
// verifica e approva dal pannello. Niente viene pubblicato da qui.
//
// Struttura delle tabelle: supabase/servizi.sql
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Flag: DRY_RUN=1 -> non scrive; CATEGORIE_PER_GIRO (default 2)
// ============================================================

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = ['1', 'true'].includes(String(process.env.DRY_RUN));
const MODEL = process.env.SERVIZI_MODEL || 'claude-sonnet-5-5';
const PER_GIRO = Math.max(1, Number(process.env.CATEGORIE_PER_GIRO) || 2);

if (!ANTHROPIC_KEY || !SUPA_URL || !SUPA_KEY) {
  console.error('✗ Missing env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const oggi = new Date().toISOString().slice(0, 10);
const supaHeaders = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' };
const slug = (s) => (s || '').toString().toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const CANTONI = new Set(['AG','AI','AR','BE','BL','BS','FR','GE','GL','GR','JU','LU','NE','NW','OW','SG','SH','SO','SZ','TG','TI','UR','VD','VS','ZG','ZH']);

// Istruzioni fisse nel system (in cache); la categoria del giro va nel messaggio.
const SYSTEM = `Sei un ricercatore per TuttoItalia (tuttoitalia.ch), il portale degli italiani in Svizzera. Costruiamo elenchi verificati di professionisti e attività dove ci si può rivolgere IN ITALIANO.

Per la categoria che ti indico cerca sul web candidati REALI in Svizzera (tutte le regioni, priorità a Zurigo, Basilea, Berna, Ginevra, Losanna, San Gallo, Lucerna; il Ticino solo se il servizio è rivolto anche a chi vive oltralpe). Fai diverse ricerche, anche in tedesco e francese ("italienisch sprechend", "parle italien"), e apri i siti ufficiali per controllare.

Tieni solo chi mostra una prova che si può parlare italiano: sito in italiano, lingue elencate, nome del titolare con indicazione delle lingue, iscrizione a un elenco italofono. Niente prova = scarta. Non inventare mai indirizzi, telefoni o email: se non li hai visti scrivi null.

Rispondi ESCLUSIVAMENTE con un array JSON (nessun testo prima o dopo, nessun markdown), 5-15 oggetti:
{"nome": "...", "tipo": "professionista|azienda|negozio|ristorante|ente|associazione", "descrizione": "una frase su cosa offre", "indirizzo": "via e numero o null", "cap": "o null", "citta": "...", "cantone": "sigla di 2 lettere", "telefono": "o null", "email": "o null", "sito": "url o null", "lingue": ["it","de",...], "fonte_url": "pagina realmente aperta (obbligatoria)", "motivo": "la prova che parla italiano"}
Niente emoji. Non usare mai il trattino lungo (U+2014); mai una virgola prima o dopo "e".`;

async function supa(path, opts = {}) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, { ...opts, headers: { ...supaHeaders, ...(opts.headers || {}) } });
  return r;
}

async function callAnthropic(messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 12 }],
      cache_control: { type: 'ephemeral' },
      messages,
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function cerca(categoria, servizio, giaNote) {
  const evita = giaNote.length ? `\n\nGià in elenco o in coda, non riproporli: ${giaNote.slice(0, 80).join('; ')}.` : '';
  const messages = [{
    role: 'user',
    content: `Oggi è ${oggi}. Servizio: ${servizio}. Categoria: ${categoria.nome}.\nChi cercare: ${categoria.ricerca_hint || categoria.nome}.${evita}`,
  }];
  let data;
  for (let i = 0; i < 8; i++) {   // pause_turn: si riprende finche' il modello chiude
    data = await callAnthropic(messages);
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }
  const testo = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const m = testo.match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`nessun array JSON (stop_reason=${data.stop_reason})`);
  return JSON.parse(m[0]);
}

// Rete di sicurezza sui testi: niente trattino lungo, niente virgola attaccata a "e".
const EM = String.fromCharCode(0x2014);
function pulisci(v) {
  if (v == null) return null;
  const t = String(v).trim().replace(new RegExp(`\\s*${EM}\\s*`, 'g'), ': ')
    .replace(/,(\s+)(e|ed|und|and|et)\b/g, '$1$2').replace(/\b(e|ed|und|and|et),/g, '$1');
  return t || null;
}

const dominio = (u) => {
  try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return null; }
};
// Stessa regola di dedup_key in schede e schede_proposte: dominio del sito se c'e',
// altrimenti nome+cap (o nome+citta').
const chiave = (o) => (o.sito && dominio(o.sito)) || `${slug(o.nome)}-${slug(o.cap || o.citta)}`;

function normalizza(raw, categoria_id) {
  const visti = new Set();
  const out = [];
  for (const o of Array.isArray(raw) ? raw : []) {
    const nome = pulisci(o.nome);
    if (!nome || !o.fonte_url) continue;     // senza nome o fonte non entra
    const cantone = String(o.cantone || '').toUpperCase();
    const riga = {
      categoria_id,
      nome,
      tipo: pulisci(o.tipo),
      descrizione: pulisci(o.descrizione),
      indirizzo: pulisci(o.indirizzo),
      cap: pulisci(o.cap),
      citta: pulisci(o.citta),
      cantone: CANTONI.has(cantone) ? cantone : null,
      telefono: pulisci(o.telefono),
      email: pulisci(o.email),
      sito: pulisci(o.sito),
      lingue: Array.isArray(o.lingue) ? o.lingue.map((l) => String(l).toLowerCase().slice(0, 2)) : null,
      fonte_url: o.fonte_url,
      motivo: pulisci(o.motivo),
      trovata_il: oggi,
    };
    riga.dedup_key = chiave(riga);
    if (visti.has(riga.dedup_key)) continue;
    visti.add(riga.dedup_key);
    out.push(riga);
  }
  return out;
}

(async () => {
  console.log(`▸ Proposte schede servizi (${oggi}, modello ${MODEL})${DRY_RUN ? ' [DRY_RUN]' : ''}`);

  // Categorie dei servizi attivi, dalla cercata meno di recente (mai cercate per prime).
  const r = await supa('categorie?select=id,slug,nome,ricerca_hint,ultima_ricerca,servizi!inner(slug,nome,stato)'
    + '&servizi.stato=in.(in_preparazione,lanciato)&order=ultima_ricerca.asc.nullsfirst');
  // Tabelle non ancora create: si esce senza errore (niente mail di fallimento a ogni giro).
  if (r.status === 404 || r.status === 400) { console.log('  tabelle dei servizi assenti: esegui supabase/servizi.sql. Esco.'); return; }
  if (!r.ok) throw new Error(`lettura categorie ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const categorie = (await r.json()).slice(0, PER_GIRO);
  if (!categorie.length) { console.log('  nessun servizio in preparazione o lanciato. Esco.'); return; }

  // Chiavi gia' note (schede pubblicate e proposte in qualunque stato): uno scartato non torna.
  const [rs, rp] = await Promise.all([supa('schede?select=dedup_key,nome'), supa('schede_proposte?select=dedup_key,nome')]);
  if (!rs.ok || !rp.ok) throw new Error(`lettura chiavi ${rs.status}/${rp.status}`);
  const note = [...(await rs.json()), ...(await rp.json())];
  const chiaviNote = new Set(note.map((x) => x.dedup_key));

  let totale = 0;
  for (const cat of categorie) {
    console.log(`  · ${cat.servizi.nome} / ${cat.nome}`);
    let righe;
    try {
      righe = normalizza(await cerca(cat, cat.servizi.nome, note.map((x) => x.nome)), cat.id);
    } catch (e) {
      console.error(`    ✗ ricerca fallita: ${e.message}`);
      continue;   // una categoria che fallisce non blocca le altre
    }
    const nuove = righe.filter((o) => !chiaviNote.has(o.dedup_key));
    nuove.forEach((o) => chiaviNote.add(o.dedup_key));
    console.log(`    ${righe.length} valide, ${righe.length - nuove.length} gia' note: ${nuove.length} nuove`);
    for (const o of nuove) console.log(`     - ${o.nome} (${o.citta || '?'} ${o.cantone || ''}) ${o.sito || ''}`);
    if (DRY_RUN) continue;

    if (nuove.length) {
      const ins = await supa('schede_proposte?on_conflict=dedup_key', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify(nuove),
      });
      if (!ins.ok) throw new Error(`inserimento proposte ${ins.status}: ${(await ins.text()).slice(0, 300)}`);
      totale += (await ins.json()).length;
    }
    const upd = await supa(`categorie?id=eq.${cat.id}`, {
      method: 'PATCH', body: JSON.stringify({ ultima_ricerca: new Date().toISOString() }),
    });
    if (!upd.ok) console.error(`    ✗ aggiornamento ultima_ricerca ${upd.status}`);
  }
  console.log(DRY_RUN ? '  DRY_RUN: niente scritto.' : `✓ Fatto: proposte inserite: ${totale}`);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
