/**
 * The round's badges: **what kind of round it was**, derived at `finishRound` and drawn above each head for
 * fifteen seconds.
 *
 * **The display is `StatsBillboardController`, and it is the only one.** It draws each id as two black lines — the
 * name and the sentence under it — on a white card above the head of the body wearing it, for the fifteen seconds
 * the set is published. That file has been deleted, reverted and rebuilt around this display in one day
 * (`HANDOFF.md` §15 items 111–114); what it needs from this file is only the vocabulary, which has not moved.
 * **Nothing else in the client reads these ids**, so a change to a badge's name is a change to what appears above
 * every head.
 *
 * **The three rules that govern every badge, and a badge that violates one is a bug rather than a
 * matter of taste.**
 *
 * 1. **Describe the performance, not the player.** A badge names something that happened — `sprayAndPray`
 *    is "most throws, fewest hits" — and never something a person *is*. The naming test is the sharp one:
 *    could a stranger read the label and know what happened, without being told who they are. `badAim` is
 *    the name this rule rejects, and it rejects it for what it costs: a label that is an accusation is a
 *    verdict handed down by a machine, and the alternative — describing the three throws that landed
 *    nothing — is both funnier and true. **`perfectionist` is the one documented exception**, and it is
 *    argued at its own entry rather than smuggled through here.
 * 2. **Never a punishment.** The badge system writes nothing to `EconomyService` or `StatsService`. It
 *    deducts no coins, moves no statistic and leaves no record anywhere but the attribute the client
 *    reads, which is cleared at fifteen seconds and again at the `Playing` edge. That is the entire
 *    lifetime, and the alternative — a badge that costs a coin — would turn a joke into a tax.
 * 3. **No forced negative.** A derived set that consists **only** of rib badges is replaced by the empty
 *    set. A player may finish a round with nothing above their head, and that is deliberate rather than a
 *    gap: the alternative is public shame in a fifteen-second window, in a game where the losing side is
 *    already the one the roster usually emptied. The suppression is `BadgeService`'s, because it is a
 *    rule about a *set* and the set only exists on the server.
 *
 * **What this module is and is not.** It is the vocabulary — the ids the server writes and the client
 * draws, the display names, and the three tones — and it is here rather than in the service for the reason
 * `HitDirection` lives beside its event: two machines read it and neither owns it. It is **not** the
 * rules. Which body earned which badge is `BadgeService`'s and needs the round's numbers; this file only
 * says what a badge *is called*. A rule stated here would be a rule the client could disagree with.
 *
 * **Badges are attributes, not tags.** `BADGES_ATTRIBUTE` carries these ids as one comma-joined string, so
 * nothing here involves `CollectionService` and `TAGS.md` has nothing to say about it. An attribute is also
 * the only shape that survives replication to every client without a remote: the server writes, the client
 * draws, and there is no message for the two to disagree about.
 */

/** What a badge is *for*, in one of three words — the only thing the display needs from it. */
export type BadgeTone = "praise" | "neutral" | "rib";

/** One badge: the id the attribute carries, what a head reads, and how it should be coloured. */
export interface Badge {
	/** The wire value. Never shown to a player; `name` is. */
	readonly id: string;

	/**
	 * What is drawn above the head. **Lower case on purpose** — these are captions, not headings, and the
	 * whole strip of them is meant to read as one sentence about a round rather than as six achievements.
	 */
	readonly name: string;

	/**
	 * **The same badge said plainly**, drawn under the name for anybody who has not read the rules.
	 *
	 * **A name is a caption and half of these are jokes a stranger cannot decode from two words** —
	 * `fetchDog`, `neo`, `glassCannon`, `sprayAndPray`. The description is the badge explained in one
	 * sentence, and it sits *under* the name rather than replacing it: the name is the thing a player quotes
	 * back, and the description is what makes quoting it mean something.
	 *
	 * **Required rather than optional, and that is the compiler's job rather than a runtime guard's.**
	 * `BADGES` below is typed `ReadonlyArray<Badge>`, so a literal missing this field fails the build — a
	 * badge added later with no sentence is an error at the desk, not a row with a hole in it above somebody's
	 * head at three in the morning.
	 *
	 * **It is not on the wire.** Both machines already import this file, so `BADGES_ATTRIBUTE` carries ids
	 * and the client looks the sentence up. A description replicated per body per round would be the same
	 * text sent again every fifteen seconds to say something that has not changed since the build.
	 *
	 * **One line, never wrapped.** A description is a sentence, and it should stay one. That was written for a
	 * display that truncated above a head; the constraint outlives it, because a two-clause description reads as two
	 * badges however it is drawn.
	 */
	readonly description: string;

	/** Which of the three tones. A display colours by this and decides nothing else from it. */
	readonly tone: BadgeTone;
}

/**
 * Every badge there is, **in the order a display draws them.**
 *
 * The order is the table's own: the round's broad verdicts first, then the narrower ones, then the pair of
 * events that are about *when* something happened rather than how much of it did. A body with six badges
 * reads top-down, so the first line is the one a watcher sees.
 *
 * **No badge has a percentage, a count or a volume.** `hatTrick` is a name for three hits, not a progress
 * bar for them; a badge that showed its working would be a scoreboard with better typography, and the
 * round already had one of those — see `RoundResultController`'s removal in `HANDOFF.md` §9.
 */
export const BADGES: ReadonlyArray<Badge> = [
	{
		id: "untouchable",
		name: "untouchable",
		description: "Landed a hit and never went down.",
		tone: "praise",
	},
	{ id: "topGun", name: "top gun", description: "The side's most hits.", tone: "praise" },
	{ id: "hatTrick", name: "hat-trick", description: "Three hits or more in one round.", tone: "praise" },
	{ id: "wall", name: "the wall", description: "Most catches on the side, at least two.", tone: "praise" },
	{ id: "safeHands", name: "safe hands", description: "Three catches or more, never down.", tone: "praise" },
	{ id: "neo", name: "neo", description: "Most dodges on the side, at least two.", tone: "praise" },
	{ id: "sniper", name: "sniper", description: "The side's most hits, from its fewest throws.", tone: "praise" },
	{ id: "clutch", name: "clutch", description: "Scored the winning point.", tone: "praise" },
	{ id: "revenge", name: "revenge", description: "Hit back someone who had hit you.", tone: "praise" },
	{ id: "onFire", name: "on fire", description: "Crowned at the round's end.", tone: "praise" },
	{ id: "carried", name: "carried", description: "Won without landing a hit or going down.", tone: "neutral" },
	{ id: "almost", name: "almost there", description: "The losing side's most hits.", tone: "neutral" },
	{
		id: "glassCannon",
		name: "glass cannon",
		description: "Most hits and most outs on the side.",
		tone: "neutral",
	},
	{ id: "firstBlood", name: "first blood", description: "The round's first hit.", tone: "neutral" },
	{
		id: "sittingDuck",
		name: "sitting duck",
		description: "Most outs on the side, without landing a hit.",
		tone: "rib",
	},
	{ id: "oneAndDone", name: "one and done", description: "Down once, never landed a hit.", tone: "rib" },
	{
		id: "sprayAndPray",
		name: "spray and pray",
		description: "Threw the most, landed the least on the side.",
		tone: "rib",
	},
	{
		id: "fetchDog",
		name: "fetch dog",
		description: "Fetched the most, threw the least on the side.",
		tone: "rib",
	},
	{ id: "punchingBag", name: "punching bag", description: "Took the most hits on the side.", tone: "rib" },

	/**
	 * **The one badge that is allowed to name a trait, and the joke is the reason.** Every other label here
	 * describes what happened; this one describes a *person* — someone who looked at a body already hit
	 * three times and chose to hit it again — and it does so on purpose. The joke is that they are
	 * "perfecting" a body that needed no help, and the *reason string* carries the performance instead
	 * (`[Badge] Player1: perfectionist — the 4th hit on Player2, who was already down 3`), so the accuracy
	 * rule 1 asks for is kept in the log even though the label keeps the joke.
	 *
	 * **The alternative was tried on paper and refused by the user.** `overkill` describes the performance
	 * and loses the joke; a badge system whose only memorable entry is a joke that was renamed into
	 * compliance is a badge system nobody quotes. This is the one deliberate exception, it is documented as
	 * one, and it is **not** exempt from rule 3 — a player whose only badge is this one shows nothing,
	 * because a rib badge alone is the thing that rule exists to prevent.
	 *
	 * **Its description is the one that has to do the work rather than the name**, because the name is a
	 * judgement and the sentence is the fact. That is the whole of what the field is for.
	 */
	{
		id: "perfectionist",
		name: "perfectionist",
		description: "The fourth hit on a body already hit three times.",
		tone: "rib",
	},
];

/** The five-point lookup, built once. `Map` rather than a scan: the client asks this per badge drawn. */
const BY_ID = new Map<string, Badge>();
for (const badge of BADGES) BY_ID.set(badge.id, badge);

/**
 * The badge `id` names, or nothing.
 *
 * **Nothing rather than a guess**, because an id this file does not know is an id the client cannot draw
 * a name for — a server that grew a badge before this file did, or an attribute written by something else
 * entirely. Skipping it is the honest answer; inventing a label would put a word above a head that nobody
 * chose.
 */
export function badgeById(id: string): Badge | undefined {
	return BY_ID.get(id);
}

/**
 * **`BADGE_COLOURS` is deleted, and the reason is the surface it was written for.** It held three bright colours
 * "for a label with no background behind it" — legible over a floor, which is a different job from legible on a
 * panel. The strip above a head has a white card behind it now, and on paper `neutral` at `#F2F2F2` is nine units
 * from the page: a rib badge would vanish. **Tone therefore chooses no ink at all.** It still exists and still
 * matters — `BadgeService` publishes nothing when a set is *only* ribs — but a display that wants to colour by it
 * will have to answer the paper question first, which is why the argument is kept here rather than the table.
 *
 * **Tone is a rank-free distinction.** Praise is not "better" than rib — rule 1 says a rib badge describes a
 * performance — and a player reading a rib badge should be laughing rather than being told off.
 */

/**
 * **How a set is published: one comma-joined string, and the empty string for "nothing".**
 *
 * A string rather than a table of children or a JSON blob, for the reason every attribute in this project
 * is a string: it replicates as one value, the client splits it, and an id list is exactly the shape a
 * string does well. **Ids never contain a comma**, which is the only constraint the encoding puts on
 * {@link BADGES} and the reason it is stated here rather than assumed.
 *
 * The empty string is a *value* and not an absence: `SetAttribute` with `""` is a change the client is
 * told about, where removing the attribute is also a change but leaves every reader asking whether
 * "never set" and "cleared" are the same fact. They are not — one is a body that was never in a round,
 * the other is a round that had nothing to say about it — and writing `""` makes the second observable.
 */
export function encodeBadges(ids: ReadonlyArray<string>): string {
	return ids.join(",");
}

/**
 * The ids an attribute value carries, skipping anything this file cannot name.
 *
 * **Parsing is forgiving on the way in and strict about what it hands back.** An empty string, a stray
 * comma or an id a newer server invented all come out as "fewer badges", which is the failure that draws
 * nothing rather than the one that draws a wrong label. The display asks {@link badgeById} for each id it
 * gets, so this and that are one rule split across two functions rather than two rules.
 */
export function decodeBadges(value: string): string[] {
	const ids: string[] = [];

	// **No trimming, and the reason is that the encoding never adds whitespace.** Ids are written by
	// `encodeBadges` from a list of names this file owns, so every segment is either empty (a trailing
	// separator, or the empty string) or an id. `string.trim` does not exist in roblox-ts's library anyway —
	// it is one of the JavaScript methods the `noLib` shims leave out — and the honest answer is that this
	// format never needed it.
	for (const raw of value.split(",")) {
		if (raw !== "" && BY_ID.has(raw)) ids.push(raw);
	}

	return ids;
}
