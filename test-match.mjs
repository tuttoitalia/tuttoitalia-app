import { pertinente, mononomeIsolato, isPacchetto } from './fonti.mjs';

// [nome cercato, titolo evento, campo artista, atteso]
const CASI = [
  // ── devono PASSARE (veri positivi, oggi in calendario e corretti) ──
  ['Pupo', 'Pupo', null, true],
  ['Arisa', 'Arisa', null, true],
  ['Anna', 'ANNA - Vera Baddie Tour', null, true],
  ['Olly', 'Olly - Tutta Vita Tour', null, true],
  ['Nomadi', 'Nomadi live', null, true],
  ['Ligabue', 'Ligabue 2027', null, true],
  ['Ultimo', 'Ultimo: World Tour', null, true],
  ['Il Volo', 'Il Volo in concerto', null, true],
  ['Pooh', 'Pooh - Amici x Sempre', null, true],
  ['Alfa', 'ALFA (IT)', null, true],
  ['Anna', 'qualsiasi cosa', 'Anna', true],                       // campo artista esatto
  ['Laura Pausini', 'Laura Pausini', null, true],                 // nome lungo
  ['Ludovico Einaudi', 'Eine Hommage an Ludovico Einaudi', null, true],
  ['Gianna Nannini', 'Gianna Nannini - GIANNAGOLD', null, true],

  // ── devono essere RESPINTI (i falsi positivi realmente finiti online) ──
  ['Anna', 'Anna Lipiak - Klavier', null, false],
  ['Anna', 'Anna Rossinelli - Heat Tour 2026', null, false],
  ['Anna', 'Anna Rossinelli im Hotel Wetterhorn', null, false],
  ['Anna', 'ANNA MAE - Sole Traveller', null, false],
  ['Anna', 'ANNA NETREBKOS Debüt in Basel', null, false],
  ['Blanco', 'Blanco White', null, false],
  ['Blanco', 'Blanco White (UK)', null, false],
  ['Clara', 'Clara Dietlin & Kojiro Okada', null, false],
  ['Clara', 'Clara Lösel 2027', null, false],
  ['Madame', 'Madame Pylinska und das Geheimnis von Chopin', null, false],
  ['Noemi', 'Noemi Beza', null, false],
  // ── falsi positivi storici già noti (regressione) ──
  ['Ultimo', 'Ricardo Montaner - El Ultimo Regreso', null, false],
  ['Olly', 'Jolly & the Flytrap', null, false],
  ['Nitro', 'Don Toliver: NITROUS', null, false],
  ['Alessandra Amoroso', 'CA7RIEL & Paco Amoroso', null, false],
  ['Anna', 'Ariel Posen: Bannatyne Tour', null, false],
];

let ok = 0, ko = 0;
for (const [cercato, titolo, artista, atteso] of CASI) {
  const res = pertinente({ nome: titolo, artista }, cercato);
  const esito = res === atteso;
  esito ? ok++ : ko++;
  console.log(`${esito ? '  ok  ' : '  FALLITO '} ${cercato.padEnd(18)} vs "${titolo}"  -> ${res} (atteso ${atteso})`);
}

console.log('\n── pacchetti (non sono eventi) ──');
const PACCHETTI = [
  ['20. Züri-Wiesn - Zusätz. Champagner-Paket (1 Magnumflasche)', true],
  ['Eros Ramazzotti - You Are Special Hospitality Package', true],
  ['Laura Pausini - VIP Package', true],
  ['Laura Pausini', false],
  ['Zucchero', false],
  ['Nino D\'Angelo - I miei meravigliosi anni \'80', false],
];
for (const [t, atteso] of PACCHETTI) {
  const res = isPacchetto(t);
  const esito = res === atteso;
  esito ? ok++ : ko++;
  console.log(`${esito ? '  ok  ' : '  FALLITO '} "${t.slice(0, 52)}" -> ${res}`);
}

console.log(`\n${ok} ok · ${ko} falliti`);
process.exit(ko ? 1 : 0);
