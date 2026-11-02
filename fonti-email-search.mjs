// ============================================================
// fonti-email-search.mjs: cerca le email mancanti delle Fonti foto
// ============================================================
// Le fonti foto (consorzi, enti, fotografi: my.tuttoitalia.ch/admin/fonti-foto) senza
// email vengono cercate una per una: Claude (API Anthropic, tool web_search + web_fetch)
// apre il sito ufficiale e le pagine contatti e propone l'indirizzo per la stampa o
// quello generale. Gira come GitHub Action (egress libero) e scrive DIRETTO su Supabase.
//
// Rete di sicurezza contro gli indirizzi inventati: un'email entra nel campo email SOLO
// se compare nel testo delle pagine che il modello ha davvero letto. Se no finisce nelle
// note come "da verificare" e la fonte resta in "Email mancante".
// Tocca solo le fonti ancora senza email: niente sovrascritture, niente email inviate.
//
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Flag: DRY_RUN=1 -> non scrive, mostra solo cosa troverebbe
//       FONTI_LIMIT=3 -> solo le prime N fonti (prova)
// ============================================================

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = ['1', 'true'].includes(String(process.env.DRY_RUN));
const LIMIT = process.env.FONTI_LIMIT ? parseInt(process.env.FONTI_LIMIT, 10) : null;
const MODEL = process.env.FONTI_MODEL || 'claude-opus-5-5';

if (!ANTHROPIC_KEY || !SUPA_URL || !SUPA_KEY) {
  console.error('✗ Missing env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const oggi = new Date().toISOString().slice(0, 10);
const supaHeaders = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function prompt(f) {
  const chi = f.tipo === 'fotografo' ? 'fotografo/fotografa professionista' : 'ente italiano (consorzio di tutela, associazione o istituzione)';
  return `Devi trovare l'indirizzo email ufficiale di questo ${chi}, a cui la redazione di tuttoitalia.ch (testata svizzera dedicata all'Italia) vuole scrivere per chiedere fotografie da pubblicare con credito.

Nome: ${f.nome}
${f.prodotto ? `Prodotto: ${f.prodotto}\n` : ''}${f.regione ? `Regione: ${f.regione}\n` : ''}${f.citta ? `Sede: ${f.citta}\n` : ''}${f.sito ? `Sito noto: ${f.sito}\n` : ''}${f.note ? `Appunti: ${f.note}\n` : ''}
Come procedere: cerca il sito ufficiale, poi APRI con web_fetch la pagina contatti (o "chi siamo", "privacy", "ufficio stampa", piè di pagina) e leggi l'indirizzo dal testo della pagina. Preferisci un indirizzo per la stampa o la comunicazione (ufficiostampa@, stampa@, comunicazione@, press@); altrimenti quello generale (info@, segreteria@, il nome del consorzio). Va bene anche una fonte istituzionale recente (Regione, Camera di commercio, MASAF, Qualivita) se il sito non c'è.
Regole: MAI una PEC (pec.it, legalmail, postacert) come email; MAI indirizzi di agenzie esterne, di singoli produttori o personali (gmail, libero, virgilio) se esiste un indirizzo dell'ente; MAI costruire un indirizzo dal nome del dominio: solo indirizzi che hai letto scritti in una pagina. Se non trovi nulla rispondi con email null.

Rispondi ESCLUSIVAMENTE con un oggetto JSON (niente testo prima o dopo, niente markdown):
{"email": "indirizzo o null", "tipo_email": "stampa|generale|personale|null", "sito": "dominio del sito ufficiale o null", "telefono": "o null", "fonte_url": "URL esatto della pagina in cui hai letto l'email, o null", "affidabilita": "alta (sito ufficiale) | media (fonte istituzionale o di terzi) | bassa", "nota": "una riga: dove l'hai trovata o perché non c'è"}
Niente trattino lungo (em dash): usa due punti o virgole. Mai una virgola prima di "e".`;
}

async function callAnthropic(messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      // in caso di rifiuto dei filtri di sicurezza la richiesta passa da sola a un altro modello
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      fallbacks: 'default',
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 6 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6 },
      ],
      messages,
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function cerca(f) {
  // Con i tool web il modello può fermarsi in "pause_turn": si riprende finché non chiude.
  const messages = [{ role: 'user', content: prompt(f) }];
  const blocchi = [];
  let data;
  for (let i = 0; i < 6; i++) {
    data = await callAnthropic(messages);
    blocchi.push(...(data.content || []));
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }
  if (data.stop_reason === 'refusal') throw new Error('richiesta rifiutata dal modello');
  const testo = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const m = testo.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`nessun JSON nella risposta (stop_reason=${data.stop_reason})`);
  const out = JSON.parse(m[0]);
  // Testo di tutto quello che il modello ha letto (risultati di ricerca e pagine aperte)
  const letto = JSON.stringify(blocchi.filter((b) => /_tool_result$/.test(b.type || ''))).toLowerCase();
  return { out, letto };
}

function pulisci(v, max = 1000) {
  if (v == null || v === 'null') return null;
  const t = String(v).replace(/—/g, ': ').replace(/,(\s+)(e|ed|und|and|et)\b/g, '$1$2').trim();
  return t ? t.slice(0, max) : null;
}

function valuta(f, { out, letto }) {
  const email = (pulisci(out.email, 200) || '').toLowerCase();
  const nota = pulisci(out.nota, 400);
  const base = { sito: pulisci(out.sito, 300), telefono: pulisci(out.telefono, 60), fonte_url: pulisci(out.fonte_url) };
  if (!email || !EMAIL_RE.test(email)) return { esito: 'non trovata', nota, ...base };
  if (/pec\.|legalmail|postacert/.test(email)) return { esito: 'solo PEC', nota: `PEC ${email} (non usata). ${nota || ''}`.trim(), ...base };
  if (!letto.includes(email)) return { esito: 'da verificare', nota: `Possibile email ${email}, non trovata nel testo letto: da verificare. ${nota || ''}`.trim(), ...base };
  const stampa = out.tipo_email === 'stampa';
  return {
    esito: 'trovata', ...base, nota,
    email: stampa ? null : email, email_stampa: stampa ? email : null,
    affidabilita: ['alta', 'media', 'bassa'].includes(out.affidabilita) ? out.affidabilita : 'media',
  };
}

async function fontiSenzaEmail() {
  const q = 'select=id,nome,tipo,prodotto,regione,citta,sito,telefono,note,stato&email=is.null&email_stampa=is.null&order=regione.asc,nome.asc';
  const r = await fetch(`${SUPA_URL}/rest/v1/fonti_foto?${q}`, { headers: supaHeaders });
  if (!r.ok) throw new Error(`lettura fonti_foto ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const righe = await r.json();
  return LIMIT ? righe.slice(0, LIMIT) : righe;
}

async function aggiorna(f, v) {
  const nota = `[${oggi}, ricerca automatica] ${v.esito}${v.nota ? `: ${v.nota}` : ''}`;
  const payload = { note: [f.note, nota].filter(Boolean).join('\n'), updated_at: new Date().toISOString() };
  if (v.sito && !f.sito) payload.sito = v.sito;
  if (v.telefono && !f.telefono) payload.telefono = v.telefono;
  if (v.esito === 'trovata') {
    if (v.email) payload.email = v.email;
    if (v.email_stampa) payload.email_stampa = v.email_stampa;
    payload.fonte_url = v.fonte_url;
    payload.affidabilita = v.affidabilita;
    payload.fonte = 'ricerca automatica sui siti ufficiali';
    if (f.stato === 'email_mancante') payload.stato = 'da_contattare';
  }
  // Filtro email=is.null: se nel frattempo qualcuno l'ha inserita a mano non si tocca niente
  const r = await fetch(`${SUPA_URL}/rest/v1/fonti_foto?id=eq.${f.id}&email=is.null&email_stampa=is.null`, {
    method: 'PATCH', headers: { ...supaHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`aggiornamento ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

(async () => {
  console.log(`▸ Email mancanti delle Fonti foto (${oggi}, modello ${MODEL})${DRY_RUN ? ' [DRY_RUN]' : ''}`);
  const fonti = await fontiSenzaEmail();
  console.log(`  ${fonti.length} fonti senza email`);
  const conteggio = {};
  for (const f of fonti) {
    let v;
    try {
      v = valuta(f, await cerca(f));
    } catch (e) {
      v = { esito: 'errore', nota: e.message.slice(0, 200) };
    }
    conteggio[v.esito] = (conteggio[v.esito] || 0) + 1;
    console.log(`   · ${f.nome}: ${v.esito}${v.email || v.email_stampa ? ` → ${v.email || v.email_stampa}` : ''}${v.fonte_url ? ` (${v.fonte_url})` : ''}`);
    if (!DRY_RUN && v.esito !== 'errore') await aggiorna(f, v);
  }
  console.log(`✓ Fatto: ${Object.entries(conteggio).map(([k, n]) => `${k} ${n}`).join(', ') || 'niente da cercare'}${DRY_RUN ? ' (DRY_RUN: niente scritto)' : ''}`);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
