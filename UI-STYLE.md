# How I want UI built

High-level shape and coupling. No palette, no pixel values, no fonts — those are decisions made in
one file and read everywhere else. This document is about *where things live* and *who is allowed to
know what*.

Portable: this is how I want UI built in any roblox-ts project, not one in particular.

---

## The one-line version

**A controller mounts; a builder builds; a theme paints; nothing invents a number twice.**

---

## 1. Controllers mount, they do not draw

One controller per HUD element. It subscribes to what it needs, and when it starts it builds its tree
and parents it to a **named layer**. That is the whole of its job.

The controller owns:

- which facts it reads,
- when it is visible,
- that it tears down what it built.

The controller does **not** own geometry another element also needs, colours, type sizes, or the
arithmetic that aligns it with a neighbour.

**A controller should read like a decision log, not like a layout.**

## 2. There are a handful of named layers, and you pick one on purpose

Not "a screen gui". A small fixed set — a HUD layer, a full-screen layer that draws *under*
everything so panels can cover it, a transition layer, an input layer — each with a stated draw order
and a stated reason for existing.

When you add one, **add it there with its reasoning attached**, not at the call site. Two controllers
each creating their own gui with their own draw order is the bug this set exists to prevent.

If you cannot say in one sentence which layer your element belongs to, that is a design question to
raise, not a coin to flip.

## 3. Shared geometry is a module, not a comment saying "keep in step"

This is the rule I care about most.

> Two offsets in two files are two literals that agree only because a comment says they do.

So: anything two elements must *agree* about goes into its own small module and both import it — the
edge they align on, the gap between stacked elements, the box one element derives its position from.

**And the corollary, which is the harder half: share only what two readers actually need.** The
shared module exports the alignment and the box; it does not export the other element's internal
width, because the first element has no opinion about it. A "layout constants" file that everything
dumps into is not this — it is a fourth place for a number to be wrong.

**Derive, don't duplicate.** If one element's position is a function of another's height, read the
height. If it is a function of another's box, import the box. Never re-type the number.

## 4. Position by anchor and arithmetic, not by absolute screen coordinates

Elements are anchored to a corner or an edge and positioned relative to their own parent chain.
Screen-space absolute coordinates are a different coordinate system, and using them to place
something inside a gui is how UI drifts on a device you did not test on.

Consequences to respect:

- **`Scale` means the parent's size**, not the viewport, unless the chain reaches a screen gui. Know
  which one you are talking to.
- **The caller's `AnchorPoint` is part of a positioning helper's contract.** If a helper assumes the
  element is bottom-anchored, say so in its doc — do not silently correct for it.
- **Auto-sized heights are read, never assumed.** A hard-coded clearance above an auto-sized element
  breaks the moment its content grows.
- There is no flexbox and no margin. Spacing is explicit — padding, gaps, list layout. Reaching for
  "margin" means thinking in CSS, which is not available.

## 5. Cap by the viewport, not by a pixel guess

An element that is safe on a monitor can be wider than the entire screen on a phone. The number that
is safe is different on every device, so **ask the viewport** rather than picking a maximum. Put that
in one small module and use it instead of a literal.

Related: **a device difference is a type size, not a scale factor.** Stepping a font variant down one
notch is predictable and testable. Multiplying every dimension by a fraction is not — it compounds
through a layout and produces numbers nobody chose.

## 6. Themes are layered by job, and a new direction gets a new module

Themes are not one object full of colours. They are a small set of modules, each owning one kind of
decision:

- **type scale and spacing** — one mapping, shared by everything, including looks that resemble each
  other in no other way;
- **paint** — the palette for a given visual direction;
- **one-off surfaces** — a distinct look used by one or two things, which gets its own module rather
  than entries in a shared one.

**A new look is a new module, not more entries in the existing map.** When two visual directions
exist in one game they are siblings, and each says why it is separate.

**Typography and spacing never fork per theme.** If a panel looks different, it is painted
differently; it is not typeset differently. That is what stops two visually unrelated surfaces
drifting into different grammars.

**Text goes through theme variants, never an ad-hoc size.** If a size is not in the scale, the scale
is missing a step — say so rather than writing a number.

---

## 6a. Building the theme structure, in full

Section 6 says what the modules are. This says how to wire them so that a change **cascades** — and
it starts with the thing that will trip an agent who learned UI on the web.

### Roblox has no cascade

In CSS a change cascades because the renderer inherits. **Roblox does not inherit.** Every
`TextLabel` carries its own `TextColor3`, every `Frame` its own `BackgroundColor3`. A theme here is
not a stylesheet; it is **a single source of truth plus the wiring that pushes it into every
instance.**

If any element picks its own colour, that element has opted out of the theme and will not follow
later changes. Building the theme *is* building the cascade. Four mechanisms do it, in this order.

### Step 1 — one contract type, slots named by job

```ts
export interface Theme {
  colors: {
    textPrimary; textSecondary; textDisabled;
    accent; success; warning; error;
    surface; panel; card; trough;   // ascending levels, not synonyms
    border; onAccent; shadow;
  };
  spacing: Spacing;
  typography: Typography;
}
```

- **Name slots by what they do, not where they come from.** `textOnDark` survives a palette swap;
  `blue500` does not.
- **`colors` is the only overridable group.** `spacing` and `typography` live in the type so
  consumers have one import, but see step 3 — directions may not move them.
- **Never add a slot named after a component.** `shopTileBackground` is a bug: the tile should ask
  for `card`. A per-component slot is custom styling wearing a theme's clothes.

### Step 2 — the base theme is a function, not a constant

Return a fresh object each call.

A UI library's theme table is usually **mutable** and gets merged into at boot. A `const THEME =
{...}` captured at import time is a snapshot of the pre-merge state and goes stale the moment
anything configures the library. A function is always read at use.

### Step 3 — a visual direction is an adapter over the base

Each direction is its own module exporting `xxxTheme(): Theme`:

```ts
export function darkTheme(): Theme {
  const base = baseTheme();
  return {
    colors: { textPrimary: RAW.text, surface: RAW.void, /* … */ },
    spacing: base.spacing,        // pass-through, deliberately
    typography: base.typography,  // pass-through, deliberately
  };
}
```

**This is the mechanism that makes the cascade hold.** Because `spacing` and `typography` are
*passed through by construction*, a direction cannot fork them without deliberately deleting a
line. Only `colors` is open. The cascade is enforced by the shape of the return, not by discipline.

Keep the **raw palette separate** from the theme. The palette module holds design-y names (`void`,
`raised`, `band`) and surface metrics (`corner`, `strokeThickness`, `transparency`). The adapter is
the *bridge*, and the bridge is where you state, per slot, which raw value fills it and why. That
mapping is a real decision — comment each line.

**In a dark direction the four surface levels must be four different values.** A light theme gets
structure for free — paper on paper. Collapse `surface`/`panel`/`card`/`trough` into one near-black
and you delete every boundary in the UI: a name bar drawn on a tile stops existing as a bar.
Ascending lightness buys back what the light theme got free.

### Step 4 — one mount point, the earliest thing on the client

A single boot step that:

1. pushes the active theme's colours into the UI library's global theme, and
2. merges **one** font into **every** typography variant.

Run it before anything is constructed. Two mount points are two orderings, and the second one wins
silently.

**Things the library will not take, get a sweep.** If there is no per-instance font setting, write
one helper that walks a subtree and forces `Font` on `TextLabel`/`TextButton`/`TextBox`, and call it
on each root as it is built. And **write the variant list out explicitly** if variants are exposed
as a type — a type is not enumerable, so a variant you forget silently keeps the library default.
That is the one failure invisible until someone notices a single label looks wrong.

### Step 5 — consumers import the contract and nothing else

- Every HUD reads the base or active-theme accessor. **Nothing outside the theme folder imports the
  raw palette.** That one rule is what makes "change it in one place" true, and it is greppable — so
  state it, and verify it.
- **Text size comes from a variant, never a literal.** If a size is missing, the scale is missing a
  step — say so rather than writing a number.
- **A device difference is a variant step down, not a scale multiplier.** `body1 → caption` is
  predictable; `× 0.8` compounds through a layout and produces numbers nobody chose.

### Step 6 — a one-off look is a sibling, not a branch

When a surface needs to look nothing like the rest, it gets **its own module deriving from the base
with only `colors` overridden** — not an `if (isPanel)` inside the shared theme, and not extra
entries in the shared map. Two visual directions in one game are siblings, and each says in its own
doc why it is separate.

### The test that proves it

Replace every colour in the palette module with a distinct loud one. **Every** GUI should change,
and nothing should be left in the old colours.

Anything that stays put has opted out of the theme. The fix is that element asking the contract for
a slot — not that element getting its own colour.

## 7. Non-theme shared modules: one rule, many tenants

Some things are neither a theme nor a component. Depth, glow, panel chrome, viewport bounds. These
live in their own module because **several unrelated elements need the same treatment and none of
them owns the others** — a dock button and a modal are not siblings, but they should be raised by the
same rule.

The test for creating one: *is there a rule here that two things which do not know about each other
must agree on?* If yes, module. If no, build it in place.

## 8. Do not build a framework

This is the failure mode to name out loud, because it is the one that looks responsible.

**No element type. No options object. No registry. No interface with one implementation.**

Shared chrome is a set of **builders** — each does exactly what the private method it replaced did. A
caller that wants something different is expected to build it, not to configure it. **The moment a
builder needs a flag to serve a second case, the abstraction is wrong**, and the second case should
be its own builder.

If a spec asks for ceremony here — an interface for one implementation, a service for one method —
say so. A smaller solution with a named trade-off beats a framework for a problem this project does
not have.

## 9. Fusion is not React

- Fine-grained reactivity. **No virtual DOM, no re-render.**
- A `Computed`'s dependencies are the `use()` calls that *actually ran*. A read inside an `if` is a
  subscription that exists only while that branch is taken — read it out of the branch if it must
  always be a dependency.
- Read a `Value` with `Fusion.peek` or through a `use` callback. There is no `.get()`.
- **big-ui components take their props at construction.** Changing contents means building a new one.
  Do not mutate a component's children and expect it to notice.
- `Text`/`Button` return plain instances with a theme applied — style the instance for anything the
  component does not take.

## 10. Everything prints once when it mounts

Each HUD element logs once, at mount, with the facts needed to diagnose it without a screenshot: its
box, its parent gui, its draw order, whether it is visible.

That is not noise. UI bugs arrive as "it is on top of the other thing" and "it is off-screen", and a
single geometry line turns a guess into a reading.

---

## Checklist before you report

- [ ] Does the controller only *mount*, with no layout arithmetic a neighbour also needs?
- [ ] Is every shared number imported rather than re-typed?
- [ ] Does the shared module export only what **two** readers need?
- [ ] Is anything positioned by absolute screen coordinates that should be anchored?
- [ ] Is any auto-sized height assumed rather than read?
- [ ] Are all sizes and colours from a theme, with no ad-hoc literals?
- [ ] Did a device difference become a type size rather than a scale factor?
- [ ] Did any builder grow a flag to serve a second case?
- [ ] Does the element print its geometry once at mount?
- [ ] **Does any file outside the theme folder import the raw palette?** (It should not.)
- [ ] **Is there a colour, font or size set on an instance anywhere that a theme slot should have
      supplied?** That instance has opted out of the cascade.
- [ ] **If a new direction was added:** is `spacing`/`typography` still passed through from the
      base rather than re-declared?
- [ ] **Could this have been smaller?** If yes, say so — I would rather hear it than have it.
