// Il pallino accanto all'isola: le attivita' che non stanno sulla pillola.
//
// L'isola mostra una cosa sola. Finora, quando ne succedevano due, la seconda
// si prendeva il posto della prima e la prima spariva — o peggio, restavano
// entrambe registrate ma se ne vedeva una sola, senza che niente dicesse che
// l'altra c'era ancora.
//
// Il pallino e' il posto dove va a stare quella che non e' in primo piano.
// Nero e tondo come l'isola, dello stesso diametro della sua altezza: si legge
// come un pezzo staccato dello stesso oggetto, non come un'icona di sistema.
//
// COSA MOSTRA
//
// Sempre e solo la PRECEDENTE nell'anello, cioe' quella che un click
// riporterebbe in primo piano. Non e' un elenco di cosa c'e' in giro: e'
// un'anteprima di cosa succede se lo premi. Per questo non compare quando c'e'
// una sola attivita' — non porterebbe da nessuna parte.
//
// L'ANIMAZIONE DI DISTACCO
//
// Nasce sovrapposto alla pillola e scivola fuori verso sinistra mentre si
// allarga. Non e' un vezzo: se comparisse sul posto sembrerebbe un secondo
// oggetto arrivato da fuori, mentre cio' che e' successo davvero e' che una
// delle due attivita' si e' staccata dall'isola. L'animazione racconta la cosa
// giusta, e senza di essa la relazione fra i due oggetti andrebbe indovinata.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { anima } from './anima.js';
import { mollaApertura } from './spring.js';
import { Anello } from './views/anello.js';

const DIM = 28;                 // diametro: pari all'altezza della pillola
const DURATA_ENTRATA = 520;
const DURATA_USCITA = 340;
const DURATA_CAMBIO = 200;

export class Satellite {
    // azione: chiamata al click, fa ruotare l'anello delle attivita'
    constructor(azione) {
        this._azione = azione;
        this._attivita = null;
        this._visibile = false;
        this._fermaGeometria = null;
        this._fermaCambio = null;
        this._larghezzaScritta = -1;      // vedi _larghezza()

        // Contenitore che impila e centra: l'anello e il numero devono stare
        // uno sopra l'altro, non affiancati.
        this._dentro = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });

        this.actor = new St.Button({
            style_class: 'dynisland-satellite',
            can_focus: true,
            accessible_name: _('Other activity'),
            reactive: true,
            child: this._dentro,
        });
        this.actor.set_pivot_point(0.5, 0.5);

        // Il contenuto va tagliato ai bordi del pallino.
        //
        // In entrata e in uscita la larghezza passa per lo zero, ma l'icona
        // dentro conserva la propria: senza ritaglio si vedrebbe sporgere dai
        // due lati di un pallino largo pochi pixel, come se galleggiasse
        // staccata. Un attore Clutter non ritaglia i figli se non glielo si
        // chiede.
        this.actor.clip_to_allocation = true;
        // Sulla pressione, come tutti gli altri comandi dell'isola: la pillola
        // accanto cambia larghezza di continuo e questo pallino si sposta con
        // lei, quindi fra pressione e rilascio si muove sotto il puntatore e
        // 'clicked' non verrebbe emesso.
        this.actor.connect('button-press-event', () => {
            this._azione?.();
            return Clutter.EVENT_STOP;
        });

        this._icona = new St.Icon({
            style_class: 'dynisland-satellite-icona',
            icon_size: 15,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dentro.add_child(this._icona);

        this._anello = new Anello({ dimensione: 22, spessore: 2 });
        this._anello.actor.x_align = Clutter.ActorAlign.CENTER;
        this._anello.actor.y_align = Clutter.ActorAlign.CENTER;
        this._dentro.add_child(this._anello.actor);

        this._numero = new St.Label({
            style_class: 'dynisland-satellite-numero',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dentro.add_child(this._numero);

        this._larghezza(0);
        this.actor.opacity = 0;
        this.actor.visible = false;
    }

    // att: l'attivita' da mostrare, oppure null per ritirare il pallino.
    setAttivita(att) {
        const eraId = this._attivita?.id ?? null;
        this._attivita = att ?? null;

        if (!att) {
            if (this._visibile) this._esci();
            return;
        }

        if (!this._visibile) {
            this._contenuto(att);
            this._entra();
            return;
        }

        // Cambio di inquilino: il contenuto si scambia con una dissolvenza
        // breve. Sostituirlo di colpo, con il pallino fermo dov'e', si
        // leggerebbe come uno sfarfallio invece che come un avvicendamento.
        if (att.id !== eraId) this._cambia(att);
        else this._contenuto(att);        // stessa attivita', valori aggiornati
    }

    // ------------------------------------------------------------- contenuto
    _contenuto(att) {
        const g = att.glyph ?? {};
        const conAnello = Number.isFinite(g.frazione);

        this._anello.actor.visible = conAnello;
        this._numero.visible = conAnello && !!g.breve;
        this._icona.visible = !conAnello;

        if (conAnello) {
            this._anello.setFrazione(g.frazione, true);
            this._numero.text = g.breve ?? '';
            if (g.colore) this._numero.style = `color: ${g.colore};`;
        } else if (g.icon) {
            this._icona.gicon = g.icon;
        } else {
            // Un'attivita' senza glyph esiste — una spinta da riga di comando
            // senza --icona — e senza questo il pallino resterebbe vuoto.
            this._icona.icon_name = 'view-more-symbolic';
        }

        this.actor.accessible_name = att.label ?? _('Other activity');
    }

    _cambia(att) {
        this._fermaCambio?.();
        const meta = DURATA_CAMBIO / 2;
        this._fermaCambio = anima(this._dentro, meta, t => {
            this._dentro.opacity = Math.round(255 * (1 - t));
        }, () => {
            this._contenuto(att);
            this._fermaCambio = anima(this._dentro, meta, t => {
                this._dentro.opacity = Math.round(255 * t);
            }, () => { this._fermaCambio = null; this._dentro.opacity = 255; });
        });
    }

    // ------------------------------------------------------------ geometria
    //
    // La larghezza si scrive nello stile in linea, non con ease({width}): su un
    // attore St quest'ultimo non fa nulla, perche' St ricava la propria
    // dimensione da CSS e contenuto e scarta la richiesta di Clutter senza
    // segnalare niente. E' il difetto piu' ricorrente di questo programma —
    // trovato sulla pillola, sulla scheda, sulla barra della musica e su quella
    // generica — e qui sarebbe la quinta volta.
    _larghezza(px) {
        const w = Math.max(0, Math.round(px));
        // Si riscrive solo quando il pixel cambia davvero: ogni assegnazione a
        // .style fa rianalizzare il foglio in linea e rimisurare il contenitore,
        // e ripeterlo per un valore identico e' lavoro buttato in mezzo a
        // un'animazione, cioe' proprio dove costa.
        if (w === this._larghezzaScritta) return;
        this._larghezzaScritta = w;
        this.actor.style = `min-width: ${w}px; max-width: ${w}px;`;
    }

    // Smoothstep: la curva che parte e arriva con velocita' nulla.
    //
    // E' quella giusta per la geometria, perche' la larghezza di questo pallino
    // non muove solo lui — sta nel box centrale del pannello, quindi ogni
    // fotogramma ricentra il gruppo e sposta anche la PILLOLA. Una molla con
    // sorpasso, che era la scelta di prima, faceva quindi oscillare l'isola: si
    // spingeva in la' e tornava indietro, e quel rimbalzo su un oggetto grande
    // e' esattamente cio' che si legge come "di scatto".
    //
    // L'elasticita' non sparisce, cambia posto: sta nella scala del pallino, che
    // e' una trasformazione e non tocca il layout di nessuno.
    _liscia(t) { return t * t * (3 - 2 * t); }

    _entra() {
        this._visibile = true;
        this._fermaGeometria?.();
        this.actor.visible = true;

        const daX = DIM + 6;      // parte sovrapposto alla pillola
        this._fermaGeometria = anima(this.actor, DURATA_ENTRATA, t => {
            const g = this._liscia(t);
            this._larghezza(DIM * g);
            this.actor.translation_x = daX * (1 - g);

            // La scala parte piu' rapida della geometria e arriva con un
            // filo di sorpasso: e' il pallino a "spuntare fuori", mentre lo
            // spazio si apre sotto di lui senza strappi.
            const s = 0.62 + 0.38 * mollaApertura(Math.min(1, t * 1.25), 9, 0.62);
            this.actor.set_scale(s, s);

            // Entra prima di essere grande: cosi' si vede spuntare invece di
            // apparire gia' fatto.
            this.actor.opacity = Math.round(255 * Math.min(1, t * 2.2));
        }, () => {
            this._fermaGeometria = null;
            this._larghezza(DIM);
            this.actor.translation_x = 0;
            this.actor.set_scale(1, 1);
            this.actor.opacity = 255;
        });
    }

    _esci() {
        this._visibile = false;
        this._fermaGeometria?.();

        // In chiusura niente sorpasso da nessuna parte: un oggetto che si ritira
        // e poi rimbalza indietro non si legge come elastico, si legge come un
        // difetto. Si rientra nella pillola e ci si spegne.
        const daScala = this.actor.scale_x || 1;
        this._fermaGeometria = anima(this.actor, DURATA_USCITA, t => {
            const g = this._liscia(t);
            this._larghezza(DIM * (1 - g));
            this.actor.translation_x = (DIM + 6) * g;
            const s = daScala + (0.7 - daScala) * g;
            this.actor.set_scale(s, s);
            this.actor.opacity = Math.round(255 * (1 - g));
        }, () => {
            this._fermaGeometria = null;
            this.actor.visible = false;
            this.actor.translation_x = 0;
            this.actor.set_scale(1, 1);
            this._larghezza(0);
        });
    }

    destroy() {
        this._fermaGeometria?.();
        this._fermaCambio?.();
        this._fermaGeometria = this._fermaCambio = null;
        this._anello?.destroy();
        this._anello = null;
        this.actor?.destroy();
        this.actor = null;
    }
}
