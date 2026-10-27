import { CollectionService, Debris, Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { BODY_ID_ATTRIBUTE, NPC_TAG } from "shared/constants";
import { events } from "shared/networking";
import { DEBUG_LOGGING, logDebug, logInfo, logWarn } from "shared/logger";

/**
 * # The hit impact effect: gold for the thrower, red for the body it landed on
 *
 * **A client-side effect on a server-side fact, exactly like `catchShockwave`.** The server decides that a
 * hit landed and says so on the wire; who draws it, and in what colour, is each client's own business. So
 * nothing here is cloned on the server, nothing is sent from here, and the module's only inputs are the two
 * events below — `hitImpact` for a landing and `caughtThrow` for the thrower whose ball never landed.
 *
 * **THE EFFECT IS FOUND BY NAME — the template's structure is a moving target and the only contract is its
 * name.** The two templates are found by a walk of `ReplicatedStorage`, their parts by walking the clone,
 * and their emitters by *class* rather than by any name inside them. Re-parent the carrier, add a second
 * emitter, rename `Shockwave1` — all free. `HitAttacker` and `HitVictim` are the whole of the interface.
 *
 * **The colour is the template, and this file never writes a `Color3`.** Gold and red are two emitters
 * recoloured in Studio by hand, and which one plays is decided by which *name* is looked for. That is
 * deliberate rather than a shortcut: a tint written here would be a second colour authority beside the one
 * in the place file, and the two would drift — the emitter's own `Color` sequence, its `LIGHT_EMISSION` and
 * its texture all multiply into the pixel, and none of that is knowable from code. **What this file
 * decides is *which* of the two, which is a question about who is watching and nothing else.**
 *
 * ## What the event carries, and why it is not the hit feed's
 *
 * **`hitImpact` — a second event about a hit, and it exists because the first one cannot do this job.**
 * `roundHit` is the *feed's* event, and its gates follow from that: it is sent from `RoundService.logHit`,
 * which is reached only when **both** ends are players —
 *
 * ```
 * if (thrower !== undefined && thrower.IsA("Player")) {
 *     if (victimPlayer !== undefined) this.logHit(thrower, victimPlayer);
 * }
 * ```
 *
 * — so a rig's throw (`thrower` is the rig `Model`) and a ball that lands on a rig (`victimPlayer` is
 * `undefined`) produce no `roundHit` at all. **In a round played against rigs that is most of the hits in
 * it.** This file read that event first, and a live session whose only line was the boot line is what
 * settled it: a subscription that never fires and an effect that never runs are the same silence.
 *
 * **So the server sends `hitImpact` from `registerHit`, where both ends do resolve** — the thrower's token
 * is a `UserId` for a player and a GUID for a rig, and `throwerOf` is what matches the GUID to its rig. It
 * carries two names and nothing else: the victim's model name, then the thrower's. The colour is which
 * template is cloned, so a direction, a side or a count would be written on the wire and never read.
 *
 * **Both names is enough for both decisions.** A player's character carries the player's name and a rig
 * carries its own, so the victim end is one comparison against `Players.LocalPlayer.Name` either way, and
 * the thrower end is the same comparison from the other side. A rig and a player sharing a name is the one
 * case that would confuse it, and the feed's two name fields already rest on the same assumption.
 *
 * **What it is not is a way around the feed's gates.** `roundHitLog` and `roundHits` remain records about
 * people, still filled only for a person's throw at a person, and this event neither feeds nor changes them.
 * It is the cosmetic half of the same moment, sent to everyone, read by this file alone.
 *
 * ## The third-party case: a bystander sees it in the same red
 *
 * A client that is in neither end of a hit draws `HitVictim` — **the same red the dying body's own client sees**
 * — on the victim's body. **This has been three decisions, and the third one is the user's own report**, so the
 * history is worth keeping rather than flattening: the first version drew nothing for a third party; the second
 * drew a white neutral burst, on the argument that a spectator's burst should say "that was not yours to take";
 * and the current one draws the red, because *"I don't see the effect when my team mates or opposing rig/player
 * dies, it should be the same as the one I see when I die"*.
 *
 * **The argument that settles it is what this game does with a hit: it kills.** A hit is lethal — that is what
 * `BallComponent`'s own comment says, and why the round ends on one — so the body in the burst is a body that is
 * about to die, and the *colour of a death* should not depend on which seat is watching it. The white version
 * was reasoning about the effect as an injury ("did this happen to me"), which is the right question for a
 * damage system and the wrong one here: there is no partial damage to be possessive about, and a spectator who
 * sees white is a spectator whose screen says less than the dying player's does about the same event.
 *
 * **What survives from the white version is the *reason* it existed** — a fight this client is not in is still a
 * fight it is watching, and the hits between two rigs are most of what happens in a round against them. That
 * argument was always in favour of drawing *something*; only the colour was in dispute.
 *
 * **The white template's name is gone from this file, and that is deliberate.** It stayed for a while as an
 * unused constant described as "the one-line undo", which is not an undo — an undo is a line you change, and a
 * name nothing reads is a line you would have to *find* first, in a file whose whole point is that the colour
 * question is settled. The way back is one string at the two call sites that pass `VICTIM_TEMPLATE_NAME`, and a
 * comment that has to say "still named here, unused" is a comment arguing for code that is not there. The
 * neutral template *instance* is still in the place file; this file no longer has an opinion about it.
 *
 * **The cost is unchanged from the white version**: every client draws every hit, so the particle work per hit
 * is multiplied by the number of clients that can see it. It is one clone per client per hit either way — the
 * only difference is which emitters that clone carries.
 *
 * ## A caught throw: red on somebody else's body, for the same reason
 *
 * **A catch is the mirror image of a hit and it is drawn from its own event.** When a thrown ball is caught by
 * an enemy, nothing was tagged — the ball never reached the body it was aimed at — and the player who pays is
 * the one who *threw* it: `RoundService.resolveCaughtThrower` kills the thrower and, where the mode scores,
 * credits the catcher's side. So there is no `hitImpact` for it at all, and the body that has to show the cost
 * is the thrower's rather than the catcher's.
 *
 * **`caughtThrow` carries the thrower first and the catcher second**, and this file puts `HitVictim` — red — on
 * the thrower's body. Two readers, not three: the thrower's own client draws it on its own character, and every
 * other client draws it on the body the name resolves to, which is a rig in most rounds played against them.
 *
 * **This branch and the spectator branch above now agree**, and that agreement is the current rule: **red is the
 * colour of a body that is out**, drawn on that body for every client that can see it, whichever end of the
 * exchange this client happens to be at. The only body that gets a different colour is the one the local player
 * *hit*, which is gold — gold says "I did that", which is a sentence only the thrower can say.
 *
 * **It does not touch `catchShockwave`.** The catcher's burst is read from the `AnimCatch` mark by that module,
 * on the catcher's own body; this is a different body and a different event, so both play and neither replaces
 * the other. The one shared thing is `playOn`'s per-body replacement, which can only ever replace an effect on
 * the *same* body — and a body cannot be both the thrower of a caught ball and the catcher of it.
 *
 * ## What this is not
 *
 * - **Not a second subscriber to the feed's event.** This file reads `hitImpact` and `caughtThrow` and nothing
 *   else — not `roundHit`, which the hit feed already reads, and not any attribute, `HealthChanged` or poll.
 *   **Two events rather than one, and they are two different facts**: `hitImpact` is a ball landing on a body
 *   and `caughtThrow` is a ball *not* landing on one, whose cost falls on the thrower. Neither can be derived
 *   from the other, and **`roundHit` must not be subscribed to here at all**: a player-on-player hit is in both
 *   it and `hitImpact`, so reading both would draw two bursts for one impact, the second replacing the first.
 *   A body's health dropping is *not* a hit either — it is also a reset, a fall and a super, and deriving
 *   "somebody hit me" from it would be a second detection of a fact the server already publishes.
 * - **Not a change to `catchShockwave`.** The two modules are siblings that share a shape and nothing
 *   else: this file has its own finder, its own cloner and its own emitter handling rather than reaching
 *   into that one, because the sibling is Studio-proven and the last thing it needs is to be refactored
 *   while a second effect is being proved. The duplication is the cost of that and is named here so it is
 *   not discovered by surprise — the shape to extract later is the whole of `findTemplate` through
 *   `templateEmitters`, once both effects are settled.
 * - **Not a change to the hit path, the hit log or the damage.** The event it reads was added beside them:
 *   `logHit` and `roundHitLog` are untouched, `BallComponent` is untouched, and no number anywhere moves
 *   because a client drew something. `TAGS.md` too.
 */
export function startHitVfx(): void {
	// **Said at boot, and it is the line that separates two silences.** This module is a plain module with a
	// subscription and no Flamework controller around it, so it is started by hand from `main.client.ts` —
	// and "did this file run at all" is a question only the boot can answer. An effect that never fires and
	// an effect that was never wired print the same nothing. This is the line `DuckController` writes for its
	// key binding, for the same reason: a subscription that announces itself turns a silent failure into a
	// readable one.
	if (DEBUG_LOGGING) {
		logInfo(
			`[VFX] hit effects up — ${ATTACKER_TEMPLATE_NAME} when I land one, ` +
				`${VICTIM_TEMPLATE_NAME} for every hit, mine or anybody else's, ` +
				`and again on a thrower whose ball I watch get caught`,
		);
	}

	// **Two names, victim first, and that order is the event's** — a hit is an impact *at the body it landed
	// on*, so the victim is the subject of a fact and the thrower is what is said about it. The arrow in the
	// line below reads the other way round deliberately: `${thrower} → ${victim}` is the sentence a person
	// says, and the payload's order is the shape of the event rather than of the sentence.
	events.Client.Get("hitImpact").Connect((victim, thrower, _ability, victimId) => {
		// **`_ability` is declared and never read, and declaring it is the only way to reach the fourth
		// field.** The power the throw carried is `hitConfirm`'s business — it escalates the splash — and not
		// this file's, but a Luau handler reads its arguments by position, so leaving the third out would put
		// the ability in `victimId`'s place and have this resolve on the word "Freeze". The leading underscore
		// is the convention for an argument that exists to be stepped over.
		//
		// **Not called `local`.** Luau reserves that word, and roblox-ts refuses the *identifier* rather than
		// the use of it — the same family as `type`, `and`, `nil` and `self`, and a hard compile error rather
		// than a shadowing warning.
		const localPlayer = Players.LocalPlayer;

		// **One line per hit received, naming which end this client is on.** The event is broadcast, so this
		// prints on every client for every hit — and it is what makes the three cases that otherwise look
		// identical distinguishable in a log: a hit that never reached this client (no line at all, and the
		// reason is upstream of this file), a hit this client is in (this line, then an effect line), and a hit
		// this client is in neither end of (this line, and then nothing — which is the bystander decision
		// above, not a fault).
		//
		// **Only the two ends this file acts on are named**; anything else is the bystander, which is the
		// whole of the third case and needs no fourth value.
		const role =
			thrower === localPlayer.Name
				? "attacker"
				: victim === localPlayer.Name
					? "victim"
					: "bystander";

		logDebug(`[VFX] hitImpact — ${thrower} → ${victim} (this client is the ${role})`);

		// **I landed it.** Gold, and on the *victim's* body — a hit is an impact at the body it landed on,
		// not at the arm that threw it, so the only thing this client draws is the thing the ball hit.
		//
		// **The victim is looked up rather than held**, because this client is not that player: the wire
		// carries a name, and the body that answers it may be a **rig** as easily as a character — a ball this
		// client threw that landed on a rig is the commonest hit of a round played against them. See `bodyOf`,
		// which resolves both.
		if (thrower === localPlayer.Name) {
			const body = bodyOf(victim, victimId);
			if (body === undefined) {
				warnNoBody("attacker", victim, victimId);
				return;
			}

			playOn(ATTACKER_TEMPLATE_NAME, body, `${localPlayer.Name}: hit ${victim} — gold`);
			return;
		}

		// **I took it.** Red, and on my own body — which is a field rather than a lookup, because this is
		// the one body on the client that does not need finding.
		if (victim === localPlayer.Name) {
			const own = localPlayer.Character;
			if (own === undefined) {
				if (DEBUG_LOGGING) {
					logInfo(`[VFX] ${localPlayer.Name}: hit by ${thrower} — but no character to put it on`);
				}

				return;
			}

			playOn(VICTIM_TEMPLATE_NAME, own, `${localPlayer.Name}: hit by ${thrower} — red`);

			// **And the branch ends here, which it did not before.** The block below is the *spectator's*, and
			// nothing guarded it against a victim reaching it: the case that got this far fell straight through
			// into it, asked `bodyOf` for the same player by name — answering with the very character the red
			// had just been put on — and played the red on it a second time. `playOn` destroys the previous
			// burst on a body before cloning the new one, so the effect the victim had just been given was torn
			// down and restarted in the same frame. It never read as "no effect", which is why it went unnoticed;
			// what it cost was the first frame of every red burst the local player ever wore.
			return;
		}

		// **Neither end is mine, so I am a spectator — and I see exactly what the body's own client sees.** Red,
		// on the victim's body, because in this game a hit is a death: the body that was struck is a body that is
		// about to lie down, and the person watching it from either side of the court should read that the same
		// way the dying player does. **This was white, and the reversal is the user's own report** — *"I don't
		// see the effect when my team mates or opposing rig/player dies, it should be the same as the one I see
		// when I die"* — which is the whole of the argument: a colour that means "somebody else was hit" is a
		// colour that says nothing about what happens next, and what happens next is the same for everybody.
		//
		// **The cost, named rather than discovered**: this branch runs on *every* client for *every* hit, so a
		// body that dies now draws its burst on every screen at once rather than one white clone and one red one.
		// It is the same particle work as before — one burst per hit per client either way — and what changed is
		// only which template is cloned. If the red ever reads as too loud, the lever is the two `playOn` calls
		// above and this one: they name the template, and this file decides nothing else about the colour.
		const body = bodyOf(victim, victimId);
		if (body === undefined) {
			warnNoBody("bystander", victim, victimId);
			return;
		}

		playOn(VICTIM_TEMPLATE_NAME, body, `${localPlayer.Name}: bystander — ${victim} was hit — red`);
	});

	// **The catch's counterpart: my throw was stopped, so the red goes on *my* body this time.**
	//
	// One subscription for both seats, because the question is the same question asked of a different body —
	// and the answer is `HitVictim` either way. **The thrower is the name tested first**, which is the reverse
	// of the handler above, and that is not an inconsistency: there the body drawn on is the victim's and the
	// local player is compared against it, while here the body drawn on is the thrower's and the thrower is what
	// the event leads with. Read the payload as a sentence — "this body's throw was caught by that one" — and
	// the order is the shape of the fact rather than a preference.
	logDebug(`[VFX] catch effects wired`);

	events.Client.Get("caughtThrow").Connect((thrower, catcher) => {
		const localPlayer = Players.LocalPlayer;

		// **Mine.** The one body on this client that needs no lookup, so it is taken from the player rather than
		// from `bodyOf` — the same split the victim branch above makes, and for the same reason: a character mid
		// respawn has no body at all, and that is worth a line of its own rather than reading as "not found".
		if (thrower === localPlayer.Name) {
			const own = localPlayer.Character;
			if (own === undefined) {
				if (DEBUG_LOGGING) {
					logInfo(`[VFX] ${localPlayer.Name}: throw caught by ${catcher} — but no character to put it on`);
				}

				return;
			}

			playOn(VICTIM_TEMPLATE_NAME, own, `${localPlayer.Name}: throw caught by ${catcher} — red`);
			return;
		}

		// **Anybody else's throw, which in a round against rigs is nearly every catch.** The body is resolved by
		// name exactly as the hit path resolves a victim's — a rig or another player, one string either way — and
		// the red is the same red the hit path now draws on everybody: the body that lost its throw, seen by the
		// people watching it happen. See the module doc for why the two branches agree on the colour and only the
		// sentence on the wire differs.
		//
		// **`""` for the id, because `caughtThrow` carries none.** That event is older than the field and has
		// one name in it; a catch is drawn on a thrower the client can find by name, and the bodies a catch
		// resolves to are the round's rigs and players, which are named uniquely. The duplicate-name case the
		// id exists for is a body somebody cloned by hand, and a body cloned by hand does not throw.
		const body = bodyOf(thrower, "");
		if (body === undefined) {
			warnNoBody("bystander (caught)", thrower, "");
			return;
		}

		playOn(VICTIM_TEMPLATE_NAME, body, `${localPlayer.Name}: bystander — ${thrower}'s throw caught by ${catcher} — red`);
	});
}

/**
 * The body a name names — **a player's character first, then a rig** — or nothing.
 *
 * **Two kinds of body, and the wire cannot tell them apart.** A player's character carries the player's name
 * and a rig carries its own, so one string has to answer for both; the order below is the whole of the
 * distinction, because a player's name is unique among players and no rig is called after one.
 *
 * **A loop over `Players.GetPlayers()` rather than `FindFirstChild(name)`**, which would answer with
 * whatever a `Player`'s child is called — the class-of-decoy trap `find.ts` argues about at length, arriving
 * by a different door. A player is a child of `Players` and nothing else is, but the lookup is *asking about
 * a player*, so it says so.
 *
 * **And then the rigs — by tag first, then by a walk of `Workspace` that requires a `Humanoid`.** The tag is
 * still the right first answer, because `NPC_TAG` is how every other reader here finds a rig and a tagged rig is
 * one this client is already dressing. **But the tag alone was narrower than the thing that sends the event.**
 * `BallComponent`'s body test is a `Model` with a `Humanoid` in it — it never looks at `NPC_TAG` — so a rig
 * standing in a practice zone that a person placed by hand, or one whose tag was painted off, is a body the
 * server happily reports a hit for and a name this function could not resolve. The symptom of that asymmetry is
 * precise: the throw lands, the tag resolves, the event arrives, and **nothing is drawn**, because the client
 * could not turn a name it was given back into the body it was standing next to.
 *
 * **The `Humanoid` is what makes the walk safe**, and it is the whole of the difference between this and the
 * name search the paragraph above refuses. A map part called `PlaceholderRig3` is a `Model` and would match on
 * name; a map part with a `Humanoid` in it is a body by every definition this game uses — it can be thrown at,
 * it can be tagged, and a hit on it is a hit worth drawing. So the decoy disappears not because the search got
 * narrower but because the question got asked correctly: *"is there a body by this name"*, rather than *"is
 * there a tagged body by this name"*, which is a different and stricter question that only usually has the same
 * answer. The walk costs a descendant scan of `Workspace` — and only for a body that is **not** tagged, since
 * a rig the lobby spawned is resolved on the id in the tag walk below; a scan of the whole world happens once
 * per hit on a hand-placed body at most, which is not a per-frame cost. The alternative, a name index kept in
 * step with the world, is a service for a lookup that happens a few times a second at most.
 *
 * **`Character` and not `FindFirstChild("HumanoidRootPart")`**: whether a body exists is a different
 * question from whether it has a root, and the two are answered in two places on purpose — a character
 * mid-respawn has none at all (here), while a body whose model has not streamed its root is a real fault
 * with a line of its own (in `playOn`). The same split holds for a rig: it comes back from here whether or not
 * it is tagged, and `playOn` is what says whether it has anything to weld to.
 *
 * **And the id first, because a name is not an identity.** The report that put this here was a rig cloned
 * seven times in Studio — seven models called `Rig` — and every arm below answers with *a* body of that name
 * rather than *the* body the ball hit. `hitImpact` therefore carries `BODY_ID_ATTRIBUTE` as well, and when it
 * does this resolves on that and never reaches a name at all. See `RoundService.bodyIdOf` for how the id is
 * minted; it is `""` for a payload from a build that predates the field, and the name arms are what remain for
 * one of those and for `caughtThrow`, which carries no id of its own.
 */
function bodyOf(name: string, id: string): Model | undefined {
	if (id !== "") {
		// **The tag walk first and the workspace walk second**, which is not a fallback but the same order the
		// name arms below use and for the same reason: most hits are on rigs the lobby spawned, and those are
		// all tagged. A workspace walk therefore only happens for a body somebody placed by hand — the case
		// that asked for the id in the first place.
		for (const tagged of CollectionService.GetTagged(NPC_TAG)) {
			if (!tagged.IsA("Model")) continue;
			if (tagged.GetAttribute(BODY_ID_ATTRIBUTE) !== id) continue;

			return tagged;
		}

		for (const descendant of Workspace.GetDescendants()) {
			if (!descendant.IsA("Model")) continue;
			if (descendant.GetAttribute(BODY_ID_ATTRIBUTE) !== id) continue;

			return descendant;
		}

		// **Then it falls through to the names rather than returning nothing.** An id that matches no body
		// means the body left the world between the hit and this line — a rig taken out by its own respawn is
		// the ordinary way — and a burst drawn on the same-named body standing where it was beats silence. The
		// id is a refinement; it is not allowed to become a new way for the effect to vanish.
	}

	for (const player of Players.GetPlayers()) {
		if (player.Name !== name) continue;

		return player.Character;
	}

	for (const tagged of CollectionService.GetTagged(NPC_TAG)) {
		if (!tagged.IsA("Model")) continue;
		if (tagged.Name !== name) continue;

		return tagged;
	}

	// The untagged body, which only a practice zone is likely to hold — see the doc above for why the tag alone
	// was the wrong test and why the `Humanoid` below is what keeps this from matching scenery.
	if (name !== "") {
		for (const descendant of Workspace.GetDescendants()) {
			if (!descendant.IsA("Model")) continue;
			if (descendant.Name !== name) continue;
			if (descendant.FindFirstChildWhichIsA("Humanoid") === undefined) continue;

			return descendant;
		}
	}

	return undefined;
}

/**
 * Plays `templateName` on `body`, and prints `line` when it does. **The whole of the effect.**
 *
 * **One function for both colours**, because the only thing that differs between them is which name is
 * looked for and which sentence is printed — and two functions would be two copies of the weld, the flags
 * and the emitter handling, which is where the two effects would drift apart.
 */
function playOn(templateName: string, body: Model, line: string): void {
	const template = findTemplate(templateName);
	if (template === undefined) {
		// **Warned about once *per template name*, and printed on every hit.** Once per name rather than
		// once per session, because there are two templates here and a missing `HitAttacker` must not
		// swallow the warning for a missing `HitVictim` — the whole point of the line is to say which of the
		// two is not there. Printed every time for the reason the sibling records at length: a warning that
		// fires once and then goes quiet is indistinguishable, from the seat, from code that never ran.
		if (!warnedTemplates.has(templateName)) {
			warnedTemplates.add(templateName);
			logWarn(`[VFX] no ${templateName} in ReplicatedStorage — that hit effect will not play`);

			// And what the client *can* see instead, because "no template" is true of a name that is absent,
			// a name that is misspelled and a template in the wrong container — three different fixes.
			for (const reportLine of nearMissReport()) logWarn(`[VFX] ${reportLine}`);
		}

		logDebug(`[VFX] ${body.Name}: hit, but no ${templateName} template to clone`);
		return;
	}

	const root = body.FindFirstChild(ANCHOR_PART);
	if (root === undefined || !root.IsA("BasePart")) {
		// **Warned rather than traced**, and this is the line that ends the guessing. A body with no
		// `HumanoidRootPart` is a rig whose model is not what this file assumes, and it is one of the four
		// ways a hit can draw nothing at all — the other three being an event that never arrived, a name this
		// client could not resolve and a template that is not there. Those four are indistinguishable from the
		// seat, and three of them used to be `DEBUG_LOGGING`-only prints in a file whose `DEBUG_LOGGING` is off. Once per body
		// name, like the template warning below, because a rig with no root will never grow one.
		if (!warnedBodies.has(body.Name)) {
			warnedBodies.add(body.Name);
			logWarn(`[VFX] ${body.Name}: hit, but no ${ANCHOR_PART} to attach it to — nothing will draw there`);
		}

		return;
	}

	// **The previous one goes first**, so a body never wears two — and a body can be hit twice inside this
	// effect's own lifetime, which is the case this is for. Destroyed rather than left to `Debris`, because
	// the point is that the *new* impact is the one on screen.
	playing.get(body)?.Destroy();

	const clone = template.Clone();

	// **A template with no `BasePart` in it at all, carried by a part this file makes.** That is the shape
	// these two arrived in: a `Model` — `HitAttacker`, `HitVictim` — whose only child is the `Main`
	// attachment, with the emitters inside *that*. Nothing is wrong with a model as a wrapper, and the
	// emitters are exactly where a person would put them; what is missing is the part, and the two things a
	// part is needed for are both real rather than bureaucratic:
	//
	// - **a `WeldConstraint` joins two `BasePart`s.** There is no weld, and therefore no way to keep the
	//   effect on the body, without one.
	// - **an `Attachment` needs a `BasePart` above it for its position to mean anything.** An attachment's
	//   frame is expressed *inside a part*; parented to a `Model` it has no such frame to be expressed in.
	//   So adopting the attachment into the part below is not bookkeeping — it is what gives the emitters a
	//   position at all.
	//
	// **So the carrier is made and the attachments are adopted into it**, and everything downstream — the
	// flags, the anchor, the weld, the emitters — is unchanged and identical to the catch effect's path. The
	// alternative was to require a part in the template and say so, which would be a rule about structure in
	// a module whose whole contract is that structure is a moving target; a person building this in Studio
	// should not have to know which wrapper the cloner prefers.
	const parts = templateParts(clone);
	if (parts.isEmpty()) {
		const carrier = new Instance("Part");
		carrier.Name = CARRIER_NAME;
		carrier.Size = Vector3.one.mul(CARRIER_SIZE);
		// **Its appearance is not set here.** The walk below flags this part exactly like every other part of
		// the clone — invisible, massless, shadowless — so that those seven flags have one owner rather than
		// two. A carrier this file makes and one a person made are the same thing: not the effect, and not
		// something to be looked at, weighed, or seen the shadow of.
		carrier.Parent = clone;

		// **Every attachment that is not already inside a part or inside another attachment.** Collecting
		// first and re-parenting second, because the walk itself is over a list that re-parenting changes —
		// and the attachments that *are* inside another attachment come along with their parent, so
		// adopting them too would move them twice.
		const orphans: Attachment[] = [];
		for (const descendant of clone.GetDescendants()) {
			if (!descendant.IsA("Attachment")) continue;

			const parent = descendant.Parent;
			if (parent !== undefined && (parent.IsA("BasePart") || parent.IsA("Attachment"))) continue;

			orphans.push(descendant);
		}

		for (const orphan of orphans) orphan.Parent = carrier;

		// **Declared as the model's centre**, so the anchor logic below needs no special case: it asks for
		// `PrimaryPart` and gets the part that was just made.
		if (clone.IsA("Model")) clone.PrimaryPart = carrier;

		parts.push(carrier);

		// **Once per template, not per hit.** It is a fact about the template rather than about this hit,
		// and it is worth knowing: the effect works, but the place file is carrying an emitter in a place
		// that has no part — which is also why the emitters may look anchored at the world origin if this
		// effect is ever extended by hand.
		if (DEBUG_LOGGING && !adoptedTemplates.has(templateName)) {
			adoptedTemplates.add(templateName);
			logInfo(`[VFX] ${templateName}: the template holds no part — carrying it on one this client made`);
		}
	}

	// **Every part, walked rather than named, and seven flags are set on each — the whole of what "a carrier
	// part" means here.**
	//
	// The first four are facts about physics and picking that cannot be wanted the other way: a carrier that
	// can collide, be touched or be queried is a part the game can react to, and an anchored one would pin the
	// body it is welded to.
	//
	// **`Massless = true` is the one of the three below that is a bug rather than a look.** A welded part
	// contributes its mass to the character's assembly, and `Anchored = false` does not cover that — the
	// carrier is joined to the body either way, so without this a body is heavier for the length of an effect
	// nobody can see. **`Transparency = 1`** because the carrier is not the effect, the emitter inside it is,
	// and a template that arrives with its default opaque part would flash a grey box on the body.
	// **`CastShadow = false`** because an invisible part still casts one.
	//
	// **The transparency half reverses a decision the catch effect used to argue for** — that the carrier is
	// invisible because its *author* made it so, and that a part meant to be seen is a thing somebody may add
	// to a template. That is overridden, and this file repeats it rather than inheriting it because the
	// sibling may not be edited by this task. The two effects agree on all seven flags; that is the point of
	// saying them twice.
	let first: BasePart | undefined;
	for (const part of parts) {
		part.Anchored = false;
		part.CanCollide = false;
		part.CanTouch = false;
		part.CanQuery = false;
		part.Massless = true;
		part.Transparency = 1;
		part.CastShadow = false;

		if (first === undefined) first = part;
	}

	// **The model's own `PrimaryPart` if it declares one, and the first part found otherwise** — a declared
	// centre is a fact a person set, and the fallback is for a template nobody has finished setting up.
	//
	// **There is no "no parts to weld" exit here any more, and its absence is the fix rather than an
	// omission.** That branch is what the first version of this file did with a template like this one, and
	// it is unreachable now: the only way `parts` could be empty was a template with no part in it, and that
	// case now makes the part instead of giving up on the effect. The sibling still carries the line, because
	// the sibling may not be edited by this task — see the module doc on the duplication.
	const declared = clone.IsA("Model") ? clone.PrimaryPart : undefined;
	const anchor = declared ?? first;
	if (anchor === undefined) return;

	clone.Parent = Workspace;

	// **Put *on* the body before it is welded there.** A `WeldConstraint` holds the offset the two parts
	// already have at the moment it is made; it does not pull one onto the other. A clone straight out of
	// `ReplicatedStorage` is therefore welded at the template's own distance from the world origin and
	// dragged around at that distance — which is what the catch effect did, on every rig at once, until this
	// line existed. `BallService` records the same lesson about a held ball ("a weld holds the offset the
	// parts already had and a ball caught across the body would stay across it").
	anchor.CFrame = root.CFrame;

	// **A `WeldConstraint`, parented to the clone** rather than to the root — `CollisionIgnore`'s trick and
	// its reason: the weld dies with the thing it holds, and no cleanup is anybody's job.
	const weld = new Instance("WeldConstraint");
	weld.Part0 = root;
	weld.Part1 = anchor;
	weld.Parent = anchor;

	// **By class, and every one of them.** A template with two emitters is a person having a second idea
	// about the shape, and firing one of them would be this code choosing which idea was better.
	const emitters = templateEmitters(clone);

	// **Once per session per template, and before the `Enabled` handling below touches anything** — so what
	// it reports is what the template holds rather than what this file just did to it. `Rate` and `Lifetime`
	// decide whether anything is emitted at all, `Size` and `Transparency` whether it can be seen, and none
	// of it is visible from the code.
	if (DEBUG_LOGGING && !describedTemplates.has(templateName)) {
		describedTemplates.add(templateName);

		if (emitters.isEmpty()) {
			logInfo(`[VFX] the ${templateName} template holds no ParticleEmitter — there is nothing to fire`);
		}

		for (const emitter of emitters) logInfo(`[VFX] emitter ${emitter.Name}: ${describeEmitter(emitter)}`);
	}

	// **And every emitter is locked to the carrier** — the one property in this file set on an emitter rather
	// than on a part. Unlocked, particles are born *into the world* at the point they were emitted: the
	// carrier keeps up with the body and they do not, so a body moving through its own effect leaves the burst
	// behind. Locked, they ride the part, which is what an effect welded to a body is asking for.
	//
	// **Set on the clone rather than read from the template**, so a template authored either way behaves the
	// same and the originals in `ReplicatedStorage` are untouched. The same line is in the catch effect; the
	// two agree rather than each doing what its own template happened to have.
	for (const emitter of emitters) emitter.LockedToPart = true;

	// **The `Enabled` question, which the installed typings do not answer, handled exactly as the sibling
	// handles it.** `ParticleEmitter:Emit` is documented in `@rbxts/types` as "emits a given number of
	// particles" and nothing more, so whether a template parked with `Enabled = false` is *gated* by that
	// property is unknown from here. An emitter authored off is therefore opened for exactly one frame —
	// long enough that `Emit` is not gated by it whichever way the engine behaves, short enough that a
	// non-zero `Rate` cannot spray for the clone's whole life. An emitter authored *on* is left alone, and
	// `Rate` is never touched: that is the author's look decision, not this file's.
	//
	// **The two effects must not disagree about this**, which is why it is copied rather than reconsidered.
	// The pattern below is also the one the catch effect was *seen working* with in Studio, which is the
	// only evidence available for it: `Emit` on a fresh emitter is not something the typings settle.
	for (const emitter of emitters) {
		if (emitter.Enabled) continue;

		emitter.Enabled = true;
		task.defer(() => (emitter.Enabled = false));
	}

	for (const emitter of emitters) emitter.Emit(EMIT_COUNT);

	playing.set(body, clone);

	// **`Debris` rather than a `task.delay` and a `Destroy`** — one part per hit, the timer is the engine's,
	// and a pooled effect would be machinery for a thing that happens a handful of times a round.
	Debris.AddItem(clone, EFFECT_LIFETIME_SECONDS);

	// **The requested line, with the emitter count appended for the sibling's reason**: "found the template
	// and fired nothing" and "fired a burst that cannot be seen" are the same line without it.
	logDebug(`[VFX] ${line} on ${ANCHOR_PART} — ${emitters.size()} emitter(s) x ${EMIT_COUNT}`);
}

/**
 * The template, found by name in `ReplicatedStorage`, **as a `Model`, a `BasePart`, or an emitter the name
 * was put on instead.**
 *
 * **The name may sit on either end of the same thing**, and that is not a guess: it is what the place file
 * did for the catch effect, where `CatchShockwave` turned out to be the `ParticleEmitter` one level inside
 * the carrier. A person names the thing that matters, and the thing that matters is the emitter; the part
 * under it goes on being called `Part`. So the name resolves the carrier *or* the emitter, and both come
 * back as the carrier to clone. **The walk upward lives in `carrierOf` and stops at the nearest `BasePart`
 * or `Model`** — the smallest thing that carries the effect, rather than `vfx-assets` or all of
 * `ReplicatedStorage`.
 *
 * **Still not "anything by that name".** A `Folder`, an `Attachment` or a `Sound` called `HitAttacker` is
 * not a template, and returning one would push the failure down to "no parts to weld", where it is harder
 * to read. **A walk rather than a path**, for the reason the sibling states: where the template sits is a
 * thing a person moves.
 */
function findTemplate(name: string): Model | BasePart | undefined {
	for (const descendant of ReplicatedStorage.GetDescendants()) {
		if (descendant.Name !== name) continue;
		if (descendant.IsA("Model") || descendant.IsA("BasePart")) return descendant;
		if (descendant.IsA("ParticleEmitter")) return carrierOf(descendant);
	}

	return undefined;
}

/**
 * What to clone when the name is on an emitter: **the nearest thing above it that can be welded to a body.**
 *
 * **Upward and stopping at the first part**, because a `Model` above the carrier is somebody tidying their
 * `ReplicatedStorage` rather than a second thing to place — climbing to it would drag whatever else that
 * model holds along with every hit. A `Model` is still accepted when there is no part between it and the
 * emitter, which is the other shape a person can build. **Stops at `ReplicatedStorage`**, so a template
 * that is not below a part at all resolves to nothing and gets reported rather than to something enormous.
 *
 * **The `Part` → `Attachment` → `ParticleEmitter` chain is carried through unchanged**: an attachment has
 * no frame of its own in the world, it is a place *inside* a part, so cloning the part brings it and the
 * emitter along and keeps the position the author gave them. That position is the placement knob in
 * Studio — this file writes the carrier's frame and nothing else.
 */
function carrierOf(emitter: ParticleEmitter): Model | BasePart | undefined {
	let node = emitter.Parent;
	while (node !== undefined && node !== ReplicatedStorage) {
		if (node.IsA("BasePart")) return node;
		if (node.IsA("Model")) return node;

		node = node.Parent;
	}

	return undefined;
}

/**
 * Every part of the cloned template, **the clone itself included if it is one.**
 *
 * **`GetDescendants` does not include the instance it was called on**, which is a hole the sibling fell
 * into: a template that *is* the carrier part has no part among its descendants at all, so the anchor came
 * out `undefined` and the effect returned without welding anything. The part is asked for first.
 */
function templateParts(clone: Instance): BasePart[] {
	const parts: BasePart[] = [];
	if (clone.IsA("BasePart")) parts.push(clone);

	for (const descendant of clone.GetDescendants()) {
		if (descendant.IsA("BasePart")) parts.push(descendant);
	}

	return parts;
}

/** Every emitter in the cloned template, **by class and in tree order.** */
function templateEmitters(clone: Instance): ParticleEmitter[] {
	const emitters: ParticleEmitter[] = [];
	for (const descendant of clone.GetDescendants()) {
		if (descendant.IsA("ParticleEmitter")) emitters.push(descendant);
	}

	return emitters;
}

/**
 * One emitter's authored state as a line of prose — **the properties that decide whether a correct `Emit`
 * produces anything a person can see.** `Rate` and `Lifetime` first, then `Size` and `Transparency`: a
 * particle with no size or full transparency is emitted, travels, expires and is never drawn, which from a
 * seat in Studio looks exactly like an effect that never ran.
 *
 * **`TimeScale` and `Brightness` are deliberately absent** — they change how the effect looks rather than
 * whether it exists, and a line that reports everything is a line nobody reads.
 */
function describeEmitter(emitter: ParticleEmitter): string {
	return (
		`enabled ${emitter.Enabled}, rate ${emitter.Rate}, ` +
		`lifetime ${rangeText(emitter.Lifetime)}, speed ${rangeText(emitter.Speed)}, ` +
		`size ${sequenceText(emitter.Size)}, transparency ${sequenceText(emitter.Transparency)}`
	);
}

/** A `NumberRange` as `3` when it is a single value and `3-5` when it is a spread between two. */
function rangeText(range: NumberRange): string {
	return range.Min === range.Max ? `${range.Min}` : `${range.Min}-${range.Max}`;
}

/**
 * A `NumberSequence` as **its two ends** — `0.5→2` — because the middle is the shape of the effect and the
 * ends are whether it exists at all. `Size` and `Transparency` are sequences over each particle's life, so
 * a particle that fades from invisible to visible has two ends that differ while one that is zero at both
 * ends never draws.
 */
function sequenceText(sequence: NumberSequence): string {
	const keys = sequence.Keypoints;
	if (keys.isEmpty()) return "empty";

	const first = keys[0].Value;
	const last = keys[keys.size() - 1].Value;

	return first === last ? `${first}` : `${first}→${last}`;
}

/** How many near-miss names `nearMissReport` lists before it stops looking. Enough to see the answer. */
const MAX_NEAR_MISSES = 8;

/**
 * What this client can see that might be one of the two templates, as lines for the log.
 *
 * **The one thing a failed lookup cannot tell you is which failure it was.** "No `HitAttacker`" is true of
 * a template nobody made, one spelled `HitAttacker1`, and one dragged into `Workspace` by mistake — and the
 * same line reports all three. So this says what is actually there: the direct children of
 * `ReplicatedStorage`, and every instance in the client's whole view whose name contains `hit`. **Only
 * what a client can see**: `ServerStorage` and `ServerScriptService` do not replicate, so a template in
 * either cannot be found from here, and the first line says so rather than leaving that to be concluded.
 *
 * **Called once per template name, from the missing-template branch** — which is the only thing that makes
 * a walk this wide acceptable. It is a string compare against every instance the client holds.
 *
 * **`hit` as the token rather than the full name**, because the two templates differ in their second half:
 * a misspelt `HitAttaker` still contains it, which is the case a partial match on the full name would miss.
 */
function nearMissReport(): string[] {
	const lines: string[] = [
		"what this client can see — ServerStorage and ServerScriptService do not replicate, so a template in either cannot be found from here:",
	];

	const top: string[] = [];
	for (const child of ReplicatedStorage.GetChildren()) top.push(`${child.Name} (${child.ClassName})`);
	lines.push(`ReplicatedStorage: ${top.isEmpty() ? "empty" : top.join(", ")}`);

	const matches: string[] = [];
	for (const descendant of game.GetDescendants()) {
		const [found] = string.find(string.lower(descendant.Name), "hit");
		if (found === undefined) continue;

		matches.push(`${descendant.GetFullName()} (${descendant.ClassName})`);
		if (matches.size() >= MAX_NEAR_MISSES) break;
	}

	lines.push(
		matches.isEmpty()
			? "nothing anywhere in the client's view has 'hit' in its name"
			: `close names: ${matches.join(", ")}`,
	);

	return lines;
}

/**
 * The template for the hit the **local player landed** — gold, drawn on the victim's body. **Placeholder
 * name**, and the whole of the contract with the place file: see the module doc.
 */
const ATTACKER_TEMPLATE_NAME = "HitAttacker";

/** The template for the hit the **local player took** — red, drawn on their own body. See {@link ATTACKER_TEMPLATE_NAME}. */
const VICTIM_TEMPLATE_NAME = "HitVictim";

/**
 * The part on the body the effect is welded to. **`HumanoidRootPart`, one constant, matching the catch
 * effect** — so the two effects sit at the same point on a body and a reader comparing them is not
 * comparing two placements.
 *
 * **`Head` is the alternative and it is a look decision rather than a better one.** The root is the body's
 * centre and holds still; the head is what the animation and the aim turn, so an effect there moves with
 * the flourish. Changing this line is the whole of that decision, and it changes both colours at once.
 */
const ANCHOR_PART = "HumanoidRootPart";

/**
 * How many particles each emitter in a template is asked for, per hit. **Placeholder — 30, matching the
 * catch shockwave.**
 *
 * **Matching rather than chosen.** The two are the same kind of beat — a body was involved with a ball, and
 * it should feel like one — so a hit arriving with half a catch's particles would read as a weaker version
 * of the same thing. It is per *emitter*, as there: a template with two emitters fires sixty for this
 * number. The argument for a burst rather than a stream is the sibling's and is not repeated here.
 */
const EMIT_COUNT = 30;

/**
 * The name and the size of the part this file makes when a template has none — see `playOn`.
 *
 * **`Carrier`, and named at all so that a clone found in `Workspace` is readable**: this part appears in the
 * tree for the length of {@link EFFECT_LIFETIME_SECONDS}, and a part called `Part` next to a body is a part
 * nobody can account for a second later.
 *
 * **A twentieth of a stud, which is a size chosen to be irrelevant rather than small.** It is not the size
 * of the effect — the particles come from the emitters, at an attachment, and the carrier's own extent never
 * reaches the screen (it is fully transparent and cannot collide, be touched or be queried). What the number
 * has to be is *not large*: a point is being given a `BasePart` so it can be welded, and anything bigger
 * would be a shape near a body that does nothing. **Placeholder.**
 */
const CARRIER_NAME = "Carrier";
const CARRIER_SIZE = 0.05;

/**
 * How long a clone is left in the world before `Debris` takes it, in seconds. **Placeholder — 0.9.**
 *
 * **The catch effect's number does not transfer, and this is the difference.** That one is timed to the
 * catch *animation* — `CATCH_ANIMATION_SECONDS` plus a `0.4` margin — so the effect cannot outlive the pose
 * it belongs to. **A hit has no pose**: nothing in the animation table is drawn for one, so there is no
 * window to match and this number is only how long the carrier must outlive the particles it fired.
 *
 * **0.9 is that guessed at**: about half a second of particle life for an impact flash, plus the same `0.4`
 * margin the sibling uses — borrowed deliberately, because "longer than any one particle's fade" is the
 * same requirement here. The two ways to be wrong are not symmetric: too short cuts a fade that is still
 * drawing, too long leaves an invisible carrier welded to a body for longer than the effect exists.
 * **The emitter's own `Lifetime` is the real answer** and this only has to be above it.
 */
const EFFECT_LIFETIME_SECONDS = 0.9;

/**
 * The clone playing on each body, so a second hit can end the last one first.
 *
 * **Keyed on the body**, because the question is "is this body already wearing one" — and a body can be hit
 * twice inside this effect's lifetime, which must *replace* the burst rather than stack a second one on
 * the same spot. **A body can only be the victim here, so one entry per body is enough**: the two colours
 * are drawn on two different bodies (the hitter and the victim of one hit are never the same player —
 * friendly fire is refused before any hit is recorded), so a single client can never want two effects on
 * one body for one hit.
 *
 * Entries are not pruned when `Debris` takes a clone: a body that has left the world is never asked about
 * again, which is the same trade every per-body table in this codebase makes.
 */
const playing = new Map<Model, Instance>();

/** The template names that have already been warned about. **Once each, not once per session** — see `playOn`. */
const warnedTemplates = new Set<string>();

/** The template names whose emitters have already been described. **Once each** — the template does not change. */
const describedTemplates = new Set<string>();

/** The template names this client has already had to give a carrier part to. **Once each per session.** */
const adoptedTemplates = new Set<string>();

/** The body names this client has already failed to draw on. **Once each** — see `warnNoBody` and `playOn`. */
const warnedBodies = new Set<string>();

/**
 * Says, once per name, that a hit arrived for a body this client could not find. **The single most useful line
 * this file can print, and it was a `DEBUG_LOGGING` trace until it was not.**
 *
 * The four ways a hit draws nothing are: the event never reached this client; a name that resolves to no body;
 * a body with no `HumanoidRootPart`; and a template missing from `ReplicatedStorage`. **From the seat they are
 * all the same nothing**, and the first is upstream of this file while the third is a problem with a rig's model
 * — so a report of "rig hits draw no VFX" cannot be answered without separating them. Only the missing template
 * was ever warned about, because it was the one that had been hit before.
 *
 * **Once per name rather than once per hit**, unlike the template warning's every-time print: a template can be
 * added to the place file mid-session, so its warning is worth repeating, while a name that resolves to no body
 * is usually a name that will never resolve — and a warning on every hit in a round would be its own kind of
 * silent. `seat` is in the line because it is the cheapest way to see that the *event* arrived at all: a body
 * this client cannot find as the attacker is a different fault from the same body unfound as a bystander.
 *
 * **The id is on the line too, and it is what tells the duplicate-name case apart from a missing body.** "No
 * body by that name" and "seven bodies by that name and the id matched none of them" are different faults with
 * different fixes — the first is a body this client cannot see, the second is a body that was destroyed between
 * the hit and this line — and `""` says the payload predated the field at all, which is a third.
 */
function warnNoBody(seat: string, name: string, id: string): void {
	if (warnedBodies.has(name)) return;

	warnedBodies.add(name);
	logWarn(
		`[VFX] ${name}: hit seen as the ${seat}, but no body by that name — no player, no ${NPC_TAG} rig, ` +
			`and nothing carrying a Humanoid in Workspace (id ${id === "" ? "was not sent" : `"${id}"`})`,
	);
}
