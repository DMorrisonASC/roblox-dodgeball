import { OnStart } from "@flamework/core";
import { BaseComponent, Component } from "@flamework/components";
import { Players, Workspace } from "@rbxts/services";
import { abilityOn } from "shared/ability";
import { CollisionIgnore } from "shared/CollisionIgnore";
import { BALL_NAME, THROWER_TOKEN } from "shared/constants";
import { BALL_CONFIG } from "shared/config/ball.config";
import { CATCH_CONFIG } from "shared/config/catch.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { SOUND_CONFIG } from "shared/config/sound.config";
import { BallService } from "../services/ball/BallService";
import { emitSound } from "../services/ball/SoundEmitter";
import { CatchService } from "../services/actions/CatchService";
import { RoundService } from "../services/round/RoundService";
import { StatsService } from "../services/stats/StatsService";
import { SuperService } from "../services/super/SuperService";

/**
 * The tag every dodgeball carries — **the same string as this component's own `tag: "Ball"`, which
 * is what puts this component on a ball at all.**
 *
 * Copied rather than shared for the reason the name is copied in `BallFactory`, `BallService` and
 * `BallPickupService`: the decorator's argument has to be a literal where Flamework's transformer
 * can read it, so the one place this cannot live is a shared constant. Written down here because
 * {@link isBall} has to recognise a ball *without* asking for its component — a part reported to
 * `Touched` may have no component on it at all, or one that has not started yet.
 */
const BALL_TAG = "Ball";

/**
 * Whether `instance` is a dodgeball.
 *
 * **Both the tag and the name, because each answers a question the other cannot.** The tag is what
 * carries {@link BallComponent}, and `BallFactory.finish` puts it on every ball the game makes; the
 * name is what a ball is called in the log. A part with one and not the other is something assembled
 * by hand, and calling that a ball is the safe direction to be wrong in — it costs a throw, where
 * the other direction costs a body.
 *
 * **A ball inside a character is answered by this too, and that is the point.** A ball welded into
 * somebody's hand sits at the centre of the silhouette a throw is aimed at, so it is decided by the
 * same guard as any other ball rather than being left to the body branch — where `struckBodyPart`
 * would drop the contact and let the throw carry on. See {@link BallComponent.handleTouch}.
 */
function isBall(instance: Instance): boolean {
	return instance.HasTag(BALL_TAG) || instance.Name === BALL_NAME;
}

interface BallAttributes {
	/**
	 * Whether this ball is a live throw: in flight, or carrying bodies it has hit but not yet
	 * resolved.
	 *
	 * **True through a body, and false the moment the ball touches the world.** That is the rule a
	 * catch exists to serve: a hit's fate is not decided at the hit but at the ball's death, so the
	 * ball has to *stay* armed — still carrying the throw, still carrying its tags — until it hits
	 * something that is not a body. A body does not end a throw; the floor, a wall, or a prop, does.
	 * So does another ball, but only once this throw has somebody on it — see
	 * {@link BallComponent.handleTouch}, which is where that condition is decided. Disarming on a
	 * body would abandon the tags before they resolved, and a ball nobody had been told was dead
	 * would sit in the world with deaths still owed.
	 */
	Armed: Boolean;

	/**
	 * Whether this throw has already been scored. See {@link BallComponent.score}.
	 *
	 * On the ball rather than in here, because it is cleared by the same `Armed` transition that
	 * clears {@link BallComponent.hitModels} — the ball's own state, kept with the ball's own state.
	 */
	StatsRecorded: Boolean;
}

/** What an uncaught hit does. Lethal on purpose — a hit ends the round. */
const HIT_DAMAGE = 1000;

/**
 * How slow a ball may be and still be worth bouncing off somebody, in studs per second.
 *
 * A ball that arrived this slowly has no throw left in it to reflect, and reflecting a
 * near-zero velocity about a near-zero direction scatters it somewhere arbitrary — the one
 * thing a bounce must never be.
 */
const BOUNCE_MIN_SPEED = 1;

/**
 * How far a ball must be from the part it touched for the line between them to mean
 * anything, in studs.
 *
 * Below this the direction is float noise and the bounce is a coin toss.
 */
const BOUNCE_MIN_SEPARATION = 0.01;

/**
 * What an impact sound's emitter is called.
 *
 * Named because the emitter is a bare part in `Workspace` with nothing else to distinguish it:
 * invisible, tiny, and parented to the world at large rather than to anything that says what it is.
 * The way to check that none has been left behind is to search for one name, and that check is the
 * acceptance test for this whole arrangement — which is why the name lives per *event* rather than a
 * single name shared by every sound in the game. A catch names its emitter something else
 * (`CATCH_EMITTER_NAME`, in `BallService`), so that "no impact emitters remain" is a statement about
 * impacts. One per impact, each gone when its clip ends, so this is a name to grep for rather than a
 * taxonomy.
 *
 * The emitter itself is built by {@link emitSound}, which is shared with the catch sound and takes
 * this name as an argument.
 */
const IMPACT_EMITTER_NAME = "ImpactEmitter";

/**
 * The next number {@link BallComponent.identity} will take.
 *
 * **A counter, because nothing else on a ball distinguishes it.** Every ball in the game is named
 * `DodgeballBall`, so the name identifies nothing, and a clock is the wrong shape for this: `os.clock`
 * counts CPU time, which this codebase has already been caught by once — see the note in
 * `ThrowProbe.ts` about a stopwatch error that read as a physics fault — and `os.time` is whole
 * seconds, so two balls handed out inside the same second would share a number and the log would be
 * ambiguous again. A counter cannot collide, and an ordinal reads better in a log than a timestamp.
 */
let ballSequence = 0;

@Component({
	tag: "Ball",
	defaults: { Armed: false, StatsRecorded: false },
})
export class BallComponent extends BaseComponent<BallAttributes, BasePart> implements OnStart {
	/**
	 * Every body this ball has tagged on this throw, keyed on the model and holding the body part
	 * that decided the contact.
	 *
	 * **A tag list, not a hit list — that is the whole of this change.** Nothing in it is a death.
	 * The models in it have been struck, and their fate is still in the air: it resolves when the
	 * ball dies (on a world contact) and is released when the ball is caught. What the map buys is
	 * both halves of that future in one place — the model to resolve, and the part that was struck,
	 * kept so a deferred death can still say *where* the ball landed rather than only that it did.
	 *
	 * The key is what stops one throw taking the same body twice: the first part to arrive wins, and
	 * every part the engine reports after it is refused here.
	 *
	 * On the instance rather than on the ball as an attribute, because an attribute holds
	 * primitives and this holds models.
	 */
	private readonly hitModels = new Map<Model, BasePart>();

	/**
	 * Which ball this is, for the log — assigned the moment the ball is armed.
	 *
	 * **Every ball is named `DodgeballBall`, so a `logTouch` line without this cannot say which of
	 * them it came from** — and that is the entire question when a touch turns up that the ball could
	 * not physically have made. Attribution is the only thing this number is for; nothing decides
	 * anything with it, and it is never cleaned up, because the ball it describes goes away with it.
	 *
	 * **In practice it is an id per ball, not per throw.** `BallService` arms a ball on a hand-out and
	 * `throwBall` arms it again, but an attribute set to the value it already holds fires no signal —
	 * so {@link BallComponent.onStart}'s handler runs once, on the hand-out, and the id from that
	 * hand-out is the one the throw and the whole flight are reported under. It only moves on after a
	 * real disarm (a drop, or a pickup that makes the ball inert again), which is a genuinely
	 * different handing and worth a different number.
	 *
	 * 0 means the ball was never seen armed, which should not happen while anything prints.
	 */
	private identity = 0;

	constructor(
		private readonly catches: CatchService,
		private readonly balls: BallService,
		private readonly stats: StatsService,
		private readonly rounds: RoundService,
		private readonly abilities: SuperService,
	) {
		super();
	}

	public onStart(): void {
		this.instance.Touched.Connect((otherPart) => {
			this.logTouch(otherPart);
			this.handleTouch(otherPart);
		});

		// **The one case this file is otherwise silent about: a ball destroyed while it still owes a
		// death.** A ball that tags a body and never touches the world — wedged on something, or
		// simply never coming down — is destroyed with its tags unresolved, and until this line there
		// was nothing anywhere in the output to say so. From a player's seat that produces exactly
		// "the enemy didn't die and the round didn't end", which is the failure this hook exists to
		// tell apart from an intermission that is stuck.
		//
		// **On the component rather than in the expiry, and that is forced rather than chosen.** The
		// tag count lives here; the expiry is a free function in `ballExpiry.ts` that has never heard
		// of a component and cannot see one. So the destruction is hooked where the count is, which
		// also makes this the *superset*: every way a ball can be destroyed comes through here, not
		// only the timer — and for a diagnostic that is the right side to err on. The line names what
		// it knows and does not claim which of them it was.
		//
		// Ungated, unlike almost everything else here: it fires at most once per ball, and it firing
		// at all is the finding.
		this.instance.Destroying.Connect(() => {
			if (this.instance.GetAttribute("Armed") !== true) return;
			if (this.hitModels.size() === 0) return;

			print(
				`[Ball] ${this.instance.Name} #${this.identity}: destroyed still armed with ` +
					`${this.hitModels.size()} unresolved tag(s) — nobody was resolved`,
			);
		});

		// **The start of a throw, and the only moment this ball's memory is emptied.**
		//
		// `Armed` going *on* is the ball being released: `BallService` arms it in `throwBall`,
		// and again on a hand-out. That is precisely "a new throw", so the tag list is empty for
		// it by construction — which is what keeps one throw's tags from leaking into the next,
		// and what lets a ball taken off the floor tag the same players all over again.
		//
		// Nothing has to empty it while the ball is merely *held*, and that is why this is
		// not hooked to the hand instead: a ball in somebody's hand cannot damage anybody, so
		// a list sitting in it is unreadable, and the throw that follows clears it anyway.
		//
		// Keeping it here rather than having `BallService` call in also keeps the ball's own
		// state in the ball: no service has to know a tag list exists, or reach into a
		// component to reset one.
		this.instance.GetAttributeChangedSignal("Armed").Connect(() => {
			if (this.instance.GetAttribute("Armed") !== true) return;

			// **A tag thrown away, said out loud, because this is the one way it can happen in
			// silence.** The clear below is right — a new throw owes nothing — but reaching it with a
			// non-empty list means a body was tagged on an earlier throw and never resolved, and that
			// body is now safe for good. Nothing else in the file can report it: the ball was not
			// destroyed (so `Destroying` stays silent), it did not die on the world (so `resolveTags`
			// never ran), and it was not caught (so `resolveCatch` never ran). Ungated on the
			// `Destroying` hook's terms — it fires only when there is something to report, and it
			// firing at all is the finding.
			if (this.hitModels.size() > 0) {
				print(
					`[Ball] ${this.instance.Name} #${this.identity}: re-armed holding ` +
						`${this.hitModels.size()} unresolved tag(s) — nobody will be resolved`,
				);
			}

			// A new number to be reported under, taken at the same moment as everything else here
			// and for the same reason: `Armed` going on is a new throw. See {@link identity} for why
			// this usually happens once per ball rather than once per throw.
			ballSequence += 1;
			this.identity = ballSequence;

			this.hitModels.clear();

			// And the throw is unscored again, for the same reason and at the same moment: `Armed`
			// going on *is* a new throw, and a new throw gets its own one contact. See {@link score}.
			this.instance.SetAttribute("StatsRecorded", false);
		});
	}

	/**
	 * What a touch means: a catch, a tag, or the death of the whole throw.
	 *
	 * The catcher is taken from the part's ancestry rather than from the players
	 * list. An NPC is a humanoid model like any other and has no `Player` behind
	 * it, so anything that asks "is this a player?" leaves NPCs unable to do what a
	 * player can.
	 *
	 * **A body does not decide anything — it is tagged, and the world ends the throw.** A hit's
	 * fate is not settled at the hit: real dodgeball lets a catch save the hit player, so a body
	 * the ball touches is *tagged* and nothing happens to it yet. The ball goes on flying, still
	 * armed, still carrying every tag — off the body it struck, unless the ball is a **Pierce** ball,
	 * which goes through it and on to the next one. See the tag branch below for what that difference
	 * takes, and why it is more than declining a bounce. It is the next contact that is not a body —
	 * the floor, a wall, a prop — that ends the throw and resolves every tag into a death. See
	 * {@link resolveTags}. And a catch before that moment releases every tag and never resolves a
	 * one: see {@link resolveCatch}.
	 *
	 * **Another ball is the third kind of contact, and which of the two it is depends on what the
	 * throw already owes.** A throw that has landed on nobody treats a ball as scenery and carries
	 * on, so it still reaches the body standing behind it. A throw that has already tagged somebody
	 * is ended by the next ball it touches, exactly as the floor would end it. See the guard at the
	 * top of this method, which is where both halves of that live.
	 */
	private handleTouch(otherPart: BasePart): void {
		// Spent already: a landing or a wall has taken this ball out of play — its tags were
		// resolved there, or there were none — and nothing below can put it back.
		if (this.instance.GetAttribute("Armed") !== true) return;

		// **Another dodgeball is the world only when this throw already owes somebody a death — and
		// that condition is the third version of this rule, reached by finding out what the first two
		// got wrong.**
		//
		// A ball in the world is a `BasePart` parented to `Workspace`, so nothing above it is a
		// `Model`. The first version treated that as a world contact outright, which ends the throw on
		// the first ball it meets. The second ignored ball contacts altogether, so a ball could never
		// spend a throw. **Both are right in one arrival and wrong in the other**, because the engine
		// reports an arrival as an unordered overlap set rather than a sequence — and a hand-held ball
		// sits in front of the chest, so a throw into a torso meets both:
		//
		// - **Body first, then a ball** — the body is tagged, and under the second version that tag sat
		//   waiting for the ball to come down. Whether it ever did is wherever the ball happened to
		//   roll, so a hit that visibly landed left the body standing.
		// - **Ball first, then the body** — and under the first version the throw was over before it
		//   touched anybody. Nothing was tagged, so nothing died, and aiming at the torso of anybody
		//   carrying a ball did nothing at all.
		//
		// **So the rule is conditional, and the condition is what the throw already owes.** A throw
		// that has landed on nobody treats a ball as scenery and carries on: the ball is an obstacle
		// the thrower never chose, and spending a throw on one before it reaches anybody spends it on
		// nothing. A throw that has landed on somebody is *finished* by the next ball it touches, which
		// resolves the tag there and then instead of leaving it hostage to where the ball finally comes
		// to rest. **Both orders then end the same way, and both end in a death.**
		//
		// The guard sits above the ancestry lookup rather than in the world branch below, and that is
		// load-bearing: a ball in somebody's hand has a `Model` above it, so it would otherwise be
		// answered as a body contact, dropped by `struckBodyPart`, and leave the throw carrying on
		// exactly as the second version did.
		if (isBall(otherPart) && this.hitModels.size() === 0) {
			this.noteDecidedNothing(otherPart, "a ball, and this throw owes nobody — carried on past it");
			return;
		}

		const character = otherPart.FindFirstAncestorWhichIsA("Model");
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");

		// Not a character — or a ball, which reaches here only when this throw already has somebody on
		// it, and is then the throw's death like any wall. See the guard above for the whole rule.
		if (!character || !humanoid || isBall(otherPart)) {
			// **This is where every tagged body meets its fate, and it is the only place it could.**
			// The ball has stayed armed through every body it hit — see {@link BallAttributes.Armed}
			// for why — so "the ball stopped being armed" and "the tagged bodies are resolved" are the
			// same event, and this branch is it. A catch would have released them earlier and returned
			// above; reaching this line means nobody saved them.
			//
			// **The sound goes first, by the same rule as before.** Everything in this branch is an
			// account of one event — the ball arrived somewhere — so it runs in the order it
			// happened: heard, then resolved, then taken out of play. It plays for every world
			// contact rather than only for throws that wound up missing on purpose, because this *is*
			// the end of the throw: a ball that lands on the floor is the only evidence a player gets
			// that a throw is over, short of watching it all the way down.
			this.playImpactSound(otherPart, SOUND_CONFIG.WORLD_HIT);

			// **The end of a throw, and it was invisible until now.** This branch is the death of
			// every throw that does not end in a catch, and it used to leave no trace at all: the
			// sound is the only thing it announces, and the one line `emitSound` prints is behind
			// {@link DEBUG_CONFIG.VERBOSE_LOGS}, which is off by default and turns on a per-frame aim
			// report with it. So a throw that landed on the floor and a throw that was never fired
			// produced the same log — nothing — and that is the *first* question anybody asks of a hit
			// that did not register: did the ball arrive at all, and where.
			//
			// Named by part and counted, because the two facts are the answer: a landing short of the
			// body is an aim or a range problem, and one that arrived with nobody tagged is a contact
			// problem. The tag lines and this one are read against each other, which is why this is
			// ungated on `landHit`'s terms — a diagnostic that has to be switched on cannot explain a
			// log captured without it.
			//
			// **Exactly one line per throw, and the disarm below is what guarantees that.** `Armed`
			// goes off on the line after this, so the second contact of an arrival is refused at the
			// top of `handleTouch` like any other spent ball. A ball that is destroyed while still
			// armed is the one case that ends without this line, and it has its own.
			print(
				`[Ball] ${this.instance.Name} #${this.identity}: ended on ${otherPart.Name} — ` +
					`${this.hitModels.size()} tag(s)`,
			);

			// The thrower is still readable here: the world branch never made the ball inert, so
			// `ThrowerId` is whatever `throwBall` stamped on it. Read once, before the tags resolve,
			// because a resolution turns tags into deaths and a death is credited to this.
			const throwerId = this.instance.GetAttribute("ThrowerId");
			const taggedAny = this.hitModels.size() > 0;
			this.resolveTags(throwerId);
			this.score(taggedAny);

			this.instance.SetAttribute("Armed", false);
			return;
		}

		// **A worn accessory is not a shield: the contact belongs to the body underneath it.**
		//
		// A hat's `Handle` sits inside the accessory, welded to the part it is worn on, and it is a
		// `BasePart` the ball reaches before it reaches anything that counts. Left as its own
		// thing — which is what this did until now — a player can wear something wide enough to
		// spend throws on: the ball is thrown off the accessory, no hit is ever recorded, and
		// whether that works is an asset property nobody in this codebase sets. So a worn part is
		// resolved to the body part it is attached to and handled as a contact with that part,
		// which makes an accessory invisible to the ball instead of armour for it. See
		// {@link struckBodyPart}.
		//
		// **This reverses the rule that used to be here, and the reason it existed is worth
		// keeping.** An earlier version treated an accessory *as itself*: a `Handle` is not in
		// {@link CATCH_CONFIG.CATCHABLE_PARTS}, so a scarf's tassel lying across the chest read as
		// a lethal hit, and the torso contact behind it — the one that would have caught the ball —
		// was then skipped by {@link hitModels}. The reply was to ignore accessory contacts
		// entirely, which fixed the scarf by making the accessory inert and turned it into a shield
		// in the same move. Resolving to the host part is the option neither of those took: the
		// scarf contact becomes an `UpperTorso` contact, which *is* catchable, so that case comes
		// out right for the right reason. What remains is a hat whose mesh reaches further from the
		// head than the head is wide — a glance off a beanie is a head contact, and lethal. That is
		// the price of a hitbox a player cannot shrink by what they choose to wear.
		const struck = this.struckBodyPart(humanoid, otherPart);
		if (!struck) {
			this.noteDecidedNothing(
				otherPart,
				"not a body part, and not traceable to one — nothing to tag",
			);
			return;
		}

		// Nobody is hurt by their own ball, and nobody catches it either — including off
		// the rebound, which is the case that matters now that balls come off people. Both
		// come down to the same string: the token stamped on the ball at release, held
		// against the token on the model it is touching. A player's token is their
		// `UserId` as text and an NPC's is a GUID, and this comparison cannot tell
		// them apart — which is the point. Asking "is this a player?" instead would
		// leave an NPC free to hit itself with its own throw.
		const throwerId = this.instance.GetAttribute("ThrowerId");
		const token = character.GetAttribute(THROWER_TOKEN);
		if (typeIs(throwerId, "string") && throwerId !== "" && throwerId === token) return;

		// **Decided already — or decided by an earlier part of this same arrival.** Either way
		// this body's turn has been taken and the ball passes through it.
		//
		// This is what makes the *first* part final: every part the engine reports after it is
		// refused here. It is also what stops one throw taking the same body twice.
		if (this.hitModels.has(character)) return;

		// **The first body part to arrive decides the whole contact, and nothing later may
		// change its mind.** A catchable part first — a torso or an arm — is a catch; anything
		// else first, the head or a leg, is a hit.
		//
		// Being plain about what that means: this is a rule about the engine's report order.
		// At throw speeds the ball crosses several studs in a frame, so an arrival is not a
		// sequence of hits but one overlap set, reported in whatever order the engine walks it
		// — a ball into the chest is often reported against the head too. If the head comes
		// first, this reads as a hit, and that is the intended rule rather than a slip.
		//
		// The alternative — letting any catchable part anywhere in the set win — takes the head
		// out of the game: a ball aimed at one would be caught by the torso it also touches.
		if (this.canCatch(struck, character)) {
			// Spent before the ball is handed over, so one attempt catches one ball
			// even if two arrive together.
			this.catches.consume(character);

			// Read before the ball changes hands: `catchBall` makes the ball inert, which clears
			// `ThrowerId`, and the catch resolution below is about the thrower the ball *arrived*
			// with rather than whoever is holding it next.
			const throwerId = this.instance.GetAttribute("ThrowerId");

			// A catch that cannot attach (no right hand) is not a catch: `attachToHand` destroys the
			// ball in that case, and nothing below should resolve a throw that is no longer in the
			// air.
			if (this.balls.catchBall(character, this.instance)) {
				this.resolveCatch(character, throwerId);
			}
			return;
		}

		// **Friendly fire is off, and this is the one place that decides it.**
		//
		// A same-side contact is vetoed *entirely* — no bounce, no damage, no death, no record, no
		// points. It is one rule for every mode rather than a mode's own decision, because it is not
		// a rule about how a round is won; it is a rule about what a throw may do to a body at all,
		// and a mode that wanted friendly fire back would be changing the game rather than its own
		// rules. That is why this is here and not in `GameMode`.
		//
		// **Before `landHit`, and therefore before `TakeDamage` — that order is the contract.** The
		// veto has to be able to refuse the contact outright, and a check placed after the damage
		// would be describing a hit that has already happened: a `Died` already fired, the round's
		// hit record already written, and nothing left to take either back. So it sits ahead of the
		// bounce and the damage alike, and a teammate is simply not a body this ball interacts with.
		//
		// A catch is deliberately *not* covered: the catch branch above has already returned, so a
		// teammate may still catch a throw. Catching is a different mechanic from hurting somebody,
		// and this rule is only about hurting them.
		if (typeIs(throwerId, "string") && this.rounds.isFriendlyFire(throwerId, character)) {
			this.noteDecidedNothing(struck, "same side — vetoed, so no damage and no record");
			return;
		}

		// **Heard here, which is after every reason this contact might not be a hit.** A catch returned
		// above, a friendly hit has just returned, and the ball's own thrower and a body it has already
		// been through were refused earlier still — so arriving at this line *is* the hit, and the
		// refusals above stay silent by construction rather than by a second check here.
		//
		// **The head is a limb, so the engine names it rather than this code matching on `"Head"`.**
		// `GetLimb` is what {@link isBodyPart} already asks, and for the reason it gives there: it
		// answers for R6 and R15 alike, and a hand-written name list would have to know both. It is
		// asked of `struck` rather than of `otherPart`, which is what makes the accessories change
		// carry through — a ball that struck a beanie was turned into a head contact by
		// {@link struckBodyPart}, so it is a head hit and sounds like one.
		//
		// `GetLimb` raises for a part that is not a direct child of the rig. Nothing can reach this
		// line without having passed `isBodyPart`, which is the test that established exactly that.
		const isHead = humanoid.GetLimb(struck) === Enum.Limb.Head;
		this.playImpactSound(struck, isHead ? SOUND_CONFIG.HEAD_HIT : SOUND_CONFIG.BODY_HIT);

		// **Tagged, not killed.** The ball has hit this body, and that is the whole of what happens
		// now: the body goes onto the tag list, and the ball carries on. No death, no point, no score —
		// all of those wait for the ball to die, which is the moment a catch can no longer save them.
		// Tagged before it leaves, so that every other part of this same arrival — and every later
		// contact with this body — is a body the ball has already tagged.
		this.hitModels.set(character, struck);

		// **The other half of `landHit`'s line, and the half that was missing.** `landHit` reports a
		// death when the throw resolves; with no line saying a body was *tagged*, a throw that tagged
		// somebody and then never resolved is indistinguishable in the log from a throw that never
		// touched anybody — which is exactly the confusion this pair exists to end. Ungated for
		// `landHit`'s reason and on the same terms: it fires once per tagged body per throw, and the
		// two lines are meant to be read against each other.
		print(`${character.Name} was tagged by ${this.instance.Name} on ${struck.Name}`);

		// **An ordinary ball comes off the body it hit; a Pierce ball goes through it.**
		//
		// **Declining `bounceOff` is not enough on its own, and that is the whole physics of this
		// ability.** A thrown ball is `CanCollide = true` and sits in the `Default` collision group
		// (`BallService.throwBall` sets the flag; nothing ever moves a ball out of the group), every
		// character is put into `Character`, and `Character` against `Default` is left at the engine's
		// default, which is *collides*. So the engine is deflecting the ball off this body whatever this
		// file does with velocities: `bounceOff` is an addition **on top of** a live contact rather than
		// the contact itself. `CollisionIgnore` is what takes the contact away — one
		// `NoCollisionConstraint` per part of this body, parented to the ball, so they die with the ball
		// *instance* and nothing has to be undone here. That file's own doc describes the job as exactly
		// this: solid against the world and everyone else, passing through the thing it was aimed at.
		//
		// **The lifetime is the ball and not the throw, and that is a known rough edge rather than an
		// oversight — the prompt asked for "the rest of the flight" and this gives longer.** A ball that
		// lands is not destroyed: it lies there until it expires or somebody collects it, so these
		// constraints outlast the flight that needed them, and `attachToHand` does not remove them (it
		// clears the *ability* on the ball, which is a different thing). Pick a spent Pierce ball up and
		// throw it again and it is an ordinary ball that is still intangible to the one player it went
		// through — and whether that also means it never *tags* them again depends on whether a
		// `NoCollisionConstraint` suppresses `Touched` as well as the contact, which is engine behaviour
		// this file cannot read out of the typings. The fix, if this matters, is to keep the handles
		// `CollisionIgnore.between` returns and destroy them where `hitModels` is cleared — one array and
		// one line — rather than to change anything about the branch below.
		//
		// **Against this body, and this is a backstop rather than the rule.** The set-up that matters
		// happened at the throw, against every body in the world — see `BallService.throwBall` — so this
		// line is redundant and is kept only while that arrangement is being verified.
		//
		// **What it is *not* is where the teammate rule lives.** With every body constrained at the throw,
		// a teammate is a body a Pierce ball no longer collides with either — that is the rule now:
		// nothing alive stops a Pierce ball, so a teammate who wanders into the line cannot cancel
		// somebody's ability. A teammate is still not *hurt* by one: the friendly-fire veto returned above
		// this line, so there is no tag and no damage. That veto is about what a contact is *allowed to
		// do*, and this is about the ball's path — two rules that used to look like one.
		//
		// Not against the world, here or there: the wall still has to stop the ball, and the floor is what
		// ends the throw and resolves every tag.
		//
		// **What this deliberately does not do is fix the aim guide, and the gap is named here so that
		// nobody has to rediscover it.** `ThrowController` draws its arc from a `Trajectory`, which
		// breaks on the first thing its raycast finds and does not ignore other characters — so for a
		// Pierce ball the preview stops at the first body the real ball will pass straight through, and
		// the *target highlight* follows the same stopped arc. The preview lies about Pierce, and it is
		// known to. That fix belongs in `Trajectory` rather than here, because the guide is a
		// client-side simulation and this is the server's contact, and it is deferred to its own pass
		// rather than forgotten. **Do not "correct" this branch to make the picture agree with itself.**
		if (abilityOn(this.instance) === "Pierce") {
			CollisionIgnore.between(this.instance, character);
		} else {
			this.bounceOff(struck);
		}
	}

	/**
	 * Counts this throw as a hit, once, at the ball's death — if it landed on anybody.
	 *
	 * **One throw, at most one entry — whether any body was tagged when the ball died decides it,
	 * and nothing later may change its mind.** That is not a tidiness rule, it is what makes the
	 * number mean what it says:
	 *
	 * - A single landing reports *every* part the ball overlaps, so without this a ball rolling to a
	 *   stop would be a dozen hits.
	 * - A ball that tagged three players and then hit the floor is one hit, not three. The throw
	 *   landed on somebody; where it came to rest afterwards is not a second throw.
	 * - A ball that is caught is counted nowhere: the catch returns before the ball dies, so nothing
	 *   reaches here. The caught thrower's death is not this figure either — that is an out, and it
	 *   is counted by the round, which is the only thing that knows an elimination happened.
	 *
	 * **Nothing is counted when nothing was tagged, and that is the rule rather than an omission.**
	 * The record is hits against outs — outcomes, not throws — so a throw that lands on the floor is
	 * a throw with no entry, and there is no such figure as a miss to add one to. The flag below is
	 * still written either way: it means "this throw's accounting is done", which is worth being able
	 * to say whether or not the answer was a hit.
	 *
	 * **Taken at the death, not at the hit**, because a hit is no longer final — a catch can still
	 * take it back. `StatsRecorded` is cleared by the same `Armed` transition that clears the tag
	 * list, so a ball picked up and thrown again is scored all over again.
	 *
	 * The token is the ball's own `ThrowerId`, which is the only thing it knows about who threw it.
	 * Whether that names a person at all is `StatsService`'s question — a rig's token is a GUID and
	 * falls out there, which is what keeps NPCs out of the record.
	 */
	private score(taggedAny: boolean): void {
		if (this.instance.GetAttribute("StatsRecorded") === true) return;

		this.instance.SetAttribute("StatsRecorded", true);

		// **A throw that tagged nobody is a miss, and this branch is the only place that knows it.** The
		// ball has died on the world carrying no tags, which is exactly the event a run of hits is broken
		// by — so the notification sits above the return rather than beside the hit below it, because
		// nothing after the return runs. Reported by *token* and not resolved to a player here: the token
		// is all the ball carries, and whether it names a person is `SuperService`'s question in the same
		// way it is `StatsService`'s.
		//
		// **Nothing else in this method's stop is a miss.** A caught throw never reaches here at all —
		// the catch branch returns long before this — so a throw that was caught is neither a hit nor a
		// miss, and a run survives it. That is the same reading the hit side gives it: a catch saves
		// everybody the ball had tagged, and it saves the thrower's run too.
		if (!taggedAny) {
			this.abilities.noteMiss(this.instance.GetAttribute("ThrowerId"));

			return;
		}

		const throwerToken = this.instance.GetAttribute("ThrowerId");
		if (!typeIs(throwerToken, "string") || throwerToken === "") return;

		this.stats.recordHit(throwerToken);

		// **The same fact, told to the thing that counts runs.** A second *reader* of one hit rather than
		// a second hit-detection path: the detection is the tag list, both notifications are driven by it,
		// and neither owns it. `StatsService` keeps a career total and `SuperService` keeps a run in a row
		// — different questions about one event, which is why they are handed the same token rather than
		// one being worked out from the other.
		this.abilities.noteHit(throwerToken);
	}

	/**
	 * Throws the ball off a body it has just hit.
	 *
	 * **Not the engine's elasticity.** That acts off everything at a strength decided by
	 * the two materials meeting, so it cannot be told "spring off people, thud off walls" —
	 * a bouncy ball bounces off the floor and the walls too, which is the opposite of what
	 * the rest of this game wants. This is the same reflection done by hand, for bodies
	 * only, so the bounce has one strength and the rest of the world stays as dead as it
	 * was.
	 *
	 * The direction is the line from the part that was touched to the ball's own centre,
	 * which is the best stand-in available: `Touched` carries no geometry, and a body is not
	 * a flat wall to take a normal from. What it produces is a **deflection** rather than a
	 * mirror bounce — a ball clipping a shoulder is sent off to one side, and a ball
	 * arriving dead centre comes back the way it came.
	 */
	private bounceOff(otherPart: BasePart): void {
		const velocity = this.instance.AssemblyLinearVelocity;
		if (velocity.Magnitude < BOUNCE_MIN_SPEED) return;

		const separation = this.instance.Position.sub(otherPart.Position);
		if (separation.Magnitude < BOUNCE_MIN_SEPARATION) return;

		const normal = separation.Unit;
		const reflected = velocity.sub(normal.mul(2 * velocity.Dot(normal)));

		this.instance.AssemblyLinearVelocity = reflected.mul(BALL_CONFIG.BOUNCE_FACTOR);
	}

	/**
	 * Takes a tagged character out, and prints which part decided that.
	 *
	 * **Called at the ball's death, not at the hit.** A hit only tags; the death happens when the
	 * ball lands on the world and every tag resolves — see {@link resolveTags} — so this runs then,
	 * once per tagged body, in the order the ball tagged them. Nothing about the *method* changed
	 * with the deferral: it is still "take this humanoid out now", and the damage below still fires
	 * the `Died` that reaches `RoundService.handleDeath`.
	 *
	 * The print is the rule made visible: it says which tagged body is being resolved, on which
	 * part, at the moment it happens. The tag itself was silent, and this line is where the throw's
	 * outcome becomes a fact instead of a possibility.
	 */
	private landHit(character: Model, humanoid: Humanoid, part: BasePart): void {
		// Gated where the rest of this file's output is not: this is one line per hit, and it is
		// worth reading only while tuning what a contact is worth.
		if (DEBUG_CONFIG.VERBOSE_LOGS) print(`[Ball] ${character.Name}: hit on ${part.Name}`);
		print(humanoid.Name + " was hit by " + this.instance.Name + " on " + part.Name);
		humanoid.TakeDamage(HIT_DAMAGE);
	}

	/**
	 * Resolves every tagged body into a death, credited to the thrower.
	 *
	 * Called from the world branch, which is the ball's death: this is the moment the tags stop
	 * being possibilities and become the throw's outcome. One death per tagged body, in the order
	 * the ball tagged them, and each death is the same pair a live hit used to run — the round told
	 * about the hit, then the body damaged — in the same order, for the same reason: the damage can
	 * fire `Died` synchronously and take the victim out of the round, so the notification goes
	 * first.
	 *
	 * **A tag whose body is already gone is skipped, not resolved.** A tagged model may have died of
	 * something else while this ball was still in the air — another throw, a reset — and a death
	 * that has already happened cannot be caused a second time. `registerHit` carries the same guard
	 * inside it for the scoring half; the humanoid check here is the damage half of the same rule.
	 *
	 * The list is emptied after the loop rather than during it, so nothing reads a half-resolved
	 * throw.
	 */
	private resolveTags(throwerId: unknown): void {
		// **What question this answers:** whether the ball died on the world at all, and with how
		// many tags owed. `landHit` below already prints one line per body it resolves, so this adds
		// only the count — and, more importantly, the case of *zero*, where the method ran and had
		// nothing to do. A throw that resolves nothing prints this and then no `was hit by` lines,
		// which is a different story from a throw that never reached here.
		if (DEBUG_CONFIG.VERBOSE_LOGS) {
			print(
				`[Ball] ${this.instance.Name} #${this.identity}: died on the world — ` +
					`resolving ${this.hitModels.size()} tag(s)`,
			);
		}

		const token = typeIs(throwerId, "string") ? throwerId : "";

		for (const [model, part] of this.hitModels) {
			const humanoid = model.FindFirstChildWhichIsA("Humanoid");
			if (!humanoid || humanoid.Health <= 0) continue;

			if (token !== "") this.rounds.registerHit(token, model);
			this.landHit(model, humanoid, part);
		}

		this.hitModels.clear();
	}

	/**
	 * Resolves a catch: every tag released, and the thrower punished if the catcher is their enemy.
	 *
	 * **Four jobs, in this order, and the first is the absence of a death.** A catch saves every
	 * body the ball tagged — so the tag list is emptied here rather than resolved, and that
	 * emptying is the whole of the save; nothing fires, and a log of the throw would otherwise show
	 * no trace of it. Then the thrower is out if the catcher is on the other side, and the catcher's
	 * side scores if the mode keeps score — both decided by the round, which owns sides and score,
	 * in one call: see `RoundService.resolveCaughtThrower`. A friendly catch does neither, and a
	 * catch of a rig's throw does neither, for the reasons that method gives. **And last, the
	 * thrower's run of hits ends** — a caught throw is a throw that did not land, which is what a
	 * streak counts, and this is the only place that fact is known. See the call below for why it is
	 * not the redundant line it looks like.
	 *
	 * **A catch that cannot be made never reaches here.** `handleTouch` only calls this after
	 * `catchBall` has taken the ball into the catcher's hand, so the save below is a fact and not a
	 * hope.
	 */
	private resolveCatch(catcher: Model, throwerId: unknown): void {
		// **What question this answers:** whether the ball was caught rather than landing — the third
		// way a throw can end, and the one that resolves nobody *on purpose*. The release below is
		// silent in normal play because silence is the feature: a catch is a save, and the bodies it
		// saves are the ones nothing happens to. Printed before the clear, so the count is the number
		// of tags actually released rather than the zero it leaves behind.
		if (DEBUG_CONFIG.VERBOSE_LOGS) {
			print(
				`[Ball] ${this.instance.Name} #${this.identity}: caught by ${catcher.Name} — ` +
					`releasing ${this.hitModels.size()} tag(s)`,
			);
		}

		this.hitModels.clear();

		const token = typeIs(throwerId, "string") ? throwerId : "";
		if (token !== "") this.rounds.resolveCaughtThrower(token, catcher);

		// **The thrower's run ends here — required in some modes and redundant in others, which is why
		// it needs saying rather than deleting.**
		//
		// A caught throw is a throw that landed on nobody, and that is what a streak counts, so the run
		// goes back to zero. Which mode is being played decides whether anything else would have done it:
		// Team Elimination and Dodge and Seek kill the thrower on a caught throw, so `noteDeath` fires and
		// a streak that is about to be zeroed is zeroed twice; **Score Rush does not** — the catch scores
		// and the thrower respawns — so this line is the only thing that resets their run at all. Deleting
		// it as redundant would quietly turn a caught throw into a streak-*preserving* event in the one
		// mode nobody re-tested.
		//
		// The double call is harmless rather than merely tolerable: `SuperService.resetStreak` returns
		// before publishing when the streak is already zero, so the second call writes nothing at all and
		// the HUD never sees the value move from one call to the next. Both calls also resolve the same
		// token the same way, so they cannot disagree about whose run ended.
		//
		// **The thrower's token and not the catcher's** — the catcher is the one who succeeded, and this is
		// charged to the one who did not. It also sits outside the round's own judgement of the catch: a
		// friendly catch returns early inside `resolveCaughtThrower` and punishes nobody, but a ball caught
		// by a teammate still never landed on an enemy, so the run ends either way.
		if (token !== "") this.abilities.noteMiss(token);
	}

	/**
	 * Whether this touch is a catch: a catchable part, on a character whose window is open.
	 *
	 * **A Pierce ball cannot be caught, and refusing here — before the weld — is the whole of what that
	 * costs.**
	 *
	 * The catch branch is `if (canCatch) { …; return; }`, so answering `false` falls through to the
	 * friendly-fire veto and then to the tag branch: **the catcher is tagged like any other body and
	 * dies when the ball lands.** A Pierce ball is not *harmless* to somebody who tries to catch it; it
	 * is unblockable by them. That is the intent — the answer to a super is to move, not to stand there
	 * with your hands out.
	 *
	 * **The refusal has to sit above the weld rather than after it**, and that is not just tidiness:
	 * `catchBall` runs `attachToHand`, which *clears* the ball's ability so that a ball arriving in a
	 * hand is an ordinary ball again. A catch allowed as far as the hand would therefore erase the very
	 * marker that made it illegal, and the ball would leave the catcher's hand a normal ball — the
	 * ability would have been cancelled by the thing it was supposed to defeat.
	 *
	 * **What is not done on the refusing path is `catches.consume(character)`**, which the catch branch
	 * would have done. That is deliberate: a catcher's window is an attempt, and an attempt that was
	 * never allowed to happen should not be spent — so a Pierce ball does not also leave them unable to
	 * catch the next ordinary one.
	 */
	private canCatch(otherPart: BasePart, character: Model): boolean {
		// **Asked before the part test, not after it**, because this is an answer about the whole
		// contact rather than about one part of it: a Pierce ball is un-catchable by any part, so there
		// is nothing to learn from whether the part it happened to touch first was a catchable one.
		//
		// **Said out loud, because the refusal is otherwise invisible.** A catcher who fails to catch
		// produces the same log as one who never tried, and the two are completely different faults, so
		// this goes through the same ungated helper the friendly-fire veto uses. Its own doc explains
		// why it is not behind a flag: a diagnostic that has to be switched on cannot explain a log that
		// was captured without it.
		if (abilityOn(this.instance) === "Pierce") {
			this.noteDecidedNothing(otherPart, "a Pierce ball — this body cannot catch it");

			return false;
		}

		if (!CATCH_CONFIG.CATCHABLE_PARTS.has(otherPart.Name)) return false;

		// Only a ball in flight can be caught. One welded into somebody's hand is
		// already held, and taking it would leave a ball with two welds on it.
		if (this.instance.Parent !== Workspace) return false;

		return this.catches.isCatching(character);
	}

	/**
	 * Whether `part` is part of `humanoid`'s body, rather than something it is holding or
	 * wearing.
	 *
	 * Two questions, in this order, and both are needed:
	 *
	 * 1. **Is it a direct child of the rig?** `GetLimb` *throws* — "Part is not a child of
	 *    Humanoid", with a stack trace in the output — for anything deeper. A hat's `Handle`
	 *    lives inside its accessory and a tool's inside its tool; without this an ordinary
	 *    glance off a beanie became an error that drowned the log and left the contact
	 *    half-handled.
	 * 2. **Does the engine call it a limb?** `GetLimb` answers for R6 and R15 alike, so no
	 *    list of names is needed here — an R15 rig has `UpperTorso` where an R6 one has
	 *    `Torso`, and a hand-written list would have to know both and would still miss a rig
	 *    nobody has seen yet. It reports `Unknown` for the `HumanoidRootPart`, so it agrees
	 *    with the explicit check above, and for a ball welded into the hand, which is a
	 *    direct child of the rig and so gets past the first question.
	 */
	private isBodyPart(humanoid: Humanoid, part: BasePart): boolean {
		if (part.Parent !== humanoid.Parent) return false;

		return humanoid.GetLimb(part) !== Enum.Limb.Unknown;
	}

	/**
	 * The body part a contact should be treated as, or `undefined` when it is not a contact with a
	 * body at all.
	 *
	 * Four answers, and the middle two are the point of the method:
	 *
	 * - **A part of the rig itself** → itself, which is the ordinary case.
	 * - **A part of something worn on the rig** → the body part it is attached to. See
	 *   {@link wornOn} for why the weld is the right thing to follow rather than a name, a
	 *   distance, or the accessory's own idea of where it is.
	 * - **The root part** → the body part it is jointed to, which is the torso. See
	 *   {@link rootHost}, which is where the reason for that lives.
	 * - **Anything else inside a character** → `undefined`: a tool, the dodgeball in somebody's hand,
	 *   or a worn part that cannot be traced back to a body. A ball that has touched one of those has
	 *   touched nothing — not a hit, not a catch, and no reason to disarm.
	 */
	private struckBodyPart(humanoid: Humanoid, otherPart: BasePart): BasePart | undefined {
		if (this.isBodyPart(humanoid, otherPart)) return otherPart;

		const accessory = otherPart.FindFirstAncestorWhichIsA("Accoutrement");
		if (accessory) return this.wornOn(humanoid, accessory);

		// **The root, and only the root.** Not every welded thing inside a character is routed to its
		// host — see {@link wornOn} for why a tool and a held ball deliberately are not — so this is
		// the root asked of *the humanoid* rather than a rule widened to cover everything welded: a
		// tool and a held ball must stay the ball's business and not become hits on the hand.
		//
		// **`Humanoid.RootPart` is the engine's own answer to which part that is** — "a reference to
		// the humanoid's `HumanoidRootPart` object" — so this is a link rather than a name, which is
		// the same choice {@link wornOn} makes and for the same reason. It also means a rig that
		// something has named oddly is still understood.
		if (otherPart === humanoid.RootPart) return this.rootHost(humanoid, otherPart);

		return undefined;
	}

	/**
	 * The body part the root is jointed to — the torso, on both rig types.
	 *
	 * **This is the fix for a hit that landed and did nothing, and it is the second version of it.**
	 * The root used to be dropped outright, on the reasoning that a ball in contact with it is in
	 * contact with the torso as well, so a report against the root alone means nothing happened. That
	 * is true of *collision* and false of `Touched`: an R15 rig's root sits below the torso's centre,
	 * so its underside is exposed between the legs, and a throw arriving at the hips touches the root
	 * and nothing else. The contact was then discarded, the throw carried on, and the body it had
	 * visibly struck survived — which is the report this was chased from, and what the refusal line at
	 * the old `return` finally showed.
	 *
	 * **Resolved rather than dropped, and resolved rather than taken as itself.** Treating the root as
	 * a body part in its own right is what this did even earlier, and it made a catcher unreachable:
	 * the root is not in {@link CATCH_CONFIG.CATCHABLE_PARTS}, so the first event of a chest arrival
	 * read as a hit and the catch that should have saved them arrived after the damage. Following the
	 * joint gets the answer those two options each missed — the contact becomes a *torso* contact, so
	 * it is a hit **and** it is catchable, which is what a ball into the chest always was.
	 *
	 * **Searches the whole rig, and that is the correction the first version of this method needed.**
	 * That version followed the link, which was right, and it looked for the link *inside the root*,
	 * which was an assumption — and a false one. **Where the joint lives depends on the rig**: on R15
	 * the joint holding the root on is a child of `LowerTorso` (and there is no `RootJoint` on the
	 * root at all), while on R6 it is a child of the root itself. Walking the root's descendants
	 * therefore found the torso on one rig and nothing on the other — and it failed by *declining*,
	 * which is the quiet way to be wrong: the throw that landed on a body produced the refusal line
	 * and then no tag, which is the symptom this method was written to remove and not a new one. A rig
	 * is one object and the link is somewhere in it, so the whole of it is searched and the answer no
	 * longer depends on which generation the rig is.
	 *
	 * **Follows the link rather than naming a part**, for {@link wornOn}'s reason: which part a rig
	 * calls its torso is the rig's business, and a hand-written name would have to know R6's `Torso`
	 * and R15's `LowerTorso` and would still miss a rig nobody has seen. The link is what "inside"
	 * means here, exactly as it is what "worn" means there — and both shapes of it are handled, see
	 * {@link connectionParts}.
	 *
	 * Only a link with the root at one end counts, so the rest of the rig's joints are nothing to do
	 * with this — and see {@link wornOn} for the two things deliberately not routed to their host.
	 *
	 * Answers `undefined` when no body part is jointed to the root, which would be a rig with no
	 * torso; the caller reports that rather than swallowing it.
	 */
	private rootHost(humanoid: Humanoid, root: BasePart): BasePart | undefined {
		// The rig, not the root: see the note above on where the joint lives. `root.Parent` rather
		// than `humanoid.Parent` because the root is a direct child of its rig and asking the part
		// itself is what makes that assumption visible instead of hidden behind a second lookup.
		const rig = root.Parent;
		if (rig === undefined) return undefined;

		for (const descendant of rig.GetDescendants()) {
			const sides = connectionParts(descendant);

			if (sides[0] !== root && sides[1] !== root) continue;

			// `side`, not `end`: `end` is a Luau keyword and roblox-ts refuses to emit it.
			for (const side of sides) {
				if (side === undefined || side === root) continue;
				if (this.isBodyPart(humanoid, side)) return side;
			}
		}

		return undefined;
	}

	/**
	 * The body part a worn accessory is attached to.
	 *
	 * **Follows the link, because the link is what "worn" means.** An accessory on a character is
	 * held there by something — that is the whole of the difference between wearing a hat and having
	 * dropped one — so the link already records the answer rather than leaving it to be guessed
	 * at. A distance test would return whichever body part happened to be nearest, which for a
	 * shoulder accessory is the head and for a long scarf is the floor; and an accessory's own
	 * `AttachmentPoint` is a `CFrame` for placing the model, not a reference to the part it landed
	 * on.
	 *
	 * Only links *inside the accessory* are searched, which is where the engine keeps the one that
	 * holds it on. **Both of Roblox's shapes for that link are handled rather than one being
	 * assumed** — see {@link connectionParts} — because a lookup written against welds alone finds
	 * nothing on a rig whose accessories are held by a `RigidConstraint`, and it fails by declining
	 * rather than by answering wrongly, which is precisely the kind of failure that survives review.
	 *
	 * The end that matters is the end that is not a descendant of the accessory, and it has to be a
	 * part of **this** rig: an accessory attached to anything else is not a body contact, so this
	 * answers `undefined` and the touch is ignored exactly as it was before this existed. That is the
	 * safe direction to fail in — a behaviour that does not change, rather than a hit on the wrong
	 * body.
	 *
	 * **Deliberately not widened past accessories.** A tool is welded to a hand in the same way, and
	 * so is the dodgeball a player is holding; routing every welded thing to its host would make a
	 * ball that clipped somebody's held ball into a hit on their hand.
	 */
	private wornOn(humanoid: Humanoid, accessory: Accoutrement): BasePart | undefined {
		for (const descendant of accessory.GetDescendants()) {
			// `side`, not `end`: `end` is a Luau keyword and roblox-ts refuses to emit it.
			for (const side of connectionParts(descendant)) {
				if (side === undefined) continue;
				if (side.IsDescendantOf(accessory)) continue;
				if (this.isBodyPart(humanoid, side)) return side;
			}
		}

		return undefined;
	}

	/**
	 * Plays one impact sound from a throwaway emitter at the point it happened.
	 *
	 * **Not parented to the thing that was struck, and that is the reversal of what this used to
	 * do.** The comment here argued that the sound should live and die with the part it was heard at,
	 * which is true of a wall and wrong of a body: a hit's head stops existing almost immediately and
	 * the clip went with it. An impact is a fact about a *moment*, and the one part of the scene with
	 * a reason to stop existing right then is the thing that was hit — so the emitter is deliberately
	 * something with no such reason.
	 *
	 * **Where the sharp case is, because it is not every death, and the difference is what to look
	 * for.** An NPC rig keeps its corpse: `RespawnBehavior` sets `BreakJointsOnDeath = false` and
	 * builds the replacement from a clone seconds later, long after any impact clip has finished. A
	 * player in Team Elimination is eliminated and left dead until the engine's own respawn timer,
	 * which is the same story. **A player converted in Dodge and Seek is not**: that mode answers
	 * `respawn`, and `RoundService.handleDeath` carries that out with `player.LoadCharacter()`, which
	 * destroys the old character on the spot. That is the hit whose sound was being cut short.
	 *
	 * Everything about the emitter itself — the flags, the parenting order, the two cleanup paths and
	 * the `PlayOnRemove` that is deliberately not used — now lives in {@link emitSound}, which is
	 * shared with the catch sound. What is left here is the part that is about *impacts*: which part
	 * the sound is heard from, and which id is chosen.
	 *
	 * The struck part's own name goes to the log, because at an impact that is the interesting fact —
	 * there are two ids for a body and a reader of the output should be able to tell which one this
	 * was without listening.
	 */
	private playImpactSound(at: BasePart, soundId: string): void {
		emitSound(at.CFrame, at.Name, soundId, IMPACT_EMITTER_NAME);
	}

	/**
	 * Records one raw `Touched` report, under the number of the ball that reported it.
	 *
	 * **Gated, and ungated was the wrong default for this one specifically.** Every other print in
	 * this file reports a *decision* — one line per landing, which is the whole story of a throw.
	 * This reports the engine's input instead: every part of every overlap set, in the engine's own
	 * order, on every contact an armed ball makes, including the ones that decide nothing. On a
	 * normal arrival that is a dozen lines that mean no more than the one line `handleTouch` ends it
	 * with, and it drowns the log it was meant to be read in. It earns its place only when a contact
	 * is *missing* or *impossible*, which is a question somebody has to be asking, so it lives with
	 * the other diagnostics behind {@link DEBUG_CONFIG.VERBOSE_LOGS}.
	 *
	 * **The identity is the point of the line, not decoration.** Several balls are in play — the
	 * arena's, the thrower's, one in a rig's hand — and they are all called `DodgeballBall`, so a
	 * bare `touched` line cannot be attributed to a throw and cannot be checked against where that
	 * throw's ball actually was. See {@link identity}.
	 *
	 * The `Armed` test is here as well as in `handleTouch` so the log and the decision agree about
	 * which reports were live: a contact on a ball that is already spent is not part of any story.
	 */
	private logTouch(otherPart: BasePart): void {
		if (!DEBUG_CONFIG.VERBOSE_LOGS) return;

		if (this.instance.GetAttribute("Armed") === false) return;

		const character = otherPart.FindFirstAncestorWhichIsA("Model");
		const player = character ? Players.GetPlayerFromCharacter(character) : undefined;

		// Built here rather than written inside the `print`, because a template literal nested
		// inside another one compiles to backticks inside backticks and renders empty — it parses,
		// it runs, and the log it produces has a hole in it.
		const subject = this.isPlayer(otherPart)
			? `${otherPart.Name} of ${player?.Name}`
			: this.isNpc(otherPart)
				? `${otherPart.Name} of ${character?.Name}`
				: otherPart.Name;

		print(`${this.instance.Name} #${this.identity} touched ${subject}`);
	}

	/**
	 * Reports a contact this ball made that decided nothing, and why.
	 *
	 * **The half of a throw's story that was silent by construction, and the reason a hit that did
	 * not register was indistinguishable from a ball that never arrived.** Every refusal in
	 * {@link handleTouch} used to `return` without a word — deliberately, because a normal arrival
	 * makes a dozen of them that mean nothing. The cost is that "this ball met the body and refused
	 * it" and "this ball never met the body" produce exactly the same empty log, which is the
	 * question behind every report of a hit that did not count.
	 *
	 * The refusals worth seeing are named, and they are chosen by how often they can fire rather than
	 * by how interesting they are: **the ones left silent are the ones a single arrival makes a dozen
	 * of** — a body already on the tag list, and the extra parts of the overlap set that follow it.
	 * Everything else fires at most once or twice per arrival, and only when something happened that
	 * the thrower did not intend.
	 *
	 * Ungated, like the tag and the landing, because it is the *absence* of those two lines that this
	 * exists to explain — and a diagnostic that has to be switched on cannot explain a log captured
	 * without it.
	 *
	 * **The body as well as the part, and that is the other half of the same lesson.** `HumanoidRootPart`
	 * is the name of a part on every rig in the game, so a line saying only that leaves the one
	 * question it is being read for unanswered: whose root was it? The ball's own thrower and the body
	 * the throw was aimed at are completely different faults — a ball released into its thrower's own
	 * leg is a spawn offset, while a ball into a victim's hip is this file failing to resolve a
	 * contact — and the part's name alone cannot tell them apart. Both are named here, so a refusal
	 * can be attributed without a second run.
	 */
	private noteDecidedNothing(part: BasePart, reason: string): void {
		const body = part.FindFirstAncestorWhichIsA("Model");
		const subject = body ? `${part.Name} of ${body.Name}` : part.Name;

		print(`[Ball] ${this.instance.Name} #${this.identity}: ${subject} — ${reason}`);
	}

	private isPlayer(otherPart: BasePart): boolean {
		const character = otherPart.FindFirstAncestorWhichIsA("Model");

		const player = character ? Players.GetPlayerFromCharacter(character) : undefined;

		if (player) {
			return true;
		}

		return false;
	}

	private isNpc(otherPart: BasePart): boolean {
		const character = otherPart.FindFirstAncestorWhichIsA("Model");
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");
		const player = character ? Players.GetPlayerFromCharacter(character) : undefined;

		if (humanoid && !player) {
			return true;
		}

		return false;
	}
}

/**
 * The two parts a connective instance holds together, or an empty list if it holds none.
 *
 * **Two shapes, because Roblox has two and which one a rig's accessories use is not ours to
 * choose.** A `Weld` or a `WeldConstraint` names the parts directly, in `Part0` and `Part1` — that
 * is the older way an accessory was held on. A `Constraint`, which is what a rigid accessory is
 * attached with (`RigidConstraint`), names an `Attachment` at each end instead, and the part is
 * whichever `BasePart` that attachment is parented to; there is no `Part0` to read at all. A lookup
 * that only understands the first shape finds nothing on a modern rig, and because
 * {@link BallComponent.wornOn} treats "found nothing" as "not a body contact", the whole thing fails
 * quietly rather than loudly.
 *
 * An end with no part behind it is reported as `undefined` rather than left out, so the two
 * positions keep meaning "first end" and "second end".
 */
function connectionParts(link: Instance): Array<BasePart | undefined> {
	if (link.IsA("JointInstance") || link.IsA("WeldConstraint")) return [link.Part0, link.Part1];

	if (!link.IsA("Constraint")) return [];

	// The part an attachment sits in, or nothing when it sits in something that is not a part.
	// A local rather than a second exported helper: it exists only to be applied to the same two
	// fields, and roblox-ts types `Array.push` against `defined[]`, so the two ends are built as one
	// literal instead of pushed onto an accumulator.
	const partOf = (attachment: Attachment | undefined): BasePart | undefined => {
		const parent = attachment?.Parent;
		return parent !== undefined && parent.IsA("BasePart") ? parent : undefined;
	};

	return [partOf(link.Attachment0), partOf(link.Attachment1)];
}
