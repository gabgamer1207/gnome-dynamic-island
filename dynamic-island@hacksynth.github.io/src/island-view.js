import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { format } from './i18n.js';
import { resolveIdleText } from './idle-content.js';

export const IslandView = GObject.registerClass(
class IslandView extends St.Widget {
    _init() {
        super._init({
            style_class: 'dynisland-pill state-idle',
            // BinLayout stacks base + flash overlay; each child's y_align
            // handles vertical centering inside the pill's content box.
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.accessible_role = 2; // ATK_ROLE_PUSH_BUTTON
        this.can_focus = false;

        // Underlying content (compact/split/expanded) stays mounted.
        this._baseLabel = new St.Label({
            style_class: 'dynisland-label',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._baseLabel);

        // Overlay child for transient flashes. While it is visible, the base
        // label is hidden so stacked text does not overlap.
        this._flashLabel = new St.Label({
            style_class: 'dynisland-label',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
            visible: false,
        });
        this.add_child(this._flashLabel);

        this._currentFlashId = null;
        this._settings = null;
        this._settingsHandlers = [];
        this._lastVM = null;

        // MODIFICA LOCALE: teniamo traccia dello stato per animare solo i
        // cambi veri, e mettiamo il perno al centro cosi' lo "schiacciamento"
        // parte dal mezzo della pillola e non dall'angolo.
        this._currentState = null;
        this.set_pivot_point(0.5, 0.5);
    }

    // MODIFICA LOCALE: alcune curve potrebbero non esserci su versioni
    // diverse di Clutter; in quel caso si ripiega su una decelerazione
    // normale invece di far esplodere l'estensione.
    _mode(nome) {
        return Clutter.AnimationMode[nome] ?? Clutter.AnimationMode.EASE_OUT_CUBIC;
    }

    // MODIFICA LOCALE: rientro animato del testo di base (orario o attivita').
    _entraBase() {
        this._baseLabel.remove_all_transitions();
        this._baseLabel.opacity = 0;
        this._baseLabel.translation_y = 5;
        this._baseLabel.show();
        this._baseLabel.ease({
            opacity: 255,
            translation_y: 0,
            duration: 220,
            mode: this._mode('EASE_OUT_CUBIC'),
        });
    }

    // MODIFICA LOCALE: rete di sicurezza. Riporta il testo di base allo stato
    // pieno e visibile senza animazioni, qualunque cosa sia successo prima.
    // Serve perche' l'orario a riposo non deve MAI poter restare invisibile.
    _resetBase() {
        this._baseLabel.remove_all_transitions();
        this._baseLabel.opacity = 255;
        this._baseLabel.translation_y = 0;
        this._baseLabel.show();
        this._flashLabel.translation_y = 0;
    }

    // MODIFICA LOCALE
    // La Dynamic Island vera non usa una curva di easing: usa una molla.
    // Parte decisa, supera di poco la misura finale e si assesta. Per questo
    // in apertura serve EASE_OUT_BACK, che quel sorpasso ce l'ha.
    // In chiusura invece si usa EASE_OUT_QUINT: un rimbalzo mentre l'oggetto
    // si richiude non sembra elastico, sembra un errore.
    _morph() {
        const da = this.get_width();
        this.set_width(-1);                        // rimisura al naturale
        const a = this.get_preferred_width(-1)[1];
        if (!da || !a || Math.abs(a - da) < 2) { this.set_width(-1); return; }

        const espande = a > da;

        this.remove_transition('width');
        this.remove_transition('scale-y');

        this.set_width(da);
        this.ease({
            width: a,
            duration: espande ? 340 : 380,
            mode: espande ? this._mode('EASE_OUT_BACK') : this._mode('EASE_OUT_QUINT'),
            // Va tolta la larghezza fissa quando l'animazione finisce,
            // altrimenti la pillola non si adatta piu' al testo che cambia.
            // onStopped e non onComplete: scatta anche se l'animazione viene
            // interrotta a meta' da un nuovo cambio di stato. Con onComplete
            // una larghezza fissa poteva restare incastrata li' per sempre.
            onStopped: () => this.set_width(-1),
        });

        // Micro schiacciamento verticale: e' quello che fa percepire materia
        // elastica invece di un rettangolo che cambia numero.
        this.scale_y = espande ? 0.92 : 1.05;
        this.ease({
            scale_y: 1,
            duration: 300,
            mode: this._mode('EASE_OUT_BACK'),
        });
    }

    setSettings(settings) {
        this._disconnectSettings();
        this._settings = settings;
        if (!settings) return;

        this._settingsHandlers = [
            settings.connect('changed::idle-content', () => this._refreshIdleContent()),
            settings.connect('changed::idle-custom-text', () => this._refreshIdleContent()),
        ];
        this._refreshIdleContent();
    }

    setViewModel(vm) {
        this._lastVM = vm;

        const states = ['idle', 'compact', 'split', 'expanded'];
        for (const s of states) this.remove_style_class_name(`state-${s}`);
        this.add_style_class_name(`state-${vm.baseState}`);

        // Base content always reflects the underlying slots (never cleared by a flash).
        const basePrimary = vm.leading ?? vm.trailing;
        const idleText = basePrimary ? '' : this._idleText();
        this._baseLabel.text = basePrimary ? this._formatBase(vm, basePrimary) : idleText;
        this.accessible_name = basePrimary ? basePrimary.label : (idleText || _('Dynamic Island (idle)'));

        // MODIFICA LOCALE: la geometria non passa piu' dal CSS (St ignora le
        // timing function e faceva scattare la pillola da una misura all'altra).
        // Va DOPO l'aggiornamento del testo: _morph misura la larghezza
        // naturale, e con il testo vecchio misurerebbe la larghezza sbagliata.
        // Al primo giro non animiamo: non c'e' uno stato da cui partire.
        if (this._currentState !== vm.baseState) {
            const primoGiro = this._currentState === null;
            this._currentState = vm.baseState;
            if (!primoGiro) this._morph();
        }

        // Transient overlay lifecycle.
        // MODIFICA LOCALE: il testo entra da sotto e esce verso l'alto, invece
        // di apparire e sparire sul posto. Una dissolvenza secca si legge come
        // "lo schermo e' cambiato"; uno scorrimento si legge come "l'oggetto si
        // e' mosso", ed e' quella la differenza che rende viva l'animazione.
        if (vm.flashing) {
            this._baseLabel.hide();
            if (vm.flashing.id !== this._currentFlashId) {
                this._currentFlashId = vm.flashing.id;
                this._flashLabel.text = vm.flashing.sublabel
                    ? `${vm.flashing.label} — ${vm.flashing.sublabel}`
                    : vm.flashing.label;
                this._flashLabel.remove_all_transitions();
                this._flashLabel.opacity = 0;
                this._flashLabel.translation_y = 7;
                this._flashLabel.show();
                this._flashLabel.ease({
                    opacity: 255,
                    translation_y: 0,
                    duration: 260,
                    mode: this._mode('EASE_OUT_BACK'),
                });
                this.add_style_class_name('flashing');
                this.accessible_description = format(_('Flash: %s'), vm.flashing.label);
            }
        } else if (this._currentFlashId) {
            this._currentFlashId = null;
            this._flashLabel.remove_all_transitions();
            this._flashLabel.ease({
                opacity: 0,
                translation_y: -7,
                // L'uscita e' piu' rapida dell'entrata: cosi' la pillola
                // sembra reattiva invece che lenta a liberarsi.
                duration: 180,
                mode: this._mode('EASE_IN_QUAD'),
                onStopped: () => { if (!this._currentFlashId) this._flashLabel.hide(); },
            });
            // MODIFICA LOCALE: il testo di base rientra SUBITO, in dissolvenza
            // incrociata con l'uscita del flash, invece di aspettarne la fine.
            // Prima dipendeva da onComplete: se arrivava una seconda notifica
            // mentre la prima usciva, quella transizione veniva annullata, la
            // callback non scattava piu' e l'orario spariva per sempre.
            this._entraBase();
            this.remove_style_class_name('flashing');
            this.accessible_description = '';
        } else {
            this._flashLabel.hide();
            this._resetBase();
        }
    }

    _formatBase(vm, primary) {
        if (vm.baseState === 'split' && vm.leading && vm.trailing)
            return `${vm.leading.label} · ${vm.trailing.label}`;
        if (vm.baseState === 'expanded' && primary.sublabel)
            return `${primary.label} — ${primary.sublabel}`;
        return primary.label;
    }

    _idleText() {
        const mode = this._settings?.get_string('idle-content') ?? 'clock';
        const customText = this._settings?.get_string('idle-custom-text') ?? '';
        return resolveIdleText(mode, customText, this._clockText());
    }

    _clockText() {
        return GLib.DateTime.new_now_local().format('%H:%M') ?? '';
    }

    _refreshIdleContent() {
        if (this._lastVM && !(this._lastVM.leading ?? this._lastVM.trailing))
            this.setViewModel(this._lastVM);
    }

    _disconnectSettings() {
        if (!this._settings) return;
        for (const handler of this._settingsHandlers) this._settings.disconnect(handler);
        this._settingsHandlers = [];
        this._settings = null;
    }

    destroy() {
        this._disconnectSettings();
        super.destroy();
    }
});
