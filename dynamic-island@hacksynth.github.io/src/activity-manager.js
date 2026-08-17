import { emptyViewModel, assertActivity, _now } from './activity.js';

// Pure — no gi imports. Use callback subscribe, not GObject signals.
export class ActivityManager {
    constructor() {
        this._activities = new Map();   // id → Activity
        this._subs = new Set();
        this._hovered = false;
        this._pinned = false;
        // MODIFICA LOCALE: catena delle attivita' persistenti.
        //
        // Vedi _sincronizzaCatena(). E' l'ordine di arrivo, e _primariaId dice
        // quale di quelle occupa la pillola; il satellite e' sempre la
        // precedente nell'anello.
        this._catena = [];              // id, in ordine di arrivo
        this._primariaId = null;
        this._lastVM = emptyViewModel();
        this._notify();
    }

    // Subscription: invoke immediately with current VM.
    subscribe(fn) {
        this._subs.add(fn);
        fn(this._lastVM);
        return () => this._subs.delete(fn);
    }

    push(activity) {
        assertActivity(activity);
        this._activities.set(activity.id, activity);
        this._notify();
    }

    update(activity) { this.push(activity); }

    remove(id) {
        if (this._activities.delete(id)) this._notify();
    }

    setHover(h) {
        if (this._hovered === !!h) return;
        this._hovered = !!h;
        this._notify();
    }

    setPinned(p) {
        if (this._pinned === !!p) return;
        this._pinned = !!p;
        this._notify();
    }

    isHovered() { return this._hovered; }
    isPinned() { return this._pinned; }

    // Called by an external ticker to expire transients.
    tick() { this._notify(); }

    destroy() {
        this._subs.clear();
        this._activities.clear();
    }

    // ----- internals -----

    _assign() {
        const now = _now();

        // Drop expired.
        const live = [];
        for (const a of this._activities.values()) {
            if (a.expiresAt !== undefined && a.expiresAt <= now) continue;
            live.push(a);
        }

        const transients = live.filter(a => a.tier === 'transient');
        const persistents = live.filter(a => a.tier === 'persistent');
        const ambients = live.filter(a => a.tier === 'ambient');

        // Flash = newest transient by startedAt (descending).
        transients.sort((x, y) => y.startedAt - x.startedAt);
        const flashing = transients[0] ?? null;

        // MODIFICA LOCALE: una sola attivita' alla volta sulla pillola, le
        // altre nel satellite.
        //
        // Prima le persistenti venivano distribuite su due posti per priorita',
        // e con piu' di due la terza spariva senza che nessuno lo dicesse. Il
        // caso peggiore capitava di continuo: musica piu' timer finivano una in
        // 'leading' e una in 'trailing', ma la pillola disegna la riga della
        // musica appena la trova in uno dei due — e del timer non restava
        // traccia. Due attivita', una visibile.
        //
        // Ora c'e' una catena: l'ultima arrivata prende la pillola, la
        // precedente si stacca nel pallino accanto, le altre restano dietro. Il
        // pallino le fa girare. Niente si perde, e la pillola non deve piu'
        // scegliere fra due contenuti che non sanno l'uno dell'altro.
        this._sincronizzaCatena(persistents);
        const perId = new Map(persistents.map(a => [a.id, a]));
        const n = this._catena.length;
        const i = this._catena.indexOf(this._primariaId);

        const leading = i >= 0 ? perId.get(this._catena[i]) ?? null : null;
        // Il satellite mostra la PRECEDENTE nell'anello: e' quella che il click
        // riporterebbe sulla pillola, quindi il pallino e' un'anteprima di cosa
        // succede se lo premi, non un elenco di cosa c'e' in giro.
        const satellite = n >= 2
            ? perId.get(this._catena[(i - 1 + n) % n]) ?? null
            : null;
        const trailing = null;

        // Derive baseState.
        //
        // MODIFICA LOCALE: il passaggio del mouse non cambia piu' lo stato.
        //
        // Prima l'hover portava a 'expanded', che nel CSS vale min-width 320px:
        // la pillola faceva un salto di quasi tre volte solo perche' le passavi
        // sopra. E siccome .state-expanded non ridefinisce background-color,
        // perdeva anche il nero di .state-idle e si accendeva di bianco.
        //
        // Il ritaglio dell'iPhone non reagisce al passaggio del dito: cambia
        // forma quando cambia il contenuto, non quando lo sfiori. Il riscontro
        // al mouse ora e' una leggera dilatazione, gestita in island-view.js
        // come scala — non tocca ne' la geometria ne' i colori.
        //
        // Il pin (tasto centrale) invece resta: li' l'apertura l'hai chiesta tu.
        let baseState;
        if (this._pinned) baseState = 'expanded';
        else if (leading && trailing) baseState = 'split';
        else if (leading || trailing) baseState = 'compact';
        else baseState = 'idle';

        return {
            baseState,
            leading,
            trailing,
            satellite,
            catena: Object.freeze(this._catena.slice()),
            flashing,
            hovered: this._hovered,
            pinned: this._pinned,
            ambientOverflow: Object.freeze(ambients),
        };
    }

    // Tiene la catena allineata a cio' che e' vivo, senza rimescolarla.
    //
    // L'ordine e' quello di ARRIVO e non cambia piu': e' l'unica cosa che rende
    // prevedibile il giro del pallino. Se si riordinasse per priorita' o per
    // ultimo aggiornamento, la stessa pressione darebbe risultati diversi a
    // seconda di cosa e' successo nel frattempo — e un comando di cui non sai
    // prevedere l'effetto e' peggio di un comando che non c'e'.
    //
    // Nota su update(): il timer si riscrive ogni secondo con lo stesso
    // identificativo. Proprio per questo la catena si indicizza per id e non
    // per oggetto: altrimenti ogni aggiornamento sembrerebbe un arrivo nuovo e
    // il timer si riprenderebbe la pillola una volta al secondo, rendendo
    // impossibile guardare qualunque altra cosa.
    _sincronizzaCatena(persistents) {
        const vivi = new Set(persistents.map(a => a.id));
        this._catena = this._catena.filter(id => vivi.has(id));

        const nuovi = persistents
            .filter(a => !this._catena.includes(a.id))
            .sort((x, y) => x.startedAt - y.startedAt);

        for (const a of nuovi) this._catena.push(a.id);

        // Un arrivo nuovo prende la pillola: e' la cosa appena successa, ed e'
        // quella di cui vuoi sapere. Le altre non spariscono, scalano.
        //
        // Le discrete no: entrano in fondo e restano li'. Se pero' la pillola
        // e' libera la prendono lo stesso — vedi il commento su `quiet` in
        // activity.js — e a quello ci pensa il ripiego qui sotto, che scatta
        // proprio quando non c'e' nessuna primaria valida.
        const rumorosi = nuovi.filter(a => !a.quiet);
        if (rumorosi.length > 0)
            this._primariaId = rumorosi[rumorosi.length - 1].id;

        // La primaria se n'e' andata (timer finito, brano concluso): passa
        // all'ultima rimasta, che e' la piu' recente.
        if (!this._catena.includes(this._primariaId))
            this._primariaId = this._catena[this._catena.length - 1] ?? null;
    }

    // Click sul satellite: la precedente nell'anello sale sulla pillola.
    // All'indietro e in cerchio, cosi' premendo ripetutamente si passano in
    // rassegna tutte e si torna al punto di partenza.
    ruotaIndietro() {
        const n = this._catena.length;
        if (n < 2) return;
        const i = this._catena.indexOf(this._primariaId);
        this._primariaId = this._catena[(i - 1 + n) % n];
        this._notify();
    }

    _notify() {
        this._lastVM = Object.freeze(this._assign());
        for (const fn of this._subs) fn(this._lastVM);
    }
}
