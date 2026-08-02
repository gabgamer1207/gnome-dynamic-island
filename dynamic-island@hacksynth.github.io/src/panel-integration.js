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

    // L'isola al centro mostra già l'ora a riposo: qui la togliamo dal menu
    // data per non averne due. Va sostituita con un'icona, altrimenti il
    // pulsante resta senza contenuto e non ci si può più cliccare sopra.
    _replaceClockWithIcon() {
        const clock = this._dateMenu?._clockDisplay;
        const box = clock?.get_parent();
        if (!clock || !box) return;

        this._calendarIcon = new St.Icon({
            icon_name: 'x-office-calendar-symbolic',
            style_class: 'system-status-icon',
        });
        box.insert_child_below(this._calendarIcon, clock);
        clock.hide();
        this._clockHidden = true;
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

        if (this._dateMenu) {
            // MODIFICA LOCALE: l'originale nascondeva il menu data, facendo
            // perdere calendario e notifiche. Qui invece lo spostiamo nel box
            // di sinistra: l'isola si prende il centro, il calendario resta
            // raggiungibile. La posizione originale viene ripristinata in unmount().
            const container = this._dateMenu.container;
            this._dateMenuParent = container.get_parent();
            if (this._dateMenuParent) {
                this._dateMenuIndex =
                    this._dateMenuParent.get_children().indexOf(container);
                this._dateMenuParent.remove_child(container);
                Main.panel._leftBox.add_child(container);
                container.show();
                this._replaceClockWithIcon();
            }
        }

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
        }
        this._mounted = false;
    }

    destroy() { this.unmount(); }
}
