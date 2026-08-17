// Molla smorzata: la curva che rende "Apple" un'animazione.
//
// Le curve di easing di Clutter descrivono una traiettoria decisa a priori.
// iOS non fa cosi': anima un oscillatore armonico smorzato, cioe' un oggetto
// con una massa attaccato a una molla. La differenza si vede in due punti.
//
//   - L'avvio e' piu' deciso: la molla e' massimamente carica all'istante zero,
//     quindi parte veloce invece di accelerare.
//   - L'arrivo non e' netto: supera di poco la misura finale e ci rientra.
//     E' quel sorpasso a far leggere l'oggetto come materia e non come numero.
//
// EASE_OUT_BACK imita il sorpasso, ma con un'ampiezza fissa e un'unica
// oscillazione: sembra un rimbalzo aggiunto sopra, non un corpo che si assesta.
//
// Nessuna dipendenza da gi://: sono funzioni pure, verificabili a mano.

// Oscillatore sotto-smorzato, normalizzato per partire da 0 e arrivare a 1.
//
//   pulsazione  quanto e' rigida la molla: piu' alta, piu' svelto tutto
//   smorzamento 0 = oscilla per sempre, 1 = nessun sorpasso
//
// Con smorzamento 0.72 il sorpasso e' di circa il 4%: si percepisce come
// elasticita' senza diventare un rimbalzo da cartone animato.
export function mollaApertura(t, pulsazione = 8.5, smorzamento = 0.72) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const wd = pulsazione * Math.sqrt(1 - smorzamento * smorzamento);
    return 1 - Math.exp(-smorzamento * pulsazione * t) *
        (Math.cos(wd * t) + (smorzamento * pulsazione / wd) * Math.sin(wd * t));
}

// Smorzamento critico: la via piu' rapida per fermarsi senza oscillare.
//
// In chiusura il sorpasso non va usato. Un oggetto che rimpicciolisce e poi
// rimbalza indietro non si legge come elastico, si legge come un difetto:
// l'occhio si aspetta che qualcosa che si ritira lo faccia in modo definitivo.
export function mollaChiusura(t, pulsazione = 9) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const x = pulsazione * t;
    return 1 - (1 + x) * Math.exp(-x);
}

// Applica una funzione di avanzamento alle transizioni gia' create da ease().
//
// Va chiamata SUBITO dopo ease(): prende le transizioni vive sull'attore e ne
// sostituisce la curva. Se la versione di Clutter non espone
// set_progress_func, non succede niente e resta valido il 'mode' passato a
// ease() — che va quindi scelto come ripiego sensato, non a caso.
// Se la firma della callback non e' quella attesa, la molla si spegne da sola
// e tutto torna alle curve di Clutter. Una molla che calcola NaN non produce
// un'animazione brutta: non ne produce nessuna, perche' la transizione salta
// al valore finale. Meglio una curva meno bella che nessun movimento.
let mollaUtilizzabile = true;

export function applicaMolla(attore, proprieta, fn) {
    if (!mollaUtilizzabile) return;

    for (const nome of proprieta) {
        const tr = attore.get_transition(nome);
        if (!tr?.set_progress_func) continue;
        try {
            tr.set_progress_func((...args) => {
                const [, trascorso, totale] = args;

                // Argomenti inattesi: si disattiva la molla per tutta la
                // sessione e si toglie la funzione da questa transizione,
                // cosi' riprende a valere il 'mode' passato a ease().
                if (!Number.isFinite(trascorso) || !Number.isFinite(totale) || totale <= 0) {
                    mollaUtilizzabile = false;
                    try { tr.set_progress_func(null); } catch (_) {}
                    return 1;
                }

                const v = fn(trascorso / totale);
                return Number.isFinite(v) ? v : trascorso / totale;
            });
        } catch (_) {
            mollaUtilizzabile = false;
        }
    }
}
