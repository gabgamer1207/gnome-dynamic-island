# Modifiche locali — notte del 2 agosto 2026

Estensione originale: `dynamic-island@hacksynth.github.io` per GNOME Shell.
Sistema: Arch, GNOME Shell 50.3, Wayland.

Ogni file modificato ha accanto un `.bak` con la versione precedente.
Per tornare indietro completamente:

```bash
cd ~/.local/share/gnome-shell/extensions/dynamic-island@hacksynth.github.io
for f in extension.js src/*.js src/providers/*.js stylesheet.css; do
    [ -f "$f.bak" ] && cp "$f.bak" "$f"
done
```
Poi logout (su Wayland la shell non si ricarica a caldo).

---

## 1. Difetti che impedivano il funzionamento

**`affectsInputRegion` rimosso in GNOME 50** — `expanded-island.js`
`Main.layoutManager.addTopChrome(attore, { affectsInputRegion: true })` faceva
sollevare `Params.parse` con "Unrecognized parameter". L'eccezione interrompeva
`enable()` a meta': l'estensione restava in stato ERROR e l'isola non compariva.
Il parametro e' stato tolto; il suo valore predefinito era comunque `true`.

**Doppio orologio nella barra** — `panel-integration.js`
Due modifiche precedenti si contraddicevano: una spostava il menu data/ora
nativo nel box di sinistra lasciandolo visibile, l'altra aggiungeva un orologio
custom nello stesso box. Rimosso il custom: il nativo mostra anche la data,
apre calendario e notifiche, e non dipende da codice nostro.

**`ease()` non anima la geometria sugli attori St** — tutti i file
E' il difetto che spiegava quasi tutti i sintomi. `St.Widget` calcola la propria
dimensione da CSS e contenuto e **scarta la richiesta di dimensione di Clutter**:
`ease({width})` crea una transizione regolare, che gira e riceve i suoi tick, ma
il valore che scrive viene ignorato al momento del layout.

Misurato: con `ease({width: 100})` la larghezza reale restava 82 per tutti i
284 ms campionati.

Conseguenza: la pillola non aveva **mai** animato il cambio di forma. Quello che
sembrava un'animazione a scatti era il `min-width` della nuova classe di stato
applicato di colpo. Ora larghezza, posizione e dimensioni si interpolano a mano
scrivendo lo stile in linea fotogramma per fotogramma.

---

## 2. Animazione

**Molla smorzata al posto delle curve** — `spring.js` (nuovo)
iOS non usa easing: anima un oscillatore armonico smorzato. Due funzioni pure,
verificate numericamente:
- apertura (8.5 / 0.72): sorpasso 3,84% a meta' corsa — per la scheda
- pillola (9.5 / 0.82): sorpasso 1,11% — su un oggetto piccolo il 3,84% si
  legge come tremolio, non come materia
- chiusura: smorzamento critico, nessun rimbalzo

Si aggancia alle transizioni con `set_progress_func`. Se la firma non fosse
quella attesa, si disattiva da sola e restano valide le curve di Clutter.

**Animazioni agganciate al frame clock** — `anima.js` (nuovo)
`GLib.timeout_add(16)` e' un timer di sistema: non sa quando il compositore
disegna. I due ritmi scorrono liberi, quindi certi fotogrammi ricevono due passi
e altri nessuno — micro-tremolio irregolare. Ora si usa `Clutter.Timeline`
legata all'attore: un passo per fotogramma reale, e si adatta da sola a schermi
a 90 o 120 Hz. Ripiego automatico al vecchio timer se non costruibile.

**Raggio degli angoli a 60 fps** — `expanded-island.js`
Erano 12 passi fissi: su 400 ms fanno 33 ms l'uno, circa 30 fps mentre il bordo
ne faceva 60. Ora il numero di passi si ricava dalla durata, e usa la stessa
molla della forma cosi' restano in fase.

**Conflitto con le transizioni CSS** — `stylesheet.css`
`.dynisland-pill` aveva `transition-duration: 250ms`. Riscrivendo `min-width`
sessanta volte al secondo, ogni riscrittura faceva partire una transizione da
250 ms verso il nuovo valore: sessanta transizioni sovrapposte che si
rincorrevano. Era il guizzo dopo il click. Rimossa.

---

## 3. Notifiche

**Banner nativi soppressi** — `providers/notification.js`
`Main.messageTray.bannerBlocked = true`: la notifica compariva sia come riquadro
standard di GNOME sia sull'isola. Ripristinato alla disattivazione.

**Da stato permanente a lampo** — `providers/notification.js`
L'attivita' era `persistent` senza scadenza: spariva solo quando tutte le
notifiche venivano distrutte, ma GNOME le tiene finche' non le chiudi a mano.
L'isola restava occupata a tempo indeterminato. Ora e' `transient` con
`expiresAt`, minimo 3 secondi.

**La scheda si apre da sola** — `extension.js`, `expanded-island.js`
Nuovo metodo `peek()`: stessa animazione del click, ma senza fondale a tutto
schermo e senza rubare il focus da tastiera. Si richiude da sola, sincronizzata
col lampo sulla pillola. Solo per le notifiche: volume, luminosita' e tastiera
restano compatti nella pillola.

**Morph invece di due oggetti** — `expanded-island.js`, `island-view.js`
La pillola si allarga a 1,55x all'arrivo della notifica, la scheda nasce sulla
sua geometria gia' in movimento, e la pillola svanisce nel primo terzo
dell'apertura mentre la scheda la copre. Prima restavano visibili entrambe —
pillola piccola sopra, scheda staccata sotto — e con due oggetti il morph non
esiste.

Le notifiche non scrivono piu' testo nella pillola: lo mostra la scheda, e la
pillola si allargava su mezza barra per contenerlo.

---

## 4. Interazione

**Hover** — non cambia piu' lo stato. Prima passava a `expanded`, che nel CSS
vale `min-width: 320px`: da 82 a 320 pixel solo passandoci sopra, spesso per
sbaglio. E siccome `.state-expanded` non ridefiniva `background-color`, la
pillola perdeva il nero e si accendeva. Ora e' un allargamento del 7%.

**Pressione** — cedimento e rimbalzo in due tempi: picco a 1,14 in 130 ms,
ritorno in 320. Il bersaglio del ritorno si **ricalcola** al momento in cui
parte: cliccando si apre un menu che prende il grab del puntatore, GNOME manda
un `leave-event` e la pillola rientra — usando il bersaglio catturato al click
si ri-allargava, ed erano i due allungamenti.

---

## 5. Colori

Pillola e scheda condividono lo stesso nero (`rgba(0,0,0,0.88)`) senza bordo,
**anche su tema chiaro**. Prima la scheda era grigia con bordo chiaro e la
pillola nera senza: due materiali diversi non si leggono come un oggetto solo
che cambia forma. Il lampo non schiarisce piu': si scurisce leggermente.

---

## 6. Robustezza

- La pulizia di un'animazione interrotta viene eseguita comunque: prima, se a
  essere interrotta era una chiusura, la scheda restava sullo schermo come
  rettangolo opaco sopra le finestre.
- Il fondale (trasparente ma reattivo, a tutto schermo) viene spento da ogni
  apertura automatica: se restava acceso si mangiava ogni click senza che si
  vedesse niente.
- `destroy()` restituisce la pillola visibile e nasconde il fondale, nel caso
  l'estensione venga disattivata a meta' animazione.

---

## 7. Interazione con le notifiche — completata

Tutta la specifica concordata e' implementata e verificata.

**Click sulla scheda** apre l'applicazione a cui la notifica si riferisce, poi
la scheda si chiude.

Il difetto che ha richiesto piu' tempo: conservavo l'oggetto notifica, ma GNOME
lo distrugge quasi subito — mentre la scheda che lo mostra e' ancora aperta e
cliccabile. Al click il riferimento era gia' nullo (`haNotifica=false` nella
sonda). Tenerlo in vita non avrebbe risolto: un oggetto distrutto non si puo'
attivare comunque.

Si conserva quindi l'**applicazione**, letta da `source.app` al momento
dell'arrivo, finche' la sorgente esiste. E' un oggetto di GNOME, vive quanto la
sessione, e sopravvive alla notifica che l'ha fatta conoscere.

**Mouse sopra la scheda**: il timer di chiusura si azzera del tutto.
**Mouse via**: riparte con 2 secondi di margine (`RAFFREDDAMENTO`), perche'
uscire dalla scheda e' spesso un movimento di passaggio, non una decisione.

**Click sulla pillola** riapre l'ultima notifica con la stessa animazione.
Sostituisce l'apertura del menu data/ora, che era un gesto ereditato
dall'orologio; il calendario resta raggiungibile dall'orologio nativo nella
barra.

**La memoria scade dopo 10 secondi** dalla chiusura della scheda
(`MEMORIA_MS`), e ogni riapertura fa ripartire il conto. Oltre quel tempo la
pillola torna al comportamento di base. Senza scadenza il gesto diventerebbe
imprevedibile: a distanza di ore non sapresti se ti si apre il calendario o una
notifica dimenticata, e un gesto di cui non prevedi l'effetto e' peggio di un
gesto che non c'e'.

**La pillola resta piccola e vuota** fra un'apertura e l'altra: le notifiche non
scrivono testo al suo interno, lo mostra la scheda.

### Tempi

| | |
|---|---|
| scheda aperta da una notifica | 5 s |
| scheda riaperta dalla pillola | 5 s |
| mouse sopra | nessun timer |
| dopo che il mouse esce | 2 s |
| memoria dell'ultima notifica | 10 s dalla chiusura |

---

## Rifiniture rimaste

- I commenti di `island-view.js` sono stratificati e in parte contraddittori:
  raccontano ancora ipotesi poi rivelatesi sbagliate (scala invece di
  larghezza, percentuali superate). Il codice e' corretto, i commenti no.
- `_animaRaggio()` in `expanded-island.js` non e' piu' usato: il raggio e' stato
  assorbito in `_animaScheda()`.

---

## 8. Musica — sessione del 2 agosto, pomeriggio

### Presentazione compatta

Con una riproduzione in corso la pillola non mostra piu' testo: copertina
dell'album a un capo, quattro barre animate all'altro — la presentazione
compatta di iOS. Il titolo si legge aprendo la scheda.

Su iPhone quei due elementi stanno ai lati del ritaglio della fotocamera e il
nero fra loro e' l'isola. Qui non c'e' nessun ritaglio — la pillola E' l'isola —
quindi vanno alle sue estremita': il risultato visivo e' lo stesso.

Il testo faceva allargare la pillola su mezza barra, e la larghezza cambiava a
ogni traccia. Ora la dimensione resta costante.

Due limiti dichiarati: le barre non sono analisi reale dello spettro (MPRIS non
espone il flusso audio) e non seguono il colore della copertina.

### Difetti corretti

**Il fondale bloccava tutti i click.** Un attore trasparente grande quanto lo
schermo, per chiudere la scheda cliccando fuori: con la scheda aperta non si
poteva piu' cliccare nessuna finestra. Per una cosa che si apre da sola
all'arrivo di una notifica e' inaccettabile. Rimosso — la scheda si chiude gia'
al leave del puntatore, dopo il raffreddamento, e con Escape.

**I comandi non rispondevano.** Le sonde hanno dato la sequenza esatta:

    pressed=true / press ricevuto / pressed=false / release ricevuto

St.Button emette 'clicked' solo se pressione e rilascio avvengono entrambi su di
lui restando premuto. Qui lo stato si azzerava prima, perche' il pulsante
riceveva un 'leave' fra i due eventi: si SPOSTA sotto il puntatore, dato che la
barra di avanzamento rimisura il contenuto ogni secondo. Basta uno scostamento
di un pixel. Ora i comandi agiscono sulla pressione — nessuna coppia di eventi
da tenere insieme.

**La pausa toglieva i comandi.** Il provider rimuoveva l'attivita' per qualunque
stato diverso da 'Playing': premendo pausa dall'isola, l'isola spariva insieme
ai comandi, e per riprendere serviva tornare al lettore. Il pulsante di pausa si
toglieva la possibilita' di annullare il proprio effetto. Ora si toglie solo a
riproduzione conclusa.

**Il volume mostrava il valore precedente.** L'isola aggiornava il testo del
lampo solo quando cambiava l'IDENTIFICATIVO dell'attivita' — ma quella del
volume ha sempre lo stesso, perche' e' la stessa cosa che si aggiorna. Dalla
seconda variazione il confronto risultava uguale e il testo non veniva riscritto.
Non era ritardo di propagazione: era un valore vecchio. La chiave ora comprende
anche l'istante.

Nota su un vicolo cieco: avevo trovato una firma sbagliata nella sostituzione di
`osdWindowManager.show` (leggeva il livello da args[2], che e' l'etichetta) e
l'avevo corretta dandola per causa. La sonda ha poi dimostrato che **quel metodo
non viene mai chiamato in GNOME 50**: quel percorso non era mai stato attivo, e
correggerne la firma non poteva servire. Rimosso; resta l'ascolto del canale
audio, che funziona.

**La barra cresceva dal centro.** Il BinLayout impila i figli e li centra:
l'allineamento vale sullo spazio in eccesso, non sul bordo da cui partire.
Sostituito con un BoxLayout orizzontale, che impacchetta dall'inizio per natura.

**Il riempimento non si muoveva** — quarta occorrenza del difetto di ease() sugli
attori St nello stesso programma. Ora passa dal CSS.

### Aggiunte

Barra cliccabile e **trascinabile**, con pallino. Trascinando si muove solo la
grafica e il salto avviene una volta sola al rilascio: cliccando ripetutamente
per cercare un punto si muoverebbe la riproduzione a ogni tentativo.

Il pallino cresce in due gradini — 12 a riposo, 14 al passaggio, 18 mentre lo
trascini. Sono due messaggi distinti: il primo annuncia che si puo' prendere, il
secondo conferma che l'hai preso. Su un elemento piccolo, senza quel riscontro
non si distingue un trascinamento da una presa mancata.

Traccia portata da opacita' 0,18 a 0,10: attirava l'occhio piu' del riempimento,
che e' l'unica parte che porta informazione.

---

## 9. Piu' attivita' insieme — sessione del 3 agosto

Fino a qui l'isola mostrava una cosa sola: l'attivita' con priorita' piu' alta
vinceva e le altre sparivano. Con la musica in riproduzione, un timer in corso e
un file in scaricamento, due delle tre non esistevano.

**Il satellite.** Un punto nero alla sinistra della pillola, staccato da essa,
che tiene le attivita' di sfondo. Cliccandolo la catena ruota all'indietro:
quella nel satellite entra nella pillola, quella nella pillola torna in coda.
Le attivita' sono un anello, non una pila, quindi non esiste un ordine in cui
resti bloccato.

`_sincronizzaCatena()` in `activity-manager.js` tiene l'anello coerente quando
un'attivita' nasce o muore; `ruotaIndietro()` fa girare l'indice.

**Attivita' silenziose.** Un dispositivo Bluetooth collegato non e' un evento:
non deve rubare la pillola a una canzone. Il campo `quiet: true` su una
specifica dice "esisti nella catena, ma non pretendere il primo posto".

### Perche' l'animazione del punto sembrava "di scatto"

La prima versione usava una molla smorzata sulla **larghezza** del satellite.
Una molla oltrepassa il bersaglio e torna indietro: e' quello che la rende viva.
Ma la larghezza e' geometria di disposizione, e ogni oscillazione spingeva la
pillola accanto, che ballava di conseguenza.

**Regola generale, vale oltre questo caso: la geometria non deve mai
oltrepassare il bersaglio, perche' muove i vicini. Le trasformazioni si.**
L'elasticita' e' passata sulla **scala** — che non occupa spazio nella
disposizione — e la larghezza segue una smoothstep, che arriva e si ferma.

---

## 10. Quattro attivita' nuove

**Bluetooth** (`providers/bluetooth.js`). Un'unica attivita' silenziosa per
tutti i dispositivi. Ascolta tre segnali di BlueZ (`PropertiesChanged`,
`InterfacesAdded`, `InterfacesRemoved`) piu' UPower per la batteria in tempo
reale. Nella pillola compare il dispositivo con **meno batteria**, che e'
l'unico che richiede una decisione. Il segnaposto viene inserito prima della
chiamata asincrona `GetAll`, altrimenti due segnali ravvicinati registrano due
volte lo stesso dispositivo.

**Timer** (`providers/timer.js`). Interfaccia D-Bus completa: `Start`, `Stop`,
`Setup`, `Add`, `Pause`, `Resume`, `Toggle`, `Status`. La pausa non e' un
sospendere il conto: `_pausa` conserva i secondi rimasti, e `_fine` viene
ricalcolato alla ripresa. Senza questa distinzione il conto alla rovescia
continuerebbe a scorrere durante la pausa e il timer finirebbe da fermo.

**Trasferimenti** (`providers/transfers.js`). Un monitor sulla cartella degli
scaricamenti. La prima misura di un file **non** e' un avanzamento ma una
riga di partenza: senza la sentinella `dimensione: -1` ogni file appariva
completo appena creato.

**Registrazione schermo** (`providers/screencast.js`). Usa le maniglie di
`Meta.RemoteAccessController`, cosi' vede anche la condivisione schermo di una
videochiamata, non solo il registratore di GNOME. `_riavvia()` incatena lo stop
all'avvio perche' il servizio rifiuta di partire finche' la sessione precedente
non e' chiusa.

---

## 11. Disegnare invece di comporre

Tre componenti sono passati da "diversi attori St impilati" a "un solo attore
disegnato in Cairo": l'anello del timer e della batteria (`views/anello.js`), il
righello di scelta della durata (`views/righello.js`), la barra di avanzamento
della musica (`views/barra.js`).

La barra e' il caso che ha insegnato la regola. Aveva tre sintomi apparentemente
scollegati — sembrava troppo spessa, scorreva a scatti, e ogni tanto lampeggiava
— e per un po' li ho inseguiti separatamente. Erano **tre conseguenze della
stessa causa**: tre attori St che si contendevano la stessa geometria, ognuno
rimisurato dal gestore di disposizione a ogni aggiornamento.

**Se un componente e' fatto di piu' attori St che litigano sulla geometria,
disegnalo.** Un `St.DrawingArea` ha una dimensione sola e nessuna trattativa.

La funzione di disegno sta **fuori** dalla classe apposta: cosi' si puo'
chiamare da uno script gjs, salvare il risultato in PNG e guardarlo. E' cosi'
che sono venute fuori una diagonale nell'anello e le righe fuori registro nei
distintivi del Bluetooth, che a occhio sullo schermo non si notavano.

---

## 12. Difetti corretti — i due che spegnevano funzioni intere

**`get_mapped()` non esiste.** In Clutter `mapped` e' una proprieta' e si legge
con `is_mapped()`. Avevo scritto `get_mapped()` in tre punti. L'eccezione
risaliva fino a `Start()`, quindi il timer non creava mai la sua attivita': si
premeva avvio e la scheda si apriva vuota. Lo stesso errore spegneva in
silenzio il Bluetooth e le barre di avanzamento.

Nessun controllo statico lo vedeva. Ho provato a costruire un verificatore
basato sui file GIR e **non funziona**: da' un falso negativo proprio su
`get_mapped` (esiste in GTK) e falsi positivi su tutto St, di cui non e'
installato il GIR. Non l'ho incluso: uno strumento che rassicura senza
verificare e' peggio di nessuno strumento.

**Una `Clutter.Timeline` legata a un attore non montato non avanza mai.**
L'anello della batteria restava a zero: l'animazione partiva mentre la scheda
era chiusa, e il suo orologio non scorreva. Il rimedio e' saltare al valore
finale quando l'attore non e' montato, e agganciare `notify::mapped` per
allinearsi quando entra in scena:

    if (!animato || !this.actor?.is_mapped()) {
        this._mostrata = a;
        this.actor?.queue_repaint();
        return;
    }

### Gli altri

- **La scheda era sempre larga al massimo**, quindi il timer sembrava perso in
  mezzo al vuoto. Ora misura il contenuto con `get_preferred_width(-1)`.
- **Tre puntini al posto dell'icona** a musica finita: l'icona era nulla perche'
  la copertina di Spotify e' un indirizzo https, non un file. Aggiunta una
  cascata di ripieghi e lo scaricamento della copertina con cache su disco.
- **`ease({width})` non anima gli attori St.** Silenzioso: nessun errore, e
  nessuna animazione.
- **`format()` non supporta `%02d`**, che si usa per i secondi di un orologio.
- I trasferimenti annunciavano due volte lo stesso file; il timer contava due
  volte il primo secondo; un apostrofo dentro uno script awk chiudeva la stringa
  bash in `bin/isola`.

---

## 13. Comandi

**`bin/isola`** rende l'isola programmabile da uno script qualunque — la fine di
una compilazione, l'avanzamento di un rsync, un promemoria. E' la stessa idea
delle Live Activities di iOS, con la differenza che qui l'interfaccia e' una
riga di shell:

    isola push build "Compilazione" "in corso" --progresso 0.3
    isola timer 25m Studio

**Nel menu di stato** (`quick-timer.js`, `quick-screencast.js`) compaiono un
avvio timer e un interruttore per la registrazione schermo, accanto a Wi-Fi e
Bluetooth.

---

## Cosa non e' stato provato

Onesta' sullo stato: queste parti sono scritte e compilano, ma non le ho viste
funzionare con dati veri.

- Bluetooth con **piu' di un dispositivo** collegato insieme
- I pulsanti casuale e ripeti della musica
- La condivisione schermo dentro una videochiamata
- Disabilitare e riabilitare l'estensione con delle attivita' in corso

Chi le prova e trova un difetto sta facendo un favore al progetto.
