import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players, ReplicatedStorage } from "@rbxts/services";
import { STATS_CONFIG } from "shared/config/stats.config";
import {
	CROWN_ATTRIBUTE,
	ROUND_STATE_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
	STAT_HITS,
	STAT_OUTS,
} from "shared/constants";

/** Prints once, when the billboards are up — the line that says the controller ran at all. */
const DEBUG = true;

/** The phase a billboard is shown in. A word between two files, not a setting. */
const INTERMISSION = "Intermission";

/** What the billboard is called, so a stray one can be told from anything else on a head. */
const BILLBOARD_NAME = "StatsBillboard";

/**
 * What the crown is called, on the same head and for the same reason.
 *
 * **A second instance rather than a row inside the billboard**, because the two are shown on different
 * clocks and to different rules: the record is drawn between rounds and the crown is drawn *during* one,
 * so they are up at different times and neither can be a child of the other's visibility.
 */
const CROWN_NAME = "CrownBillboard";

/**
 * Room for the line above a head, in pixels.
 *
 * **Wide enough for the longest line the label can hold, not for a typical one.** Nothing but the
 * text is drawn — the label has no background — so a billboard wider than its own line costs a clip
 * rectangle and nothing else, while one narrower cuts the ratio off the end of it. At caption size
 * `Hits: 999 | Outs: 999 | Ratio: 1.00` runs to a little over three hundred pixels.
 *
 * **That measurement was taken against a longer line, so it still holds.** `Outs:` is three
 * characters narrower than the `Misses:` it replaced, and nothing else about the line changed.
 */
const BILLBOARD_SIZE = UDim2.fromOffset(320, 40);

/**
 * Each player's hit-and-out record, floating above their head between rounds.
 *
 * **A record is something you read while nothing is happening.** During a round it would be a label
 * in the way of the thing it describes — and a ratio that moved mid-round would be a number to watch
 * instead of the ball — so the whole billboard is switched off while a round runs and back on when it
 * ends. That is the one moment a player has to look at anybody else's numbers, and the moment they
 * are standing still in a lobby.
 *
 * **It reads attributes and computes nothing that the server could have computed.** The counts and
 * the ratio are published by `StatsService`, so the two machines cannot disagree about a player's own
 * record; this decides only how to draw it. Nothing here is sent, asked for, or reconciled.
 *
 * One `BillboardGui` per player **per body**, mounted on `CharacterAdded` and torn down with the
 * character that carried it. See {@link attach} for why a respawn gets a scope of its own.
 *
 * **And the crown, which is the second thing this file hangs on the same head.** A player who is hot
 * wears an image above them, for as long as `CROWN_ATTRIBUTE` says so — which the *server* decides, since
 * "the most hits on their side" needs every count and every side at once. See `SuperService.refreshCrowns`
 * for the rule, and {@link attach} for how little the client has to do with the answer.
 *
 * **The two readouts are on opposite clocks, and that is what makes them one file rather than two.** The
 * record is for an intermission and the crown is for a round; what they share is everything mechanical —
 * a player list to watch, a body to wait for, a scope per body to tear down — and none of that is about
 * either readout. Adding the crown here rather than in a controller of its own is what keeps one copy of
 * that machinery, and the connection it is built on (`CharacterAdded`, and the attribute's own signal)
 * is the same pair the record uses.
 */
@Controller()
export class StatsBillboardController implements OnStart {
	public onStart(): void {
		// Mounted rather than built inline: the round's status folder is made by `RoundService`, and
		// waiting for it can yield — so `onStart` is the wrong place to hold the rest of the boot up
		// for something another machine has not made yet. The same shape, and the same reason, as
		// every other HUD controller here.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const folder = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER) as Folder;

		const scope = Fusion.scoped();

		// The phase, as a `Value` rather than read where it is needed: a `Computed` has to be able to
		// *watch* this, and `GetAttribute` inside one is a reading taken once rather than a dependency.
		const state = Fusion.Value(scope, stateOf(folder));

		scope.push(
			folder.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => state.set(stateOf(folder))),
		);

		scope.push(Players.PlayerAdded.Connect((player) => this.watch(player, state, scope)));

		// A player already in the game when this mounted never fires the added-signal, so the ones
		// already here are walked rather than waited for — the scan-and-subscribe the other services
		// and HUDs do, for the same reason.
		for (const player of Players.GetPlayers()) this.watch(player, state, scope);

		if (DEBUG) print(`[HUD] stat billboards and crowns up — ${Players.GetPlayers().size()} players`);
	}

	/** Gives `player` a billboard above every body they get, for as long as they are in the game. */
	private watch(player: Player, state: Fusion.Value<string>, parent: Fusion.Scope<unknown>): void {
		player.CharacterAdded.Connect((character) => this.attach(character, player, state, parent));
	}

	/**
	 * Mounts a stat billboard on `character`'s head.
	 *
	 * **A scope of its own for each body, torn down with it.** The two computeds below are bound to a
	 * label that is destroyed when the character is — but a computed is *not* destroyed by the
	 * instance it writes to, and a scope belonging to the controller would collect one pair per
	 * respawn for the life of the session. An inner scope is destroyed either by its owner or by the
	 * scope it came from, so a respawn takes its own down and leaves nothing behind.
	 *
	 * The `Text` is big-ui's, so this label reads the same theme as every other piece of the HUD —
	 * see `ThemeController`, which configures it before any of this mounts.
	 */
	private attach(character: Model, player: Player, state: Fusion.Value<string>, parent: Fusion.Scope<unknown>): void {
		// Waited for rather than found: a character is announced before its parts have all arrived,
		// and a head that is not there yet is a billboard with nowhere to go.
		const head = character.WaitForChild("Head") as BasePart;

		const scope = Fusion.innerScope(parent);

		// **Pushed into the scope it tears down, which is the fix for an error this used to print on every
		// death.** The connection was made and forgotten, so it outlived the cleanup it performs: the body it
		// belonged to was gone, but the handler was still attached to the *player*, and it therefore ran again
		// on every later removal — cleaning a scope that had already been cleaned. That is Fusion's
		// `poisonedScope` followed by a stack of `destroyedTwice` lines, once per respawn, for the rest of the
		// session. A connection held by the scope is disconnected when the scope is cleaned, so the handler
		// cannot outlive the body it was made for.
		scope.push(player.CharacterRemoving.Connect(() => Fusion.doCleanup(scope)));

		const billboard = new Instance("BillboardGui");
		billboard.Name = BILLBOARD_NAME;
		billboard.Adornee = head;
		billboard.Size = BILLBOARD_SIZE;
		billboard.StudsOffsetWorldSpace = new Vector3(0, STATS_CONFIG.BILLBOARD_OFFSET_Y, 0);
		// **Occluded rather than drawn through the world.** This is a label about a body standing in
		// the map, not a marker on a screen: somebody behind a wall is somebody you cannot read, and a
		// scoreboard that floated through geometry would be showing the numbers of a player who could
		// be anywhere.
		billboard.AlwaysOnTop = false;
		billboard.MaxDistance = STATS_CONFIG.BILLBOARD_MAX_DISTANCE;
		billboard.Parent = head;

		Fusion.Hydrate(scope, billboard)({
			Enabled: Fusion.Computed(scope, (use) => use(state) === INTERMISSION),
		});

		// The two counts as watchable states, so the line below follows them rather than sampling them
		// once. Per body, and in the body's own scope — the connections they hold belong to this head.
		const hits = watchCount(scope, player, STAT_HITS);
		const outs = watchCount(scope, player, STAT_OUTS);

		const label = Text(scope, {
			text: Fusion.Computed(scope, (use) => describe(use(hits), use(outs))),
			variant: "caption",
			align: Enum.TextXAlignment.Center,
		});
		label.Parent = billboard;

		// **And the crown, which is the same machinery pointed at a different source.** The flag is watched
		// on the *player* rather than on the body, because that is where the server wrote it — and that is
		// the whole of what a respawn costs: the answer did not change, so the only thing that has to be
		// rebuilt is the billboard, which is what this method is for.
		const crowned = watchFlag(scope, player, CROWN_ATTRIBUTE);

		const crown = new Instance("BillboardGui");
		crown.Name = CROWN_NAME;
		crown.Adornee = head;
		crown.Size = STATS_CONFIG.CROWN_SIZE;
		crown.StudsOffsetWorldSpace = new Vector3(0, STATS_CONFIG.CROWN_OFFSET_Y, 0);
		// **Occluded, like the record above it, and that is a decision rather than the default.** A crown is
		// something about a body standing in the map: a crowned player behind a wall is a player you cannot
		// see, exactly as their numbers are. It is also the one property here worth revisiting — `true` draws
		// it through geometry like an objective marker, which is a different game.
		crown.AlwaysOnTop = false;
		crown.MaxDistance = STATS_CONFIG.CROWN_MAX_DISTANCE;
		crown.Parent = head;

		Fusion.Hydrate(scope, crown)({
			Enabled: Fusion.Computed(scope, (use) => use(crowned)),
		});

		const image = new Instance("ImageLabel");
		image.Name = "Image";
		image.BackgroundTransparency = 1;
		image.Size = UDim2.fromScale(1, 1);
		image.Image = STATS_CONFIG.CROWN_IMAGE;
		// **Fitted rather than stretched**, because the shape of the upload is the uploader's business: a
		// crown drawn into a box it was not made for is a crown that looks wrong at every distance.
		image.ScaleType = Enum.ScaleType.Fit;
		image.Parent = crown;
	}
}

/**
 * The record as the one line above a head.
 *
 * **Every figure is named, and the names are what make it readable from across an arena.** A row of
 * bare numbers above somebody else's head is a small puzzle to be solved while looking at it;
 * `Hits:`, `Outs:` and `Ratio:` are read without being worked out, which is the whole job of a
 * label drawn above every player in the game.
 *
 * Nothing is abbreviated and nothing is implied. The line is long for a reason, and it is the reason
 * the billboard it sits in is as wide as it is — see {@link BILLBOARD_SIZE}.
 */
function describe(hits: number, outs: number): string {
	const counted = hits + outs;
	const ratio = counted === 0 ? 0 : hits / counted;

	return `Hits: ${hits} | Outs: ${outs} | Ratio: ${string.format("%.2f", ratio)}`;
}

/** The phase `folder` is publishing, or `""` while it has not said. */
function stateOf(folder: Instance): string {
	const state = folder.GetAttribute(ROUND_STATE_ATTRIBUTE);

	return typeIs(state, "string") ? state : "";
}

/**
 * The phase as a `Value`, so a `Computed` can watch it.
 *
 * **The bridge between two channels.** Attributes are how the server publishes this, and a Fusion
 * state is the only thing a `Computed` can depend on — `GetAttribute` read inside one is a value
 * taken once, not a dependency, so a label built straight on it would be a label that never changed
 * after its first frame. Fed from the changed-signal, it is live.
 */
function watchCount(scope: Fusion.Scope<unknown>, player: Player, name: string): Fusion.Value<number> {
	const state = Fusion.Value(scope, countOf(player, name));

	scope.push(player.GetAttributeChangedSignal(name).Connect(() => state.set(countOf(player, name))));

	return state;
}

/** A numeric attribute, or `0` — the count a player with nothing recorded has. */
function countOf(player: Player, name: string): number {
	const value = player.GetAttribute(name);

	return typeIs(value, "number") ? value : 0;
}

/**
 * A boolean attribute as a `Value`, for {@link watchCount}'s reason and in exactly its shape.
 *
 * **The crown's flag is watched on the player and never on the body**, which is what makes a respawn
 * free: the answer did not change, so the only thing to rebuild is the billboard — and every body gets
 * one of those because every body runs {@link StatsBillboardController.attach}. An attribute that was
 * never written reads as `false`, which is the honest answer for a player who has not been crowned.
 */
function watchFlag(scope: Fusion.Scope<unknown>, player: Player, name: string): Fusion.Value<boolean> {
	const state = Fusion.Value(scope, flagOf(player, name));

	scope.push(player.GetAttributeChangedSignal(name).Connect(() => state.set(flagOf(player, name))));

	return state;
}

/** A boolean attribute, or `false`. */
function flagOf(player: Player, name: string): boolean {
	return player.GetAttribute(name) === true;
}
