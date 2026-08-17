// Motore di animazione agganciato al ritmo dello schermo.
//
// Finora le animazioni giravano su GLib.timeout_add(16). Sedici millisecondi
// approssimano i 60 fotogrammi al secondo, ma il timer di GLib e' un timer di
// sistema: non sa niente di quando il compositore disegna davvero. I due ritmi
// scorrono liberi uno rispetto all'altro, quindi ogni tanto due passi cadono
// nello stesso fotogramma — e uno viene buttato — oppure nessuno ne cade in
// uno, e il fotogramma ripete il valore di prima.
//
// Il risultato non e' un rallentamento: e' un micro-tremolio irregolare. E'
// esattamente quel residuo che resta quando durate, curve e passi sono gia'
// tutti giusti, ed e' il motivo per cui un'animazione puo' sembrare "quasi"
// fluida senza mai esserlo del tutto.
//
// Clutter.Timeline invece si aggancia al frame clock dell'attore: emette un
// passo per ogni fotogramma che il compositore sta per disegnare, ne' uno di
// piu' ne' uno di meno, e il tempo che riporta e' quello reale trascorso. Con
// un display a 90 o 120 Hz si adegua da solo, cosa che un timer fisso non puo'
// fare per definizione.
//
// Se per qualche ragione la timeline non fosse costruibile, si ripiega sul
// vecchio timer: meno fluido, ma meglio di nessuna animazione.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

// passo(t)  con t da 0 a 1, chiamato una volta per fotogramma
// fine()    solo a completamento naturale, mai su interruzione
//
// Restituisce una funzione che interrompe l'animazione senza chiamare fine().
export function anima(attore, durata, passo, fine) {
    const ms = Math.max(1, Math.round(durata));

    try {
        const tl = new Clutter.Timeline({ actor: attore, duration: ms });

        tl.connect('new-frame', (_t, trascorso) => {
            passo(Math.min(1, trascorso / ms));
        });

        // 'stopped' scatta sia a fine corsa sia su stop(): il secondo
        // argomento distingue i due casi. Su interruzione non si chiama fine(),
        // perche' e' chi interrompe a decidere lo stato finale.
        tl.connect('stopped', (_t, completata) => {
            if (!completata) return;
            passo(1);
            fine?.();
        });

        tl.start();
        return () => { try { tl.stop(); } catch (_) {} };
    } catch (_) {
        // Ripiego: timer di sistema, come prima.
        const passi = Math.max(8, Math.round(ms / 16));
        const intervallo = Math.max(16, Math.round(ms / passi));
        let i = 0;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervallo, () => {
            i++;
            const t = Math.min(1, i / passi);
            passo(t);
            if (t >= 1) { fine?.(); return GLib.SOURCE_REMOVE; }
            return GLib.SOURCE_CONTINUE;
        });
        return () => GLib.source_remove(id);
    }
}
