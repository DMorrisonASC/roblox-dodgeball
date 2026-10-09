/**
 * The Jest globals, declared for the compiler because the specs cannot import them.
 *
 * **Why this file exists at all — the toolchain blocker, stated once.** Under this project's pins
 * (Flamework 1.3.2 → roblox-ts 3.0.0 → TypeScript 5.5.3) the specs cannot `import` the globals from
 * `@rbxts/jest-globals` without dying at that import with:
 *
 * ```
 * roblox-ts: Invalid module access! Do you have multiple TS runtimes trying to import this?
 * ```
 *
 * That message comes from `include/RuntimeLib.lua`, and what it compares is **`_G[module]`**: a global keyed
 * by the module *instance*, holding the `TS` runtime that loaded it. A module loaded by a second runtime
 * errors rather than being loaded twice. The plugin drives the suite with its *own* embedded roblox-ts
 * runtime, so the moment a spec file makes the place's runtime `require` the globals module, two runtimes
 * have touched one instance and the second one loses.
 *
 * **It is therefore the import that is fatal, not the globals.** `jest-roblox` runs with `injectGlobals`
 * on by default — the globals are *injected into the test environment* — so the specs do not need to import
 * them at all, and not importing them means the place's runtime never touches that module. This file gives
 * TypeScript the names it needs to compile; the values come from the runner at run time.
 *
 * **Hand-written signatures rather than a re-export of the package's own types, and the reason is the same
 * one.** A `.d.ts` containing a top-level `import type` becomes a *module*, and a module's `declare`s are
 * module-scoped — so the types could not be brought in without both defeating this file's purpose and, in
 * the emitted program, risking the very require it exists to avoid. The cost is drift: these signatures are
 * a hand-written subset of `@rbxts/jest-globals`' own `index.d.ts`, and a matcher used by a future spec
 * must be added here as well as used there. That is the price of a global script, and it is a smaller price
 * than a suite that cannot run.
 *
 * **No `jest` namespace beyond `fn`.** The one member any of these specs could want is `jest.fn()`, whose
 * real signature is a `LuaTuple<[mock, fn]>` — the two-value return the JS-Jest-trained reader gets wrong.
 * Everything else in the namespace is added here the first time a test needs it, rather than guessed at.
 */

interface JestMatchers {
	/** Identity, for primitives. */
	toBe(expected: unknown): void;
	/** `nil`, which is Luau's `null` — `toBeNull` is not a thing here. */
	toBeNil(): void;
	toBeGreaterThan(expected: number): void;
	/** Inversion. Luau has no `.not` — `not` is a reserved word. */
	readonly never: JestMatchers;
}

declare function expect(actual: unknown): JestMatchers;

declare function describe(name: string, fn: () => void): void;
declare function it(name: string, fn: () => void, timeout?: number): void;
declare function test(name: string, fn: () => void, timeout?: number): void;

declare function beforeEach(fn: () => void): void;
declare function afterEach(fn: () => void): void;
declare function beforeAll(fn: () => void): void;
declare function afterAll(fn: () => void): void;

declare const jest: {
	/** Returns **two** values: the mock and a forwarding function. See the note above. */
	readonly fn: (...args: never[]) => LuaTuple<[unknown, (...args: never[]) => unknown]>;
};
