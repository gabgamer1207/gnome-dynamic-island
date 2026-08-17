// I dispositivi Bluetooth collegati, nella scheda aperta.
//
// Un cerchio per dispositivo: l'anello dice la carica, l'icona dentro dice che
// cos'e', il numero sotto dice quanto. E' la stessa lettura di un orologio —
// forma prima, cifra dopo — ed e' il motivo per cui funziona anche di sfuggita:
// un anello quasi vuoto lo riconosci senza leggere il numero.
//
// PERCHE' UNA SOLA ATTIVITA' E NON UNA PER DISPOSITIVO
//
// Ogni dispositivo potrebbe essere un'attivita' a se': la catena le reggerebbe.
// Ma il pallino accanto all'isola serve a passare da una COSA che stai facendo
// a un'altra, e tre paia di cuffie non sono tre cose che stai facendo: sono un
// unico fatto — "cosa ho attaccato" — con tre righe dentro.
//
// Riempire la catena di dispositivi renderebbe il giro del pallino lungo e
// noioso proprio nei momenti in cui serve corto.
//
// LA CARICA CHE MANCA
//
// Molti dispositivi non la riportano: non implementano il profilo che serve, e
// non c'e' modo di ricavarla. In quel caso l'anello resta la sola pista vuota e
// sotto compare il nome invece della percentuale. Un anello a zero direbbe una
// cosa falsa — "scarico" — mentre la verita' e' "non lo so".

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { Anello } from './anello.js';

const DIM_ANELLO = 44;
const DIM_ICONA = 20;

// Verde, giallo, rosso: le soglie sono quelle a cui cambia cosa fai.
// Sopra il 30% non ci pensi; fra il 30 e il 15 cominci a cercare il cavo; sotto
// il 15 e' tardi. Un gradiente continuo sarebbe piu' preciso e meno utile,
// perche' non distinguerebbe i tre momenti.
function coloreCarica(pct) {
    if (pct === null) return [1, 1, 1, 0.28];
    if (pct > 30) return [0.20, 0.82, 0.478, 1];    // #33d17a
    if (pct > 15) return [0.961, 0.761, 0.067, 1];  // #f5c211
    return [0.878, 0.106, 0.141, 1];                // #e01b24
}

export class BluetoothView {
    constructor() {
        this.actor = new St.BoxLayout({
            style_class: 'dynisland-bt',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        // Nome e carica stanno gia' dentro i cerchi: la riga standard della
        // scheda li ripeterebbe in piccolo e in grigio sopra di essi.
        this.actor._dynIslandRigaPropria = true;

        this._badge = new Map();     // percorso → { radice, anello, icona, pct, nome }
    }

    // dispositivi: [{ percorso, nome, icona (Gio.Icon), batteria (0-100 o null) }]
    aggiorna(dispositivi) {
        const vivi = new Set(dispositivi.map(d => d.percorso));

        // Prima si tolgono quelli spariti: se si aggiungesse prima, un
        // dispositivo scollegato resterebbe disegnato per un fotogramma con
        // accanto quelli nuovi, e la scheda ballerebbe.
        for (const [percorso, b] of [...this._badge]) {
            if (vivi.has(percorso)) continue;
            b.anello.destroy();
            b.radice.destroy();
            this._badge.delete(percorso);
        }

        for (const d of dispositivi) {
            let b = this._badge.get(d.percorso);
            if (!b) { b = this._crea(d); this._badge.set(d.percorso, b); }
            this._scrivi(b, d);
        }
    }

    _crea(d) {
        const radice = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'dynisland-bt-badge',
            x_align: Clutter.ActorAlign.CENTER,
        });

        // L'icona sta DENTRO l'anello, non accanto: impilate con un BinLayout,
        // che e' l'unico gestore che sovrappone invece di affiancare.
        const cerchio = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
        });
        const anello = new Anello({ dimensione: DIM_ANELLO, spessore: 4 });
        anello.actor.x_align = Clutter.ActorAlign.CENTER;
        anello.actor.y_align = Clutter.ActorAlign.CENTER;
        cerchio.add_child(anello.actor);

        const icona = new St.Icon({
            style_class: 'dynisland-bt-icona',
            icon_size: DIM_ICONA,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        cerchio.add_child(icona);
        radice.add_child(cerchio);

        const pct = new St.Label({
            style_class: 'dynisland-bt-carica',
            x_align: Clutter.ActorAlign.CENTER,
        });
        radice.add_child(pct);

        const nome = new St.Label({
            style_class: 'dynisland-bt-nome',
            x_align: Clutter.ActorAlign.CENTER,
        });
        nome.clutter_text.ellipsize = 3;      // PANGO_ELLIPSIZE_END
        radice.add_child(nome);

        this.actor.add_child(radice);
        return { radice, anello, icona, pct, nome };
    }

    _scrivi(b, d) {
        if (d.icona) b.icona.gicon = d.icona;

        const carica = Number.isFinite(d.batteria) ? d.batteria : null;
        b.anello.setColore(coloreCarica(carica));
        b.anello.setFrazione(carica === null ? 0 : carica / 100, true);

        // Il trattino, non l'etichetta nascosta.
        //
        // Nascondendola, il nome risalirebbe di una riga e quel cerchio
        // starebbe piu' in alto degli altri: tre badge affiancati con le
        // scritte a quote diverse si leggono come un errore di impaginazione.
        // Il trattino tiene la riga e dice la cosa giusta — nessuna lettura —
        // che e' diversa da zero per cento.
        b.pct.text = carica === null ? '—' : `${carica}%`;
        b.pct.style = carica === null ? 'color: rgba(255, 255, 255, 0.35);' : null;
        b.nome.text = d.nome ?? '';
    }

    destroy() {
        for (const b of this._badge.values()) b.anello.destroy();
        this._badge.clear();
        this.actor?.destroy();
        this.actor = null;
    }
}
