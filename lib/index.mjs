/**
 * dsh-image-webp-to-png
 *
 * Some LLM backends (notably llama.cpp, whose vision decoder is stb_image) cannot
 * decode WebP. DSH re-encodes any image that carries an alpha channel to WebP in
 * the attachment layer (`dsh-attachment-local` `encodingLadder`:
 * `hasAlpha ? "image/webp" : "image/jpeg"`), so those images arrive at such
 * backends as WebP and are rejected with
 *   `400 {"code":400,"message":"Failed to load image or audio file"}`.
 *
 * This bundle fixes that on the client side, at the seam the adapter actually
 * reads: `ctx.attachments.readImageRequest(ref, target, signal)`. It wraps that
 * method (once, idempotently) so that whenever the underlying store returns a
 * WebP request-image, we transparently re-encode those bytes to PNG — which
 * preserves the alpha channel, is decodable by every backend, and keeps the
 * same dimensions. Opaque images (JPEG) and images already emitted as PNG pass
 * through untouched.
 *
 * The wrapper is FAIL-OPEN: if anything goes wrong (sharp missing, decode error,
 * the seam not ready at load time) the original WebP result is returned unchanged
 * and DSH keeps working exactly as before. No request is ever blocked or failed
 * because of this bundle.
 *
 * Because it is a normal profile bundle, the wrapper is re-installed on every DSH
 * start, so the fix survives DSH updates without touching the root-owned
 * `/usr/lib/node_modules/.../dsh-attachment-local` file.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

export const name = "image-webp-to-png";
export const inject = ["attachments"];

const MARKER = Symbol.for("dsh.imageWebpToPng.wrapped");
const MAX_CACHE = 128;

/** Re-encode a WebP image buffer to PNG (dimensions + alpha preserved). */
export async function webpToPng(bytes) {
	const out = await getSharp()(bytes, { limit: 0 }).png({ compressionLevel: 6 }).toBuffer();
	return new Uint8Array(out);
}

let _sharp;
/** Resolve `sharp` from the DSH installation (it ships its own sharp). */
function getSharp() {
	if (_sharp) return _sharp;
	const localRequire = createRequire(import.meta.url);
	const candidates = [
		"/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/sharp",
		join("/usr/lib/node_modules/@deepseek-ai/dsh", "node_modules", "sharp"),
	];
	for (const candidate of candidates) {
		try {
			_sharp = createRequire(join(candidate, "package.json"))("sharp");
			return _sharp;
		} catch {
			/* try the next candidate */
		}
	}
	try {
		_sharp = localRequire("sharp");
		return _sharp;
	} catch {
		/* fall through */
	}
	throw new Error("dsh-image-webp-to-png: cannot resolve the sharp module from the DSH tree");
}

const cache = new Map(); // variantId -> PNG bytes (bounded)

/**
 * Wrap `attachments.readImageRequest` so WebP request-images come back as PNG.
 * Idempotent (guarded by MARKER). Returns true when the wrapper is in place.
 */
export function wrap(attachments, log) {
	if (!attachments || typeof attachments.readImageRequest !== "function") return false;
	if (attachments[MARKER]) return true;
	const original = attachments.readImageRequest.bind(attachments);
	const wrapped = async (ref, target, signal) => {
		const version = await original(ref, target, signal);
		if (!version || version.mediaType !== "image/webp" || !version.data || version.data.byteLength === 0) {
			return version;
		}
		const key = String(version.variantId ?? ref?.attachmentId ?? "");
		let png = cache.get(key);
		if (!png) {
			try {
				png = await webpToPng(version.data);
			} catch (error) {
				log?.warn?.(`dsh-image-webp-to-png: re-encode failed, keeping WebP: ${error?.message}`);
				return version;
			}
			cache.set(key, png);
			if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
		}
		return { ...version, data: png, mediaType: "image/png", bytes: png.byteLength };
	};
	try {
		attachments.readImageRequest = wrapped;
		attachments[MARKER] = true;
		log?.info?.("dsh-image-webp-to-png: wrapped attachments.readImageRequest (WebP -> PNG)");
		return true;
	} catch (error) {
		log?.warn?.(`dsh-image-webp-to-png: could not wrap the attachments seam: ${error?.message}`);
		return false;
	}
}

/** Bundle entry: install the wrapper (fail-open). */
export function apply(ctx, config) {
	if (config && config.enabled === false) return;
	const log = ctx?.logger ?? ctx;
	const resolve = () => {
		try {
			if (ctx && typeof ctx.attachments === "object" && ctx.attachments !== null) return ctx.attachments;
		} catch {
			/* use ctx.get fallback below */
		}
		try {
			if (ctx && typeof ctx.get === "function") return ctx.get("attachments");
		} catch {
			/* service not available yet */
		}
		return void 0;
	};
	try {
		if (!wrap(resolve(), log)) {
			// The core `attachments` service should already be up when a user bundle
			// loads, but if it is not, (re)try lazily on the first LLM stream — the
			// adapter needs the service, so it is guaranteed available by then.
			ctx?.on?.("llm/stream", (_options, next) => {
				try {
					wrap(resolve(), log);
				} catch {
					/* fail-open */
				}
				return next();
			});
		}
	} catch (error) {
		log?.warn?.(`dsh-image-webp-to-png: ${error?.message}`);
	}
}
