import { readFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { OutgoingHttpHeaders } from 'http';

import { WASI } from 'node:wasi';
import { NextFunction, Request, Response } from 'express';
// Cheat by using one of express's dependencies, not a new one
import getRawBody from 'raw-body';
import { WASIOptions } from 'wasi';

interface Options {
  wasmPath: string;
  config?: Buffer;
  wasi?: WASIOptions;
}

enum HeaderKind {
  REQUEST = 0,
  RESPONSE = 1,
  REQUEST_TRAILERS = 2,
  RESPONSE_TRAILERS = 3,
}

enum BodyKind {
  REQUEST = 0,
  RESPONSE = 1,
}

enum LogLevel {
  DEBUG = -1,
  INFO = 0,
  WARN = 1,
  ERROR = 2,
  NONE = 3,
}

enum Feature {
  BUFFER_REQUEST = 1 << 0,
  BUFFER_RESPONSE = 1 << 1,
  TRAILERS = 1 << 2,
}

class Features {
  private features: number;

  constructor(features: number) {
    this.features = features;
  }

  has(feature: Feature): boolean {
    return (this.features & feature) === feature;
  }
}

class MiddlewareState {
  private _features: Features = new Features(0);

  get features(): Features {
    return this._features;
  }

  set features(features: Features) {
    this._features = features;
  }
}

class RequestState {
  private _request: Request;
  private _response: Response;
  private _nextCalled = false;
  private _features?: Features;
  private _requestBodyReadIndex = 0;
  private _responseBodyReadIndex = 0;
  private _requestBodyReplaced = false;
  private _responseBodyReplaced = false;

  public constructor(request: Request, response: Response) {
    this._request = request;
    this._response = response;
  }

  public get nextCalled(): boolean {
    return this._nextCalled;
  }

  public set nextCalled(value: boolean) {
    this._nextCalled = value;
  }

  public get features(): Features {
    if (this._features) {
      return this._features;
    }
    return mwStateStorage.getStore()!.features;
  }

  public set features(features: Features) {
    this._features = features;
  }

  public get request() {
    return this._request;
  }

  public get response() {
    return this._response;
  }

  get requestBodyReadIndex(): number {
    return this._requestBodyReadIndex;
  }

  set requestBodyReadIndex(value: number) {
    this._requestBodyReadIndex = value;
  }

  get responseBodyReadIndex(): number {
    return this._responseBodyReadIndex;
  }

  set responseBodyReadIndex(value: number) {
    this._responseBodyReadIndex = value;
  }

  get requestBodyReplaced(): boolean {
    return this._requestBodyReplaced;
  }

  set requestBodyReplaced(value: boolean) {
    this._requestBodyReplaced = value;
  }

  get responseBodyReplaced(): boolean {
    return this._responseBodyReplaced;
  }

  set responseBodyReplaced(value: boolean) {
    this._responseBodyReplaced = value;
  }
}

class ResponseBuffer {
  private _body = Buffer.from(emptyBuffer);
  private _trailers: NodeJS.Dict<string[]> = {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private _cb: () => void = () => {};

  private _origAddTrailers: (
    headers: OutgoingHttpHeaders | [string, string][],
  ) => void;
  private _origWrite: (chunk: Buffer) => void;
  private _origEnd: (
    data?: any,
    encodingOrCb?: BufferEncoding | (() => void),
    cb?: () => void,
  ) => Response;

  public constructor(res: Response) {
    this._origAddTrailers = res.addTrailers.bind(res);
    this._origWrite = res.write.bind(res);
    this._origEnd = res.end.bind(res);

    (res as BufferedResponse).buffer = this;
  }

  set cb(value: () => void) {
    this._cb = value;
  }

  get body(): Buffer {
    return this._body;
  }

  appendBody(chunk: Buffer) {
    this._body = Buffer.concat([this._body, chunk]);
  }

  replaceBody(chunk: Buffer) {
    this._body = chunk;
  }

  get trailers(): NodeJS.Dict<string[]> {
    return this._trailers;
  }

  addTrailer(key: string, value: string) {
    let trailer = this._trailers[key];
    if (!trailer) {
      trailer = [];
      this._trailers[key] = trailer;
    }
    trailer.push(value);
  }

  release() {
    this._origWrite(this._body);
    this._origAddTrailers(this._trailers);
    this._origEnd(this._cb);
  }
}

interface BufferedResponse extends Response {
  buffer: ResponseBuffer;
}

const mwStateStorage = new AsyncLocalStorage<MiddlewareState>();
const stateStorage = new AsyncLocalStorage<RequestState>();

const emptyBuffer = new Uint8Array(0);

class HttpHandler {
  private config: Buffer;

  public constructor(config?: Buffer) {
    this.config = config || Buffer.from(emptyBuffer);
  }

  // Circumvent null checking with !, setMemory must be called before
  // host functions.
  private memory!: Uint8Array;

  public getImport() {
    return {
      enable_features: this.enableFeatures.bind(this),
      get_config: this.getConfig.bind(this),
      get_header_names: this.getHeaderNames.bind(this),
      get_header_values: this.getHeaderValues.bind(this),
      get_method: this.getMethod.bind(this),
      get_protocol_version: this.getProtocolVersion.bind(this),
      get_status_code: this.getStatusCode.bind(this),
      get_uri: this.getUri.bind(this),
      log: this.log.bind(this),
      log_enabled: this.logEnabled.bind(this),
      read_body: this.readBody.bind(this),
      set_header_value: this.setHeader.bind(this),
      set_status_code: this.setStatusCode.bind(this),
      set_uri: this.setUri.bind(this),
      write_body: this.writeBody.bind(this),
    };
  }

  public setMemory(memory: WebAssembly.Memory) {
    this.memory = new Uint8Array(memory.buffer);
  }

  private enableFeatures(features: number): number {
    const state = stateStorage.getStore();
    if (state) {
      state.features = new Features(features);
      return features;
    }
    const mwState = mwStateStorage.getStore()!;
    mwState.features = new Features(features);
    return features;
  }

  private getConfig(buf: number, bufLimit: number) {
    return this.writeIfUnderLimit(buf, bufLimit, this.config);
  }

  private getHeaderNames(
    kind: HeaderKind,
    buf: number,
    bufLimit: number,
  ): bigint {
    const state = stateStorage.getStore()!;
    let headers: NodeJS.Dict<string | string[] | number>;
    switch (kind) {
      case HeaderKind.REQUEST:
        headers = state.request.headers;
        break;
      case HeaderKind.RESPONSE:
        headers = state.response.getHeaders();
        break;
      case HeaderKind.REQUEST_TRAILERS:
        headers = state.request.trailers;
        break;
      case HeaderKind.RESPONSE_TRAILERS:
        headers = (state.response as BufferedResponse).buffer.trailers;
    }

    const headerNames = Object.keys(headers);
    return this.writeNullTerminated(buf, bufLimit, headerNames);
  }

  private getHeaderValues(
    kind: HeaderKind,
    name: number,
    nameLen: number,
    buf: number,
    bufLimit: number,
  ): bigint {
    if (nameLen == 0) {
      throw new Error('HTTP header name cannot be empty');
    }

    const state = stateStorage.getStore()!;
    let headers: NodeJS.Dict<string | string[] | number>;
    switch (kind) {
      case HeaderKind.REQUEST:
        headers = state.request.headers;
        break;
      case HeaderKind.RESPONSE:
        headers = state.response.getHeaders();
        break;
      case HeaderKind.REQUEST_TRAILERS:
        headers = state.request.trailers;
        break;
      case HeaderKind.RESPONSE_TRAILERS:
        headers = (state.response as BufferedResponse).buffer.trailers;
    }

    const n = this.mustReadString('name', name, nameLen).toLowerCase();
    let values: string[] = [];
    const value = headers[n];
    if (value) {
      if (Array.isArray(value)) {
        values = value;
      } else {
        values.push(value.toString());
      }
    }

    return this.writeNullTerminated(buf, bufLimit, values);
  }

  private getMethod(buf: number, bufLimit: number): number {
    const req = stateStorage.getStore()!.request;
    return this.writeStringIfUnderLimit(buf, bufLimit, req.method);
  }

  private getProtocolVersion(buf: number, bufLimit: number): number {
    const req = stateStorage.getStore()!.request;
    let httpVersion = req.httpVersion;
    switch (httpVersion) {
      case '1.0':
        httpVersion = 'HTTP/1.0';
        break;
      case '1.1':
        httpVersion = 'HTTP/1.1';
        break;
      case '2':
      case '2.0':
        httpVersion = 'HTTP/2.0';
    }
    return this.writeStringIfUnderLimit(buf, bufLimit, httpVersion);
  }

  private getStatusCode(): number {
    const res = stateStorage.getStore()!.response;
    return res.statusCode;
  }

  private getUri(buf: number, bufLimit: number): number {
    const uri = stateStorage.getStore()!.request.url;
    return this.writeStringIfUnderLimit(buf, bufLimit, uri);
  }

  private log(level: LogLevel, buf: number, bufLimit: number) {
    const s = this.mustReadString('log', buf, bufLimit);
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(s);
        break;
      case LogLevel.INFO:
        console.info(s);
        break;
      case LogLevel.WARN:
        console.warn(s);
        break;
      case LogLevel.ERROR:
        console.error(s);
        break;
    }
  }

  // There is no standard logging library in express, for now just enable non-debug logging always.
  private logEnabled(level: LogLevel): number {
    if (level !== LogLevel.DEBUG) {
      return 1;
    }
    return 0;
  }

  private readBody(kind: BodyKind, buf: number, bufLimit: number): bigint {
    const state = stateStorage.getStore()!;
    if (kind === BodyKind.REQUEST) {
      const req = state.request;
      const body = req.body as Buffer;
      const start = state.requestBodyReadIndex;
      const end = Math.min(start + bufLimit, body.length);
      const slice = body.subarray(start, end);
      this.memory.set(slice, buf);
      state.requestBodyReadIndex = end;
      if (end === body.length) {
        return (1n << 32n) | BigInt(slice.length);
      }
      return BigInt(slice.length);
    }
    if (kind !== BodyKind.RESPONSE) {
      throw new Error(`Unknown body kind ${kind}`);
    }

    const buffer = (state.response as BufferedResponse).buffer;
    if (!buffer) {
      throw new Error('Response body not buffered');
    }

    const body = buffer.body;
    const start = state.responseBodyReadIndex;
    const end = Math.min(start + bufLimit, body.length);
    const slice = body.subarray(start, end);
    this.memory.set(slice, buf);
    state.responseBodyReadIndex = end;
    if (end === body.length) {
      return (1n << 32n) | BigInt(slice.length);
    }
    return BigInt(slice.length);
  }

  private writeBody(kind: BodyKind, body: number, bodyLen: number) {
    let b: Uint8Array;
    if (bodyLen == 0) {
      b = emptyBuffer;
    } else {
      b = this.mustRead('body', body, bodyLen);
    }
    const store = stateStorage.getStore()!;
    switch (kind) {
      case BodyKind.REQUEST:
        if (store.requestBodyReplaced) {
          store.request.body = Buffer.concat([store.request.body, b]);
        } else {
          store.request.body = Buffer.from(b);
        }
        break;
      case BodyKind.RESPONSE:
        if (!store.nextCalled) {
          store.response.write(b);
        } else if (store.responseBodyReplaced) {
          (store.response as BufferedResponse).buffer.appendBody(
            Buffer.from(b),
          );
        } else {
          (store.response as BufferedResponse).buffer.replaceBody(
            Buffer.from(b),
          );
        }
        break;
    }
  }

  private setHeader(
    kind: HeaderKind,
    name: number,
    nameLen: number,
    value: number,
    valueLen: number,
  ): void {
    if (nameLen == 0) {
      throw new Error('HTTP header name cannot be empty');
    }
    if (kind !== HeaderKind.RESPONSE) {
      throw new Error('TODO: Support non-response set_header');
    }

    const n = this.mustReadString('name', name, nameLen);
    const v = this.mustReadString('value', value, valueLen);
    stateStorage.getStore()?.response.setHeader(n, v);
  }

  private setStatusCode(statusCode: number): void {
    stateStorage.getStore()!.response.status(statusCode);
  }

  private setUri(uri: number, uriLen: number) {
    let u = '';
    if (uriLen > 0) {
      u = this.mustReadString('uri', uri, uriLen);
    }
    stateStorage.getStore()!.request.url = u;
  }

  private mustReadString(
    fieldName: string,
    offset: number,
    byteCount: number,
  ): string {
    if (byteCount == 0) {
      return '';
    }

    return Buffer.from(this.mustRead(fieldName, offset, byteCount)).toString();
  }

  private mustRead(
    fieldName: string,
    offset: number,
    byteCount: number,
  ): Uint8Array {
    if (byteCount == 0) {
      return emptyBuffer;
    }

    if (
      offset >= this.memory.length ||
      offset + byteCount >= this.memory.length
    ) {
      throw new Error(`out of memory reading ${fieldName}`);
    }

    return this.memory.slice(offset, offset + byteCount);
  }

  private writeStringIfUnderLimit(
    offset: number,
    limit: number,
    v: string,
  ): number {
    return this.writeIfUnderLimit(offset, limit, Buffer.from(v));
  }

  private writeIfUnderLimit(offset: number, limit: number, v: Buffer): number {
    const vLen = v.length;
    if (vLen > limit || vLen == 0) {
      return vLen;
    }

    this.memory.set(v, offset);
    return vLen;
  }

  private writeNullTerminated(
    buf: number,
    bufLimit: number,
    input: string[],
  ): bigint {
    const count = BigInt(input.length);
    if (count === 0n) {
      return 0n;
    }

    const encodedInput = input.map((i) => Buffer.from(i));
    const byteCount = encodedInput.reduce((acc, i) => acc + i.length + 1, 0);

    const countLen = (count << 32n) | BigInt(byteCount);

    if (byteCount > bufLimit) {
      return countLen;
    }

    let offset = 0;
    for (const s of encodedInput) {
      const sLen = s.length;
      this.memory.set(s, buf + offset);
      offset += sLen;
      this.memory[buf + offset] = 0;
      offset++;
    }

    return countLen;
  }
}

const host = (wasi: WASI, httpHandler: HttpHandler) => {
  return {
    wasi_snapshot_preview1: wasi.wasiImport,
    http_handler: httpHandler.getImport(),
  };
};

export default async (options: Options) => {
  const mwState = new MiddlewareState();
  return mwStateStorage.run(mwState, async () => {
    const wasm = await WebAssembly.compile(
      await readFile(new URL(options.wasmPath, import.meta.url)),
    );
    const wasi = new WASI(options.wasi);
    const httpHandler = new HttpHandler(options.config);
    const instance = await WebAssembly.instantiate(
      wasm,
      host(wasi, httpHandler),
    );
    httpHandler.setMemory(instance.exports['memory'] as WebAssembly.Memory);

    const handleRequest = instance.exports['handle_request'] as () => bigint;
    const handleResponse = instance.exports['handle_response'] as (
      reqCtx: number,
    ) => void;

    if (instance.exports['_start']) {
      wasi.start(instance);
    } else {
      wasi.initialize(instance);
    }

    return (req: Request, res: Response, next: NextFunction) => {
      mwStateStorage.run(mwState, async () => {
        if (mwState.features.has(Feature.BUFFER_REQUEST)) {
          req.body = await getRawBody(req);
        }
        if (mwState.features.has(Feature.BUFFER_RESPONSE)) {
          bufferResponse(res);
        }
        const state = new RequestState(req, res);
        stateStorage.run(state, () => {
          const ctxNext = handleRequest();
          if ((ctxNext & 0x1n) !== 0x1n) {
            // wasm populated a response so end it.
            res.end();
          } else {
            next();
            state.nextCalled = true;
            const ctx = Number(ctxNext >> 32n);
            handleResponse(ctx);
          }
          if (mwState.features.has(Feature.BUFFER_RESPONSE)) {
            (res as BufferedResponse).buffer.release();
          }
        });
      });
    };
  });
};

function bufferResponse(res: Response) {
  const buffer = new ResponseBuffer(res);

  res.sendStatus = function sendStatus(status: number) {
    res.statusCode = status;
    return res;
  };
  res.write = function write(
    chunk: any,
    encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
    cb?: (error?: Error | null) => void,
  ) {
    if (typeof encodingOrCb === 'function') {
      buffer.appendBody(Buffer.from(chunk));
      encodingOrCb();
      return true;
    }
    buffer.appendBody(Buffer.from(chunk, encodingOrCb));
    if (cb) {
      cb();
    }
    return true;
  };
  res.addTrailers = function addTrailers(
    headers: OutgoingHttpHeaders | [string, string][],
  ) {
    if (Array.isArray(headers)) {
      for (const [k, v] of headers) {
        buffer.addTrailer(k, v);
      }
    } else {
      for (const k in headers) {
        let v = headers[k]!;
        if (Array.isArray(v)) {
          for (const vv of v) {
            buffer.addTrailer(k, vv);
          }
        } else {
          if (typeof v === 'number') {
            v = v.toString();
          }
          buffer.addTrailer(k, v);
        }
      }
    }
  };

  res.end = function end(
    data?: any,
    encodingOrCb?: BufferEncoding | (() => void),
    cb?: () => void,
  ) {
    if (!data) {
      return res;
    }
    if (typeof data === 'function') {
      buffer.cb = data;
      return res;
    }
    if (typeof encodingOrCb !== 'function') {
      buffer.appendBody(Buffer.from(data, encodingOrCb));
      if (cb) {
        buffer.cb = cb;
      }
    } else {
      buffer.appendBody(Buffer.from(data));
      buffer.cb = encodingOrCb;
      return res;
    }
    return res;
  };
}
