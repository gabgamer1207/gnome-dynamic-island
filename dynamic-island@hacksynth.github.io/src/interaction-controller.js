import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { format } from './i18n.js';
import { providerDisplayName } from './provider-display.js';

export class InteractionController {
    constructor(view, manager, extension) {
        this._view = view;
        this._manager = manager;
        this._extension = extension;
        this._handlers = [];
        this._contextMenu = null;

        // MODIFICA LOCALE: senza un PopupMenuManager il menu contestuale apre
        // il proprio grab fuori dal sistema di GNOME, e la shell finisce in
        // "Invalid overview shown transition from HIDDEN to HIDING" a ogni
        // click destro. Il manager fa gestire il grab alla shell.
        this._menuManager = new PopupMenu.PopupMenuManager(this._view);

        this._handlers.push(
            view.connect('enter-event', () => { manager.setHover(true); return Clutter.EVENT_PROPAGATE; }),
            view.connect('leave-event', () => { manager.setHover(false); return Clutter.EVENT_PROPAGATE; }),
            view.connect('button-press-event', (_a, ev) => {
                const btn = ev.get_button();
                if (btn === Clutter.BUTTON_PRIMARY) {
                    // MODIFICA LOCALE: il click sinistro si limitava a fare
                    // toggle del "pin", quindi le notifiche non si aprivano
                    // mai. Ora apre la lista notifiche e il calendario, che
                    // e' quello che ci si aspetta cliccando sull'isola.
                    this._toggleMessageList();
                    return Clutter.EVENT_STOP;
                }
                if (btn === Clutter.BUTTON_MIDDLE) {
                    // Il pin resta disponibile, spostato sul tasto centrale.
                    manager.setPinned(!manager.isPinned());
                    return Clutter.EVENT_STOP;
                }
                if (btn === Clutter.BUTTON_SECONDARY) {
                    this._showContextMenu();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            }),
            view.connect('key-press-event', (_a, ev) => {
                if (ev.get_key_symbol() === Clutter.KEY_Escape) {
                    manager.setPinned(false);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            }),
        );
    }

    // MODIFICA LOCALE: apre il menu data, che contiene lista notifiche e
    // calendario. E' lo stesso menu dell'orologio di GNOME: panel-integration
    // lo sposta nel box di sinistra, ma resta questo l'oggetto da aprire.
    _toggleMessageList() {
        const dateMenu = Main.panel.statusArea?.dateMenu;
        if (!dateMenu?.menu) return;

        // Se e' aperto il menu contestuale dell'isola, prima lo chiudiamo:
        // due menu aperti insieme litigano per il grab.
        if (this._contextMenu?.isOpen) this._contextMenu.close();

        dateMenu.menu.toggle();
    }

    _showContextMenu() {
        if (this._contextMenu) {
            this._menuManager.removeMenu(this._contextMenu);
            this._contextMenu.destroy();
            this._contextMenu = null;
        }

        const menu = new PopupMenu.PopupMenu(this._view, 0.5, St.Side.TOP);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        this._menuManager.addMenu(menu);

        const prefsItem = new PopupMenu.PopupMenuItem(_('Preferences…'));
        prefsItem.connect('activate', () => this._extension.openPreferences());
        menu.addMenuItem(prefsItem);

        const vm = this._manager._lastVM;
        const current = vm?.flashing ?? vm?.leading ?? vm?.trailing;
        if (current) {
            const disableItem = new PopupMenu.PopupMenuItem(
                format(_('Disable %s'), providerDisplayName(current.providerId, _)));
            disableItem.connect('activate', () => {
                const settings = this._extension.getSettings();
                const enabled = new Set(settings.get_strv('providers-enabled'));
                enabled.delete(current.providerId);
                settings.set_strv('providers-enabled', [...enabled]);
            });
            menu.addMenuItem(disableItem);
        }

        // MODIFICA LOCALE: distruggere il menu dentro il suo stesso segnale di
        // chiusura lo elimina mentre la shell lo sta ancora usando. Rimandiamo
        // la distruzione al giro successivo del loop principale.
        menu.connect('open-state-changed', (m, isOpen) => {
            if (isOpen) return;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._menuManager.removeMenu(m);
                m.destroy();
                if (this._contextMenu === m) this._contextMenu = null;
                return GLib.SOURCE_REMOVE;
            });
        });

        this._contextMenu = menu;
        menu.open();
    }

    destroy() {
        if (this._contextMenu) {
            this._menuManager.removeMenu(this._contextMenu);
            this._contextMenu.destroy();
            this._contextMenu = null;
        }
        this._menuManager = null;
        for (const id of this._handlers) this._view.disconnect(id);
        this._handlers = [];
    }
}
