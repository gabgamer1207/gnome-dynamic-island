import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _, ngettext } from 'resource:///org/gnome/shell/extensions/extension.js';
import { format } from './i18n.js';

export class PanelIntegration {
    constructor(view, satellite = null) {
        this._view = view;
        this._satellite = satellite;
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

    // MODIFICA LOCALE: rimosso l'orologio custom (era un doppione).
    //
    // Qui veniva creata un'etichetta St.Label con l'ora, aggiunta al _leftBox.
    // Aveva senso finche' l'orologio nativo veniva nascosto: serviva un
    // sostituto. Ma la modifica precedente ha deciso — giustamente — di non
    // nasconderlo piu', e _recuperaOrologio() ora chiama esplicitamente
    // clock.show().
    //
    // Le due modifiche insieme mettevano DUE orologi nel box di sinistra:
    // quello nativo con data e ora, e questo con la sola ora. Il click su
    // quello custom faceva dateMenu.menu.toggle(), quindi apriva il menu
    // dell'altro: due elementi, un solo comportamento.
    //
    // Vince il nativo: mostra anche la data, apre calendario e notifiche, e
    // non dipende da codice nostro. Il custom non aggiungeva niente.
    //
    // Rimossi con lui _aggiornaOra(), _distruggiOrologio() e la diagnostica
    // DYNISLAND-DIAG, che scriveva nel journal a ogni avvio.

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

        // Il satellite va aggiunto PRIMA della pillola: il box centrale
        // impacchetta i figli in ordine, quindi cosi' finisce alla sua
        // sinistra, che e' dove l'utente si aspetta l'attivita' "precedente".
        //
        // Sta nello stesso contenitore e non appeso sopra a coordinate
        // assolute: cosi' il gruppo resta centrato da solo e non c'e' niente da
        // riposizionare a mano quando la pillola cambia larghezza — cosa che fa
        // di continuo. Il prezzo e' che la pillola scivola di mezzo pallino
        // quando questo compare, ma il pallino entra con una molla e quello
        // scostamento si legge come l'isola che fa spazio.
        if (this._satellite) center.add_child(this._satellite);
        center.add_child(this._view);
        this._mounted = true;

        // Warn (don't fight) if other extensions added children.
        const siblings = center.get_children().filter(c => c !== this._view
            && c !== this._satellite
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
        if (this._satellite?.get_parent() === center)
            center.remove_child(this._satellite);

        // Rete di sicurezza: se una versione precedente aveva lasciato
        // l'orologio nascosto, qui torna visibile.
        this._restoreClock();

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
