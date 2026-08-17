// Il timer quando la scheda e' aperta: pausa, stop e il tempo in grande.
//
// E' la forma estesa dell'isola di iOS — anello e cifre a destra, i due comandi
// a sinistra — con una differenza voluta: li' il colore e' quello dell'app che
// ha creato l'attivita', qui e' sempre l'ambra del timer. Su iOS quel colore
// serve a dire QUALE app sta parlando; qui il provider e' uno solo, e un colore
// costante lo rende riconoscibile senza doverlo leggere.
//
// I COMANDI
//
// Pausa e stop, non solo stop. Un timer che si puo' soltanto azzerare costringe
// a ricominciare da capo ogni volta che qualcuno bussa alla porta, ed e' la
// ragione per cui i timer da studio finiscono per essere ignorati.
//
// Piu' e meno un minuto, ai due lati del numero. Non e' un doppione della
// scelta iniziale: li' decidi quanto vuoi che duri, qui correggi mentre sta
// gia' andando — "ancora un minuto e ho finito". Sono due momenti diversi, e
// dover fermare e rifare il timer per aggiungere sessanta secondi e' proprio
// il motivo per cui a meta' pomeriggio si smette di usarlo.
//
// Stanno accanto alla cifra che modificano: un pulsante lontano dal suo effetto
// costringe a ricordare cosa fa.
//
// PERCHE' I COMANDI AGISCONO SULLA PRESSIONE
//
// St.Button emette 'clicked' solo se pressione e rilascio avvengono entrambi su
// di lui restando premuto nel frattempo. Qui non succede: il contenuto della
// scheda cambia ogni secondo — sono le cifre del conto alla rovescia — la
// scheda si rimisura, e il pulsante si sposta sotto il puntatore anche solo di
// un pixel. Fra pressione e rilascio arriva un 'leave', lo stato di premuto si
// azzera, e 'clicked' non viene mai emesso: il pulsante sembra rotto.
//
// E' lo stesso difetto gia' trovato sui comandi della musica, dove a muovere le
// cose era la barra di avanzamento. Agire sulla pressione lo elimina alla
// radice, e per comandi immediati e ripetibili e' anche piu' corretto.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { Anello } from './anello.js';

const AMBRA = [1, 0.62, 0.04, 1];

export class TimerView {
    // azioni: { pausa(), riprendi(), ferma(), aggiungi(secondi) }
    constructor(azioni) {
        this._azioni = azioni;
        this._inPausa = false;

        this.actor = new St.BoxLayout({
            style_class: 'dynisland-timer',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const comandi = new St.BoxLayout({ style_class: 'dynisland-timer-comandi' });
        this._btnPausa = this._bottone('media-playback-pause-symbolic',
            _('Pause'), () => this._alterna());
        this._btnStop = this._bottone('window-close-symbolic',
            _('Stop'), () => this._azioni.ferma?.());
        comandi.add_child(this._btnPausa);
        comandi.add_child(this._btnStop);
        this.actor.add_child(comandi);

        // Spaziatore: comandi a sinistra, tempo a destra, come nell'isola vera.
        this.actor.add_child(new St.Widget({ x_expand: true }));

        this._nome = new St.Label({
            style_class: 'dynisland-timer-nome',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._nome);

        this._anello = new Anello({ dimensione: 38, spessore: 4, colore: AMBRA });
        this.actor.add_child(this._anello.actor);

        this._meno = this._regola('list-remove-symbolic', _('One minute less'), -60);
        this.actor.add_child(this._meno);

        this._tempo = new St.Label({
            style_class: 'dynisland-timer-tempo',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._tempo);

        this._piu = this._regola('list-add-symbolic', _('One minute more'), +60);
        this.actor.add_child(this._piu);

        // La scheda non deve aggiungere la sua riga di testo sopra: nome e
        // tempo sono gia' qui, e li' finirebbero scritti una seconda volta.
        this.actor._dynIslandRigaPropria = true;
    }

    // Chiamata a ogni secondo dal provider. Non ricostruisce niente: riscrive i
    // valori sugli attori che esistono gia'. Sostituire la vista a ogni giro
    // farebbe rimontare la scheda una volta al secondo, e si vedrebbe.
    aggiorna({ testo, nome, frazione, inPausa, restanti }) {
        this._tempo.text = testo ?? '';
        this._nome.text = nome ?? '';
        this._anello.setFrazione(frazione ?? 0, !inPausa);

        // Sotto il minuto togliere un minuto non ha senso: il pulsante si
        // spegne invece di sparire, perche' un comando che va e viene fa
        // saltare la fila degli altri e costringe a ricercarli.
        const puoTogliere = (restanti ?? 0) > 75;
        this._meno.reactive = puoTogliere;
        this._meno.opacity = puoTogliere ? 255 : 90;

        if (inPausa !== this._inPausa) {
            this._inPausa = inPausa;
            this._btnPausa.child.icon_name = inPausa
                ? 'media-playback-start-symbolic'
                : 'media-playback-pause-symbolic';
            this._btnPausa.accessible_name = inPausa ? _('Resume') : _('Pause');
            // In pausa il tempo si smorza: e' il segnale che il numero che stai
            // guardando non sta piu' cambiando. Senza, un timer fermo e uno che
            // corre hanno esattamente lo stesso aspetto.
            this._tempo.style = inPausa ? 'color: rgba(255, 159, 10, 0.55);' : null;
        }
    }

    _alterna() {
        if (this._inPausa) this._azioni.riprendi?.();
        else this._azioni.pausa?.();
    }

    // Piu' piccoli dei comandi principali: sono una rifinitura, non il motivo
    // per cui hai aperto la scheda, e alla stessa misura ruberebbero l'occhio
    // a pausa e stop.
    _regola(icona, nome, delta) {
        const b = new St.Button({
            style_class: 'dynisland-timer-regola',
            can_focus: true,
            accessible_name: nome,
            child: new St.Icon({ icon_name: icona, icon_size: 13 }),
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Sulla pressione come tutto il resto: le cifre cambiano ogni secondo,
        // la scheda si rimisura e il pulsante scivola sotto il puntatore.
        b.connect('button-press-event', () => {
            this._azioni.aggiungi?.(delta);
            return Clutter.EVENT_STOP;
        });
        return b;
    }

    _bottone(icona, nome, azione) {
        const b = new St.Button({
            // Classe propria, non quella della musica: stessa veste ma piu'
            // grande. Ingrandire quella condivisa avrebbe cambiato anche i
            // comandi del lettore, che erano gia' della misura giusta.
            style_class: 'dynisland-btn-grande',
            can_focus: true,
            accessible_name: nome,
            child: new St.Icon({ icon_name: icona, icon_size: 18 }),
        });
        b.connect('button-press-event', () => {
            azione();
            return Clutter.EVENT_STOP;
        });
        return b;
    }

    destroy() {
        this._anello?.destroy();
        this._anello = null;
        this.actor?.destroy();
        this.actor = null;
    }
}
