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
- [ ] **Could this have been smaller?** If yes, say so — I would rather hear it than have it.
