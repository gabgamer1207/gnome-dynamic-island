// Timer e Pomodoro nell'isola.
//
// iOS mostra i timer nella Dynamic Island con il conto alla rovescia sempre
// visibile: non serve tornare all'app per sapere quanto manca. E' il caso d'uso
// in cui un'informazione persistente e piccola vale piu' di una finestra.
//
// Si comanda da riga di comando o da scorciatoia di tastiera, tramite la stessa
// interfaccia D-Bus del provider generico:
//
//     Avvia 25 minuti di studio:
//     gdbus call --session --dest org.gnome.Shell.Extensions.DynamicIsland \
//       --object-path /org/gnome/Shell/Extensions/DynamicIsland/Timer \
//       --method org.gnome.Shell.Extensions.DynamicIsland.Timer.Start 1500 "Studio"
//
//     Ferma:
//     ... --method org.gnome.Shell.Extensions.DynamicIsland.Timer.Stop
//
// Lo script `isola` in bin/ avvolge tutto questo: `isola timer 25m Studio`.
//
// PERCHE' NON UNA FINESTRA
//
// Un timer da studio ha un requisito preciso: deve essere visibile senza essere
// invadente. Una finestra va tenuta sopra le altre e ruba spazio; una notifica
// arriva solo alla fine, quando ormai non serve piu' sapere quanto manca.
// L'isola e' l'unico posto che soddisfa entrambe le cose.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { createActivity, _now } from '../activity.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { format } from '../i18n.js';
import { acquisisciNome, rilasciaNome, PERCORSO_BASE } from '../bus-name.js';
import { TimerView } from '../views/timer-view.js';
import { TimerSetupView, formattaDurata } from '../views/timer-setup-view.js';
import { QuickTimer } from '../quick-timer.js';

// Percorso e interfaccia PROPRI, non quelli di dbus.js: un'interfaccia si puo'
// esportare una sola volta per percorso, e i due provider si accendono in modo
// indipendente. Condividono solo il nome sul bus, che e' cio' che serve
// all'utente per chiamarli.
const PERCORSO = `${PERCORSO_BASE}/Timer`;
const INTERFACCIA = 'org.gnome.Shell.Extensions.DynamicIsland.Timer';

const XML = `
<node>
  <interface name="${INTERFACCIA}">
    <method name="Start">
      <arg type="i" direction="in" name="secondi"/>
      <arg type="s" direction="in" name="etichetta"/>
    </method>
    <method name="Stop"/>
    <method name="Setup"/>
    <method name="Add">
      <arg type="i" direction="in" name="secondi"/>
    </method>
    <method name="Pause"/>
    <method name="Resume"/>
    <method name="Toggle"/>
    <method name="Status">
      <arg type="i" direction="out" name="restanti"/>
      <arg type="s" direction="out" name="etichetta"/>
    </method>
  </interface>
</node>`;

export class TimerProvider {
    constructor() {
        this.id = 'timer';
        this._manager = null;
        this._settings = null;
        this._impl = null;
        this._tickId = 0;
        this._fine = 0;
        this._totale = 0;
        this._etichetta = '';
        this._nomePreso = false;
        this._pausa = 0;          // secondi congelati, 0 = in corsa
        this._vista = null;
        this._vistaScelta = null;
        this._quick = null;
    }

    enable(manager, settings) {
        this._manager = manager;
        this._settings = settings;

        try {
            this._impl = Gio.DBusExportedObject.wrapJSObject(XML, this);
            this._impl.export(Gio.DBus.session, PERCORSO);
            acquisisciNome();
            this._nomePreso = true;
        } catch (e) {
            logError(e, 'DynamicIsland: export del timer fallito');
            this._impl = null;
        }

        // Il comando nel menu di stato. Se la shell non lo accetta si perde il
        // pulsante, non il timer: il resto del provider non lo riguarda.
        try {
            this._quick = new QuickTimer({
                alterna: sec => { if (this._fine) this.Stop(); else this.Start(sec, _('Timer')); },
                avvia: sec => this.Start(sec, _('Timer')),
                ferma: () => this.Stop(),
                scegli: () => this.Setup(),
            });
        } catch (e) {
            logError(e, 'DynamicIsland: comando timer nel menu di stato non aggiunto');
            this._quick = null;
        }
    }

    disable() {
        this._ferma();
        try { this._impl?.unexport(); } catch (_) {}
        this._impl = null;
        if (this._nomePreso) { rilasciaNome(); this._nomePreso = false; }
        this._manager?.remove(`${this.id}:corrente`);
        this._manager?.remove(`${this.id}:fine`);
        this._buttaVista();
        this._buttaScelta();
        this._quick?.destroy();
        this._quick = null;
        this._manager = null;
    }

    // --- metodi esposti su D-Bus --------------------------------------------

    Start(secondi, etichetta) {
        if (!(secondi > 0)) return;
        this._chiudiScelta();
        this._ferma();
        this._fine = GLib.get_monotonic_time() / 1000 + secondi * 1000;
        this._totale = secondi;          // serve all'anello: quanto era l'intero
        this._pausa = 0;
        this._etichetta = etichetta || _('Timer');
        this._aggiorna();
        this._avviaOrologio();
    }

    _avviaOrologio() {
        if (this._tickId) return;
        // Un secondo esatto: il conto alla rovescia deve cambiare quando cambia
        // davvero. Un intervallo piu' corto sprecherebbe risvegli, uno piu'
        // lungo farebbe saltare dei secondi.
        //
        // timeout_add e non timeout_add_seconds: il secondo allinea i risvegli
        // ai secondi interi dell'orologio di sistema per consumare meno, e il
        // primo scatto arriva quindi prima di un secondo pieno. Su un contatore
        // che si vede, quel primo intervallo accorciato si legge come uno
        // scatto: il numero resta fermo un attimo di troppo e poi ne salta uno.
        // Qui il risparmio non vale l'irregolarita'.
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (!this._aggiorna()) { this._tickId = 0; return GLib.SOURCE_REMOVE; }
            return GLib.SOURCE_CONTINUE;
        });
    }

    Stop() {
        this._ferma();
        this._pausa = 0;
        this._manager?.remove(`${this.id}:corrente`);
        this._buttaVista();
        this._chiudiScelta();
        this._quick?.aggiorna(false, '');
    }

    // Apre la scelta della durata sull'isola.
    //
    // Un timer in corso e la scelta di uno nuovo non convivono: sarebbero due
    // attivita' dello stesso provider in catena, e il pallino passerebbe
    // dall'una all'altra senza che il giro voglia dire niente.
    Setup() {
        if (!this._manager) return;
        this._ferma();
        this._pausa = 0;
        this._manager.remove(`${this.id}:corrente`);
        this._buttaVista();

        this._secondiScelti = 15 * 60;
        this._vistaScelta ??= new TimerSetupView({
            cambiato: s => { this._secondiScelti = s; this._mostraScelta(); },
            avvia: s => { this._chiudiScelta(); this.Start(s, _('Timer')); },
        });
        this._vistaScelta.setSecondi(this._secondiScelti);
        this._mostraScelta();
    }

    // Aggiunge (o toglie) tempo a un timer gia' partito.
    //
    // Non e' un doppione della scelta iniziale: li' decidi quanto deve durare,
    // qui correggi mentre sta andando. Fermare e rifare per aggiungere un
    // minuto e' il motivo per cui i timer si smette di usarli.
    Add(secondi) {
        if (!this._fine || !Number.isFinite(secondi) || secondi === 0) return;

        // Un timer non puo' scendere sotto i cinque secondi: portarlo a zero
        // sarebbe "ferma", che ha gia' il suo pulsante, e portarlo sotto zero
        // lo farebbe scadere all'istante come se fosse suonato davvero.
        const ora = Math.max(5, (this._pausa || this._restanti()) + secondi);

        if (this._pausa) this._pausa = ora;
        else this._fine = GLib.get_monotonic_time() / 1000 + ora * 1000;

        // Se il nuovo residuo supera la durata di partenza, l'anello sarebbe
        // piu' che pieno: si allarga l'intero, cosi' torna semplicemente
        // "carico" invece di uscire dalla scala.
        if (ora > this._totale) this._totale = ora;

        this._aggiorna();
    }

    // In pausa non si tiene un orologio fermo: si tiene il NUMERO di secondi
    // che restavano. La scadenza e' un istante, e un istante non si puo'
    // sospendere — mentre sei in pausa continua ad avvicinarsi. Cio' che va
    // conservato e' la durata residua, e la scadenza si ricalcola alla ripresa.
    Pause() {
        if (!this._fine || this._pausa) return;
        this._pausa = Math.max(1, this._restanti());
        if (this._tickId) { GLib.source_remove(this._tickId); this._tickId = 0; }
        this._aggiorna();
    }

    Resume() {
        if (!this._pausa) return;
        this._fine = GLib.get_monotonic_time() / 1000 + this._pausa * 1000;
        this._pausa = 0;
        this._aggiorna();
        this._avviaOrologio();
    }

    Toggle() {
        if (this._pausa) this.Resume();
        else this.Pause();
    }

    // Stessa ragione di _aggiorna(): in pausa il residuo e' quello congelato.
    // Senza questo, `isola timer-stato` mostrerebbe un timer fermo che cala.
    Status() {
        if (!this._fine) return [0, ''];
        return [Math.max(0, this._pausa || this._restanti()), this._etichetta];
    }

    // --- interno -------------------------------------------------------------

    _ferma() {
        if (this._tickId) { GLib.source_remove(this._tickId); this._tickId = 0; }
        this._fine = 0;
    }

    _mostraScelta() {
        const testo = formattaDurata(this._secondiScelti);
        this._manager.update(createActivity({
            id: `${this.id}:scelta`,
            providerId: this.id,
            tier: 'persistent',
            slot: 'leading',
            priority: 10,
            label: _('Timer'),
            sublabel: testo,
            glyph: {
                icon: Gio.ThemedIcon.new_from_names(['alarm-symbolic']),
                testo,
                colore: '#ff9f0a',
            },
            expandedView: this._vistaScelta.actor,
        }));
    }

    // Prima si toglie l'attivita', poi si distrugge la vista: finche'
    // l'attivita' esiste la scheda ne tiene l'attore, e distruggerlo sotto di
    // lei le lascerebbe un figlio morto.
    _chiudiScelta() {
        this._manager?.remove(`${this.id}:scelta`);
        this._buttaScelta();
    }

    _buttaScelta() {
        this._vistaScelta?.destroy();
        this._vistaScelta = null;
    }

    // La scheda tiene un riferimento all'attore finche' l'attivita' esiste:
    // si distrugge solo quando l'attivita' se ne va, mai a meta' corsa.
    _buttaVista() {
        this._vista?.destroy();
        this._vista = null;
    }

    // Orologio monotono: non salta se cambia l'ora di sistema, ne' col fuso, ne'
    // con l'ora legale. Un timer misura una durata, non un istante.
    // Si arrotonda per eccesso, cosi' "1s" resta scritto finche' quel secondo
    // non e' davvero passato e lo zero coincide con la fine.
    _restanti() {
        return Math.ceil((this._fine - GLib.get_monotonic_time() / 1000) / 1000);
    }

    // Torna false quando il timer e' concluso, cosi' il chiamante ferma il ciclo.
    _aggiorna() {
        if (!this._manager) return false;

        // In pausa il valore viene dal residuo congelato, non dalla scadenza.
        //
        // La scadenza e' un istante nel futuro, e un istante non si mette in
        // pausa: mentre sei fermo continua ad avvicinarsi. Leggendo _restanti()
        // il conto scenderebbe lo stesso e il timer arriverebbe a zero da fermo,
        // annunciando la fine di qualcosa che non stava andando avanti.
        //
        // Ed e' anche il motivo per cui il ramo della conclusione qui sotto e'
        // subordinato al non essere in pausa: e' lo stesso difetto gia' visto
        // sulla musica, dove premere pausa faceva sparire l'isola insieme ai
        // comandi — il pulsante si toglieva la possibilita' di essere annullato.
        const restanti = this._pausa ? this._pausa : this._restanti();

        if (!this._pausa && restanti <= 0) {
            this._manager.remove(`${this.id}:corrente`);
            const durata = 8000 * 1000;   // la fine di un timer va notata
            const ora = _now();
            this._manager.push(createActivity({
                id: `${this.id}:fine`,
                providerId: this.id,
                tier: 'transient',
                slot: 'either',
                label: format(_('%s finished'), this._etichetta),
                startedAt: ora,
                expiresAt: ora + durata,
            }));
            this._fine = 0;
            this._buttaVista();
            this._quick?.aggiorna(false, '');
            return false;
        }

        // Persistente e non transitorio: un timer in corso e' uno stato, e deve
        // restare visibile finche' dura.
        //
        // Nell'etichetta va il nome e nel sottotitolo il tempo, perche' e' cosi'
        // che si legge la scheda aperta: prima cos'e', poi quanto manca. Nella
        // pillola l'ordine e' rovesciato — li' c'e' l'anello, che dice gia' cos'e'
        // senza parole, e accanto serve solo il numero.
        const scritto = this._formatta(restanti);
        const frazione = this._totale > 0 ? restanti / this._totale : 0;

        // La vista si costruisce una volta sola e poi si aggiorna. Passarne una
        // nuova a ogni secondo farebbe smontare e rimontare la scheda aperta
        // sotto le mani di chi la sta guardando.
        this._vista ??= new TimerView({
            pausa: () => this.Pause(),
            riprendi: () => this.Resume(),
            ferma: () => this.Stop(),
            aggiungi: sec => this.Add(sec),
        });
        this._vista.aggiorna({
            testo: scritto,
            nome: this._etichetta,
            frazione,
            inPausa: !!this._pausa,
            restanti,
        });

        this._manager.update(createActivity({
            id: `${this.id}:corrente`,
            providerId: this.id,
            tier: 'persistent',
            slot: 'leading',
            priority: 10,           // vince sulle altre: e' l'unica cosa che scade
            label: this._etichetta,
            sublabel: scritto,
            glyph: {
                frazione,
                testo: scritto,
                // Nel pallino c'e' spazio per due cifre, non per "18:04": si
                // manda l'unita' piu' grande che conta ancora qualcosa. Il
                // provider la calcola perche' e' l'unico che sa cosa siano quei
                // numeri; farla ricavare al pallino tagliando la stringa
                // significherebbe indovinare.
                breve: this._breve(restanti),
                // Ambra anche nelle cifre, non solo nell'anello: sull'isola vera
                // il tempo e' colorato, ed e' cio' che lo distingue a colpo
                // d'occhio da un orologio qualsiasi. Smorzata in pausa, come nella
                // scheda: il colore dice se il numero sta ancora cambiando.
                colore: this._pausa ? 'rgba(255, 159, 10, 0.55)' : '#ff9f0a',
            },
            expandedView: this._vista.actor,
        }));
        this._quick?.aggiorna(true, scritto);
        return true;
    }

    // Ore se ce ne sono, altrimenti minuti, altrimenti secondi: sempre al
    // massimo due cifre, cosi' entra nel cerchio del pallino.
    _breve(s) {
        if (s >= 3600) return `${Math.floor(s / 3600)}h`;
        if (s >= 60) return `${Math.floor(s / 60)}`;
        return `${s}`;
    }

    // Sopra l'ora si mostra anche quella; sotto il minuto si scende ai secondi.
    // Un formato fisso costringerebbe a leggere "00:00:47" per capire "47s".
    _formatta(s) {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
        if (m > 0) return `${m}:${String(sec).padStart(2,'0')}`;
        return `${sec}s`;
    }
}
