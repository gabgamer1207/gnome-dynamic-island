// La barra di avanzamento del brano: traccia, riempimento e pallino.
//
// PERCHE' DISEGNATA E NON COMPOSTA DI ATTORI
//
// Prima erano tre widget St dentro un contenitore: la traccia, il riempimento
// che le cresceva dentro e il pallino in coda. Sembra la strada naturale, e
// invece porta con se' tre problemi che non si risolvono singolarmente.
//
//   L'ALTEZZA NON E' QUELLA CHE CHIEDI. Il contenitore si alza per contenere il
//   figlio piu' alto, e il figlio piu' alto e' il pallino: una traccia da tre
//   pixel diventava una fascia da quattordici, grigia e spessa, che non
//   assomiglia a una barra di avanzamento ma a un contenitore vuoto.
//
//   IL MOVIMENTO E' A SCATTI DA UN PIXEL. La larghezza di un attore St si puo'
//   animare solo riscrivendone lo stile in linea, e i pixel sono interi: su tre
//   minuti di brano l'avanzamento procede per salti invece che scorrere.
//
//   OGNI FOTOGRAMMA RIMISURA LA SCHEDA. Cambiare la larghezza di un figlio
//   obbliga il contenitore a rifare i conti, e con lui tutta la scheda: sessanta
//   volte al secondo, per muovere una linea bianca.
//
// Disegnandola, l'altezza e' quella che dico io, la posizione e' un numero a
// virgola e non ci sono contenitori da avvisare: si ridipinge un attore e basta.
// E' la stessa scelta gia' fatta per l'anello e per il nastro del timer, per le
// stesse ragioni.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { anima } from '../anima.js';

const SPESSORE = 4;          // la linea
const RAGGIO_PALLINO = 6;
const RAGGIO_SOPRA = 7;      // il puntatore e' sulla barra
const RAGGIO_TRASCINO = 8;   // lo stai tenendo
const ALTEZZA = 20;          // area sensibile: piu' alta della linea, si prende

// Un rettangolo con i capi tondi, disegnato come una linea spessa: e' il modo
// piu' corto per ottenerlo, e i capi vengono esatti senza calcolare archi.
function linea(cr, x1, x2, y, spessore, colore) {
    if (x2 - x1 < 0.5) return;
    cr.newPath();
    cr.setLineWidth(spessore);
    cr.setLineCap(1 /* ROUND */);
    cr.setSourceRGBA(...colore);
    cr.moveTo(x1 + spessore / 2, y);
    cr.lineTo(x2 - spessore / 2, y);
    cr.stroke();
}

export function disegnaBarra(cr, w, h, frazione, opzioni = {}) {
    const {
        spessore = SPESSORE,
        raggio = RAGGIO_PALLINO,
        colore = [1, 1, 1, 1],
        colorePista = [1, 1, 1, 0.28],
    } = opzioni;

    // Il pallino non deve poter uscire dai bordi: la corsa utile e' quella fra i
    // due centri estremi, non fra i due bordi.
    const x0 = raggio;
    const x1 = w - raggio;
    const y = h / 2;
    const f = Math.max(0, Math.min(1, frazione));
    const x = x0 + (x1 - x0) * f;

    linea(cr, x0 - spessore / 2, x1 + spessore / 2, y, spessore, colorePista);
    linea(cr, x0 - spessore / 2, x + spessore / 2, y, spessore, colore);

    cr.newPath();
    cr.setSourceRGBA(...colore);
    cr.arc(x, y, raggio, 0, Math.PI * 2);
    cr.fill();
}

export class Barra {
    // azioni: { anteprima(frazione), salta(frazione) }
    //   anteprima  mentre trascini: aggiorna il tempo scritto accanto
    //   salta      a dito alzato: e' il momento in cui si chiede al lettore
    constructor(azioni) {
        this._azioni = azioni;
        this._frazione = 0;
        this._raggio = RAGGIO_PALLINO;
        this._ferma = null;
        this.trascinando = false;

        this.actor = new St.DrawingArea({
            style_class: 'dynisland-barra',
            height: ALTEZZA,
            x_expand: true,
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.connect('repaint', () => {
            const cr = this.actor.get_context();
            const [w, h] = this.actor.get_surface_size();
            try {
                disegnaBarra(cr, w, h, this._frazione, { raggio: this._raggio });
            } finally { cr.$dispose(); }
        });

        this.actor.connect('button-press-event', (a, ev) => {
            this.trascinando = true;
            this._animaPallino(RAGGIO_TRASCINO);
            this._daEvento(a, ev, false);
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('motion-event', (a, ev) => {
            if (!this.trascinando) return Clutter.EVENT_PROPAGATE;
            this._daEvento(a, ev, false);
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('button-release-event', (a, ev) => {
            if (!this.trascinando) return Clutter.EVENT_PROPAGATE;
            this.trascinando = false;
            this._animaPallino(RAGGIO_PALLINO);
            this._daEvento(a, ev, true);
            return Clutter.EVENT_STOP;
        });
        // Il pallino cresce gia' al passaggio del puntatore, prima ancora che
        // tu prema. E' quello che dice "questo si puo' prendere": senza, una
        // barra di avanzamento sembra una decorazione, e nessuno prova a
        // trascinarla.
        this.actor.connect('enter-event', () => {
            if (!this.trascinando) this._animaPallino(RAGGIO_SOPRA);
            return Clutter.EVENT_PROPAGATE;
        });
        // Se il puntatore esce mentre tieni premuto, il trascinamento finisce
        // qui: altrimenti resterebbe agganciato per sempre e la barra
        // smetterebbe di seguire il lettore.
        this.actor.connect('leave-event', () => {
            const stavaTrascinando = this.trascinando;
            this.trascinando = false;
            this._animaPallino(RAGGIO_PALLINO);
            if (stavaTrascinando) this._azioni.salta?.(this._frazione);
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // A virgola, non arrotondata: e' tutto il punto di disegnarla.
    setFrazione(f) {
        const v = Math.max(0, Math.min(1, Number(f) || 0));
        if (Math.abs(v - this._frazione) < 0.0002) return;
        this._frazione = v;
        this.actor?.queue_repaint();
    }

    _daEvento(attore, ev, definitivo) {
        const [x] = ev.get_coords();
        const [bx] = attore.get_transformed_position();
        const w = attore.get_width();
        if (!w) return;
        const f = Math.max(0, Math.min(1, (x - bx - this._raggio) / (w - 2 * this._raggio)));
        this._frazione = f;
        this.actor.queue_repaint();
        if (definitivo) this._azioni.salta?.(f);
        else this._azioni.anteprima?.(f);
    }

    _animaPallino(a) {
        this._ferma?.();
        const da = this._raggio;
        this._ferma = anima(this.actor, 140, t => {
            this._raggio = da + (a - da) * t;
            this.actor?.queue_repaint();
        }, () => { this._ferma = null; this._raggio = a; this.actor?.queue_repaint(); });
    }

    destroy() {
        this._ferma?.();
        this._ferma = null;
        this.actor?.destroy();
        this.actor = null;
    }
}
