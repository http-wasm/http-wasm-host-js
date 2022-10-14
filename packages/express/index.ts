import { readFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';

import { WASI } from 'node:wasi';
import { NextFunction, Request, Response } from 'express';

interface Options {
  wasmPath: string;
}

class RequestState {
  private _request: Request;
  private _response: Response;
  private _next: NextFunction;
  private _nextCalled = false;

  public constructor(request: Request, response: Response, next: NextFunction) {
    this._request = request;
    this._response = response;
    this._next = next;
  }

  public next() {
    this._next();
  }

  get nextCalled(): boolean {
    return this._nextCalled;
  }

  set nextCalled(value: boolean) {
    this._nextCalled = value;
  }

  public get request() {
    return this._request;
  }

  public get response() {
    return this._response;
  }
}

const stateStorage = new AsyncLocalStorage<RequestState>();

const emptyBuffer = new Uint8Array(0);

class HttpHandler {
  // Circumvent null checking with !, setMemory must be called before
  // host functions.
  private memory!: Uint8Array;

  public getImport() {
    return {
      get_request_header: this.getRequestHeader.bind(this),
      next: this.next.bind(this),
      set_response_header: this.setResponseHeader.bind(this),
      set_status_code: this.setStatusCode.bind(this),
    };
  }

  public setMemory(memory: WebAssembly.Memory) {
    this.memory = new Uint8Array(memory.buffer);
  }

  private getRequestHeader(
    name: number,
    nameLen: number,
    buf: number,
    bufLimit: number,
  ): bigint {
    if (nameLen == 0) {
      throw new Error('HTTP header name cannot be empty');
    }

    const n = this.mustReadString('name', name, nameLen);
    const v = stateStorage.getStore()!.request.header(n);
    if (!v) {
      return 0n;
    }

    return (1n << 32n) | this.writeStringIfUnderLimit(buf, bufLimit, v);
  }

  private next() {
    const state = stateStorage.getStore()!;
    state.next();
    state.nextCalled = true;
  }

  private setResponseHeader(
    name: number,
    nameLen: number,
    value: number,
    valueLen: number,
  ): void {
    if (nameLen == 0) {
      throw new Error('HTTP header name cannot be empty');
    }

    const n = this.mustReadString('name', name, nameLen);
    const v = this.mustReadString('value', value, valueLen);
    stateStorage.getStore()?.response.setHeader(n, v);
  }

  private setStatusCode(statusCode: number): void {
    stateStorage.getStore()!.response.status(statusCode);
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
  ): bigint {
    const buf = Buffer.from(v);

    const vLen = BigInt.asUintN(32, BigInt(buf.length));
    if (vLen > limit || vLen == 0n) {
      return vLen;
    }

    this.memory.set(buf, offset);
    return vLen;
  }
}

const host = (wasi: WASI, httpHandler: HttpHandler) => {
  return {
    wasi_snapshot_preview1: wasi.wasiImport,
    'http-handler': httpHandler.getImport(),
  };
};

export default async (options: Options) => {
  const wasm = await WebAssembly.compile(
    await readFile(new URL(options.wasmPath, import.meta.url)),
  );
  const wasi = new WASI();
  const httpHandler = new HttpHandler();
  const instance = await WebAssembly.instantiate(wasm, host(wasi, httpHandler));
  httpHandler.setMemory(instance.exports['memory'] as WebAssembly.Memory);

  const handle = instance.exports['handle'] as () => void;

  if (instance.exports['_start']) {
    wasi.start(instance);
  } else {
    wasi.initialize(instance);
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const state = new RequestState(req, res, next);
    stateStorage.run(state, () => {
      handle();
      if (!state.nextCalled) {
        // wasm populated a response so end it.
        res.end();
      }
    });
  };
};
