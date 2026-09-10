#!/usr/bin/env node
/**
 * INVITO/attivazione degli utenti importati da Base44: manda a chi non ha ancora
 * impostato la password un'email "attiva il tuo account" (da redazione@tuttoitalia.ch)
 * col link per scegliere la password. Riusa l'endpoint reset-request con
 * contesto='invito' (email di benvenuto, link valido 7 giorni).
 *
 *   node invita-utenti-base44.mjs            # ANTEPRIMA: conta soltanto, NON invia
 *   node invita-utenti-base44.mjs --invia    # invia davvero
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (progetto di my.tuttoitalia.ch).
 * Opz.: SITO_ORIGIN (base del link nell'email; default anteprima; dopo il
 * passaggio a www metti https://www.tuttoitalia.ch), AUTH_URL (endpoint auth).
 */
const INVIA = process.argv.includes('--invia')
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('✗ Mancano SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
const SUPA = SUPABASE_URL.replace(/\/$/, '')
const supaH = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
const SITO_ORIGIN = process.env.SITO_ORIGIN || 'https://anteprima.tuttoitalia.ch'
const AUTH_URL = process.env.AUTH_URL || 'https://my.tuttoitalia.ch/api/pubblico/auth'
const sleep = ms => new Promise(r => setTimeout(r, ms))

// importati non ancora attivati: origine='base44' e password NON valida (senza ':')
async function daInvitare() {
  const out = []
  let offset = 0
  for (;;) {
    const r = await fetch(`${SUPA}/rest/v1/commenti_utenti?origine=eq.base44&select=email,pass_hash&limit=1000&offset=${offset}`, { headers: supaH })
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const page = await r.json()
    for (const u of page) if (u.email && !(u.pass_hash || '').includes(':')) out.push(u.email)
    if (page.length < 1000) break
    offset += 1000
  }
  return out
}

const lista = await daInvitare()
console.log(`Utenti Base44 importati e NON ancora attivati: ${lista.length}`)
console.log(`Link nell'email → ${SITO_ORIGIN}/reset-password · endpoint → ${AUTH_URL}`)

if (!INVIA) { console.log('\nANTEPRIMA (nessun invio). Rilancia con --invia per mandare le email.'); process.exit(0) }

let ok = 0, ko = 0
for (const email of lista) {
  try {
    const r = await fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITO_ORIGIN },
      body: JSON.stringify({ action: 'reset-request', email, lang: 'it', contesto: 'invito' }),
    })
    r.ok ? ok++ : ko++
  } catch { ko++ }
  if ((ok + ko) % 25 === 0) console.log(`  ${ok + ko}/${lista.length} (ok ${ok}, errori ${ko})`)
  await sleep(300) // gentile con Resend / rate limit
}
console.log(`FATTO. Email di invito richieste: ok ${ok}, errori ${ko}.`)
