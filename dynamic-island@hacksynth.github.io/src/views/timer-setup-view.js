// La scelta della durata, prima che il timer parta.
//
// E' la forma che iOS 27 mostra nella Dynamic Island quando tocchi il timer nel
// centro di controllo: il nastro delle tacche in alto, il comando di avvio a
// sinistra e la durata scelta in grande a destra.
//
// PERCHE' UN NASTRO E NON UN CAMPO DI TESTO
//
// Perche' scegliere una durata non e' digitare un numero: e' un aggiustamento.
// Parti da un'idea approssimativa — "un quarto d'ora circa" — e la sistemi
// guardando il risultato. Un campo di testo obbliga a decidere prima e a
// scrivere dopo; il nastro fa fare le due cose insieme, ed e' il motivo per cui
// tutti i timer fisici hanno una manopola.
//
// PERCHE' DUE NASTRI E NON UNO SOLO
//
// Un nastro solo dovrebbe misurare in secondi per permettere "tre minuti e
// mezzo", e a quel punto per arrivare a venticinque minuti servirebbero
// millecinquecento tacche: un trascinamento lungo mezzo schermo, ripetuto.
// Cambiare il passo a meta' corsa — secondi sotto il minuto, minuti sopra —
// farebbe cambiare la velocita' di scorrimento mentre trascini, che si sente
// come un inceppamento.
//
// Due nastri tengono ogni unita' col suo passo naturale. Quello dei secondi e'
// piu' basso e piu' discreto, perche' e' la rifinitura: la scelta vera si fa
// sui minuti.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { Righello } from './righello.js';

export class TimerSetupView {
    // azioni: { cambiato(secondi), avvia(secondi) }
    constructor(azioni) {
        this._azioni = azioni;

        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'dynisland-scelta',
            x_expand: true,
        });
        this.actor._dynIslandRigaPropria = true;

        // Minuti: passo di uno, un numero ogni cinque, fino a tre ore.
        this._minuti = new Righello(() => this._cambiato(), {
            min: 0, max: 180, etichettaOgni: 5, pxAllaTacca: 12, iniziale: 15,
        });
        this.actor.add_child(this._minuti.actor);

        // Secondi: una tacca per secondo, un numero ogni quindici.
        //
        // Non arriva a 60: sessanta secondi sono un minuto, e averli in due
        // posti diversi vorrebbe dire poter scrivere la stessa durata in due
        // modi — e vedere il nastro dei minuti e quello dei secondi in
        // disaccordo su cosa hai scelto.
        //
        // Tacche piu' fitte di quelle dei minuti (7 px contro 12): sono
        // sessanta invece di una manciata, e a dodici pixel l'una il minuto
        // intero sarebbe piu' largo della scheda.
        this._secondi = new Righello(() => this._cambiato(), {
            min: 0, max: 59, etichettaOgni: 15, pxAllaTacca: 7,
            piccolo: true, iniziale: 0,
        });
        this.actor.add_child(this._secondi.actor);

        const riga = new St.BoxLayout({
            style_class: 'dynisland-scelta-riga',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._avvia = new St.Button({
            style_class: 'dynisland-scelta-avvia',
            can_focus: true,
            label: _('Start Timer'),
        });
        // Sulla pressione come ogni altro comando dell'isola: qui il testo
        // accanto cambia mentre trascini, la scheda si rimisura e il pulsante
        // scivola sotto il puntatore fra pressione e rilascio.
        this._avvia.connect('button-press-event', () => {
            const s = this.secondi;
            if (s > 0) this._azioni.avvia?.(s);
            return Clutter.EVENT_STOP;
        });
        riga.add_child(this._avvia);

        riga.add_child(new St.Widget({ x_expand: true }));

        this._tempo = new St.Label({
            style_class: 'dynisland-timer-tempo',   // stesso ambra del timer in corsa
            y_align: Clutter.ActorAlign.CENTER,
        });
        riga.add_child(this._tempo);

        this.actor.add_child(riga);
        this._scrivi();
    }

    get secondi() {
        return this._minuti.valore * 60 + this._secondi.valore;
    }

    setSecondi(tot) {
        const t = Math.max(0, Math.round(tot));
        this._minuti.setValore(Math.floor(t / 60));
        this._secondi.setValore(t % 60);
        this._scrivi();
    }

    _cambiato() {
        this._scrivi();
        this._azioni.cambiato?.(this.secondi);
    }

    _scrivi() {
        this._tempo.text = formattaDurata(this.secondi);
        // Un timer da zero non esiste: finche' non scegli qualcosa il comando
        // resta li' ma non risponde, invece di far partire il nulla.
        this._avvia.reactive = this.secondi > 0;
        this._avvia.opacity = this.secondi > 0 ? 255 : 120;
    }

    destroy() {
        this._minuti?.destroy();
        this._secondi?.destroy();
        this._minuti = this._secondi = null;
        this.actor?.destroy();
        this.actor = null;
    }
}

// Stessa forma che avra' il conto alla rovescia una volta partito: vedere il
// medesimo formato prima e dopo evita di dover ricontrollare di aver scelto
// giusto.
export function formattaDurata(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0)
        return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
}
