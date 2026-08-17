import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivity, _setFakeClock } from '../dynamic-island@hacksynth.github.io/src/activity.js';
import { ActivityManager } from '../dynamic-island@hacksynth.github.io/src/activity-manager.js';

function mgr() {
    const m = new ActivityManager();
    const models = [];
    m.subscribe(vm => models.push(vm));
    return { m, models, last: () => models[models.length - 1] };
}

function act(spec) { return createActivity(spec); }

test('empty manager emits idle view-model on subscribe', () => {
    const { last } = mgr();
    assert.equal(last().baseState, 'idle');
});

test('one persistent leading → compact', () => {
    const { m, last } = mgr();
    m.push(act({ id: 'a', providerId: 'media', tier: 'persistent', slot: 'leading', label: 'Song' }));
    assert.equal(last().baseState, 'compact');
    assert.equal(last().leading.id, 'a');
    assert.equal(last().trailing, null);
});

// Two persistents no longer split the pill between them.
//
// They used to occupy a 'leading' and a 'trailing' slot side by side, and a
// third one simply vanished. Worse, the pill draws the media row as soon as it
// finds a media activity in either slot — so music plus a timer showed the
// music and no trace of the timer at all: two activities, one visible.
//
// Now the newest one holds the pill and the previous one detaches into the
// satellite dot beside it. Nothing is dropped, and the pill never has to choose
// between two contents that know nothing about each other.
test('two persistents: the newest holds the pill, the other becomes the satellite', () => {
    const { m, last } = mgr();
    m.push(act({ id: 'a', providerId: 'media', tier: 'persistent', slot: 'leading', label: 'Song', startedAt: 10 }));
    m.push(act({ id: 'b', providerId: 'notification', tier: 'persistent', slot: 'trailing', label: 'Msg', startedAt: 20 }));
    assert.equal(last().baseState, 'compact');
    assert.equal(last().leading.id, 'b');
    assert.equal(last().satellite.id, 'a');
    assert.equal(last().trailing, null, 'lo slot trailing non viene piu assegnato');
});

test('either-slot activity fills leading first', () => {
    const { m, last } = mgr();
    m.push(act({ id: 'e', providerId: 'p', tier: 'persistent', slot: 'either', label: 'E' }));
    assert.equal(last().leading.id, 'e');
    assert.equal(last().trailing, null);
});

test('higher priority wins within a slot', () => {
    const { m, last } = mgr();
    m.push(act({ id: 'low', providerId: 'p', tier: 'persistent', slot: 'leading', label: 'L', priority: 0 }));
    m.push(act({ id: 'hi',  providerId: 'p', tier: 'persistent', slot: 'leading', label: 'H', priority: 5 }));
    assert.equal(last().leading.id, 'hi');
});

// Hover reports itself but does not resize the pill.
//
// It used to promote baseState to 'expanded', which in CSS means a min-width of
// 320px: the pill nearly tripled in width just because the pointer crossed it,
// and lost its background colour along the way. The notch on an iPhone does not
// react to being touched — it changes shape when its contents change. Hover
// feedback is now a slight scale-up, handled in island-view.js.
//
// The flag stays in the view model because the view still needs to know.
test('hover is reported but leaves baseState alone', () => {
    const { m, last } = mgr();
    m.setHover(true);
    assert.equal(last().hovered, true);
    assert.equal(last().baseState, 'idle');
    m.push(act({ id: 'a', providerId: 'p', tier: 'persistent', slot: 'leading', label: 'L' }));
    assert.equal(last().baseState, 'compact');
    m.setHover(false);
    assert.equal(last().hovered, false);
    assert.equal(last().baseState, 'compact');
});

test('pin survives hover-off', () => {
    const { m, last } = mgr();
    m.setPinned(true);
    m.setHover(true);
    m.setHover(false);
    assert.equal(last().baseState, 'expanded');
    m.setPinned(false);
    assert.equal(last().baseState, 'idle');
});

test('transient sets flashing and keeps underlying slots', () => {
    let t = 1_000_000;
    _setFakeClock(() => t);
    try {
        const { m, last } = mgr();
        m.push(act({ id: 'media', providerId: 'media', tier: 'persistent', slot: 'leading', label: 'Song' }));
        m.push(act({ id: 'vol',   providerId: 'volume', tier: 'transient', slot: 'either', label: '70%',
                     expiresAt: t + 1_500_000 }));
        assert.equal(last().flashing.id, 'vol');
        assert.equal(last().leading.id, 'media');
        assert.equal(last().baseState, 'compact');
    } finally {
        _setFakeClock(null);
    }
});

test('transient clears when clock passes expiresAt and tick() runs', () => {
    let t = 1_000_000;
    _setFakeClock(() => t);
    try {
        const { m, last } = mgr();
        m.push(act({ id: 'vol', providerId: 'volume', tier: 'transient', slot: 'either', label: '70%',
                     expiresAt: t + 1_500_000 }));
        assert.equal(last().flashing.id, 'vol');
        t = t + 2_000_000;
        m.tick();
        assert.equal(last().flashing, null);
    } finally {
        _setFakeClock(null);
    }
});

test('ambient activities populate ambientOverflow only', () => {
    const { m, last } = mgr();
    m.push(act({ id: 'batt', providerId: 'power', tier: 'ambient', slot: 'either', label: '42%' }));
    assert.equal(last().leading, null);
    assert.equal(last().baseState, 'idle');
    assert.equal(last().ambientOverflow.length, 1);
    assert.equal(last().ambientOverflow[0].id, 'batt');
});

test('remove drops the activity and re-runs assignment', () => {
    const { m, last } = mgr();
    m.push(act({ id: 'a', providerId: 'p', tier: 'persistent', slot: 'leading', label: 'A', startedAt: 10 }));
    m.push(act({ id: 'b', providerId: 'p', tier: 'persistent', slot: 'trailing', label: 'B', startedAt: 20 }));
    assert.equal(last().baseState, 'compact');
    m.remove('a');
    // The declared slot no longer decides anything: whoever is left holds the pill.
    assert.equal(last().baseState, 'compact');
    assert.equal(last().leading.id, 'b');
    assert.equal(last().satellite, null);
});

test('update replaces an activity by id preserving startedAt ordering', () => {
    const { m, last } = mgr();
    const a1 = act({ id: 'a', providerId: 'p', tier: 'persistent', slot: 'leading', label: 'L1', startedAt: 10 });
    m.push(a1);
    const a2 = act({ id: 'a', providerId: 'p', tier: 'persistent', slot: 'leading', label: 'L2', startedAt: 20 });
    m.update(a2);
    assert.equal(last().leading.label, 'L2');
});

// Arrival order decides the chain, not priority.
//
// Priority used to pick who got the visible slot. It cannot do that any more,
// and it should not: the satellite is a control, and a control whose effect you
// cannot predict is worse than no control. If the order were re-sorted by
// priority — or by whoever updated last — the same press would land somewhere
// different depending on what happened in between. Arrival order never moves.
test('arrival order decides the chain, not priority', () => {
    const { m, last } = mgr();
    m.push(act({ id: 'hi', providerId: 'p', tier: 'persistent', slot: 'either', label: 'Hi', priority: 5, startedAt: 10 }));
    m.push(act({ id: 'lo', providerId: 'p', tier: 'persistent', slot: 'either', label: 'Lo', priority: 0, startedAt: 20 }));
    assert.equal(last().baseState, 'compact');
    assert.equal(last().leading.id, 'lo', 'l ultima arrivata prende la pillola anche se conta meno');
    assert.equal(last().satellite.id, 'hi');
});

// --- catena e satellite ------------------------------------------------------
//
// Il modello: le persistenti formano una catena in ordine di ARRIVO. L'ultima
// arrivata occupa la pillola; il satellite mostra sempre la precedente
// nell'anello, cioe' quella che un click riporterebbe in primo piano. Premendo
// ripetutamente si va all'indietro e in cerchio.

function persistente(id, startedAt) {
    return createActivity({
        id, providerId: 'p', tier: 'persistent', slot: 'leading',
        label: id, startedAt,
    });
}

test('a single persistent activity has no satellite', () => {
    const { m, last } = mgr();
    m.push(persistente('musica', 100));
    assert.equal(last().leading.id, 'musica');
    assert.equal(last().satellite, null, 'un pallino che non porta da nessuna parte e un ingombro');
});

test('a newly arrived activity takes the pill, the previous one becomes the satellite', () => {
    const { m, last } = mgr();
    m.push(persistente('musica', 100));
    m.push(persistente('timer', 200));
    assert.equal(last().leading.id, 'timer');
    assert.equal(last().satellite.id, 'musica');
});

test('the satellite always shows the previous one, not merely the oldest', () => {
    const { m, last } = mgr();
    m.push(persistente('musica', 100));
    m.push(persistente('timer', 200));
    m.push(persistente('rec', 300));
    assert.equal(last().leading.id, 'rec');
    assert.equal(last().satellite.id, 'timer', 'musica resta dietro, non nel pallino');
});

test('clicking the satellite walks backwards and wraps around', () => {
    const { m, last } = mgr();
    m.push(persistente('musica', 100));
    m.push(persistente('timer', 200));
    m.push(persistente('rec', 300));

    m.ruotaIndietro();
    assert.equal(last().leading.id, 'timer');
    assert.equal(last().satellite.id, 'musica');

    m.ruotaIndietro();
    assert.equal(last().leading.id, 'musica');
    // Giro chiuso: dopo la prima si riparte dall'ultima.
    assert.equal(last().satellite.id, 'rec');

    m.ruotaIndietro();
    assert.equal(last().leading.id, 'rec');
});

test('rotating with a single activity does nothing', () => {
    const { m, last } = mgr();
    m.push(persistente('musica', 100));
    m.ruotaIndietro();
    assert.equal(last().leading.id, 'musica');
    assert.equal(last().satellite, null);
});

// Il timer si riscrive ogni secondo con lo stesso identificativo: se un
// aggiornamento contasse come arrivo, si riprenderebbe la pillola di continuo e
// guardare qualunque altra cosa diventerebbe impossibile.
test('updating an existing activity does not steal the pill', () => {
    const { m, last } = mgr();
    m.push(persistente('musica', 100));
    m.push(persistente('timer', 200));
    m.ruotaIndietro();
    assert.equal(last().leading.id, 'musica');

    m.update(createActivity({
        id: 'timer', providerId: 'p', tier: 'persistent', slot: 'leading',
        label: 'timer', sublabel: '4:59', startedAt: 200,
    }));
    assert.equal(last().leading.id, 'musica', 'un aggiornamento non e un arrivo');
    assert.equal(last().satellite.id, 'timer');
});

test('removing the primary hands the pill to the most recent survivor', () => {
    const { m, last } = mgr();
    m.push(persistente('musica', 100));
    m.push(persistente('timer', 200));
    m.push(persistente('rec', 300));
    m.remove('rec');
    assert.equal(last().leading.id, 'timer');
    assert.equal(last().satellite.id, 'musica');
});

test('removing a background activity leaves the primary alone', () => {
    const { m, last } = mgr();
    m.push(persistente('musica', 100));
    m.push(persistente('timer', 200));
    m.push(persistente('rec', 300));
    m.remove('musica');
    assert.equal(last().leading.id, 'rec');
    assert.equal(last().satellite.id, 'timer');
});

test('dropping to a single activity retires the satellite', () => {
    const { m, last } = mgr();
    m.push(persistente('musica', 100));
    m.push(persistente('timer', 200));
    m.remove('musica');
    assert.equal(last().leading.id, 'timer');
    assert.equal(last().satellite, null);
});

// --- attivita' discrete ------------------------------------------------------
//
// Cose che durano ore e che non sono un evento: delle cuffie collegate. Devono
// stare nella catena — per poterle raggiungere col pallino — senza scalzare
// cio' che stavi guardando.

function discreta(id, startedAt) {
    return createActivity({
        id, providerId: 'bluetooth', tier: 'persistent', slot: 'either',
        label: id, startedAt, quiet: true,
    });
}

test('a quiet activity does not displace the current primary', () => {
    const { m, last } = mgr();
    m.push(persistente('musica', 100));
    m.push(discreta('cuffie', 200));
    assert.equal(last().leading.id, 'musica', 'la musica resta in primo piano');
    assert.equal(last().satellite.id, 'cuffie', 'ma le cuffie sono raggiungibili');
});

// Senza questo una discreta arrivata da sola sarebbe viva e invisibile: non
// sulla pillola perche' non ruba, e non nel pallino perche' con una sola
// attivita' il pallino non esiste.
test('a quiet activity still takes an empty pill', () => {
    const { m, last } = mgr();
    m.push(discreta('cuffie', 100));
    assert.equal(last().leading.id, 'cuffie');
    assert.equal(last().satellite, null);
});

test('a loud arrival still takes the pill from a quiet one', () => {
    const { m, last } = mgr();
    m.push(discreta('cuffie', 100));
    m.push(persistente('timer', 200));
    assert.equal(last().leading.id, 'timer');
    assert.equal(last().satellite.id, 'cuffie');
});

test('a quiet activity can be rotated into view like any other', () => {
    const { m, last } = mgr();
    m.push(persistente('musica', 100));
    m.push(discreta('cuffie', 200));
    m.ruotaIndietro();
    assert.equal(last().leading.id, 'cuffie');
    assert.equal(last().satellite.id, 'musica');
});

// Se la primaria sparisce, il posto va all'ultima rimasta anche se e' discreta:
// meglio mostrare le cuffie che lasciare la pillola vuota con roba viva dietro.
test('when the primary leaves, a quiet survivor takes the pill', () => {
    const { m, last } = mgr();
    m.push(discreta('cuffie', 100));
    m.push(persistente('timer', 200));
    m.remove('timer');
    assert.equal(last().leading.id, 'cuffie');
});
