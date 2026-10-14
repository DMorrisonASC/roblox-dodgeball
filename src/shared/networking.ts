import Net from "@rbxts/net";

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
 * One line of the round-result board: whose row it is, and the two figures the round counted for them.
 *
 * **A name rather than a `Player`.** The board is drawn between rounds, and the round's roster is
 * emptied before the intermission begins — so the thing the label needs is something to *print*,
 * and that is what travels. A `Player` on the wire would be a reference the client would then have
 * to resolve against a list it may no longer contain.
 *
 * **The id is for the face, and it is a number because a face is looked up by one.** Every client
 * has to draw a picture for a name it cannot otherwise resolve — a player who has since left is not
 * in `Players` on this machine — so the id travels with the name rather than being looked up here.
 *
 * **Both figures are the round's, not lifetime ones.** `StatsService` keeps career counts and they
 * are deliberately not these: a board about the round that just ended is not the place for a total,
 * and the two sets of numbers have different lifetimes for that reason. See `RoundService.roundHits`
 * and `RoundService.roundOuts`.
 */
export interface RoundResultRow {
	readonly userId: number;
	readonly name: string;
	readonly hits: number;
	readonly outs: number;
}

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
 * strings to drift apart. That is the argument `voteCountAttribute` makes about a shared key, and the
 * same one `RoundResultRow` makes about living here rather than next to the service that sends it. The
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
	 * Client → server: this player wants the opposite of whatever their throwing setting
	 * currently is.
	 *
	 * **A request to flip, not a value to set.** Sending the setting itself would make the
	 * wire the description of a state, and a client that lost track of it — after a
	 * respawn, say — could switch throwing on for a player who had it off. Flipping what
	 * the server holds cannot disagree with the server, whatever the client believes.
	 */
	toggleThrow: Net.Definitions.ClientToServerEvent<[]>(),

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
	 * itself.** `toggleThrow` above argues the opposite case at length — a request to flip rather
	 * than a value to set, because the server owns the setting and a client that had lost track of
	 * it could otherwise switch throwing *on* for somebody who had it off. The reasoning there is
	 * about *authority*, not about values on the wire, and it does not reach this event: the server
	 * holds no opinion about whether a key is down, and no way to discover it. That is a fact only
	 * the client has, so the client is the only thing that can report it, and the honest shape of a
	 * held key is a boolean that stays true until it is false.
	 *
	 * Nothing is validated on the far side and nothing needs to be: an untrue `true` buys a player
	 * fifteen studs per second for as long as their stamina lasts, which is what the same player
	 * gets by holding the key, and running out stops it either way. See `WalkSpeedService`.
	 */
	setSprinting: Net.Definitions.ClientToServerEvent<[active: boolean]>(),

	/**
	 * Client → server: whether this player is **holding the throw button** — a charge in progress.
	 *
	 * **A level, on `setSprinting`'s terms and for its reason: the server holds no opinion about a button
	 * and no way to discover one.** The charge is measured on the client (`client/throwing.ts` owns its
	 * start time) and the server learns nothing about it until the release arrives carrying the charge — so
	 * a pool that must not refill while a body is winding up a throw has to be *told*, and the client is the
	 * only machine that can say.
	 *
	 * **Nothing is validated on the far side, and the reason that is safe here is worth following through.**
	 * An untrue `true` buys *nothing at all*: `WalkSpeedService` holds the **recovery** while this is up and
	 * deliberately leaves the **drain** alone, so a client claiming to be charging forever while sprinting
	 * still burns its pool at the normal rate and gains exactly zero, and one claiming it while walking
	 * gives up the recovery it would otherwise have collected. **The lie is either neutral or self-harming** —
	 * which is a stronger position than `setSprinting` is in, where an untrue `true` buys movement until the
	 * pool runs out.
	 *
	 * **The server clears it on a new body**, because the claim is per *player* and the state it describes is
	 * per *body*: a client that died mid-charge may never send the `false`, and a pool that never refilled
	 * again would be a worse fault than the one this exists to fix. See `WalkSpeedService.trackPlayer`.
	 */
	setCharging: Net.Definitions.ClientToServerEvent<[charging: boolean]>(),

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
	 * Server → client: the round that has just finished, as the result panel reads it.
	 *
	 * **The only entry in this file that travels the other way.** Every other declaration here is a
	 * client asking the server to do something; this is the server telling the clients what happened.
	 * There is nothing to send back, and nothing to validate on arrival beyond the shape: a client
	 * cannot fire it.
	 *
	 * **A list, therefore not an attribute.** The folder the rest of the HUD reads carries scalars —
	 * one phase, one clock, one flag, one packed option string. A board is a side's worth of rows,
	 * and the alternative that was considered — an attribute per player, read off `Players` and
	 * filtered by side on the client — puts the ranking rule on the machine that is drawing it,
	 * where the order a board is in would be decided by whoever wrote the label.
	 *
	 * **It carries the mode as well as the side label, and that is not redundancy.** The client names
	 * a side through `sideNameOf(mode, label)`, and the mode it would otherwise read off
	 * `ROUND_MODE_ATTRIBUTE` is rewritten twenty seconds into the intermission — when the vote closes
	 * and names the *next* round. A panel still on screen would have watched the winning side change
	 * its name underneath it.
	 *
	 * **Fired once, so it is the one HUD fact a late joiner does not get.** A client that connects
	 * during the intermission has no result to draw and shows no panel; it did not watch the round,
	 * and there is nothing on the folder for it to catch up from.
	 */
	roundResult: Net.Definitions.ServerToClientEvent<[mode: string, winner: string, rows: RoundResultRow[]]>(),

	/**
	 * Server → client: **one hit, as the two people in it** — the third entry here that travels this way,
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
	 * rig's GUID to its rig is `throwerOf`'s job. Gated like everything else about a hit: `registerHit`
	 * returns unless a round is being played, so a ball that touches a body outside one draws nothing.
	 *
	 * **It is not a record and nothing accumulates from it.** `roundHit` and `roundHitLog` remain the round's
	 * history of a hit between two people; this is the same event told to the clients that have to draw it,
	 * and only `hitVfx` reads it.
	 */
	hitImpact: Net.Definitions.ServerToClientEvent<[victim: string, thrower: string]>(),

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
	 * same shape `toggleThrow` and `markHeldBall` use.
	 */
	equipCosmetic: Net.Definitions.ClientToServerEvent<[slot: string, id: string]>(),

	/**
	 * Client → server: this player wants the named power in or out of their item-box pool.
	 *
	 * **A toggle rather than a setter, on {@link toggleThrow}'s precedent and for its exact reason.** The
	 * wire carries a request to *flip* one power, not a pool to install, so a client that has lost track
	 * of what it has — which is any client that has just joined, or joined back — cannot assert a pool the
	 * server disagrees with. Flipping what the server already holds is a change the server can make
	 * correctly whatever the client believes, which is the property a setter does not have.
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
