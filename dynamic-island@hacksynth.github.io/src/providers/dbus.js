// Provider D-Bus: l'equivalente delle Live Activities di iOS.
//
// Su iPhone la Dynamic Island e' utile perche' le app possono spingerci
// dentro contenuto tramite un'API. Tutto il resto sono casi d'uso di quella.
//
// Qui esponiamo la stessa cosa: un'interfaccia D-Bus che qualunque
// programma, script o comando puo' chiamare per far comparire un'attivita'.
// Un provider solo, invece di uno per ogni cosa immaginabile.
//
// Dalla riga di comando:
//   isola push backup "Backup OneDrive" "in corso" --progresso 0.42
//   isola rimuovi backup

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { createActivity, _now } from '../activity.js';
import { ProgressView } from '../views/progress-view.js';

const NOME_BUS = 'org.gnome.Shell.Extensions.DynamicIsland';
const PERCORSO = '/org/gnome/Shell/Extensions/DynamicIsland';

const INTERFACCIA = `
<node>
  <interface name="org.gnome.Shell.Extensions.DynamicIsland">
    <method name="Push">
      <arg type="s"    name="id"       direction="in"/>
      <arg type="s"    name="label"    direction="in"/>
      <arg type="s"    name="sublabel" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
    </method>
    <method name="Remove">
      <arg type="s" name="id" direction="in"/>
    </method>
    <method name="List">
      <arg type="as" name="ids" direction="out"/>
    </method>
    <method name="Clear"/>
  </interface>
</node>`;

export class DBusProvider {
    constructor() {
        this.id = 'dbus';
        this._manager = null;
        this._impl = null;
        this._ownerId = 0;
        this._views = new Map();   // id → ProgressView
    }

    enable(manager, _settings) {
        this._manager = manager;

        this._impl = Gio.DBusExportedObject.wrapJSObject(INTERFACCIA, this);
        try {
            this._impl.export(Gio.DBus.session, PERCORSO);
        } catch (e) {
            logError(e, 'DynamicIsland: export D-Bus fallito');
            return;
        }

        // Il nome sul bus serve perche' i client possano chiamarci per nome
        // invece di dover conoscere il nome unico della shell.
        this._ownerId = Gio.bus_own_name(
            Gio.BusType.SESSION, NOME_BUS,
            Gio.BusNameOwnerFlags.REPLACE, null, null, null);
    }

    disable() {
        for (const id of [...this._views.keys()]) this._rimuovi(id);
        this._views.clear();

        if (this._ownerId) { Gio.bus_unown_name(this._ownerId); this._ownerId = 0; }
        try { this._impl?.unexport(); } catch (_) {}
        this._impl = null;
        this._manager = null;
    }

    // ------------------------------------------------------- metodi D-Bus
    Push(id, label, sublabel, options) {
        if (!id || !label) return;
        const opt = this._spacchetta(options);

        // transient sparisce da solo, persistent resta finche' non lo togli.
        // Un'attivita' senza durata nota (un backup) deve essere persistent:
        // se sparisse a meta' l'utente penserebbe che sia finita.
        const tier = opt.tier === 'transient' ? 'transient' : 'persistent';
        const durata = Number.isFinite(opt.timeout) ? opt.timeout : 5;

        let vista = null;
        if (Number.isFinite(opt.progress)) {
            vista = this._vista(id);
            vista.setProgress(opt.progress);
        } else if (this._views.has(id)) {
            // Il progresso e' sparito da un aggiornamento all'altro: l'attivita'
            // e' diventata indeterminata, via la barra.
            this._views.get(id).destroy();
            this._views.delete(id);
        }

        this._manager?.update(createActivity({
            id: `${this.id}:${id}`,
            providerId: this.id,
            tier,
            slot: opt.slot === 'trailing' ? 'trailing' : 'leading',
            priority: Number.isFinite(opt.priority) ? opt.priority : 0,
            label,
            sublabel: sublabel || null,
            glyph: opt.icon ? { icon: new Gio.ThemedIcon({ name: opt.icon }) } : null,
            expandedView: vista?.actor ?? null,
            ...(tier === 'transient' ? { expiresAt: _now() + durata * 1000000 } : {}),
        }));
    }

    Remove(id) { this._rimuovi(id); }

    List() {
        return [...this._views.keys()];
    }

    Clear() {
        for (const id of [...this._views.keys()]) this._rimuovi(id);
    }

    // ----------------------------------------------------------- interni
    _rimuovi(id) {
        this._manager?.remove(`${this.id}:${id}`);
        const v = this._views.get(id);
        if (v) { v.destroy(); this._views.delete(id); }
    }

    _vista(id) {
        let v = this._views.get(id);
        if (!v) { v = new ProgressView(); this._views.set(id, v); }
        return v;
    }

    // Le opzioni arrivano come a{sv}: vanno scartate una per una.
    _spacchetta(options) {
        const out = {};
        if (!options) return out;
        for (const [k, v] of Object.entries(options)) {
            try { out[k] = v.deepUnpack ? v.deepUnpack() : v; }
            catch (_) { /* opzione malformata: si ignora, non si esplode */ }
        }
        return out;
    }
}
