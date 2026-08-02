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

        // MODIFICA LOCALE: qui prima il menu data veniva spostato a forza nel
        // box di sinistra. Ma just-perfection ha una propria impostazione per
        // la posizione dell'orologio e la riapplica: due estensioni che
        // spostano lo stesso oggetto se lo tolgono a vicenda, e il risultato
        // e' che l'ora finisce dove capita o non si vede affatto.
        //
        // Ora non lo tocchiamo: dove sta l'orologio lo decide chi ha
        // l'impostazione apposta. Noi ci prendiamo solo il centro.
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

        this._mounted = false;
    }

    destroy() { this.unmount(); }
}
