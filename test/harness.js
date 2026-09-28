/**
 * Handler-level test harness.
 *
 * The lib/ tests cover the billing and reset math. They cannot cover the three
 * things the HIGH findings were actually about — the daily reset call in
 * api/translate.js, the auth gate, and the transaction wiring — because all of
 * that lives in the handlers, which import firebase-admin at module scope.
 *
 * `installFakeAdmin()` shadows firebase-admin's namespace getters with fakes
 * BEFORE a handler is imported, so `const db = admin.firestore()` at module
 * scope binds to the fake. The fake delegates to a per-test store, since ESM
 * evaluates each handler module only once per process.
 */
import admin from 'firebase-admin';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { todayString } from '../lib/liveQuota.js';

const clone = (value) => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)));

const INCREMENT = '__fakeIncrement';
const DELETE = '__fakeDelete';

const applyField = (existing, value) => {
  if (value && typeof value === 'object' && INCREMENT in value) return (existing || 0) + value[INCREMENT];
  return value;
};

/**
 * Enough of Firestore to run the handlers honestly: merge/replace semantics,
 * FieldValue sentinels, and — the part that matters for the day-boundary race —
 * transactions that detect a concurrent write to a document they read and
 * re-run, the way a real server-side transaction does.
 */
export class FakeFirestore {
  constructor(initial = {}) {
    this.docs = new Map(Object.entries(initial).map(([path, data]) => [path, clone(data)]));
    this.versions = new Map([...this.docs.keys()].map((path) => [path, 1]));
    this.reads = 0;
    this.writes = 0;
    this.transactionAttempts = 0;
    // One-shot: fires right after the next read, so a test can commit a
    // competing write in the exact window between a read and its update.
    this.onNextRead = null;
  }

  get touched() {
    return this.reads + this.writes;
  }

  raw(path) {
    return this.docs.has(path) ? clone(this.docs.get(path)) : null;
  }

  /** A write that did not come from a handler — the competing endpoint. */
  commitExternal(path, data) {
    this._write(path, data, { merge: true });
  }

  _read(path) {
    this.reads += 1;
    const exists = this.docs.has(path);
    const data = exists ? clone(this.docs.get(path)) : undefined;
    const hook = this.onNextRead;
    if (hook) {
      this.onNextRead = null;
      hook(path);
    }
    return { exists, data: () => data };
  }

  _write(path, update, { merge = true, requireExists = false } = {}) {
    this.writes += 1;
    if (requireExists && !this.docs.has(path)) {
      throw new Error(`No document to update at ${path}`);
    }

    const current = merge ? clone(this.docs.get(path)) || {} : {};
    for (const [field, value] of Object.entries(update)) {
      if (value && typeof value === 'object' && DELETE in value) {
        delete current[field];
      } else {
        current[field] = applyField(current[field], value);
      }
    }

    this.docs.set(path, current);
    this.versions.set(path, (this.versions.get(path) || 0) + 1);
  }

  _ref(path) {
    return {
      path,
      get: async () => this._read(path),
      set: async (data, options = {}) => this._write(path, data, { merge: Boolean(options.merge) }),
      update: async (data) => this._write(path, data, { merge: true, requireExists: true }),
    };
  }

  collection(name) {
    return { doc: (id) => this._ref(`${name}/${id}`) };
  }

  async runTransaction(fn, { maxAttempts = 5 } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.transactionAttempts = attempt;
      const readVersions = new Map();
      const pending = [];

      const tx = {
        get: async (ref) => {
          // Recorded before the read, because a read hook may itself commit the
          // competing write this transaction has to notice.
          readVersions.set(ref.path, this.versions.get(ref.path) || 0);
          return this._read(ref.path);
        },
        set: (ref, data, options = {}) => pending.push({ ref, data, merge: Boolean(options.merge) }),
        update: (ref, data) => pending.push({ ref, data, merge: true, requireExists: true }),
      };

      const result = await fn(tx);

      const stale = [...readVersions].some(([path, version]) => (this.versions.get(path) || 0) !== version);
      if (stale) continue;

      for (const write of pending) {
        this._write(write.ref.path, write.data, { merge: write.merge, requireExists: write.requireExists });
      }
      return result;
    }

    throw new Error('Transaction failed after too many contention retries');
  }
}

let currentStore = null;
let currentVerify = async () => {
  throw new Error('verifyIdToken not stubbed for this test');
};

const fakeDb = {
  collection: (name) => currentStore.collection(name),
  runTransaction: (fn) => currentStore.runTransaction(fn),
};

const fakeFirestore = () => fakeDb;
fakeFirestore.FieldValue = {
  increment: (amount) => ({ [INCREMENT]: amount }),
  delete: () => ({ [DELETE]: true }),
};

const shadow = (target, name, value) =>
  Object.defineProperty(target, name, { value, configurable: true, writable: true });

export const installFakeAdmin = () => {
  // The handlers read these at module scope before initializeApp; a missing key
  // would throw inside .replace() and drown the test output in stack traces.
  process.env.FIREBASE_PROJECT_ID = 'test-project';
  process.env.FIREBASE_CLIENT_EMAIL = 'test@example.com';
  process.env.FIREBASE_PRIVATE_KEY = 'test-key';
  process.env.GEMINI_API_KEY = 'test-gemini-key';

  shadow(admin, 'firestore', fakeFirestore);
  shadow(admin, 'auth', () => ({ verifyIdToken: (token) => currentVerify(token) }));
  shadow(admin, 'credential', { cert: () => ({}) });
  shadow(admin, 'initializeApp', () => ({}));
};

export const useStore = (initial = {}) => {
  currentStore = new FakeFirestore(initial);
  return currentStore;
};

/** Accept any token and report this uid. */
export const acceptToken = (uid) => {
  currentVerify = async () => ({ uid });
};

/** Reject every token, the way an expired or forged one is rejected. */
export const rejectToken = (message = 'Decoding Firebase ID token failed') => {
  currentVerify = async () => {
    throw new Error(message);
  };
};

export const makeReq = ({ method = 'POST', headers = {}, body = {} } = {}) => ({ method, headers, body });

export const makeRes = () => ({
  statusCode: null,
  body: null,
  headers: {},
  ended: false,
  setHeader(key, value) {
    this.headers[key] = value;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
  end() {
    this.ended = true;
    return this;
  },
});

/** Stub the Gemini text model and capture what the handler asked it for. */
export const stubGemini = ({
  detected = 'Thai',
  translations = [{ lang: 'English', text: 'Hello' }],
  totalTokenCount = 100,
  // Errors to throw before the first success, one per call — lets a test drive
  // the retry path without waiting on a real backoff.
  failWith = [],
} = {}) => {
  const calls = [];

  GoogleGenerativeAI.prototype.getGenerativeModel = function getGenerativeModel(modelConfig) {
    return {
      generateContent: async (request) => {
        calls.push({ modelConfig, request });
        const failure = failWith[calls.length - 1];
        if (failure) throw failure;
        return {
          response: {
            text: () => JSON.stringify({ detected, translations }),
            usageMetadata: { totalTokenCount },
          },
        };
      },
    };
  };

  return calls;
};

/** Stub the ephemeral-token mint. Returns the array of fetch calls made. */
export const stubTokenMint = ({ ok = true, status = 200, name = 'ephemeral-token' } = {}) => {
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok,
      status,
      json: async () => ({ name }),
      text: async () => 'mint rejected',
    };
  };

  return calls;
};

/**
 * Must use the handlers' own day rule. When this computed a UTC date and the
 * handlers cut the day at Bangkok midnight, every reset assertion silently
 * inverted for the seven hours between 17:00Z and midnight Z.
 */
export const dateString = (offsetDays = 0) =>
  todayString(new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000));

export const TODAY = () => dateString(0);
export const YESTERDAY = () => dateString(-1);
