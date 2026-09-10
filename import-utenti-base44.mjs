#!/usr/bin/env node
/**
 * Import SILENZIOSO degli utenti registrati su Base44 (entità User) nel sistema
 * membri del sito (tabella Supabase `commenti_utenti`). NON manda email.
 *
 * Le password NON si migrano (Base44 le gestisce col suo login): ogni utente
 * importato riceve una password NON valida (senza ':', quindi nessun login la
 * verifica) e dovrà impostarne una col flusso "Password dimenticata?" / invito.
 * Marchiati con origine='base44'. Idempotente: salta le email già presenti.
 *
 *   node import-utenti-base44.mjs [--dry]
 *
 * Env: BASE44_APP_ID, BASE44_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * (SUPABASE_* devono puntare al progetto dove vive commenti_utenti = quello di
 * my.tuttoitalia.ch). Richiede la colonna `origine` su commenti_utenti.
 */
import crypto from 'node:crypto'

const DRY = process.argv.includes('--dry')
const { BASE44_APP_ID, BASE44_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
if (!BASE44_APP_ID || !BASE44_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('✗ Mancano env: BASE44_APP_ID, BASE44_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY'); process.exit(1)
}
const SUPA = SUPABASE_URL.replace(/\/$/, '')
const supaH = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const passNonValida = () => 'imported-' + crypto.randomBytes(12).toString('hex') // senza ':' → verifyPassword sempre false

async function fetchBase44Users() {
  const r = await fetch(`https://base44.app/api/apps/${BASE44_APP_ID}/entities/User`, { headers: { api_key: BASE44_API_KEY } })
  if (!r.ok) throw new Error(`Base44 ${r.status}: ${(await r.text()).slice(0, 300)}`)
  const arr = await r.json()
  if (!Array.isArray(arr)) throw new Error('Base44 User: risposta non-array')
  return arr
}

async function emailEsistenti() {
  const set = new Set()
  let offset = 0
  for (;;) {
    const r = await fetch(`${SUPA}/rest/v1/commenti_utenti?select=email&limit=1000&offset=${offset}`, { headers: supaH })
    if (!r.ok) throw new Error(`Supabase select ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const page = await r.json()
    page.forEach(u => set.add((u.email || '').toLowerCase()))
    if (page.length < 1000) break
    offset += 1000
  }
  return set
}

const users = await fetchBase44Users()
console.log(`Utenti Base44 (entità User): ${users.length}`)

// mappa → {email, nome}, valida email, dedup interno
const visti = new Set()
const candidati = []
for (const u of users) {
  const email = (u.email || u.user_email || '').trim().toLowerCase()
  if (!EMAIL_RE.test(email) || visti.has(email)) continue
  visti.add(email)
  const nome = (u.full_name || u.nome || u.name || u.display_name || '').trim() || email.split('@')[0]
  candidati.push({ email, nome })
}
console.log(`Con email valida: ${candidati.length}`)

const esistenti = await emailEsistenti()
const nuovi = candidati.filter(c => !esistenti.has(c.email))
console.log(`Già presenti in commenti_utenti: ${candidati.length - nuovi.length} · da importare: ${nuovi.length}`)

if (DRY) { console.log('DRY: nessuna scrittura.'); process.exit(0) }
if (nuovi.length === 0) { console.log('Niente da importare.'); process.exit(0) }

// insert a blocchi (ignora duplicati per il vincolo unique su email)
let fatti = 0
for (let i = 0; i < nuovi.length; i += 500) {
  const blocco = nuovi.slice(i, i + 500).map(c => ({ email: c.email, nome: c.nome, pass_hash: passNonValida(), origine: 'base44' }))
  const r = await fetch(`${SUPA}/rest/v1/commenti_utenti?on_conflict=email`, {
    method: 'POST', headers: { ...supaH, Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(blocco),
  })
  if (!r.ok) { console.error(`✗ insert blocco ${i}: ${r.status} ${(await r.text()).slice(0, 200)}`); process.exit(1) }
  fatti += blocco.length
  console.log(`  importati ${fatti}/${nuovi.length}`)
}
console.log(`FATTO. Importati ${fatti} utenti (origine='base44', senza password valida). Nessuna email inviata.`)
