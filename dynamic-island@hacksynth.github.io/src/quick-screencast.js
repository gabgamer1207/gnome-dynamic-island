// La registrazione dello schermo nel menu di stato, accanto al timer.
//
// GNOME la offre solo dalla scorciatoia di tastiera o dal pannello degli
// screenshot: due gesti che vanno ricordati. Qui sta dove cerchi le altre cose
// da accendere e spegnere, con il tempo trascorso leggibile senza aprire nulla.
//
// PERCHE' UN INTERRUTTORE SEMPLICE E NON UN MENU
//
// Il timer ha un menu perche' deve chiedere una durata. Una registrazione no:
// c'e' una sola cosa da fare, e farla o non farla e' esattamente uno stato
// acceso o spento. Un menu con dentro una voce sola sarebbe un ostacolo.
//
// Lo stato non lo decide il click ma il registro di Mutter: se l'avvio
// fallisce, l'interruttore non deve restare acceso a mentire.

import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { QuickToggle, SystemIndicator }
    from 'resource:///org/gnome/shell/ui/quickSettings.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const Interruttore = GObject.registerClass(
class InterruttoreRegistrazione extends QuickToggle {
    _init(azioni) {
        super._init({
            title: _('Screen Recording'),
            iconName: 'media-record-symbolic',
        });
        this._azioni = azioni;
        // Niente toggleMode: vedi l'intestazione — lo stato lo riporta Mutter,
        // non la pressione.
        this.connect('clicked', () => this._azioni.alterna?.());
    }

    aggiorna(inCorso, testo) {
        this.checked = inCorso;
        this.subtitle = inCorso ? testo : null;
    }
});

export class QuickScreencast {
    // azioni: { alterna() }
    constructor(azioni) {
        this._indicatore = new SystemIndicator();
        this._interruttore = new Interruttore(azioni);
        this._indicatore.quickSettingsItems.push(this._interruttore);

        const qs = Main.panel.statusArea.quickSettings;
        // Due strade, come per il timer: il nome del metodo pubblico e' cambiato
        // fra le versioni della shell, e su una che non lo ha l'estensione non
        // deve perdere l'isola per un pulsante.
        if (typeof qs?.addExternalIndicator === 'function') {
            qs.addExternalIndicator(this._indicatore);
        } else if (qs) {
            qs._indicators.add_child(this._indicatore);
            qs._addItems(this._indicatore.quickSettingsItems);
        }
    }

    aggiorna(inCorso, testo) {
        this._interruttore?.aggiorna(inCorso, testo ?? '');
    }

    destroy() {
        // Gli elementi stanno nella griglia del menu, non dentro l'indicatore:
        // distruggere solo quest'ultimo li lascerebbe orfani ma visibili.
        for (const it of this._indicatore?.quickSettingsItems ?? []) it.destroy();
        this._indicatore?.destroy();
        this._indicatore = null;
        this._interruttore = null;
    }
}
