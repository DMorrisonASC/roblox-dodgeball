import { OnStart, Service } from "@flamework/core";
import { Players, RunService } from "@rbxts/services";
import { DEV_CONFIG } from "../dev.config";

/** Marks a whitelisted player. Read as `=== true`, so an absent attribute means no. */
const IS_DEV = "IsDev";

/**
 * Flags are attributes too, under this prefix, so anything that can see the
 * `Player` can read one without going through this service. `Dev_InfiniteBalls`
 * and friends.
 */
const FLAG_PREFIX = "Dev_";

/**
 * The solo-dev testing harness.
 *
 * Deliberately not an admin system: it whitelists by UserId, marks the player
 * with attributes, and answers a chat command or two. What it gives a system is
 * *one place* to ask "is this a dev, and is this flag on" — so no call site
 * carries a UserId, and turning the whole thing off is one line of config.
 *
 * The attribute *is* the state. There is no table of devs kept beside it, which
 * is what makes `setFlag` take effect the instant it is called: every reader sees
 * the attribute, and the attribute has already changed.
 */
@Service()
export class DevService implements OnStart {
	public onStart() {
		// The whitelist is a Studio tool. Elsewhere it is ignored unless the config
		// says otherwise, so a UserId in the repository is never a live cheat.
		if (!this.allowed()) {
			warn(
				"[Dev] outside Studio and `allowInLiveServers` is false — the dev whitelist is " +
					"ignored and no flags will be applied",
			);
			return;
		}

		Players.PlayerAdded.Connect((player) => this.welcome(player));

		// Anyone already in when this service started.
		for (const player of Players.GetPlayers()) {
			this.welcome(player);
		}
	}

	/** Whether this player was whitelisted and marked. */
	public isDev(player: Player): boolean {
		return player.GetAttribute(IS_DEV) === true;
	}

	/** Whether a flag is on for this player. False for a non-dev, and false if unset. */
	public getFlag(player: Player, flag: string): boolean {
		return player.GetAttribute(FLAG_PREFIX + flag) === true;
	}

	/**
	 * Switches a flag for a dev, now.
	 *
	 * Writes the player's attribute, so a system that reads `Dev_<flag>` picks the
	 * change up on its next read rather than at the next respawn or restart.
	 */
	public setFlag(player: Player, flag: string, value: boolean): void {
		if (!this.isDev(player)) return;

		player.SetAttribute(FLAG_PREFIX + flag, value);
	}

	/** Whether the harness may run at all here. */
	private allowed(): boolean {
		return RunService.IsStudio() || DEV_CONFIG.allowInLiveServers;
	}

	private welcome(player: Player): void {
		if (DEV_CONFIG.userIds.includes(player.UserId) && !this.isDev(player)) {
			this.becomeDev(player);
		}

		// Connected for everyone on purpose: `isDev` is then the single gate on what
		// the commands do, rather than a second whitelist that could drift from it.
		player.Chatted.Connect((message) => this.handleChat(player, message));
	}

	private becomeDev(player: Player): void {
		player.SetAttribute(IS_DEV, true);

		for (const [flag, value] of pairs(DEV_CONFIG.defaultFlags)) {
			this.setFlag(player, flag, value);
		}

		print(`[Dev] ${player.Name} is a dev — ${this.describeFlags(player)}`);
	}

	/**
	 * `/dev <flag> <on|off>`, and nothing else.
	 *
	 * A non-dev gets no answer at all, not even a refusal: the command has no
	 * reason to advertise that it exists.
	 */
	private handleChat(player: Player, message: string): void {
		if (!this.isDev(player)) return;

		const words: string[] = [];
		for (const word of message.lower().split(" ")) {
			if (word !== "") words.push(word);
		}

		if (words[0] !== "/dev") return;

		const requested = this.findFlag(words[1]);
		const state = words[2];

		// Matched against the configured flags, so a typo is answered with the list
		// rather than quietly writing an attribute nothing will ever read.
		if (!requested || (state !== "on" && state !== "off")) {
			this.printUsage(player);
			return;
		}

		this.setFlag(player, requested, state === "on");
		print(`[Dev] ${player.Name}: ${requested} ${this.getFlag(player, requested) ? "on" : "off"}`);
	}

	/** The configured flag whose name matches `lowered`, in its own casing. */
	private findFlag(lowered: string | undefined): string | undefined {
		if (!lowered) return undefined;

		for (const [flag] of pairs(DEV_CONFIG.defaultFlags)) {
			if (flag.lower() === lowered) return flag;
		}

		return undefined;
	}

	private printUsage(player: Player): void {
		const names: string[] = [];
		for (const [flag] of pairs(DEV_CONFIG.defaultFlags)) names.push(flag);

		print(`[Dev] ${player.Name}: usage is /dev <flag> <on|off> — flags: ${names.join(", ")}`);
	}

	/** Every flag and where it stands, for the one print a joining dev costs. */
	private describeFlags(player: Player): string {
		const parts: string[] = [];
		for (const [flag] of pairs(DEV_CONFIG.defaultFlags)) {
			parts.push(`${flag} ${this.getFlag(player, flag) ? "on" : "off"}`);
		}

		return parts.join(", ");
	}
}
