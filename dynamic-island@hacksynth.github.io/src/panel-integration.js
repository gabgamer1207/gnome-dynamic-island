import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _, ngettext } from 'resource:///org/gnome/shell/extensions/extension.js';
import { format } from './i18n.js';

export class PanelIntegration {
    constructor(view) {
        this._view = view;
        this._dateMenu = Main.panel.statusArea.dateMenu;
        this._dateMenuParent = null;
        this._dateMenuIndex = -1;
        this._calendarIcon = null;
        this._clockHidden = false;
        this._mounted = false;
    }

    // MODIFICA LOCALE: qui l'orologio del pannello veniva nascosto e sostituito
    // da un'icona, perché "tanto l'ora la mostra l'isola a riposo".
    //
    // È il difetto di fondo: l'isola si prendeva il mestiere dell'orologio, ma
    // basta una notifica non letta — che è un'attività persistente — per
    // occupare l'isola a tempo indeterminato. Risultato: l'ora sparisce dal
    // sistema finché non svuoti il centro notifiche.
    //
    // L'ora non è un contenuto fra gli altri, è infrastruttura: non può
    // dipendere da cosa sta succedendo. Ora l'orologio resta l'orologio, si
    // sposta solo a sinistra per lasciare il centro all'isola, e l'isola sta
    // vuota quando non ha niente da dire — come la Dynamic Island vera.
    _replaceClockWithIcon() {
        // volutamente vuoto: l'orologio non si tocca più
    }

    // MODIFICA LOCALE: orologio nostro.
    //
    // Tentare di far riapparire il _clockDisplay di GNOME si e' rivelato
    // inaffidabile: e' un componente interno, il nome puo' cambiare fra
    // versioni, e resta nascosto per stati lasciati indietro da sessioni
    // precedenti che non possiamo piu' ricostruire.
    //
    // Un'etichetta nostra e' meno elegante ma non ha nessuna di quelle
    // dipendenze: la creiamo noi, la aggiorniamo noi, la distruggiamo noi.
    // Per una cosa che deve semplicemente esserci sempre, e' il compromesso
    // giusto. Il click apre comunque il calendario di GNOME, cosi' non si
    // perde niente rispetto all'originale.
    _creaOrologio() {
        if (this._orologio) return;

        this._orologio = new St.Button({
            style_class: 'panel-button dynisland-clock',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._etichettaOra = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'dynisland-clock-label',
        });
        this._orologio.set_child(this._etichettaOra);
        this._orologio.connect('clicked', () => {
            Main.panel.statusArea?.dateMenu?.menu?.toggle();
        });

        const box = Main.panel._leftBox;
        log(`DYNISLAND-DIAG leftBox=${!!box} figli_prima=${box?.get_n_children()}`);
        box.add_child(this._orologio);
        this._aggiornaOra();

        // Diagnostica: l'allocazione reale si conosce solo dopo un giro di
        // layout, non subito dopo add_child.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            const [w, h] = this._orologio?.get_size() ?? [0, 0];
            const [x, y] = this._orologio?.get_transformed_position() ?? [0, 0];
            log(`DYNISLAND-DIAG orologio testo="${this._etichettaOra?.text}" ` +
                `size=${w}x${h} pos=${x},${y} visible=${this._orologio?.visible} ` +
                `opacity=${this._orologio?.opacity} mapped=${this._orologio?.mapped}`);
            log(`DYNISLAND-DIAG leftBox figli_dopo=${box.get_n_children()} ` +
                `boxSize=${box.get_width()}x${box.get_height()} ` +
                `boxPos=${box.get_transformed_position()}`);
            for (const c of box.get_children()) {
                log(`DYNISLAND-DIAG   figlio ${c.constructor.name} ` +
                    `visible=${c.visible} size=${c.get_width()}x${c.get_height()}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _aggiornaOra() {
        const adesso = GLib.DateTime.new_now_local();
        if (this._etichettaOra) this._etichettaOra.text = adesso.format('%H:%M');

        // Riallineato al minuto successivo invece che ogni 60 secondi fissi:
        // cosi' l'ora cambia quando cambia davvero, non con un ritardo che
        // si accumula a ogni ciclo.
        const alProssimoMinuto = 60 - adesso.get_second();
        this._oraId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, alProssimoMinuto, () => {
                this._oraId = 0;
                this._aggiornaOra();
                return GLib.SOURCE_REMOVE;
            });
    }

    _distruggiOrologio() {
        if (this._oraId) { GLib.source_remove(this._oraId); this._oraId = 0; }
        this._orologio?.destroy();
        this._orologio = null;
        this._etichettaOra = null;
    }

    // MODIFICA LOCALE: recupero da versioni precedenti.
    //
    // Il vecchio codice nascondeva l'orologio e infilava un'icona calendario
    // al suo posto, annullando tutto in unmount(). Ma se la shell ricarica
    // l'estensione senza passare da unmount (crash, aggiornamento, sessione
    // interrotta), quell'icona resta nel pannello e l'orologio resta nascosto
    // per sempre: l'istanza nuova parte con _calendarIcon = null e non sa
    // nemmeno che ci siano da togliere.
    //
    // Qui li andiamo a cercare per davvero, invece di fidarci di uno stato
    // che potrebbe non essere mai stato scritto.
    _recuperaOrologio() {
        const dm = this._dateMenu;
        if (!dm) return;

        // _clockDisplay è il nome interno di GNOME; se un giorno cambia,
        // ripieghiamo sulla prima etichetta dentro il pulsante.
        let clock = dm._clockDisplay;
        const box = clock?.get_parent() ?? dm.container?.get_first_child();
        if (!box) return;

        if (!clock) {
            for (const c of box.get_children()) {
                if (c instanceof St.Label) { clock = c; break; }
            }
        }

        for (const c of box.get_children()) {
            if (c !== clock && c instanceof St.Icon &&
                c.icon_name === 'x-office-calendar-symbolic')
                c.destroy();
        }

        clock?.show();
    }

    _restoreClock() {
        if (this._calendarIcon) {
            this._calendarIcon.destroy();
            this._calendarIcon = null;
        }
        if (this._clockHidden) {
            this._dateMenu?._clockDisplay?.show();
            this._clockHidden = false;
        }
    }

    mount() {
        if (this._mounted) return;
        const center = Main.panel._centerBox;

        // MODIFICA LOCALE: il menu data (orologio + calendario) si sposta nel
        // box di sinistra, cosi' il centro resta libero per l'isola.
        //
        // Due avvertenze imparate a caro prezzo:
        //   - l'orologio NON si nasconde. L'originale lo sostituiva con
        //     un'icona dando per scontato che l'ora la mostrasse l'isola, ma
        //     basta una notifica non letta (attivita' persistente) per
        //     occupare l'isola a tempo indeterminato e restare senza ora.
        //   - questo spostamento funziona solo se nessun'altra estensione
        //     rivendica la posizione dell'orologio. just-perfection lo fa
        //     tramite clock-menu-position e se e' attiva vince lei: in quel
        //     caso conviene disattivarla o lasciarle il compito.
        if (this._dateMenu) {
            const container = this._dateMenu.container;
            this._dateMenuParent = container.get_parent();
            if (this._dateMenuParent) {
                this._dateMenuIndex =
                    this._dateMenuParent.get_children().indexOf(container);
                this._dateMenuParent.remove_child(container);
                Main.panel._leftBox.add_child(container);
                container.show();
                this._recuperaOrologio();   // toglie eventuali avanzi
            }
        }

        // L'ora la mettiamo noi, a sinistra, e non dipende da nessuno.
        this._creaOrologio();

        center.add_child(this._view);
        this._mounted = true;

        // Warn (don't fight) if other extensions added children.
        const siblings = center.get_children().filter(c => c !== this._view
            && (!this._dateMenu || c !== this._dateMenu.container));
        if (siblings.length > 0) {
            Main.notify(_('Dynamic Island'),
                format(
                    ngettext(
                        'Detected %d other center-box extension. Layout may be cramped.',
                        'Detected %d other center-box extensions. Layout may be cramped.',
                        siblings.length),
                    siblings.length));
        }
    }

    unmount() {
        if (!this._mounted) return;
        const center = Main.panel._centerBox;
        if (this._view.get_parent() === center) center.remove_child(this._view);

        // Rete di sicurezza: se una versione precedente aveva lasciato
        // l'orologio nascosto, qui torna visibile.
        this._restoreClock();
        this._distruggiOrologio();

        if (this._dateMenu && this._dateMenuParent) {
            // Rimette il menu data dove stava, all'indice originale.
            const container = this._dateMenu.container;
            const parent = container.get_parent();
            if (parent) parent.remove_child(container);
            if (this._dateMenuIndex >= 0)
                this._dateMenuParent.insert_child_at_index(container, this._dateMenuIndex);
            else
                this._dateMenuParent.add_child(container);
            container.show();
            this._dateMenu._clockDisplay?.show();
        }

        this._mounted = false;
    }

    destroy() { this.unmount(); }
}
