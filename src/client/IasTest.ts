/**
 * **A test, not a feature.** Can the Input Action System see `I`/`J`/`K`/`L`?
 *
 * The question this answers: a player who can only use their left hand needs IJKL as an alternative
 * to WASD, and the supported path is a new `InputContext` rather than a fork of the `PlayerModule` —
 * but there are reports that IAS cannot override inputs the default controls already own. This file
 * finds out, and its result decides which of those two roads the feature takes:
 *
 * - **IJKL seen** → a small client controller that reads the action and feeds movement. The
 *   `PlayerModule` is untouched.
 * - **IJKL never seen** → the fallback is a fork, and that cost is justified by this output rather
 *   than by a guess.
 *
 * **It is built to be deleted.** One file, one call in `main.client.ts`, and both go when the answer
 * is in. It is not a Flamework controller on purpose — a controller registers itself in
 * `flamework.build`, and a test that edits the build manifest is a test nobody deletes cleanly.
 *
 * **It never touches the character.** Reading input and moving a body are two different questions,
 * and a test that does both produces an output nobody can read: the default controls would fight
 * whatever this fed them, and a broken walk would be indistinguishable from a broken binding.
 */
import { Players, ReplicatedStorage } from "@rbxts/services";

/**
 * The off switch. False and this file does nothing at all — `main.client.ts` need not change.
 *
 * **Off, because the test is finished and its scaffolding is now in the way.** The verdict is in a
 * log — *"WASD seen: no, IJKL seen: yes"* — and it names the road the feature took: build on the
 * Input Action System and leave the `PlayerModule` alone. What the file does *not* stop being is a
 * second `InputContext` at priority 2000, and the keys it binds (`I`, `K`, `J`, `L`) overlap the
 * ones the movement controller now reads, which makes any run with both alive ambiguous at exactly
 * the point the ambiguity matters. This is the file's own documented switch and it is the whole
 * change: nothing above this line is built while it is false, so the context is never created.
 *
 * **Deleting it is the follow-up and not this edit**, deliberately: the file has never been
 * committed, so deleting it here would lose it rather than retire it. It is one file and one call in
 * `main.client.ts` whenever the answer stops being worth keeping.
 */
const DEBUG = false;

/**
 * The context's priority.
 *
 * **`100` was the first guess and it is probably too low.** The Input Action System's own docs give
 * `2000` as the value that is "high enough to sink its bound inputs before the default
 * `PlayerScripts` contexts process them", which is the only published statement about where the
 * defaults sit — so `2000` is the number with evidence behind it and this is it. The value is
 * printed in the output, because a run that sees nothing needs to be able to say *which* priority
 * saw nothing.
 */
const TEST_PRIORITY = 2000;

/** How long the three-press protocol gets before the summary line prints, in seconds. */
const VERDICT_SECONDS = 20;

/** Whether each action has ever reported a value — the whole of the verdict. */
let sawWasd = false;
let sawIjkl = false;

/**
 * Runs the test, or does nothing. Called once from `main.client.ts`.
 *
 * Spawned rather than run inline for the reason every controller gives: it is called during the
 * client's boot and does not deserve to be part of it.
 */
export function startIasTest(): void {
	if (!DEBUG) return;

	task.spawn(() => run());
}

function run(): void {
	// **In every line, not implied by them.** A `Server & Clients` session runs this in each client,
	// and two interleaved sets of output with nothing in them saying whose they are is a log nobody
	// can read — which is exactly the session this test is most likely to be run in.
	const player = Players.LocalPlayer.Name;

	const context = buildContext();
	const wasd = buildAxisAction(context, "WASD", Enum.KeyCode.W, Enum.KeyCode.S, Enum.KeyCode.A, Enum.KeyCode.D);
	const ijkl = buildAxisAction(context, "IJKL", Enum.KeyCode.I, Enum.KeyCode.K, Enum.KeyCode.J, Enum.KeyCode.L);

	// **`StateChanged` and not `Pressed`/`Released`**, which the docs restrict to `Bool` actions —
	// a `Direction2D` action reports through `StateChanged` only, and that is where the `Vector2`
	// arrives. The value is printed unformatted rather than picked apart into X and Y: what matters
	// is that *something* arrived, and which of the four keys produced it is already answered by
	// which of the two actions spoke.
	wasd.StateChanged.Connect((value) => {
		sawWasd = true;
		print(`[IasTest] WASD -> ${tostring(value)}`);
	});

	ijkl.StateChanged.Connect((value) => {
		// Ungated, and printed the moment it happens rather than at the summary: this single line is
		// the answer, and a run that saw it does not have to wait twenty seconds to know.
		if (!sawIjkl) print("[IasTest] IJKL seen — IAS can read these keys");
		sawIjkl = true;

		print(`[IasTest] IJKL -> ${tostring(value)}`);
	});

	print(`[IasTest] ${player}: up — ${context.GetFullName()}, priority ${context.Priority}, Sink ${context.Sink}`);
	print(`[IasTest] ${player}: press W, then I, then both together. Verdict in ${VERDICT_SECONDS}s.`);

	task.delay(VERDICT_SECONDS, () => {
		print(
			`[IasTest] ${player}: verdict — WASD seen: ${sawWasd ? "yes" : "no"}, ` +
				`IJKL seen: ${sawIjkl ? "yes" : "no"}`,
		);

		// **The line that decides something.** It names the road the feature takes rather than leaving
		// the two booleans above to be re-derived by whoever reads the log next.
		if (sawIjkl) {
			print(
				`[IasTest] ${player}: go — IAS reads IJKL. Build the movement controller on it; ` +
					`the PlayerModule is not forked.`,
			);
		} else {
			print(
				`[IasTest] ${player}: no-go — IAS never reported an IJKL key. The fallback is a ` +
					`PlayerModule fork, and this output is what justifies it.`,
			);
		}
	});
}

/**
 * The context: `MovementTest`, at {@link TEST_PRIORITY}, **with `Sink` off**.
 *
 * **`Sink = false` is what keeps this from being a test that breaks the game.** The docs describe
 * sinking as consuming input events for the context's bound key codes and blocking them from
 * reaching lower-priority contexts — which is exactly what we would want *if* this context bound
 * WASD and meant to replace it, and exactly what we must not do while the question is still open.
 * This context reads IJKL and observes WASD; it must not stand in front of either.
 *
 * Parented under `ReplicatedStorage.Inputs`, which is where the docs put input contexts, and printed
 * with its full path so a run that sees nothing can be told apart from a run whose instances went
 * somewhere the engine does not read. A client may create these locally — they do not replicate, and
 * they are gone when the session is.
 */
function buildContext(): InputContext {
	let inputs = ReplicatedStorage.FindFirstChild("Inputs");

	if (inputs === undefined || !inputs.IsA("Folder")) {
		const folder = new Instance("Folder");
		folder.Name = "Inputs";
		folder.Parent = ReplicatedStorage;
		inputs = folder;
	}

	const context = new Instance("InputContext");
	context.Name = "MovementTest";
	context.Enabled = true;
	context.Priority = TEST_PRIORITY;
	context.Sink = false;
	context.Parent = inputs;

	return context;
}

/**
 * One `Direction2D` action with one keyboard binding on it.
 *
 * **Two actions rather than one action with two bindings, and that is a correction to the test as it
 * was first specified.** With `W`/`A`/`S`/`D` and `I`/`J`/`K`/`L` bound to the *same* action, the
 * action reports one merged `Vector2` and nothing in the output says which key produced it — so
 * `W` and `I` are indistinguishable, and no run of any length could ever answer the question this
 * file exists to ask. Two actions make each key's arrival attributable: `WASD ->` appears when a WASD
 * key is pressed and `IJKL ->` appears when an IJKL key is, and the presence or absence of the
 * second line *is* the verdict. Whether a single action carrying both sets merges them sensibly is a
 * separate question — a good one for the implementation, and not for this test.
 */
function buildAxisAction(
	context: InputContext,
	name: string,
	up: Enum.KeyCode,
	down: Enum.KeyCode,
	left: Enum.KeyCode,
	right: Enum.KeyCode,
): InputAction {
	const action = new Instance("InputAction");
	action.Name = name;
	action.Type = Enum.InputActionType.Direction2D;
	action.Parent = context;

	// One binding per hardware kind is what the docs recommend for a shipping action — gamepad and
	// touch included. Deliberately one here: this test is about a *keyboard* question, and an
	// unbound gamepad is not a missing feature in a throwaway.
	const binding = new Instance("InputBinding");
	binding.Name = "Keyboard";
	binding.Type = Enum.InputBindingType.Automatic;
	binding.Up = up;
	binding.Down = down;
	binding.Left = left;
	binding.Right = right;
	binding.Parent = action;

	return action;
}
