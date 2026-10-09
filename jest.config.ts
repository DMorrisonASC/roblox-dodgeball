import { defineConfig } from "@isentinel/jest-roblox";

/**
 * The project's first test config.
 *
 * **`backend: "studio-cli"` is explicit rather than `"auto"`**, because the choice is the kind of thing that
 * should be a decision and not a default: `auto` picks `studio-cli` when Studio is installed, and a failed
 * Studio attempt does *not* fall back to Open Cloud — it fails the run. Naming it says the local, headless
 * Studio is the intended backend, and a machine without Studio should fail loudly here rather than silently
 * trying something else.
 *
 * **`projects` is deliberately omitted, and the reason is a real one for this repo.** A *string* entry names a
 * DataModel path where the runner expects to find a `jest.config` stub already sitting in the place — so an
 * explicit list means "I have put a config there", not "these are my test roots". The documented default
 * (nothing here) derives one project per `luauRoots` mount from the tsconfig `outDir` and generates each
 * stub itself, which is what this project wants: `out/shared` is mounted at `ReplicatedStorage/TS` by
 * `default.project.json`, but the runner reads the mount from the Rojo project rather than being told the
 * path, so the spec's own example (`ReplicatedStorage/shared`) would name a folder that does not exist and
 * `ReplicatedStorage/TS` returns "Required config cannot be resolved" for the reason above. Omitting the key
 * is both the default and the only form that works without a stub in the place.
 */
export default defineConfig({
	backend: "studio-cli",
	// **The Jest framework has to be *in the place*, and it has to be a `ModuleScript`.** The plugin that
	// runs the suite lives in Studio, but the `Jest` module it drives is required out of the DataModel — and
	// `instance-resolver.luau` asserts both that the path resolves *and* that what it finds is a
	// `ModuleScript`. `@rbxts/jest` is the wrapper package and mounts as a plain Folder (because
	// `node_modules/@rbxts` is a flat `$path` mount and that package ships no project file), so pointing
	// there fails the second assertion. `@rbxts-js/Jest` is the real module, mounted from its own package's
	// `default.project.json` — see that mount in `default.project.json`, which also carries `JestGlobals`.
	jestPath: "ReplicatedStorage/rbxts_include/node_modules/@rbxts-js/Jest",
	// **No `placeFile`, deliberately.** The `studio-cli` backend builds its own place from the Rojo project —
	// which is the whole reason it is the right backend for this repo: the game is built *live* through
	// `rojo serve` into an open Studio, not saved to a `.rbxl`, so there is no place file to point at. The one
	// this key used to name (`roblox-ts-game.rbxl`, dated 9/24) was a two-week-old template that the game was
	// never built in, and it has been deleted rather than left to mislead the next reader. Leaving the key out
	// also avoids falling back to the CLI's own default of `./game.rbxl`, which does not exist here either.
	test: {
		outDir: "./out",
		// **Set explicitly, because the specs depend on it and the default is not visible from the outside.**
		// The specs cannot `import` `@rbxts/jest-globals` on this toolchain (see `src/types/jestGlobals.d.ts`
		// for the whole reason), so they rely on the runner putting `describe`, `it` and `expect` into the test
		// environment — which is what `injectGlobals` means and what it defaults to. A run without it leaves
		// those names `nil`, the first spec file dies at load, and the CLI reports it as "the jest plugin
		// produced no result" with no further detail: exactly the failure this line exists to rule out.
		injectGlobals: true,
	},
});
