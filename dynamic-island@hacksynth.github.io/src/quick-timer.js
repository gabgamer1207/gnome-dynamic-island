// Il timer nel menu di stato, accanto a Wi-Fi e Bluetooth.
//
// L'isola si comanda da riga di comando, il che va benissimo per uno script e
// male per un gesto quotidiano: nessuno apre un terminale per far partire un
// pomodoro. Qui c'e' l'interruttore che manca — stesso posto dove gia' cerchi
// le altre cose da accendere e spegnere.
//
// Il timer non dipende da nessuna applicazione esterna: vive dentro
// l'estensione, nel processo della shell. Questo comando quindi non "apre"
// niente, parla direttamente al provider che lo tiene.
//
// PERCHE' UN MENU E NON UN SEMPLICE INTERRUTTORE
//
// Un interruttore da solo dovrebbe indovinare la durata. Il menu offre le
// durate che si usano davvero e, per tutte le altre, la scelta col nastro
// sull'isola. Premere l'interruttore resta la scorciatoia: parte il pomodoro,
// che e' la durata piu' usata, e ripremendolo si ferma.

import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { QuickMenuToggle, SystemIndicator }
    from 'resource:///org/gnome/shell/ui/quickSettings.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { format } from './i18n.js';

// Le durate che si usano davvero: pomodoro, mezz'ora, pausa breve, pausa lunga.
// Un elenco piu' lungo non aiuterebbe — per tutto il resto c'e' il nastro.
const PRESET = [5, 10, 15, 25, 45, 60];
const PREDEFINITA = 25;

const Interruttore = GObject.registerClass(
class InterruttoreTimer extends QuickMenuToggle {
    _init(azioni) {
        super._init({
            title: _('Timer'),
            iconName: 'alarm-symbolic',
        });
        this._azioni = azioni;

        // Niente toggleMode: lo stato non lo decide il click, lo decide se il
        // timer sta andando. Con toggleMode l'interruttore si accenderebbe da
        // solo alla pressione anche se l'avvio fallisse.
        this.connect('clicked', () => this._azioni.alterna?.(PREDEFINITA * 60));

        this.menu.setHeader('alarm-symbolic', _('Timer'));
        for (const m of PRESET) {
            this.menu.addAction(
                format(_('%d minutes'), m),
                () => this._azioni.avvia?.(m * 60));
        }
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Choose duration…'), () => this._azioni.scegli?.());
        this.menu.addAction(_('Stop'), () => this._azioni.ferma?.());
    }

    aggiorna(inCorso, testo) {
        this.checked = inCorso;
        // Il tempo che resta si legge senza aprire niente: e' l'unica ragione
        // per cui vale la pena guardare qui invece che sull'isola.
        this.subtitle = inCorso ? testo : null;
    }
});

export class QuickTimer {
    // azioni: { alterna(secondi), avvia(secondi), ferma(), scegli() }
    constructor(azioni) {
        this._indicatore = new SystemIndicator();
        this._interruttore = new Interruttore(azioni);
        this._indicatore.quickSettingsItems.push(this._interruttore);

        const qs = Main.panel.statusArea.quickSettings;

        // Due strade, perche' il nome del metodo pubblico e' cambiato fra le
        // versioni della shell e su una versione che non lo ha l'estensione non
        // deve morire: perderebbe l'isola intera per un pulsante.
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
        // Gli elementi del menu vanno distrutti a mano: stanno nella griglia
        // del menu di stato, non dentro l'indicatore, quindi distruggere solo
        // quest'ultimo li lascerebbe orfani ma visibili.
        for (const it of this._indicatore?.quickSettingsItems ?? []) it.destroy();
        this._indicatore?.destroy();
        this._indicatore = null;
        this._interruttore = null;
    }
}
