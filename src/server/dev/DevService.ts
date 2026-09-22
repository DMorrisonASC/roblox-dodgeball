import { OnStart, Service } from "@flamework/core";
import { Players, TextChatService } from "@rbxts/services";
import { DEV_CONFIG } from "./dev.config";

/** Marks a whitelisted player. Read as `=== true`, so an absent attribute means no. */
const IS_DEV = "IsDev";

/**
 * Flags are attributes too, under this prefix, so anything that can see the
 * `Player` can read one without going through this service — `Dev_InfiniteBalls`,
 * `Dev_InfiniteCatch`, `Dev_NoCooldown`, and one for every other key in
 * `DEV_CONFIG.defaultFlags`.
 */
const FLAG_PREFIX = "Dev_";

/**
 * The command prefix.
 *
 * An exclamation mark rather than a slash: a leading `/` is read as a chat command
 * by Roblox's own systems in some configurations and never reaches the server, so
 * the prefix a game owns is the one that arrives.
 */
const PREFIX = "!dev";

/**
 * Prints which chat is being read, and every command that arrives through it.
 *
 * A command that does nothing is ambiguous — the message may never have reached
 * the server, or it may have arrived in a shape the parser did not recognise — and
 * logging the raw text is the only way to tell those apart. Turn it off once the
 * commands are trusted.
 */
const DEBUG = true;

/**
 * The solo-dev testing harness.
 *
 * Deliberately not an admin system: it whitelists by UserId, marks the player with
 * attributes, and answers a chat command. What it gives a gameplay system is *one
 * place* to ask "is this a dev, and is this flag on" — so no call site carries a
 * UserId, and the whole thing is three call sites wide.
 *
 * The attribute **is** the state. There is no table of devs kept beside it, which
 * is what makes `setFlag` take effect the instant it is called: every reader sees
 * the attribute, and the attribute has already changed — including a system that
 * listens on `GetAttributeChangedSignal` instead of asking.
 *
 * The whitelist never leaves this folder's server-side config: it is never logged,
 * never sent to a client, and there is no remote in here to send it with.
 */
@Service()
export class DevService implements OnStart {
	/**
	 * The last message each player's chat delivered.
	 *
	 * Both chats are listened to (see `onStart`), so one message can arrive twice. An
	 * identical line straight after itself is that duplicate and nothing else — nobody
	 * types the same command twice in a row on purpose — so the second is dropped
	 * instead of answering the same command twice.
	 */
	private readonly lastCommand = new Map<Player, string>();

	/**
	 * Callbacks to run when a flag is switched, keyed on the flag's own name.
	 *
	 * A flag is *state*: a system that reads one learns it changed the next time it
	 * looks, which is enough for a rule consulted on every action — a catch window
	 * opened by a press, a cooldown checked before a dash. It is not enough for a rule
	 * consulted at the *end* of something that has to happen first. `InfiniteBalls` is
	 * that case: switching it on with an empty hand changes nothing until the next
	 * throw, and an empty hand has no next throw. This is how a system that has to act
	 * on the change finds out, without this file knowing what any of them do.
	 */
	private readonly flagListeners = new Map<string, ((player: Player, on: boolean) => void)[]>();

	public onStart() {
		Players.PlayerAdded.Connect((player) => this.welcome(player));

		// Anyone already in when this service started.
		for (const player of Players.GetPlayers()) {
			this.welcome(player);
		}

		// **The modern chat as well as `Chatted`.** `Player.Chatted` is the legacy
		// signal and `TextChatService.MessageReceived` is the current one, and only one
		// of them speaks in a given place — but which one is not worth betting on, since
		// `TextChatService.ChatVersion` reports the *setting* rather than the chat a
		// player is actually typing into. Two connections cost nothing, and the
		// duplicate they can produce is absorbed by `handleChat`.
		TextChatService.MessageReceived.Connect((message) => this.handleMessage(message));

		if (DEBUG) print("[Dev] listening for commands on both chat systems");
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
	 * Registers `listener` to run whenever `flag` is switched, with the player it was
	 * switched for and the value it was switched to.
	 *
	 * Called once per system that cares, at construction — the same shape as the
	 * `getFlag` call sites, which is the point: a system either *asks*, or asks to be
	 * told. What the new value means is the listener's business, and so is whether it
	 * already happens to be in that state; the listener is called on every switch, not
	 * only on a change.
	 */
	public onFlagChanged(flag: string, listener: (player: Player, on: boolean) => void): void {
		const listeners = this.flagListeners.get(flag);
		if (listeners) {
			listeners.push(listener);
		} else {
			this.flagListeners.set(flag, [listener]);
		}
	}

	/**
	 * Switches a flag for a dev, now.
	 *
	 * Writes the player's attribute, so a system that reads `Dev_<flag>` picks the
	 * change up on its next read — and one listening on the attribute's changed signal
	 * picks it up sooner than that. Any listener registered under this flag's name is
	 * called outright, which is the belt to that pair of braces: see `onFlagChanged`.
	 */
	public setFlag(player: Player, flag: string, value: boolean): void {
		if (!this.isDev(player)) return;

		player.SetAttribute(FLAG_PREFIX + flag, value);

		const listeners = this.flagListeners.get(flag);
		if (!listeners) return;

		for (const listener of listeners) listener(player, value);
	}

	private welcome(player: Player): void {
		if (DEV_CONFIG.userIds.includes(player.UserId) && !this.isDev(player)) {
			this.becomeDev(player);
		}

		// Connected for everyone on purpose: `isDev` is then the single gate on what the
		// commands do, rather than a second whitelist that could drift from it. A
		// non-dev's message is dropped in `handleChat` without a word.
		player.Chatted.Connect((message) => this.handleChat(player, message, "Chatted"));
	}

	/**
	 * The TextChatService bridge, which is the whole difference between the two chats.
	 *
	 * A `TextChatMessage` is not addressed to a `Player`: it carries a `TextSource`,
	 * and a system message carries none at all, which is the case to drop on.
	 */
	private handleMessage(message: TextChatMessage): void {
		const source = message.TextSource;
		if (!source) {
			if (DEBUG) print(`[Dev] TextChatService <${message.Text}> with no sender — ignored`);
			return;
		}

		const player = Players.GetPlayerByUserId(source.UserId);
		if (player) this.handleChat(player, message.Text, "TextChatService");
	}

	/** Marks a whitelisted player, and applies the flags they start with. */
	private becomeDev(player: Player): void {
		player.SetAttribute(IS_DEV, true);

		for (const [flag, value] of pairs(DEV_CONFIG.defaultFlags)) {
			this.setFlag(player, flag, value);
		}

		print(`[Dev] ${player.Name} is a dev — ${this.describeFlags(player)}`);
	}

	/**
	 * `!dev <flag> <on|off>`, wherever in the message it sits.
	 *
	 * A non-dev gets no answer at all, not even a refusal: the command has no reason
	 * to advertise that it exists.
	 *
	 * `via` names the chat that delivered the text, and is for the log only.
	 */
	private handleChat(player: Player, message: string, via: string): void {
		// The duplicate check comes first, so a message delivered by both chats is
		// logged and acted on once.
		const previous = this.lastCommand.get(player);
		this.lastCommand.set(player, message);
		if (previous === message) return;

		if (DEBUG) print(`[Dev] ${via} <${message}> from ${player.Name}`);

		if (!this.isDev(player)) return;

		const words: string[] = [];
		for (const word of message.lower().split(" ")) {
			if (word !== "") words.push(word);
		}

		// **The command is looked for anywhere, not just at the front.** Nothing in the
		// chat contract promises a message arrives as it was typed — a configuration can
		// hand the server a prefixed line — and a command one word further along is still
		// obviously the command. It is dev-only, so the leniency costs nothing.
		let at = -1;
		for (let index = 0; index < words.size(); index++) {
			if (words[index] === PREFIX) {
				at = index;
				break;
			}
		}

		if (at < 0) return;

		const requested = this.findFlag(words[at + 1]);
		const state = words[at + 2];

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

	/**
	 * The syntax, and where every flag currently stands.
	 *
	 * The states are in here, not only in the line a dev gets on joining, because the
	 * question after a typo is "which of these are on?" — and a bare `!dev` lands here
	 * too, since no flag word fails the same test. That makes `!dev` on its own the way
	 * to read the current state, which is otherwise only visible in the chat log above
	 * you.
	 */
	private printUsage(player: Player): void {
		print(`[Dev] ${player.Name}: usage is ${PREFIX} <flag> <on|off> — ${this.describeFlags(player)}`);
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
