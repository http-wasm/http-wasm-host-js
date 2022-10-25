import { readFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';

import { WASI } from 'node:wasi';
import { NextFunction, Request, Response } from 'express';

interface Options {
  wasmPath: string;
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
      get_header_values: this.getHeaderValues.bind(this),
      get_uri: this.getUri.bind(this),
      next: this.next.bind(this),
      set_header_value: this.setHeader.bind(this),
      set_status_code: this.setStatusCode.bind(this),
      set_uri: this.setUri.bind(this),
      write_body: this.writeBody.bind(this),
    };
  }

  public setMemory(memory: WebAssembly.Memory) {
    this.memory = new Uint8Array(memory.buffer);
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
    if (kind !== HeaderKind.REQUEST) {
      throw new Error('TODO: Support non-request get_header_values');
    }

    const n = this.mustReadString('name', name, nameLen);
    const req = stateStorage.getStore()!.request;
    let values: string[] = [];
    // NodeJS only returns multiple values for set-cookie, others will have values concatenated by comma.
    // TODO(anuraaga): Understand if we need to unconcatenate commas.
    if (n === 'set-cookie') {
      const v = req.header('set-cookie');
      if (v) {
        values = v;
      }
    } else {
      const v = req.header(n);
      if (v) {
        values = [v];
      }
    }

    return this.writeNullTerminated(buf, bufLimit, values);
  }

  private getUri(buf: number, bufLimit: number): number {
    const uri = stateStorage.getStore()!.request.url;
    return this.writeStringIfUnderLimit(buf, bufLimit, uri);
  }

  private next() {
    const state = stateStorage.getStore()!;
    state.next();
    state.nextCalled = true;
  }

  private writeBody(kind: BodyKind, body: number, bodyLen: number) {
    if (kind !== BodyKind.RESPONSE) {
      throw new Error('TODO: Support non-response write_body');
    }

    let b: Uint8Array;
    if (bodyLen == 0) {
      b = emptyBuffer;
    } else {
      b = this.mustRead('body', body, bodyLen);
    }
    const response = stateStorage.getStore()!.response;
    response.write(Buffer.from(b));
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
    const buf = Buffer.from(v);

    const vLen = buf.length;
    if (vLen > limit || vLen == 0) {
      return vLen;
    }

    this.memory.set(buf, offset);
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
