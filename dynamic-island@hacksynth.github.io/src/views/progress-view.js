// Barra di avanzamento generica per le attivita' spinte via D-Bus.
//
// Serve a tutto cio' che ha una percentuale: un backup, una trascrizione,
// un download, una compilazione. Volutamente minima: chi spinge l'attivita'
// mette il testo, qui c'e' solo la barra e la percentuale.
//
// CORREZIONE: due difetti gia' visti altrove nello stesso programma.
//
// 1. Il contenitore era un BinLayout, che impila i figli e li centra. La barra
//    cresceva quindi da meta' verso i due bordi invece che da sinistra: un
//    BoxLayout orizzontale impacchetta dall'inizio senza doverglielo chiedere.
//
// 2. La larghezza era animata con ease({width}), che su un attore St non fa
//    nulla: St calcola la propria dimensione da CSS e contenuto e scarta la
//    richiesta di Clutter, senza segnalare niente. La dimensione va scritta
//    nello stile in linea, un fotogramma alla volta.
//
// Erano gia' stati corretti nella vista della musica; qui erano rimasti perche'
// questa vista non era raggiungibile — il provider D-Bus non era mai stato
// acceso. Adesso lo e', e li avrebbe riportati a galla tali e quali.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { anima } from '../anima.js';

export class ProgressView {
    constructor() {
        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'dynisland-progress',
            x_expand: true,
        });

        this._barra = new St.BoxLayout({
            style_class: 'dynisland-media-bar',      // stesso stile della musica
            x_expand: true,
        });
        this._riempimento = new St.Widget({
            style_class: 'dynisland-media-bar-fill',
            x_expand: false,
        });
        this._barra.add_child(this._riempimento);

        this._percentuale = new St.Label({
            style_class: 'dynisland-media-time',
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });

        this.actor.add_child(this._barra);
        this.actor.add_child(this._percentuale);

        this._frazione = 0;
        this._mostrata = 0;      // quella disegnata adesso, che insegue _frazione
        this._ferma = null;
    }

    setProgress(frazione) {
        this._frazione = Math.max(0, Math.min(1, Number(frazione) || 0));
        this._percentuale.text = `${Math.round(this._frazione * 100)}%`;

        // Stessa ragione dell'anello: senza frame clock non si anima.
        //
        // Questa vista sta dentro la scheda, che nasce chiusa. Un avanzamento
        // spinto da riga di comando mentre nessuno guarda avvierebbe una
        // timeline che non parte mai, e all'apertura la barra sarebbe ferma a
        // zero anche col novanta per cento scritto accanto.
        if (!this._barra.is_mapped()) {
            this._mostrata = this._frazione;
            this._disegna(this._frazione);
            return;
        }

        // Si parte da dove la barra si trova adesso, non da zero: con
        // aggiornamenti fitti, altrimenti, ripartirebbe da capo ogni volta.
        const da = this._mostrata;
        const a = this._frazione;
        this._ferma?.();
        this._ferma = anima(this._barra, 400, t => {
            // Decelerazione cubica: parte decisa e si posa. Abbastanza lenta da
            // leggersi come avanzamento, abbastanza rapida da non restare
            // indietro quando gli aggiornamenti sono ravvicinati.
            const e = 1 - Math.pow(1 - t, 3);
            this._disegna(da + (a - da) * e);
        }, () => this._disegna(a));
    }

    _disegna(frazione) {
        this._mostrata = frazione;
        const larghezza = this._barra.get_width();
        if (larghezza <= 0) return;   // non ancora allocata: si ridisegna dopo
        const w = Math.round(larghezza * frazione);
        this._riempimento.style = `min-width: ${w}px; max-width: ${w}px;`;
    }

    destroy() {
        this._ferma?.();
        this._ferma = null;
        this.actor?.destroy();
        this.actor = null;
    }
}
