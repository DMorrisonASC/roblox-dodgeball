import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players, ReplicatedStorage } from "@rbxts/services";
import { STATS_CONFIG } from "shared/config/stats.config";
import { ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER, STAT_HITS, STAT_MISSES } from "shared/constants";

/** Prints once, when the billboards are up — the line that says the controller ran at all. */
const DEBUG = true;

/** The phase a billboard is shown in. A word between two files, not a setting. */
const INTERMISSION = "Intermission";

/** What the billboard is called, so a stray one can be told from anything else on a head. */
const BILLBOARD_NAME = "StatsBillboard";

/**
 * Room for the line above a head, in pixels.
 *
 * **Wide enough for the longest line the label can hold, not for a typical one.** Nothing but the
 * text is drawn — the label has no background — so a billboard wider than its own line costs a clip
 * rectangle and nothing else, while one narrower cuts the ratio off the end of it. At caption size
 * `Hits: 999 | Misses: 999 | Ratio: 1.00` runs to a little over three hundred pixels.
 */
const BILLBOARD_SIZE = UDim2.fromOffset(320, 40);

/**
 * Each player's throw record, floating above their head between rounds.
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

		if (DEBUG) print(`[HUD] stat billboards up — ${Players.GetPlayers().size()} players`);
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
		player.CharacterRemoving.Connect(() => Fusion.doCleanup(scope));

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
		const misses = watchCount(scope, player, STAT_MISSES);

		const label = Text(scope, {
			text: Fusion.Computed(scope, (use) => describe(use(hits), use(misses))),
			variant: "caption",
			align: Enum.TextXAlignment.Center,
		});
		label.Parent = billboard;
	}
}

/**
 * The record as the one line above a head.
 *
 * **Every figure is named, and the names are what make it readable from across an arena.** A row of
 * bare numbers above somebody else's head is a small puzzle to be solved while looking at it;
 * `Hits:`, `Misses:` and `Ratio:` are read without being worked out, which is the whole job of a
 * label drawn above every player in the game.
 *
 * Nothing is abbreviated and nothing is implied. The line is long for a reason, and it is the reason
 * the billboard it sits in is as wide as it is — see {@link BILLBOARD_SIZE}.
 */
function describe(hits: number, misses: number): string {
	const throws = hits + misses;
	const ratio = throws === 0 ? 0 : hits / throws;

	return `Hits: ${hits} | Misses: ${misses} | Ratio: ${string.format("%.2f", ratio)}`;
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

/** A numeric attribute, or `0` — the count a player who has never thrown anything has. */
function countOf(player: Player, name: string): number {
	const value = player.GetAttribute(name);

	return typeIs(value, "number") ? value : 0;
}
