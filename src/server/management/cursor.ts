import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { ValidationError } from "~/errors";

/** A DynamoDB scan position can contain a host user key. Only sealed cursors leave the mount. */
export function directoryCursors(basePath: string, sharedKey?: Uint8Array) {
  const key = sharedKey ? Buffer.from(sharedKey) : randomBytes(32);
  if (key.length !== 32) throw new TypeError("cursorKey must contain 32 bytes.");
  const scope = (query: string) => Buffer.from(JSON.stringify([basePath, query]));
  return {
    seal(cursor: string, query: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(scope(query));
      const data = Buffer.concat([cipher.update(cursor, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
    },
    open(token: string, query: string) {
      try {
        if (!/^[A-Za-z0-9_-]{38,8192}$/.test(token)) throw new Error();
        const bytes = Buffer.from(token, "base64url");
        const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        cipher.setAAD(scope(query));
        cipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
      } catch {
        throw new ValidationError("Invalid directory cursor. Restart the search.", [
          { field: "cursor", message: "Restart the search." },
        ]);
      }
    },
  };
}
