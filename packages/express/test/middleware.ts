import http from 'node:http';
import { AddressInfo } from 'node:net';

import express, { Request, Response } from 'express';
import { after, describe, it } from 'mocha';
import fetch from 'node-fetch';
import getRawBody from 'raw-body';
import { assert } from 'chai';

import httpwasm, { Feature, Features } from '../index.js';

const requestBody = '{"hello": "panda"}';
const responseBody = '{"hello": "world"}';

const noopHandler = (req: Request, res: Response) => {
  res.sendStatus(200);
};

describe('config', async function () {
  const wasmPath = '../../examples/config.wasm';

  let server: http.Server;
  let url: string;

  const runTest = async (features: number) => {
    const app = express();
    const config = Buffer.allocUnsafe(8);
    config.writeBigUInt64LE(BigInt(features));
    const mw = await httpwasm({ wasmPath, config });
    app.use(mw);
    app.all('/*', async (req, res) => {
      if (new Features(features).has(Feature.BUFFER_REQUEST)) {
        const body: Buffer = req.body ? req.body : await getRawBody(req);
        assert.equal(body.toString(), requestBody);
      }
      res.contentType('application/json').send(responseBody);
    });
    await new Promise((resolve) => {
      server = app.listen(0, () => resolve(undefined));
    });

    const address = server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;

    const res = await fetch(url, { method: 'POST', body: requestBody });
    const content = await res.text();
    assert.equal(content, responseBody);

    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(undefined);
        }
      });
    });
  };

  it('none', async function () {
    await runTest(0);
  });
  it('BUFFER_REQUEST', async function () {
    await runTest(Feature.BUFFER_REQUEST);
  });
  it('BUFFER_RESPONSE', async function () {
    await runTest(Feature.BUFFER_RESPONSE);
  });
  it('TRAILERS', async function () {
    await runTest(Feature.TRAILERS);
  });
  it('BUFFER_REQUEST | BUFFER_RESPONSE', async function () {
    await runTest(Feature.BUFFER_REQUEST | Feature.BUFFER_RESPONSE);
  });
  it('BUFFER_REQUEST | BUFFER_RESPONSE | TRAILERS', async function () {
    await runTest(
      Feature.BUFFER_REQUEST | Feature.BUFFER_RESPONSE | Feature.TRAILERS,
    );
  });
});

describe('method', async function () {
  const wasmPath = '../../testdata/e2e/method.wasm';

  let server: http.Server;
  let url: string;

  before(async function () {
    const app = express();
    const mw = await httpwasm({ wasmPath });
    app.use(mw);
    app.all('/*', async (req, res) => {
      assert.equal(req.method, 'POST');
      const body = await getRawBody(req);
      assert.equal(body.toString(), 'GET');
      res.sendStatus(200);
    });
    await new Promise((resolve) => {
      server = app.listen(0, () => resolve(undefined));
    });

    const address = server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  after(async function () {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(undefined);
        }
      });
    });
  });

  it('reads and writes method', async function () {
    const response = await fetch(url);
    assert.equal(response.status, 200);
  });
});

describe('uri', async function () {
  const wasmPath = '../../testdata/e2e/uri.wasm';

  let server: http.Server;
  let url: string;

  before(async function () {
    const app = express();
    const mw = await httpwasm({ wasmPath });
    app.use(mw);
    app.all('/*', async (req, res) => {
      assert.equal(req.url, '/v1.0/hello?name=teddy');
      const body = req.body ? req.body : await getRawBody(req);
      assert.equal(body.toString(), '/v1.0/hi?name=panda');
      res.sendStatus(200);
    });
    await new Promise((resolve) => {
      server = app.listen(0, () => resolve(undefined));
    });

    const address = server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  after(async function () {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(undefined);
        }
      });
    });
  });

  it('reads and writes uri', async function () {
    const response = await fetch(`${url}/v1.0/hi?name=panda`);
    assert.equal(response.status, 200);
  });
});

describe('protocol version', async function () {
  const wasmPath = '../../testdata/e2e/protocol_version.wasm';

  let server: http.Server;
  let url: string;

  before(async function () {
    const app = express();
    const mw = await httpwasm({ wasmPath });
    app.use(mw);
    app.all('/*', noopHandler);
    await new Promise((resolve) => {
      server = app.listen(0, () => resolve(undefined));
    });

    const address = server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  after(async function () {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(undefined);
        }
      });
    });
  });

  it('http1', async function () {
    const response = await fetch(url);
    const content = await response.text();
    assert.equal(content, 'HTTP/1.1');
  });

  // TODO(anuraaga): Express only supports http1 without a bridge, test http2 in the future when supporting Koa.
});

describe('header names', async function () {
  const wasmPath = '../../testdata/e2e/header_names.wasm';

  let server: http.Server;
  let url: string;

  before(async function () {
    const app = express();
    const mw = await httpwasm({ wasmPath });
    app.use(mw);
    app.all('/*', noopHandler);
    await new Promise((resolve) => {
      server = app.listen(0, () => resolve(undefined));
    });

    const address = server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  after(async function () {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(undefined);
        }
      });
    });
  });

  it('reads names', async function () {
    const response = await fetch(url);
    assert.equal(response.status, 200);
  });
});

describe('handle response', async function () {
  const wasmPath = '../../testdata/e2e/handle_response.wasm';

  let server: http.Server;
  let url: string;

  before(async function () {
    const app = express();
    const mw = await httpwasm({ wasmPath });
    app.use(mw);
    app.all('/*', noopHandler);
    await new Promise((resolve) => {
      server = app.listen(0, () => resolve(undefined));
    });

    const address = server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  after(async function () {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(undefined);
        }
      });
    });
  });

  it('propagates context', async function () {
    const response = await fetch(url);
    assert.equal(response.status, 200);
  });
});
