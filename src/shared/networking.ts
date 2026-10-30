import Net from "@rbxts/net";
import type { MatchStatsRow } from "./matchStats";

/**
 * Every remote in the game, declared once here and used by both sides.
 *
 * The declarations are evaluated on both machines and the library builds the
 * matching instances on the server and waits for them on the client, so this
 * file is the whole contract: add an entry, and both sides can see it typed.
 *
 * (The throw's remote is still the older hand-rolled `ReplicatedStorage.Remotes`
 * event — see `shared/remotes.ts`. Left alone deliberately; it works.)
 */

/**
 * Which way a hit went, as the two sides in it — **`"AtoB"` is team A's throw landing on a B body, and
 * `"BtoA"` is the reverse.**
 *
 * **Two values, because friendly fire is refused before any hit is recorded.** `BallComponent` vetoes a
 * same-side contact ahead of the damage, so every logged hit has one end on each side and there is no
 * same-side case for a third value to describe. That is exactly what makes this usable as a *colour
 * rule*: a reader that knows the two sides' colours can draw both names of a hit from this one string,
 * and can be certain the two do not match.
 *
 * **Declared here, beside the event that carries it, rather than in `RoundService` where the log that
 * fills it lives.** It is the vocabulary of the *wire* — the server writes it, and every client reads it
 * and derives colours from it — and a literal union spelled out in two files is two places for the two
 * strings to drift apart. That is the argument `voteCountAttribute` makes about a shared key. The
 * server's entry type still uses it; only its home moved.
 *
 * **A value rather than something the far side works out.** A client cannot derive which way a hit went
 * from the pair of names: that takes both players' *sides*, and the sides a later reader would look up
 * are not necessarily the sides that were in force when the throw landed.
 */
export type HitDirection = "AtoB" | "BtoA";

export const events = Net.Definitions.Create({
	/**
	 * Client → server: this character wants to dodge in this direction, measured in this frame.
	 *
	 * **Two facts rather than one, and the second is the frame the first was measured in** — the camera's
	 * heading, flattened. Which of the four dodge clips the dash wears is
	 * `dodgeDirectionOf(direction, reference)`, and what that reference is decides what a key means: measured
	 * against the camera, `S` is a backward dodge whenever it is pressed, which is what the player pressing
	 * it expects. Measured against the *body* instead — the earlier version — it is whichever direction the
	 * body has finished turning to face, because `RotationType` is `MovementRelative` and the body tracks its
	 * own movement: a player pressed the key for a backward dodge and got the forward clip, or a different
	 * clip depending on how long they held the key first. A rig's dodge is the other way round and does not
	 * travel this wire at all: its direction is *motion*, chosen by its AI, so the server classifies it
	 * against the rig's own facing — which the server owns, so there is no lag to argue about.
	 *
	 * **The reference rather than a decided word.** The client could classify this itself and send the word,
	 * and for a player that would be the smaller payload — but it would put a second copy of the rule in the
	 * client for players while a rig's dodge stayed classified on the server, which is two answers to what
	 * `S+D` means waiting to disagree. Sending the frame keeps exactly one classifier.
	 *
	 * **The cost is one `Vector3` per dodge** — three floats, at most once every `DODGE_CONFIG.COOLDOWN`
	 * seconds — and it decides nothing about the dash: the direction is what the dash uses, the reference is
	 * used only to name the clip.
	 *
	 * **A zero reference means "I did not send one"**, not "my camera faces nowhere": the reader flattens the
	 * value, and a direction with no horizontal part is the same absence as no value at all — which is the
	 * path that leaves the classification to the server's own read.
	 *
	 * Server-bound only. The movement replicates on its own, so there is nothing
	 * to send back and no reason for a second event.
	 */
	dodge: Net.Definitions.ClientToServerEvent<[direction: Vector3, reference: Vector3]>(),

	/**
	 * Client → server: this player is asking to leave the round and go back to the lobby.
	 *
	 * **A request, not a state, on `duck`'s terms and for a stronger reason.** What the client knows is that a
	 * key was pressed twice; everything that follows — whether a round is on, whether they are still in it,
	 * what becomes of their seat, what a rig does about it and what their reward turns into — is decided on
	 * the server out of state the client has no honest copy of. A client that sent "I have left" would be
	 * describing an outcome it is not allowed to grant itself, and the seat it frees is exactly the thing
	 * `MatchService.release` exists to move under the server's own hand.
	 *
	 * **No payload**, because the key is the only fact the client has that the server does not and the server
	 * already knows who sent it — the same argument the duck's declaration makes about a duck having no
	 * direction, no duration and no target.
	 *
	 * **It is only ever sent on the far side of a confirmation**, which is why a stray `L` cannot end a round
	 * for anybody: the client arms a prompt first, any other key cancels it, and what crosses this wire is
	 * always a player who pressed the key twice.
	 */
	surrender: Net.Definitions.ClientToServerEvent<[]>(),

	/**
	 * Client → server: this player has sat still long enough to be asked, and has not answered.
	 *
	 * **A second event rather than a flag on `surrender`, and the reason is what the server does differently.** The
	 * round treats both requests identically — a surrender is exactly what an absent player wants — but this one is
	 * *reported*: the server poofs the body and prints why it left, so a round that loses a body has a line in the
	 * output saying it was the player's absence rather than their choice. A boolean on the surrender event would
	 * have put that branch inside a handler whose only job is the round's own bookkeeping.
	 *
	 * **No payload again**, and for `surrender`'s reason: the server already knows who sent it, and how long the
	 * client waited is the client's own threshold — a number it could send is a number the server should not
	 * believe. `AFK_CONFIG.IDLE_SECONDS` is shared instead, so the line the server prints names the same figure the
	 * client actually waited.
	 *
	 * **The client sends it at the end of a countdown it drew itself**, so this is not a poll and not a timeout on
	 * the server: a player who moves during the five seconds never sends it at all.
	 */
	afk: Net.Definitions.ClientToServerEvent<[]>(),

	/**
	 * Client → server: this character wants to duck.
	 *
	 * Carries nothing, on `catch`'s terms and for its reason — a key press is the only fact the client
	 * has that the server does not, and the server already knows *who* pressed it. There is even less to
	 * say here than there: a duck has no direction, no duration and no target, and every rule that
	 * decides whether one happens is server-side. See `DuckService`.
	 *
	 * **A request rather than a state, and that is not a formality.** A client that sent "I am ducking"
	 * would be describing a body the server has to trust it about, and the duck is a hit exemption — the
	 * one thing in the game a client must not be able to grant itself. The server answers this out of
	 * its own state and writes the attribute itself, which is what keeps the exemption unforgeable.
	 */
	duck: Net.Definitions.ClientToServerEvent<[]>(),

	/**
	 * Client → server: this character wants to try to catch.
	 *
	 * Carries nothing on purpose. The only thing the client knows that the server
	 * does not is that a key was pressed — and the server already knows *who*
	 * pressed it, from the `Player` the engine hands the handler, so there is
	 * nothing here worth letting a client say.
	 */
	catch: Net.Definitions.ClientToServerEvent<[]>(),

	/**
	 * Client → server: this player wants to put down the ball they are holding.
	 *
	 * Nothing on the wire, like the two above, and for a stronger reason here: the
	 * server is the only machine that knows whether there *is* a ball in that hand, so
	 * anything the client said about it would be a claim rather than a fact.
	 */
	drop: Net.Definitions.ClientToServerEvent<[]>(),

	/**
	 * Client → server: this player wants to use whatever power the mystery box gave them.
	 *
	 * **Carries nothing on purpose, and unlike `markHeldBall` that is not merely a preference.** The mark
	 * remote names an ability because the *player* is choosing it; here the box chose, and which one it
	 * chose is a fact the server is holding in its own window. A client that sent the name it read off
	 * `MYSTERY_POWER_ATTRIBUTE` would be sending a *replica* — so a window that had just closed, or a
	 * collection that landed while the attribute was still catching up, would have a player mark a ball
	 * with a power they were never given. The server answers this request out of the window it holds,
	 * which is the same argument `catch` and `drop` make in one sentence each.
	 *
	 * **A request, not an instruction.** Whether there is a window at all, whether the ball in hand can
	 * carry what it rolled, whether a round is being played and whether the window still has time on it
	 * are four questions this machine cannot answer, and the server answers all four before spending
	 * anything.
	 */
	useMysteryPower: Net.Definitions.ClientToServerEvent<[]>(),

	/**
	 * Client → server: this player is voting for this mode for the next round.
	 *
	 * Carries the mode's **id as a string**, not a `GameModeId`: the wire is not typed, so the
	 * server has to treat what arrives as an arbitrary string and check it — which is what
	 * `isGameModeId` and the registry lookup are for. Typing it here would describe an intention
	 * rather than a guarantee.
	 *
	 * A string rather than a number, deliberately. An index into the server's list would be a
	 * number whose meaning lived on the other machine, so a client a version behind would vote for
	 * whichever mode happened to have moved into that slot — silently, and for the wrong thing. An
	 * id that is not recognised is refused instead.
	 */
	castVote: Net.Definitions.ClientToServerEvent<[mode: string]>(),

	/**
	 * Client → server: whether this player is now holding the sprint key.
	 *
	 * **A level, and the only event here that sends a value the server could not work out for
	 * itself.** Every other request on this wire either carries nothing or names something the
	 * server then checks, because the server owns the state and a client that had lost track of it
	 * must not be able to assert it. That reasoning is about *authority*, not about values on the
	 * wire, and it does not reach this event: the server holds no opinion about whether a key is
	 * down, and no way to discover it. That is a fact only the client has, so the client is the only
	 * thing that can report it, and the honest shape of a held key is a boolean that stays true
	 * until it is false.
	 *
	 * Nothing is validated on the far side and nothing needs to be: an untrue `true` buys a player
	 * fifteen studs per second for as long as their stamina lasts, which is what the same player
	 * gets by holding the key, and running out stops it either way. See `WalkSpeedService`.
	 */
	setSprinting: Net.Definitions.ClientToServerEvent<[active: boolean]>(),

	// **`setCharging` used to sit here, was removed, and is back carrying something else.** It first reported
	// whether a player was holding the throw button so that `WalkSpeedService` could stop the stamina pool
	// refilling during a charge. **That hold is gone** — see `WalkSpeedService.poolHold` for why a hold whose
	// length the player controls is a lockout rather than a rule about resting — and the event went with it.
	//
	// It returns for the *speed cap*: a charge is a stance with its windup held, so a charging body is limited to
	// `CHARACTER_CONFIG.AIMING_WALK_SPEED` while it holds, and the server has no way to observe a hold — the
	// start time lives on the client (`client/throwing.ts`) and the server only hears of the throw when the
	// release arrives. So this is `setSprinting`'s shape and `setSprinting`'s trust argument: a level that only
	// the client can know, reported as a boolean and believed, because an untrue `true` costs the player their
	// own movement speed and buys nothing else.
	//
	// **A level and not an event**, deliberately: a missed "start" would leave a body capped for ever if the
	// server tracked only that, and a level is idempotent — the client re-sends whenever the answer changes, and
	// a lost message is corrected by the next charge the player starts or ends.
	setCharging: Net.Definitions.ClientToServerEvent<[active: boolean]>(),

	/**
	 * Client → server: this player wants the ball in their hand to carry this ability.
	 *
	 * **Carries the ability's id as a string**, not an `AbilityKind`: the wire is not typed, so the
	 * server treats what arrives as an arbitrary string and checks it with `isAbilityKind` — the
	 * arrangement `castVote` describes at length, and for its reason. A client may legitimately name an
	 * ability nobody has written, and the refusal belongs where the string is turned into a value.
	 *
	 * **Nothing comes back, and that is the design rather than an omission.** Whether the mark happened
	 * is written on the *ball* — a replicated instance in this player's own hand — so the attribute
	 * appearing is the acknowledgement, and a reply event would be a second channel carrying a fact the
	 * client already has. A refusal needs no message either: an unmarked ball a moment later is the
	 * answer, and the server prints the reason where a reader can find it.
	 *
	 * **Nothing on the wire says whether the player may mark a ball.** The server holds the charge,
	 * knows the dev flags, and is the only machine that can see the ball in the hand, so a client that
	 * gated its own request would be a second copy of rules it cannot evaluate — the position
	 * `setSprinting` above argues from the opposite direction.
	 */
	markHeldBall: Net.Definitions.ClientToServerEvent<[kind: string]>(),

	/**
	 * Client → server: this player is spending their charge on a MultiBall window.
	 *
	 * **No argument, unlike {@link markHeldBall} above, and the difference is the two abilities rather
	 * than an economy.** A mark has to say *what* the ball is being marked as, because the ball is what
	 * carries the ability and there is more than one word it could be. This names one ability in the
	 * key that sent it: there is nothing for the client to choose, and therefore nothing arriving that
	 * needs checking — the server asks whether this player may have a window, not what they asked for.
	 *
	 * **Nothing comes back**, for the reason the mark gives: the answer is two attributes on the player,
	 * which replicate on their own, so a reply event would be a second channel carrying a fact this
	 * machine already has. A refusal needs no message either — an unchanged pair of attributes 
	 * a moment later is the answer, and the server prints the reason where a reader can find it.
	 */
	multiBall: Net.Definitions.ClientToServerEvent<[]>(),

	/**
	 * Client → server: **where this player's body is, as its own machine sees it** — a diagnostic, and the
	 * only remote in this file that exists to be read by a person rather than by the game.
	 *
	 * **Why a remote at all, when every other shared fact in this project is an attribute.** An attribute is
	 * the server's publication channel: `DUCKING_ATTRIBUTE` records the rule outright — *a client's write on
	 * its own character does not replicate* — and nothing under `src/client/` writes one. This is the one
	 * fact that only the client has: the server's copy of a client-owned character lags a replication step,
	 * so "where the player is" is a question the server cannot answer about itself, and the whole of the
	 * hit-disagreement measurement in `server/dev/HitDisagreementProbe` is the difference between the two
	 * answers. There is no attribute that could carry it.
	 *
	 * **`sampledAt` is the client's reading of `Workspace:GetServerTimeNow()` at the instant it read its own
	 * root**, not a `os.clock` figure. That is the point of the pair: an instant on the shared clock can be
	 * subtracted from the server's own reading of the same clock at the tag, so the line carries an *age*
	 * and not just two positions. A server timestamp taken on arrival would hide the upload leg, which is
	 * half of what the probe is trying to see.
	 *
	 * **Sent only while `DEBUG_CONFIG.VERBOSE_LOGS` is on**, at ten hertz, and it ships off. Nothing in the
	 * game reads it, nothing is written back, and a client that never sends one is a client whose character
	 * has simply never been echoed — which the probe prints as an absent sample rather than as a zero. The
	 * delivery is unvalidated on the game's side for `markHeldBall`'s reason (the wire is not typed) and
	 * validated on the probe's, with `typeIs`, because a value that is not a `Vector3` reaching a
	 * subtraction would be an error inside a diagnostic.
	 */
	positionEcho: Net.Definitions.ClientToServerEvent<[position: Vector3, sampledAt: number]>(),

	/**
	 * Server → client: **one hit, as the two people in it** — the second entry here that travels this way,
	 * and the second that is about the round rather than an answer to a request.
	 *
	 * **Two names and a direction, and nothing else needs to travel.** A hit is a *pair*, which is why
	 * this is an event rather than an attribute: the folder the rest of the HUD reads carries scalars, and
	 * no scalar says "Alice hit Bob". The names are what a row draws; the direction is what decides both
	 * colours, because a side's colour is a property of the side rather than of the person — and
	 * {@link HitDirection} is also where the guarantee that the two names differ comes from.
	 *
	 * **Broadcast, to everybody — and this is a reversal, so the argument it replaces is worth stating.**
	 * It used to go to the two people in the hit and to nobody else, on the reasoning that a third client
	 * could do nothing with it but discard it. That was true while the reader was a pair of *personal*
	 * lists ("who I hit", "who hit me"): a client was only ever shown its own exchanges. It stopped being
	 * true when the reader became the round's feed, because a feed is one list for the whole server — the
	 * hits you are in and the hits you are not are the same list, read the same way — so a client that is
	 * in nobody's hits still has every reason to watch other people's. One `SendToAllPlayers` rather than a
	 * `SendToPlayers` over the pair. **The cost is stated rather than hidden**: every client receives every
	 * hit of the round in a server of N, and N−2 of them are hits it does not appear in. What that buys is
	 * that the feed is the same list on every machine with no filtering anywhere — not on the server, and
	 * not on the client, which no longer has to ask whether one of the two names is its own.
	 *
	 * **Not validated on arrival beyond the direction.** The wire is not typed, so the direction arrives
	 * as an arbitrary string and only two values are meaningful; a client that reads a third drops the
	 * message rather than inventing a colour for it. **Nothing about *who* is checked at all any more** —
	 * the two names are drawn and never compared.
	 */
	roundHit: Net.Definitions.ServerToClientEvent<[hitter: string, victim: string, direction: string]>(),

	/**
	 * Server → client: **one hit landed on a body, whoever either end was, named with the victim first.**
	 * This is what the impact effect is drawn from, and it is a second event about a hit rather than a second
	 * version of the one above.
	 *
	 * **Why it is not `roundHit` with more callers.** That event is the *feed's*, and its shape follows from
	 * that: it carries a direction so a row can be painted in two team colours, and it is sent only for hits
	 * with a person at both ends — `RoundService.logHit` is the sole sender and is reached only when the
	 * thrower is a `Player` and the victim is too, because the board and the log are records about people. A
	 * rig's throw and a ball that lands on a rig therefore produce no `roundHit` at all, and in a round played
	 * against rigs those are most of the hits in it. **A cosmetic effect cannot live on an event that is
	 * gated on both ends being people**, so it gets its own.
	 *
	 * **Two names, and one string covers both kinds of body.** The victim's *model* name is the player's name
	 * for a character and the rig's own name for a rig, so a client compares against `Players.LocalPlayer.Name`
	 * exactly as it would for the feed; the thrower is named the same way. What it deliberately does **not**
	 * carry is the direction, the sides or a count: the effect's colour is which template is cloned, so none
	 * of that is read, and a field nothing reads is a field that will be believed later.
	 *
	 * **Victim first, and the order is the design**: a hit is an impact *at the body it landed on*, so the
	 * subject of the sentence is the victim and the thrower is what it is told about. A reader that is in
	 * neither end draws nothing.
	 *
	 * **Sent from `RoundService.registerHit`, which is where both ends resolve to something with a name** —
	 * the thrower arrives as a token that is a `UserId` for a player and a GUID for a rig, and matching a
	 * rig's GUID to its rig is `throwerOf`'s job.
	 *
	 * **And sent in every phase, which is a reversal recorded rather than a quiet widening.** This used to be
	 * gated with the round — `registerHit` returned before sending unless one was being played — so a ball
	 * landing on a practice dummy, or on a player in the lobby, drew nothing anywhere. An impact is a fact
	 * about a *body* rather than about a round, and both of its readers are cosmetic (`hitVfx` draws the
	 * burst, `hitConfirm` draws the splash), so the send now happens before the round gate and only the
	 * round's own records stay behind it. **What still does not draw outside a round is a rig's throw**:
	 * `throwerOf`'s rig arm walks `rigsInRound()`, which is `Playing`-gated, so a rig throwing in the lobby
	 * resolves to nothing and no half-subject payload is sent. A player's throw always resolves.
	 *
	 * **A third field, `ability` — the power the throw was carrying, `""` when it carried none.** Added for the
	 * escalating splash: `hitConfirm` counts the bodies one throw took and has to know whether to escalate past
	 * `MULTI HIT!` into `SMASH!` and `RAMPAGE!`, and a client cannot answer that for itself. The two attributes
	 * that could have said so are both gone by the time an impact is drawn — `BALL_ABILITY_ATTRIBUTE` rides the
	 * ball, which has already landed, and `ARMED_ABILITY_ATTRIBUTE` is consumed when the mark is applied.
	 * **`"MultiBall"` is filled in by `registerHit` rather than read off the ball**, because a MultiBall throw
	 * is a window on the *player* and its balls carry no mark: `isBallAbility` reports `false` for it, so the
	 * name can never arrive from `abilityOn`. An empty string rather than a `nil`, on
	 * `BALL_ABILITY_ATTRIBUTE`'s convention — every reader has one empty value to test.
	 *
	 * **It is not a record and nothing accumulates from it.** `roundHit` and `roundHitLog` remain the round's
	 * history of a hit between two people; this is the same event told to the clients that have to draw it,
	 * and `hitVfx`, `hitConfirm` and — since item 146 — `HitLogController` are its readers.
	 *
	 * **And the third reader is why the missing direction has a visible consequence rather than a silent
	 * one.** The HUD's hit feed needs the two names for *every* hit, which is the set this event carries and
	 * `roundHit` does not; it takes a hit with a person at both ends from `roundHit` (which has the direction,
	 * so it can paint both names in team colours) and everything else from here, drawn in one ink because this
	 * payload has no sides to draw. That is a deliberate asymmetry and not a gap: the sides on `roundHit` are
	 * derived by `RoundService` from two `Player`s' teams, and a rig's side is a fact this event's shape never
	 * promised. A reader that wants rig rows coloured would have to send the direction too — which would make
	 * the "nothing it does not need" argument below false, so it is not done quietly here.
	 *
	 * **A fourth field, `victimId` — and it is the fix for a name being asked to do an identity's job.** The
	 * first field is the victim's `Name`, which is enough for `hitConfirm` (it only ever compares the *thrower*)
	 * and enough for a rig the lobby spawned, because those are named uniquely from the pool. It is **not**
	 * enough for a body a person made: a model duplicated seven times in Studio is seven models called `Rig`, so
	 * a client looking one up by name draws on whichever copy it finds first — or, before `bodyOf` grew its
	 * walk, on nothing. The report was exactly that, and it is why the id travels beside the name rather than
	 * instead of it: the names are what the log is read against, and the id is what the client resolves with.
	 * See `BODY_ID_ATTRIBUTE`, which is where the id lives on the body, and `hitVfx.bodyOf`.
	 *
	 * **Appended rather than woven in, and `hitConfirm` proves that is safe.** A Luau handler ignores arguments
	 * it does not declare, so the splash module's `(victim, thrower, ability)` keeps working untouched — which
	 * is why the new field went on the end of the tuple rather than beside the field it belongs with.
	 */
	hitImpact: Net.Definitions.ServerToClientEvent<
		[victim: string, thrower: string, ability: string, victimId: string]
	>(),

	/**
	 * Server → client: **a throw was caught, and the body that has to wear the consequence is the thrower's.**
	 * Named thrower first, catcher second — the body being drawn on is the subject, exactly as {@link
	 * hitImpact} puts the victim first.
	 *
	 * **Why a third event, and not a flag inside `hitImpact`.** A caught throw is not a hit: nothing was
	 * tagged, no damage was dealt and the ball never reached the body it was aimed at. It is also the *only*
	 * moment in the game where the player who is punished is the one whose ball was stopped — so a client
	 * cannot derive it from anything it already receives. `hitImpact` could not carry it either: its two
	 * names are "the body it landed on" and "the arm that threw it", and the meaning of the pair is the
	 * opposite of this one, so a flag would make every reader re-learn what a hit is.
	 *
	 * **Sent from `RoundService.resolveCaughtThrower` rather than from the ball**, and *after* that method's
	 * guards — so it goes out exactly where the catch actually punishes somebody. A friendly catch returns
	 * before it (nothing happened to the thrower), a catch between rounds returns (there is no round to be
	 * out of), and an unresolved thrower — a rig whose throw cannot be attributed — returns too, because a
	 * payload with no thrower is a body nobody can draw on. Everything that reaches the send is a thrower the
	 * round is about to kill, which is the sentence the effect says.
	 *
	 * **Two names and nothing else.** The thrower's *model* name is the player's name for a character and the
	 * rig's own name for a rig, so one string answers both — the same convention {@link hitImpact} uses for
	 * its pair. The catcher is carried only so the client's log line can name both ends; nothing is drawn on
	 * the catcher's body from this event, because the catch's own burst is `catchShockwave`'s and reads the
	 * `AnimCatch` mark instead.
	 *
	 * **Broadcast, not targeted at the thrower.** A rig's throw being caught is the common case in a round
	 * against rigs and there is no player end to target; and the body it happened to is one everybody can see.
	 */
	caughtThrow: Net.Definitions.ServerToClientEvent<[thrower: string, catcher: string]>(),

	/**
	 * Server → client: **your throw took the last body on the other side** — the round is decided by your hit,
	 * and your screen says `WIPEOUT!`.
	 *
	 * **Why this cannot be derived on the client.** A wipe is a fact about a *side*: it needs every body on
	 * that side, their healths, the mode's own rule about what a side running out means, and the rigs the
	 * client may not even be watching. A client can see the body it hit fall over; it cannot see that it was
	 * the last one, and it certainly cannot see the mode's answer. So the confirmation is the server's, and
	 * this event is that confirmation.
	 *
	 * **Sent to one player rather than broadcast**, which is the first event in this file that is. Everything
	 * else here is a thing everybody can see (a hit, a catch, a feed); a wipe is a caption on the thrower's
	 * own screen, and the other clients already get the result panel when the round finishes. **It carries the
	 * thrower's name anyway** — the same pair `hitImpact` sends — so the one client that receives it can make
	 * the same comparison it makes for every other event rather than trusting the addressing.
	 *
	 * **Sent from `RoundService.announceWipe`, which `eliminate` calls**, and only when the round's own
	 * outcome function says the victim's side is now empty *and* the winner is the thrower's side. It fires at
	 * most once a round: the elimination that empties a side is the last one that can happen. **It is not a
	 * record and changes nothing** — what the round publishes about a finished round is now a set of badges on
	 * each body (`BADGES_ATTRIBUTE`, above in `constants.ts`), and this is the caption that has no place in it.
	 */
	teamWipe: Net.Definitions.ServerToClientEvent<[thrower: string]>(),

	/**
	 * Server → client: **you dodged a ball that came within a ball's width of hitting you** — the caption
	 * `Perfect` on the dodger's own screen.
	 *
	 * **A moment rather than a state, so it is an event**, on the argument `teamWipe` above makes: there is no
	 * attribute here for anyone else to read. What it describes is a *near miss*, and nothing in the world
	 * changes because of one — the ball is already past, the body is already somewhere else, and the round's
	 * own records do not count it (a dodge is `BadgeService.recordDodge`'s, taken at the request; a perfect
	 * dodge is the same dodge with a finer measurement, not a second one). An attribute would be a value
	 * written for one client and cleared by that client, which is a handshake with nothing on the other end.
	 *
	 * **Sent to one player rather than broadcast**, like {@link teamWipe} — the caption is on the dodger's own
	 * screen and the ball's near-miss is not news to anybody else. **It carries the dodger's name anyway**, so
	 * the one client that receives it makes the same `Players.LocalPlayer.Name` comparison it makes for every
	 * other event rather than trusting the addressing — the same belt `teamWipe` wears.
	 *
	 * **Sent from `DodgeService` and nowhere else**, because that is the only machine that can measure it: the
	 * ball's path and the body's own position at the instant it dodged are both server facts, and a client
	 * that claimed one would be claiming the other. It is sent for a *player* only — a rig's perfect dodge is
	 * measured and printed, and has no screen to appear on (see `DodgeService.watchForPerfectDodge`).
	 *
	 * **No distance on the wire.** The caption is a word; the stud figure is the server's log line, and a
	 * field no client reads is a field that gets believed later — the argument {@link hitImpact}'s doc makes
	 * about the direction, the sides and the count.
	 */
	perfectDodge: Net.Definitions.ServerToClientEvent<[dodger: string]>(),

	/**
	 * Client → server: **give me the board** — every body on a side, player or rig, with its round's counters and
	 * its points.
	 *
	 * **A request and an answer rather than a `ServerAsyncFunction`, and that is a reversal with a report
	 * behind it.** It was declared as an async function, on the argument that a call that returns a value needs
	 * no second event and carries no correlation id for anybody to get wrong. What the argument missed is what
	 * the rest of this file is evidence for: **every remote in this game that has ever been seen to work is a
	 * `ClientToServerEvent` or a `ServerToClientEvent`**, and the board's was the only `ServerAsyncFunction` in
	 * the project — one call shape, used once, whose round trip was never observed to complete. Two sessions of
	 * *"the panel is empty"* is what an unexercised mechanism costs, and the fix is not a better async function:
	 * it is the pair of events that {@link openPowerChest}/{@link chestResult} already prove, in the same file,
	 * for the same shape of conversation — *the client asks, the server answers that one client*.
	 *
	 * **The round trip survives, and so does the cost.** The panel is still empty for one ping when it opens and
	 * filled when the answer lands; what is gone is the id the library used to match a reply to its request,
	 * which the board does not need: the payload is a *snapshot*, so the only thing a stale answer can do is
	 * arrive after a newer one. Two opens inside one ping is a key press and its repeat, and the later arrival
	 * wins — see `MatchStatsController.receive`, which draws whatever the last answer was.
	 *
	 * **Nothing is sent by the client**, on `catch` and `drop`'s argument: the server already knows who is
	 * asking, and there is nothing else to ask. There is no argument to validate, which is why this one has no
	 * note about the wire being untyped — a caller cannot say anything untrue.
	 *
	 * **The answer is the round's own, not the asker's**: every body on a side — the players from
	 * `Players.GetPlayers()` and the rigs from `rigsOnASide` — so the board is the same list
	 * on every machine that asks. See {@link matchStatsBoard} for the reply, `shared/matchStats.ts` for the row
	 * and `MatchStatsService` for what it reads.
	 */
	matchStats: Net.Definitions.ClientToServerEvent<[]>(),

	/**
	 * Server → client: **the board** — one row per body on a side, for the one player who asked.
	 *
	 * **The answer to {@link matchStats}, and sent to that player alone.** `SendToPlayer` rather than
	 * `SendToAllPlayers`, because nobody else asked and a board is the largest payload in the game: eight rows of
	 * seven fields is fine once and wasteful sixteen times a second if it were pushed. See {@link matchStats} for
	 * why this is a pair of events rather than a function.
	 *
	 * **No request id, and the omission is argued rather than accidental.** `chestResult` has none either, and
	 * for the same reason: the payload is a whole state rather than an increment, so an answer that arrives out
	 * of order is an answer that is merely older. A client that asked twice in one ping draws the answer it got
	 * last, which is the same board.
	 *
	 * **`ReadonlyArray` on both sides of the wire and a plain array on it**: `MatchStatsRow` is two strings and
	 * five numbers per row, so this is a table of tables — the one shape every remote in `@rbxts/net` carries
	 * without a serialisation rule, and the reason `shared/matchStats.ts` keeps the row flat.
	 */
	matchStatsBoard: Net.Definitions.ServerToClientEvent<[rows: ReadonlyArray<MatchStatsRow>]>(),

	/**
	 * Client → server: this player wants to spend coins on a Power Chest.
	 *
	 * **Carries nothing, for {@link multiBall}'s reason.** The chest's price, the roster and this
	 * player's wallet are all facts the server alone holds, so there is nothing a client could truthfully
	 * say here. The answer is {@link chestResult}, because a chest *does* need an answer: unlike a mark
	 * or a window, whose acknowledgement is a replicated attribute, a refusal here has to say why — "not
	 * enough coins" and "all collected" are different answers to a player, and the wallet is the one
	 * attribute that is allowed to stay unchanged by a successful action's *opposite*.
	 */
	openPowerChest: Net.Definitions.ClientToServerEvent<[]>(),

	/**
	 * Server → client: what the chest the player just opened did.
	 *
	 * **`granted` is the item's name on success and `""` on refusal**, and `reason` is the human
	 * sentence for the refusal (empty on success) — so a client draws the answer from one event rather
	 * than inferring it from which attributes changed. Sent to the one player, not broadcast.
	 *
	 * **What a name is depends on the arm, and the two differ on purpose.** A power arrives as its *id* —
	 * `"Pierce"` — because the client already owns the id→words map the roster is drawn from
	 * (`ABILITY_NAMES`), and sending the name would be a second copy of that vocabulary on the server. A
	 * cosmetic arrives as its *display name* — `"Verdant Trail"` — because this panel has no such map: its
	 * footer is one line with nowhere to look a cosmetic id up from, and `COSMETICS` is the server's file. A
	 * client tells them apart with the same test it uses everywhere else (`isAbilityKind`) and draws
	 * anything that is not an ability id verbatim.
	 */
	chestResult: Net.Definitions.ServerToClientEvent<[granted: string, reason: string]>(),

	/**
	 * Client → server: this player wants to spend coins on one catalogued cosmetic.
	 *
	 * **Carries the cosmetic's id as a string**, not a `CosmeticDef` and not a slot: the wire is not typed, so
	 * the server treats what arrives as an arbitrary string and checks it against the catalogue — the
	 * arrangement `castVote` and `equipCosmetic` both describe, and for the same reason. There is no second
	 * argument naming a slot, because the catalogue alone says what the thing is; a purchase never has to say
	 * *where* something is worn, only what it wants.
	 *
	 * **The answer is {@link purchaseResult}, for the reason the chest gets one**: a purchase has refusals a
	 * player cannot tell apart by watching nothing happen — "not enough coins" and "already own it" are
	 * different situations, and the wallet is the one attribute that is allowed to stay unchanged by a
	 * successful action's opposite. It is a *separate* event from {@link chestResult} rather than a reuse,
	 * because the two vocabularies must not collide: the refusal strings are deliberately different sentences,
	 * and the client can then draw both on one line without a flag saying which action it was answering.
	 */
	purchaseCosmetic: Net.Definitions.ClientToServerEvent<[id: string]>(),

	/**
	 * Server → client: what the purchase the player just asked for did.
	 *
	 * **Same shape as {@link chestResult} — `granted` is the cosmetic's display name on success and `""` on
	 * refusal, `reason` is the human sentence for the refusal.** It is a distinct event rather than a reuse of
	 * the chest's because the two refusals must be able to say different things: the chest's reasons are its
	 * own ("you already had that one", "nothing left in the chest to win") and a purchase's are this event's
	 * ("you already own that trail", "that trail isn't for sale"). Two events, one shared line on the panel,
	 * and the client knows which sentence it is reading because the event that carried it says so.
	 *
	 * **`granted` is the name, not the id, for the reason {@link chestResult} now gives about its own cosmetic
	 * arm**: the panel has one line with nowhere to look an id up from, and `COSMETICS` is the server's file.
	 */
	purchaseResult: Net.Definitions.ServerToClientEvent<[granted: string, reason: string]>(),

	/**
	 * Client → server: this player wants to wear this cosmetic in this slot.
	 *
	 * **Two strings, and the slot is on the wire for one reason: an empty id names no slot by itself.**
	 * `""` is the meaningful value "no cosmetic — the default" (see `EQUIPPED_TRAIL_ATTRIBUTE`), and a
	 * message carrying only that would leave the server unable to tell a trail being cleared from an
	 * elimination being cleared. So both travel, and both are checked on arrival: the slot must be one
	 * this build knows, and the id must be either empty or a catalogued cosmetic *of that slot*.
	 *
	 * **Ownership is deliberately not sayable from this end.** The client asserts what it would like to
	 * wear; whether it owns the thing is answered by the server from its own record, because a client
	 * that could tell the server what it owned would be a client that could equip anything. See
	 * `EconomyService.equipCosmetic` for the order the checks run in.
	 *
	 * **No reply event, unlike {@link openPowerChest}.** A chest needs an answer because its refusals are
	 * three different sentences a player cannot distinguish by watching nothing happen; an equip's
	 * refusals are all "that request was not valid", which a correct client never sends and which is not
	 * worth a sentence. The acknowledgement is the attribute changing, which replicates on its own — the
	 * same shape `markHeldBall` uses.
	 */
	equipCosmetic: Net.Definitions.ClientToServerEvent<[slot: string, id: string]>(),

	/**
	 * Client → server: this player wants the named power in or out of their item-box pool.
	 *
	 * **A toggle rather than a setter.** The wire carries a request to *flip* one power, not a pool to
	 * install, so a client that has lost track of what it has — which is any client that has just joined,
	 * or joined back — cannot assert a pool the server disagrees with. Flipping what the server already
	 * holds is a change the server can make correctly whatever the client believes, which is the property a
	 * setter does not have.
	 *
	 * **The pool is not ownership, and this cannot grant anything.** The named power must be one the player
	 * already owns, checked against the record — so the worst a malicious client can do is put something it
	 * owns into a pool nothing reads yet. See `EconomyService.togglePowerPool` for the order of the checks.
	 *
	 * No reply event, for the reason {@link equipCosmetic} gives: the acknowledgement is the attribute
	 * changing, which replicates on its own.
	 */
	togglePowerPool: Net.Definitions.ClientToServerEvent<[power: string]>(),
});
