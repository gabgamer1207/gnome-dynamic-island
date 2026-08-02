// La scheda espansa: quello che il pannello di GNOME non puo' contenere.
//
// #panel ha un'altezza fissa (2.2em) e NON cresce per contenere i figli.
// Qualunque cosa viva dentro Main.panel._centerBox puo' allargarsi ma mai
// diventare piu' alta. La Dynamic Island vera pero' non si allarga nel
// pannello: scende sotto. Per farlo serve un attore che dal pannello esca.
//
// Questa scheda vive quindi in Main.layoutManager (top chrome), posizionata
// a mano sotto il centro del pannello, senza vincoli di dimensione.
//
// Il trucco che rende credibile il morph: la scheda NON compare sotto la
// pillola. Nasce esattamente sopra di essa, con la sua stessa geometria e lo
// stesso raggio, e da li' cresce. L'occhio legge un oggetto solo che cambia
// forma invece di due elementi che si danno il cambio.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const LARGHEZZA_MAX = 420;
const MARGINE_SCHERMO = 24;
const RAGGIO_SCHEDA = 22;

export class ExpandedIsland {
    constructor(pill) {
        this._pill = pill;
        this._aperta = false;
        this._chiusuraId = 0;

        // Fondale trasparente a tutto schermo: intercetta i click fuori dalla
        // scheda per richiuderla. Preferito a un grab modale, che ruba la
        // tastiera a tutto il sistema e puo' fallire.
        this._fondale = new St.Widget({
            reactive: true,
            visible: false,
            style_class: 'dynisland-backdrop',
        });
        this._fondale.connect('button-press-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });

        this._scheda = new St.BoxLayout({
            vertical: true,
            reactive: true,
            can_focus: true,
            visible: false,
            style_class: 'dynisland-card',
        });
        this._scheda.set_pivot_point(0.5, 0.0);   // cresce verso il basso

        this._scheda.connect('key-press-event', (_a, ev) => {
            if (ev.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // --- riga principale: icona + testi ---
        this._riga = new St.BoxLayout({ style_class: 'dynisland-card-row' });

        this._icona = new St.Icon({
            style_class: 'dynisland-card-icon',
            icon_name: 'application-x-executable-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._riga.add_child(this._icona);

        const testi = new St.BoxLayout({
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style_class: 'dynisland-card-text',
        });
        this._titolo = new St.Label({ style_class: 'dynisland-card-title' });
        this._sottotitolo = new St.Label({ style_class: 'dynisland-card-subtitle' });
        this._titolo.clutter_text.ellipsize = 3;        // PANGO_ELLIPSIZE_END
        this._sottotitolo.clutter_text.ellipsize = 3;
        testi.add_child(this._titolo);
        testi.add_child(this._sottotitolo);
        this._riga.add_child(testi);

        this._scheda.add_child(this._riga);

        // Contenitore per la vista che il provider puo' fornire (activity.expandedView).
        this._slotProvider = new St.Bin({ x_expand: true, visible: false });
        this._scheda.add_child(this._slotProvider);

        this._vistaProvider = null;

        Main.layoutManager.addTopChrome(this._fondale, { affectsInputRegion: true });
        Main.layoutManager.addTopChrome(this._scheda, { affectsInputRegion: true });
    }

    get isOpen() { return this._aperta; }

    // --------------------------------------------------------------- contenuto
    setActivity(act) {
        this._attivita = act ?? null;

        if (!act) {
            this._titolo.text = _('Nothing happening');
            this._sottotitolo.text = '';
            this._sottotitolo.visible = false;
            this._icona.icon_name = 'preferences-system-time-symbolic';
            this._staccaVistaProvider();
            return;
        }

        this._titolo.text = act.label ?? '';
        this._sottotitolo.text = act.sublabel ?? '';
        this._sottotitolo.visible = !!act.sublabel;

        if (act.glyph?.icon) this._icona.gicon = act.glyph.icon;
        else this._icona.icon_name = 'view-more-symbolic';

        // Vista personalizzata del provider, se c'e'. Non la distruggiamo mai:
        // e' roba sua, noi la ospitiamo e basta.
        this._staccaVistaProvider();
        if (act.expandedView) {
            this._vistaProvider = act.expandedView;
            this._slotProvider.set_child(act.expandedView);
            this._slotProvider.visible = true;
        }
    }

    _staccaVistaProvider() {
        if (this._vistaProvider) {
            this._slotProvider.set_child(null);
            this._vistaProvider = null;
        }
        this._slotProvider.visible = false;
    }

    // ------------------------------------------------------------- geometria
    _rettangoloPillola() {
        const [x, y] = this._pill.get_transformed_position();
        const [w, h] = this._pill.get_transformed_size();
        return { x, y, w: Math.max(w, 1), h: Math.max(h, 1) };
    }

    _rettangoloScheda() {
        const monitor = Main.layoutManager.primaryMonitor;
        const pill = this._rettangoloPillola();

        const w = Math.min(LARGHEZZA_MAX, monitor.width - MARGINE_SCHERMO * 2);
        const [, hNaturale] = this._scheda.get_preferred_height(w);
        const h = Math.max(hNaturale, 96);

        // Centrata sulla pillola, ma senza uscire dallo schermo.
        let x = pill.x + pill.w / 2 - w / 2;
        x = Math.max(monitor.x + MARGINE_SCHERMO,
                     Math.min(x, monitor.x + monitor.width - w - MARGINE_SCHERMO));

        // Parte leggermente sovrapposta al pannello: la scheda deve sembrare
        // uscita da li', non comparsa piu' sotto.
        const y = pill.y + pill.h - 6;

        return { x, y, w, h };
    }

    // ------------------------------------------------------------- apertura
    open() {
        if (this._aperta) return;
        this._aperta = true;

        if (this._chiusuraId) {
            GLib.source_remove(this._chiusuraId);
            this._chiusuraId = 0;
        }

        const monitor = Main.layoutManager.primaryMonitor;
        this._fondale.set_position(monitor.x, monitor.y);
        this._fondale.set_size(monitor.width, monitor.height);
        this._fondale.show();

        const da = this._rettangoloPillola();

        // La scheda nasce con la geometria esatta della pillola.
        this._scheda.remove_all_transitions();
        this._scheda.set_position(da.x, da.y - da.h);
        this._scheda.set_size(da.w, da.h);
        this._scheda.style = `border-radius: ${Math.round(da.h / 2)}px;`;
        this._scheda.opacity = 0;
        this._scheda.show();

        // Va misurata da visibile, altrimenti l'altezza naturale e' zero.
        const a = this._rettangoloScheda();

        this._scheda.ease({
            x: a.x, y: a.y, width: a.w, height: a.h,
            opacity: 255,
            duration: 400,
            // Il sorpasso e' quello che fa sembrare la scheda un oggetto con
            // una massa, non un pannello che si disegna.
            mode: this._mode('EASE_OUT_BACK'),
        });

        // Il raggio non e' animabile via ease (e' stile, non proprieta'):
        // lo interpoliamo a mano su pochi passi. Bastano: il movimento
        // domina la percezione, il raggio la accompagna.
        this._animaRaggio(Math.round(da.h / 2), RAGGIO_SCHEDA, 400);

        // Il contenuto entra in ritardo sulla forma. E' il dettaglio che
        // separa "si e' aperto qualcosa" da "quella cosa e' diventata questa".
        this._riga.opacity = 0;
        this._riga.translation_y = 12;
        this._riga.ease({
            opacity: 255, translation_y: 0,
            duration: 300, delay: 120,
            mode: this._mode('EASE_OUT_CUBIC'),
        });

        this._scheda.grab_key_focus();
    }

    close() {
        if (!this._aperta) return;
        this._aperta = false;

        const a = this._rettangoloPillola();

        this._scheda.remove_all_transitions();
        this._riga.ease({
            opacity: 0, translation_y: 8,
            duration: 120,
            mode: this._mode('EASE_IN_QUAD'),
        });

        this._scheda.ease({
            x: a.x, y: a.y - a.h, width: a.w, height: a.h,
            opacity: 0,
            duration: 320,
            // Nessun rimbalzo in chiusura: sembrerebbe un errore, non elasticita'.
            mode: this._mode('EASE_OUT_QUINT'),
            onStopped: () => {
                this._scheda.hide();
                this._fondale.hide();
                this._staccaVistaProvider();
            },
        });

        this._animaRaggio(RAGGIO_SCHEDA, Math.round(a.h / 2), 320);
    }

    toggle() { this._aperta ? this.close() : this.open(); }

    // Interpolazione manuale del raggio: St non anima le proprieta' di stile.
    _animaRaggio(da, a, durata) {
        if (this._raggioId) { GLib.source_remove(this._raggioId); this._raggioId = 0; }
        const passi = 12;
        const intervallo = Math.max(16, Math.round(durata / passi));
        let i = 0;
        this._raggioId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervallo, () => {
            i++;
            const t = Math.min(1, i / passi);
            // Stessa decelerazione dell'animazione principale, cosi' i due
            // movimenti restano in fase.
            const e = 1 - Math.pow(1 - t, 3);
            const r = Math.round(da + (a - da) * e);
            this._scheda.style = `border-radius: ${r}px;`;
            if (t >= 1) { this._raggioId = 0; return GLib.SOURCE_REMOVE; }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _mode(nome) {
        return Clutter.AnimationMode[nome] ?? Clutter.AnimationMode.EASE_OUT_CUBIC;
    }

    destroy() {
        if (this._raggioId) { GLib.source_remove(this._raggioId); this._raggioId = 0; }
        if (this._chiusuraId) { GLib.source_remove(this._chiusuraId); this._chiusuraId = 0; }
        this._staccaVistaProvider();
        Main.layoutManager.removeChrome(this._scheda);
        Main.layoutManager.removeChrome(this._fondale);
        this._scheda.destroy();
        this._fondale.destroy();
        this._scheda = null;
        this._fondale = null;
    }
}
