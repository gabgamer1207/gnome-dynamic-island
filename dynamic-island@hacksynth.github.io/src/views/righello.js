// Il righello per scegliere la durata di un timer.
//
// E' la forma che iOS 27 mostra nella Dynamic Island quando tocchi il timer nel
// centro di controllo: una striscia di tacche che scorre sotto un indice fisso,
// con i minuti scritti sopra. Si trascina, e il numero grande a fianco segue.
//
// PERCHE' L'INDICE STA FERMO E IL RIGHELLO SCORRE
//
// L'opposto — indice mobile su una scala ferma — sembra piu' semplice, ma
// costringe la scala a contenere tutto l'intervallo: da un minuto a due ore in
// trecento pixel fanno una tacca ogni due pixel e mezzo, illeggibile, e nessuna
// etichetta ci sta. Facendo scorrere il nastro le tacche restano larghe quanto
// serve e l'intervallo diventa illimitato.
//
// E' anche il modo in cui funzionano le manopole vere: il riferimento e' fisso,
// e sei tu a muovere la cosa.
//
// LA SFUMATURA AI BORDI
//
// Le tacche svaniscono ai due lati invece di essere tagliate di netto. Un
// taglio netto direbbe "qui finisce"; la sfumatura dice "continua", che e' la
// verita' e insieme l'invito a trascinare.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

const AMBRA = [1, 0.62, 0.04];

// Disegna il nastro. Fuori dalla classe di proposito: cosi' si puo' rendere su
// un'immagine e guardarlo senza avviare una shell intera.
//
// valore: quello sotto l'indice, anche frazionario mentre si trascina, espresso
//         in TACCHE — non in minuti. Un nastro non sa cosa sta misurando: sa
//         quante tacche ci sono e ogni quante scrivere un numero. E' cio' che
//         gli permette di servire sia i minuti sia i secondi senza duplicarlo.
export function disegnaRighello(cr, w, h, valore, opzioni = {}) {
    const {
        pxAllaTacca = 12,
        min = 0,
        max = 180,
        etichettaOgni = 5,
        scala = 1,            // quanto vale una tacca nell'unita' scritta
        piccolo = false,      // nastro secondario: piu' basso e piu' discreto
    } = opzioni;
    const minuti = valore;
    const pxAlMinuto = pxAllaTacca;
    const MIN_MINUTI = min, MAX_MINUTI = max;
    const centro = w / 2;

    const yNumeri = 2;
    const yTacche = piccolo ? 15 : 20;
    const altaTacca = piccolo ? 13 : 20;
    const bassaTacca = piccolo ? 7 : 11;
    const yIndice = yTacche + altaTacca + 4;

    // Quante tacche entrano, piu' un margine per quelle che stanno uscendo.
    const raggio = Math.ceil(w / (2 * pxAlMinuto)) + 2;
    const primo = Math.floor(minuti) - raggio;
    const ultimo = Math.ceil(minuti) + raggio;

    const font = Pango.FontDescription.from_string('Cantarell Semi-Bold');
    font.set_absolute_size((piccolo ? 9 : 11) * Pango.SCALE);

    for (let m = primo; m <= ultimo; m++) {
        if (m < MIN_MINUTI || m > MAX_MINUTI) continue;
        const x = centro + (m - minuti) * pxAlMinuto;
        if (x < -pxAlMinuto || x > w + pxAlMinuto) continue;

        // Sfumatura ai bordi: piena al centro, nulla ai due estremi.
        const d = Math.abs(x - centro) / (w / 2);
        const opacita = Math.max(0, 1 - Math.pow(d, 2.2));

        const ogniCinque = m % etichettaOgni === 0;
        const alt = ogniCinque ? altaTacca : bassaTacca;

        cr.setSourceRGBA(...AMBRA, opacita * (ogniCinque ? 0.95 : 0.6));
        cr.setLineWidth(2);
        cr.newPath();
        cr.moveTo(Math.round(x) + 0.5, yTacche + (altaTacca - alt));
        cr.lineTo(Math.round(x) + 0.5, yTacche + altaTacca);
        cr.stroke();

        if (!ogniCinque) continue;

        // Il numero sotto l'indice si accende: e' quello che stai scegliendo.
        const vicino = Math.abs(m - minuti) < 2.5;
        const l = PangoCairo.create_layout(cr);
        l.set_font_description(font);
        l.set_text(String(m * scala), -1);
        const [lw] = l.get_pixel_size();
        cr.setSourceRGBA(
            ...(vicino ? [1, 1, 1] : [1, 1, 1]),
            opacita * (vicino ? 0.95 : 0.42));
        cr.moveTo(Math.round(x - lw / 2), yNumeri);
        PangoCairo.show_layout(cr, l);
    }

    // L'indice: un triangolo che punta in su, al centro, sempre.
    cr.newPath();
    cr.setSourceRGBA(...AMBRA, 1);
    const pi = piccolo ? 5 : 6;
    cr.moveTo(centro, yIndice);
    cr.lineTo(centro - pi, yIndice + pi + 1);
    cr.lineTo(centro + pi, yIndice + pi + 1);
    cr.closePath();
    cr.fill();
}

export class Righello {
    // cambiato(valore) viene chiamato mentre si trascina, a tacca intera.
    constructor(cambiato, opzioni = {}) {
        this._cambiato = cambiato;
        this._op = {
            pxAllaTacca: 12, min: 0, max: 180, etichettaOgni: 5,
            scala: 1, piccolo: false, ...opzioni,
        };
        this._minuti = this._op.iniziale ?? 15;
        this._trascinando = false;
        this._xIniziale = 0;
        this._minutiIniziali = 0;

        this.actor = new St.DrawingArea({
            style_class: 'dynisland-righello',
            height: this._op.piccolo ? 40 : 52,
            x_expand: true,
            reactive: true,
        });
        this.actor.connect('repaint', () => {
            const cr = this.actor.get_context();
            const [w, h] = this.actor.get_surface_size();
            try { disegnaRighello(cr, w, h, this._minuti, this._op); }
            finally { cr.$dispose(); }
        });

        // Sulla pressione, come tutto il resto dell'isola: la scheda si rimisura
        // di continuo e gli attori si spostano sotto il puntatore, quindi
        // 'clicked' non e' affidabile. Qui per giunta serve il trascinamento,
        // che di 'clicked' non sa nulla.
        this.actor.connect('button-press-event', (_a, ev) => {
            this._trascinando = true;
            [this._xIniziale] = ev.get_coords();
            this._minutiIniziali = this._minuti;
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('motion-event', (_a, ev) => {
            if (!this._trascinando) return Clutter.EVENT_PROPAGATE;
            const [x] = ev.get_coords();
            // Si trascina il NASTRO: spostandolo a destra i minuti calano,
            // perche' e' la scala a muoversi, non l'indice.
            this._imposta(this._minutiIniziali - (x - this._xIniziale) / this._op.pxAllaTacca);
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('button-release-event', () => {
            if (!this._trascinando) return Clutter.EVENT_PROPAGATE;
            this._trascinando = false;
            // A dito alzato ci si posa sul minuto intero piu' vicino: un timer
            // da 14 minuti e 40 secondi non lo vuole nessuno.
            this._imposta(Math.round(this._minuti));
            return Clutter.EVENT_STOP;
        });
        // Fuori dall'area il trascinamento finisce, altrimenti resterebbe
        // agganciato al puntatore anche dopo che se n'e' andato.
        this.actor.connect('leave-event', () => {
            if (!this._trascinando) return Clutter.EVENT_PROPAGATE;
            this._trascinando = false;
            this._imposta(Math.round(this._minuti));
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('scroll-event', (_a, ev) => {
            const su = ev.get_scroll_direction() === Clutter.ScrollDirection.UP;
            this._imposta(Math.round(this._minuti) + (su ? 1 : -1));
            return Clutter.EVENT_STOP;
        });
    }

    get valore() { return Math.max(this._op.min, Math.round(this._minuti)); }

    setValore(v) { this._imposta(v); }

    _imposta(m) {
        const v = Math.max(this._op.min, Math.min(this._op.max, m));
        if (v === this._minuti) return;
        const primaIntero = Math.round(this._minuti);
        this._minuti = v;
        this.actor?.queue_repaint();
        // Si avvisa solo quando cambia il minuto intero: chi ascolta riscrive
        // un'etichetta e aggiorna un'attivita', e farlo a ogni pixel di
        // trascinamento vorrebbe dire ridisegnare mezza isola sessanta volte
        // al secondo per un numero che non e' cambiato.
        if (Math.round(v) !== primaIntero) this._cambiato?.(Math.round(v));
    }

    destroy() {
        this.actor?.destroy();
        this.actor = null;
    }
}
