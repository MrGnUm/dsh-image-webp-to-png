# dsh-image-webp-to-png

A DeepSeek Harness (DSH) **bundle** that fixes the `400: Failed to load image or
audio file` error you get when sending **alpha-channel images** to a backend that
cannot decode WebP — most notably **llama.cpp** (its vision decoder is `stb_image`,
which has no WebP support).

It is an installable plugin: it lives in your profile, is **re-applied on every DSH
start**, and **survives DSH updates** without touching the root-owned
`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-attachment-local`
file.

---

## Why images fail

DSH normalizes every attached image in `dsh-attachment-local`. The codec choice is
hard-coded (`encodingLadder`):

```js
const mediaType = hasAlpha ? "image/webp" : "image/jpeg";
```

So **any image with an alpha channel** is re-encoded to **WebP**. (A clean 8-bit
sRGB image with no metadata that fits the size/limit budget passes through as-is;
opaque images become JPEG.)

- Opaque → **JPEG** → llama.cpp decodes it fine.
- Alpha → **WebP** → llama.cpp's `stb_image` cannot decode WebP → the request is
  rejected with `400 {"code":400,"message":"Failed to load image or audio file"}`
  and the server logs `E mtmd_helper_bitmap_init_from_buf: failed to decode webp buffer`.

There is **no configuration knob** in `dsh-attachment-local` to change this codec,
and the server side (llama.cpp) is not going to add a WebP decoder, so the fix
belongs on the client.

## How the bundle fixes it

The adapter (e.g. `dsh-llm-pi-ai`, used by your `fedotov` provider) builds the
outgoing request by calling the attachment seam:

```js
attachments.readImageRequest(ref, target, signal)  // -> { data, mediaType, width, height, ... }
```

This bundle wraps that **one** seam method at DSH start (idempotently, guarded by a
`Symbol`). Whenever the underlying store returns a **WebP** request-image, the
wrapper transparently re-encodes those bytes to **PNG**:

- PNG **preserves the alpha channel** (JPEG would flatten it).
- PNG is decodable by **every** backend (llama.cpp, OpenAI-compatible, …).
- Dimensions are unchanged (pure format conversion, no resize).
- The result is **cached** by `variantId`, so a given image is re-encoded once.

Everything else passes through untouched (JPEG stays JPEG, PNG stays PNG).

The wrapper is **fail-open**: if `sharp` is missing, a decode fails, or the seam is
not ready at load time, the original WebP result is returned unchanged and DSH
keeps working exactly as before. This bundle can never block or fail a request.

## Files

```
dsh-image-webp-to-png/
├── package.json        # bundle manifest (dsh.bundle.patch)
├── cordis.patch.yml    # self-declares the entry (id: image-webp-to-png)
├── lib/index.mjs       # the bundle: wrap(attachments) + webpToPng()
├── install.sh          # install into a profile (default: web)
└── uninstall.sh        # remove from a profile
```

## Install

Requirements: `pnpm` on PATH, and a DSH profile (default `~/.dsh/profiles/web`).

```bash
cd dsh-image-webp-to-png
./install.sh                      # -> ~/.dsh/profiles/web
# or a different profile:
DSH_PROFILE_DIR=/path/to/profile ./install.sh
```

`install.sh` (idempotent, backs up `package.json` first):

1. Adds `dsh-image-webp-to-png` as a `link:` dependency pointing at this directory.
2. Adds it to the profile's `dsh.profile.bundles` array.
3. Runs `pnpm install` in the profile to create the symlink + update the lockfile.

The fix takes effect on the **next DSH web session** (immediately if the profile
has `patchReload: "live"`).

## Verify

Send an **alpha-channel image** (a PNG with transparency) to your `fedotov` model
and ask it to describe it. Before the bundle: `400 … Failed to load image or
audio file`. After: the model describes the image.

You can also watch the DSH logs for the one-time line:
`dsh-image-webp-to-png: wrapped attachments.readImageRequest (WebP -> PNG)`.

## Revert

```bash
./uninstall.sh                                  # clean removal
# or, using the backup install.sh made:
./uninstall.sh ~/.dsh/profiles/web/package.json.bak-<timestamp>
```

## For the admin (server side, optional)

The client-side fix above is sufficient. If you would rather fix it at the source,
the root cause is the hard-coded `hasAlpha ? "image/webp" : "image/jpeg"` in
`dsh-attachment-local/lib/index.js` (`encodingLadder`, and the matching
`pipeline.webp(...)` branch in `encode()`). Upstream has no option to emit PNG for
alpha images; a small patch adding a PNG branch (and bumping the
`request-image-v6` transform version so stale WebP cache entries are regenerated)
would remove the need for this bundle.

## Compatibility notes

- Works with any DSH profile that mounts the local attachment store
  (`LocalAttachmentStore`). If a future DSH changes the seam method name
  (`readImageRequest`) or its return shape, the wrapper degrades to a no-op
  (fail-open) and the original behaviour resumes.
- `sharp` is resolved from the DSH installation
  (`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/sharp`); this bundle has
  no runtime dependencies of its own.
