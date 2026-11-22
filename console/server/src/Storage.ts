import { Storage } from "@highalch/console-domain/Storage.external";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Bucket } from "./Bucket.ts";
import { Links } from "./Links.ts";

/** R2's checksum header: the body's SHA-256, base64. */
export const checksumHeader = "x-amz-checksum-sha256";

/** Base64 of a hex digest, as `x-amz-checksum-sha256` carries it. */
export const base64OfHex = (hex: string) =>
  Result.match(Hex.decode(hex), { onSuccess: Base64.encode, onFailure: () => "" });

const Items = Schema.fromJsonString(Schema.Array(Schema.Json));

/**
 * The domain's `Storage` over the artifact bucket. A PUT link binds the exact content type,
 * length and SHA-256 (R2 refuses any other body); a GET link is signed for the artifact origin,
 * which serves it as the domain decided. A bucket that does not answer is a defect: the policy
 * that called is redelivered and retries.
 */
export const StorageLive = Storage.toLayer(
  Effect.gen(function* () {
    const bucket = yield* Bucket;
    const links = yield* Links;
    const digest = yield* Digest.Digest;
    const encoder = new TextEncoder();
    return {
      inspect: Effect.fn("Storage.inspect")(function* ({ key, bytes, sha256 }) {
        const head = yield* bucket.head(key);
        if (Option.isNone(head)) return { status: "missing" as const };
        // an upload through a link always carries its checksum; read the body when it did not
        const actual = Option.isSome(head.value.sha256)
          ? head.value.sha256.value
          : yield* Effect.flatMap(bucket.get(key), (body) =>
              Option.isSome(body)
                ? Effect.flatMap(body.value.bytes, (b) => digest.digestHex(Digest.sha256, b))
                : Effect.succeed(""),
            );
        if (head.value.size === bytes && actual === sha256) return { status: "ok" as const };
        yield* bucket.remove([key]);
        return { status: "mismatch" as const };
      }, Effect.orDie),
      readItems: Effect.fn("Storage.readItems")(function* ({ key, limit }) {
        const body = yield* bucket.get(key);
        if (Option.isNone(body)) return { items: [], total: 0 };
        const text = new TextDecoder().decode(yield* body.value.bytes);
        const items = yield* Schema.decodeUnknownEffect(Items)(text);
        return { items: items.slice(0, limit), total: items.length };
      }, Effect.orDie),
      writeJson: Effect.fn("Storage.writeJson")(function* ({ key, value }) {
        const body = encoder.encode(JSON.stringify(value));
        yield* bucket.put(key, body, "application/json");
        return { bytes: body.byteLength };
      }, Effect.orDie),
      remove: Effect.fn("Storage.remove")(function* ({ keys }) {
        if (keys.length > 0) yield* bucket.remove(keys);
        return {};
      }, Effect.orDie),
      presignPut: Effect.fn("Storage.presignPut")(function* ({
        key,
        mime,
        bytes,
        sha256,
        seconds,
      }) {
        const headers = {
          "content-type": mime,
          "content-length": String(bytes),
          [checksumHeader]: base64OfHex(sha256),
        };
        return { url: yield* bucket.presignPut({ key, headers, seconds }), headers };
      }, Effect.orDie),
      presignGet: Effect.fn("Storage.presignGet")(function* ({ key, mime, name, seconds }) {
        return { url: yield* links.sign({ key, mime, name, seconds }) };
      }),
    };
  }),
);
