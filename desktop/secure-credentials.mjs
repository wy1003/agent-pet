import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE_VERSION = 1;
const MAX_NAMESPACE_LENGTH = 128;
const MAX_NAMESPACE_COUNT = 64;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_STORE_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function credentialError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateNamespace(namespace) {
  if (
    typeof namespace !== "string"
    || namespace.length > MAX_NAMESPACE_LENGTH
    || !NAMESPACE_PATTERN.test(namespace)
  ) {
    throw credentialError(
      "secure_credentials_invalid_namespace",
      `Credential namespace must be 1-${MAX_NAMESPACE_LENGTH} ASCII letters, digits, dots, colons, underscores, or hyphens.`,
    );
  }
  return namespace;
}

function normalizeValue(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw credentialError(
      "secure_credentials_invalid_payload",
      "Credential payload must be JSON serializable.",
    );
  }
  if (serialized === undefined) {
    throw credentialError(
      "secure_credentials_invalid_payload",
      "Credential payload must be JSON serializable.",
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_VALUE_BYTES) {
    throw credentialError(
      "secure_credentials_payload_too_large",
      `Credential payload must not exceed ${MAX_VALUE_BYTES} bytes.`,
    );
  }
  return { serialized, value: JSON.parse(serialized) };
}

function emptyEntries() {
  return Object.create(null);
}

function isStrictBase64(value) {
  if (typeof value !== "string" || !value || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

/**
 * Stores small JSON credential records using an injected Electron-safeStorage-like backend.
 * The complete namespace map is encrypted, so neither values nor namespace names are exposed
 * in the on-disk JSON envelope.
 */
export class SecureCredentials {
  constructor(filePathOrOptions, injectedBackend) {
    const options = typeof filePathOrOptions === "object" && filePathOrOptions !== null
      ? filePathOrOptions
      : { filePath: filePathOrOptions, encryptionBackend: injectedBackend };
    if (typeof options.filePath !== "string" || !options.filePath.trim()) {
      throw new TypeError("SecureCredentials requires a filePath.");
    }
    this.filePath = path.resolve(options.filePath);
    this.encryptionBackend = options.encryptionBackend;
    this.writeQueue = Promise.resolve();
  }

  async load(namespace) {
    const key = validateNamespace(namespace);
    await this.writeQueue.catch(() => {});
    const entries = await this.#readEntries();
    if (!Object.hasOwn(entries, key)) return null;
    return normalizeValue(entries[key]).value;
  }

  async save(namespace, value) {
    const key = validateNamespace(namespace);
    const normalized = normalizeValue(value);
    return this.#enqueueWrite(async () => {
      this.#requireEncryption();
      const entries = await this.#readEntries();
      if (!Object.hasOwn(entries, key) && Object.keys(entries).length >= MAX_NAMESPACE_COUNT) {
        throw credentialError(
          "secure_credentials_namespace_limit",
          `Secure credential storage supports at most ${MAX_NAMESPACE_COUNT} namespaces.`,
        );
      }
      entries[key] = normalized.value;
      await this.#writeEntries(entries);
      return normalizeValue(normalized.value).value;
    });
  }

  async clear(namespace) {
    const key = validateNamespace(namespace);
    return this.#enqueueWrite(async () => {
      this.#requireEncryption();
      const entries = await this.#readEntries();
      if (!Object.hasOwn(entries, key)) return false;
      delete entries[key];
      if (Object.keys(entries).length === 0) {
        await rm(this.filePath, { force: true });
      } else {
        await this.#writeEntries(entries);
      }
      return true;
    });
  }

  async has(namespace) {
    const key = validateNamespace(namespace);
    await this.writeQueue.catch(() => {});
    const entries = await this.#readEntries();
    return Object.hasOwn(entries, key);
  }

  #enqueueWrite(operation) {
    const pending = this.writeQueue.catch(() => {}).then(operation);
    this.writeQueue = pending;
    return pending;
  }

  #isEncryptionAvailable() {
    try {
      return Boolean(
        this.encryptionBackend
        && typeof this.encryptionBackend.isEncryptionAvailable === "function"
        && typeof this.encryptionBackend.encryptString === "function"
        && typeof this.encryptionBackend.decryptString === "function"
        && this.encryptionBackend.isEncryptionAvailable(),
      );
    } catch {
      return false;
    }
  }

  #requireEncryption() {
    if (!this.#isEncryptionAvailable()) {
      throw credentialError(
        "secure_storage_unavailable",
        "Operating-system credential encryption is unavailable; credentials were not saved.",
      );
    }
  }

  async #readEntries() {
    let raw;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return emptyEntries();
      throw error;
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_FILE_BYTES) return emptyEntries();

    try {
      if (!this.#isEncryptionAvailable()) return emptyEntries();
      const envelope = JSON.parse(raw);
      if (
        envelope?.version !== FILE_VERSION
        || Object.keys(envelope).some((key) => key !== "version" && key !== "ciphertext")
        || !isStrictBase64(envelope.ciphertext)
      ) {
        return emptyEntries();
      }
      const plaintext = this.encryptionBackend.decryptString(
        Buffer.from(envelope.ciphertext, "base64"),
      );
      if (
        typeof plaintext !== "string"
        || Buffer.byteLength(plaintext, "utf8") > MAX_STORE_BYTES
      ) {
        return emptyEntries();
      }
      const payload = JSON.parse(plaintext);
      if (
        payload?.version !== FILE_VERSION
        || !payload.entries
        || typeof payload.entries !== "object"
        || Array.isArray(payload.entries)
      ) {
        return emptyEntries();
      }
      const keys = Object.keys(payload.entries);
      if (keys.length > MAX_NAMESPACE_COUNT) return emptyEntries();
      const entries = emptyEntries();
      for (const key of keys) {
        validateNamespace(key);
        entries[key] = normalizeValue(payload.entries[key]).value;
      }
      return entries;
    } catch {
      return emptyEntries();
    }
  }

  async #writeEntries(entries) {
    const plaintext = JSON.stringify({ version: FILE_VERSION, entries });
    if (Buffer.byteLength(plaintext, "utf8") > MAX_STORE_BYTES) {
      throw credentialError(
        "secure_credentials_store_too_large",
        `Secure credential storage must not exceed ${MAX_STORE_BYTES} bytes.`,
      );
    }
    let encrypted;
    try {
      encrypted = this.encryptionBackend.encryptString(plaintext);
    } catch (error) {
      throw credentialError(
        "secure_credentials_encryption_failed",
        `Credential encryption failed: ${error?.message || "unknown error"}`,
      );
    }
    if (!Buffer.isBuffer(encrypted) && !(encrypted instanceof Uint8Array)) {
      throw credentialError(
        "secure_credentials_encryption_failed",
        "Credential encryption did not return encrypted bytes.",
      );
    }
    const envelope = `${JSON.stringify({
      version: FILE_VERSION,
      ciphertext: Buffer.from(encrypted).toString("base64"),
    }, null, 2)}\n`;
    if (Buffer.byteLength(envelope, "utf8") > MAX_FILE_BYTES) {
      throw credentialError(
        "secure_credentials_store_too_large",
        `Encrypted credential storage must not exceed ${MAX_FILE_BYTES} bytes.`,
      );
    }

    const directory = path.dirname(this.filePath);
    const temporaryPath = path.join(directory, `.secure-credentials-${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, envelope, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

export { SecureCredentials as SecureCredentialStore, SecureCredentials as SecureCredentialsStore };
export default SecureCredentials;
