// ============================================================
// guide-bozze.mjs: bozze delle guide pratiche dei servizi TuttoItalia
// ============================================================
// Prende dalla scaletta (tabella `guide`) le guide in stato "bozza" ancora
// senza testo, dei servizi "in_preparazione" o "lanciato", e chiede a Claude
// (tool web_search) di scriverle partendo da fonti ufficiali. La guida passa
// a "in_revisione": una persona la controlla e la pubblica dal pannello.
// Da qui non si pubblica mai nulla.
//
// Struttura delle tabelle: supabase/servizi.sql
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Flag: DRY_RUN=1 -> non scrive; GUIDE_PER_GIRO (default 2); GUIDA=<slug> per una sola
// ============================================================

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = ['1', 'true'].includes(String(process.env.DRY_RUN));
const MODEL = process.env.GUIDE_MODEL || 'claude-sonnet-5-5';
const PER_GIRO = Math.max(1, Number(process.env.GUIDE_PER_GIRO) || 2);
const SOLO = (process.env.GUIDA || '').trim();

if (!ANTHROPIC_KEY || !SUPA_URL || !SUPA_KEY) {
  console.error('✗ Missing env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const oggi = new Date().toISOString().slice(0, 10);
const traUnAnno = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
const supaHeaders = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' };
const supa = (path, opts = {}) =>
  fetch(`${SUPA_URL}/rest/v1/${path}`, { ...opts, headers: { ...supaHeaders, ...(opts.headers || {}) } });

// Istruzioni fisse nel system (in cache); la guida del giro va nel messaggio.
const SYSTEM = `Scrivi guide pratiche per TuttoItalia (tuttoitalia.ch), il portale degli italiani all'estero. Il lettore è un italiano che vive nel paese indicato, spesso da poco: vuole sapere cosa fare, entro quando e a chi rivolgersi.

Metodo:
- Cerca sul web e apri le fonti UFFICIALI (amministrazioni federali e cantonali, enti pubblici, consolati, INPS, Agenzia delle Entrate). Siti privati solo come appoggio, mai come unica fonte di una regola.
- Ogni cifra, soglia o scadenza deve venire da una pagina che hai aperto. Se un dato varia per regione e non lo trovi per tutte, dillo e indica dove si controlla.
- Se una regola è incerta o cambiata di recente, scrivilo in chiaro invece di indovinare.
- Non dare consulenza personale: chiudi indicando quando conviene rivolgersi a un professionista.

Stile: italiano semplice, frasi brevi, parla al lettore con il "tu". Struttura in markdown: un paragrafo iniziale che risponde subito, poi sezioni con titoli "##", elenchi solo per passi o voci parallele, tabelle dove ci sono dati per regione. Lunghezza 600-1200 parole. Niente emoji. Non usare mai il trattino lungo (U+2014). Mai una virgola subito prima o subito dopo "e".

Rispondi ESCLUSIVAMENTE con un oggetto JSON (nessun testo prima o dopo, nessun blocco di codice):
{"sommario": "una o due frasi per l'anteprima", "corpo": "la guida in markdown", "fonti": ["url di ogni pagina ufficiale usata"], "regioni": ["sigle delle regioni o cantoni a cui si applica"] oppure null se vale per tutto il paese, "dubbi": "cosa il revisore deve controllare con più attenzione, o null"}`;

async function callAnthropic(messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 15 }],
      cache_control: { type: 'ephemeral' },
      messages,
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function scrivi(guida, paese) {
  const messages = [{
    role: 'user',
    content: `Oggi è ${oggi}. Paese: ${paese}. Servizio: ${guida.servizi.nome}.\nTitolo: ${guida.titolo}\nCosa deve coprire: ${guida.traccia || guida.titolo}`,
  }];
  let data;
  for (let i = 0; i < 10; i++) {   // pause_turn: si riprende finche' il modello chiude
    data = await callAnthropic(messages);
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }
  const testo = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const m = testo.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`nessun oggetto JSON (stop_reason=${data.stop_reason})`);
  return JSON.parse(m[0]);
}

// Rete di sicurezza sui testi: niente trattino lungo, niente virgola attaccata a "e".
const EM = String.fromCharCode(0x2014);
function pulisci(v) {
  if (v == null) return null;
  const t = String(v).replace(new RegExp(`\\s*${EM}\\s*`, 'g'), ': ')
    .replace(/,(\s+)(e|ed|und|and|et)\b/g, '$1$2').replace(/\b(e|ed|und|and|et),/g, '$1').trim();
  return t || null;
}

const NOMI_PAESE = { CH: 'Svizzera', DE: 'Germania', FR: 'Francia', BE: 'Belgio', GB: 'Regno Unito', ES: 'Spagna' };

function valida(out) {
  const corpo = pulisci(out.corpo);
  const fonti = (Array.isArray(out.fonti) ? out.fonti : []).filter((u) => /^https?:\/\//.test(u));
  if (!corpo || corpo.split(/\s+/).length < 300) throw new Error('guida troppo corta o vuota');
  if (!fonti.length) throw new Error('nessuna fonte: la guida non entra');
  const regioni = Array.isArray(out.regioni) && out.regioni.length
    ? out.regioni.map((r) => String(r).toUpperCase().replace(/^[A-Z]{2}-/, '')).filter((r) => /^[A-Z0-9]{2,3}$/.test(r))
    : null;
  const dubbi = pulisci(out.dubbi);
  return {
    sommario: pulisci(out.sommario),
    // I dubbi per il revisore restano in testa al testo in revisione: si tolgono prima di pubblicare.
    corpo: dubbi ? `> **Da controllare in revisione:** ${dubbi}\n\n${corpo}` : corpo,
    fonti,
    cantoni: regioni,
    stato: 'in_revisione',
    ricontrollo_entro: traUnAnno,
  };
}

(async () => {
  console.log(`▸ Bozze guide (${oggi}, modello ${MODEL})${DRY_RUN ? ' [DRY_RUN]' : ''}`);
  let q = 'guide?select=id,slug,titolo,traccia,paesi,servizi!inner(nome,stato)'
    + '&stato=eq.bozza&corpo=is.null&servizi.stato=in.(in_preparazione,lanciato)&order=created_at';
  if (SOLO) q = `guide?select=id,slug,titolo,traccia,paesi,servizi!inner(nome,stato)&slug=eq.${encodeURIComponent(SOLO)}`;
  const r = await supa(q);
  // Tabelle non ancora create: si esce senza errore.
  if (r.status === 404 || r.status === 400) { console.log('  tabelle dei servizi assenti: esegui supabase/servizi.sql. Esco.'); return; }
  if (!r.ok) throw new Error(`lettura guide ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const guide = (await r.json()).slice(0, SOLO ? 1 : PER_GIRO);
  if (!guide.length) { console.log('  nessuna guida da scrivere. Esco.'); return; }

  let scritte = 0;
  for (const g of guide) {
    const paese = (g.paesi && g.paesi.length === 1) ? (NOMI_PAESE[g.paesi[0]] || g.paesi[0]) : 'qualunque paese (pratiche verso l\'Italia)';
    console.log(`  · ${g.slug} (${paese})`);
    let riga;
    try {
      riga = valida(await scrivi(g, paese));
    } catch (e) {
      console.error(`    ✗ ${e.message}`);
      continue;   // una guida che fallisce non blocca le altre
    }
    console.log(`    ${riga.corpo.split(/\s+/).length} parole, ${riga.fonti.length} fonti`);
    if (DRY_RUN) { console.log(riga.corpo.slice(0, 600) + '\n    …'); continue; }
    const up = await supa(`guide?id=eq.${g.id}&stato=eq.bozza`, { method: 'PATCH', body: JSON.stringify(riga) });
    if (!up.ok) throw new Error(`aggiornamento guida ${up.status}: ${(await up.text()).slice(0, 200)}`);
    scritte++;
  }
  console.log(DRY_RUN ? '  DRY_RUN: niente scritto.' : `✓ Fatto: guide passate in revisione: ${scritte}`);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
