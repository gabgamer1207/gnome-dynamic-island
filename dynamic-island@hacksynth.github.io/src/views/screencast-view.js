// La registrazione quando la scheda e' aperta.
//
// Il pallino rosso, ingrandito, E' il comando: premilo e la registrazione si
// ferma. Non c'e' un'icona di stop dentro, e non e' una svista — quel pallino e'
// gia' il simbolo universale di "sta registrando", e trasformarlo nel modo per
// smettere e' la scorciatoia piu' corta fra il vedere e l'agire. E' quello che
// fa iOS, ed e' il motivo per cui non devi cercare nessun menu.
//
// COME SI CAPISCE CHE SI PUO' PREMERE
//
// Un pallino che pulsa comunica uno stato, non un comando: da solo direbbe
// "sto registrando", non "premimi". L'appiglio arriva al passaggio del mouse —
// un anello sottile compare intorno — e alla pressione, dove il pallino si
// schiaccia e torna con una molla. Sono i due momenti in cui l'utente sta gia'
// guardando li'; metterci un contorno fisso invece lo sporcherebbe sempre, per
// un'informazione che serve solo in quei due istanti.
//
// IL SECONDO PULSANTE
//
// Ferma quella in corso e ne avvia subito un'altra: serve a spezzare una
// registrazione lunga in pezzi senza passare dalle scorciatoie di tastiera e
// senza perdere il ritmo di quello che stai facendo.
//
// Per la condivisione dello schermo non compare: una condivisione la concede
// l'applicazione che l'ha chiesta, e riavviarla dall'isola non avrebbe senso.
// Fermarla invece si, ed e' anzi il caso in cui serve di piu'.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { anima } from '../anima.js';
import { mollaApertura } from '../spring.js';

const CICLO_PULSAZIONE = 2200;

export class ScreencastView {
    // azioni: { ferma(), nuova() }
    constructor(azioni) {
        this._azioni = azioni;
        this._pulsazione = null;
        this._pressione = null;

        this.actor = new St.BoxLayout({
            style_class: 'dynisland-rec',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Il pallino. E' un St.Button perche' deve prendere il fuoco da
        // tastiera come qualunque altro comando: chi non usa il mouse deve
        // poter fermare una registrazione.
        this._stop = new St.Button({
            style_class: 'dynisland-rec-pallino',
            can_focus: true,
            accessible_name: _('Stop recording'),
        });
        // Perno al centro: schiacciandolo deve restringersi verso il proprio
        // centro, non verso l'angolo in alto a sinistra.
        this._stop.set_pivot_point(0.5, 0.5);
        // Sulla pressione, non sul click: la scheda si rimisura ogni secondo
        // per via delle cifre, il pulsante si sposta sotto il puntatore e
        // 'clicked' non verrebbe mai emesso. Stesso difetto dei comandi della
        // musica, stessa soluzione.
        this._stop.connect('button-press-event', () => {
            this._animaPressione();
            this._azioni.ferma?.();
            return Clutter.EVENT_STOP;
        });
        this.actor.add_child(this._stop);

        this._nuova = new St.Button({
            style_class: 'dynisland-btn-grande',
            can_focus: true,
            accessible_name: _('New recording'),
            child: new St.Icon({ icon_name: 'view-refresh-symbolic', icon_size: 18 }),
        });
        this._nuova.connect('button-press-event', () => {
            this._azioni.nuova?.();
            return Clutter.EVENT_STOP;
        });
        this.actor.add_child(this._nuova);

        this.actor.add_child(new St.Widget({ x_expand: true }));

        this._nome = new St.Label({
            style_class: 'dynisland-rec-nome',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._nome);

        this._tempo = new St.Label({
            style_class: 'dynisland-rec-tempo',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._tempo);

        // Come per il timer: la riga standard della scheda ripeterebbe cio' che
        // questa vista mostra gia', in piu' grande.
        this.actor._dynIslandRigaPropria = true;

        // La pulsazione parte quando la scheda si apre e si ferma quando si
        // chiude. E' la convenzione che la scheda gia' offre, ed e' anche
        // l'unica corretta: anima() aggancia l'animazione al frame clock
        // dell'attore, e un attore non montato non ne ha uno — la pulsazione
        // avviata nel costruttore resterebbe ferma al primo fotogramma, per poi
        // sbloccarsi all'apertura da un punto qualsiasi del ciclo.
        this.actor._dynIslandShow = () => this._avviaPulsazione();
        this.actor._dynIslandHide = () => this._fermaPulsazione();
    }

    aggiorna({ testo, nome, registrazione }) {
        this._tempo.text = testo ?? '';
        this._tempo.visible = !!testo;
        this._nome.text = nome ?? '';
        // Riavviare ha senso solo per una registrazione: una condivisione la
        // concede chi l'ha chiesta.
        this._nuova.visible = !!registrazione;
        this._stop.accessible_name = registrazione
            ? _('Stop recording') : _('Stop sharing');
    }

    // Stessa curva della pillola: seno fra piena e mezza opacita', mai a zero.
    // Un indicatore di registrazione che si spegne, anche per un istante, e' un
    // indicatore su cui non puoi contare.
    _avviaPulsazione() {
        if (this._pulsazione) return;
        const giro = () => {
            this._pulsazione = anima(this._stop, CICLO_PULSAZIONE, t => {
                const s = (1 + Math.cos(t * Math.PI * 2)) / 2;
                this._stop.opacity = Math.round(255 * (0.6 + 0.4 * s));
            }, () => { this._pulsazione = null; giro(); });
        };
        giro();
    }

    _fermaPulsazione() {
        this._pulsazione?.();
        this._pulsazione = null;
        // Si riparte da piena opacita': riaprendo la scheda il pallino non deve
        // ricomparire a meta' dissolvenza, come se fosse gia' in corso da prima.
        if (this._stop) this._stop.opacity = 255;
    }

    // Si schiaccia e torna con un sorpasso: e' il riscontro che dice "premuto"
    // prima ancora che l'effetto sia visibile.
    //
    // I NUMERI SONO STATI CALCOLATI, NON SCELTI A OCCHIO.
    //
    // Su questa pillola c'e' gia' un precedente: hover e pressione erano al 5%,
    // e sembrava che non succedesse niente. Non era un difetto dell'animazione —
    // era aritmetica. Il 5% di 52 pixel fa due pixel e mezzo, sotto la soglia di
    // percezione.
    //
    // Qui il pallino e' 26 pixel. Con una compressione al 78% si schiaccia di
    // 5,7 px, che si vede; il sorpasso della molla vale 1,3 px, che si sente
    // come rimbalzo senza sembrare un difetto. Con lo smorzamento 0,6 che avevo
    // messo per primo il sorpasso era 0,3 px: un terzo di pixel, cioe' niente.
    _animaPressione() {
        this._pressione?.();
        const daScala = this._stop.scale_x || 1;
        const GIU = 0.78;
        this._pressione = anima(this._stop, 110, t => {
            const s = daScala + (GIU - daScala) * t;
            this._stop.set_scale(s, s);
        }, () => {
            this._pressione = anima(this._stop, 360, t => {
                const s = GIU + (1 - GIU) * mollaApertura(t, 10, 0.42);
                this._stop.set_scale(s, s);
            }, () => { this._pressione = null; this._stop.set_scale(1, 1); });
        });
    }

    destroy() {
        // Prima si staccano gli agganci, poi si distrugge.
        //
        // La scheda tiene un riferimento a questo attore finche' non monta
        // qualcos'altro, e alla prossima apertura chiamerebbe _dynIslandHide
        // su un oggetto gia' deallocato. Toglierli qui e' la meta' del rimedio;
        // l'altra meta' e' la rete in expanded-island.js, che serve per le
        // viste scritte da altri.
        if (this.actor) {
            this.actor._dynIslandShow = null;
            this.actor._dynIslandHide = null;
        }
        this._fermaPulsazione();
        this._pressione?.();
        this._pressione = null;
        this.actor?.destroy();
        this.actor = null;
    }
}
