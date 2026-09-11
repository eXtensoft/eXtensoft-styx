---
title: Contextual help
tags: [hosting, client]
---
# Contextual help

The docs page is a destination; sometimes help should come to the user instead. A **(?)**
beside any control can open a slide-in panel showing one page from your corpus — no
navigation away, no second documentation system.

## The recipe

```html
<button id="grid-help">?</button>
<script type="module">
  import lucid from '/lucid/lucid.mjs';
  document.querySelector('#grid-help').addEventListener('click', () =>
    lucid.panel({ api: '/api/docs', id: 'guide/filtering', docsUrl: '/docs' }));
</script>
```

That is the whole integration. You own the buttons and decide which page each one opens;
Lucid owns the panel.

| `lucid.panel` | Meaning |
|---|---|
| `api` | Same as `init` — the corpus to read. Different buttons may use different corpora. |
| `id` | The page to show. `id: 'guide/filtering#sorting'` jumps to a heading. |
| `docsUrl` | Optional. The page hosting your full docs mount; when set, the panel header links there ("Full documentation →") at the current page. |

## Wiring the buttons

**Server-rendered pages.** Name the page on the button and let one delegated listener cover the
whole app — written once, in `_Layout`:

```html
<button class="help-btn" data-help="guide/tickets" title="How the queue works">?</button>

<script type="module">
  import lucid from '/lucid/lucid.mjs';
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-help]');
    if (b) lucid.panel({ api: '/api/docs', id: b.dataset.help, docsUrl: '/Docs' });
  });
</script>
```

**Pages that build their DOM in JavaScript.** The listener above is on `document`, so buttons your
module renders later are already wired — there is nothing to re-run after a re-render. Call `panel`
yourself when the id is computed rather than written in markup:

```js
import lucid from '/lucid/lucid.mjs';

class TicketsPage {
  init(config = {}) {
    this.api = config.docsApi ?? '/api/docs';
    this.root.querySelector('.queue-help')
        .addEventListener('click', () => this.help('guide/tickets'));
  }
  help(id) { lucid.panel({ api: this.api, id, docsUrl: '/Docs' }); }
}
export default new TicketsPage();
```

The two mix freely: importing the same module URL twice gives the same instance, and the panel is a
singleton — one drawer, its content swapped per call.

## How the panel behaves

- It slides in pinned to the right edge of the window and closes with **×** or Escape.
  Clicking the same (?) again also closes it.
- Links to other corpus pages navigate *inside the panel*, with a Back button. The page URL
  is never touched, so it cannot fight your router or a docs mount on the same page.
- Links into your app and external links behave exactly as on the docs page: current tab
  unless the markup says `{target=_blank}`.
- It is read-only, always. Editing happens on the docs page.
- If the page does not exist — or [is hidden from this user](../content/editing.md#who-may-read-what) —
  the panel says "No help is available here." rather than erroring. Role filtering applies
  automatically; there is nothing to configure twice.

## A custom hash prefix has no link

The header link is built as `${docsUrl}#/${id}`. If your docs page mounts the reader under a
`hashBase` other than the default — `lucid.init({ hashBase: '#/help/' })`, as a hash-routed host
whose own router owns `#/…` must — then no value of `docsUrl` reaches it: `/` yields a link that
router ignores, `/#/help` yields two hashes. Omit `docsUrl` until this is fixed; the panel simply
shows no link.

## Theming

The panel sits at `document.body`, outside any themed mount, so give it the same
`--lucid-*` custom properties on `body` (or any ancestor). A theme saved in the corpus's
`_theme.json` overrides those, exactly as on the docs page.

## Writing help pages

They are ordinary pages. A page can serve both the manual and a (?) — most should. If you
accumulate panel-only micro-pages that would clutter the docs sidebar, give them their own
corpus and point the buttons' `api` at it.
