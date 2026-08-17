// Anello di avanzamento circolare.
//
// E' la forma che il timer di iOS mostra nella Dynamic Island: un cerchio che
// si svuota. Funziona perche' non chiede di leggere niente — la quantita' di
// arco che resta la vedi con la coda dell'occhio, ed e' esattamente il modo in
// cui si guarda un timer mentre stai facendo altro.
//
// PERCHE' CAIRO E NON IL CSS
//
// Un arco parziale non si esprime con i bordi arrotondati di un foglio di
// stile: si potrebbe simulare sovrapponendo maschere, ma sarebbero tre attori
// per disegnare una cosa sola, e ogni fotogramma dovrebbe tenerli d'accordo.
// Con Cairo e' una chiamata ad arc().
//
// La funzione di disegno sta fuori dalla classe di proposito: cosi' e'
// verificabile da sola, rendendola su un'immagine e guardandola, senza dover
// avviare una shell intera.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { anima } from '../anima.js';

const TAU = Math.PI * 2;

// cr           contesto Cairo
// w, h         dimensioni dell'area, in pixel
// frazione     da 0 (vuoto) a 1 (pieno)
// opzioni      spessore, colore [r,g,b,a], colorePista [r,g,b,a]
export function disegnaAnello(cr, w, h, frazione, opzioni = {}) {
    const {
        spessore = 3,
        colore = [1, 0.62, 0.04, 1],          // ambra: il colore dei timer
        colorePista = [1, 1, 1, 0.18],
    } = opzioni;

    const raggio = Math.min(w, h) / 2 - spessore / 2;
    if (raggio <= 0) return;

    const cx = w / 2;
    const cy = h / 2;

    cr.setLineWidth(spessore);
    // Estremi arrotondati: un arco tagliato di netto sembra un pezzo rotto di
    // cerchio, uno arrotondato sembra un tratto di penna.
    cr.setLineCap(1 /* Cairo.LineCap.ROUND */);

    // newPath() prima di ogni arco, sempre.
    //
    // arc() non inizia un tracciato nuovo: lo AGGIUNGE a quello in corso, e se
    // esiste gia' un punto corrente ci tira una linea dritta fino all'inizio
    // dell'arco. Basta che chi ci ha preceduto abbia lasciato un punto nel
    // contesto — un testo, un tracciato non chiuso — e l'anello si ritrova
    // attraversato da una diagonale.
    //
    // Nel widget il contesto arriva pulito a ogni ridipintura, quindi il difetto
    // non si vedrebbe li'; si e' visto disegnando questa stessa funzione in
    // un'immagine di prova, dopo una riga di testo. E' una dipendenza silenziosa
    // dallo stato di chi chiama: costa due righe toglierla.
    cr.newPath();
    cr.setSourceRGBA(...colorePista);
    cr.arc(cx, cy, raggio, 0, TAU);
    cr.stroke();

    const f = Math.max(0, Math.min(1, frazione));
    if (f <= 0) return;

    // Si parte dalle ore 12 e si gira in senso orario, come un orologio.
    // In Cairo l'angolo zero e' a ore 3 e cresce verso il basso, quindi
    // l'inizio va portato indietro di un quarto di giro.
    const inizio = -Math.PI / 2;
    cr.newPath();
    cr.setSourceRGBA(...colore);
    if (f >= 1) cr.arc(cx, cy, raggio, 0, TAU);
    else cr.arc(cx, cy, raggio, inizio, inizio + TAU * f);
    cr.stroke();
}

export class Anello {
    constructor({ dimensione = 18, spessore = 3, colore, colorePista } = {}) {
        this._frazione = 0;
        this._mostrata = 0;
        this._ferma = null;
        this._opzioni = { spessore, colore, colorePista };

        this.actor = new St.DrawingArea({
            style_class: 'dynisland-anello',
            width: dimensione,
            height: dimensione,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.connect('repaint', () => this._dipingi());

        // Quando l'anello entra in scena si mette subito al valore giusto.
        //
        // Vive dentro la scheda, che nasce chiusa: al momento in cui il
        // provider scrive la carica quell'attore non e' ancora sullo schermo, e
        // un'animazione avviata li' non parte mai (vedi setFrazione). Aprendo la
        // scheda si vedrebbe l'anello fermo al valore di partenza — che e' zero.
        //
        // Non si anima l'ingresso: la scheda si sta gia' aprendo con la sua
        // molla, e un anello che si riempie mentre la scheda cresce sono due
        // movimenti sovrapposti che si disturbano. Il valore c'e' e basta.
        this.actor.connect('notify::mapped', () => {
            if (!this.actor?.is_mapped()) return;
            if (this._mostrata === this._frazione) return;
            this._ferma?.();
            this._ferma = null;
            this._mostrata = this._frazione;
            this.actor.queue_repaint();
        });
    }

    // anima: falso quando il valore salta di proposito (un timer nuovo), perche'
    // in quel caso un'interpolazione mostrerebbe una corsa che non e' successa.
    setFrazione(frazione, animato = true) {
        const a = Math.max(0, Math.min(1, Number(frazione) || 0));

        // Se il bersaglio non e' cambiato e siamo gia' li' — o ci stiamo
        // andando — non c'e' niente da rifare.
        //
        // Il modello di vista viene ripubblicato quattro volte al secondo dal
        // ticker che fa scadere i lampi, e ogni pubblicazione riporta qui lo
        // stesso valore. Senza questa guardia l'animazione da 950 ms verrebbe
        // interrotta e riavviata ogni 250 ms: non arriverebbe mai in fondo, e
        // l'anello avanzerebbe a strappi invece che di continuo.
        //
        // Le due condizioni servono entrambe. Solo "stesso bersaglio" salterebbe
        // anche il caso in cui l'animazione precedente e' stata interrotta a
        // meta': li' il disegno e' fermo a un valore vecchio e va raggiunto.
        // Solo "sta animando" non basta, perche' a corsa finita _ferma torna
        // nullo e ricominceremmo da capo per niente.
        if (a === this._frazione && (this._ferma || a === this._mostrata)) return;

        this._frazione = a;
        this._ferma?.();
        this._ferma = null;

        // Senza un frame clock non c'e' animazione possibile: si scrive il
        // valore e basta.
        //
        // anima() aggancia una Clutter.Timeline al frame clock dell'attore, e un
        // attore non montato non ne ha uno: la timeline parte, non avanza mai di
        // un fotogramma e non finisce mai. Il valore resterebbe quello di
        // partenza — e' cosi' che l'anello della batteria delle cuffie mostrava
        // un cerchio vuoto invece del sessanta per cento reale, perche' la
        // scheda in cui vive era ancora chiusa quando la carica e' arrivata.
        //
        // Il difetto e' silenzioso due volte: nessun errore, e _ferma resta
        // valorizzato per sempre, quindi la guardia qui sopra scarta anche gli
        // aggiornamenti successivi con lo stesso valore.
        // is_mapped(), non get_mapped(): in Clutter "mapped" e' una proprieta' con
        // getter is_mapped, e il nome che sembrava ovvio non esiste. La chiamata
        // sbagliata sollevava un'eccezione che risaliva fino a Start(), quindi il
        // timer non partiva del tutto — un errore di battitura che spegneva una
        // funzionalita' intera, e che nessun controllo statico poteva vedere.
        if (!animato || !this.actor?.is_mapped()) {
            this._mostrata = a;
            this.actor?.queue_repaint();
            return;
        }

        const da = this._mostrata;
        // Un secondo intero: e' l'intervallo con cui il timer aggiorna, e
        // un'animazione lunga quanto l'attesa fa scorrere l'anello di continuo
        // invece di farlo scattare a ogni secondo.
        this._ferma = anima(this.actor, 950, t => {
            this._mostrata = da + (a - da) * t;
            this.actor?.queue_repaint();
        }, () => {
            // A corsa conclusa il campo torna nullo: da qui in poi significa
            // "nessuna animazione in volo", ed e' cio' su cui si regge la
            // guardia qui sopra.
            this._ferma = null;
            this._mostrata = a;
            this.actor?.queue_repaint();
        });
    }

    setColore(colore) {
        this._opzioni.colore = colore;
        this.actor?.queue_repaint();
    }

    _dipingi() {
        const cr = this.actor.get_context();
        const [w, h] = this.actor.get_surface_size();
        try { disegnaAnello(cr, w, h, this._mostrata, this._opzioni); }
        finally { cr.$dispose(); }
    }

    destroy() {
        this._ferma?.();
        this._ferma = null;
        this.actor?.destroy();
        this.actor = null;
    }
}
